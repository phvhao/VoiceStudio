"""Rendered timeline: where every phrase of a finished book is heard.

The audiobook reader used to spread each chapter's words evenly over its
duration, so the highlight drifted at every pause, voice change or slow
passage. The renderer knows exactly where each sentence/clause take lands —
it joins them itself — so it now keeps that, next to every WAV it caches and
next to the finished book. These tests pin the measurement against the real
sample offsets of constructed takes (pauses, gaps, trims, leveling, retakes,
crossfaded chunks), the cache sidecars (segment and chapter layers, with and
without a sidecar, eviction, adoption), the remote worker's embedded timing,
the book sidecar and its endpoint, and that default renders and cache keys are
untouched. Engine boundary stubbed throughout — no model, no GPU.
"""
import asyncio
import importlib
import json
import os

import pytest
import torch

SR = 1000  # 40-sample trim margin at the default 40 ms: exact and tiny


@pytest.fixture(autouse=True)
def _runtime_symbols():
    # Bound per test: other suites reload these modules.
    audiobook = importlib.import_module("services.audiobook")
    for name in ("Chapter", "ExpressiveOptions", "Span", "synthesize_chapter", "book_timeline",
                 "span_display_takes", "_take_texts"):
        globals()[name] = getattr(audiobook, name)
    lr = importlib.import_module("services.longform_render")
    for name in ("load_chapter_timeline", "prune_cache_dir", "timeline_sidecar_path",
                 "write_chapter_timeline", "write_json_atomic", "SEGMENT_SUBDIR"):
        globals()[name] = getattr(lr, name)


def _loud_length(text: str, attempt: int = 0) -> int:
    """Each take's speech length, distinct per text (and per retake)."""
    return 60 + 11 * len(text) + 23 * attempt


def _take(text: str, attempt: int = 0, pad: int = 120):
    """A take with the engine's own silent lead-in and tail around its speech."""
    n = _loud_length(text, attempt)
    return torch.cat([torch.zeros(pad), torch.full((n,), 0.25), torch.zeros(pad)]).reshape(1, -1)


def _synth(calls=None):
    def synth(text, voice_id, speed=None, attempt=0):
        if calls is not None:
            calls.append(text)
        return _take(text, attempt)
    return synth


_PAUSES = {"sentence": 300, "ellipsis": 500, "semicolon": 250, "colon": 250,
           "dash": 200, "comma": 120}


def _spoken_lengths(audio, start, end):
    seg = audio.reshape(-1, audio.shape[-1])[0, start:end]
    loud = seg[seg.abs() > 1e-6]
    return loud.numel(), (loud.numel() == 0 or bool(torch.allclose(loud, loud[0].expand_as(loud))))


def _assert_measured(audio, doc, spans, split, length_of=_loud_length):
    """Every recorded take range holds exactly that take's speech, and every
    sample of speech in the chapter lies in some range."""
    assert doc["samples"] == audio.shape[-1]
    covered = 0
    for item in doc["spans"]:
        takes = _take_texts(spans[item["span"]].text, **split)
        assert item["units"], "phrase timing expected"
        for k, a, b in item["units"]:
            assert item["start"] <= a < b <= item["end"]
            count, uniform = _spoken_lengths(audio, a, b)
            assert count == length_of(takes[k]) and uniform, (takes[k], a, b)
            covered += count
    total, _ = _spoken_lengths(audio, 0, audio.shape[-1])
    assert covered == total


# ── measured in synthesize_chapter ──────────────────────────────────────────

@pytest.mark.parametrize("trim_edges", [False, True])
@pytest.mark.parametrize("level_voices", [False, True])
def test_phrase_ranges_are_the_takes_real_sample_offsets(trim_edges, level_voices):
    spans = [
        Span(voice_id=None, text="One. Two three.\nFour five six"),
        Span(voice_id="Mara", text="Seven eight; nine.", pause_ms_after=300),
        Span(voice_id=None, text="", pause_ms_after=200),
        Span(voice_id=None, text="Ten.\n\nEleven twelve, thirteen."),
    ]
    split = {"paragraph_gap_ms": 250, "punctuation_pauses": _PAUSES, "split_commas": True}
    timing: list = []
    audio, duration = synthesize_chapter(
        spans, _synth(), SR, line_gap_ms=150, trim_edges=trim_edges,
        level_voices=level_voices, voice_gains={"Mara": 4.0} if level_voices else None,
        timing=timing, **split)
    (doc,) = timing
    assert doc["phrases"] is True and doc["sample_rate"] == SR
    assert [s["span"] for s in doc["spans"]] == [0, 1, 3]  # the pause-only span has no audio
    assert [len(s["units"]) for s in doc["spans"]] == [3, 2, 3]
    _assert_measured(audio, doc, spans, split)
    assert duration == audio.shape[-1] / SR


