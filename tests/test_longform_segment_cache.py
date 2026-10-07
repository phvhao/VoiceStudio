"""Segment- and take-level render caches under the longform chapter cache.

Covers the layered contract: segment key stability across every input
dimension; with phrase-by-phrase reading, a one-word edit in a parsed
chapter (plain prose is ONE span) rendering exactly one take, a stopped
chapter resuming from its finished takes, repeats getting a take each, a
retake rendering that take alone, spans cached whole before takes were kept
still hitting; an interrupted chapter resuming from its already-finished
segments; missing / corrupt / foreign-rate files degrading to a clean cache
miss; the byte-cap eviction walking every layer and never a running render's
files; and the fully-unchanged chapter short-circuiting at the chapter key
without ever touching segment or take files. Drives the real
`_render_chapter_cached` with a stub synth (no model/GPU).
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import wave

import pytest
import torch

from api.routers.audiobook import _chapter_cache_keys, _render_chapter_cached
from services.audiobook import (
    Chapter,
    ExpressiveOptions,
    Span,
    chapter_units,
    parse_audiobook_script,
    punctuation_pause_pairs,
)
from services.chunked_tts import DEFAULT_PUNCTUATION_PAUSES
from services.longform_render import (
    SEGMENT_SUBDIR,
    TAKE_SUBDIR,
    CacheHold,
    SegmentCache,
    TakeCache,
    bump_retake,
    chapter_cache_key,
    prune_cache_dir,
    segment_cache_key,
    take_anchor,
)

_SR = 24000
_SIG = "None|None|None|None"  # resolved signature of the no-profile voice


def _resolve(_voice_id):
    return {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}


def _chapter(*texts, title="C1"):
    return Chapter(title=title, spans=[
        Span(voice_id=None, text=t, pause_ms_after=100) for t in texts
    ])


def _counting_synth(calls):
    def synth(text, voice_id, speed=None):
        calls.append(text)
        return torch.full((2400,), 0.1)  # 0.1 s @ 24k
    return synth


def _seg_path(tmp_path, text, **kw):
    key = segment_cache_key(text, sample_rate=_SR, engine_id="eng",
                            voice_id=None, voice_sig=_SIG, **kw)
    return tmp_path / SEGMENT_SUBDIR / f"{key}.wav"


# ── segment key ─────────────────────────────────────────────────────────────

def test_segment_key_deterministic():
    kw = dict(sample_rate=_SR, engine_id="eng", voice_id="v",
              voice_sig="a|b|c|1", speed=None, extra_sig="")
    a = segment_cache_key("Hello there.", **kw)
    assert a == segment_cache_key("Hello there.", **kw)
    assert len(a) == 20


@pytest.mark.parametrize("mutation", [
    {"text": "Different."},
    {"sample_rate": 44100},
    {"engine_id": "kokoro"},
    {"voice_id": "other"},
    {"voice_sig": "x|y|z|2"},
    {"speed": 0.8},
    {"extra_sig": '{"Dr": "Doctor"}'},
])
def test_segment_key_changes_on_any_dimension(mutation):
    kw = dict(text="Hello there.", sample_rate=_SR, engine_id="eng",
              voice_id="v", voice_sig="a|b|c|1", speed=None, extra_sig="")
    base = segment_cache_key(kw["text"], **{k: v for k, v in kw.items() if k != "text"})
    kw.update(mutation)
    mutated = segment_cache_key(kw.pop("text"), **kw)
    assert mutated != base


def test_chapter_key_golden_unchanged_by_segment_layer():
    # Locks the on-disk chapter key derivation: chapter caches written by
    # released versions must keep hitting after the segment layer landed.
    key = chapter_cache_key([(None, "hi", 0, None)], sample_rate=_SR,
                            engine_id="eng", voice_sig={"": _SIG})
    assert key == "ce2accacf51a70d04da0"


@pytest.mark.parametrize("rule, affected", [
    # Before longform resolved [[…]] the brackets were spoken.
    ("has_inline_overrides", "Say [[gif|jiff]]."),
    # Before the quote/caps rules “đừng read as "dừng" and MÙA THU was spelled.
    ("changed_by_quote_and_caps_rules", "“đừng cầu”"),
    ("changed_by_quote_and_caps_rules", "MÙA THU tới."),
])
def test_text_a_reading_change_affects_never_replays_an_older_render(monkeypatch, rule,
                                                                     affected):
    """Text a reading change rewrites must key away from audio cached before
    it, while every other text keeps the exact key its cache was written under."""
    import services.longform_render as lr

    def keys(text):
        return (
            segment_cache_key(text, sample_rate=_SR, engine_id="eng",
                              voice_id=None, voice_sig=_SIG),
            chapter_cache_key([(None, text, 0, None)], sample_rate=_SR,
                              engine_id="eng", voice_sig={"": _SIG}),
        )

    plain = "Plain [text] here, USA and NASA."
    current = {t: keys(t) for t in (affected, plain)}
    monkeypatch.setattr(lr, rule, lambda _text: False)
    before = {t: keys(t) for t in current}
    assert current[plain] == before[plain]
    seg_now, chap_now = current[affected]
    seg_old, chap_old = before[affected]
    assert seg_now != seg_old and chap_now != chap_old


# ── phrase takes: a parsed chapter (plain prose is ONE span) ────────────────
#
# A script of plain paragraphs parses to a single span, so a cache of whole
# spans re-rendered every take of the chapter for a one-word edit, and a Stop
# threw away every take of the span in progress. The test this replaced
# rendered one span per sentence, which no parsed script does.

_PARAGRAPH = ("The old lighthouse keeper climbed the spiral stairs every evening at dusk. "
              "He carried a brass lantern, a thermos of tea, and a notebook full of weather. "
              "Nobody in the village remembered when he had first arrived; "
              "some said forty years, some said more. "
              "The gulls knew him, though, and they wheeled above the gallery "
              "whenever he stepped outside.")
_PHRASES = ExpressiveOptions(punctuation_pauses=punctuation_pause_pairs(DEFAULT_PUNCTUATION_PAUSES))


def _paragraphs():
    """Twelve paragraphs; three of each one's four sentences repeat in every
    paragraph, so each repeat is a take of its own."""
    return [_PARAGRAPH.replace("keeper", f"keeper {i}") for i in range(12)]


def _parsed(paragraphs, title="One"):
    """The chapter the parser makes of these paragraphs (one span)."""
    return parse_audiobook_script(f"# {title}\n\n" + "\n\n".join(paragraphs)).chapters[0]


def _take_synth(calls, *, stop_after=None):
    """A stub engine: a take per text, distinct lengths; ``stop_after``
    takes finish, then the next one fails (Stop, a crash)."""
    def synth(text, voice_id, speed=None):
        if stop_after is not None and len(calls) >= stop_after:
            raise RuntimeError("stopped mid-chapter")
        calls.append(text)
        return torch.full((1, 240 + 7 * len(text)), 0.1)
    return synth


def _render_phrases(tmp_path, chapter, calls, opts=_PHRASES, **kw):
    return _render_chapter_cached(chapter, _take_synth(calls, **kw), _SR, "eng", _resolve,
                                  str(tmp_path), opts=opts)


def test_one_word_edit_in_a_parsed_chapter_renders_one_take(tmp_path):
    chapter = _parsed(_paragraphs())
    assert sum(1 for s in chapter.spans if s.text) == 1  # plain prose: one span
    calls: list[str] = []
    _render_phrases(tmp_path, chapter, calls)
    takes = len(calls)
    assert takes >= 40  # every sentence or clause its own take

    edited = _paragraphs()
    edited[5] = edited[5].replace("brass lantern", "copper lantern")
    calls.clear()
    wav_path, dur, cached, seg_stats = _render_phrases(tmp_path, _parsed(edited), calls)
    assert cached is False  # the chapter changed → chapter-level miss
    assert len(calls) == 1 and "copper lantern" in calls[0]  # only the edited take
    assert seg_stats == {"total": takes, "cached": takes - 1}
    assert os.path.isfile(wav_path) and dur > 0
    # The takes are the cache: the span is not stored whole as well.
    assert len(list((tmp_path / TAKE_SUBDIR).glob("*.wav"))) == takes + 1
    assert not (tmp_path / SEGMENT_SUBDIR).exists()


def test_a_stopped_chapter_loses_at_most_the_take_in_progress(tmp_path):
    chapter = _parsed(_paragraphs())
    order = [text for texts, _ in chapter_units(
        chapter.spans, punctuation_pauses=dict(_PHRASES.punctuation_pauses))[0] for text in texts]
    takes = len(order)
    calls: list[str] = []
    with pytest.raises(RuntimeError):
        _render_phrases(tmp_path, chapter, calls, stop_after=takes - 6)
    assert calls == order[:takes - 6]
    calls.clear()
    _wav, _dur, cached, seg_stats = _render_phrases(tmp_path, chapter, calls)
    assert cached is False and calls == order[-6:]  # each finished take was kept
    assert seg_stats == {"total": takes, "cached": takes - 6}


def test_a_span_cached_whole_before_takes_were_kept_still_hits(tmp_path):
    """Upgrading re-renders nothing: a phrase-rendered span an earlier
    build cached whole is served as it is, its takes counted as reused."""
    chapter = _parsed(_paragraphs()[:2])
    keys = _chapter_cache_keys(chapter, _SR, "eng", _resolve, str(tmp_path), opts=_PHRASES)
    old = SegmentCache(str(tmp_path), sample_rate=_SR, engine_id="eng",
                       voice_sig=keys.voice_sigs, extra_sig=keys.seg_extra_sig)
    old.store(keys.spans[0], torch.full((1, 24000), 0.1))
    takes = sum(len(texts) for texts, _ in chapter_units(
        keys.spans, punctuation_pauses=dict(_PHRASES.punctuation_pauses))[0])

    def boom(*_a, **_k):
        raise AssertionError("a span cached whole was rendered again")

    _wav, dur, cached, seg_stats = _render_chapter_cached(chapter, boom, _SR, "eng", _resolve,
                                                          str(tmp_path), opts=_PHRASES)
    assert cached is False and dur == pytest.approx(1.0)
    assert seg_stats == {"total": takes, "cached": takes}
    assert not (tmp_path / TAKE_SUBDIR).exists()


def test_every_repeat_of_a_sentence_is_a_take_of_its_own(tmp_path):
    line = "The same sentence is read here, word for word, once again."
    chapter = _parsed([line, "Something else is said in between the two.", line])
    seen = []

    def synth(text, voice_id, speed=None, occurrence=None, retake=0):
        seen.append((text, occurrence, retake))
        return torch.full((1, 2400), 0.1)

    _render_chapter_cached(chapter, synth, _SR, "eng", _resolve, str(tmp_path), opts=_PHRASES)
    assert [(o, r) for t, o, r in seen if t == line] == [(0, 0), (1, 0)]
    # Each repeat is cached in its own slot, so a re-assembly renders neither.
    seen.clear()
    _render_chapter_cached(chapter, synth, _SR, "eng", _resolve, str(tmp_path),
                           opts=ExpressiveOptions(punctuation_pauses=(("sentence", 900),)))
    assert seen == []


def _takes_of(cache_dir, chapter, opts=_PHRASES):
    """Every take of ``chapter``, in reading order, as a render plans them
    (its retakes placed), and the chapter's title as a retake keeps it."""
    keys = _chapter_cache_keys(chapter, _SR, "eng", _resolve, str(cache_dir), opts=opts)
    store = TakeCache(str(cache_dir), sample_rate=_SR, engine_id="eng",
                      voice_sig=keys.voice_sigs, take_sig=keys.take_sig)
    plan = keys.takes if keys.takes is not None else store.plan(keys.spans, chapter_units(
        keys.spans, punctuation_pauses=dict(opts.punctuation_pauses)), title=keys.title)
    return [ref for refs in plan for ref in refs], keys.title


