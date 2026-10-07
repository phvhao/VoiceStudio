import asyncio

import pytest


def test_remote_chapter_does_not_prepare_local_model(tmp_path, monkeypatch):
    from api.routers import audiobook
    from services import gpu_gateway
    from services.audiobook import Chapter, ExpressiveOptions, Span
    from worker.routing import Decision

    monkeypatch.setattr(audiobook, "_resolve_voice", lambda _id: {
        "ref_audio": None, "ref_text": None, "instruct": None, "seed": None,
    })
    monkeypatch.setattr(audiobook, "_voice_profile_exists", lambda _id: False)
    monkeypatch.setattr("services.tts_backend.active_backend_id", lambda: "test")
    monkeypatch.setattr(audiobook, "_prepare_synth", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("remote audiobook loaded the local model")
    ))

    async def fake_run(op, *, local, remote, decision, job):
        assert op == remote.operation == "audiobook"
        assert local.prepare is not None
        assert remote.params["text"] == "hello"
        out = tmp_path / "remote.wav"
        out.write_bytes(b"wav")
        return str(out), 1.0, False, None

    monkeypatch.setattr(gpu_gateway, "run", fake_run)
    result = asyncio.run(audiobook._run_chapter(
        Chapter("One", [Span(None, "hello")]),
        decision=Decision(True, "w1", "gpu2"), job=gpu_gateway.JobRun("audiobook"),
        default_voice=None, language=None, opts=ExpressiveOptions(), voice_map=None,
        lexicon=None, cache_dir=str(tmp_path),
    ))
    assert result[0].endswith("remote.wav")


def test_local_chapter_uses_canonical_text_scaled_timeout(tmp_path, monkeypatch):
    from api.routers import audiobook
    from services import gpu_gateway, model_manager
    from services.audiobook import Chapter, ExpressiveOptions, Span
    from worker.routing import Decision

    class Backend:
        gpu_compat = ("mps", "cpu")

    chapter = Chapter("One", [Span(None, "a" * 900), Span(None, "b" * 901)])
    expected_text = f"{'a' * 900}\n{'b' * 901}"
    calls = []

    monkeypatch.setattr(audiobook, "_resolve_voice", lambda _id: {
        "ref_audio": None, "ref_text": None, "instruct": None, "seed": None,
    })
    monkeypatch.setattr(audiobook, "_voice_profile_exists", lambda _id: False)
    monkeypatch.setattr("services.tts_backend.active_backend_id", lambda: "test")
    monkeypatch.setattr("services.tts_backend.get_backend_class", lambda _id: Backend)

    async def fake_prepare(*_args, **_kwargs):
        return lambda *_args, **_kwargs: None, 24_000, lambda _id: {}, "test"

    def fake_timeout(text, *, engine=None, **_kwargs):
        calls.append((text, engine))
        return 315.05

    async def fake_run(op, *, local, remote, decision, job):
        prepared = await local.prepare()
        assert op == "audiobook"
        assert prepared.timeout == 315.05
        assert remote.params["text"] == expected_text
        return "local.wav", 1.0, False, None

    monkeypatch.setattr(audiobook, "_prepare_synth", fake_prepare)
    monkeypatch.setattr(model_manager, "generate_timeout_s", fake_timeout)
    monkeypatch.setattr(gpu_gateway, "run", fake_run)

    result = asyncio.run(audiobook._run_chapter(
        chapter,
        decision=Decision(False, "local"), job=gpu_gateway.JobRun("audiobook"),
        default_voice=None, language=None, opts=ExpressiveOptions(), voice_map=None,
        lexicon=None, cache_dir=str(tmp_path),
    ))

    assert result[0] == "local.wav"
    assert calls == [(expected_text, Backend)]


def test_audiobook_worker_marks_a_chapter_exactly_once(monkeypatch):
    """The chapter was marked in synthesis and again in the encode every worker
    result goes through: two watermarks in every remote chapter. Synthesis
    returns it unmarked; the encode marks it once."""
    import io
    import types

    import numpy as np
    import soundfile as sf
    from worker.executor import TaskExecutor, _Reporters

    marked = []
    monkeypatch.setattr("services.watermark.mark_synthetic",
                        lambda audio, sr, context, **_kw: marked.append((sr, context)) or audio)

    class Backend:
        sample_rate = 100
        def generate(self, text, **kwargs):
            return np.ones(20, dtype=np.float32)

    monkeypatch.setattr(TaskExecutor, "_load_backend", staticmethod(lambda _engine: Backend()))
    params = {"spans": [{"text": "hello", "pause_ms_after": 0}],
              "voices": [{"ref_text": None, "instruct": None}],
              "ref_audio": [None], "expressive": {}, "watermark": True}
    result = asyncio.run(TaskExecutor()._run_audiobook(
        types.SimpleNamespace(engine="test", deadlines=None), params, _Reporters(None, None)))
    assert marked == [(100, "worker.executor.tts")]
    audio, rate = sf.read(io.BytesIO(result["payload"]), dtype="float32")
    assert rate == 100 and len(audio) == 20
    # Synthesis alone leaves the chapter unmarked.
    assert TaskExecutor._synthesize_audiobook(
        Backend(), params["spans"], params["voices"], params).shape[-1] == 20
    assert marked == [(100, "worker.executor.tts")]


