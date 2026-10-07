"""Audiobook sections, the outline's chapter status and the HTML export.

* ``## Title`` / ``### Title`` sections reach the plan, the rendered timeline
  (where each is heard) and the page.
* ``POST /audiobook/outline`` looks each chapter up under the key a real
  render uses (one derivation, ``_chapter_cache_keys``), and tells which
  chapters changed since the last book.
* ``POST /audiobook/export/html`` builds a ZIP in the temp folder: a
  self-contained ``index.html`` (escaped, timeline embedded, no network) and
  the book's audio. ``GET /audiobook/export/html/{id}`` downloads it once.

App modules are resolved at call time: other suites reload them.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import re
import tempfile
import types
import wave
import zipfile

import pytest
import torch

SR = 24000


def _mod(name: str):
    return importlib.import_module(name)


def _wav(path, frames=SR // 4):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"\x00\x00" * frames)


@pytest.fixture
def outputs(tmp_path, monkeypatch):
    config = _mod("core.config")
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(tmp_path))
    monkeypatch.setattr(config, "VOICES_DIR", str(tmp_path / "voices"))
    watermark = _mod("services.watermark")
    monkeypatch.setattr(watermark, "will_mark", lambda: False)
    monkeypatch.setattr(watermark, "mark_synthetic", lambda audio, *_a, **_k: audio)
    return tmp_path


# ── Sections in the plan and the timeline ───────────────────────────────────

def test_sections_reach_the_plan_and_survive_a_manifest_round_trip():
    ab = _mod("services.audiobook")
    plan = ab.parse_audiobook_script("# One\nIntro.\n## Part [voice:B] two\nBody.\n### Deep\nx")
    spans = plan.chapters[0].spans
    assert [(s.text, s.section, s.section_level) for s in spans] == [
        ("Intro.", None, None), ("Part", "Part [voice:B] two", 2), ("two", None, None),
        ("Body.", None, None), ("Deep", "Deep", 3), ("x", None, None)]
    # A section never resets the voice: B reads on after the heading.
    assert [s.voice_id for s in spans] == [None, None, "B", "B", "B", "B"]
    again = [ab.Span(**s.to_dict()) for s in spans]  # the resume manifest path
    assert again == spans
    assert "section" not in ab.Span(voice_id=None, text="plain").to_dict()


def test_timeline_places_each_section_where_its_heading_is_heard():
    ab = _mod("services.audiobook")
    chapter = ab.parse_audiobook_script("# One\nIntro.\n## Part two\nBody text.").chapters[0]
    timing = {"version": 1, "sample_rate": 1000, "samples": 6000, "phrases": True, "spans": [
        {"span": 0, "start": 0, "end": 1000, "units": [[0, 0, 1000]]},
        {"span": 1, "start": 1500, "end": 2500, "units": [[0, 1500, 2500]]},
        {"span": 2, "start": 3000, "end": 6000, "units": [[0, 3000, 6000]]},
    ]}
    doc = ab.book_timeline("audiobook_a.m4b", [(chapter, 6.0, timing, "k1")])
    ch = doc["chapters"][0]
    assert [p["text"] for p in ch["phrases"]] == ["Intro.", "Part two", "Body text."]
    assert ch["sections"] == [{"title": "Part two", "level": 2, "start": 1.5, "phrase": 1}]
    assert ch["key"] == "k1"


def test_untimed_chapter_is_split_by_section_and_character_share():
    ab = _mod("services.audiobook")
    chapter = ab.parse_audiobook_script("# One\nabcd\n## [slow]Ef[/slow]\nghij").chapters[0]
    ch = ab.book_timeline("audiobook_a.m4b", [(chapter, 10.0, None)])["chapters"][0]
    assert ch["precision"] == "chapter"
    assert [(p["text"], p["start"], p["end"]) for p in ch["phrases"]] == [
        ("abcd", 0.0, 4.0), ("Ef", 4.0, 6.0), ("ghij", 6.0, 10.0)]
    # The title as a listener reads it: tags stripped.
    assert ch["sections"] == [{"title": "Ef", "level": 2, "start": 4.0, "phrase": 1}]
    # Without sections: one entry per line or paragraph, the break kept.
    plain = ab.parse_audiobook_script("# One\nabcd\nefgh").chapters[0]
    assert ab.book_timeline("x", [(plain, 2.0, None)])["chapters"][0]["phrases"] == [
        {"text": "abcd", "start": 0.0, "end": 1.0, "voice": None},
        {"text": "efgh", "start": 1.0, "end": 2.0, "voice": None, "break": "line"}]
    flat = ab.parse_audiobook_script("# One\nabcd efgh").chapters[0]
    assert ab.book_timeline("x", [(flat, 2.0, None)])["chapters"][0]["phrases"] == [
        {"text": "abcd efgh", "start": 0.0, "end": 2.0, "voice": None}]


def test_section_spans_render_their_heading_as_its_own_paragraph():
    ab = _mod("services.audiobook")
    spans = ab.parse_audiobook_script("Before.\n## Title\nAfter.").chapters[0].spans
    said = []

    def synth(text, voice_id, speed=None):
        said.append(text)
        return torch.full((1, 100), 0.1)

    audio, _ = ab.synthesize_chapter(spans, synth, 1000, line_gap_ms=0, paragraph_gap_ms=50)
    assert said == ["Before.", "Title", "After."]  # no '#' reaches the engine
    assert audio.shape[-1] == 300 + 2 * 50  # a paragraph gap on both sides


# ── Outline status ───────────────────────────────────────────────────────────

_SCRIPT = "# One\nFirst chapter.\n## A part\nMore.\n# Two\nSecond chapter."


@pytest.fixture
def local_engine(outputs, monkeypatch):
    router = _mod("api.routers.audiobook")
    monkeypatch.setattr(_mod("services.tts_backend"), "active_backend_id", lambda: "eng")
    monkeypatch.setattr(router, "_local_sample_rate", lambda engine: SR if engine == "eng" else None)
    monkeypatch.setattr(_mod("services.gpu_gateway"), "decide",
                        lambda *_a, **_k: types.SimpleNamespace(remote=False))
    return router


def _render_like_the_book(router, req, index):
    """Render one chapter exactly as /audiobook/preview's local path does."""
    plan = router.parse_audiobook_script(req.text, default_voice=req.default_voice)
    chapter = plan.chapters[index]
    opts = router._chapter_opts(router._expressive_opts(req), chapter, req.default_voice,
                                req.voice_map)
    cache_dir = os.path.join(str(_mod("core.config").OUTPUTS_DIR), "longform_cache")
    os.makedirs(cache_dir, exist_ok=True)

    def synth(text, voice_id, speed=None):
        return torch.full((1, 2400), 0.1)

    path, *_ = router._render_chapter_cached(
        chapter, synth, SR, "eng", router._voice_resolver(req.default_voice, req.voice_map),
        cache_dir, req.lexicon, None, opts, req.voice_map, default_voice=req.default_voice)
    return path