def _ask_again(cache_dir, chapter, at, opts=_PHRASES) -> int:
    """Retake take ``at`` (in reading order) of ``chapter``, where the chapter
    reads it — what ``POST /audiobook/retake`` does."""
    takes, title = _takes_of(cache_dir, chapter, opts)
    return bump_retake(str(cache_dir), takes[at],
                       take_anchor([ref.text for ref in takes], at, title))


def _salted(text, retake):
    """A stub take: distinct per text, longer when it is a retake."""
    return torch.full((1, 2400 + len(text) + (100 if retake else 0)), 0.1)


def test_a_retake_renders_that_take_alone(tmp_path):
    chapter = _parsed(_paragraphs()[:3])
    seen = []

    def synth(text, voice_id, speed=None, occurrence=None, retake=""):
        seen.append((text, retake))
        return _salted(text, retake)

    def render():
        return _render_chapter_cached(chapter, synth, _SR, "eng", _resolve, str(tmp_path),
                                      opts=_PHRASES)

    first, _dur, _cached, _stats = render()
    keys = _chapter_cache_keys(chapter, _SR, "eng", _resolve, str(tmp_path), opts=_PHRASES)
    ref = _takes_of(tmp_path, chapter)[0][5]
    # A span cached whole holds the old take: it must not be served either.
    SegmentCache(str(tmp_path), sample_rate=_SR, engine_id="eng", voice_sig=keys.voice_sigs,
                 extra_sig=keys.seg_extra_sig).store(keys.spans[0], torch.full((1, 4800), 0.1))
    assert _ask_again(tmp_path, chapter, 5) == 1
    seen.clear()
    again, _dur, cached, stats = render()
    assert again != first and cached is False  # the retake moved the chapter's key
    [(text, salt)] = seen
    assert text == ref.text and salt  # that take alone, seeded anew
    assert stats["total"] - stats["cached"] == 1
    seen.clear()
    assert render()[2] is True and seen == []
    # Asked again, it is another take again.
    assert _ask_again(tmp_path, chapter, 5) == 2
    render()
    assert [text for text, _salt in seen] == [ref.text] and seen[0][1] != salt


