"""What a long-form re-render reuses, and what it must not.

* A Settings → Performance preset keys the audio it renders (the keys used
  to hash the request only, so a chapter rendered at 64 steps replayed at 16)
  — Quality and no preset too, in all three cache layers — reaches a remote
  worker, and shows in ``GET /audiobook/sampling``; audio cached before is
  still found.
* The gap between lines is never part of a take's key: changing it joins the
  takes already cached again instead of rendering them.
* Eviction goes by use: a chapter or segment a render reuses is renewed, so a
  book larger than the cache keeps what it keeps reusing; pruning runs off
  the event loop.
* A chapter already cached is served without loading the model — also one
  whose takes wait for a recognizer, while none is installed.
* What the speech check found is kept with the audio, so a cached chapter
  still lists the phrases to listen to; takes it could not listen to are never
  kept as checked, and are checked once a recognizer answers; the result says
  whether no recognizer was installed or the one installed heard no words. A
  remote chapter is never checked, so the check does not move its key.
* A language the engine now receives otherwise (OmniVoice read "Arabic" as
  Auto) renders again once, in all three cache layers; every other keeps its
  cache.

Stub engine throughout — no model, no GPU. App modules are resolved at call
time: other suites reload them.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import os
import threading
import time
import types
import wave

import pytest
import torch

SR = 24000


def _mod(name: str):
    return importlib.import_module(name)


def _resolve(_voice_id):
    return {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}


class _Engine:
    """A stub engine that records what it was asked to say."""

    def __init__(self):
        self.calls: list = []
        self.said: dict = {}

    def synth(self, text, voice_id, speed=None, attempt=0):
        self.calls.append(text)
        audio = torch.full((2400,), 0.1)
        self.said[id(audio)] = text
        return audio


@pytest.fixture
def engine(tmp_path, monkeypatch):
    """The router, rendering through a stub engine ``eng`` at 24 kHz with
    outputs under ``tmp_path``, unmarked, every job routed here."""
    config = _mod("core.config")
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(tmp_path))
    monkeypatch.setattr(config, "VOICES_DIR", str(tmp_path / "voices"))
    watermark = _mod("services.watermark")
    monkeypatch.setattr(watermark, "will_mark", lambda: False)
    monkeypatch.setattr(watermark, "mark_synthetic", lambda audio, *_a, **_k: audio)
    router = _mod("api.routers.audiobook")
    monkeypatch.setattr(_mod("services.tts_backend"), "active_backend_id", lambda: "eng")
    monkeypatch.setattr(router, "_local_sample_rate",
                        lambda engine_id: SR if engine_id in ("eng", "omnivoice") else None)
    monkeypatch.setattr(_mod("services.gpu_gateway"), "decide",
                        lambda *_a, **_k: types.SimpleNamespace(remote=False))
    return router


def _use_engine(router, monkeypatch, stub: _Engine, engine_id: str = "eng"):
    def build_synth(default_voice=None, language=None, opts=None, voice_map=None, lease=None):
        return {"mode": "generic", "engine_id": engine_id, "sample_rate": SR,
                "resolve": router._voice_resolver(default_voice, voice_map, lease),
                "synth": stub.synth}
    monkeypatch.setattr(router, "_build_synth", build_synth)


def _chapter(*texts, title="C"):
    ab = _mod("services.audiobook")
    return ab.Chapter(title=title, spans=[ab.Span(voice_id=None, text=t, pause_ms_after=0)
                                          for t in texts])


def _run(router, chapter, cache_dir, opts=None, decision=None, job=None):
    return asyncio.run(router._run_chapter(
        chapter, decision=decision or types.SimpleNamespace(remote=False), job=job,
        default_voice=None, language=None, opts=opts or _mod("services.audiobook").ExpressiveOptions(),
        voice_map=None, lexicon=None, cache_dir=cache_dir))


def _cache(tmp_path) -> str:
    path = tmp_path / "longform_cache"
    path.mkdir(exist_ok=True)
    return str(path)


def _write_wav(path, frames=2400):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"\x10\x00" * frames)


# ── The performance preset keys what it renders ─────────────────────────────

@pytest.fixture
def preset(engine, monkeypatch):
    """The default engine under a performance preset: ``preset["steps"]`` (and
    ``preset["postprocess"]``) as Settings → Performance would set them;
    ``None`` steps means no preset chosen."""
    tts = _mod("services.tts_backend")
    monkeypatch.setattr(tts, "active_backend_id", lambda: "omnivoice")
    real = tts.get_backend_class
    monkeypatch.setattr(tts, "get_backend_class",
                        lambda backend_id: tts.OmniVoiceBackend if backend_id == "omnivoice"
                        else real(backend_id))
    chosen = {"steps": None, "postprocess": True}

    def tts_defaults():
        if chosen["steps"] is None:
            return {}
        return {"num_step": chosen["steps"], "postprocess_output": chosen["postprocess"]}

    monkeypatch.setattr(_mod("services.performance_profiles"), "tts_defaults", tts_defaults)
    return chosen


def _state(router, chapter, cache):
    """What the outline reports for ``chapter``: ``(key, cached, names)``."""
    return router._chapter_cache_state(
        chapter, decision=types.SimpleNamespace(remote=False), default_voice=None,
        language=None, opts=_mod("services.audiobook").ExpressiveOptions(), voice_map=None,
        lexicon=None, cache_dir=cache)


@pytest.mark.parametrize("first", [None, 32, 64], ids=["no preset", "quality", "max"])
def test_a_chapter_rendered_at_one_preset_is_not_replayed_at_another(
        first, engine, preset, tmp_path, monkeypatch):
    """Quality, and no preset chosen, key their steps like every other preset:
    keyed without them, a chapter would hold the key builds before presets
    wrote, which another preset adopts as its own audio."""
    router = engine
    stub = _Engine()
    _use_engine(router, monkeypatch, stub, "omnivoice")
    cache = _cache(tmp_path)
    chapter = _chapter(_LAMP, _RIVER)
    preset["steps"] = first
    _run(router, chapter, cache)
    assert len(stub.calls) == 2
    rendered = _state(router, chapter, cache)[0]
    for steps in (64, 16):
        if steps == first:
            continue
        preset["steps"] = steps
        _key, cached, names = _state(router, chapter, cache)
        assert cached is False and rendered not in names
        stub.calls.clear()
        _path, _dur, cached, _stats = _run(router, chapter, cache)
        assert cached is False and len(stub.calls) == 2
    stub.calls.clear()
    preset["steps"] = first
    _path, _dur, cached, _stats = _run(router, chapter, cache)
    assert cached is True and stub.calls == []


def test_an_edit_at_another_preset_reuses_no_take_of_the_first(
        engine, preset, tmp_path, monkeypatch):
    router = engine
    stub = _Engine()
    _use_engine(router, monkeypatch, stub, "omnivoice")
    cache = _cache(tmp_path)
    preset["steps"] = 32  # Quality
    _run(router, _chapter(_LAMP, _RIVER), cache)
    stub.calls.clear()
    preset["steps"] = 64  # Max, and one line edited
    edited = "The river ran under the old bridge."
    _path, _dur, cached, stats = _run(router, _chapter(_LAMP, edited), cache)
    assert cached is False and stats == {"total": 2, "cached": 0}
    assert sorted(stub.calls) == sorted([_LAMP, edited])


def test_the_engine_receives_the_preset_and_an_explicit_value_wins(engine, preset, monkeypatch):
    router = engine
    ab = _mod("services.audiobook")
    calls = []

    class Model:
        sampling_rate = SR

        def generate(self, **kw):
            calls.append(kw)
            return [torch.zeros(1, 2400)]

    async def get_model():
        return Model()

    monkeypatch.setattr(_mod("services.model_manager"), "get_model", get_model)
    monkeypatch.setattr(router, "_resolve_voice", _resolve)
    preset.update(steps=8, postprocess=False)  # Fast
    synth, *_ = asyncio.run(router._prepare_synth(
        "p", opts=router._preset_opts(ab.ExpressiveOptions(), "omnivoice")))
    synth("hello", None)
    assert calls[-1]["num_step"] == 8 and calls[-1]["postprocess_output"] is False
    synth, *_ = asyncio.run(router._prepare_synth(
        "p", opts=router._preset_opts(ab.ExpressiveOptions(num_step=40), "omnivoice")))
    synth("hello", None)
    assert calls[-1]["num_step"] == 40


def test_every_preset_writes_the_sampling_it_renders_at(engine, preset):
    """Quality's and no preset's too, so nothing this build renders is keyed
    like the request alone (see the next test)."""
    router = engine
    ab = _mod("services.audiobook")

    def sampling(engine_id="omnivoice", **request):
        opts = router._preset_opts(ab.ExpressiveOptions(**request), engine_id)
        return opts.num_step, opts.postprocess_output

    for steps in (None, 32):  # no preset chosen, or Quality
        preset["steps"] = steps
        assert sampling() == (32, True)
    preset["steps"] = 16
    assert sampling() == (16, True)
    preset.update(steps=8, postprocess=False)  # Fast
    assert sampling() == (8, False)
    # An explicit request value wins.
    assert sampling(num_step=40, postprocess_output=True) == (40, True)
    # Engines without the default engine's controls take no preset.
    assert router._preset_opts(ab.ExpressiveOptions(), "eng").is_default


@pytest.mark.parametrize("steps", [None, 32, 16], ids=["no preset", "quality", "balanced"])
def test_audio_cached_before_presets_keyed_it_is_still_found(steps, engine, preset, tmp_path):
    """Builds before this keyed a chapter with the request alone, at every
    preset: the new key misses and the chapter is served through the old one."""
    router = engine
    ab = _mod("services.audiobook")
    stub = _Engine()
    cache = _cache(tmp_path)
    chapter = _chapter("The lamp held for forty years.")
    request = ab.ExpressiveOptions()
    legacy, *_ = router._render_chapter_cached(chapter, stub.synth, SR, "omnivoice", _resolve,
                                               cache, opts=request)
    preset["steps"] = steps
    opts = router._preset_opts(request, "omnivoice")
    key, cached, names = router._chapter_cache_state(
        chapter, decision=types.SimpleNamespace(remote=False), default_voice=None, language=None,
        opts=request, voice_map=None, lexicon=None, cache_dir=cache)
    assert key != router._cache_name(legacy) and cached is True
    assert router._cache_name(legacy) in names  # a book that recorded the old key
    stub.calls.clear()
    path, _dur, cached, _stats = router._render_chapter_cached(
        chapter, stub.synth, SR, "omnivoice", _resolve, cache, opts=opts, request_opts=request)
    assert cached is True and stub.calls == []
    assert router._cache_name(path) == key and not os.path.exists(legacy)


@pytest.mark.parametrize("steps", [None, 32, 16], ids=["no preset", "quality", "balanced"])
def test_takes_cached_before_presets_keyed_them_are_still_found(steps, engine, preset, tmp_path):
    router = engine
    ab = _mod("services.audiobook")
    stub = _Engine()
    cache = _cache(tmp_path)
    request = ab.ExpressiveOptions()
    router._render_chapter_cached(_chapter(_LAMP, _RIVER), stub.synth, SR, "omnivoice",
                                  _resolve, cache, opts=request)
    stub.calls.clear()
    preset["steps"] = steps
    edited = "The river ran under the old bridge."
    _path, _dur, cached, stats = router._render_chapter_cached(
        _chapter(_LAMP, edited), stub.synth, SR, "omnivoice", _resolve, cache,
        opts=router._preset_opts(request, "omnivoice"), request_opts=request)
    assert cached is False and stub.calls == [edited]
    assert stats == {"total": 2, "cached": 1}


def test_sampling_endpoint_names_the_steps_a_render_takes(engine, preset, monkeypatch):
    router = engine
    assert router.audiobook_sampling()["num_step"] == 32  # no preset: the longform preset
    preset.update(steps=64)
    got = router.audiobook_sampling()
    assert (got["num_step"], got["guidance_scale"], got["postprocess_output"]) == (64, 2.0, True)
    preset.update(steps=8, postprocess=False)
    assert router.audiobook_sampling()["postprocess_output"] is False
    monkeypatch.setattr(_mod("services.tts_backend"), "active_backend_id", lambda: "eng")
    assert router.audiobook_sampling()["num_step"] is None  # the engine's own default


def test_a_remote_worker_renders_at_the_preset(engine, preset, tmp_path):
    router = engine
    ab = _mod("services.audiobook")
    cache = _cache(tmp_path)
    chapter = _chapter("The lamp held for forty years.")
    request = ab.ExpressiveOptions()
    kw = dict(engine_id="omnivoice", default_voice=None, voice_map=None, language=None,
              lexicon=None, cache_dir=cache)
    _call, legacy = router._remote_chapter_call(chapter, opts=request, **kw)
    _write_wav(legacy)
    preset["steps"] = 64
    call, path = router._remote_chapter_call(
        chapter, opts=router._preset_opts(request, "omnivoice"), request_opts=request, **kw)
    assert call.params["expressive"]["num_step"] == 64
    assert path != legacy and os.path.exists(path) and not os.path.exists(legacy)


def test_a_remote_chapter_rendered_at_quality_is_no_other_presets(engine, preset, tmp_path):
    router = engine
    ab = _mod("services.audiobook")
    cache = _cache(tmp_path)
    chapter = _chapter(_LAMP)
    request = ab.ExpressiveOptions()
    kw = dict(engine_id="omnivoice", default_voice=None, voice_map=None, language=None,
              lexicon=None, cache_dir=cache)

    def remote(steps):
        preset["steps"] = steps
        return router._remote_chapter_call(
            chapter, opts=router._preset_opts(request, "omnivoice"), request_opts=request, **kw)

    call, quality = remote(32)
    assert call.params["expressive"]["num_step"] == 32
    _write_wav(quality)  # what the worker rendered at Quality
    for steps in (64, 16):
        call, path = remote(steps)
        assert call.params["expressive"]["num_step"] == steps
        assert path != quality and not os.path.exists(path) and os.path.exists(quality)
    # No preset chosen renders as Quality does.
    assert remote(None)[1] == quality


# ── The gap between lines is never part of a take ───────────────────────────

def test_changing_the_line_gap_renders_nothing_again(engine, tmp_path):
    router = engine
    ab = _mod("services.audiobook")
    stub = _Engine()
    cache = _cache(tmp_path)
    chapter = _chapter("The lamp held for forty years.", "The river ran under the bridge.")
    _path, before, _c, _s = router._render_chapter_cached(
        chapter, stub.synth, SR, "eng", _resolve, cache, opts=ab.ExpressiveOptions())
    stub.calls.clear()
    _path, after, cached, stats = router._render_chapter_cached(
        chapter, stub.synth, SR, "eng", _resolve, cache, opts=ab.ExpressiveOptions(line_gap_ms=250))
    assert cached is False and stub.calls == []
    assert stats == {"total": 2, "cached": 2}
    assert after == pytest.approx(before + 0.25)


def test_takes_cached_with_the_line_gap_in_their_key_are_still_found(engine, tmp_path):
    router = engine
    ab = _mod("services.audiobook")
    lr = _mod("services.longform_render")
    cache = _cache(tmp_path)
    opts = ab.ExpressiveOptions(line_gap_ms=250, trim_edges=True)
    chapter = _chapter("The lamp held for forty years.")
    keys = router._chapter_cache_keys(chapter, SR, "eng", _resolve, cache, opts=opts)
    # How builds before this keyed the take: the gap in its signature.
    old = lr.SegmentCache(cache, sample_rate=SR, engine_id="eng", voice_sig=keys.voice_sigs,
                          extra_sig=f"\x00{opts.legacy_take_signature()}")
    assert keys.seg_extra_sig != old.extra_sig
    _write_wav(old._path(keys.spans[0]))
    stub = _Engine()
    _p, _d, cached, stats = router._render_chapter_cached(
        chapter, stub.synth, SR, "eng", _resolve, cache, opts=opts)
    assert stub.calls == [] and stats == {"total": 1, "cached": 1}


# ── Eviction goes by use ────────────────────────────────────────────────────

def _age(path, seconds=10_000):
    old = time.time() - seconds
    os.utime(path, (old, old))
    return old


def test_a_chapter_served_from_the_cache_counts_as_used(engine, tmp_path):
    router = engine
    stub = _Engine()
    cache = _cache(tmp_path)
    chapter = _chapter("The lamp held for forty years.")
    path, *_ = router._render_chapter_cached(chapter, stub.synth, SR, "eng", _resolve, cache)
    old = _age(path)
    _p, _d, cached, _s = router._render_chapter_cached(chapter, stub.synth, SR, "eng", _resolve, cache)
    assert cached is True and os.path.getmtime(path) > old + 1_000


def test_a_remote_chapter_served_from_the_cache_counts_as_used(engine, tmp_path):
    router = engine
    gateway = _mod("services.gpu_gateway")
    cache = _cache(tmp_path)
    chapter = _chapter("The lamp held for forty years.")
    _call, path = router._remote_chapter_call(
        chapter, engine_id="eng", default_voice=None, voice_map=None, language=None,
        lexicon=None, opts=_mod("services.audiobook").ExpressiveOptions(), cache_dir=cache)
    _write_wav(path)
    old = _age(path)
    got = _run(router, chapter, cache, decision=types.SimpleNamespace(remote=True),
               job=gateway.JobRun("audiobook"))
    assert got[0] == path and got[2] is True and os.path.getmtime(path) > old + 1_000


def test_a_book_larger_than_the_cache_keeps_what_it_reuses(engine, tmp_path):
    """The cap holds less than a book's chapters and segments together.
    Eviction went by when a file was written — a chapter hit left its age
    alone — so each re-render dropped the oldest chapters it was still using
    and rendered them again. By use, three re-renders after one edit render
    only the edited line."""
    router = engine
    lr = _mod("services.longform_render")
    stub = _Engine()
    cache = _cache(tmp_path)

    def book(edited=False):
        return [_chapter(*(f"Chapter {c}, line {k}, is read aloud here."
                           + (" Now edited." if edited and (c, k) == (2, 1) else "")
                           for k in range(3)), title=f"C{c}") for c in range(4)]

    def render(chapters, cap):
        lr.prune_cache_dir(cache, max_bytes=cap)  # what a render does first
        stub.calls.clear()
        for chapter in chapters:
            router._render_chapter_cached(chapter, stub.synth, SR, "eng", _resolve, cache)
            time.sleep(0.03)  # each chapter's files a clock tick apart
        return list(stub.calls)

    assert len(render(book(), 1 << 40)) == 12
    total, _removed = lr.prune_cache_dir(cache, max_bytes=1 << 40)
    # The cap: everything but the first chapter's segments.
    segments = sorted((os.path.getmtime(e.path), e.path) for e in os.scandir(
        os.path.join(cache, lr.SEGMENT_SUBDIR)) if e.name.endswith(".wav"))[:3]
    first = sum(os.path.getsize(p) + (os.path.getsize(lr.timeline_sidecar_path(p))
                                      if os.path.exists(lr.timeline_sidecar_path(p)) else 0)
                for _t, p in segments)
    cap = total - first
    edited = book(edited=True)
    assert render(edited, cap) == ["Chapter 2, line 1, is read aloud here. Now edited."]
    assert render(edited, cap) == []
    assert render(edited, cap) == []


def test_pruning_runs_off_the_event_loop(engine, monkeypatch):
    router = engine
    threads = []
    monkeypatch.setattr(router, "prune_cache_dir",
                        lambda *_a, **_k: threads.append(threading.get_ident()) or (0, 0))
    monkeypatch.setattr(_mod("services.ffmpeg_utils"), "find_ffmpeg", lambda: "ffmpeg")
    plan = _mod("services.audiobook").AudiobookPlan(chapters=[_chapter("Hello there.")])

    async def first_event():
        events = router._render_longform_sse(plan, default_voice=None)
        try:
            return threading.get_ident(), await events.__anext__()
        finally:
            await events.aclose()

    loop_thread, event = asyncio.run(first_event())
    assert json.loads(event[len("data: "):])["type"] == "started"
    assert threads and threads[0] != loop_thread


# ── A cached chapter loads no model ─────────────────────────────────────────

def test_a_cached_chapter_is_served_without_loading_the_model(engine, tmp_path, monkeypatch):
    router = engine
    stub = _Engine()
    _use_engine(router, monkeypatch, stub)
    cache = _cache(tmp_path)
    chapter = _chapter("The lamp held for forty years.")
    first = _run(router, chapter, cache)
    assert first[2] is False and stub.calls

    async def no_model(*_a, **_k):
        raise AssertionError("a cached chapter waited for the model to load")

    monkeypatch.setattr(router, "_prepare_synth", no_model)
    second = _run(router, chapter, cache)
    assert second[2] is True and second[0] == first[0]


# ── The speech check's results stay with the audio ──────────────────────────

def _recognizer(monkeypatch, stub: _Engine, *, answers=True, misheard=()):
    """The check's recognizer hears what the stub engine said (``misheard``
    phrases as something else); with ``answers`` off none is installed."""
    speech = _mod("services.speech_verify")
    real = speech.SpeechVerifier
    state = {"answers": answers}

    def transcribe(audio, _sample_rate):
        if not state["answers"]:
            return None
        text = stub.said.get(id(audio), "speech already rendered")
        return ("nothing like the script at all" if any(m in text for m in misheard)
                else text)

    monkeypatch.setattr(speech, "SpeechVerifier",
                        lambda sr, **kw: real(sr, transcribe=transcribe, **kw))
    return state


def _checked(router, path):
    return router._chapter_speech_check(_mod("services.longform_render").load_chapter_timeline(path))


_LAMP = "The lamp held for forty years."
_RIVER = "The river ran under the bridge."


def test_a_cached_chapter_still_lists_the_phrases_to_listen_to(engine, monkeypatch):
    router = engine
    stub = _Engine()
    _use_engine(router, monkeypatch, stub)
    _recognizer(monkeypatch, stub, misheard={_LAMP})

    def preview():
        return asyncio.run(router.audiobook_preview(router.AudiobookPreviewRequest(
            text=f"# One\n{_LAMP}\n{_RIVER}", verify_speech=True)))

    first = preview()
    assert first["cached"] is False
    # The script's two lines are one take (plain prose parses to one span).
    assert [s["text"] for s in first["speech_check"]["suspect"]] == [f"{_LAMP}\n{_RIVER}"]
    second = preview()
    assert second["cached"] is True
    assert second["speech_check"]["suspect"] == first["speech_check"]["suspect"]


@pytest.mark.skipif(importlib.import_module("services.ffmpeg_utils").find_ffmpeg() is None,
                    reason="ffmpeg required for a full render")
def test_a_rerendered_book_still_lists_the_phrases_to_listen_to(engine, monkeypatch):
    router = engine
    stub = _Engine()
    _use_engine(router, monkeypatch, stub)
    _recognizer(monkeypatch, stub, misheard={_LAMP})

    async def render():
        response = await router.audiobook_synthesize(router.AudiobookRequest(
            text=f"# One\n{_LAMP}\n# Two\n{_RIVER}", verify_speech=True))
        return [json.loads(frame[len("data:"):]) async for frame in response.body_iterator]

    def chapters():
        events = asyncio.run(asyncio.wait_for(render(), timeout=120))
        assert events[-1]["type"] == "done", events
        return [e for e in events if e["type"] == "chapter"]

    first = chapters()
    second = chapters()
    assert [e["cached"] for e in second] == [True, True]
    assert [e["speech_check"]["suspect"] for e in second] == [
        e["speech_check"]["suspect"] for e in first]
    assert [s["text"] for s in second[0]["speech_check"]["suspect"]] == [_LAMP]


def test_an_edited_chapter_keeps_the_check_of_the_lines_it_reuses(engine, tmp_path, monkeypatch):
    router = engine
    ab = _mod("services.audiobook")
    stub = _Engine()
    _recognizer(monkeypatch, stub, misheard={_LAMP})
    cache = _cache(tmp_path)
    opts = ab.ExpressiveOptions(verify_speech=True)
    router._render_chapter_cached(_chapter(_LAMP, _RIVER), stub.synth, SR, "eng", _resolve,
                                  cache, opts=opts)
    stub.calls.clear()
    path, _d, cached, stats = router._render_chapter_cached(
        _chapter(_LAMP, "The river ran under the old bridge."), stub.synth, SR, "eng",
        _resolve, cache, opts=opts)
    assert cached is False and stub.calls == ["The river ran under the old bridge."]
    assert [s["text"] for s in stats["speech_check"]["suspect"]] == [_LAMP]
    assert stats["speech_check"]["checked"] == 2  # the reused line was checked, not re-heard
    assert _checked(router, path)["suspect"] == stats["speech_check"]["suspect"]


def test_takes_the_check_could_not_hear_are_checked_once_a_recognizer_answers(
        engine, tmp_path, monkeypatch):
    router = engine
    ab = _mod("services.audiobook")
    stub = _Engine()
    recognizer = _recognizer(monkeypatch, stub, answers=False)
    cache = _cache(tmp_path)
    opts = ab.ExpressiveOptions(verify_speech=True)
    chapter = _chapter(_LAMP, _RIVER)
    path, _d, _c, stats = router._render_chapter_cached(chapter, stub.synth, SR, "eng",
                                                        _resolve, cache, opts=opts)
    # Never kept as checked: the result says what was not listened to.
    assert (stats["speech_check"]["checked"], stats["speech_check"]["unchecked"]) == (0, 2)
    assert _checked(router, path)["unavailable"] is True
    recognizer["answers"] = True
    stub.calls.clear()
    path, _d, cached, stats = router._render_chapter_cached(chapter, stub.synth, SR, "eng",
                                                            _resolve, cache, opts=opts)
    assert cached is False and sorted(stub.calls) == sorted([_LAMP, _RIVER])
    assert (stats["speech_check"]["checked"], stats["speech_check"]["unchecked"]) == (2, 0)
    assert stats["cached"] == 0
    assert _checked(router, path)["unchecked"] == 0


def test_without_a_recognizer_cached_takes_are_reused_unchecked(engine, tmp_path, monkeypatch):
    router = engine
    ab = _mod("services.audiobook")
    stub = _Engine()
    _recognizer(monkeypatch, stub, answers=False)
    cache = _cache(tmp_path)
    opts = ab.ExpressiveOptions(verify_speech=True)
    chapter = _chapter(_LAMP, _RIVER)
    router._render_chapter_cached(chapter, stub.synth, SR, "eng", _resolve, cache, opts=opts)
    stub.calls.clear()
    path, _d, cached, _s = router._render_chapter_cached(chapter, stub.synth, SR, "eng",
                                                         _resolve, cache, opts=opts)
    assert cached is True and stub.calls == []
    assert _checked(router, path)["unchecked"] == 2
    # An edit reuses the other line's take the same way, still counted unchecked.
    path, _d, cached, stats = router._render_chapter_cached(
        _chapter(_LAMP, "The river ran under the old bridge."), stub.synth, SR, "eng",
        _resolve, cache, opts=opts)
    assert stub.calls == ["The river ran under the old bridge."]
    assert stats["speech_check"]["unchecked"] == 2


def test_without_a_recognizer_installed_a_cached_chapter_loads_no_model(
        engine, tmp_path, monkeypatch):
    """Takes the check could not listen to wait for a recognizer, but with
    none installed the render only served the same cached chapter after
    loading the model (and waiting for the GPU) to learn that."""
    router = engine
    ab = _mod("services.audiobook")
    asr = _mod("services.asr_backend")
    stub = _Engine()
    _use_engine(router, monkeypatch, stub)
    installed = {"value": False}
    monkeypatch.setattr(asr, "reference_recognizer_installed", lambda: installed["value"])
    monkeypatch.setattr(asr, "transcribe_check", lambda _audio, **_kw: None)
    cache = _cache(tmp_path)
    chapter = _chapter(_LAMP, _RIVER)
    opts = ab.ExpressiveOptions(verify_speech=True)
    first = _run(router, chapter, cache, opts=opts)
    assert _checked(router, first[0])["unchecked"] == 2
    prepare = router._prepare_synth

    async def no_model(*_a, **_k):
        raise AssertionError("a cached chapter waited for the model to load")

    monkeypatch.setattr(router, "_prepare_synth", no_model)
    second = _run(router, chapter, cache, opts=opts)
    assert second[2] is True and second[0] == first[0]
    # Once a recognizer is installed, the render asks it and checks the takes.
    installed["value"] = True
    monkeypatch.setattr(asr, "transcribe_check", lambda _audio, **_kw: "speech")
    monkeypatch.setattr(router, "_prepare_synth", prepare)
    stub.calls.clear()
    path, _dur, cached, _stats = _run(router, chapter, cache, opts=opts)
    assert cached is False and set(stub.calls) == {_LAMP, _RIVER}
    assert _checked(router, path)["unchecked"] == 0


@pytest.mark.parametrize("installed", [False, True], ids=["none installed", "heard no words"])
def test_unheard_takes_say_whether_a_recognizer_was_missing(installed, engine, tmp_path,
                                                            monkeypatch):
    """A near-silent take an installed recognizer heard no words in is
    unchecked too, and is no reason to tell the user to install one: the
    result says which it was, and keeps saying it from the cache."""
    router = engine
    ab = _mod("services.audiobook")
    asr = _mod("services.asr_backend")
    stub = _Engine()
    monkeypatch.setattr(asr, "reference_recognizer_installed", lambda: installed)
    monkeypatch.setattr(asr, "transcribe_check", lambda _audio, **_kw: None)
    cache = _cache(tmp_path)
    opts = ab.ExpressiveOptions(verify_speech=True)
    path, _d, _c, stats = router._render_chapter_cached(_chapter(_LAMP, _RIVER), stub.synth, SR,
                                                        "eng", _resolve, cache, opts=opts)
    assert stats["speech_check"]["unchecked"] == 2
    assert stats["speech_check"]["no_recognizer"] is (not installed)
    assert _checked(router, path)["no_recognizer"] is (not installed)


def test_the_speech_check_does_not_move_a_remote_chapter(engine, tmp_path):
    """A worker never runs the check, so a chapter rendered there is the same
    unchecked render either way: the check no longer keys it (it used to,
    rendering identical audio again under a key that claimed a check)."""
    router = engine
    ab = _mod("services.audiobook")
    cache = _cache(tmp_path)
    chapter = _chapter(_LAMP)
    kw = dict(engine_id="eng", default_voice=None, voice_map=None, language=None,
              lexicon=None, cache_dir=cache)
    plain, plain_path = router._remote_chapter_call(chapter, opts=ab.ExpressiveOptions(), **kw)
    checked, checked_path = router._remote_chapter_call(
        chapter, opts=ab.ExpressiveOptions(verify_speech=True), **kw)
    assert checked_path == plain_path
    assert checked.params["expressive"]["verify_speech"] is False
    # A chapter cached under the key that claimed the check is still found.
    params = {k: v for k, v in checked.params.items() if k != "text"}
    params["expressive"] = {**params["expressive"], "verify_speech": True}
    legacy = os.path.join(cache, "remote-" + hashlib.sha256(
        json.dumps(params, sort_keys=True, default=str).encode()).hexdigest() + ".wav")
    _write_wav(legacy)
    _call, path = router._remote_chapter_call(
        chapter, opts=ab.ExpressiveOptions(verify_speech=True), **kw)
    assert path == plain_path and os.path.exists(path) and not os.path.exists(legacy)


# ── A language the engine now receives otherwise ────────────────────────────

def test_a_language_the_engine_now_receives_otherwise_renders_again(
        engine, preset, tmp_path, monkeypatch):
    """OmniVoice read the pickers' "Arabic" as Auto and now receives Standard
    Arabic's id: a chapter cached under "Arabic" before renders again — once,
    every take of it, so an edit never joins takes read as Auto to hinted
    ones — while a language it receives as before keeps its cache."""
    router = engine
    ab = _mod("services.audiobook")
    codes = _mod("services.language_codes")
    stub = _Engine()
    cache = _cache(tmp_path)
    chapter = _chapter(_LAMP, _RIVER)
    edited = _chapter(_LAMP, "The river ran under the old bridge.")
    opts = ab.ExpressiveOptions()

    def render(language, script=chapter):
        return router._render_chapter_cached(script, stub.synth, SR, "omnivoice", _resolve, cache,
                                             language=language, opts=opts)

    def outline(language):
        return router._chapter_cache_state(
            chapter, decision=types.SimpleNamespace(remote=False), default_voice=None,
            language=language, opts=opts, voice_map=None, lexicon=None, cache_dir=cache)[1]

    real = codes.language_input_changed
    monkeypatch.setattr(codes, "language_input_changed", lambda *_a: False)  # a build before
    for language in ("Arabic", "English"):
        render(language)
    monkeypatch.setattr(codes, "language_input_changed", real)
    stub.calls.clear()
    assert outline("English") is True and outline("Arabic") is False
    _path, _d, cached, _s = render("English")
    assert cached is True and stub.calls == []
    _path, _d, cached, stats = render("Arabic", edited)
    assert cached is False and stats["cached"] == 0 and len(stub.calls) == 2
    stub.calls.clear()
    _path, _d, cached, _s = render("Arabic", edited)
    assert cached is True and stub.calls == []


def test_a_remote_chapter_in_such_a_language_renders_again(engine, tmp_path, monkeypatch):
    router = engine
    ab = _mod("services.audiobook")
    codes = _mod("services.language_codes")
    chapter = _chapter(_LAMP)

    def remote(language):
        return router._remote_chapter_call(
            chapter, engine_id="omnivoice", default_voice=None, voice_map=None,
            language=language, lexicon=None, opts=ab.ExpressiveOptions(),
            cache_dir=_cache(tmp_path))[1]

    now = {language: remote(language) for language in ("Arabic", "English")}
    monkeypatch.setattr(codes, "language_input_changed", lambda *_a: False)  # a build before
    assert remote("Arabic") != now["Arabic"]
    assert remote("English") == now["English"]