def _outline(router, **kw):
    return asyncio.run(router.audiobook_outline(router.AudiobookOutlineRequest(**kw)))


def test_outline_reports_a_chapter_rendered_under_the_render_key(local_engine):
    router = local_engine
    kw = {"text": _SCRIPT, "line_gap_ms": 200, "lexicon": {"First": "Furst"}}
    assert [c["status"] for c in _outline(router, **kw)["chapters"]] == [
        "not_rendered", "not_rendered"]
    _render_like_the_book(router, router.AudiobookOutlineRequest(**kw), 0)
    got = _outline(router, **kw)
    assert got["book"] is False
    assert [(c["title"], c["status"], c["cached"], c["in_book"]) for c in got["chapters"]] == [
        ("One", "rendered", True, None), ("Two", "not_rendered", False, None)]
    # Any input the key folds in moves it: the text, a setting, the lexicon.
    edited = {**kw, "text": _SCRIPT.replace("More.", "More!")}
    for other in (edited, {**kw, "line_gap_ms": 300}, {**kw, "lexicon": None}):
        assert _outline(router, **other)["chapters"][0]["cached"] is False


def test_outline_tells_which_chapters_changed_since_the_last_book(local_engine, outputs):
    router = local_engine
    req = router.AudiobookOutlineRequest(text=_SCRIPT)
    first = _render_like_the_book(router, req, 0)
    second = _render_like_the_book(router, req, 1)
    book = {"version": 1, "output": "audiobook_b1.m4b", "duration": 1.0, "chapters": [
        {"title": "One", "key": router._cache_name(first)},
        {"title": "Two", "key": router._cache_name(second)}]}
    (outputs / "audiobook_b1.m4b.timeline.json").write_text(json.dumps(book), encoding="utf-8")
    got = _outline(router, text=_SCRIPT, output="audiobook_b1.m4b")
    assert got["book"] is True
    assert [(c["status"], c["in_book"]) for c in got["chapters"]] == [
        ("rendered", True), ("rendered", True)]
    edited = _SCRIPT.replace("Second chapter.", "Second chapter, revised.")
    assert [(c["status"], c["cached"], c["in_book"])
            for c in _outline(router, text=edited, output="audiobook_b1.m4b")["chapters"]] == [
        ("rendered", True, True), ("changed", False, False)]
    # Rendering the edited chapter alone fills the cache; the book still lags.
    _render_like_the_book(router, router.AudiobookOutlineRequest(text=edited), 1)
    assert _outline(router, text=edited, output="audiobook_b1.m4b")["chapters"][1] == {
        "title": "Two", "status": "changed", "cached": True, "in_book": False}
    # A name that is not a render's own output is never read.
    assert _outline(router, text=_SCRIPT, output="../audiobook_b1.m4b")["book"] is False