def test_retaken_phrases_are_timed_by_the_take_that_was_kept():
    class Verifier:
        def render(self, text, take):
            take(0)
            return take(1) if text.startswith("Two") else take(0)

    spans = [Span(voice_id=None, text="One. Two three. Four.")]
    split = {"punctuation_pauses": _PAUSES}
    timing: list = []
    audio, _ = synthesize_chapter(spans, _synth(), SR, verifier=Verifier(), timing=timing, **split)
    _assert_measured(audio, timing[0], spans, split,
                     length_of=lambda t: _loud_length(t, 1 if t.startswith("Two") else 0))


def test_a_take_with_no_audio_has_no_range_and_shifts_nothing():
    def synth(text, voice_id, speed=None):
        return torch.zeros(1, 0) if text.startswith("Two") else _take(text)

    spans = [Span(voice_id=None, text="One. Two three. Four.")]
    split = {"punctuation_pauses": _PAUSES}
    timing: list = []
    audio, _ = synthesize_chapter(spans, synth, SR, timing=timing, **split)
    units = timing[0]["spans"][0]["units"]
    assert [k for k, _a, _b in units] == [0, 2]
    for k, a, b in units:
        text = _take_texts(spans[0].text, **split)[k]
        assert _spoken_lengths(audio, a, b)[0] == _loud_length(text)


def test_crossfaded_chunks_tile_the_span():
    chunked_tts = importlib.import_module("services.chunked_tts")
    # Three 100-sample chunks, 20-sample crossfade: they meet mid-overlap.
    assert chunked_tts.chunk_ranges([100, 100, 100], 20) == [(0, 90), (90, 170), (170, 260)]
    joined = chunked_tts.concatenate_audio_chunks([torch.ones(100)] * 3, 1000, crossfade_ms=20)
    assert joined.shape[-1] == 260
    # A chunk shorter than the crossfade never sends a range backwards.
    ranges = chunked_tts.chunk_ranges([100, 30, 100], 50)
    assert all(a <= b for a, b in ranges) and all(ranges[i][1] <= ranges[i + 1][0]
                                                  for i in range(len(ranges) - 1))

    sentence = "Word " * 30 + "end. "
    spans = [Span(voice_id=None, text=sentence * 8)]  # > 800 chars: several chunks
    timing: list = []
    audio, _ = synthesize_chapter(spans, _synth(), SR, timing=timing)
    (item,) = timing[0]["spans"]
    assert timing[0]["phrases"] is False
    chunks = _take_texts(spans[0].text)
    assert len(chunks) > 1 and [k for k, *_ in item["units"]] == list(range(len(chunks)))
    edges = [item["start"]] + [b for _k, _a, b in item["units"]]
    assert [a for _k, a, _b in item["units"]] == edges[:-1]  # contiguous
    assert edges[-1] == item["end"] == audio.shape[-1]


@pytest.mark.parametrize("split", [{}, {"punctuation_pauses": _PAUSES, "split_commas": True}])
def test_asking_for_timing_never_changes_the_audio(split):
    spans = [Span(voice_id=None, text="One, two. Three."), Span(voice_id="B", text="Four.")]
    plain, _ = synthesize_chapter(spans, _synth(), SR, line_gap_ms=100, **split)
    timed, _ = synthesize_chapter(spans, _synth(), SR, line_gap_ms=100, timing=[], **split)
    assert torch.equal(plain, timed)


# ── cache layers ────────────────────────────────────────────────────────────

def _resolve(_voice_id):
    return {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}


@pytest.fixture
def unmarked(monkeypatch):
    watermark = importlib.import_module("services.watermark")
    monkeypatch.setattr(watermark, "will_mark", lambda: False)
    monkeypatch.setattr(watermark, "mark_synthetic", lambda audio, *_a, **_k: audio)