# ── interrupted chapter resumes from finished segments ──────────────────────

def test_interrupted_chapter_resumes_from_cached_segments(tmp_path):
    calls: list[str] = []

    def failing(text, voice_id, speed=None):
        calls.append(text)
        if "THIRD" in text:
            raise RuntimeError("interrupted mid-chapter")
        return torch.full((2400,), 0.1)

    ch = _chapter("First sentence.", "Second sentence.", "THIRD sentence fails.")
    with pytest.raises(RuntimeError):
        _render_chapter_cached(ch, failing, _SR, "eng", _resolve, str(tmp_path))
    # The two spans that finished were persisted before the crash.
    assert len(list((tmp_path / SEGMENT_SUBDIR).glob("*.wav"))) == 2

    calls.clear()
    wav_path, _dur, cached, seg_stats = _render_chapter_cached(
        ch, _counting_synth(calls), _SR, "eng", _resolve, str(tmp_path))
    assert cached is False
    assert calls == ["THIRD sentence fails."]  # only the lost span re-renders
    assert seg_stats == {"total": 3, "cached": 2}
    assert os.path.isfile(wav_path)


def test_resume_with_missing_segment_file(tmp_path):
    calls: list[str] = []
    ch = _chapter("First sentence.", "Second sentence.", "Third sentence.")
    wav_path, *_ = _render_chapter_cached(ch, _counting_synth(calls), _SR, "eng",
                                          _resolve, str(tmp_path))
    # Evicted/deleted mid-way: chapter WAV and one segment gone.
    os.remove(wav_path)
    os.remove(_seg_path(tmp_path, "Second sentence."))

    calls.clear()
    _wav, _dur, cached, seg_stats = _render_chapter_cached(
        ch, _counting_synth(calls), _SR, "eng", _resolve, str(tmp_path))
    assert cached is False
    assert calls == ["Second sentence."]
    assert seg_stats == {"total": 3, "cached": 2}


# ── corrupt / foreign segment files degrade to a clean miss ─────────────────

def test_corrupt_segment_file_is_clean_miss(tmp_path):
    calls: list[str] = []
    ch = _chapter("First sentence.", "Second sentence.")
    wav_path, *_ = _render_chapter_cached(ch, _counting_synth(calls), _SR, "eng",
                                          _resolve, str(tmp_path))
    os.remove(wav_path)
    _seg_path(tmp_path, "First sentence.").write_bytes(b"not a wav at all")

    calls.clear()
    _wav, _dur, _cached, seg_stats = _render_chapter_cached(
        ch, _counting_synth(calls), _SR, "eng", _resolve, str(tmp_path))
    assert calls == ["First sentence."]  # corrupt entry re-rendered, no crash
    assert seg_stats == {"total": 2, "cached": 1}


def test_wrong_sample_rate_segment_is_clean_miss(tmp_path):
    calls: list[str] = []
    ch = _chapter("First sentence.")
    wav_path, *_ = _render_chapter_cached(ch, _counting_synth(calls), _SR, "eng",
                                          _resolve, str(tmp_path))
    os.remove(wav_path)
    # Overwrite the cached segment with a valid WAV at a foreign rate.
    p = _seg_path(tmp_path, "First sentence.")
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x00\x00" * 800)

    calls.clear()
    _wav, _dur, _cached, seg_stats = _render_chapter_cached(
        ch, _counting_synth(calls), _SR, "eng", _resolve, str(tmp_path))
    assert calls == ["First sentence."]
    assert seg_stats == {"total": 1, "cached": 0}


# ── unchanged chapter short-circuits at the chapter layer ───────────────────

def test_unchanged_chapter_never_touches_segment_files(tmp_path):
    calls: list[str] = []
    ch = _chapter("First sentence.", "Second sentence.")
    _render_chapter_cached(ch, _counting_synth(calls), _SR, "eng", _resolve, str(tmp_path))

    # Remove the whole segment layer (WAVs and their timing sidecars): a
    # chapter-level hit must not need it.
    for p in (tmp_path / SEGMENT_SUBDIR).glob("*"):
        os.remove(p)
    (tmp_path / SEGMENT_SUBDIR).rmdir()

    def boom(*_a, **_k):
        raise AssertionError("synth must not be called on a chapter cache hit")

    _wav, dur, cached, seg_stats = _render_chapter_cached(
        ch, boom, _SR, "eng", _resolve, str(tmp_path))
    assert cached is True and dur > 0
    assert seg_stats is None
    assert not (tmp_path / SEGMENT_SUBDIR).exists()  # layer never recreated


# ── LRU byte cap covers both layers ─────────────────────────────────────────

def _seed(path, size, age_s):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\0" * size)
    t = time.time() - age_s
    os.utime(path, (t, t))
    return path


def test_prune_walks_segment_subdir(tmp_path):
    chap = _seed(tmp_path / "chapter.wav", 600, age_s=5)
    old_seg = _seed(tmp_path / SEGMENT_SUBDIR / "old.wav", 600, age_s=100)
    new_seg = _seed(tmp_path / SEGMENT_SUBDIR / "new.wav", 600, age_s=1)

    remaining, removed = prune_cache_dir(str(tmp_path), max_bytes=1300)
    assert removed == 1
    assert not old_seg.exists()               # oldest evicted — inside segments/
    assert chap.exists() and new_seg.exists()
    assert remaining == 1200                  # both layers counted in the budget


def test_prune_evicts_stale_chapter_before_fresh_segment(tmp_path):
    old_chap = _seed(tmp_path / "stale_chapter.wav", 600, age_s=100)
    seg = _seed(tmp_path / SEGMENT_SUBDIR / "fresh.wav", 600, age_s=1)
    remaining, removed = prune_cache_dir(str(tmp_path), max_bytes=700)
    assert removed == 1
    assert not old_chap.exists() and seg.exists()
    assert remaining == 600