_SENTENCES = ("The lighthouse keeper climbed the stairs every evening at dusk. "
              "He carried a brass lantern that had belonged to his grandfather. "
              "The wind howled outside the windows for the whole long night.")


def test_outline_counts_the_takes_a_chapter_not_cached_whole_renders(local_engine, outputs):
    """Read sentence by sentence, a chapter not cached whole says how many of
    its takes a render would reuse: after a one-word edit all but one, after a
    pause change all of them (it only joins them again)."""
    router = local_engine
    pauses = dict(_mod("services.chunked_tts").DEFAULT_PUNCTUATION_PAUSES)
    epilogue = "Nobody in the village below ever asked him why he kept on climbing."
    kw = {"text": f"# One\n{_SENTENCES}\n# Two\n{_SENTENCES}\n{epilogue}",
          "punctuation_pauses": pauses}
    assert [c["takes"] for c in _outline(router, **kw)["chapters"]] == [
        {"total": 3, "cached": 0}, {"total": 4, "cached": 0}]
    _render_like_the_book(router, router.AudiobookOutlineRequest(**kw), 0)
    one, two = _outline(router, **kw)["chapters"]
    # Cached whole: nothing to count. Chapter two opens with chapter one's
    # three sentences, so only its last take is left to render.
    assert one["cached"] is True and "takes" not in one
    assert two["takes"] == {"total": 4, "cached": 3}
    edited = {**kw, "text": kw["text"].replace("whole long night.", "whole night.", 1)}
    assert _outline(router, **edited)["chapters"][0]["takes"] == {"total": 3, "cached": 2}
    paused = {**kw, "punctuation_pauses": {**pauses, "sentence": 700}}
    assert _outline(router, **paused)["chapters"][0]["takes"] == {"total": 3, "cached": 3}
    # Read in paragraphs, a chapter has no takes kept one by one.
    assert "takes" not in _outline(router, text=kw["text"])["chapters"][0]


def test_outline_reads_the_remote_cache_when_the_job_runs_remotely(local_engine, outputs):
    router = local_engine
    remote = types.SimpleNamespace(remote=True)
    req = router.AudiobookOutlineRequest(text=_SCRIPT)
    plan = router.parse_audiobook_script(_SCRIPT)
    cache_dir = str(outputs / "longform_cache")
    os.makedirs(cache_dir, exist_ok=True)
    _, path = router._remote_chapter_call(
        plan.chapters[0], engine_id="eng", default_voice=None, voice_map=None, language=None,
        lexicon=None, opts=router._expressive_opts(req), cache_dir=cache_dir)
    _wav(path)
    states = [router._chapter_cache_state(c, decision=remote, default_voice=None, language=None,
                                          opts=router._expressive_opts(req), voice_map=None,
                                          lexicon=None, cache_dir=cache_dir)
              for c in plan.chapters]
    assert [cached for _key, cached, _names in states] == [True, False]
    assert states[0][0] == router._cache_name(path) == states[0][2][0]


