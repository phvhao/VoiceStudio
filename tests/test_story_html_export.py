"""Stories as HTML books: who says each line, and where each line starts.

* ``/longform/render`` takes each line's character (``speaker``: its name and
  its colour slot in the editor) and where the line starts (``break_before``)
  — display only: synthesis and cache keys never see them, the resume
  manifest keeps them.
* The rendered timeline carries both onto its phrases, as the audiobook
  timeline carries breaks; a story timed before this gets them from the
  lines it was rendered from (``timeline_with_turns``).
* ``POST /audiobook/export/html`` with the story's lines exports it as turns,
  in the Script template unless another is asked for; the preview and the
  template list are routes of their own.

App modules are resolved at call time: other suites reload them.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import re
import zipfile

import pytest

MAI = {"name": "Bà Mai", "accent": 0}
CUONG = {"name": "Cường", "accent": 1}


def _mod(name: str):
    return importlib.import_module(name)


def _posted() -> list:
    """A story as ``storyToSpans`` posts it: narration, then two characters."""
    return [
        {"title": "Ngọn đèn", "spans": [
            {"voice_id": None, "text": "Gió thổi suốt ba ngày.", "pause_ms_after": 0},
            {"voice_id": "p1", "text": "Không phải đêm nay.", "pause_ms_after": 0,
             "break_before": "paragraph", "speaker": MAI},
            # A line holding only markup: no audio, its break passes on.
            {"voice_id": "p1", "text": " ", "pause_ms_after": 0, "break_before": "paragraph",
             "speaker": MAI},
            {"voice_id": "p2", "text": "Hải đăng ơi!", "pause_ms_after": 300,
             "break_before": "line", "speaker": CUONG}]},
    ]


def _plan():
    router = _mod("api.routers.audiobook")
    return [router._story_chapter(router.LongformChapter.model_validate(c), i)
            for i, c in enumerate(_posted())]


def test_lines_keep_their_speaker_and_break_out_of_synthesis():
    ab = _mod("services.audiobook")
    router = _mod("api.routers.audiobook")
    (chapter,) = _plan()
    assert [(s.text, s.break_before, s.speaker) for s in chapter.spans] == [
        ("Gió thổi suốt ba ngày.", None, None),
        ("Không phải đêm nay.", "paragraph", MAI),
        ("Hải đăng ơi!", "paragraph", CUONG)]
    # The resume manifest keeps them; the cache never sees them.
    assert [ab.Span(**s.to_dict()) for s in chapter.spans] == chapter.spans
    bare = ab.Span(voice_id="p2", text="Hải đăng ơi!", pause_ms_after=300)
    assert router._span_key_tuple(chapter.spans[2]) == router._span_key_tuple(bare)
    assert "speaker" not in bare.to_dict()


def test_the_timeline_says_who_reads_each_line_and_where_it_starts():
    ab = _mod("services.audiobook")
    (chapter,) = _plan()
    # Measured: one take per span.
    timing = {"version": 1, "sample_rate": 1000, "samples": 3000, "phrases": True, "spans": [
        {"span": i, "start": i * 1000, "end": i * 1000 + 900, "units": [[0, i * 1000, i * 1000 + 900]]}
        for i in range(3)]}
    for timed in (timing, None):
        phrases = ab.book_timeline("story_x.m4b", [(chapter, 3.0, timed)])["chapters"][0]["phrases"]
        assert [(p["text"], p.get("break"), p.get("speaker")) for p in phrases] == [
            ("Gió thổi suốt ba ngày.", None, None),
            ("Không phải đêm nay.", "paragraph", MAI),
            ("Hải đăng ơi!", "paragraph", CUONG)], timed


def test_an_old_story_timeline_gets_its_speakers_and_lines_from_the_story():
    ab = _mod("services.audiobook")
    old = {"version": 1, "output": "story_x.m4b", "duration": 3.0, "chapters": [{
        "title": "Ngọn đèn", "start": 0.0, "end": 3.0, "precision": "phrase", "phrases": [
            {"text": "Gió thổi suốt ba ngày.", "start": 0.0, "end": 1.0, "voice": None},
            {"text": "Không phải đêm nay.", "start": 1.0, "end": 2.0, "voice": "p1"},
            {"text": "Hải đăng ơi!", "start": 2.0, "end": 3.0, "voice": "p2"}],
        "sections": []}]}
    before = json.dumps(old)
    laid = ab.timeline_with_turns(old, _plan())
    assert json.dumps(old) == before  # never changed in place
    assert [(p.get("break"), p.get("speaker")) for p in laid["chapters"][0]["phrases"]] == [
        (None, None), ("paragraph", MAI), ("paragraph", CUONG)]
    # Already told, or text the story no longer holds: as it is.
    assert ab.timeline_with_turns(laid, _plan()) is laid
    edited = ab.timeline_with_turns(old, [_mod("api.routers.audiobook")._story_chapter(
        _mod("api.routers.audiobook").LongformChapter(title="X", spans=[{"text": "Khác."}]))])
    assert edited["chapters"] == old["chapters"]


# ── The export routes ────────────────────────────────────────────────────────

@pytest.fixture
def outputs(tmp_path, monkeypatch):
    monkeypatch.setattr("core.config.OUTPUTS_DIR", str(tmp_path))
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr("core.config.DATA_DIR", str(data))
    return tmp_path


def _export(outputs, **body) -> str:
    router = _mod("api.routers.audiobook")
    got = asyncio.run(router.audiobook_export_html(router.AudiobookHtmlExportRequest(**body)))
    with zipfile.ZipFile(outputs / "data" / "html_exports" / f"{got['id']}.zip") as archive:
        return archive.read("index.html").decode("utf-8")


def _turns(page: str) -> list:
    return re.findall(r'<p class="turn who-(\d)"><b class="who">([^<]+)</b>', page)


def test_a_story_exports_as_turns_in_the_script_template(outputs):
    name = "story_old1.m4b"
    (outputs / name).write_bytes(b"\x00\x00\x00\x18ftypM4B fake story")
    old = {"version": 1, "output": name, "duration": 3.0, "chapters": [{
        "title": "Ngọn đèn", "start": 0.0, "end": 3.0, "precision": "phrase", "phrases": [
            {"text": "Gió thổi suốt ba ngày.", "start": 0.0, "end": 1.0, "voice": None},
            {"text": "Không phải đêm nay.", "start": 1.0, "end": 2.0, "voice": "p1"},
            {"text": "Hải đăng ơi!", "start": 2.0, "end": 3.0, "voice": "p2"}]}]}
    (outputs / f"{name}.timeline.json").write_text(json.dumps(old), encoding="utf-8")
    page = _export(outputs, output=name, story=_posted(), book_lang="vi")
    assert 'data-template="script"' in page
    assert _turns(page) == [("0", "Bà Mai"), ("1", "Cường")]
    # Without the story's lines it is still a story (by its name): Script,
    # one paragraph, nobody named — its voices are profile ids.
    plain = _export(outputs, output=name)
    assert 'data-template="script"' in plain and not _turns(plain)
    # Another template on request; names as the design says.
    classic = _export(outputs, output=name, story=_posted(),
                      design={"template": "classic", "show_names": False})
    assert 'data-template="classic"' in classic and not _turns(classic)


def test_a_story_rendered_without_a_timeline_is_estimated_from_its_lines(outputs):
    name = "story_untimed.m4b"
    (outputs / name).write_bytes(b"\x00\x00\x00\x18ftypM4B fake story")
    page = _export(outputs, output=name, story=_posted(), chapter_durations=[3.0])
    assert _turns(page) == [("0", "Bà Mai"), ("1", "Cường")]
    assert 'class="note"' in page  # timing estimated, and the page says so
    with pytest.raises(Exception) as bad:
        _export(outputs, output=name, story=[{"spans": "nope"}])
    assert getattr(bad.value, "status_code", None) == 422


def test_an_untimed_story_with_other_chapters_than_its_lengths_still_shows_its_text(
        outputs, monkeypatch):
    # Lengths kept for one chapter, lines posted for two (a chapter added
    # since the render): the page had a title and a player, and no text.
    name = "story_untimed2.m4b"
    (outputs / name).write_bytes(b"\x00\x00\x00\x18ftypM4B fake story")
    probed = []

    async def probe(path, **_):
        probed.append(path)
        return 6.0

    monkeypatch.setattr("services.ffmpeg_utils.probe_duration", probe)
    two = _posted() + [{"title": "Sáng", "spans": [
        {"voice_id": None, "text": "Trời đã sáng.", "pause_ms_after": 0}]}]
    page = _export(outputs, output=name, story=two, chapter_durations=[3.0])
    assert probed, "the file's own length shares out the chapters instead"
    assert "Gió thổi suốt ba ngày." in page and "Trời đã sáng." in page
    assert _turns(page) == [("0", "Bà Mai"), ("1", "Cường")]


def test_the_preview_and_the_templates_have_routes_of_their_own(outputs):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    name = "audiobook_prev1.m4b"
    (outputs / name).write_bytes(b"\x00\x00\x00\x18ftypM4B fake book")
    app = FastAPI()
    app.include_router(_mod("api.routers.audiobook").router)
    client = TestClient(app)
    # Declared before /{export_id}, which would otherwise take the path.
    listed = client.get("/audiobook/export/html/templates").json()
    assert [t["id"] for t in listed["templates"]] == [
        "classic", "modern", "magazine", "cinematic", "kids", "script"]
    assert listed["numbering"] == ["words", "numeral", "roman", "none"]
    preview = client.post("/audiobook/export/html/preview", json={
        "output": name, "text": "# One\nHello there.\n\nBye.", "chapter_durations": [2.0],
        "design": {"template": "kids", "body_font": "system"}})
    assert preview.status_code == 200
    page = preview.json()["html"]
    assert 'data-template="kids"' in page and "<script" not in page
    assert 'src="audio/' not in page and 'class="ph on"' in page
    # Writes nothing: no export waits to be downloaded.
    assert not (outputs / "data" / "html_exports").exists()
    assert client.post("/audiobook/export/html/preview",
                       json={"output": "../x.m4b"}).status_code == 404
