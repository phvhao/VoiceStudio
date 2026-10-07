"""Packed classifier-free guidance in OmniVoice's default decoder.

Upstream ``_generate_iterative`` runs 2B rows per step and pads every
unconditional row (target tokens only) to the longest conditional row, so with
a clone reference 39-44% of each step ran on padding. The packed layout puts
``[cond_i | uncond_i]`` in one row behind a block-diagonal mask. It must be a
pure speed change:

  * fp32 logits match the padded layout within tolerance and tokens are
    identical at temperature 0 and under a pinned seed, at batch 1 and at
    batch 3 with unequal lengths (so rows carry padding);
  * it is chosen only where it pays and has been validated (CPU, CUDA eager,
    SDPA/eager attention, a packed row under 1.4x the padded one);
  * ``OMNIVOICE_PACKED_CFG=0`` forces the padded layout, ``=1`` forces packing.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

torch = pytest.importorskip("torch")
transformers = pytest.importorskip("transformers")

from omnivoice.models import omnivoice as ov  # noqa: E402

# (text tokens, reference tokens, target tokens) per item.
CLONE = [(30, 60, 20)]
CLONE_BATCH = [(30, 60, 20), (22, 90, 31), (40, 35, 12)]
NO_REFERENCE = [(18, 0, 40)]


@pytest.fixture(scope="module")
def model():
    torch.manual_seed(0)
    llm_cfg = transformers.Qwen3Config(
        hidden_size=64,
        intermediate_size=128,
        num_hidden_layers=2,
        num_attention_heads=4,
        num_key_value_heads=2,
        head_dim=16,
        vocab_size=2000,
        max_position_embeddings=4096,
        rms_norm_eps=1e-6,
        tie_word_embeddings=True,
    )
    llm_cfg._attn_implementation = "sdpa"
    m = ov.OmniVoice(ov.OmniVoiceConfig(llm_config=llm_cfg)).eval()
    m.llm.config._attn_implementation = "sdpa"
    with torch.no_grad():
        m.audio_heads.weight.mul_(20.0)  # peaky logits, like a trained head
    return m


@pytest.fixture
def stub_inputs(monkeypatch):
    """Replace tokenization: each text names its (text, ref, target) sizes."""

    def prepare(self, text, num_target_tokens, ref_text, ref_audio_tokens,
                lang, instruct, denoise):
        n_text, n_ref, _ = (int(x) for x in text.split("_")[1:])
        C, mask_id = self.config.num_audio_codebook, self.config.audio_mask_id
        g = torch.Generator().manual_seed(sum(map(ord, text)))
        parts = [torch.randint(0, 300, (1, 1, n_text), generator=g).repeat(1, C, 1)]
        if n_ref:
            parts.append(torch.randint(0, 1024, (1, C, n_ref), generator=g))
        parts.append(torch.full((1, C, num_target_tokens), mask_id, dtype=torch.long))
        ids = torch.cat(parts, dim=2)
        audio_mask = torch.zeros(1, ids.shape[2], dtype=torch.bool)
        audio_mask[0, n_text:] = True
        return {"input_ids": ids, "audio_mask": audio_mask}

    monkeypatch.setattr(ov.OmniVoice, "_prepare_inference_inputs", prepare)


def _task(items):
    B = len(items)
    return ov.GenerationTask(
        batch_size=B,
        texts=[f"item{j}_{n}_{r}_{u}" for j, (n, r, u) in enumerate(items)],
        target_lens=[u for _, _, u in items],
        langs=[None] * B,
        instructs=[None] * B,
        ref_texts=[None] * B,
        ref_audio_tokens=[None] * B,
        ref_rms=[None] * B,
    )


def _run(model, items, gen_config, mode, monkeypatch):
    """Decode with OMNIVOICE_PACKED_CFG=mode; return tokens, the logits the
    scoring saw, and whether the packed path ran."""
    monkeypatch.setenv("OMNIVOICE_PACKED_CFG", mode)
    seen, packed_ran = [], []
    scoring = ov.OmniVoice._predict_tokens_with_scoring
    packed = ov.OmniVoice._generate_iterative_packed_cfg

    def record(self, c_logits, u_logits, cfg):
        seen.append((c_logits.clone(), u_logits.clone()))
        return scoring(self, c_logits, u_logits, cfg)

    def spy(self, *args, **kwargs):
        packed_ran.append(True)
        return packed(self, *args, **kwargs)

    monkeypatch.setattr(ov.OmniVoice, "_predict_tokens_with_scoring", record)
    monkeypatch.setattr(ov.OmniVoice, "_generate_iterative_packed_cfg", spy)
    torch.manual_seed(1234)
    with torch.inference_mode():
        tokens = model._generate_iterative(_task(items), gen_config)
    monkeypatch.setattr(ov.OmniVoice, "_predict_tokens_with_scoring", scoring)
    monkeypatch.setattr(ov.OmniVoice, "_generate_iterative_packed_cfg", packed)
    return tokens, seen, bool(packed_ran)


@pytest.mark.parametrize("items", [CLONE, CLONE_BATCH], ids=["batch1", "batch3"])
@pytest.mark.parametrize(
    "temps", [(0.0, 0.0), (5.0, 0.0), (5.0, 1.0)], ids=["greedy", "default", "class-temp"]
)
def test_packed_matches_padded_layout(model, stub_inputs, monkeypatch, items, temps):
    gen_config = ov.OmniVoiceGenerationConfig(
        num_step=8, position_temperature=temps[0], class_temperature=temps[1]
    )
    ref_tokens, ref_logits, ref_packed = _run(model, items, gen_config, "0", monkeypatch)
    tokens, logits, packed = _run(model, items, gen_config, "1", monkeypatch)

    assert not ref_packed and packed
    assert len(logits) == len(ref_logits) > 0
    for (c, u), (rc, ru) in zip(logits, ref_logits):
        assert c.shape == rc.shape and u.shape == ru.shape
        assert torch.isfinite(c).all() and torch.isfinite(u).all()
        torch.testing.assert_close(c, rc, rtol=1e-4, atol=1e-4)
        torch.testing.assert_close(u, ru, rtol=1e-4, atol=1e-4)
    for got, want in zip(tokens, ref_tokens):
        assert torch.equal(got, want)
        assert (got != model.config.audio_mask_id).all()


@pytest.mark.parametrize(
    "items,expected",
    [(CLONE, True), (CLONE_BATCH, True), (NO_REFERENCE, False)],
    ids=["clone", "clone-batch", "no-reference"],
)
def test_auto_packs_only_when_the_row_shrinks(model, stub_inputs, monkeypatch, items, expected):
    _, _, packed = _run(model, items, ov.OmniVoiceGenerationConfig(num_step=2), "", monkeypatch)
    assert packed is expected


def _fake_model(device="cpu", attn="sdpa", compiled=False):
    llm = SimpleNamespace(config=SimpleNamespace(_attn_implementation=attn))
    if compiled:
        llm._orig_mod = object()
    return SimpleNamespace(llm=llm, device=torch.device(device))


CLONE_LENS = ([110], [20])  # u < 0.4c


@pytest.mark.parametrize(
    "fake,expected",
    [
        (_fake_model("cpu"), True),
        (_fake_model("cuda"), True),
        (_fake_model("cpu", attn="eager"), True),
        (_fake_model("mps"), False),
        (_fake_model("privateuseone"), False),  # DirectML
        (_fake_model("cuda", attn="flash_attention_2"), False),
        (_fake_model("cuda", compiled=True), False),
    ],
    ids=["cpu", "cuda", "eager-attn", "mps", "directml", "flash-attn", "compiled"],
)
def test_gate_by_host(monkeypatch, fake, expected):
    monkeypatch.delenv("OMNIVOICE_PACKED_CFG", raising=False)
    monkeypatch.setattr(torch.version, "hip", None)
    assert ov._use_packed_cfg(fake, *CLONE_LENS) is expected


def test_gate_keeps_rocm_on_the_padded_layout(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_PACKED_CFG", raising=False)
    monkeypatch.setattr(torch.version, "hip", "6.2")
    assert ov._use_packed_cfg(_fake_model("cuda"), *CLONE_LENS) is False


def test_env_switch_overrides_the_gate(monkeypatch):
    monkeypatch.setattr(torch.version, "hip", None)
    monkeypatch.setenv("OMNIVOICE_PACKED_CFG", "0")
    assert ov._use_packed_cfg(_fake_model("cpu"), *CLONE_LENS) is False
    monkeypatch.setenv("OMNIVOICE_PACKED_CFG", "1")
    assert ov._use_packed_cfg(_fake_model("mps"), [58], [40]) is True


def test_threshold_is_u_below_point_four_c(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_PACKED_CFG", raising=False)
    monkeypatch.setattr(torch.version, "hip", None)
    fake = _fake_model("cpu")
    assert ov._use_packed_cfg(fake, [100], [39]) is True
    assert ov._use_packed_cfg(fake, [100], [40]) is False
