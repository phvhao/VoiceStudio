"""The reader's paragraphs and the HTML book.

* ``parse_script_to_spans(layout=True)`` marks each span that starts a new
  line or paragraph of the script (``break_before``) — display only: the
  golden corpus, synthesis and cache keys never see it.
* :func:`services.audiobook.book_timeline` carries those breaks onto its
  phrases (``"break"``), cutting an entry where one starts inside it, and
  :func:`services.audiobook.timeline_with_layout` gives an older timeline
  the breaks of the script it was rendered from.
* The exported page sets the book as an e-book: paragraphs, an untitled
  opening without a made-up "Chapter 1", contents, reading settings, a
  player bar and a print stylesheet — one self-contained, escaped file.

App modules are resolved at call time: other suites reload them.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import pathlib
import re

import pytest

_ROOT = pathlib.Path(__file__).resolve().parent.parent


def _mod(name: str):
    return importlib.import_module(name)


def _layout(script: str) -> list:
    parser = _mod("services.longform_parser")
    return [[(s["text"], s.get("break_before")) for s in c["spans"]]
            for c in parser.parse_script_to_spans(script, layout=True)]


# ── Parser ───────────────────────────────────────────────────────────────────

def test_layout_marks_lines_and_paragraphs_across_markup():
    assert _layout(
        "Intro.\n# One\nFirst [voice:B] inline.\n[voice:A]\nOwn line.\n\n[pause 1s]\nAfter.\n"
        "[voice:B] Next line.\nSame [pause] line.") == [
        [("Intro.", None)],
        [("First", None),            # a chapter's first text: no break
         ("inline.", None),          # a voice switch inside the line
         ("Own line.", "line"),      # a line holding only a tag is a line, not blank
         ("After.", "paragraph"),    # the blank line before the [pause] line
         ("Next line.\nSame", "line"),  # a line break inside one span stays in it
         ("line.", None)]]


def test_layout_puts_a_heading_in_a_paragraph_of_its_own():
    assert _layout("Before.\n## Part\nAfter [slow]slow\n\nsplit[/slow] end.") == [
        [("Before.", None), ("Part", "paragraph"), ("After", "paragraph"),
         ("slow\n\nsplit", None), ("end.", None)]]


def test_layout_is_display_only():
    parser = _mod("services.longform_parser")
    script = "# One\nA.\n\nB [voice:X]\nC [slow]d[/slow]\n## S\ne"
    plain = parser.parse_script_to_spans(script)
    laid = parser.parse_script_to_spans(script, layout=True)
    # Without it the parse is the golden corpus's, byte for byte.
    assert "break_before" not in json.dumps(plain)
    strip = [{**c, "spans": [{k: v for k, v in s.items() if k != "break_before"}
                             for s in c["spans"]]} for c in laid]
    assert strip == plain


def test_break_before_survives_the_manifest_and_stays_out_of_cache_keys():
    ab = _mod("services.audiobook")
    router = _mod("api.routers.audiobook")
    spans = ab.parse_audiobook_script("# One\nA.\n\nB.").chapters[0].spans
    assert [s.break_before for s in spans] == [None]  # one span: its breaks are inside it
    spans = ab.parse_audiobook_script("# One\nA.\n[voice:X]\nB.").chapters[0].spans
    assert spans[1].break_before == "line"
    assert [ab.Span(**s.to_dict()) for s in spans] == spans  # the resume manifest
    bare = ab.Span(voice_id="X", text="B.")
    assert "break_before" not in bare.to_dict()
    assert router._span_key_tuple(spans[1]) == router._span_key_tuple(bare)


# ── Timeline ─────────────────────────────────────────────────────────────────

def _phrase_by_phrase():
    ab = _mod("services.audiobook")
    return ab.ExpressiveOptions(punctuation_pauses=ab.punctuation_pause_pairs({"sentence": 300}))


def _timing(*items, phrases=True, rate=1000):
    return {"version": 1, "sample_rate": rate, "samples": 10_000, "phrases": phrases,
            "spans": [{"span": i, "start": a, "end": b, "units": u} for i, a, b, u in items]}


def test_timeline_phrases_carry_their_breaks():
    ab = _mod("services.audiobook")
    chapter = ab.parse_audiobook_script(
        "# One\nFirst line.\nSecond line.\n\nNew paragraph. [voice:B]\nHi.").chapters[0]
    timing = _timing((0, 0, 3000, [[0, 0, 1000], [1, 1000, 2000], [2, 2000, 3000]]),
                     (1, 3000, 4000, [[0, 3000, 4000]]))
    phrases = ab.book_timeline("x", [(chapter, 4.0, timing)],
                               opts=_phrase_by_phrase())["chapters"][0]["phrases"]
    assert [(p["text"], p.get("break")) for p in phrases] == [
        ("First line.", None), ("Second line.", "line"),
        ("New paragraph.", "paragraph"), ("Hi.", "line")]


def test_timeline_cuts_a_take_where_a_line_starts_inside_it():
    ab = _mod("services.audiobook")
    # <=800-character chunks: one take holds both lines of the verse.
    chapter = ab.parse_audiobook_script("# One\nRoses are red\nviolets blue").chapters[0]
    timing = _timing((0, 0, 2600, [[0, 0, 2600]]), phrases=False)
    phrases = ab.book_timeline("x", [(chapter, 2.6, timing)])["chapters"][0]["phrases"]
    assert [(p["text"], p["start"], p["end"], p.get("break")) for p in phrases] == [
        ("Roses are red", 0.0, 1.352, None), ("violets blue", 1.352, 2.6, "line")]


def test_a_take_that_left_no_phrase_passes_its_break_on():
    ab = _mod("services.audiobook")
    chapter = ab.parse_audiobook_script("# One\nA one.\n\nB two.\nC three.").chapters[0]
    # The engine returned nothing for the second take.
    timing = _timing((0, 0, 3000, [[0, 0, 1000], [2, 2000, 3000]]))
    phrases = ab.book_timeline("x", [(chapter, 3.0, timing)],
                               opts=_phrase_by_phrase())["chapters"][0]["phrases"]
    assert [(p["text"], p.get("break")) for p in phrases] == [
        ("A one.", None), ("C three.", "paragraph")]


def test_timeline_with_layout_gives_an_old_timeline_its_paragraphs():
    ab = _mod("services.audiobook")
    script = "Opening.\n# One\nAlpha beta.\n\nGamma.\n## Part\nDelta."
    old = {"version": 1, "output": "x", "duration": 6.0, "chapters": [
        {"title": "Chapter 1", "untitled": True, "start": 0.0, "end": 1.0,
         "precision": "chapter", "phrases": [{"text": "Opening.", "start": 0.0, "end": 1.0}],
         "sections": []},
        {"title": "One", "start": 1.0, "end": 6.0, "precision": "chapter", "phrases": [
            {"text": "Alpha beta. Gamma.", "start": 1.0, "end": 3.0, "voice": None},
            {"text": "Part", "start": 3.0, "end": 4.0, "voice": None},
            {"text": "Delta.", "start": 4.0, "end": 6.0, "voice": None}],
         "sections": [{"title": "Part", "level": 2, "start": 3.0, "phrase": 1}]}]}
    before = json.dumps(old)
    laid = ab.timeline_with_layout(old, script)
    assert json.dumps(old) == before  # never changed in place
    one = laid["chapters"][1]
    assert [(p["text"], p["start"], p["end"], p.get("break")) for p in one["phrases"]] == [
        ("Alpha beta.", 1.0, 2.294, None), ("Gamma.", 2.294, 3.0, "paragraph"),
        ("Part", 3.0, 4.0, "paragraph"), ("Delta.", 4.0, 6.0, "paragraph")]
    assert one["sections"][0]["phrase"] == 2  # moved along with the cut
    # A timeline that has breaks, or a script that no longer holds the text.
    assert ab.timeline_with_layout(laid, script) is laid
    edited = ab.timeline_with_layout(old, "# One\nSomething else.")
    assert edited["chapters"] == old["chapters"]


# ── The page ─────────────────────────────────────────────────────────────────

def _page(timeline, **kw):
    html_mod = _mod("services.audiobook_html")
    return html_mod.render_page(title=kw.pop("title", "Book"), timeline=timeline,
                                audio_src="audio/a.m4a", **kw)


def _data(page: str) -> dict:
    block = re.search(r'id="book-data">(.*?)</script>', page, re.S).group(1)
    return json.loads(block)


def test_page_data_keeps_breaks_and_names_the_opening():
    ab = _mod("services.audiobook")
    html_mod = _mod("services.audiobook_html")
    timeline = html_mod.estimated_timeline(
        "x", "Before any heading.\n# Chương 1\nOne.\nTwo.\n\nThree.", duration=10.0)
    data = _data(_page(timeline, labels={"intro": "Mở đầu", "chapter_n": "Chương {n}"}))
    opening, first = data["chapters"]
    assert (opening["title"], opening["number"], opening["intro"]) == ("Mở đầu", None, True)
    assert "Chapter" not in json.dumps(data["chapters"])
    assert (first["title"], first["number"]) == ("Chương 1", 1)
    assert [(p["text"], p.get("break")) for p in first["phrases"]] == [
        ("One.", None), ("Two.", "line"), ("Three.", "paragraph")]
    assert ab.TIMELINE_VERSION == 1  # readers that ignore "break" still read it


def test_page_is_a_self_contained_escaped_book():
    nasty = '</script><img src=x onerror=alert(1)> & "q"'
    page = _page({"chapters": [{
        "title": nasty, "start": 0, "end": 2, "precision": "phrase",
        "phrases": [{"text": "Hi " + nasty, "start": 0, "end": 1},
                    {"text": "Bye", "start": 1, "end": 2, "break": "paragraph"}],
        "sections": []}]},
        title=nasty, author=nasty, narrator=nasty, labels={"settings": "<b>S</b>"})
    # No network: no URL or external resource; one script block of data, one of code.
    assert not re.search(r"https?:|//[a-z]|@import|url\(", page, re.I)
    assert page.count("</script>") == 2 and "<img src=x" not in page
    assert "&lt;b&gt;S&lt;/b&gt;" in page and "<b>S</b>" not in page
    assert _data(page)["chapters"][0]["phrases"][1]["break"] == "paragraph"
    # Contents, reading settings, player bar and shortcuts help.
    for marker in ('<nav class="toc" id="toc-panel"', 'id="toc"', 'id="settings"',
                   'data-pref="theme" data-value="sepia"', 'data-pref="align" data-value="start"',
                   'id="follow"', 'id="prev-chapter"', 'id="next-chapter"', 'id="ticks"',
                   'id="keys-toggle"', 'id="back-to-current"', 'id="toc-toggle"'):
        assert marker in page, marker
    # The keyboard hint lives in the popover, not loose on the page.
    assert re.search(r'<div class="menu" id="keys"[^>]*hidden>', page)


def test_page_typesets_justified_paragraphs_and_prints_clean():
    page = _page(None)
    css = page[page.index("<style>"):page.index("</style>")]
    assert "text-align:justify;text-justify:inter-word;text-align-last:start" in css
    assert "hyphens:manual" in css and "hyphens:auto" not in css
    assert ":root[data-align=start] main p{text-align:start}" in css
    assert '"Noto Serif"' in css and "@media print" in css
    printed = css[css.index("@media print"):]
    assert ".player" in printed and "display:none" in printed
    # Settings persist per browser, and a blocked storage never breaks the page.
    js = page[page.index("<script>"):]
    assert js.count("localStorage") == 2 and js.count("try {") >= 2
    # Paragraphs and line breaks come from the timeline.
    assert "brk === 'paragraph'" in js and "brk === 'line'" in js


def test_page_labels_match_what_the_app_sends():
    """Every label the page uses comes from the app (``htmlExportLabels``)."""
    html_mod = _mod("services.audiobook_html")
    source = (_ROOT / "electron/src/renderer/src/features/longform/html-export.tsx").read_text(
        encoding="utf-8")
    body = source[source.index("export function htmlExportLabels"):]
    body = body[:body.index("\n}\n")]
    sent = set(re.findall(r"^\s+(\w+): t\(", body, re.M))
    assert sent == set(html_mod.DEFAULT_LABELS)


# ── The export route ─────────────────────────────────────────────────────────

@pytest.fixture
def outputs(tmp_path, monkeypatch):
    monkeypatch.setattr("core.config.OUTPUTS_DIR", str(tmp_path))
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr("core.config.DATA_DIR", str(data))
    return tmp_path


def test_export_gives_an_old_timeline_the_script_paragraphs(outputs):
    import zipfile

    router = _mod("api.routers.audiobook")
    name = "audiobook_old1.m4b"
    (outputs / name).write_bytes(b"\x00\x00\x00\x18ftypM4B fake book")
    doc = {"version": 1, "output": name, "duration": 2.0, "chapters": [{
        "title": "One", "start": 0.0, "end": 2.0, "precision": "phrase",
        "phrases": [{"text": "A.", "start": 0.0, "end": 1.0, "voice": None},
                    {"text": "B.", "start": 1.0, "end": 2.0, "voice": None}]}]}
    (outputs / f"{name}.timeline.json").write_text(json.dumps(doc), encoding="utf-8")
    got = asyncio.run(router.audiobook_export_html(router.AudiobookHtmlExportRequest(
        output=name, text="# One\nA.\n\nB.")))
    with zipfile.ZipFile(outputs / "data" / "html_exports" / f"{got['id']}.zip") as archive:
        data = _data(archive.read("index.html").decode("utf-8"))
    assert [p.get("break") for p in data["chapters"][0]["phrases"]] == [None, "paragraph"]


def _css(page: str) -> str:
    return page[page.index("<style>"):page.index("</style>")]


def _js(page: str) -> str:
    return page[page.index("<script>"):]


def test_a_book_without_headings_is_one_chapter_not_an_opening():
    """No heading at all: the one chapter is the book. No "Introduction" for
    its whole length, no made-up heading; the player names it by its title."""
    html_mod = _mod("services.audiobook_html")
    ab = _mod("services.audiobook")
    plan = ab.parse_audiobook_script("Just some text.\n\nMore text.")
    timeline = {"chapters": [{"title": c.title, "untitled": c.untitled} for c in plan.chapters]}
    labels = {"intro": "Mở đầu", "chapter_n": "Chương {n}"}
    (lone,) = html_mod.page_timeline(timeline, labels, book_title="Dế Mèn")["chapters"]
    assert (lone["title"], lone["number"], lone.get("intro")) == ("Dế Mèn", None, None)
    assert lone["headless"] is True and "app_title" not in lone
    # Without a book title, it is numbered in the app's words.
    (lone,) = html_mod.page_timeline(timeline, labels)["chapters"]
    assert (lone["title"], lone["number"], lone.get("app_title")) == ("Chương 1", None, True)
    # The page skips the heading of every headless chapter, the opening too.
    js = _js(_page(timeline))
    assert "if (!chapter.headless)" in js and "if (!chapter.intro)" not in js
    opening = html_mod.page_timeline({"chapters": [
        {"title": "Chapter 1", "untitled": True}, {"title": "One"}]}, labels)["chapters"][0]
    assert opening["intro"] is opening["headless"] is opening["app_title"] is True


def test_print_resets_every_theme_token_over_any_theme():
    """A theme picked in the menu (or Auto in a dark OS) must not print pale
    text: the print reset is as specific as every theme rule and resets every
    token they set."""
    css = re.sub(r"/\*.*?\*/", "", _css(_page(None)), flags=re.S)
    screen, printed = css[:css.index("@media print")], css[css.index("@media print"):]
    selectors, body = re.search(r"([^{}]*)\{([^}]*--fg:#000[^}]*)\}", printed).groups()
    selectors = [s.strip() for s in selectors.split(",")]
    themes = re.findall(r"(:root[^{]*)\{(--bg:[^}]*)\}", screen)
    assert len(themes) >= 3
    for selector, declarations in themes:
        # `:root[data-theme=…]` and `:root:not([data-theme])` are (0,2,0).
        wanted = ":root[data-theme]" if "data-theme=" in selector else selector.strip()
        assert wanted in selectors, (wanted, selectors)
        for token in re.findall(r"(--[\w-]+):", declarations):
            if token not in ("--scale", "--bar-h", "--player-h"):
                assert token + ":" in body, (selector, token)


def test_app_words_inside_the_book_text_carry_the_app_language():
    page = _page({"chapters": [
        {"title": "Chapter 1", "untitled": True, "precision": "chapter", "phrases": []},
        {"title": "Một", "precision": "chapter", "phrases": []}]},
        lang="en", book_lang="vi", narrator="Mai")
    assert '<main id="text" lang="vi" dir="auto">' in page
    assert '<p lang="en" dir="ltr">Narrated by <bdi>Mai</bdi></p>' in page
    js = _js(page)
    for marker in ("appWords(el('p', 'label', label))", "appWords(el('p', 'note', L.estimated))",
                   "if (chapter.app_title) appWords(openerTitle)",
                   "if (chapter.app_title) appWords(button.lastChild)",
                   "nowTitle.lang = shown && shown.appTitle ? root.lang : bookLang"):
        assert marker in js, marker
    assert [c.get("app_title") for c in _data(page)["chapters"]] == [True, None]


def test_contents_drawer_follows_the_chapter_and_leaves_with_the_narrow_layout():
    page = _page(None)
    css, js = _css(page), _js(page)
    # The phone drawer is fixed (no offsetParent) yet drawn: it still scrolls
    # to the current chapter, also as it opens.
    assert "tocPanel.offsetParent" not in js and "tocPanel.getClientRects().length" in js
    drawer = js[js.index("function setDrawer"):js.index("function closeDrawer")]
    assert drawer.index("showChapterInContents(currentEntry)") < drawer.index(".focus(")
    # Wide again (a tablet turned): no scrim left over the page, drawer closed.
    assert re.search(r"@media \(min-width:60\.01rem\)\{[^}]*\.scrim[^}]*display:none", css)
    assert "matchMedia('(min-width:60.01rem)')" in js and "setDrawer(false)" in js


def test_scrolling_the_contents_or_a_field_does_not_stop_the_follow():
    js = _js(_page(None))
    follow = js[js.index("function ownScroll"):js.index("var pillFrame")]
    assert "tocPanel.contains(target)" in follow and "target.closest('.menu')" in follow
    assert "INPUT|SELECT|TEXTAREA" in follow
    assert "window.addEventListener('wheel', userScrolled" not in js
    assert "ownScroll(event.target, false)" in follow and "ownScroll(event.target, true)" in follow

@pytest.fixture(autouse=True)
def _cut_at_marks_only(monkeypatch):
    """These tests pin where marks cut phrases and what the cuts carry; joining
    short phrases is tested on its own in test_phrase_rendering.py."""
    from services import chunked_tts

    monkeypatch.setattr(chunked_tts, "PHRASE_MIN_CHARS", 0)