def test_segment_hit_refreshes_mtime_for_lru(tmp_path):
    calls: list[str] = []
    ch = _chapter("First sentence.")
    wav_path, *_ = _render_chapter_cached(ch, _counting_synth(calls), _SR, "eng",
                                          _resolve, str(tmp_path))
    os.remove(wav_path)  # force the segment layer on the next run
    seg = _seg_path(tmp_path, "First sentence.")
    stale = time.time() - 10_000
    os.utime(seg, (stale, stale))

    _render_chapter_cached(ch, _counting_synth(calls), _SR, "eng", _resolve, str(tmp_path))
    assert os.path.getmtime(seg) > stale + 1_000  # hit bumped it — LRU-fresh


def test_take_hits_count_as_used_and_a_corrupt_take_is_a_clean_miss(tmp_path):
    chapter = _parsed(_paragraphs()[:1])
    calls: list[str] = []
    wav_path, *_ = _render_phrases(tmp_path, chapter, calls)
    takes = sorted((tmp_path / TAKE_SUBDIR).glob("*.wav"))
    assert len(takes) == len(calls) >= 3
    os.remove(wav_path)  # the next render assembles the chapter from its takes
    stale = time.time() - 10_000
    takes[0].write_bytes(b"not a wav at all")
    for take in takes:
        os.utime(take, (stale, stale))
    calls.clear()
    _render_phrases(tmp_path, chapter, calls)
    assert len(calls) == 1  # the corrupt take rendered again, no crash
    assert all(os.path.getmtime(take) > stale + 1_000 for take in takes)  # LRU-fresh


def test_prune_walks_the_takes_and_never_a_running_renders_files(tmp_path):
    held = _seed(tmp_path / "chapter.wav", 600, age_s=500)  # oldest, still needed
    old_take = _seed(tmp_path / TAKE_SUBDIR / "old.wav", 600, age_s=100)
    new_take = _seed(tmp_path / TAKE_SUBDIR / "new.wav", 600, age_s=1)
    counters = tmp_path / TAKE_SUBDIR / "retakes.json"
    counters.write_text("{}")
    with CacheHold() as hold:
        hold.add(str(held))
        remaining, removed = prune_cache_dir(str(tmp_path), max_bytes=1300)
        assert removed == 1 and remaining == 1202  # held files still count
        assert held.exists() and not old_take.exists() and new_take.exists()
    assert counters.exists()  # bookkeeping is never evicted
    # Released: the next pruning may take it like any other file.
    prune_cache_dir(str(tmp_path), max_bytes=700)
    assert not held.exists() and new_take.exists()


