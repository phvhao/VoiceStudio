"""Audiobook sections, the outline's chapter status and the HTML export.

* ``## Title`` / ``### Title`` sections reach the plan, the rendered timeline
  (where each is heard) and the page.
* ``POST /audiobook/outline`` looks each chapter up under the key a real
  render uses (one derivation, ``_chapter_cache_keys``), and tells which
  chapters changed since the last book.
* ``POST /audiobook/export/html`` writes ``<output>.html.zip``: a
  self-contained ``index.html`` (escaped, timeline embedded, no network) and
  the book's audio.

App modules are resolved at call time: other suites reload them.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import re
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
    # Without sections the whole chapter is one entry, as before.
    plain = ab.parse_audiobook_script("# One\nabcd\nefgh").chapters[0]
    assert ab.book_timeline("x", [(plain, 2.0, None)])["chapters"][0]["phrases"] == [
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
    assert [cached for _key, cached in states] == [True, False]
    assert states[0][0] == router._cache_name(path)


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


def _export(**kw):
    router = _mod("api.routers.audiobook")
    return asyncio.run(router.audiobook_export_html(router.AudiobookHtmlExportRequest(**kw)))


def _page_data(page: str) -> dict:
    m = re.search(r'<script type="application/json" id="book-data">(.*?)</script>', page, re.S)
    return json.loads(m.group(1))


def test_html_export_zips_a_self_contained_page_and_the_audio(outputs):
    name = _book(outputs)
    covers = outputs / "audiobook_covers"
    covers.mkdir()
    (covers / "0123456789ab.png").write_bytes(b"\x89PNG cover")
    got = _export(output=name, title="My <Book> & co", lang="vi",
                  metadata={"author": "A <uthor>", "narrator": "N"},
                  cover_path=str(covers / "0123456789ab.png"),
                  labels={"play": "Phát", "contents": "Mục lục", "bogus": "x"})
    assert got["output"] == f"{name}.html.zip"
    with zipfile.ZipFile(outputs / got["output"]) as archive:
        assert sorted(archive.namelist()) == ["audio/audiobook_h1.m4a", "cover.png", "index.html"]
        assert archive.read("audio/audiobook_h1.m4a") == (outputs / name).read_bytes()
        page = archive.read("index.html").decode("utf-8")
    # No network: no URL, no external resource of any kind.
    assert not re.search(r"https?:|//[a-z]|@import|url\(", page, re.I)
    assert 'src="audio/audiobook_h1.m4a"' in page and 'src="cover.png"' in page
    assert '<html lang="vi">' in page
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


def test_html_export_estimates_a_timeline_for_a_book_without_one(outputs):
    name = _book(outputs, "audiobook_h2.mp3", timeline=False)
    script = "# One\nabcd\n## Sub\nefgh\n# Broken\nzz\n# Three\nijkl"
    got = _export(output=name, text=script, chapter_durations=[6.0, None, 2.0])
    with zipfile.ZipFile(outputs / got["output"]) as archive:
        assert "audio/audiobook_h2.mp3" in archive.namelist()
        data = _page_data(archive.read("index.html").decode("utf-8"))
    assert [(c["title"], c["start"], c["end"], c["precision"]) for c in data["chapters"]] == [
        ("One", 0.0, 6.0, "chapter"), ("Three", 6.0, 8.0, "chapter")]
    assert data["chapters"][0]["sections"][0]["title"] == "Sub"


def test_html_export_rebuilds_in_place_and_goes_with_the_book_name(outputs):
    router = _mod("api.routers.audiobook")
    name = _book(outputs)
    first = _export(output=name)["output"]
    assert _export(output=name, title="Again")["output"] == first
    assert sorted(p.name for p in outputs.iterdir() if p.name.startswith(name)) == [
        name, f"{name}.html.zip", f"{name}.timeline.json"]
    router._remove_book_derivatives(str(outputs / name))
    assert sorted(p.name for p in outputs.iterdir() if p.name.startswith(name)) == [name]


@pytest.mark.parametrize("output", ["../x.m4b", "audiobook_none.m4b", "audiobook_h1.wav", ""])
def test_html_export_refuses_anything_but_a_finished_book(outputs, output):
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
