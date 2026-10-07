"""The HTML book's designs: six templates over one page.

* Every template renders the shared page — highlight, contents, text size,
  themes, the justify toggle, print styles, keys — escapes every text from
  the book, and loads nothing from the network.
* A design embeds only the fonts it chose (none for system fonts), and every
  choice it does not know falls back to the template's own.
* The accent colour reads on every theme; names, numbering, the Magazine
  standfirst and pull quote, and sentence-by-sentence estimated chapters.

App modules are resolved at call time: other suites reload them.
"""
from __future__ import annotations

import importlib
import re

import pytest


def _mod(name: str):
    return importlib.import_module(name)


NASTY = '</script><img src=x onerror=alert(1)> & "q"  '


def _timeline(text: str = "Hello there.", *, speaker=None, voice=None, precision="phrase") -> dict:
    phrase = {"text": text, "start": 0.0, "end": 1.0}
    if speaker:
        phrase["speaker"] = speaker
    if voice:
        phrase["voice"] = voice
    return {"duration": 4.0, "chapters": [
        {"title": "One", "start": 0.0, "end": 2.0, "precision": precision,
         "phrases": [phrase, {"text": "Second line.", "start": 1.0, "end": 2.0,
                              "break": "paragraph"}],
         "sections": []},
        {"title": "Two", "start": 2.0, "end": 4.0, "precision": precision,
         "phrases": [{"text": "Then.", "start": 2.0, "end": 4.0}], "sections": []}]}


def _page(timeline=None, **kw):
    html_mod = _mod("services.audiobook_html")
    kw.setdefault("title", "Book")
    kw.setdefault("audio_src", "audio/a.m4a")
    return html_mod.render_page(timeline=timeline if timeline is not None else _timeline(), **kw)


def _design(template=None, **kw):
    return _mod("services.book_templates").resolve(template, **kw)


def _without_fonts(page: str) -> str:
    return re.sub(r"url\(data:font/woff2;base64,[A-Za-z0-9+/=]*\)", "url(FONT)", page)


def _families(page: str) -> list:
    return re.findall(r'@font-face\{font-family:"([^"]+)";font-style:(\w+)', page)


def _templates():
    return list(_mod("services.book_templates").TEMPLATES)


# ── Every template ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("template", ["classic", "modern", "magazine", "cinematic", "kids",
                                      "script"])
def test_every_template_renders_the_shared_page(template):
    assert template in _templates()
    page = _page(design=_design(template), book_lang="vi")
    assert f'data-template="{template}"' in page and f'class="tpl-{template}' in page
    for marker in ('<nav class="toc" id="toc-panel"', 'id="settings"', 'id="font-down"',
                   'data-pref="theme" data-value="sepia"', 'data-pref="theme" data-value="dark"',
                   'data-pref="align" data-value="justify"', 'id="follow"', 'id="prev-chapter"',
                   'id="keys-toggle"', 'id="back-to-current"', '<section class="chapter"',
                   'class="ph" data-s="0" data-e="1"', "@media print", ":root[data-theme=sepia]",
                   ":root[data-theme=dark]", "prefers-color-scheme:dark", 'id="book-data"'):
        assert marker in page, (template, marker)
    # The keys, the highlight and the contents are driven by one script.
    script = page[page.index("<script>"):]
    for marker in ("event.key === ' '", "ArrowLeft", "classList.add('on')", "setDrawer"):
        assert marker in script, (template, marker)


@pytest.mark.parametrize("template", ["classic", "modern", "magazine", "cinematic", "kids",
                                      "script"])