def _render(tmp_path, chapter, opts, calls=None):
    from api.routers.audiobook import _render_chapter_cached

    path, _dur, cached, _stats = _render_chapter_cached(
        chapter, _synth(calls), SR, "eng", _resolve, str(tmp_path), None, None, opts, None)
    return path, cached


def test_segment_cache_keeps_phrase_timing_and_old_segments_fall_back_to_spans(
        tmp_path, unmarked):
    chapter = Chapter(title="C", spans=[Span(voice_id=None, text="One. Two three."),
                                        Span(voice_id="B", text="Four five.")])
    phrases = ExpressiveOptions(punctuation_pauses=tuple(sorted(_PAUSES.items())))
    calls: list = []
    fresh, _ = _render(tmp_path, chapter, phrases, calls)
    first = load_chapter_timeline(fresh)
    assert first is not None and all(s["units"] for s in first["spans"])
    seg_dir = tmp_path / SEGMENT_SUBDIR
    sidecars = sorted(seg_dir.glob("*.timeline.json"))
    assert len(sidecars) == 2 and len(list(seg_dir.glob("*.wav"))) == 2

    # Leveling keys the chapter, never a take: re-assembled from cached
    # segments, the phrases are where they were.
    leveled, cached = _render(tmp_path, chapter, dataclass_replace(phrases, level_voices=True), calls)
    assert not cached and len(calls) == 3
    assert load_chapter_timeline(leveled)["spans"] == first["spans"]

    # A segment cached before timing was kept still hits, timed as a whole.
    for sidecar in sidecars:
        sidecar.unlink()
    gained, _ = _render(tmp_path, chapter, dataclass_replace(phrases, voice_gains=(("B", 3.0),)),
                        calls)
    assert len(calls) == 3
    spans = load_chapter_timeline(gained)["spans"]
    assert [s["units"] for s in spans] == [None, None]
    assert [(s["start"], s["end"]) for s in spans] == [(s["start"], s["end"])
                                                       for s in first["spans"]]


def dataclass_replace(opts, **changes):
    import dataclasses

    return dataclasses.replace(opts, **changes)


def test_segment_sidecar_from_another_take_is_ignored(tmp_path):
    lr = importlib.import_module("services.longform_render")
    cache = lr.SegmentCache(str(tmp_path), sample_rate=SR, engine_id="eng")
    span = Span(voice_id=None, text="Hello.")
    cache.store(span, torch.ones(1, 500))
    cache.store_timing(span, [[0, 10, 490]], samples=500)
    assert cache.load_timing(span, samples=500) == [[0, 10, 490]]
    assert cache.load_timing(span, samples=499) is None  # not this audio
    # Storing a new take drops the old take's timing with it.
    cache.store(span, torch.ones(1, 400))
    assert cache.load_timing(span, samples=400) is None
    side = timeline_sidecar_path(cache._path(span))
    with open(side, "w", encoding="utf-8") as f:
        f.write("{not json")
    assert cache.load_timing(span, samples=400) is None


def test_chapter_cache_hit_reads_its_sidecar_and_falls_back_without_one(tmp_path, unmarked):
    chapter = Chapter(title="C", spans=[Span(voice_id=None, text="One. Two.")])
    opts = ExpressiveOptions(punctuation_pauses=tuple(sorted(_PAUSES.items())))
    path, cached = _render(tmp_path, chapter, opts)
    doc = load_chapter_timeline(path)
    assert not cached and doc is not None
    side = timeline_sidecar_path(path)
    assert side == path[:-len(".wav")] + ".timeline.json"

    calls: list = []
    hit, cached = _render(tmp_path, chapter, opts, calls)
    assert (hit, cached, calls) == (path, True, [])
    assert load_chapter_timeline(hit) == doc

    with open(side, "w", encoding="utf-8") as f:
        f.write("{torn")
    assert load_chapter_timeline(hit) is None  # corrupt → the chapter is timed as a whole
    os.remove(side)
    assert load_chapter_timeline(hit) is None  # cached before timing was kept
    # Timing written for other audio under the same name is never believed.
    write_chapter_timeline(hit, dict(doc, samples=doc["samples"] + 1,
                                     spans=[dict(doc["spans"][0], end=doc["samples"] + 1)]))
    assert load_chapter_timeline(hit) is None