def test_outline_and_preview_flag_the_untitled_intro(local_engine, outputs, monkeypatch):
    """The parser names the untitled intro "Chapter 1" in English; every reply
    that carries that title says it is a stand-in, so the app names it."""
    router = local_engine
    text = "An opening line.\n# Chương 1\nBody."
    got = _outline(router, text=text)["chapters"]
    assert [(c["title"], c.get("untitled")) for c in got] == [
        ("Chapter 1", True), ("Chương 1", None)]

    async def run_chapter(chapter, **_kw):
        return str(outputs / "longform_cache" / "x.wav"), 1.0, True, None

    monkeypatch.setattr(router, "_run_chapter", run_chapter)

    def preview(index):
        req = router.AudiobookPreviewRequest(text=text, chapter_index=index)
        return asyncio.run(router.audiobook_preview(req))

    assert preview(0)["untitled"] is True
    assert "untitled" not in preview(1)


def test_summary_keeps_no_english_stand_in_title():
    ab = _mod("services.audiobook")
    plan = ab.parse_audiobook_script("Opening.\n# Real\nBody.")
    summary = _mod("services.longform_render").render_summary(plan.chapters, voices=[])
    assert summary["chapter_titles"] == ["", "Real"]


@pytest.mark.skipif(_mod("services.ffmpeg_utils").find_ffmpeg() is None,
                    reason="ffmpeg required for a full render")
def test_a_fresh_full_render_leaves_every_chapter_rendered(local_engine, outputs, monkeypatch):
    """The outline's status is read under the key the real render records in
    the book's timeline: right after a full render through the /audiobook front
    door, no chapter may read as changed. Leveling is on, as the app sends it."""
    router = local_engine

    def build_synth(default_voice=None, language=None, opts=None, voice_map=None, lease=None):
        return {"mode": "generic", "engine_id": "eng", "sample_rate": SR,
                "resolve": router._voice_resolver(default_voice, voice_map, lease),
                "synth": lambda text, voice_id, speed=None, attempt=0: torch.full((2400,), 0.1)}

    monkeypatch.setattr(router, "_build_synth", build_synth)
    fields = {"text": "An opening line.\n# One\nFirst. [slow]Hi.[/slow]\n## Part\nMore.\n"
                      "# Two\nSecond chapter.",
              "level_voices": True, "line_gap_ms": 120, "lexicon": {"First": "Furst"}}

    async def render():
        response = await router.audiobook_synthesize(router.AudiobookRequest(**fields))
        return [json.loads(frame[len("data:"):]) async for frame in response.body_iterator]

    events = asyncio.run(asyncio.wait_for(render(), timeout=120))
    done = events[-1]
    assert done["type"] == "done", events
    chapters = [e for e in events if e["type"] == "chapter"]
    assert [(e["title"], e.get("untitled")) for e in chapters] == [
        ("Chapter 1", True), ("One", None), ("Two", None)]
    # No book title, and the intro's stand-in is none either.
    assert not done.get("title")

    got = _outline(router, **fields, output=done["output"])
    assert got["book"] is True
    assert [(c["status"], c["in_book"]) for c in got["chapters"]] == [("rendered", True)] * 3