def test_every_template_escapes_the_book(template):
    """The book's own text — title, people, chapters, sections, phrases,
    names, the copies a standfirst or pull quote makes — and the app's
    labels never reach the page as markup."""
    timeline = {"duration": 9.0, "chapters": [{
        "title": NASTY, "start": 0.0, "end": 9.0, "precision": "phrase",
        "phrases": [{"text": f"Start {NASTY}.", "start": 0, "end": 1,
                     "speaker": {"name": NASTY, "accent": 1}}] + [
            {"text": f"Paragraph {k} {NASTY} here at last.", "start": k, "end": k + 1,
             "break": "paragraph", "voice": NASTY} for k in range(1, 8)],
        "sections": [{"title": NASTY, "level": 2, "start": 3, "phrase": 3}]}]}
    for story in (False, True):
        page = _page(timeline, title=NASTY, author=NASTY, narrator=NASTY,
                     labels={"settings": "<b>S</b>", "play": "<i>P</i>"},
                     design=_design(template, show_names=True), story=story,
                     voice_names={NASTY: NASTY}, cover_src='x" onload="alert(1)')
        bare = _without_fonts(page)
        assert "<img src=x" not in bare and "onerror=alert" not in bare.replace("onerror=alert(1)&gt;", "")
        assert bare.count("</script>") == 2
        assert "<b>S</b>" not in bare and "<i>P</i>" not in bare
        assert 'onload="alert(1)"' not in bare
        assert "&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;" in bare
        # The data block can hold no markup and no line separator either.
        data = bare[bare.index('id="book-data">'):bare.index("</script>")]
        assert "<" not in data[len('id="book-data">'):] and " " not in data


@pytest.mark.parametrize("template", ["classic", "modern", "magazine", "cinematic", "kids",
                                      "script"])
def test_no_template_loads_anything_from_the_network(template):
    page = _page(design=_design(template), cover_src="cover.png")
    bare = _without_fonts(page)
    assert not re.search(r"https?:|//[a-z0-9]|@import|\bsrc=\"(?!audio/|cover\.png)", bare, re.I)
    # Every url() is a font the page carries.
    assert "url(" not in bare.replace("url(FONT)", "")
    preview = _without_fonts(_page(design=_design(template), preview=True))
    assert "<script" not in preview and "url(" not in preview.replace("url(FONT)", "")


# ── Fonts ────────────────────────────────────────────────────────────────────

def test_only_the_chosen_fonts_are_embedded():
    fonts = _mod("services.book_fonts")
    assert fonts.families(), "the bundled fonts are missing"
    # System fonts: no font at all, and the smallest page.
    system = _page(design=_design("classic", body_font="system", heading_font="system"))
    assert "@font-face" not in system
    assert "font-family:" in system and '"Noto Serif"' in system
    chosen = _page(design=_design("classic", body_font="lora", heading_font="inter"))
    assert sorted(set(_families(chosen))) == [("Inter", "normal"), ("Lora", "normal")]
    assert len(chosen) > len(system) + 100_000
    # One family for both: embedded once.
    same = _page(design=_design("modern", body_font="inter", heading_font="inter"))
    assert _families(same) == [("Inter", "normal")]
    # Italics only where the template sets them (Magazine's standfirst and quotes).
    magazine = _page(design=_design("magazine"))
    assert ("Playfair Display", "italic") in _families(magazine)
    assert ("Source Serif 4", "italic") not in _families(magazine)
    # A font this app does not bundle falls back to the template's.
    unknown = _design("kids", body_font="comic-sans", heading_font="../../etc/passwd")
    assert (unknown.body_font, unknown.heading_font) == ("nunito", "baloo-2")


def test_design_falls_back_to_the_template_for_what_it_does_not_know():
    templates = _mod("services.book_templates")
    odd = templates.resolve("nope", accent="red", numbering="hex", show_names=None)
    assert odd.template.id == "classic" and odd.accent == odd.template.accent
    assert odd.numbering == "words" and odd.show_names is False
    assert templates.resolve(None, story=True).template.id == "script"
    assert templates.resolve("magazine", story=True).template.id == "magazine"
    assert templates.resolve("modern", accent="#ABCDEF").accent == "#abcdef"
    listed = templates.listing()
    assert [t["id"] for t in listed] == ["classic", "modern", "magazine", "cinematic", "kids",
                                         "script"]
    assert [t["id"] for t in listed if t["stories"]] == ["script"]