def test_a_running_render_keeps_its_finished_chapters_until_the_mux(tmp_path, monkeypatch):
    """Another render prunes before it writes — and could evict the chapters
    this one finished and has yet to join into the book."""
    import soundfile as sf

    from api.routers import audiobook
    from core import config, db
    from services import ffmpeg_utils, gpu_gateway

    monkeypatch.setattr(config, "OUTPUTS_DIR", str(tmp_path))
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "jobs.db"))
    db.init_db()
    monkeypatch.setattr(ffmpeg_utils, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(audiobook, "_resolve_default_language", lambda *_a: None)
    monkeypatch.setattr(gpu_gateway, "decide", lambda *_a: object())

    async def chapter(ch, *, cache_dir, **_kw):
        if ch.title == "B":
            prune_cache_dir(cache_dir, max_bytes=0)  # another render, meanwhile
        wav = os.path.join(cache_dir, f"{ch.title}.wav")
        sf.write(wav, torch.zeros(1000).numpy(), _SR)
        return wav, 1000 / _SR, False, None

    joined = []

    async def mux(command, **_kw):
        with open(command[command.index("-i") + 1], encoding="utf-8") as f:
            listed = [line.split("'")[1] for line in f if line.strip()]
        joined.append([os.path.exists(path) for path in listed])
        with open(command[-1], "wb") as f:
            f.write(b"book")

    monkeypatch.setattr(audiobook, "_run_chapter", chapter)
    monkeypatch.setattr(ffmpeg_utils, "run_ffmpeg", mux)

    async def run():
        return [e async for e in audiobook._render_longform_sse(
            parse_audiobook_script("# A\nOne.\n# B\nTwo."), default_voice=None, job_id="hold1")]

    events = [json.loads(e[len("data: "):]) for e in asyncio.run(run())]
    assert events[-1]["type"] == "done" and joined == [[True, True]]
    # Once the render ends, its chapters are ordinary cache entries again.
    prune_cache_dir(str(tmp_path / "longform_cache"), max_bytes=0)
    assert not (tmp_path / "longform_cache" / "A.wav").exists()


def test_a_cached_chapter_never_touches_its_takes(tmp_path):
    chapter = _parsed(_paragraphs()[:1])
    _render_phrases(tmp_path, chapter, [])
    shutil.rmtree(tmp_path / TAKE_SUBDIR)

    def boom(*_a, **_k):
        raise AssertionError("synth must not be called on a chapter cache hit")

    _wav, _dur, cached, seg_stats = _render_chapter_cached(chapter, boom, _SR, "eng", _resolve,
                                                           str(tmp_path), opts=_PHRASES)
    assert cached is True and seg_stats is None
    assert not (tmp_path / TAKE_SUBDIR).exists()


# ── "retake this sentence": the takes API ───────────────────────────────────

@pytest.fixture
def app_render(tmp_path, monkeypatch):
    """The router rendering through a stub engine ``eng`` at 24 kHz, outputs
    under ``tmp_path``, unmarked, every job here; ``seen`` lists ``(text,
    retake salt)`` per synthesized take."""
    import importlib
    import types

    monkeypatch.setattr(importlib.import_module("core.config"), "OUTPUTS_DIR", str(tmp_path))
    watermark = importlib.import_module("services.watermark")
    monkeypatch.setattr(watermark, "will_mark", lambda: False)
    monkeypatch.setattr(watermark, "mark_synthetic", lambda audio, *_a, **_k: audio)
    router = importlib.import_module("api.routers.audiobook")
    monkeypatch.setattr(importlib.import_module("services.tts_backend"), "active_backend_id",
                        lambda: "eng")
    monkeypatch.setattr(router, "_local_sample_rate", lambda _engine_id: _SR)
    monkeypatch.setattr(importlib.import_module("services.gpu_gateway"), "decide",
                        lambda *_a, **_k: types.SimpleNamespace(remote=False))
    seen: list = []

    def synth(text, voice_id, speed=None, attempt=0, occurrence=None, retake=""):
        seen.append((text, retake))
        return _salted(text, retake)

    def build_synth(default_voice=None, language=None, opts=None, voice_map=None, lease=None):
        return {"mode": "generic", "engine_id": "eng", "sample_rate": _SR,
                "resolve": router._voice_resolver(default_voice, voice_map, lease),
                "synth": synth}

    monkeypatch.setattr(router, "_build_synth", build_synth)
    return router, seen


def test_the_app_lists_a_chapters_takes_and_asks_for_one_again(app_render):
    from fastapi import HTTPException

    router, seen = app_render
    body = {"text": "# One\n\n" + "\n\n".join(_paragraphs()[:2]),
            "punctuation_pauses": dict(DEFAULT_PUNCTUATION_PAUSES)}

    def takes():
        return asyncio.run(router.audiobook_takes(router.AudiobookPreviewRequest(**body)))

    def preview():
        return asyncio.run(router.audiobook_preview(router.AudiobookPreviewRequest(**body)))

    def retake(**where):
        return asyncio.run(router.audiobook_retake(router.AudiobookRetakeRequest(**body, **where)))

    listed = takes()
    assert listed["phrases"] is True and listed["title"] == "One"
    rows = listed["takes"]
    assert [(t["span"], t["take"]) for t in rows] == [(0, k) for k in range(len(rows))]
    assert rows[1]["text"].startswith("He carried a brass lantern")
    assert [t["retake"] for t in rows] == [0] * len(rows) and not any(t["cached"] for t in rows)
    first = preview()
    assert len(seen) == len(rows) and all(t["cached"] for t in takes()["takes"])

    with pytest.raises(HTTPException) as moved:
        retake(span=0, take=1, phrase="A sentence that is somewhere else now.")
    assert moved.value.status_code == 409
    with pytest.raises(HTTPException) as missing:
        retake(span=0, take=len(rows))
    assert missing.value.status_code == 404
    got = retake(span=0, take=1, phrase=rows[1]["text"])
    assert (got["span"], got["take"], got["text"], got["retake"]) == (0, 1, rows[1]["text"], 1)

    seen.clear()
    again = preview()
    assert again["output"] != first["output"] and again["cached"] is False
    [(text, salt)] = seen  # that take alone, as a retake
    assert text == rows[1]["text"] and salt
    after = takes()["takes"]
    assert after[1]["retake"] == 1 and all(t["cached"] for t in after)
    assert retake(span=0, take=1)["retake"] == 2


def test_retakes_need_sentence_by_sentence_reading(app_render):
    from fastapi import HTTPException

    router, _seen = app_render
    body = {"text": "# One\n\n" + _PARAGRAPH}
    assert asyncio.run(router.audiobook_takes(router.AudiobookPreviewRequest(**body))) == {
        "title": "One", "phrases": False, "takes": []}
    with pytest.raises(HTTPException) as refused:
        asyncio.run(router.audiobook_retake(router.AudiobookRetakeRequest(**body, span=0, take=0)))
    assert refused.value.status_code == 400


def _whole_span(router, body, *, timed: bool):
    """Cache the one span of ``body``'s chapter whole, as a build before takes
    were kept rendered it: a WAV with — when ``timed`` — its take ranges kept
    beside it. Returns the takes it holds, as the take list reads them."""
    import importlib

    req = router.AudiobookPreviewRequest(**body)
    chapter = router._script_chapter(req)
    request_opts = router._chapter_opts(router._expressive_opts(req), chapter, None, None)
    cache_dir = os.path.join(importlib.import_module("core.config").OUTPUTS_DIR,
                             "longform_cache")
    keys = _chapter_cache_keys(chapter, _SR, "eng", router._voice_resolver(None, None),
                               cache_dir, opts=router._preset_opts(request_opts, "eng"),
                               request_opts=request_opts,
                               language=router._resolve_default_language(None, None))
    takes = sum(len(texts) for texts, _gaps in chapter_units(
        keys.spans, punctuation_pauses=dict(DEFAULT_PUNCTUATION_PAUSES))[0])
    old = SegmentCache(cache_dir, sample_rate=_SR, engine_id="eng", voice_sig=keys.voice_sigs,
                       extra_sig=keys.seg_extra_sig)
    old.store(keys.spans[0], torch.full((1, 2400 * takes), 0.1))
    if timed:
        old.store_timing(keys.spans[0], [[k, 2400 * k, 2400 * (k + 1)] for k in range(takes)],
                         samples=2400 * takes)
    return takes


@pytest.mark.parametrize("timed", [True, False], ids=["take ranges kept", "no take ranges"])
def test_a_span_cached_whole_is_cut_into_its_takes_when_one_is_retaken(app_render, timed):
    """The takes list (and the Contents rail's count, read the same way)
    agrees with the render about a span an earlier build cached whole: every
    take of it is reused, and once one of them is asked for again the others
    are cut from it by the take ranges kept with it — only the retaken take
    renders. Without those ranges (none was written) the span renders anew."""
    router, seen = app_render
    body = {"text": "# One\n\n" + "\n\n".join(_paragraphs()[:2]),
            "punctuation_pauses": dict(DEFAULT_PUNCTUATION_PAUSES)}
    takes_held = _whole_span(router, body, timed=timed)
    req = router.AudiobookPreviewRequest(**body)

    def takes():
        return asyncio.run(router.audiobook_takes(req))["takes"]

    def preview():
        return asyncio.run(router.audiobook_preview(req))

    rows = takes()
    assert len(rows) == takes_held > 2 and all(t["cached"] for t in rows)
    preview()
    assert seen == []  # as listed: the span served whole
    asyncio.run(router.audiobook_retake(router.AudiobookRetakeRequest(
        **body, span=0, take=1, phrase=rows[1]["text"])))
    listed = [t["cached"] for t in takes()]
    assert listed == ([k != 1 for k in range(len(rows))] if timed else [False] * len(rows))
    preview()
    rendered = [text for text, _salt in seen]
    assert rendered == ([rows[1]["text"]] if timed else [t["text"] for t in rows])
    assert [bool(salt) for _text, salt in seen] == [
        True if timed else k == 1 for k in range(len(seen))]
    # From then on the span is read take by take, every take kept.
    assert all(t["cached"] for t in takes())


def test_a_passage_preview_cuts_its_takes_from_a_chapter_cached_whole(app_render):
    """Right after a retake the app plays the paragraph holding it: in a
    chapter an earlier build cached whole, the paragraph's other sentences are
    cut from that chapter's audio — what the book holds — and only the
    retaken sentence renders (they used to render anew, and with an unpinned
    voice read differently from then on)."""
    router, seen = app_render
    paragraphs = _paragraphs()[:2]
    chapter = "# One\n\n" + "\n\n".join(paragraphs)
    pauses = {"punctuation_pauses": dict(DEFAULT_PUNCTUATION_PAUSES)}
    body = {"text": chapter, **pauses}
    _whole_span(router, body, timed=True)
    rows = asyncio.run(router.audiobook_takes(router.AudiobookPreviewRequest(**body)))["takes"]
    second = next(k for k, t in enumerate(rows) if t["text"].startswith("The old lighthouse keeper 1"))
    retaken = rows[second + 1]  # a sentence the chapter said in its first paragraph too
    asyncio.run(router.audiobook_retake(router.AudiobookRetakeRequest(
        **body, span=0, take=second + 1, phrase=retaken["text"])))
    at = chapter.index(paragraphs[1])
    asyncio.run(router.audiobook_preview(router.AudiobookPreviewRequest(
        text=paragraphs[1], context={"chapter": chapter, "start": at,
                                     "end": at + len(paragraphs[1])}, **pauses)))
    [(text, salt)] = seen
    assert text == retaken["text"] and salt
    # The chapter's next render cuts the rest and renders nothing more.
    seen.clear()
    asyncio.run(router.audiobook_preview(router.AudiobookPreviewRequest(**body)))
    assert seen == []


def test_stories_list_and_retake_the_takes_of_a_posted_chapter(app_render, monkeypatch):
    """``/longform/takes`` and ``/longform/retake`` read a Stories chapter as
    ``/longform/render`` does: its pause-only span has no takes, each voice
    keys its own, and a retake renders that one take alone."""
    from fastapi import HTTPException

    router, seen = app_render
    # Two profiles that resolve to voices of their own (no database here).
    monkeypatch.setattr(router, "_map_span_voice", lambda voice_id, default, _map: voice_id
                        or default)
    monkeypatch.setattr(router, "_resolve_voice", lambda key: {
        "ref_audio": None, "ref_text": None, "instruct": key and f"voice {key}", "seed": None})
    first, second = _paragraphs()[:2]
    chapter = {"title": "", "spans": [
        {"voice_id": "p-hao", "text": first},
        {"voice_id": None, "text": "", "pause_ms_after": 400},
        {"voice_id": "p-mai", "text": second, "speed": 1.1}]}
    body = {"chapter": chapter, "punctuation_pauses": dict(DEFAULT_PUNCTUATION_PAUSES)}

    def takes():
        return asyncio.run(router.longform_takes(router.LongformTakesRequest(**body)))

    def retake(**where):
        return asyncio.run(router.longform_retake(router.LongformRetakeRequest(**body, **where)))

    def render():
        """One chapter as /longform/render renders it."""
        import importlib
        import types

        plan = router.LongformRenderRequest(chapters=[chapter], **{
            k: v for k, v in body.items() if k != "chapter"})
        return asyncio.run(router._run_chapter(
            router._story_chapter(plan.chapters[0]), operation="longform",
            decision=types.SimpleNamespace(remote=False), job=None, default_voice=None,
            language=router._resolve_default_language(None, None),
            opts=router._expressive_opts(plan), voice_map=None, lexicon=None,
            cache_dir=os.path.join(importlib.import_module("core.config").OUTPUTS_DIR,
                                   "longform_cache")))

    listed = takes()
    assert listed["phrases"] is True and listed.get("untitled") is True
    rows = listed["takes"]
    assert {t["span"] for t in rows} == {0, 2}  # the pause between the lines says nothing
    assert rows[0]["text"].startswith("The old lighthouse keeper 0")
    render()
    assert len(seen) == len(rows) and all(t["cached"] for t in takes()["takes"])

    last = next(t for t in rows if t["span"] == 2 and t["take"] == 1)
    with pytest.raises(HTTPException) as moved:
        retake(span=2, take=1, phrase="Not what that line says.")
    assert moved.value.status_code == 409
    assert retake(span=2, take=1, phrase=last["text"])["retake"] == 1
    seen.clear()
    render()
    [(text, salt)] = seen  # that take alone, as a retake
    assert text == last["text"] and salt
    with pytest.raises(HTTPException) as empty:
        asyncio.run(router.longform_takes(router.LongformTakesRequest(
            chapter={"spans": [{"text": "  "}]})))
    assert empty.value.status_code == 400
    assert asyncio.run(router.longform_takes(router.LongformTakesRequest(
        chapter=chapter)))["phrases"] is False  # read in paragraphs: no takes kept


# ── a retake stays with the sentence it was asked for ──────────────────────

_DUSK = "The sun had already set at dusk."
_STAIRS = "We walked up the long stairs."


def _yes_chapter(title, before, after):
    """A chapter whose middle paragraph is the one-line sentence "Yes."."""
    return f"# {title}\n\n{before}\n\nYes.\n\n{after}"


def test_a_retake_stays_in_its_chapter_and_its_book(app_render):
    """The same line read in another chapter or another book — same voice,
    same settings, so until now the same take — keeps its take and its
    chapter's key: only the "Yes." asked for is read anew."""
    router, seen = app_render
    pauses = {"punctuation_pauses": dict(DEFAULT_PUNCTUATION_PAUSES)}
    book = (_yes_chapter("One", _DUSK, _STAIRS) + "\n\n"
            + _yes_chapter("Two", "Did the keeper ever leave the island?",
                           "He never did, not once in forty years."))
    other_book = _yes_chapter("Elsewhere", "Was the lamp still burning at midnight?",
                              "It burned until the morning came.")

    def request(kind, text, index=0, **extra):
        return getattr(router, kind)(text=text, chapter_index=index, **pauses, **extra)

    def takes(text, index=0):
        return asyncio.run(router.audiobook_takes(
            request("AudiobookPreviewRequest", text, index)))["takes"]

    def preview(text, index=0):
        return asyncio.run(router.audiobook_preview(
            request("AudiobookPreviewRequest", text, index)))

    for text, index in ((book, 0), (book, 1), (other_book, 0)):
        preview(text, index)
    assert [text for text, _salt in seen].count("Yes.") == 1  # one take, until now
    yes = next(t for t in takes(book) if t["text"] == "Yes.")
    asyncio.run(router.audiobook_retake(request(
        "AudiobookRetakeRequest", book, span=yes["span"], take=yes["take"], phrase="Yes.")))
    seen.clear()
    assert preview(book, 1)["cached"] is True and preview(other_book)["cached"] is True
    assert seen == []
    assert not any(t["retake"] for t in takes(book, 1) + takes(other_book))
    assert preview(book)["cached"] is False
    [(text, salt)] = seen
    assert text == "Yes." and salt


def test_a_passage_preview_reads_its_chapters_takes(app_render):
    """A passage preview sends where it is read: a sentence the chapter said
    before it is the repeat it is there — its own take, never the earlier
    one's — and the retake asked for it is what plays at once."""
    router, seen = app_render
    pauses = {"punctuation_pauses": dict(DEFAULT_PUNCTUATION_PAUSES)}
    chapter = f"# One\n\n{_DUSK}\n\nYes.\n\n{_STAIRS}\n\nYes."
    at = chapter.rindex("Yes.")
    passage = {"text": "Yes.", "context": {"chapter": chapter, "start": at, "end": at + 4},
               **pauses}

    def preview(**body):
        return asyncio.run(router.audiobook_preview(router.AudiobookPreviewRequest(**body)))

    def takes():
        return asyncio.run(router.audiobook_takes(
            router.AudiobookPreviewRequest(text=chapter, **pauses)))["takes"]

    # On its own the last paragraph reads the chapter's second "Yes.": the
    # chapter then renders its first one, in reading order.
    preview(**passage)
    assert seen == [("Yes.", "")]
    seen.clear()
    preview(text=chapter, **pauses)
    assert [text for text, _salt in seen] == [_DUSK, "Yes.", _STAIRS]

    last = takes()[-1]
    asyncio.run(router.audiobook_retake(router.AudiobookRetakeRequest(
        text=chapter, **pauses, span=last["span"], take=last["take"], phrase="Yes.")))
    seen.clear()
    preview(**passage)  # what the app plays at once, where the retake is read
    [(text, salt)] = seen
    assert text == "Yes." and salt
    assert all(t["cached"] for t in takes())  # the rail counts it as rendered
    seen.clear()
    assert preview(text=chapter, **pauses)["cached"] is False and seen == []


def test_a_retake_stays_with_its_sentence_when_a_copy_before_it_comes_or_goes(tmp_path):
    lines = ["She asked again.", "Yes.", "The rain kept falling on the roof all night long.",
             "Yes."]
    seen = []

    def synth(text, voice_id, speed=None, occurrence=None, retake=""):
        seen.append((text, retake))
        return _salted(text, retake)

    def render(texts):
        _render_chapter_cached(_parsed(texts), synth, _SR, "eng", _resolve, str(tmp_path),
                               opts=_PHRASES)

    render(lines)
    assert _ask_again(tmp_path, _parsed(lines), 3) == 1
    seen.clear()
    render(lines)
    [(text, salt)] = seen
    assert text == "Yes." and salt

    def salts(texts):
        return [ref.salt for ref in _takes_of(tmp_path, _parsed(texts))[0]]

    # The copy before it deleted, or another added before it: the retaken
    # line keeps its retake, nothing renders, and no other line takes it.
    for texts in ([lines[0], *lines[2:]], ["Yes.", *lines], [*lines[:2], "Yes.", *lines[2:]]):
        assert salts(texts) == [""] * (len(texts) - 1) + [salt]
        seen.clear()
        render(texts)
        assert seen == []


def test_retakes_are_saved_durably_and_survive_a_torn_file(tmp_path, monkeypatch):
    """A power-off can leave the retakes file torn (zero-filled on NTFS):
    every save flushes it to the disk, and the retakes as they were before
    the last one are kept to read instead."""
    from core import durable_io

    chapter = _parsed(_paragraphs()[:2])
    _render_phrases(tmp_path, chapter, [])
    flushed = []
    monkeypatch.setattr(durable_io, "flush_fd", lambda fd: flushed.append("file"))
    monkeypatch.setattr(durable_io, "flush_dir", lambda path: flushed.append("folder"))
    _ask_again(tmp_path, chapter, 1)
    assert flushed == ["file", "folder"]  # the file before its rename, the folder after
    _ask_again(tmp_path, chapter, 2)
    counters = tmp_path / TAKE_SUBDIR / "retakes.json"
    counters.write_bytes(b"\0" * counters.stat().st_size)
    # The last retake was in the torn file; the one before it is kept.
    assert [ref.retake for ref in _takes_of(tmp_path, chapter)[0][:3]] == [0, 1, 0]
    # The next retake saves both again.
    _ask_again(tmp_path, chapter, 2)
    assert [ref.retake for ref in _takes_of(tmp_path, chapter)[0][:3]] == [0, 1, 1]


def test_another_renders_pruning_never_drops_the_takes_a_chapter_is_about_to_read(
        tmp_path, monkeypatch):
    """A pause change re-joins every take of a chapter from the cache; another
    render pruning the cache meanwhile used to evict the takes it had yet to
    read — the oldest files there — and they rendered again (an unpinned
    voice then reads them differently)."""
    chapter = _parsed(_paragraphs()[:2])
    calls: list[str] = []
    _render_phrases(tmp_path, chapter, calls)
    stale = time.time() - 10_000
    for take in (tmp_path / TAKE_SUBDIR).glob("*.wav"):
        os.utime(take, (stale, stale))
    load = TakeCache.load
    pruned = []

    def load_while_another_render_prunes(self, ref, attempt=0):
        if not pruned:
            pruned.append(prune_cache_dir(str(tmp_path), max_bytes=0))
        return load(self, ref, attempt)

    monkeypatch.setattr(TakeCache, "load", load_while_another_render_prunes)
    calls.clear()
    _render_phrases(tmp_path, chapter, calls,
                    opts=ExpressiveOptions(punctuation_pauses=(("sentence", 900),)))
    assert pruned and calls == []


_CORPUS_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "retake_take_cases.json")
with open(_CORPUS_PATH, encoding="utf-8") as _corpus:
    _CORPUS = json.load(_corpus)