def test_local_sample_rate_needs_no_model(monkeypatch):
    router = _mod("api.routers.audiobook")
    tts = _mod("services.tts_backend")
    monkeypatch.setattr(tts, "get_backend_class", lambda _id: tts.OmniVoiceBackend)
    monkeypatch.setattr(_mod("services.model_manager"), "model", None)
    assert router._local_sample_rate("omnivoice") == 24000
    monkeypatch.setattr(_mod("services.model_manager"), "model",
                        types.SimpleNamespace(sampling_rate=22050))
    assert router._local_sample_rate("omnivoice") == 22050

    class Other:
        _DEFAULT_SAMPLE_RATE = 48000
    monkeypatch.setattr(tts, "get_backend_class", lambda _id: Other)
    monkeypatch.setattr(tts, "_active_instance", None)
    assert router._local_sample_rate("other") == 48000


# ── HTML export ──────────────────────────────────────────────────────────────

_NASTY = '</script><script>alert(1)</script> & "q" <b>'


def _book(outputs, name="audiobook_h1.m4b", timeline=True):
    (outputs / name).write_bytes(b"\x00\x00\x00\x18ftypM4B fake book")
    if timeline:
        doc = {"version": 1, "output": name, "duration": 4.0, "chapters": [{
            "title": "One " + _NASTY, "start": 0.0, "end": 4.0, "precision": "phrase",
            "key": "secret-cache-key",
            "phrases": [{"text": "Hello " + _NASTY, "start": 0.0, "end": 1.0, "voice": None},
                        {"text": "Part two", "start": 1.5, "end": 2.0, "voice": None},
                        {"text": "Body.", "start": 2.5, "end": 4.0, "voice": None}],
            "sections": [{"title": "Part two", "level": 2, "start": 1.5, "phrase": 1}]}]}
        (outputs / f"{name}.timeline.json").write_text(json.dumps(doc), encoding="utf-8")
    return name


@pytest.fixture
def exports(outputs, tmp_path, monkeypatch):
    """The folder exports wait in: the app's data folder, outside the outputs."""
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr("core.config.DATA_DIR", str(data))
    # A shared system temp must never be used (another local user could
    # pre-create or link a fixed-name folder there).
    temp = tmp_path / "system-temp"
    temp.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(temp))
    return data / "html_exports"


def test_html_exports_stay_out_of_the_shared_temp_folder(outputs, exports, tmp_path):
    _export(output=_book(outputs))
    assert list(exports.glob("*.zip"))
    assert not any((tmp_path / "system-temp").iterdir())


def _export(**kw):
    router = _mod("api.routers.audiobook")
    return asyncio.run(router.audiobook_export_html(router.AudiobookHtmlExportRequest(**kw)))


def _zip(exports, got) -> zipfile.ZipFile:
    return zipfile.ZipFile(exports / f"{got['id']}.zip")


def _page_data(page: str) -> dict:
    m = re.search(r'<script type="application/json" id="book-data">(.*?)</script>', page, re.S)
    return json.loads(m.group(1))


def test_html_export_zips_a_self_contained_page_and_the_audio(outputs, exports):
    name = _book(outputs)
    covers = outputs / "audiobook_covers"
    covers.mkdir()
    (covers / "0123456789ab.png").write_bytes(b"\x89PNG cover")
    got = _export(output=name, title="My <Book> & co", lang="vi",
                  metadata={"author": "A <uthor>", "narrator": "N"},
                  cover_path=str(covers / "0123456789ab.png"),
                  labels={"play": "Phát", "contents": "Mục lục", "bogus": "x"})
    with _zip(exports, got) as archive:
        assert sorted(archive.namelist()) == ["audio/audiobook_h1.m4a", "cover.png", "index.html"]
        assert archive.read("audio/audiobook_h1.m4a") == (outputs / name).read_bytes()
        page = archive.read("index.html").decode("utf-8")
    # No network: no URL, no external resource of any kind.
    assert not re.search(r"https?:|//[a-z]|@import|url\(", page, re.I)
    assert 'src="audio/audiobook_h1.m4a"' in page and 'src="cover.png"' in page
    assert '<html lang="vi" dir="ltr">' in page
    # Book text is escaped everywhere it lands.
    assert "<title>My &lt;Book&gt; &amp; co</title>" in page and "A &lt;uthor&gt;" in page
    assert "alert(1)" in page and "<script>alert" not in page
    assert page.count("</script>") == 2  # the data block and the page script
    data = _page_data(page)
    chapter = data["chapters"][0]
    assert chapter["title"] == "One " + _NASTY
    assert [p["text"] for p in chapter["phrases"]][0] == "Hello " + _NASTY
    assert chapter["sections"] == [{"title": "Part two", "level": 2, "start": 1.5, "phrase": 1}]
    assert "secret-cache-key" not in page  # the cache key stays home
    assert data["labels"]["play"] == "Phát" and data["labels"]["pause"] == "Pause"
    assert "bogus" not in data["labels"] and "Mục lục" in page