@pytest.mark.parametrize("accent", ["#ffffff", "#000000", "#ffd400", "#1d4ed8", "#c8102e"])
def test_the_accent_reads_on_every_theme_of_every_template(accent):
    templates = _mod("services.book_templates")
    for template in templates.TEMPLATES.values():
        design = templates.resolve(template.id, accent=accent)
        for theme in templates.THEMES:
            tokens = templates._tokens(design, theme)
            assert templates.contrast(tokens["accent"], tokens["paper"]) >= 4.5, (
                template.id, theme, accent)
            assert templates.contrast(tokens["on-accent"], tokens["accent"]) >= 3, (
                template.id, theme, accent)


def _rules(page: str) -> list:
    """Every ``selector{declarations}`` of the page's style sheet, innermost
    first (an @media block's own rules included)."""
    css = _without_fonts(page)
    css = css[css.index("<style>"):css.index("</style>")]
    return [(sel.strip(), body) for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css)]


def test_text_on_a_character_colour_reads_on_every_theme():
    # Kids sets each chapter label on a character colour: white on the dark
    # theme's pastels was 1.7–2.5:1.
    templates = _mod("services.book_templates")
    design = templates.resolve("kids")
    for theme in templates.THEMES:
        tokens = templates._tokens(design, theme)
        for i in range(len(templates.WHO_LIGHT)):
            assert templates.contrast(tokens[f"on-who-{i}"], tokens[f"who-{i}"]) >= 4.5, (theme, i)
    for selector, body in _rules(_page(design=design)):
        if selector.endswith(".opener .label") and "background:var(--who-" in body:
            slot = re.search(r"background:var\(--who-(\d)\)", body).group(1)
            assert f"color:var(--on-who-{slot})" in body, selector
    # On paper a label is plain black text, never black on a black fill.
    printed = _page(design=design)
    printed = printed[printed.rindex("@media print{"):]
    assert ".opener .label{background:none}" in printed


@pytest.mark.parametrize("template", ["classic", "modern", "magazine", "cinematic", "kids",
                                      "script"])
def test_a_character_name_can_wrap(template):
    # A long name (up to 80 characters) once ran over the line beside it in
    # Script's name column, and past the screen on a phone.
    page = _page(design=_design(template, show_names=True), story=True)
    for selector, body in _rules(page):
        if ".who" in selector:
            assert "nowrap" not in body, (template, selector)
        # Wrapped, a turn's name keeps its last line on the column's edge, not
        # the paragraph's justified last line's start.
        if selector == "p.turn .who" and "text-align:end" in body:
            assert "text-align-last:auto" in body, (template, body)


@pytest.mark.parametrize("template", ["classic", "modern", "magazine", "cinematic", "kids",
                                      "script"])
def test_the_word_being_read_keeps_its_width(template):
    # Kids set it in 800 weight: each word grew as it lit, and the line
    # re-wrapped under a child reading along.
    width = re.compile(r"(?:^|;)\s*(?:font(?:-weight|-size|-family|-stretch)?|letter-spacing|"
                       r"word-spacing|padding[\w-]*|border(?:-[\w-]*)?|margin[\w-]*)\s*:")
    for selector, body in _rules(_page(design=_design(template))):
        if re.search(r"\.(?:w|ph)\.on\b", selector):
            assert not width.search(body), (template, selector, body)


@pytest.mark.parametrize("template", ["classic", "modern", "magazine", "cinematic", "kids",
                                      "script"])
def test_every_italic_a_template_sets_is_embedded(template):
    # Script set phone narration in italic without its italic: the browser
    # slanted the upright face, Vietnamese marks and all.
    templates = _mod("services.book_templates")
    design = _design(template)
    page = _page(design=design)
    for selector, body in _rules(page):
        if "@font-face" in selector or not re.search(r"font(?:-style)?:\s*italic", body):
            continue
        role = "heading" if "var(--heading-font)" in body else "body"
        assert role in templates.TEMPLATES[template].italic, (template, selector)
        family = _mod("services.book_fonts").family(getattr(design, f"{role}_font")).family
        assert (family, "italic") in _families(page), (template, selector)