def test_prune_removes_a_wavs_sidecar_with_it_and_orphans(tmp_path):
    import time

    def seed(name, size, age):
        p = tmp_path / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\0" * size)
        t = time.time() - age
        os.utime(p, (t, t))
        return p

    old = seed("old.wav", 1000, 300)
    old_side = seed("old.timeline.json", 50, 300)
    new = seed("segments/new.wav", 1000, 10)
    new_side = seed("segments/new.timeline.json", 50, 10)
    orphan = seed("segments/gone.timeline.json", 50, 10)
    inputs = seed("inputs/abc.json", 50, 400)
    remaining, removed = prune_cache_dir(str(tmp_path), max_bytes=1200)
    assert removed == 1  # WAVs only: sidecars are never counted as audio
    assert not old.exists() and not old_side.exists() and not orphan.exists()
    assert new.exists() and new_side.exists() and inputs.exists()
    assert remaining == 1100


def test_adopting_a_legacy_entry_moves_its_timing(tmp_path):
    lr = importlib.import_module("services.longform_render")
    legacy, new = tmp_path / "legacy.wav", tmp_path / "new.wav"
    legacy.write_bytes(b"x")
    (tmp_path / "legacy.timeline.json").write_text("{}", encoding="utf-8")
    assert lr.adopt_cached_file(str(legacy), str(new)) == str(new)
    assert (tmp_path / "new.timeline.json").exists()
    assert not (tmp_path / "legacy.timeline.json").exists()
    # No timing with the legacy entry: a stale one under the new key goes.
    legacy.write_bytes(b"y")
    assert lr.adopt_cached_file(str(legacy), str(new)) == str(new)
    assert not (tmp_path / "new.timeline.json").exists()


# ── remote worker ───────────────────────────────────────────────────────────

def test_remote_chapter_carries_its_timing_inside_the_wav(tmp_path):
    import numpy as np
    import soundfile as sf

    from worker.executor import TaskExecutor, _with_timeline

    class Backend:
        sample_rate = SR

        def generate(self, text, **kwargs):
            return _take(text)

    rows = [{"text": "One. Two.", "pause_ms_after": 200}, {"text": "Three.", "voice": "B"}]
    params = {"ref_audio": [None, None], "watermark": False,
              "expressive": {"punctuation_pauses": _PAUSES}}
    timing: list = []
    audio = TaskExecutor._synthesize_audiobook(
        Backend(), rows, [{"ref_text": None, "instruct": None}] * 2, params, timing)
    payload, meta = TaskExecutor._encode(audio, params, Backend())
    timed, timed_meta = _with_timeline(payload, meta, timing[0])
    assert timed_meta["bytes"] == len(timed) > len(payload) and timed_meta["sample_rate"] == SR

    plain_path, timed_path = tmp_path / "remote-old.wav", tmp_path / "remote-new.wav"
    plain_path.write_bytes(payload)
    timed_path.write_bytes(timed)
    # Every reader still sees exactly the same audio.
    a, _ = sf.read(str(plain_path), dtype="float32")
    b, _ = sf.read(str(timed_path), dtype="float32")
    assert np.array_equal(a, b)
    assert load_chapter_timeline(str(plain_path)) is None  # an older worker's result
    doc = load_chapter_timeline(str(timed_path))
    assert doc == timing[0]
    spans = [Span(voice_id=str(i), text=r["text"]) for i, r in enumerate(rows)]
    _assert_measured(torch.from_numpy(b).reshape(1, -1), doc, spans,
                     {"punctuation_pauses": _PAUSES})


def test_worker_audiobook_still_renders_without_a_timing_list():
    from worker.executor import TaskExecutor

    class Backend:
        sample_rate = SR

        def generate(self, text, **kwargs):
            return _take(text)

    audio = TaskExecutor._synthesize_audiobook(
        Backend(), [{"text": "Hi."}], [{"ref_text": None, "instruct": None}],
        {"ref_audio": [None], "watermark": False, "expressive": {}})
    assert audio.shape[-1] > 0


# ── book timeline ───────────────────────────────────────────────────────────