def test_html_export_estimates_a_timeline_for_a_book_without_one(outputs, exports):
    name = _book(outputs, "audiobook_h2.mp3", timeline=False)
    script = "# One\nabcd\n## Sub\nefgh\n# Broken\nzz\n# Three\nijkl"
    got = _export(output=name, text=script, chapter_durations=[6.0, None, 2.0])
    with _zip(exports, got) as archive:
        assert "audio/audiobook_h2.mp3" in archive.namelist()
        data = _page_data(archive.read("index.html").decode("utf-8"))
    assert [(c["title"], c["start"], c["end"], c["precision"]) for c in data["chapters"]] == [
        ("One", 0.0, 6.0, "chapter"), ("Three", 6.0, 8.0, "chapter")]
    assert data["chapters"][0]["sections"][0]["title"] == "Sub"


def test_html_export_is_downloaded_once_and_leaves_no_copy_of_the_book(outputs, exports):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    router = _mod("api.routers.audiobook")
    name = _book(outputs)
    # What an earlier version left beside the book goes with the next export.
    (outputs / f"{name}.html.zip").write_bytes(b"old copy of the book")
    got = _export(output=name)
    assert sorted(p.name for p in outputs.iterdir() if p.is_file()) == [
        name, f"{name}.timeline.json"]
    assert got["bytes"] == os.path.getsize(exports / f"{got['id']}.zip")

    app = FastAPI()
    app.include_router(router.router)
    client = TestClient(app)
    first = client.get(f"/audiobook/export/html/{got['id']}")
    assert first.status_code == 200 and first.headers["content-type"] == "application/zip"
    assert first.content[:2] == b"PK"
    # Served once: the copy of the book is gone.
    assert list(exports.iterdir()) == []
    assert client.get(f"/audiobook/export/html/{got['id']}").status_code == 404
    assert client.get("/audiobook/export/html/" + "A" * 32).status_code == 404


def test_html_export_removes_exports_nobody_downloaded(outputs, exports):
    name = _book(outputs)
    exports.mkdir()
    stale, fresh = exports / ("a" * 32 + ".zip"), exports / ("b" * 32 + ".zip")
    for path in (stale, fresh):
        path.write_bytes(b"x")
    old = os.path.getmtime(stale) - 2 * 60 * 60
    os.utime(stale, (old, old))
    got = _export(output=name)
    assert sorted(p.name for p in exports.iterdir()) == sorted([fresh.name, f"{got['id']}.zip"])


def test_html_export_is_discarded_when_its_save_is_cancelled(outputs, exports):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    router = _mod("api.routers.audiobook")
    name = _book(outputs)
    kept, cancelled = _export(output=name), _export(output=name)
    app = FastAPI()
    app.include_router(router.router)
    client = TestClient(app)
    # The save dialog was cancelled: the copy of the book goes at once, not
    # an hour later with the next export.
    gone = client.delete(f"/audiobook/export/html/{cancelled['id']}")
    assert gone.status_code == 200 and gone.json() == {"deleted": cancelled["id"]}
    assert [p.name for p in exports.iterdir()] == [f"{kept['id']}.zip"]
    assert client.get(f"/audiobook/export/html/{cancelled['id']}").status_code == 404
    # Already gone (served, or discarded twice): not an error.
    assert client.delete(f"/audiobook/export/html/{cancelled['id']}").status_code == 200
    assert client.delete("/audiobook/export/html/" + "A" * 32).status_code == 404
    assert client.delete("/audiobook/export/html/..%2Fdata").status_code == 404
    assert [p.name for p in exports.iterdir()] == [f"{kept['id']}.zip"]


