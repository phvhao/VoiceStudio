"""Clone, Design, API and streamed takes are leveled by speech, not by peak.

Peak normalization scaled each take's single loudest sample to -2 dBFS, so its
loudness depended on that one sample: repeat takes of a voice differed, and a
short take came out louder than a long one. ``normalize_speech_level`` brings
the gated speech level to the audiobook leveling target instead, without ever
clipping, and leaves dead renders inaudible.
"""
from __future__ import annotations

import ast
import math
from pathlib import Path

import pytest
import torch

from services.audio_dsp import (
    SHORT_SPEECH_PEAK_DB,
    SPEECH_PEAK_CEILING_DB,
    normalize_audio,
    normalize_speech_level,
)
from services.voice_leveling import TARGET_SPEECH_DB, speech_level_db

SR = 24000
BACKEND = Path(__file__).resolve().parents[1] / "backend"


def _db(x: float) -> float:
    return 20.0 * math.log10(x)


def _speech_rms_db(audio: torch.Tensor, mask: torch.Tensor) -> float:
    """RMS of the samples known to be speech, measured independently of the
    gating the helper uses."""
    speech = audio.reshape(-1, audio.shape[-1])[:, mask]
    return 10.0 * math.log10(float(speech.double().pow(2).mean()))


def _take(seconds: float, level_db: float, *, seed: int, spike_db: float = 0.0):
    """A speech-like take: 0.4 s syllable bursts of modulated noise at
    ``level_db`` RMS, separated by near-silent gaps, with an optional click
    ``spike_db`` over the speech level (one loud sample decides a peak
    normalizer)."""
    g = torch.Generator().manual_seed(seed)
    n = int(seconds * SR)
    t = torch.arange(n) / SR
    mask = ((t % 0.6) < 0.4)
    envelope = 0.6 + 0.4 * torch.sin(2 * math.pi * 4.0 * t).abs()
    noise = torch.randn(n, generator=g) * envelope
    audio = torch.where(mask, noise, noise * 1e-3)
    rms = float(audio[mask].pow(2).mean().sqrt())
    audio = audio * (10 ** (level_db / 20.0) / rms)
    if spike_db:
        audio[n // 3] = 10 ** ((level_db + spike_db) / 20.0)
    return audio.unsqueeze(0).float(), mask


TAKES = [  # (seconds, speech level dB, click over the speech dB)
    (1.5, -12.0, 0.0), (2.0, -31.0, 18.0), (4.0, -18.0, 0.0), (6.0, -26.0, 17.0),
    (9.0, -22.0, 0.0), (14.0, -15.0, 18.5), (20.0, -28.0, 0.0), (30.0, -20.0, 17.5),
]


def test_takes_of_any_loudness_and_length_land_on_the_speech_target():
    leveled, peaked = [], []
    for seed, (seconds, level, spike_db) in enumerate(TAKES):
        audio, mask = _take(seconds, level, seed=seed, spike_db=spike_db)
        out = normalize_speech_level(audio, SR)
        assert float(out.abs().max()) < 10 ** (SPEECH_PEAK_CEILING_DB / 20.0) + 1e-6
        leveled.append(_speech_rms_db(out, mask))
        peaked.append(_speech_rms_db(normalize_audio(audio, target_dBFS=-2.0), mask))
    assert all(abs(level - TARGET_SPEECH_DB) <= 0.5 for level in leveled), leveled
    # The peak normalizer these takes used to get spread them far apart.
    assert max(peaked) - min(peaked) > 3.0, peaked


def test_a_loud_take_is_cut_to_the_target():
    audio, mask = _take(5.0, -8.0, seed=11)
    out = normalize_speech_level(audio, SR)
    assert abs(_speech_rms_db(out, mask) - TARGET_SPEECH_DB) <= 0.5


def test_the_boost_stops_before_the_peak_ceiling():
    audio, mask = _take(5.0, -40.0, seed=12, spike_db=25.0)
    out = normalize_speech_level(audio, SR)
    peak = float(out.abs().max())
    assert peak == pytest.approx(10 ** (SPEECH_PEAK_CEILING_DB / 20.0), rel=1e-4)
    assert _speech_rms_db(out, mask) < TARGET_SPEECH_DB - 1.0


def test_a_take_too_short_to_measure_is_peak_scaled():
    audio, _ = _take(0.25, -30.0, seed=13)
    assert speech_level_db(audio, SR) is None
    out = normalize_speech_level(audio, SR)
    assert _db(float(out.abs().max())) == pytest.approx(SHORT_SPEECH_PEAK_DB, abs=1e-3)


@pytest.mark.parametrize("audio", [
    torch.full((1, SR), 1e-4),
    torch.zeros(1, SR),
    torch.zeros(0),
])
def test_blank_audio_is_never_amplified(audio):
    out = normalize_speech_level(audio, SR)
    assert torch.equal(out, audio)


def test_blank_audio_still_reads_as_blank_to_the_archetype_guard():
    from api.routers.archetypes import _is_blank_audio

    assert _is_blank_audio(normalize_speech_level(torch.full((1, SR), 1e-4), SR))
    speech, _ = _take(3.0, -30.0, seed=14)
    assert not _is_blank_audio(normalize_speech_level(speech, SR))


def test_non_finite_audio_is_left_for_the_sanitizer():
    audio = torch.tensor([[0.1, float("nan"), 0.2]])
    assert normalize_speech_level(audio, SR) is audio


def test_stereo_takes_are_leveled_as_one():
    left, mask = _take(4.0, -30.0, seed=15)
    audio = torch.cat([left, left * 0.5])
    out = normalize_speech_level(audio, SR)
    assert out.shape == audio.shape
    assert abs(_speech_rms_db(out, mask) - TARGET_SPEECH_DB) <= 0.5


def test_generate_effect_chain_levels_by_speech():
    """The /generate tail (mastering, preset chain, normalization) ends on the
    speech target, whatever the take's peak."""
    from api.routers.generation import _apply_effect_chain

    audio, mask = _take(6.0, -30.0, seed=16, spike_db=17.0)
    out = _apply_effect_chain(audio, SR, "broadcast")
    assert abs(_speech_rms_db(out, mask) - TARGET_SPEECH_DB) <= 0.5
    assert float(out.abs().max()) < 10 ** (SPEECH_PEAK_CEILING_DB / 20.0) + 1e-6


# ── Every synthesis surface uses the one helper ──────────────────────────────

#: Functions that finish a Clone, Design, API or streamed take.
SPEECH_LEVELED = {
    "api/routers/generation.py": "_apply_effect_chain",
    "api/routers/openai_compat.py": "_run_tts",
    "api/routers/tts_stream.py": "render_stream_sentence",
    "services/gpu_sandbox.py": "_worker",
}
#: Peak normalization stays only where it is a deliberate, separate choice:
#: dubbing (manual, batch and the remote worker's dub segments, whose cached
#: segments carry no mastering version) and the user's own Normalize tool.
PEAK_NORMALIZED = {
    "api/routers/dub_generate.py",
    "api/routers/batch.py",
    "worker/executor.py",
    "api/routers/tools.py",
}


def _calls(node: ast.AST, name: str) -> int:
    return sum(
        1 for n in ast.walk(node)
        if isinstance(n, ast.Call)
        and getattr(n.func, "id", getattr(n.func, "attr", None)) == name
    )


@pytest.mark.parametrize("path,function", sorted(SPEECH_LEVELED.items()))
def test_synthesis_surfaces_level_by_speech(path, function):
    tree = ast.parse((BACKEND / path).read_text(encoding="utf-8"))
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == function)
    assert _calls(fn, "normalize_speech_level") == 1
    assert _calls(fn, "normalize_audio") == 0


def test_peak_normalization_is_confined_to_dubbing_and_the_normalize_tool():
    """A new synthesis surface reaching for ``normalize_audio`` fails here."""
    callers = set()
    for path in BACKEND.rglob("*.py"):
        rel = path.relative_to(BACKEND).as_posix()
        if rel.startswith(("tests/", "services/audio_dsp.py")):
            continue
        source = path.read_text(encoding="utf-8")
        if "normalize_audio" in source and any(
            getattr(n, "id", getattr(n, "attr", None)) == "normalize_audio"
            for n in ast.walk(ast.parse(source)) if isinstance(n, (ast.Name, ast.Attribute))
        ):
            callers.add(rel)
    assert callers == PEAK_NORMALIZED