def test_display_text_is_the_script_not_what_the_engine_was_told():
    split = {"punctuation_pauses": _PAUSES}
    takes = span_display_takes("Say [[gif|jiff]] now. [laugh] Dr Who.  Yes.",
                               "Say [[gif|jiff]] now. [laugh] Dr Who.  Yes.",
                               lexicon={"Dr": "Doctor"}, **split)
    assert takes == ["Say gif now.", "Dr Who.", "Yes."]
    # Cut differently from what was spoken: the normalized text stands in.
    assert span_display_takes("Room 1. Then.", "Room one point. Then.", **split) == [
        "Room one point.", "Then."]


def test_book_timeline_offsets_precision_and_voices():
    split_opts = ExpressiveOptions(punctuation_pauses=tuple(sorted(_PAUSES.items())))
    ch1 = Chapter(title="One", spans=[Span(voice_id="narrator", text="Hello there. Bye."),
                                      Span(voice_id="Mara", text="Hi [[Nguyen|Win]].")])
    ch2 = Chapter(title="Two", spans=[Span(voice_id="narrator", text="Old chapter.")])
    ch3 = Chapter(title="Three", spans=[Span(voice_id="narrator", text="Span only.")])
    doc1 = {"version": 1, "sample_rate": SR, "samples": 3000, "phrases": True, "spans": [
        {"span": 0, "start": 0, "end": 1500, "units": [[0, 41, 700], [1, 1000, 1500]]},
        {"span": 1, "start": 1800, "end": 3000, "units": [[0, 1800, 2950]]},
    ]}
    doc3 = {"version": 1, "sample_rate": SR, "samples": 1000, "phrases": True,
            "spans": [{"span": 0, "start": 0, "end": 1000, "units": None}]}
    tl = book_timeline("audiobook_x.m4b", [(ch1, 3.0, doc1), (ch2, 2.5, None), (ch3, 1.0, doc3)],
                       default_voice="narrator", opts=split_opts)
    assert tl["version"] == 1 and tl["output"] == "audiobook_x.m4b" and tl["duration"] == 6.5
    one, two, three = tl["chapters"]
    assert (one["precision"], two["precision"], three["precision"]) == ("phrase", "chapter", "span")
    assert one["phrases"] == [
        {"text": "Hello there.", "start": 0.041, "end": 0.7, "voice": None},
        {"text": "Bye.", "start": 1.0, "end": 1.5, "voice": None},
        {"text": "Hi Nguyen.", "start": 1.8, "end": 2.95, "voice": "Mara"},
    ]
    assert (two["start"], two["end"]) == (3.0, 5.5)
    assert two["phrases"] == [{"text": "Old chapter.", "start": 3.0, "end": 5.5, "voice": None}]
    assert three["phrases"] == [{"text": "Span only.", "start": 5.5, "end": 6.5, "voice": None}]
    # Timing that names a span the chapter does not have is never trusted.
    bad = dict(doc3, spans=[dict(doc3["spans"][0], span=4)])
    assert book_timeline("a_b.m4b", [(ch3, 1.0, bad)])["chapters"][0]["precision"] == "chapter"


def test_book_sidecar_is_written_atomically(tmp_path, monkeypatch):
    lr = importlib.import_module("services.longform_render")
    target = tmp_path / "audiobook_x.m4b.timeline.json"
    assert write_json_atomic(str(target), {"version": 1})
    assert json.loads(target.read_text(encoding="utf-8")) == {"version": 1}

    def torn(doc, f, **_kw):
        f.write('{"version": 1, "chap')
        raise OSError("disk full")

    monkeypatch.setattr(lr.json, "dump", torn)
    assert not write_json_atomic(str(target), {"version": 2})
    # The reader still sees the whole previous file, and no temp is left.
    assert json.loads(target.read_text(encoding="utf-8")) == {"version": 1}
    assert [p.name for p in tmp_path.iterdir()] == [target.name]


@pytest.fixture
def outputs(tmp_path, monkeypatch):
    from core import config, db

    monkeypatch.setattr(config, "OUTPUTS_DIR", str(tmp_path))
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "jobs.db"))
    db.init_db()
    return tmp_path