@pytest.mark.parametrize("case", _CORPUS, ids=[c["name"] for c in _CORPUS])
def test_the_takes_list_is_what_the_editor_places(app_render, monkeypatch, case):
    """The editors find each listed take in their text by the characters the
    reader is shown (``take-retake.ts`` places this same corpus): a change to
    how takes are cut or shown fails here first, and the editor's side is
    checked again against the corpus it brings."""
    router, _seen = app_render
    monkeypatch.setattr(router, "_map_span_voice", lambda voice_id, default, _map: voice_id
                        or default)
    monkeypatch.setattr(router, "_resolve_voice", lambda key: {
        "ref_audio": None, "ref_text": None, "instruct": key, "seed": None})
    pauses = {"punctuation_pauses": dict(DEFAULT_PUNCTUATION_PAUSES)}
    if "script" in case:
        listed = asyncio.run(router.audiobook_takes(router.AudiobookPreviewRequest(
            text=case["script"], chapter_index=case["chapter_index"], lexicon=case["lexicon"],
            **pauses)))
    else:
        listed = asyncio.run(router.longform_takes(router.LongformTakesRequest(
            chapter=case["chapter"], **pauses)))
    assert [[t["span"], t["take"], t["text"]] for t in listed["takes"]] == case["takes"]


# ── the speech check: a score kept with each take ───────────────────────────