# ── Names, numbering, standfirst and pull quotes ─────────────────────────────

def test_chapter_numbering_styles():
    pages = {style: _page(design=_design("classic", numbering=style))
             for style in ("words", "numeral", "roman", "none")}
    label = '<p class="label" lang="en" dir="ltr">{}</p><h2>Two</h2>'
    assert label.format("Chapter 2") in pages["words"]
    assert label.format("2") in pages["numeral"]
    assert label.format("II") in pages["roman"]
    assert '<span class="num">II</span>' in pages["roman"]
    assert 'class="label"' not in pages["none"] and 'class="num"' not in pages["none"]
    # A title that says its number already gets no label above it.
    said = _page({"chapters": [{"title": "Chapter 7: Rain", "start": 0, "end": 1,
                                "phrases": [{"text": "x", "start": 0, "end": 1}]}]})
    assert 'class="label"' not in said


def test_a_story_is_set_as_turns_with_each_character_named():
    mai = {"name": "Mai", "accent": 1}
    cuong = {"name": "Cường", "accent": 9}
    timeline = {"chapters": [{"title": "One", "start": 0, "end": 4, "precision": "phrase",
                              "phrases": [
        {"text": "The storm came.", "start": 0, "end": 1},
        {"text": "Not tonight.", "start": 1, "end": 2, "break": "paragraph", "speaker": mai},
        {"text": "Hold on.", "start": 2, "end": 3, "break": "paragraph", "speaker": mai},
        {"text": "Lighthouse!", "start": 3, "end": 4, "break": "paragraph", "speaker": cuong}],
        "sections": []}]}
    script = _page(timeline, story=True, design=_design("script", story=True))
    turns = re.findall(r'<p class="turn who-(\d)"><b class="who">([^<]+)</b> <span class="said">',
                       script)
    # One block per line, in the editor's colour (its slot, round the palette).
    assert turns == [("1", "Mai"), ("1", "Mai"), ("1", "Cường")]
    assert '<p class="lead"><span class="ph"' in script  # narration: no name
    assert re.search(r'<body class="tpl-script[^"]* turns"', script)
    # Elsewhere a name shows where the speaker changes; switched off, never.
    classic = _page(timeline, story=True, design=_design("classic", show_names=True))
    assert len(re.findall(r'<b class="who">', classic)) == 2
    off = _page(timeline, story=True, design=_design("script", show_names=False))
    assert 'class="who"' not in off and not re.search(r'<body class="[^"]* turns"', off)


def test_a_voice_that_changes_inside_a_paragraph_is_named_where_it_changes():
    """A book's [voice:…] tags often switch voices mid-paragraph: Script
    gives the new voice a turn of its own, the other templates name it
    inline, where it starts."""
    timeline = {"chapters": [{"title": "One", "start": 0, "end": 3, "precision": "phrase",
                              "phrases": [
        {"text": "Rohn begins:", "start": 0, "end": 1, "voice": "Ly"},
        {"text": "a gloomy fact.", "start": 1, "end": 2, "voice": "Ly"},
        {"text": "This book is no manual.", "start": 2, "end": 3, "voice": "Cuc"}]}]}
    script = _page(timeline, design=_design("script"))
    assert re.findall(r'<p class="turn who-(\d)"><b class="who">([^<]+)</b>', script) == [
        ("0", "Ly"), ("1", "Cuc")]
    classic = _page(timeline, design=_design("classic", show_names=True))
    paragraph = re.search(r'<p class="turn who-0"><b class="who">Ly</b> (.*?)</p>',
                          classic).group(1)
    assert re.findall(r'<b class="who who-(\d)">([^<]+)</b>', paragraph) == [("1", "Cuc")]
    assert paragraph.index(">Cuc</b> <span class=\"ph\"") > paragraph.index("a gloomy fact.")
    assert 'class="who' not in _page(timeline, design=_design("classic"))


