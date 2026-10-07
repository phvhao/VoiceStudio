"""Previews stop with their client; renders say how far a chapter is.

* Stop frees the GPU within one take: ``/audiobook/preview`` and the plain
  ``/generate`` a Stories line preview calls notice a client that went away
  (``api.disconnect.cancel_on_disconnect``) and cancel the render, which stops
  before its next take. They used to render every take to the end, and their
  render trace said "complete"; it says "cancelled" now.
* Progress inside a chapter: the render's SSE stream and a streamed preview
  carry ``progress`` events — what the chapter waits for, then the takes done
  of those it renders and how long one takes — never into job history, whose
  cap would push out the chapter events a resume reads.

No model: each take is a short sleep; ffmpeg is stubbed.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import threading
import time
import urllib.parse

import pytest
import torch
from fastapi import HTTPException

SR = 24000

#: Long enough apart that none is read with the next one.
SENTENCES = [f"This is sentence number {word} of the little test chapter here."
             for word in ("one", "two", "three", "four", "five", "six")]


class SlowSynth:
    """A synth whose every take takes ``delay`` seconds; records each take."""

    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.calls: list[str] = []
        self.started = threading.Event()
        self._lock = threading.Lock()

    def __call__(self, text, voice_id, speed=None, attempt=0, occurrence=None, retake=""):
        with self._lock:
            self.calls.append(text)
        self.started.set()
        time.sleep(self.delay)
        return torch.zeros(SR // 20)


@pytest.fixture
def outputs(tmp_path, monkeypatch):
    from core import config, db

    monkeypatch.setattr(config, "OUTPUTS_DIR", str(tmp_path))
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "jobs.db"))
    db.init_db()
    return tmp_path


@pytest.fixture
def engine(monkeypatch):
    """The render's engine: a stub nothing else knows, so no cache key or
    preset of a real engine applies, and every chapter renders here."""
    from api.routers import audiobook
    from services import ffmpeg_utils

    synth = SlowSynth()

    async def prepare(default_voice, language=None, opts=None, voice_map=None, lease=None):
        return synth, SR, lambda _voice: {"ref_audio": None, "ref_text": None,
                                          "instruct": None, "seed": None}, "stub"

    async def mux(command, **_kw):
        with open(command[-1], "wb") as f:
            f.write(b"book")

    monkeypatch.setattr("services.tts_backend.active_backend_id", lambda: "stub")
    monkeypatch.setattr(audiobook, "_prepare_synth", prepare)
    monkeypatch.setattr(audiobook, "_resolve_default_language", lambda *_a: None)
    monkeypatch.setattr(ffmpeg_utils, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(ffmpeg_utils, "run_ffmpeg", mux)
    return synth


def _script(sentences=SENTENCES) -> str:
    return "# One\n" + " ".join(sentences)


def _wait_for_idle_pool(timeout: float = 10.0) -> None:
    """Until no GPU-pool job runs (an earlier test's abandoned job included)."""
    from services.model_manager import gpu_pool_stats

    deadline = time.monotonic() + timeout
    while gpu_pool_stats()["running"] and time.monotonic() < deadline:
        time.sleep(0.02)
    assert gpu_pool_stats()["running"] == 0, "a GPU-pool job is still running"


class _Client:
    """A request whose client leaves once ``leaves()`` is true."""

    method = "POST"

    def __init__(self, leaves):
        self.url = type("Url", (), {"path": "/audiobook/preview"})()
        self._leaves = leaves

    async def is_disconnected(self) -> bool:
        return bool(self._leaves())


def _events(frames: list[str]) -> list[dict]:
    return [json.loads(frame[len("data:"):].strip()) for frame in frames]


# ── the shared helper ───────────────────────────────────────────────────────

def test_cancel_on_disconnect_returns_the_work_while_the_client_stays():
    from api.disconnect import cancel_on_disconnect

    async def work():
        await asyncio.sleep(0.05)
        return 42

    assert asyncio.run(cancel_on_disconnect(_Client(lambda: False), work(), poll_s=0.01)) == 42
    assert asyncio.run(cancel_on_disconnect(None, work())) == 42


def test_cancel_on_disconnect_cancels_the_work_and_traces_it_cancelled():
    from api.disconnect import cancel_on_disconnect
    from core import render_trace

    cancelled = []

    async def work():
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    trace = render_trace.RenderTrace("preview")

    async def run():
        with trace.activate():
            await cancel_on_disconnect(_Client(lambda: True), work(), poll_s=0.01)

    with pytest.raises(HTTPException) as caught:
        asyncio.run(run())
    assert caught.value.status_code == 499
    assert cancelled == [True]
    # Frozen: the middleware's later "complete" does not replace it.
    trace.finish("complete")
    assert trace.snapshot()["outcome"] == "cancelled"


# ── /generate: the render stops before its next take ────────────────────────

def test_a_generate_take_stops_before_its_next_attempt_once_cancelled():
    from api.routers.generation import GenerateCancelled, _render_take, _render_with_pauses
    from services.inference_cancellation import InferenceCancellation

    scope = InferenceCancellation()
    taken = []

    class Verifier:  # asks for a retake after the first attempt
        def render(self, text, take):
            take(0)
            scope.cancel()  # the client left during the first attempt
            return take(1)

    with scope.activate():
        with pytest.raises(GenerateCancelled):
            _render_take("Hello.", lambda n: taken.append(n) or torch.zeros(10), Verifier())
        assert taken == [0]
        with pytest.raises(GenerateCancelled):
            _render_with_pauses(lambda text: taken.append(text) or torch.zeros(1, 10),
                                [("One.", 100), ("Two.", 0)], SR)
    assert taken == [0]


def _fake_engine(monkeypatch, *, delay: float, first_take):
    import importlib

    tb = importlib.import_module("services.tts_backend")

    class SlowEngine(tb.TTSBackend):
        id = "slow-stop-test"
        display_name = "slow-stop-test (test)"
        supports_cloning = True
        gpu_compat = ("cpu",)
        calls: list = []

        @property
        def sample_rate(self) -> int:
            return SR

        @property
        def supported_languages(self) -> list[str]:
            return ["multi"]

        @classmethod
        def is_available(cls):
            return True, "ready"

        def generate(self, text, **kw):
            type(self).calls.append(text)
            first_take()
            time.sleep(delay)
            g = torch.Generator().manual_seed(len(type(self).calls))
            return (torch.randn(1, SR // 2, generator=g) * 0.2).clamp(-0.7, 0.7)

    tb.reset_active_backend()
    monkeypatch.setitem(tb._REGISTRY, SlowEngine.id, SlowEngine)
    monkeypatch.delenv("OMNIVOICE_TTS_BACKEND", raising=False)
    return SlowEngine


def test_generate_stops_after_the_take_in_progress_when_its_client_leaves(
        tmp_path, monkeypatch):
    """A Stories line preview's Stop: the plain /generate it called cancels
    its render, which ends after the take in progress (it rendered all six)."""
    import core.config as cfg
    import api.routers.generation as gen_mod
    from core import render_trace
    from main import app
    from services import tts_backend

    monkeypatch.setattr(cfg, "OUTPUTS_DIR", str(tmp_path))
    monkeypatch.setattr(gen_mod, "OUTPUTS_DIR", str(tmp_path))
    _wait_for_idle_pool()

    async def run():
        loop = asyncio.get_running_loop()
        leave = asyncio.Event()
        engine = _fake_engine(monkeypatch, delay=1.0,
                              first_take=lambda: loop.call_soon_threadsafe(leave.set))
        body = urllib.parse.urlencode({
            "text": " ".join(SENTENCES), "engine": engine.id, "max_chunk_chars": "70",
        }).encode()
        scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1", "method": "POST", "scheme": "http",
            "path": "/generate", "raw_path": b"/generate", "query_string": b"",
            "root_path": "", "server": ("testserver", 80), "client": ("127.0.0.1", 50000),
            "headers": [(b"host", b"testserver"),
                        (b"content-type", b"application/x-www-form-urlencoded"),
                        (b"content-length", str(len(body)).encode())],
        }
        state = {"sent": False}

        async def receive():
            if not state["sent"]:
                state["sent"] = True
                return {"type": "http.request", "body": body, "more_body": False}
            await leave.wait()  # the client leaves once the first take began
            return {"type": "http.disconnect"}

        sent = []

        async def send(message):
            sent.append(message)

        await app(scope, receive, send)
        return engine, sent

    engine, sent = asyncio.run(run())
    try:
        _wait_for_idle_pool()
        # The take in progress when the client left ended; none started after it.
        assert len(engine.calls) == 1, engine.calls
        assert sent[0]["status"] == 499
        assert render_trace.recent()[-1]["surface"] == "generate"
        assert render_trace.recent()[-1]["outcome"] == "cancelled"
    finally:
        tts_backend.reset_active_backend()


# ── /audiobook/preview ───────────────────────────────────────────────────────

def test_a_preview_stops_after_the_take_in_progress_when_its_client_leaves(outputs, engine):
    from api.routers import audiobook

    engine.delay = 0.8
    _wait_for_idle_pool()
    req = audiobook.AudiobookPreviewRequest(text=_script(), punctuation_pauses={})
    with pytest.raises(HTTPException) as caught:
        asyncio.run(audiobook.audiobook_preview(req, _Client(lambda: engine.calls)))
    assert caught.value.status_code == 499
    _wait_for_idle_pool()
    # It used to render all six takes and answer as if the client still waited.
    assert len(engine.calls) == 1, engine.calls


def _stream_preview(req, client=None) -> list[dict]:
    from api.routers import audiobook

    async def run():
        response = await audiobook.audiobook_preview(req, client)
        return [frame async for frame in response.body_iterator]

    return _events(asyncio.run(run()))


def test_a_streamed_preview_reports_its_takes_then_answers(outputs, engine):
    from api.routers import audiobook

    engine.delay = 0.15
    events = _stream_preview(audiobook.AudiobookPreviewRequest(
        text=_script(), punctuation_pauses={}, stream=True))
    *progress, done = events
    assert done["type"] == "done" and done["output"].endswith(".wav")
    assert done["cached"] is False and done["title"] == "One"
    assert progress and {event["type"] for event in progress} == {"progress"}
    rendering = [event for event in progress if event["phase"] == "rendering"]
    assert rendering[0]["total"] == len(SENTENCES) and rendering[0]["phrases"] is True
    dones = [event["done"] for event in rendering]
    assert dones == sorted(dones) and dones[-1] >= len(SENTENCES) - 1
    # The wall-clock pace of a take: about the stub's 0.15 s.
    paced = [event["rate"] for event in rendering if "rate" in event]
    assert paced and all(0.1 <= rate <= 1.0 for rate in paced), paced


def test_a_streamed_preview_stops_when_its_client_leaves(outputs, engine):
    from api.routers import audiobook

    engine.delay = 0.8
    _wait_for_idle_pool()
    events = _stream_preview(audiobook.AudiobookPreviewRequest(
        text=_script(), punctuation_pauses={}, stream=True), _Client(lambda: engine.calls))
    assert "done" not in [event["type"] for event in events]
    _wait_for_idle_pool()
    assert len(engine.calls) == 1, engine.calls


def test_a_preview_says_what_its_chapter_waits_for(outputs, engine, monkeypatch):
    """Loading the voice model, then a GPU busy with another job."""
    from api.routers import audiobook
    from services.model_manager import _get_gpu_pool, gpu_pool_stats

    _wait_for_idle_pool()
    real_prepare = audiobook._prepare_synth

    async def slow_prepare(*args, **kwargs):
        await asyncio.sleep(0.3)  # the model loads
        return await real_prepare(*args, **kwargs)

    monkeypatch.setattr(audiobook, "_voice_model_loads", lambda _engine: True)
    monkeypatch.setattr(audiobook, "_prepare_synth", slow_prepare)
    # Every GPU worker is busy with another job until the chapter has waited.
    release = threading.Event()
    pool = _get_gpu_pool()
    blockers = [pool.submit(release.wait, 10)]
    deadline = time.monotonic() + 5
    while gpu_pool_stats()["running"] < 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    blockers += [pool.submit(release.wait, 10)
                 for _ in range(gpu_pool_stats()["workers"] - 1)]
    while (gpu_pool_stats()["running"] < gpu_pool_stats()["workers"]
           and time.monotonic() < deadline):
        time.sleep(0.01)
    threading.Timer(1.0, release.set).start()
    try:
        events = _stream_preview(audiobook.AudiobookPreviewRequest(
            text=_script(SENTENCES[:2]), punctuation_pauses={}, stream=True))
    finally:
        release.set()
    phases = [event["phase"] for event in events if event["type"] == "progress"]
    assert phases[:2] == ["loading", "queued"], phases
    assert phases[-1] == "rendering"
    assert events[-1]["type"] == "done"


# ── the render's SSE stream ──────────────────────────────────────────────────

def _render(plan_text: str, *, is_disconnected=None, job_id="progress1",
            trace=None) -> list[dict]:
    from api.routers import audiobook

    # Read sentence by sentence, as the app reads a book by default.
    opts = audiobook._expressive_opts(
        audiobook.AudiobookPreviewRequest(text="", punctuation_pauses={}))

    async def run():
        with trace.activate() if trace is not None else contextlib.nullcontext():
            return [frame async for frame in audiobook._render_longform_sse(
                audiobook.parse_audiobook_script(plan_text), default_voice=None,
                opts=opts, job_id=job_id, is_disconnected=is_disconnected)]

    return _events(asyncio.run(run()))


def test_a_render_streams_take_progress_but_never_into_job_history(outputs, engine):
    from core import job_store

    engine.delay = 0.1
    # Chapter two says other sentences: the same ones would reuse chapter
    # one's takes, and render none.
    events = _render(_script() + "\n# Two\n" + " ".join(
        sentence.replace("little", "second") for sentence in SENTENCES[:3]))
    progress = [event for event in events if event["type"] == "progress"]
    assert {event["index"] for event in progress} == {0, 1}
    totals = {event["index"]: event["total"] for event in progress if "total" in event}
    assert totals == {0: len(SENTENCES), 1: 3}
    # Each chapter's progress comes before its chapter event.
    for at, event in enumerate(events):
        if event["type"] == "chapter":
            assert all(e["index"] != event["index"] for e in events[at:]
                       if e["type"] == "progress")
    assert events[-1]["type"] == "done"
    kept = [json.loads(row["payload"])["type"] for row in job_store.events_since("progress1")]
    assert "progress" not in kept and kept.count("chapter") == 2


def test_a_render_stops_mid_chapter_when_its_client_leaves(outputs, engine):
    """The chapter boundary was the only place a render looked: a long
    chapter rendered out after Stop."""
    from core import job_store, render_trace

    engine.delay = 0.8
    _wait_for_idle_pool()
    trace = render_trace.RenderTrace("audiobook")
    events = _render(_script(), is_disconnected=lambda: _async(bool(engine.calls)),
                     job_id="leaves1", trace=trace)
    assert events[-1]["type"] == "stopped" and events[-1]["rendered"] == 0
    _wait_for_idle_pool()
    assert len(engine.calls) == 1, engine.calls
    assert job_store.get("leaves1")["status"] == "cancelled"
    assert trace.snapshot()["outcome"] == "cancelled"


async def _async(value):
    return value


def test_progress_counts_only_the_takes_left_to_render(outputs, engine):
    """After one sentence is edited, the chapter renders that take alone."""
    from api.routers import audiobook

    _stream_preview(audiobook.AudiobookPreviewRequest(
        text=_script(), punctuation_pauses={}, stream=True))
    engine.calls.clear()
    edited = [*SENTENCES[:2], "This sentence was written again by its author today.",
              *SENTENCES[3:]]
    events = _stream_preview(audiobook.AudiobookPreviewRequest(
        text=_script(edited), punctuation_pauses={}, stream=True))
    totals = [event["total"] for event in events
              if event["type"] == "progress" and "total" in event]
    assert totals and set(totals) == {1}
    assert engine.calls == [edited[2]]