def _listening(monkeypatch, *, misheard=(), answers=True):
    """The check's recognizer hears each take say its own text — the takes
    holding a ``misheard`` word as something else — or, with ``answers``
    off, hears no words at all. ``state["heard"]`` lists what it was asked."""
    import importlib

    speech = importlib.import_module("services.speech_verify")
    state = {"answers": answers, "heard": []}

    class Listening(speech.SpeechVerifier):
        def __init__(self, sample_rate, **kw):
            super().__init__(sample_rate, transcribe=self._hear, **kw)

        def render(self, text, take):
            self._text = text
            return super().render(text, take)

        def _hear(self, _audio, _sample_rate):
            if not state["answers"]:
                return None
            text = getattr(self, "_text", "")
            state["heard"].append(text)
            return "nothing like the script at all" if any(m in text for m in misheard) else text

    monkeypatch.setattr(speech, "SpeechVerifier", Listening)
    return state


def test_each_takes_check_is_kept_and_a_rejoined_chapter_listens_to_none(tmp_path, monkeypatch):
    import dataclasses

    state = _listening(monkeypatch, misheard={"thermos"})
    chapter = _parsed(_paragraphs()[:2])
    checked = dataclasses.replace(_PHRASES, verify_speech=True)
    calls: list[str] = []
    _wav, _dur, _cached, stats = _render_phrases(tmp_path, chapter, calls, opts=checked)
    thermos = [text for text in calls if "thermos" in text]
    assert len(thermos) == 6  # two takes, each tried three times
    found = stats["speech_check"]
    assert (found["checked"], found["retaken"], found["unchecked"]) == (8, 4, 0)
    assert [s["text"] for s in found["suspect"]] == [thermos[0], thermos[0]]

    # Re-joined (trimming on): nothing is rendered or heard again, and the
    # same takes are still the ones to listen to.
    state["heard"].clear()
    calls.clear()
    _wav, _dur, cached, again = _render_phrases(
        tmp_path, chapter, calls, opts=dataclasses.replace(checked, trim_edges=True))
    assert cached is False and calls == [] and state["heard"] == []
    assert again["speech_check"]["suspect"] == found["suspect"]
    assert again["speech_check"]["checked"] == 8