def test_magazine_sets_an_initial_only_on_a_capital():
    def first_paragraph(first: str, second: str) -> str:
        page = _page({"chapters": [{"title": "One", "start": 0, "end": 2, "precision": "phrase",
                                    "phrases": [{"text": first, "start": 0, "end": 1},
                                                {"text": second, "start": 1, "end": 2}]}]},
                     design=_design("magazine"))
        return re.search(r'<p class="standfirst">.*?</p>(<p[^>]*>)', page).group(1)

    assert first_paragraph("Rohn begins:", "“Trong sáu nghìn năm…”") == '<p class="initial">'
    assert first_paragraph("Rohn begins:", "trong sáu nghìn năm") == "<p>"


def test_a_book_names_its_voices_but_never_a_profile_id():
    html_mod = _mod("services.audiobook_html")
    profile = "0f8fad5b-d9cb-469f-a165-70867728950e"
    timeline = {"chapters": [{"title": "One", "phrases": [
        {"text": "A.", "start": 0, "end": 1, "voice": "Narrator"},
        {"text": "B.", "start": 1, "end": 2, "voice": profile, "break": "paragraph"},
        {"text": "C.", "start": 2, "end": 3, "voice": "abc123", "break": "paragraph"},
        {"text": "D.", "start": 3, "end": 4, "break": "paragraph"}]}]}
    data = html_mod.page_timeline(timeline, voice_names={"abc123": "Kim Cúc"})
    assert data["people"] == [{"name": "Narrator", "color": 0}, {"name": "Kim Cúc", "color": 1}]
    assert [p.get("who") for p in data["chapters"][0]["phrases"]] == [0, None, 1, None]
    # A story names characters only: its voices are profiles.
    assert html_mod.page_timeline(timeline, story=True)["people"] == []


def test_magazine_sets_a_standfirst_and_a_pull_quote():
    phrases = [{"text": "It began at dawn.", "start": 0, "end": 1}]
    phrases += [{"text": f"Paragraph {k} opens here with a sentence long enough. And more.",
                 "start": k, "end": k + 1, "break": "paragraph"} for k in range(1, 7)]
    page = _page({"chapters": [{"title": "One", "start": 0, "end": 7, "precision": "phrase",
                                "phrases": phrases}]}, design=_design("magazine"))
    assert re.search(r'<p class="standfirst"><span class="ph"[^>]*>It began at dawn\.</span></p>',
                     page)
    quote = re.search(r'<blockquote class="pull" aria-hidden="true"><p>([^<]+)</p></blockquote>',
                      page)
    assert quote and quote.group(1).startswith("Paragraph ") and quote.group(1).endswith(
        "long enough.")
    # The copy is no phrase: the highlight and the words stay the text's own.
    assert page.count('class="ph"') == len(phrases)


def test_estimated_chapters_are_highlighted_sentence_by_sentence():
    html_mod = _mod("services.audiobook_html")
    timeline = {"chapters": [{"title": "One", "start": 0, "end": 10, "precision": "chapter",
                              "phrases": [{"text": "First one. Dr. Who came! Then “Yes.” Fin",
                                           "start": 0, "end": 10}],
                              "sections": []}]}
    phrases = html_mod.page_timeline(timeline)["chapters"][0]["phrases"]
    assert [p["text"] for p in phrases] == ["First one.", "Dr. Who came!", "Then “Yes.”", "Fin"]
    assert phrases[0]["start"] == 0 and phrases[-1]["end"] == 10
    assert all(a["end"] == b["start"] for a, b in zip(phrases, phrases[1:]))
    assert html_mod.sentences("TS. Nguyễn đến. Ông nói.") == ["TS. Nguyễn đến.", "Ông nói."]


def test_the_preview_is_the_first_chapter_without_script_or_audio():
    page = _page(preview=True, design=_design("cinematic"))
    assert "<script" not in page and 'preload="none"' in page and 'src="audio/' not in page
    assert 'id="chapter-1"' in page and 'id="chapter-2"' not in page
    # The contents still list every chapter; the first phrase shows the highlight.
    assert 'data-target="chapter-2"' in page
    assert page.count('class="ph on"') == 1