def test_audiobook_worker_forwards_mps_proxy_quality_and_seed():
    import numpy as np
    from services.audiobook import segment_seed
    from worker.executor import TaskExecutor

    calls = []

    class Backend:
        sample_rate = 100
        supports_native_omnivoice_controls = True

        def generate(self, text, **kwargs):
            calls.append((text, kwargs))
            return np.ones(20, dtype=np.float32)

    TaskExecutor._synthesize_audiobook(
        Backend(), [{"text": "hello", "pause_ms_after": 0}],
        [{"ref_text": None, "instruct": None, "seed": 42}],
        {"ref_audio": [None], "expressive": {}, "watermark": False},
    )

    _text, kwargs = calls[0]
    assert kwargs["num_step"] == 32
    assert kwargs["guidance_scale"] == 2.0
    assert kwargs["seed"] == segment_seed(42, "hello")


@pytest.mark.parametrize("vary", [False, True], ids=["one seed per sentence", "vary repeats"])
def test_a_remote_chapter_reads_each_take_as_this_machine_does(tmp_path, monkeypatch, vary):
    """A worker renders whole chapters and keeps no takes: the task tells it
    which takes to read otherwise — a retake the user asked for, salted anew
    — and it seeds every take by the rule this machine seeds by. With a
    pinned seed the retaken sentence comes back different and the rest the
    same, and a chapter sounds the same wherever it renders, Vary repeated
    lines included (the worker counted every call instead)."""
    import torch
    from api.routers import audiobook as router
    from services.audiobook import (
        Chapter,
        ExpressiveOptions,
        Span,
        punctuation_pause_pairs,
        segment_seed,
        take_seed_input,
    )
    from services.chunked_tts import DEFAULT_PUNCTUATION_PAUSES
    from services.longform_render import bump_retake, take_anchor
    from worker.executor import TaskExecutor

    monkeypatch.setattr(router, "_resolve_voice", lambda _id: {
        "ref_audio": None, "ref_text": None, "instruct": None, "seed": 1234})
    monkeypatch.setattr(router, "_voice_profile_exists", lambda _id: False)
    monkeypatch.setattr("services.watermark.is_enabled", lambda: False)
    monkeypatch.setattr("services.watermark.will_mark", lambda: False)
    line = "The same sentence is read here, word for word, once again."
    chapter = Chapter("One", [Span(None, f"{line}\n\nSomething else is said in between.\n\n{line}")])
    opts = ExpressiveOptions(punctuation_pauses=punctuation_pause_pairs(DEFAULT_PUNCTUATION_PAUSES),
                             vary_repeats=vary)
    cache_dir = str(tmp_path)

    class Backend:
        sample_rate = 100

        def __init__(self):
            self.seeds = []

        def generate(self, text, **_kwargs):
            self.seeds.append((text, torch.initial_seed()))
            return torch.ones(1, 20)

    def task():
        call, _path = router._remote_chapter_call(
            chapter, engine_id="eng", default_voice=None, voice_map=None, language=None,
            lexicon=None, opts=opts, cache_dir=cache_dir)
        return call.params

    def on_the_worker(params):
        backend = Backend()
        TaskExecutor._synthesize_audiobook(backend, params["spans"], params["voices"], params)
        return backend.seeds

    def takes_here():
        keys = router._chapter_cache_keys(chapter, 100, "eng", router._voice_resolver(None, None),
                                          cache_dir, opts=opts)
        return [ref for refs in router._chapter_take_plan(keys, opts=opts, lexicon=None)
                for ref in refs]

    def seeds_here():
        return [(ref.text, segment_seed(1234, *take_seed_input(
            ref.text, 0, lambda: 0, occurrence=ref.occurrence, retake=ref.salt, vary=vary)))
            for ref in takes_here()]

    before = task()
    assert "takes" not in before  # nothing to tell: its key is as it was
    first = on_the_worker(before)
    assert first == seeds_here()
    takes = takes_here()
    bump_retake(cache_dir, takes[2], take_anchor([ref.text for ref in takes], 2, "One"))
    after = task()
    assert after["takes"] == [[0, 2, 1, takes_here()[2].salt]]
    again = on_the_worker(after)
    assert again == seeds_here()
    assert again[:2] == first[:2] and again[2] != first[2]


def test_an_audiobook_task_naming_takes_its_chapter_lacks_is_refused():
    import types

    from worker.executor import TaskExecutor, TaskFailure, _Reporters

    params = {"spans": [{"text": "hello", "pause_ms_after": 0}],
              "voices": [{"ref_text": None, "instruct": None}],
              "ref_audio": [None], "expressive": {}, "watermark": False,
              "takes": [[3, 0, 0, ""]]}
    with pytest.raises(TaskFailure) as refused:
        asyncio.run(TaskExecutor()._run_audiobook(
            types.SimpleNamespace(engine="test", deadlines=None), params, _Reporters(None, None)))
    assert refused.value.error.code == "INVALID_TASK_PARAMS"