def test_takes_the_check_could_not_hear_are_heard_later_without_rendering(tmp_path, monkeypatch):
    import dataclasses

    state = _listening(monkeypatch, answers=False)
    chapter = _parsed(_paragraphs()[:1])
    checked = dataclasses.replace(_PHRASES, verify_speech=True)
    calls: list[str] = []
    _wav, _dur, _cached, stats = _render_phrases(tmp_path, chapter, calls, opts=checked)
    takes = len(calls)
    assert (stats["speech_check"]["checked"], stats["speech_check"]["unchecked"]) == (0, takes)
    # A recognizer answers now: the takes are listened to, none rendered again
    # (a span cached whole would have been rendered again to be checked).
    state["answers"] = True
    calls.clear()
    _wav, _dur, cached, stats = _render_phrases(tmp_path, chapter, calls, opts=checked)
    assert cached is False and calls == []
    assert (stats["speech_check"]["checked"], stats["speech_check"]["unchecked"]) == (takes, 0)
    assert stats["cached"] == takes


def test_turning_the_check_on_listens_to_takes_rendered_without_it(tmp_path, monkeypatch):
    import dataclasses

    state = _listening(monkeypatch)
    chapter = _parsed(_paragraphs()[:1])
    calls: list[str] = []
    _render_phrases(tmp_path, chapter, calls)
    takes = len(calls)
    calls.clear()
    _wav, _dur, cached, stats = _render_phrases(
        tmp_path, chapter, calls, opts=dataclasses.replace(_PHRASES, verify_speech=True))
    assert cached is False and calls == [] and len(state["heard"]) == takes
    assert stats["speech_check"]["checked"] == takes


def test_the_checks_retake_never_replaces_the_take_read_without_the_check(tmp_path, monkeypatch):
    """The check keeps the retake it chose for a misheard take in a slot of
    its own: a chapter re-joined with the check off then reads every take as
    it was first rendered — as a fresh render without the check does — and
    with the check on, the retake it chose, without listening again."""
    import dataclasses
    import importlib

    import soundfile as sf

    speech = importlib.import_module("services.speech_verify")
    watermark = importlib.import_module("services.watermark")
    monkeypatch.setattr(watermark, "mark_synthetic", lambda audio, *_a, **_k: audio)
    heard: list = []

    class Listening(speech.SpeechVerifier):
        """Mishears the first rendering (level 0.1) of the "thermos" take."""

        def __init__(self, sample_rate, **kw):
            super().__init__(sample_rate, transcribe=self._hear, **kw)

        def render(self, text, take):
            self._text = text
            return super().render(text, take)

        def _hear(self, audio, _sample_rate):
            heard.append(self._text)
            first = float(audio.abs().max()) < 0.15
            return "nothing like it at all" if first and "thermos" in self._text else self._text

    monkeypatch.setattr(speech, "SpeechVerifier", Listening)

    def synth(text, voice_id, speed=None, attempt=0):
        return torch.full((1, 240 + 7 * len(text)), 0.1 * (attempt + 1))

    chapter = _parsed(_paragraphs()[:1])

    def render(cache, **options):
        wav, *_ = _render_chapter_cached(chapter, synth, _SR, "eng", _resolve, str(cache),
                                         opts=dataclasses.replace(_PHRASES, **options))
        return sf.read(wav, dtype="float32")[0]

    plain = render(tmp_path)
    checked = render(tmp_path, verify_speech=True)
    assert not (checked == plain).all()  # the check chose a retake of one take
    heard.clear()
    # Re-joined with the check on: its choice is kept, nothing heard again.
    rejoined = render(tmp_path, verify_speech=True, trim_edges=True)
    assert heard == [] and (rejoined == render(tmp_path / "fresh", verify_speech=True,
                                               trim_edges=True)).all()
    # And with it off: every take as first rendered, as a fresh render.
    without = render(tmp_path, trim_edges=True)
    assert (without == render(tmp_path / "fresh-off", trim_edges=True)).all()