def test_finished_book_writes_its_timeline_and_skips_failed_chapters(outputs, monkeypatch):
    from api.routers import audiobook
    from services import ffmpeg_utils, gpu_gateway

    monkeypatch.setattr(ffmpeg_utils, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(audiobook, "_resolve_default_language", lambda *_a: None)
    monkeypatch.setattr(gpu_gateway, "decide", lambda *_a: object())
    import soundfile as sf

    plan = audiobook.parse_audiobook_script("# A\nFirst one. Second.\n# B\nBroken.\n# C\nThird.")

    async def chapter(ch, **_kw):
        if ch.title == "B":
            raise RuntimeError("engine failed")
        wav = outputs / f"{ch.title}.wav"
        n = 2000 if ch.title == "A" else 1000
        sf.write(str(wav), torch.zeros(n).numpy(), SR)
        if ch.title == "A":  # C was cached before timing was kept
            write_chapter_timeline(str(wav), {
                "version": 1, "sample_rate": SR, "samples": n, "phrases": True,
                "spans": [{"span": 0, "start": 0, "end": 1900,
                           "units": [[0, 40, 900], [1, 1200, 1900]]}]})
        return str(wav), n / SR, ch.title == "C", None

    async def mux(command, **_kw):
        with open(command[-1], "wb") as f:
            f.write(b"book")

    monkeypatch.setattr(audiobook, "_run_chapter", chapter)
    monkeypatch.setattr(ffmpeg_utils, "run_ffmpeg", mux)
    stale = outputs / "audiobook_job1.m4b.timeline.json"
    stale.write_text('{"stale": true}', encoding="utf-8")

    async def run():
        return [e async for e in audiobook._render_longform_sse(
            plan, default_voice=None, opts=ExpressiveOptions(
                punctuation_pauses=tuple(sorted(_PAUSES.items()))), job_id="job1")]

    events = [json.loads(e[len("data: "):]) for e in asyncio.run(run())]
    done = events[-1]
    assert done["type"] == "done" and done["timeline"] is True and done["failed_chapters"] == [1]
    tl = json.loads(stale.read_text(encoding="utf-8"))
    assert tl["output"] == done["output"] == "audiobook_job1.m4b"
    assert [c["title"] for c in tl["chapters"]] == ["A", "C"]
    a, c = tl["chapters"]
    assert a["precision"] == "phrase" and [p["text"] for p in a["phrases"]] == ["First one.",
                                                                                "Second."]
    # Each chapter names the cached audio it came from (the outline's "changed
    # since the last book" reads it).
    assert c == {"title": "C", "start": 2.0, "end": 3.0, "precision": "chapter",
                 "phrases": [{"text": "Third.", "start": 2.0, "end": 3.0, "voice": None}],
                 "sections": [], "key": "C"}
    assert tl["duration"] == 3.0


def test_timeline_endpoint_serves_a_books_sidecar_only(outputs):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient

    from api.routers import audiobook

    doc = {"version": 1, "output": "audiobook_ab12.m4b", "duration": 1.0, "chapters": []}
    (outputs / "audiobook_ab12.m4b.timeline.json").write_text(json.dumps(doc), encoding="utf-8")
    (outputs / "secret.timeline.json").write_text(json.dumps(doc), encoding="utf-8")
    app = FastAPI()
    app.include_router(audiobook.router)
    client = TestClient(app)
    ok = client.get("/audiobook/timeline/audiobook_ab12.m4b")
    assert ok.status_code == 200 and ok.json() == doc
    assert client.get("/audiobook/timeline/story_none.mp3").status_code == 404
    for name in ("secret", "audiobook_ab12.m4b.timeline.json", "..%2Faudiobook_ab12.m4b",
                 "audiobook_ab12.wav", "AUDIOBOOK_ab12.m4b"):
        assert client.get(f"/audiobook/timeline/{name}").status_code == 404, name
    for name in ("../audiobook_ab12.m4b", "audiobook_ab12.m4b/../x.m4b", "a_b.m4b\n"):
        with pytest.raises(HTTPException) as ei:
            audiobook.audiobook_timeline(name)
        assert ei.value.status_code == 404
    # A sidecar that names another book is not this book's timeline.
    (outputs / "story_x.mp3.timeline.json").write_text(json.dumps(doc), encoding="utf-8")
    assert client.get("/audiobook/timeline/story_x.mp3").status_code == 404

@pytest.fixture(autouse=True)
def _cut_at_marks_only(monkeypatch):
    """These tests pin where marks cut phrases and what the cuts carry; joining
    short phrases is tested on its own in test_phrase_rendering.py."""
    from services import chunked_tts

    monkeypatch.setattr(chunked_tts, "PHRASE_MIN_CHARS", 0)