def test_startup_removes_every_export_an_earlier_run_left(outputs, exports):
    router = _mod("api.routers.audiobook")
    router.sweep_html_exports()  # no folder yet: fine
    exports.mkdir()
    # A download that never finished, one just made, and a write a crash cut short.
    for leftover in ("a" * 32 + ".zip", "b" * 32 + ".zip", "c" * 32 + ".zip.part"):
        (exports / leftover).write_bytes(b"a full copy of the book")
    router.sweep_html_exports()
    assert list(exports.iterdir()) == []


def test_the_backend_sweeps_html_exports_as_it_starts():
    import inspect

    # Phase B runs before the export routes are served.
    assert "sweep_html_exports()" in inspect.getsource(_mod("main")._phase_b)


def test_html_export_tags_the_book_text_with_its_own_language(outputs, exports):
    name = _book(outputs)
    got = _export(output=name, lang="ar", direction="rtl", book_lang="en")
    with _zip(exports, got) as archive:
        page = archive.read("index.html").decode("utf-8")
    # The page's words are the app's; the book's text is in its own language.
    assert '<html lang="ar" dir="rtl">' in page
    assert '<main id="text" lang="en" dir="auto">' in page
    assert '<ol id="toc" lang="en" dir="auto">' in page
    got = _export(output=name, book_lang="not a tag!")
    with _zip(exports, got) as archive:
        assert '<main id="text" lang="" dir="auto">' in archive.read("index.html").decode()


def test_html_export_names_an_untitled_chapter_in_the_app_language(outputs, exports):
    name = _book(outputs, "audiobook_h3.mp3", timeline=False)
    got = _export(output=name, text="Opening words.\n# Two\nMore.", chapter_durations=[1.0, 1.0],
                  labels={"chapter_n": "Chương {n}"})
    with _zip(exports, got) as archive:
        page = archive.read("index.html").decode("utf-8")
    # The text before the first heading is the book's opening: named in the
    # app's words, not numbered, so "Two" is chapter 1.
    chapters = _page_data(page)["chapters"]
    assert [(c["title"], c["number"], c.get("intro")) for c in chapters] == [
        ("Opening", None, True), ("Two", 1, None)]
    # The page's title falls back to the first chapter the script titled.
    assert "<title>Two</title>" in page
    # Every chapter untitled (a Stories-like plan): numbered in the app's words.
    html_mod = _mod("services.audiobook_html")
    data = html_mod.page_timeline({"chapters": [
        {"title": "Chapter 1", "untitled": True}, {"title": "Chapter 2", "untitled": True}]},
        {"chapter_n": "Chương {n}"})
    assert [(c["title"], c["number"], c.get("intro")) for c in data["chapters"]] == [
        ("Chương 1", 1, None), ("Chương 2", 2, None)]


def test_page_seek_bar_reads_as_a_time():
    html_mod = _mod("services.audiobook_html")
    page = html_mod.render_page(title="t", timeline=None, audio_src="audio/a.m4a")
    assert "seekBar.setAttribute('aria-valuetext', time)" in page


@pytest.mark.parametrize("output", ["../x.m4b", "audiobook_none.m4b", "audiobook_h1.wav", ""])
def test_html_export_refuses_anything_but_a_finished_book(outputs, exports, output):
    from fastapi import HTTPException

    _book(outputs)
    with pytest.raises(HTTPException) as caught:
        _export(output=output)
    assert caught.value.status_code == 404


def test_page_json_cannot_close_its_script_block():
    html_mod = _mod("services.audiobook_html")
    page = html_mod.render_page(title="t", timeline={"chapters": [{
        "title": "<!-- </script>", "start": 0, "end": 1, "precision": "phrase",
        "phrases": [{"text": " &", "start": 0, "end": 1}]}]}, audio_src="audio/a.m4a")
    block = re.search(r'id="book-data">(.*?)</script>', page, re.S).group(1)
    assert "<" not in block and ">" not in block and "&" not in block and " " not in block
    assert json.loads(block)["chapters"][0]["title"] == "<!-- </script>"
