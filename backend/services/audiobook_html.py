"""A finished audiobook or story as a web page: ``index.html`` + its audio in a ZIP.

The page is ONE self-contained file — inline CSS and script, the fonts its
design names embedded, no network request of any kind (local-first) — that
plays ``audio/<book>.<ext>`` beside it and reads like an e-book: a title
block, a contents sidebar (a drawer on phones), chapters set in paragraphs
(a story's lines as turns with the character's name), the phrase being read
highlighted and its word underlined, from the book's rendered timeline
(:func:`services.audiobook.book_timeline`). A book rendered without one gets
a timeline estimated from the script, chapter by chapter. Reading settings
(text size, theme, alignment, following the voice) stay in the browser.

The text is set in the page itself, so it reads (and prints) without script
and the export dialog previews it in a frame that runs none; the script only
times each phrase's words and drives the player. The look is the book's
design (:mod:`services.book_templates`): one of six templates over this one
page, with its accent colour, fonts, names and chapter numbering.

Pure apart from :func:`write_export_zip`'s file I/O and the font files the
design embeds: no torch, no FastAPI.
"""
from __future__ import annotations

import html
import json
import os
import re
import zipfile
from typing import Optional

from services import book_fonts, book_templates

#: The page's own words, in the app's language. The app sends them; these
#: English defaults fill any it leaves out.
DEFAULT_LABELS = {
    "play": "Play",
    "pause": "Pause",
    "back": "Back 10 seconds",
    "forward": "Forward 10 seconds",
    "seek": "Position",
    "speed": "Speed",
    "contents": "Contents",
    "narrated_by": "Narrated by",
    "player": "Player",
    "estimated": "Timing is estimated: the highlight may run ahead of or behind the voice.",
    "keys": "Space plays or pauses, the arrow keys go back or forward.",
    "keys_chapter": "Shift with an arrow key goes to the previous or next chapter.",
    # A chapter the script gave no title, ``{n}`` its number.
    "chapter_n": "Chapter {n}",
    # The text before the book's first chapter heading.
    "intro": "Opening",
    "prev_chapter": "Previous chapter",
    "next_chapter": "Next chapter",
    "settings": "Reading settings",
    "text_size": "Text size",
    "smaller": "Smaller text",
    "larger": "Larger text",
    "theme": "Theme",
    "theme_auto": "Auto",
    "theme_light": "Light",
    "theme_sepia": "Sepia",
    "theme_dark": "Dark",
    "align": "Alignment",
    "justify": "Justify",
    "align_start": "Align left",
    "follow": "Follow the voice",
    "back_to_current": "Back to current",
    "shortcuts": "Keyboard shortcuts",
    "close": "Close",
    "slideshow": "Slideshow",
    "fullscreen": "Full screen",
}
#: The longest label kept (a sentence, not a payload).
_LABEL_MAX = 300
SPEEDS = (0.75, 1, 1.25, 1.5, 1.75, 2)
_BREAKS = ("line", "paragraph")
#: A name a phrase's voice may carry that is a profile id, not a name to show.
_ID_LIKE_RE = re.compile(r"^(?:[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}"
                         r"|[0-9a-f]{12,64})$", re.I)
#: The longest speaker or voice name shown.
_NAME_MAX = 80
#: A pull quote's length, in characters.
_PULL_MIN, _PULL_MAX = 25, 220
#: The phrases of a chapter the export dialog's preview shows.
_PREVIEW_PHRASES = 60
#: The longest first phrase a chapter sets as its standfirst.
_STANDFIRST_MAX = 240
#: Opening quote marks.
_QUOTES = "\"'“‘«„"
#: Where a sentence may end: its final marks and any closing quotes, then space.
_SENTENCE_END_RE = re.compile("[.!?…]+[\"'”’»)\\]]*\\s+")
#: Words a period follows without ending the sentence (lower case). Only
#: words that never end one: "etc." often does, so it is not here.
_ABBREVIATIONS = frozenset((
    "mr", "mrs", "ms", "dr", "prof", "jr", "sr", "vs", "e.g", "i.e",
    "tp", "ts", "ths", "gs", "pgs", "bs", "ks"))
#: Words that are abbreviations only before a number ("No. 5"); a sentence
#: may end in them ("She said no.").
_NUMBER_ABBREVIATIONS = frozenset(("no", "nos", "vol", "pp"))


def labels_for(given: Optional[dict]) -> dict:
    """The page's labels: ``given`` where it names a known label with text."""
    labels = dict(DEFAULT_LABELS)
    for key, value in (given or {}).items():
        if key in labels and isinstance(value, str) and value.strip():
            labels[key] = value.strip()[:_LABEL_MAX]
    return labels


def _script_json(value) -> str:
    """JSON safe inside ``<script type="application/json">``: no ``<``, ``>``
    or ``&`` (so no ``</script>`` or comment can close it early) and no line
    separators."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    for char, escape in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"),
                         (" ", "\\u2028"), (" ", "\\u2029")):
        text = text.replace(char, escape)
    return text


def estimated_timeline(output: str, script: str, *,
                       chapter_durations: Optional[list] = None,
                       duration: Optional[float] = None) -> Optional[dict]:
    """A timeline for a book rendered without one, from the script it was
    rendered from: each chapter's text spread evenly over the chapter
    (:func:`services.audiobook.book_timeline` with nothing measured).

    ``chapter_durations`` gives each parsed chapter's length in seconds
    (``None`` for one that failed, so is not in the file); when it does not
    line up with the script, ``duration`` (the whole file) is shared by the
    chapters by their length in characters. ``None`` with neither."""
    from services.audiobook import parse_audiobook_script

    return estimated_plan_timeline(output, parse_audiobook_script(script).chapters,
                                   chapter_durations=chapter_durations, duration=duration)


def estimated_plan_timeline(output: str, chapters: list, *,
                            chapter_durations: Optional[list] = None,
                            duration: Optional[float] = None) -> Optional[dict]:
    """:func:`estimated_timeline` for chapters already planned (a story's,
    as ``/longform/render`` reads them)."""
    from services.audiobook import book_timeline

    if not chapters:
        return None
    if chapter_durations is not None and len(chapter_durations) == len(chapters):
        timed = [(c, max(0.0, float(d)), None)
                 for c, d in zip(chapters, chapter_durations) if d is not None]
    elif duration and duration > 0:
        sizes = [max(1, c.char_count) for c in chapters]
        timed = [(c, duration * size / sum(sizes), None) for c, size in zip(chapters, sizes)]
    else:
        return None
    return book_timeline(output, timed)


def chapter_title(chapter: dict, number: int, labels: dict) -> str:
    """A timeline chapter's title on the page: as written, or for a chapter
    the script left untitled, ``labels["chapter_n"]`` with its ``number``."""
    if chapter.get("untitled"):
        return labels["chapter_n"].replace("{n}", str(number))
    return str(chapter.get("title") or "")


def page_timeline(timeline: Optional[dict], labels: Optional[dict] = None,
                  book_title: str = "", *, story: bool = False,
                  voice_names: Optional[dict] = None) -> dict:
    """What the page reads from a book timeline: chapters with their phrases
    (where each starts a new line or paragraph, and who says it) and
    sections, and the people who speak; nothing else (cache keys stay home).

    The text before a book's first heading is its opening (``intro``): the
    page shows it without a heading, never as a made-up "Chapter 1", and the
    chapters after it are numbered from 1. A book with no heading at all has
    no opening: its one chapter is the book, without a heading either, and
    the player names it by ``book_title``. Such chapters are ``headless``; a
    title in the app's words (a label, not the book's text) is ``app_title``.

    ``people`` lists each voice or character once, in the order they are
    first heard: ``{"name", "color"}`` (a palette slot). A story's phrases
    name the character who says them (``speaker``: its name and its slot in
    the Stories editor's colours); a book's, the ``[voice:NAME]`` reading
    them (``voice``), shown as ``voice_names`` names it — a profile id with
    no name to show is nobody. The book's default voice is nobody either.
    Each phrase said by somebody carries ``who``, an index into ``people``."""
    labels = labels_for(labels)
    found = [c for c in (timeline or {}).get("chapters") or [] if isinstance(c, dict)]
    opening = len(found) > 1 and bool(found[0].get("untitled")) and not any(
        c.get("untitled") for c in found[1:])
    lone = len(found) == 1 and bool(found[0].get("untitled"))
    people: list = []
    keys: dict = {}
    voices = 0

    def who(phrase: dict) -> Optional[int]:
        nonlocal voices
        speaker = phrase.get("speaker")
        if isinstance(speaker, dict) and isinstance(speaker.get("name"), str) \
                and speaker["name"].strip():
            name = speaker["name"].strip()[:_NAME_MAX]
            accent = speaker.get("accent")
            color = accent if type(accent) is int and accent >= 0 else len(people)
            key = ("speaker", name, color)
        elif story:
            return None
        else:
            voice = phrase.get("voice")
            if not isinstance(voice, str) or not voice.strip():
                return None
            given = (voice_names or {}).get(voice)
            if isinstance(given, str) and given.strip():
                name = given.strip()[:_NAME_MAX]
            elif _ID_LIKE_RE.fullmatch(voice.strip()):
                return None
            else:
                name = voice.strip()[:_NAME_MAX]
            key = ("voice", voice)
            color = None
        if key not in keys:
            if color is None:
                color = voices
                voices += 1
            keys[key] = len(people)
            people.append({"name": name, "color": color % len(book_templates.WHO_LIGHT)})
        return keys[key]

    chapters = []
    number = 0
    for index, chapter in enumerate(found):
        intro = opening and index == 0
        if not intro and not lone:
            number += 1
        if intro:
            title = labels["intro"]
        elif lone:
            title = book_title or chapter_title(chapter, 1, labels)
        else:
            title = chapter_title(chapter, number, labels)
        phrases = [_page_phrase(p, who(p)) for p in chapter.get("phrases") or []
                   if isinstance(p, dict)]
        sections = [{"title": str(s.get("title") or ""), "level": s.get("level", 2),
                     "start": s.get("start", 0), "phrase": s.get("phrase", 0)}
                    for s in chapter.get("sections") or [] if isinstance(s, dict)]
        precision = chapter.get("precision", "chapter")
        if precision == "chapter":
            phrases, moved = _by_sentence(phrases)
            for section in sections:
                if type(section["phrase"]) is int and 0 <= section["phrase"] < len(moved):
                    section["phrase"] = moved[section["phrase"]]
        doc = {
            "title": title,
            "number": None if intro or lone else number,
            "start": chapter.get("start", 0),
            "end": chapter.get("end", 0),
            "precision": precision,
            "phrases": phrases,
            "sections": sections,
        }
        if chapter.get("untitled"):
            doc["untitled"] = True
        if intro:
            doc["intro"] = True
        if intro or lone:
            doc["headless"] = True
        if intro or (chapter.get("untitled") and not (lone and book_title)):
            doc["app_title"] = True
        chapters.append(doc)
    out = {"chapters": chapters, "people": people}
    slides = [{"start": float(s["start"]), "name": s.get("name") if isinstance(s.get("name"), str)
               else None, "fit": s.get("fit") if s.get("fit") in ("auto", "cover", "contain")
               else "auto"}
              for c in found for s in c.get("images") or []
              if isinstance(s, dict) and isinstance(s.get("start"), (int, float))]
    if slides:
        # The slideshow's pictures, in time order (``name`` None: the cover again).
        out["slides"] = sorted(slides, key=lambda s: s["start"])
    return out


def _page_phrase(phrase: dict, who: Optional[int] = None) -> dict:
    doc = {"text": str(phrase.get("text") or ""), "start": phrase.get("start", 0),
           "end": phrase.get("end", 0)}
    if phrase.get("break") in _BREAKS:
        doc["break"] = phrase["break"]
    if who is not None:
        doc["who"] = who
    return doc


def _abbreviation(before: str, following: str) -> bool:
    """Whether the period after ``before`` (the sentence so far) marks an
    abbreviation rather than the sentence's end, ``following`` the first
    character after it."""
    words = [w.lstrip(_QUOTES + "(") for w in before.split()]
    if not words:
        return False
    word = words[-1].lower()
    if word in _NUMBER_ABBREVIATIONS:
        return following.isdigit()
    if word == "st":
        # "Main St." is a street, which may end a sentence; "St. Paul" (or
        # "Then St. Paul") a saint.
        return not (len(words) > 2 and words[-2][:1].isupper())
    return word in _ABBREVIATIONS


def sentences(text: str) -> list:
    """``text`` cut after each sentence-final mark (and its closing quotes)
    that a capital, a digit or an opening quote follows — not after an
    abbreviation such as "Dr." or "TS."."""
    out, start = [], 0
    for match in _SENTENCE_END_RE.finditer(text):
        following = text[match.end():match.end() + 1]
        if not following or not (following.isupper() or following.isdigit()
                                 or following in "\"'“‘«(["):
            continue
        if text[match.start()] == "." and _abbreviation(text[start:match.start()], following):
            continue
        out.append(text[start:match.end()].strip())
        start = match.end()
    out.append(text[start:].strip())
    return [s for s in out if s]


def _by_sentence(phrases: list) -> tuple:
    """The phrases of a chapter timed only as a whole — a paragraph each,
    timed by its share of the characters — cut into their sentences the same
    way, so the highlight moves on sentence by sentence (as the app's reader
    does) rather than lighting a whole paragraph. Returns them and, for each
    phrase given, the index of its first sentence."""
    out, moved = [], []
    for phrase in phrases:
        moved.append(len(out))
        parts = sentences(phrase["text"])
        if len(parts) < 2:
            out.append(phrase)
            continue
        start, end = float(phrase["start"] or 0), float(phrase["end"] or 0)
        total = sum(len(p) for p in parts) or 1
        at = 0
        for k, part in enumerate(parts):
            piece = {**phrase, "text": part,
                     "start": round(start + (end - start) * at / total, 3)}
            at += len(part)
            piece["end"] = round(start + (end - start) * at / total, 3)
            if k:
                piece.pop("break", None)
            out.append(piece)
    return out, moved


_CSS = """
:root{--scale:1;--bar-h:3.25rem;--player-h:7rem;--base:1.1875rem;--base-phone:1.0625rem;
--leading:1.75;--measure:66ch;--who:var(--accent)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:calc(var(--bar-h) + 1rem)}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 var(--ui-font);
padding-bottom:calc(var(--player-h) + 2rem)}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
[hidden]{display:none!important}
.icon{display:inline-grid;place-items:center;min-width:2.5rem;height:2.5rem;padding:0 .5rem;border-radius:.6rem;
border:1px solid transparent;background:transparent;cursor:pointer;line-height:1}
.icon:hover{background:var(--tint)}
.icon svg{width:1.25rem;height:1.25rem;fill:currentColor}
.icon:disabled{opacity:.4;cursor:default;background:transparent}
.bar{position:sticky;top:0;z-index:20;height:var(--bar-h);display:flex;align-items:center;gap:.5rem;
padding:0 .75rem;background:color-mix(in srgb,var(--bg) 92%,transparent);border-bottom:1px solid var(--line);
-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.bar-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;
font-size:.95rem;opacity:0;transition:opacity .2s}
.bar.titled .bar-title{opacity:1}
.aa{font-family:var(--body-font);font-size:1.05rem;font-weight:600}
.menu{position:absolute;z-index:30;background:var(--card);color:var(--fg);border:1px solid var(--line);
border-radius:.9rem;box-shadow:0 12px 32px var(--shadow);padding:.9rem;font-size:.9rem}
#settings{top:calc(var(--bar-h) - .25rem);inset-inline-end:.75rem;width:min(20rem,calc(100vw - 1.5rem))}
.menu fieldset{border:0;margin:0 0 .85rem;padding:0;min-width:0}
.menu legend,.menu .caption{display:block;padding:0;margin:0 0 .4rem;color:var(--muted);font-size:.78rem;
font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.seg{display:flex;gap:.25rem;padding:.2rem;border-radius:.65rem;background:var(--bg);border:1px solid var(--line)}
.seg button{flex:1;min-height:2.1rem;border:0;border-radius:.5rem;background:transparent;cursor:pointer;padding:0 .4rem}
.seg button[aria-pressed=true]{background:var(--card);color:var(--accent);font-weight:600;box-shadow:0 1px 3px var(--shadow)}
.seg button:disabled{opacity:.4;cursor:default}
.seg output{display:grid;place-items:center;min-width:3.5rem;font-variant-numeric:tabular-nums}
.switch{display:flex;align-items:center;justify-content:space-between;gap:1rem;cursor:pointer}
.switch input{width:1.1rem;height:1.1rem;accent-color:var(--accent)}
.shell{display:grid;grid-template-columns:17rem minmax(0,1fr);gap:3rem;max-width:76rem;margin:0 auto;padding:0 1.5rem}
.no-toc .shell{grid-template-columns:minmax(0,1fr)}
.no-toc .toc,.no-toc #toc-toggle{display:none}
.toc{position:sticky;top:var(--bar-h);align-self:start;max-height:calc(100vh - var(--bar-h) - var(--player-h));
overflow-x:hidden;overflow-y:auto;padding:1.5rem .25rem 1rem 0;font-size:.9rem;overscroll-behavior:contain}
.toc-head{display:flex;align-items:center;justify-content:space-between;margin:0 0 .5rem}
.toc h2{margin:0;font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
#toc,#toc ol{list-style:none;margin:0;padding:0}
#toc ol{margin:.1rem 0 .3rem;padding-inline-start:2.1rem}
#toc button{display:flex;gap:.6rem;align-items:baseline;width:100%;text-align:start;padding:.35rem .5rem;border:0;
border-radius:.5rem;background:transparent;cursor:pointer;line-height:1.35;overflow-wrap:anywhere;
border-inline-start:2px solid transparent}
#toc button:hover{background:var(--tint)}
#toc .num{flex:none;min-width:1.2rem;color:var(--muted);font-variant-numeric:tabular-nums;font-size:.85em}
#toc .t{min-width:0}
#toc .dur{display:none}
#toc button[aria-current=true]{color:var(--accent);font-weight:600;border-inline-start-color:var(--accent);
background:var(--tint)}
#toc button[aria-current=true] .num{color:var(--accent)}
#toc .s3{padding-inline-start:1.25rem}
#toc ol button{color:var(--muted);font-size:.95em;padding-block:.25rem}
.scrim{position:fixed;inset:0;z-index:39;background:rgba(0,0,0,.35)}
main{min-width:0;max-width:var(--measure);width:100%;margin:0 auto;padding:2.5rem 0 0;font-family:var(--body-font);
font-size:calc(var(--base) * var(--scale));line-height:var(--leading);font-kerning:normal}
.cover{display:flex;gap:1.5rem;align-items:center;margin:0 0 3rem;padding-bottom:2.5rem;border-bottom:1px solid var(--line)}
.cover img{width:9rem;max-width:35%;height:auto;border-radius:.4rem;box-shadow:0 8px 28px var(--shadow);flex:none}
.cover h1,.hero h1,.opener h2,main h3,main h4,.pull{font-family:var(--heading-font)}
.cover h1{margin:0;font-size:2.1em;line-height:1.15;font-weight:600;text-wrap:balance;overflow-wrap:break-word}
.cover p{margin:.6rem 0 0;color:var(--muted);font-family:var(--ui-font);font-size:.95rem;line-height:1.4}
.cover .author{font-size:1.05rem;color:var(--fg)}
.note{margin:0 0 2rem;padding:.6rem .9rem;border-radius:.6rem;background:var(--tint);color:var(--muted);
font:.85rem/1.45 var(--ui-font)}
main section{padding-top:1rem;margin-bottom:4rem}
.opener{margin:0 0 2rem;text-align:start}
.opener .label{margin:0 0 .5rem;color:var(--accent);font:600 .78rem/1.2 var(--ui-font);letter-spacing:.14em;
text-transform:uppercase}
.opener h2{margin:0;font-size:1.75em;line-height:1.25;font-weight:600;text-wrap:balance;overflow-wrap:break-word}
main h3,main h4{text-align:start;line-height:1.35;font-weight:600;margin:2.2em 0 .8em;break-after:avoid}
main h3{font-size:1.25em}
main h4{font-size:1.08em;color:var(--muted)}
main p{margin:0;overflow-wrap:break-word}
.chapter>p{text-align:justify;text-justify:inter-word;text-align-last:start;-webkit-hyphens:manual;hyphens:manual}
:root[data-align=start] .chapter>p{text-align:start}
.chapter>p+p{text-indent:1.5em}
.who{font:700 .74em/1 var(--label-font);letter-spacing:.07em;text-transform:uppercase;
color:var(--who);margin-inline-end:.1em}
.who-0{--who:var(--who-0)}.who-1{--who:var(--who-1)}.who-2{--who:var(--who-2)}.who-3{--who:var(--who-3)}
.who-4{--who:var(--who-4)}.who-5{--who:var(--who-5)}.who-6{--who:var(--who-6)}.who-7{--who:var(--who-7)}
.ph{border-radius:.2em;-webkit-box-decoration-break:clone;box-decoration-break:clone;transition:background-color .2s}
.ph.on{background:var(--phrase)}
.w{cursor:pointer}
.w:hover{text-decoration:underline dotted;text-underline-offset:.22em}
.w.on{color:var(--word);text-decoration:underline;text-decoration-color:var(--accent);
text-decoration-thickness:.09em;text-underline-offset:.22em}
.pill{position:fixed;z-index:25;left:50%;bottom:calc(var(--player-h) + .9rem);transform:translateX(-50%);
padding:.55rem 1rem;border:0;border-radius:999px;background:var(--accent);color:var(--on-accent);font-size:.9rem;
font-weight:600;box-shadow:0 6px 20px var(--shadow);cursor:pointer}
.player{position:fixed;left:0;right:0;bottom:0;z-index:20;background:var(--card);border-top:1px solid var(--line);
box-shadow:0 -6px 24px var(--shadow);padding:.5rem 1rem calc(.6rem + env(safe-area-inset-bottom))}
.seek-row,.controls{display:flex;align-items:center;gap:.75rem;max-width:76rem;margin:0 auto}
.seek{position:relative;flex:1;min-width:6rem;height:1.75rem;display:flex;align-items:center}
#seek{position:relative;z-index:1;width:100%;margin:0;accent-color:var(--accent);background:transparent}
#ticks{position:absolute;inset-inline:.5rem;top:50%;height:.8rem;transform:translateY(-50%);pointer-events:none}
#ticks span{position:absolute;top:0;width:2px;height:100%;margin-inline-start:-1px;border-radius:1px;background:var(--muted);opacity:.55}
#time{font-variant-numeric:tabular-nums;color:var(--muted);font-size:.85rem;white-space:nowrap}
.now{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9rem;font-weight:600}
.buttons{display:flex;align-items:center;gap:.15rem}
#play{width:3rem;height:3rem;border-radius:50%;background:var(--accent);color:var(--on-accent);margin:0 .25rem}
#play:not(.playing) .i-pause,#play.playing .i-play{display:none}
#play:hover{background:var(--accent);filter:brightness(1.08)}
.extras{flex:1 1 0;display:flex;justify-content:flex-end;align-items:center;gap:.5rem;position:relative}
.extras label{font-size:.85rem;color:var(--muted);display:flex;gap:.4rem;align-items:center}
.extras select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.45rem;padding:.2rem .35rem}
#keys{bottom:calc(100% + .5rem);inset-inline-end:0;width:min(18rem,calc(100vw - 2rem))}
#keys p{margin:0 0 .5rem;line-height:1.45}
#keys p:last-child{margin:0}
@media (max-width:60rem){
.shell{grid-template-columns:minmax(0,1fr);padding:0 1.1rem}
.toc{position:fixed;z-index:40;top:0;bottom:0;inset-inline-start:0;width:min(21rem,86vw);max-height:none;
align-self:stretch;
padding:1rem;background:var(--card);border-inline-end:1px solid var(--line);box-shadow:0 0 40px var(--shadow);
transform:translateX(-105%);visibility:hidden;transition:transform .25s ease,visibility .25s}
[dir=rtl] .toc{transform:translateX(105%)}
.toc.open{transform:none;visibility:visible}
main{padding-top:1.5rem;font-size:calc(var(--base-phone) * var(--scale))}
.cover{flex-direction:column;align-items:flex-start;gap:1rem;margin-bottom:2rem;padding-bottom:1.75rem}
.cover img{width:7rem}
.cover h1{font-size:1.75em}
}
/* Wide (a tablet turned too): the contents are the sidebar, never a drawer. */
@media (min-width:60.01rem){.only-narrow,.scrim{display:none!important}}
@media (max-width:36rem){
.controls{flex-wrap:wrap;gap:.1rem .5rem}
.now{order:-2}
.extras{order:-1;flex:none}
.controls .buttons{flex-basis:100%;justify-content:center}
.opener h2{font-size:1.5em}
.extras label span{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
"""

#: The slideshow: the picture of the moment (two layers, so one fades into the
#: next) with a slow zoom, and the sentence being read, large, each word
#: filled as it is heard. Its shadow is a filter on the whole caption: a
#: text-shadow would paint over a word's fill (background-clip:text).
_STAGE_CSS = """
.stage{position:fixed;left:0;right:0;top:var(--bar-h,3.5rem);bottom:var(--player-h,6rem);z-index:15;
overflow:hidden;color:#fff;background:radial-gradient(120% 90% at 50% 35%,#272b38 0,#0e0f14 70%)}
.stage[hidden]{display:none}
body.show .shell,body.show .pill,body.show .hero{display:none!important}
.stage-layer{position:absolute;inset:0;opacity:0;transition:opacity .8s ease}
.stage-layer.on{opacity:1}
.stage-layer.empty{display:none}
.stage-layer img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.stage-bg{opacity:0;filter:blur(28px) brightness(.55);transform:scale(1.12)}
.stage-layer.whole .stage-bg{opacity:1}
.stage-layer.whole .stage-fg{object-fit:contain}
.stage-layer.on .stage-fg{animation:stage-in var(--kb,20s) ease-out both}
.stage-layer.out.on .stage-fg{animation-name:stage-out}
@keyframes stage-in{from{transform:scale(1)}to{transform:scale(1.06)}}
@keyframes stage-out{from{transform:scale(1.06)}to{transform:scale(1)}}
body:not(.playing) .stage-fg,body:not(.playing) .stage-caption .sw.on{animation-play-state:paused}
.stage-shade{position:absolute;left:0;right:0;bottom:0;height:52%;pointer-events:none;
background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.62))}
.stage-caption{position:absolute;left:6%;right:6%;bottom:7%;margin:0;text-align:center;
font-family:var(--body-font);font-weight:600;font-size:clamp(1.15rem,3.1vw,2.5rem);line-height:1.35;
color:#fff;filter:drop-shadow(0 2px 6px rgba(0,0,0,.75));text-wrap:balance}
.stage-caption .sw.done{color:#ffd25a}
.stage-caption .sw.on{color:transparent;
background:linear-gradient(90deg,#ffd25a 50%,#fff 50%) 100% 0/200% 100% no-repeat;
-webkit-background-clip:text;background-clip:text;animation:stage-word var(--d,.4s) linear forwards}
@keyframes stage-word{to{background-position:0 0}}
.stage-full{position:absolute;top:.75rem;inset-inline-end:.75rem;color:#fff;background:rgba(0,0,0,.35);
border-radius:999px}
.stage:fullscreen{top:0;bottom:0}
#view-toggle[aria-pressed=true]{color:var(--accent)}
@media (prefers-reduced-motion:reduce){.stage-layer{transition:none}
.stage-layer.on .stage-fg,.stage-caption .sw.on{animation:none}
.stage-caption .sw.on{color:#ffd25a;background:none}}
"""

_PRINT_CSS = """
@page{margin:2cm}
body{background:#fff;color:#000;padding:0}
.bar,.player,.toc,.pill,.scrim,.note,#settings,#keys,.cover-play,.stage{display:none!important}
body.show .shell{display:block!important}
.shell{display:block;max-width:none;padding:0}
main{max-width:none;padding:0;margin:0;font-size:11.5pt;line-height:1.55;background:none;box-shadow:none}
.cover{break-after:page;border:0}
main section{break-before:page;margin:0}
.opener,main h3,main h4{break-after:avoid}
main p{orphans:3;widows:3}
.ph.on{background:none;box-shadow:none}
.w.on{color:inherit;text-decoration:none;background:none;box-shadow:none}
.opener .label,main p.lead::first-letter{color:#000}
.opener .label{background:none}
"""

_JS = r"""
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('book-data').textContent);
  var L = data.labels;
  var root = document.documentElement;
  var body = document.body;
  function byId(id) { return document.getElementById(id); }
  var audio = byId('audio');
  var playButton = byId('play');
  var seekBar = byId('seek');
  var ticks = byId('ticks');
  var timeText = byId('time');
  var nowTitle = byId('now');
  var main = byId('text');
  var toc = byId('toc');
  var tocPanel = byId('toc-panel');
  var bookLang = main.getAttribute('lang') || '';
  var tocToggle = byId('toc-toggle');
  var scrim = byId('scrim');
  var bar = byId('bar');
  var player = byId('player');
  var pill = byId('back-to-current');
  var WS = /\s+/;
  var LETTER;
  try { LETTER = new RegExp('[\\p{L}\\p{M}\\p{N}]', 'gu'); } catch (e) { LETTER = /[A-Za-z0-9]/g; }
  var words = [];
  var phraseEls = [];
  var chapters = [];

  // ---- Reading settings: kept in this browser only. The theme and the
  // alignment are the book's own until the reader picks one.
  var STORE = 'voicestudio-book-reader';
  var SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
  var prefs = { scale: 2, theme: null, align: null, follow: true, view: null };
  try {
    var saved = JSON.parse(window.localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object') {
      if (typeof saved.scale === 'number' && SCALES[saved.scale] !== undefined) prefs.scale = saved.scale;
      if (/^(auto|light|sepia|dark)$/.test(saved.theme)) prefs.theme = saved.theme;
      if (saved.align === 'justify' || saved.align === 'start') prefs.align = saved.align;
      if (typeof saved.follow === 'boolean') prefs.follow = saved.follow;
      if (saved.view === 'read' || saved.view === 'show') prefs.view = saved.view;
    }
  } catch (e) { /* storage off: defaults */ }
  function savePrefs() {
    try { window.localStorage.setItem(STORE, JSON.stringify(prefs)); } catch (e) { /* not kept */ }
  }
  // The reader's pick, else the book's own.
  function chosen(key) { return prefs[key] || data[key]; }
  var fontDown = byId('font-down');
  var fontUp = byId('font-up');
  var fontSize = byId('font-size');
  var followBox = byId('follow');
  var choices = Array.prototype.slice.call(document.querySelectorAll('[data-pref]'));
  function applyPrefs() {
    root.style.setProperty('--scale', String(SCALES[prefs.scale]));
    var theme = chosen('theme');
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    root.setAttribute('data-align', chosen('align'));
    body.classList.toggle('show', chosen('view') === 'show');
    fontSize.textContent = Math.round(SCALES[prefs.scale] * 100) + '%';
    fontDown.disabled = prefs.scale === 0;
    fontUp.disabled = prefs.scale === SCALES.length - 1;
    followBox.checked = prefs.follow;
    choices.forEach(function (button) {
      button.setAttribute('aria-pressed', String(chosen(button.dataset.pref) === button.dataset.value));
    });
  }
  function setPref(key, value) { prefs[key] = value; applyPrefs(); savePrefs(); }
  fontDown.addEventListener('click', function () { setPref('scale', Math.max(0, prefs.scale - 1)); });
  fontUp.addEventListener('click', function () { setPref('scale', Math.min(SCALES.length - 1, prefs.scale + 1)); });
  followBox.addEventListener('change', function () {
    setPref('follow', followBox.checked);
    if (followBox.checked) { suspended = false; reveal(false); }
    updatePill();
  });
  choices.forEach(function (button) {
    button.addEventListener('click', function () { setPref(button.dataset.pref, button.dataset.value); });
  });
  applyPrefs();

  // ---- The text: each phrase the page sets, its words timed in turn.
  function tokens(text) { return String(text || '').trim().split(WS).filter(Boolean); }
  // Words of a phrase over [start, end]: by their letters, or evenly when
  // only the chapter is timed (the app's reader does the same).
  function timeWords(list, start, end, even) {
    var weights = list.map(function (w) { var m = w.match(LETTER); return m ? m.length : 0; });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    if (even || !total) { weights = list.map(function () { return 1; }); total = list.length; }
    var per = Math.max(0, end - start) / (total || 1);
    var at = 0;
    return list.map(function (w, i) {
      var item = { text: w, start: start + at * per };
      at += weights[i];
      return item;
    });
  }
  function clock(t) {
    t = Math.max(0, Math.floor(t || 0));
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    var mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  var sections = Array.prototype.slice.call(main.querySelectorAll('section.chapter'));
  var tocButtons = Array.prototype.slice.call(toc.children).map(function (item) {
    return item.querySelector('button');
  });
  sections.forEach(function (section, c) {
    var even = section.hasAttribute('data-even');
    Array.prototype.forEach.call(section.querySelectorAll('.ph'), function (span) {
      var index = phraseEls.length;
      phraseEls.push(span);
      var list = tokens(span.textContent);
      span.textContent = '';
      timeWords(list, Number(span.getAttribute('data-s')), Number(span.getAttribute('data-e')), even)
        .forEach(function (w, k) {
          if (k) span.appendChild(document.createTextNode(' '));
          var word = el('span', 'w', w.text);
          word.dataset.i = String(words.length);
          words.push({ start: w.start, el: word, phrase: index });
          span.appendChild(word);
        });
    });
    chapters.push({ start: Number(section.getAttribute('data-start')) || 0, el: tocButtons[c],
      section: section, title: section.getAttribute('data-title') || '',
      appTitle: section.hasAttribute('data-app-title') });
  });

  // ---- Playback.
  function total() {
    return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (data.duration || 0);
  }
  function play() {
    var started = audio.play();
    if (started && started.catch) started.catch(function () {});
  }
  function toggle() { if (audio.paused) play(); else audio.pause(); }
  function jump(t) {
    audio.currentTime = Math.max(0, t);
    suspended = false;
    if (audio.paused) play();
  }
  // Move to `t` and show `target` (a chapter or section) or the phrase there.
  function seekTo(t, target) {
    audio.currentTime = Math.max(0, t);
    suspended = false;
    paint();
    if (target) scrollToEl(target, 0);
    else reveal(true);
  }
  function chapterAt(t) { return find(chapters, t); }
  function previousChapter() {
    var t = audio.currentTime;
    var i = chapterAt(t);
    if (i < 0) return seekTo(0);
    if (t - chapters[i].start > 3 || i === 0) return seekTo(chapters[i].start, chapters[i].section);
    seekTo(chapters[i - 1].start, chapters[i - 1].section);
  }
  function nextChapter() {
    var i = chapterAt(audio.currentTime);
    if (i + 1 < chapters.length) seekTo(chapters[i + 1].start, chapters[i + 1].section);
  }
  function drawTicks() {
    var length = total();
    ticks.textContent = '';
    if (!length) return;
    chapters.forEach(function (chapter, i) {
      if (!i || chapter.start <= 0 || chapter.start >= length) return;
      var tick = el('span');
      tick.style.insetInlineStart = (100 * chapter.start / length) + '%';
      ticks.appendChild(tick);
    });
  }

  // ---- Following the voice.
  var suspended = false;
  function band() {
    var top = bar.offsetHeight;
    var bottom = window.innerHeight - player.offsetHeight;
    return { top: top, bottom: bottom, height: Math.max(1, bottom - top) };
  }
  function motion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  }
  function scrollToEl(node, share) {
    var view = band();
    var box = node.getBoundingClientRect();
    window.scrollTo({ top: window.pageYOffset + box.top - view.top - view.height * share, behavior: motion() });
  }
  // Keep the phrase being read in the upper third of the page.
  function reveal(force) {
    if (currentPhrase < 0) return;
    var node = phraseEls[currentPhrase];
    var view = band();
    var box = node.getBoundingClientRect();
    if (force || box.top < view.top + 8 || box.top > view.top + view.height * 0.5) scrollToEl(node, 0.2);
  }
  function follow() {
    if (!prefs.follow || suspended || audio.paused) return;
    reveal(false);
  }
  function offscreen(node) {
    var view = band();
    var box = node.getBoundingClientRect();
    return box.bottom < view.top || box.top > view.bottom;
  }
  function updatePill() {
    var show = currentPhrase >= 0 && !audio.paused && (suspended || !prefs.follow) &&
      offscreen(phraseEls[currentPhrase]);
    pill.hidden = !show;
  }
  function userScrolled() {
    if (audio.paused || !prefs.follow) return;
    suspended = true;
    updatePill();
  }
  // What scrolls (or takes the keys) on its own, not the page: the contents
  // panel, a menu, and for the keys a field such as the speed list.
  function ownScroll(target, keys) {
    if (!target || target.nodeType !== 1) return false;
    return tocPanel.contains(target) || !!target.closest('.menu') ||
      (keys && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
  }
  window.addEventListener('wheel', function (event) {
    if (!ownScroll(event.target, false)) userScrolled();
  }, { passive: true });
  window.addEventListener('touchmove', function (event) {
    if (!ownScroll(event.target, false)) userScrolled();
  }, { passive: true });
  window.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || ownScroll(event.target, true)) return;
    if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End)$/.test(event.key)) userScrolled();
  });
  var pillFrame = 0;
  window.addEventListener('scroll', function () {
    if (pillFrame) return;
    pillFrame = requestAnimationFrame(function () { pillFrame = 0; updatePill(); });
  }, { passive: true });
  pill.addEventListener('click', function () { suspended = false; reveal(true); pill.hidden = true; });

  var current = -1;
  var currentPhrase = -1;
  var currentChapter = -1;
  var shownSecond = -1;
  var shownSeek = -1;
  function find(list, t) {
    if (!list.length || !(t >= list[0].start)) return -1;
    var lo = 0, hi = list.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (list[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function showChapterInContents(button) {
    // Skipped only where the contents are not drawn: the phone drawer is
    // fixed (so it has no offsetParent) but drawn, open or not.
    if (!button || !tocPanel.getClientRects().length || body.classList.contains('no-toc')) return;
    var top = button.getBoundingClientRect().top - tocPanel.getBoundingClientRect().top +
      tocPanel.scrollTop;
    if (top < tocPanel.scrollTop || top + button.offsetHeight > tocPanel.scrollTop + tocPanel.clientHeight) {
      tocPanel.scrollTop = Math.max(0, top - tocPanel.clientHeight / 3);
    }
  }
  function paint() {
    var t = audio.currentTime;
    var index = find(words, t);
    if (index !== current) {
      if (current >= 0) words[current].el.classList.remove('on');
      current = index;
      if (index >= 0) words[index].el.classList.add('on');
    }
    var phrase = index >= 0 ? words[index].phrase : -1;
    if (phrase !== currentPhrase) {
      if (currentPhrase >= 0) phraseEls[currentPhrase].classList.remove('on');
      currentPhrase = phrase;
      if (phrase >= 0) { phraseEls[phrase].classList.add('on'); follow(); }
      updatePill();
    }
    var chapter = find(chapters, t);
    if (chapter !== currentChapter) {
      if (currentChapter >= 0 && chapters[currentChapter].el) chapters[currentChapter].el.removeAttribute('aria-current');
      currentChapter = chapter;
      var shown = chapters[Math.max(0, chapter)];
      nowTitle.textContent = shown ? shown.title : '';
      nowTitle.lang = shown && shown.appTitle ? root.lang : bookLang;
      nowTitle.dir = shown && shown.appTitle ? (root.dir || 'ltr') : 'auto';
      if (chapter >= 0 && chapters[chapter].el) {
        chapters[chapter].el.setAttribute('aria-current', 'true');
        showChapterInContents(chapters[chapter].el);
      }
    }
    var length = total();
    // The seek bar moves on by a visible step, the clock by a second.
    if (!seeking && Math.abs(t - shownSeek) >= Math.max(0.25, length / 1000)) {
      shownSeek = t;
      seekBar.value = String(t);
    }
    var second = Math.floor(t);
    if (second !== shownSecond) {
      shownSecond = second;
      var time = clock(t) + ' / ' + clock(length);
      timeText.textContent = time;
      seekBar.setAttribute('aria-valuetext', time);
    }
    if (stage && showing()) paintStage(t, index);
  }
  var frame = 0;
  function loop() { paint(); frame = audio.paused ? 0 : requestAnimationFrame(loop); }
  var playLabels = Array.prototype.slice.call(document.querySelectorAll('[data-play] .label'));
  function setPlaying(playing) {
    playButton.setAttribute('aria-label', playing ? L.pause : L.play);
    playButton.title = playing ? L.pause : L.play;
    playButton.classList.toggle('playing', playing);
    playLabels.forEach(function (label) { label.textContent = playing ? L.pause : L.play; });
    body.classList.toggle('playing', playing);
  }
  audio.addEventListener('play', function () {
    setPlaying(true);
    suspended = false;
    if (!frame) frame = requestAnimationFrame(loop);
  });
  audio.addEventListener('pause', function () { setPlaying(false); paint(); updatePill(); });
  audio.addEventListener('timeupdate', function () { if (!frame) paint(); });
  audio.addEventListener('loadedmetadata', function () {
    seekBar.max = String(total());
    shownSecond = -1;
    drawTicks();
    paint();
  });
  var seeking = false;
  seekBar.max = String(total());
  seekBar.addEventListener('input', function () {
    seeking = true;
    audio.currentTime = Number(seekBar.value);
    shownSeek = audio.currentTime;
    paint();
  });
  seekBar.addEventListener('change', function () { seeking = false; suspended = false; reveal(false); });
  playButton.addEventListener('click', toggle);
  Array.prototype.forEach.call(document.querySelectorAll('[data-play]'), function (button) {
    button.addEventListener('click', toggle);
  });
  byId('back').addEventListener('click', function () { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  byId('forward').addEventListener('click', function () { audio.currentTime = audio.currentTime + 10; });
  byId('prev-chapter').addEventListener('click', previousChapter);
  byId('next-chapter').addEventListener('click', nextChapter);
  byId('speed').addEventListener('change', function (event) { audio.playbackRate = Number(event.target.value) || 1; });
  main.addEventListener('click', function (event) {
    var selection = window.getSelection && window.getSelection();
    if (selection && !selection.isCollapsed) return;
    var target = event.target;
    if (target && target.dataset && target.dataset.i !== undefined) jump(words[Number(target.dataset.i)].start);
  });
  // A chapter or section in the contents: its time, and where it is set.
  toc.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('button[data-seek]');
    if (!button) return;
    seekTo(Number(button.getAttribute('data-seek')) || 0, byId(button.getAttribute('data-target')));
    closeDrawer();
  });

  // ---- Menus and the contents drawer.
  var openMenu = null;
  function setMenu(menu, button, open) {
    if (open && openMenu && openMenu.menu !== menu) setMenu(openMenu.menu, openMenu.button, false);
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      openMenu = { menu: menu, button: button };
      var first = menu.querySelector('button:not(:disabled), input, select');
      if (first) first.focus({ preventScroll: true });
    } else if (openMenu && openMenu.menu === menu) {
      openMenu = null;
    }
  }
  [['settings', 'settings-toggle'], ['keys', 'keys-toggle']].forEach(function (pair) {
    var menu = byId(pair[0]);
    var button = byId(pair[1]);
    button.addEventListener('click', function () { setMenu(menu, button, menu.hidden); });
  });
  document.addEventListener('click', function (event) {
    if (openMenu && !openMenu.menu.contains(event.target) && !openMenu.button.contains(event.target)) {
      setMenu(openMenu.menu, openMenu.button, false);
    }
  });
  function setDrawer(open) {
    tocPanel.classList.toggle('open', open);
    scrim.hidden = !open;
    tocToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      var currentEntry = toc.querySelector('[aria-current=true]');
      // The chapter being read is in view in the drawer, not only focused.
      if (currentEntry) showChapterInContents(currentEntry);
      var focus = currentEntry || toc.querySelector('button');
      if (focus) focus.focus({ preventScroll: true });
    }
  }
  function closeDrawer() {
    if (!tocPanel.classList.contains('open')) return;
    setDrawer(false);
    tocToggle.focus({ preventScroll: true });
  }
  tocToggle.addEventListener('click', function () { setDrawer(!tocPanel.classList.contains('open')); });
  byId('toc-close').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  // Wide again (a tablet turned): the contents are the sidebar, so an open
  // drawer closes; its scrim and expanded toggle would stay behind.
  var wideQuery = window.matchMedia ? window.matchMedia('(min-width:60.01rem)') : null;
  function leaveDrawer() {
    if (wideQuery.matches && tocPanel.classList.contains('open')) setDrawer(false);
  }
  if (wideQuery && wideQuery.addEventListener) wideQuery.addEventListener('change', leaveDrawer);
  else if (wideQuery && wideQuery.addListener) wideQuery.addListener(leaveDrawer);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (openMenu) {
        var button = openMenu.button;
        setMenu(openMenu.menu, button, false);
        button.focus({ preventScroll: true });
      } else {
        closeDrawer();
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    var tag = (event.target && event.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag)) return;
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      toggle();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      var back = event.key === 'ArrowLeft';
      if (event.shiftKey) {
        if (back) previousChapter(); else nextChapter();
      } else {
        audio.currentTime = Math.max(0, audio.currentTime + (back ? -5 : 5));
      }
    }
  });

  // ---- Slideshow: the picture of the moment and the sentence being read,
  // large, each word filled as it is heard. Pictures change where the
  // book's [image:] tags stand; before the first, the cover (or the plain stage).
  var stage = byId('stage');
  var stageCaption = byId('stage-caption');
  var viewToggle = byId('view-toggle');
  var stageFull = byId('stage-full');
  var layers = Array.prototype.slice.call(stage.querySelectorAll('.stage-layer'));
  var slides = (data.slides || []).filter(function (s) { return s && typeof s.start === 'number'; });
  var slideAt = -2;
  var layerOn = 0;
  var captionFrom = -1;
  var captionTo = -1;
  var captionWord = -2;
  var captionSpans = [];
  var CAPTION_CHARS = 90;
  function showing() { return body.classList.contains('show'); }
  function refreshStage() {
    stage.hidden = !showing();
    viewToggle.setAttribute('aria-pressed', String(showing()));
    slideAt = -2;
    captionFrom = captionTo = -1;
    captionWord = -2;
    paint();
  }
  // A picture fills the stage when the two are about the same shape, else
  // shows whole on a blurred copy of itself (as the video does).
  function fitPicture(layer) {
    var front = layer.querySelector('.stage-fg');
    function decide() {
      var fit = layer.dataset.fit;
      if (fit === 'auto') {
        var shape = (front.naturalWidth / Math.max(1, front.naturalHeight)) /
          (stage.clientWidth / Math.max(1, stage.clientHeight));
        fit = shape >= 1 / 1.3 && shape <= 1.3 ? 'cover' : 'contain';
      }
      layer.classList.toggle('whole', fit === 'contain');
    }
    if (front.complete && front.naturalWidth) decide(); else front.onload = decide;
  }
  function showSlide(s) {
    var slide = s >= 0 ? slides[s] : null;
    var src = slide && slide.src ? slide.src : (data.cover || '');
    var next = layers[1 - layerOn];
    Array.prototype.forEach.call(next.querySelectorAll('img'), function (img) {
      if (src) img.src = src; else img.removeAttribute('src');
    });
    next.classList.toggle('empty', !src);
    next.classList.toggle('out', s % 2 === 1);
    next.dataset.fit = slide ? slide.fit : 'auto';
    var until = s + 1 < slides.length ? slides[s + 1].start : total();
    var span = until - (slide ? slide.start : 0);
    next.style.setProperty('--kb', Math.max(6, Math.min(30, span || 20)) + 's');
    if (src) fitPicture(next);
    next.classList.remove('on');
    void next.offsetWidth;
    next.classList.add('on');
    layers[layerOn].classList.remove('on');
    layerOn = 1 - layerOn;
  }
  function wordEnd(i) {
    var after = words[i + 1];
    if (after && after.phrase === words[i].phrase) return after.start;
    return Number(phraseEls[words[i].phrase].getAttribute('data-e')) || words[i].start;
  }
  // The words of the caption holding word `index`: its sentence, cut into
  // pieces of about CAPTION_CHARS characters.
  function captionRange(index) {
    var phrase = words[index].phrase;
    var a = index, b = index;
    while (a > 0 && words[a - 1].phrase === phrase) a--;
    while (b + 1 < words.length && words[b + 1].phrase === phrase) b++;
    var from = a, size = 0;
    for (var i = a; i <= b; i++) {
      var add = words[i].el.textContent.length + (i > from ? 1 : 0);
      if (i > from && size + add > CAPTION_CHARS) {
        if (index < i) return [from, i - 1];
        from = i;
        size = 0;
        add = words[i].el.textContent.length;
      }
      size += add;
    }
    return [from, b];
  }
  function buildCaption(index) {
    var range = captionRange(index);
    captionFrom = range[0];
    captionTo = range[1];
    captionSpans = [];
    stageCaption.textContent = '';
    for (var i = captionFrom; i <= captionTo; i++) {
      if (i > captionFrom) stageCaption.appendChild(document.createTextNode(' '));
      var span = el('span', 'sw', words[i].el.textContent);
      stageCaption.appendChild(span);
      captionSpans.push(span);
    }
    captionWord = -2;
  }
  function markCaption(index) {
    captionWord = index;
    var rate = audio.playbackRate || 1;
    captionSpans.forEach(function (span, k) {
      var i = captionFrom + k;
      span.classList.toggle('done', i < index);
      if (i === index) {
        span.style.setProperty('--d', Math.max(0.05, (wordEnd(i) - words[i].start) / rate) + 's');
        span.classList.remove('on');
        void span.offsetWidth;
      }
      span.classList.toggle('on', i === index);
    });
  }
  function paintStage(t, index) {
    var s = find(slides, t);
    if (s !== slideAt) { slideAt = s; showSlide(s); }
    if (index < 0) {
      if (captionFrom !== -1) { stageCaption.textContent = ''; captionSpans = []; }
      captionFrom = captionTo = -1;
      captionWord = -2;
      return;
    }
    if (index < captionFrom || index > captionTo) buildCaption(index);
    if (index !== captionWord) markCaption(index);
  }
  viewToggle.addEventListener('click', function () {
    setPref('view', showing() ? 'read' : 'show');
    refreshStage();
  });
  if (stage.requestFullscreen) {
    stageFull.addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen();
    });
  } else {
    stageFull.hidden = true;
  }
  stage.hidden = !showing();
  viewToggle.setAttribute('aria-pressed', String(showing()));

  // The title shows in the top bar once the title block has scrolled away.
  var h1 = byId('book-title');
  if (h1 && window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      bar.classList.toggle('titled', !entries[0].isIntersecting);
    }, { rootMargin: '-48px 0px 0px 0px' }).observe(h1);
  } else {
    bar.classList.add('titled');
  }
  function measure() {
    root.style.setProperty('--bar-h', bar.offsetHeight + 'px');
    root.style.setProperty('--player-h', player.offsetHeight + 'px');
  }
  window.addEventListener('resize', measure);
  measure();
  drawTicks();
  setPlaying(false);
  paint();
})();
"""

_ICONS = {
    "back": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
    "forward": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/></svg>',
    "play": '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    "pause": '<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    "prev": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
    "next": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
    "menu": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>',
    "close": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/></svg>',
    "slides": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v9.6l3.5-3.5 2.5 2.5 4-4 4 4V6zm3.5 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
    "expand": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
}

_ROMAN = ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
          (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"))


def _roman(number: int) -> str:
    out = ""
    for value, letters in _ROMAN:
        while number >= value:
            out += letters
            number -= value
    return out


def _capital(text: str) -> bool:
    """Whether ``text`` starts (past any quote or bracket) with a capital."""
    letter = next((c for c in text if c.isalnum()), "")
    return letter.isupper()


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _seconds(value) -> str:
    """A time for a ``data-*`` attribute: seconds, to the millisecond."""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        number = 0.0
    return f"{max(0.0, number):.3f}".rstrip("0").rstrip(".")


def _clock(seconds: float) -> str:
    total = max(0, int(seconds or 0))
    h, m, s = total // 3600, total % 3600 // 60, total % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _number_label(chapter: dict, labels: dict, numbering: str) -> str:
    """The chapter-number label above a title in the design's numbering,
    unless the title already says it ("Chapter 3: …" under "Chapter 3")."""
    if chapter.get("headless") or chapter.get("untitled") or chapter.get("number") is None \
            or numbering == "none":
        return ""
    lead = _squash(labels["chapter_n"].split("{n}")[0]).lower()
    if lead and _squash(chapter["title"]).lower().startswith(lead):
        return ""
    number = int(chapter["number"])
    if numbering == "numeral":
        return str(number)
    if numbering == "roman":
        return _roman(number)
    return labels["chapter_n"].replace("{n}", str(number))


def _toc_number(chapter: dict, label: str, numbering: str) -> Optional[str]:
    if not label:
        return None
    return _roman(int(chapter["number"])) if numbering == "roman" else str(chapter["number"])


class _Chapter:
    """One chapter of the page: its section and its entry in the contents."""

    def __init__(self, chapter: dict, index: int, *, design, labels: dict, people: list,
                 app_attrs: str, preview_on: bool):
        self.chapter = chapter
        self.index = index
        self.design = design
        self.template = design.template
        self.labels = labels
        self.people = people
        self.app_attrs = app_attrs
        self.preview_on = preview_on
        self.blocks: list = []      # [kind, html, first phrase text]
        self.subs: list = []        # contents entries of its sections
        self.paragraph: Optional[dict] = None
        # Who says the phrase set last (None: narration, or not known yet).
        self.speaking: Optional[int] = None
        # A standfirst was just set: the paragraph after it opens with an initial.
        self.initial = False

    def phrase(self, phrase: dict) -> str:
        cls = "ph on" if self.preview_on else "ph"
        self.preview_on = False
        return (f'<span class="{cls}" data-s="{_seconds(phrase["start"])}" '
                f'data-e="{_seconds(phrase["end"])}">{html.escape(phrase["text"])}</span>')

    def close(self) -> None:
        paragraph, self.paragraph = self.paragraph, None
        if not paragraph:
            return
        inner = ""
        for part in paragraph["parts"]:
            inner += part if part == "<br>" or not inner or inner.endswith("<br>") else " " + part
        who = paragraph["who"]
        if paragraph["label"]:
            person = self.people[who]
            self.blocks.append(["turn", (
                f'<p class="turn who-{person["color"]}"><b class="who">'
                f'{html.escape(person["name"])}</b> <span class="said">{inner}</span></p>'),
                paragraph["first"]])
        else:
            cls = f' class="{paragraph["cls"]}"' if paragraph["cls"] else ""
            self.blocks.append(["p", f"<p{cls}>{inner}</p>", paragraph["first"]])

    def open(self, who: Optional[int], cls: str, first: str) -> None:
        self.close()
        named = self.design.show_names and who is not None
        label = named and (self.template.turns or who != self.speaking)
        self.speaking = who
        if self.initial and not cls and not label and _capital(first):
            cls = "initial"
        self.initial = cls == "standfirst"
        self.paragraph = {"who": who, "label": label, "parts": [], "first": first,
                          "cls": "" if label else cls}

    def name(self, who: int) -> str:
        """``who``'s name where the voice changes inside a paragraph."""
        person = self.people[who]
        return f'<b class="who who-{person["color"]}">{html.escape(person["name"])}</b>'

    def build(self) -> tuple:
        chapter, index, labels = self.chapter, self.index, self.labels
        esc = html.escape
        number_label = _number_label(chapter, labels, self.design.numbering)
        app = chapter.get("app_title")
        title = esc(chapter["title"])
        head = ""
        if not chapter.get("headless"):
            label_html = (f'<p class="label"{self.app_attrs}>{esc(number_label)}</p>'
                          if number_label else "")
            head = (f'<header class="opener">{label_html}'
                    f'<h2{self.app_attrs if app else ""}>{title}</h2></header>')
        phrases = chapter["phrases"]
        marks = sorted(chapter.get("sections") or [], key=lambda s: s.get("phrase", 0))
        lead = True
        standfirst = (self.template.standfirst and len(phrases) > 1
                      and len(phrases[0]["text"]) <= _STANDFIRST_MAX)
        m = i = 0
        while i < len(phrases):
            if m < len(marks) and marks[m].get("phrase", 0) <= i:
                mark = marks[m]
                m += 1
                self.close()
                # The heading is read aloud: its phrases are the heading itself.
                said, k = "", i
                while k < len(phrases) and len(_squash(said)) < len(_squash(mark["title"])):
                    said += " " + phrases[k]["text"]
                    k += 1
                tag = "h4" if mark.get("level") == 3 else "h3"
                anchor = f"s-{index + 1}-{m}"
                if _squash(said) == _squash(mark["title"]):
                    inner = " ".join(self.phrase(p) for p in phrases[i:k])
                    i = k
                else:
                    inner = esc(mark["title"])
                self.blocks.append(["h", f'<{tag} id="{anchor}">{inner}</{tag}>', ""])
                deeper = ' class="s3"' if tag == "h4" else ""
                self.subs.append(
                    f'<li><button type="button"{deeper} data-seek="{_seconds(mark.get("start"))}"'
                    f' data-target="{anchor}"><span class="t">{esc(mark["title"])}</span></button></li>')
                lead = standfirst = False
                self.speaking = None
                continue
            phrase = phrases[i]
            brk = phrase.get("break")
            who = phrase.get("who")
            if self.paragraph is None or brk == "paragraph":
                if standfirst and not (self.design.show_names and who is not None):
                    # The chapter's first phrase stands above it; its
                    # paragraph goes on below.
                    self.open(who, "standfirst", phrase["text"])
                    self.paragraph["parts"].append(self.phrase(phrase))
                    self.close()
                    standfirst = lead = False
                    i += 1
                    if i < len(phrases) and phrases[i].get("break") != "paragraph":
                        self.open(phrases[i].get("who"), "", phrases[i]["text"])
                    continue
                self.open(who, "lead" if lead else "", phrase["text"])
                lead = standfirst = False
            elif self.design.show_names and who != self.speaking and self.template.turns:
                # Another voice inside a paragraph: a turn of its own.
                self.open(who, "", phrase["text"])
            else:
                if brk == "line" and self.paragraph["parts"]:
                    self.paragraph["parts"].append("<br>")
                if self.design.show_names and who != self.speaking and who is not None:
                    self.paragraph["parts"].append(self.name(who))
            self.speaking = who
            self.paragraph["parts"].append(self.phrase(phrase))
            i += 1
        self.close()
        if self.template.pull_quotes:
            self._pull_quote()
        attrs = (f' class="chapter" id="chapter-{index + 1}" data-start="{_seconds(chapter["start"])}"'
                 f' data-title="{title}"')
        if app:
            attrs += " data-app-title"
        if chapter.get("precision") == "chapter":
            attrs += " data-even"
        section = f"<section{attrs}>{head}{''.join(b[1] for b in self.blocks)}</section>"
        number = _toc_number(chapter, number_label, self.design.numbering)
        number_html = f'<span class="num">{esc(number)}</span>' if number else ""
        length = max(0.0, float(chapter.get("end") or 0) - float(chapter.get("start") or 0))
        entry = (f'<li><button type="button" data-seek="{_seconds(chapter["start"])}" '
                 f'data-target="chapter-{index + 1}">{number_html}'
                 f'<span class="t"{self.app_attrs if app else ""}>{title}</span>'
                 f'<span class="dur">{_clock(length)}</span></button>'
                 f'{"<ol>" + "".join(self.subs) + "</ol>" if self.subs else ""}</li>')
        return section, entry, bool(self.subs), any(b[0] == "turn" for b in self.blocks)

    def _pull_quote(self) -> None:
        """A pull quote — the first sentence of a paragraph halfway into the
        chapter, set large a paragraph ahead of it; a copy, so hidden from
        screen readers."""
        paragraphs = [k for k, block in enumerate(self.blocks) if block[0] == "p"]
        if len(paragraphs) < 3:
            return
        for n in range(max(2, len(paragraphs) // 2), len(paragraphs)):
            first = sentences(_squash(self.blocks[paragraphs[n]][2]))
            text = first[0] if first else ""
            # The quote marks are the pull quote's own: not a line of dialogue.
            if _PULL_MIN <= len(text) <= _PULL_MAX and text[0] not in _QUOTES:
                self.blocks.insert(paragraphs[n - 1], [
                    "pull", '<blockquote class="pull" aria-hidden="true">'
                            f"<p>{html.escape(text)}</p></blockquote>", ""])
                return


def render_page(*, title: str, timeline: Optional[dict], audio_src: str,
                labels: Optional[dict] = None, author: str = "", narrator: str = "",
                cover_src: Optional[str] = None, lang: str = "en", direction: str = "ltr",
                book_lang: str = "", duration: float = 0.0,
                design: Optional[book_templates.Design] = None, story: bool = False,
                voice_names: Optional[dict] = None, preview: bool = False,
                images: Optional[dict] = None, view: str = "read") -> str:
    """The book's ``index.html``. Every text from the book goes through
    :func:`html.escape` or :func:`_script_json`; the script builds its words
    with ``textContent`` only.

    ``lang`` and ``direction`` are the app's, whose words the page's own
    labels are in; ``book_lang`` is the language of the book's text (its
    title, contents and chapters), ``""`` when it is not known. The book's
    text runs in its own direction (``dir="auto"``). ``design`` is the book's
    look (:func:`services.book_templates.resolve`; the default template when
    ``None``); ``story`` says the timeline is a story's, whose characters are
    named rather than its voices.

    ``preview`` is the export dialog's: no script and no audio, the first
    phrase shown as being read so the highlight's look shows.

    ``images`` maps each ``[image:]`` picture the export carries to its file
    in it; the slideshow (``view`` ``"show"``: the page opens in it) shows
    them by the book's clock, the cover before the first and after
    ``[image: none]``. A picture the export does not carry is left out (the
    one before it shows on)."""
    labels = labels_for(labels)
    design = design or book_templates.resolve(story=story)
    template = design.template
    esc = html.escape
    app_lang = esc(lang or "en")
    app_dir = "rtl" if direction == "rtl" else "ltr"
    app_attrs = f' lang="{app_lang}" dir="{app_dir}"'

    def label(key: str) -> str:
        return esc(labels[key])

    data = page_timeline(timeline, labels, book_title=title, story=story,
                         voice_names=voice_names)
    text_lang = _text_lang(book_lang)
    shown = len(data["chapters"])
    if preview:
        # The first chapter (after an opening without a heading, the one
        # after it too), cut short; the contents still list every chapter.
        shown = 2 if data["chapters"] and data["chapters"][0].get("headless") else 1
        for chapter in data["chapters"][:shown]:
            chapter["phrases"] = chapter["phrases"][:_PREVIEW_PHRASES]
            chapter["sections"] = [s for s in chapter["sections"]
                                   if s.get("phrase", 0) < _PREVIEW_PHRASES]
        for chapter in data["chapters"][shown:]:
            chapter["phrases"] = []  # listed in the contents only
    built = [_Chapter(chapter, c, design=design, labels=labels, people=data["people"],
                      app_attrs=app_attrs, preview_on=preview and c == 0).build()
             for c, chapter in enumerate(data["chapters"])]
    sections = "".join(b[0] for b in built[:shown])
    toc = "".join(b[1] for b in built)
    no_toc = len(built) < 2 and not any(b[2] for b in built)
    turns = any(b[3] for b in built[:shown])
    estimated = any(c["precision"] == "chapter" for c in data["chapters"])

    byline = ""
    if author:
        byline += f'<p class="author"{text_lang}>{esc(author)}</p>'
    if narrator:
        # "Narrated by" is the app's words, inside the book's text.
        byline += f"<p{app_attrs}>{label('narrated_by')} <bdi>{esc(narrator)}</bdi></p>"
    play_cover = ""
    if template.cover_play:
        play_cover = (f'<button type="button" class="cover-play" data-play>{_ICONS["play"]}'
                      f'<span class="label"{app_attrs}>{label("play")}</span></button>')
    cover = esc(cover_src) if cover_src else ""
    if template.hero:
        hero = (f'<header class="hero"{text_lang}>'
                + (f'<img class="hero-bg" src="{cover}" alt="">' if cover else "")
                + '<div class="hero-inner">'
                + (f'<img class="hero-poster" src="{cover}" alt="">' if cover else "")
                + f'<div class="cover-text"><h1 id="book-title">{esc(title)}</h1>{byline}{play_cover}</div>'
                + "</div></header>")
        title_block = ""
    else:
        hero = ""
        image = f'<img src="{cover}" alt="">' if cover else ""
        title_block = (f'<header class="cover">{image}<div class="cover-text">'
                       f'<h1 id="book-title">{esc(title)}</h1>{byline}{play_cover}</div></header>')
    note = f'<p class="note"{app_attrs}>{label("estimated")}</p>' if estimated else ""
    speeds = "".join(
        f'<option value="{s}"{" selected" if s == 1 else ""}>{s}×</option>' for s in SPEEDS)

    def choice(pref: str, value: str, key: str) -> str:
        return (f'<button type="button" data-pref="{pref}" data-value="{value}" '
                f'aria-pressed="false">{label(key)}</button>')

    themes = "".join(choice("theme", v, f"theme_{v}") for v in ("auto", "light", "sepia", "dark"))
    aligns = choice("align", "justify", "justify") + choice("align", "start", "align_start")
    css = (_CSS + _STAGE_CSS + book_templates.theme_css(design) + book_templates.font_css(design)
           + template.css + "@media print{" + _PRINT_CSS + book_templates.print_css(design) + "}")
    faces = "".join(book_fonts.face_css([font], italic=italic) for font, italic in design.embedded)
    page_data = {"labels": {"play": labels["play"], "pause": labels["pause"]},
                 "duration": float(duration or 0), "theme": template.theme,
                 "align": template.align, "view": "show" if view == "show" else "read"}
    if cover_src and not preview:
        page_data["cover"] = cover_src
    slides = [{"start": s["start"], "src": (images or {}).get(s["name"], "") if s["name"] else "",
               "fit": s["fit"]}
              for s in data.get("slides") or [] if not s["name"] or s["name"] in (images or {})]
    if slides:
        page_data["slides"] = slides
    theme_attr = f' data-theme="{template.theme}"' if template.theme != "auto" else ""
    classes = f"tpl-{template.id}" + (" no-toc" if no_toc else "") + (" turns" if turns else "")
    audio = (f'<audio id="audio" preload="metadata" src="{esc(audio_src)}"></audio>'
             if audio_src and not preview else '<audio id="audio" preload="none"></audio>')
    script = "" if preview else (
        f'<script type="application/json" id="book-data">{_script_json(page_data)}</script>\n'
        f"<script>{_JS}</script>\n")
    return f"""<!doctype html>
<html lang="{app_lang}" dir="{app_dir}" data-template="{template.id}"{theme_attr} data-align="{template.align}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{esc(title)}</title>
<style>{faces}{css}</style>
</head>
<body class="{classes}">
<header class="bar" id="bar">
<button type="button" class="icon only-narrow" id="toc-toggle" aria-label="{label('contents')}" title="{label('contents')}" aria-expanded="false" aria-controls="toc-panel">{_ICONS['menu']}</button>
<span class="bar-title"{text_lang}>{esc(title)}</span>
<button type="button" class="icon" id="view-toggle" aria-label="{label('slideshow')}" title="{label('slideshow')}" aria-pressed="false">{_ICONS['slides']}</button>
<button type="button" class="icon aa" id="settings-toggle" aria-label="{label('settings')}" title="{label('settings')}" aria-expanded="false" aria-controls="settings">Aa</button>
<div class="menu" id="settings" role="dialog" aria-label="{label('settings')}" hidden>
<fieldset><legend>{label('text_size')}</legend><div class="seg">
<button type="button" id="font-down" aria-label="{label('smaller')}" title="{label('smaller')}">A−</button>
<output id="font-size" aria-live="polite">100%</output>
<button type="button" id="font-up" aria-label="{label('larger')}" title="{label('larger')}">A+</button>
</div></fieldset>
<fieldset><legend>{label('theme')}</legend><div class="seg">{themes}</div></fieldset>
<fieldset><legend>{label('align')}</legend><div class="seg">{aligns}</div></fieldset>
<label class="switch"><span>{label('follow')}</span><input type="checkbox" id="follow" checked></label>
</div>
</header>
{hero}<div class="shell">
<nav class="toc" id="toc-panel" aria-labelledby="contents">
<div class="toc-head"><h2 id="contents">{label('contents')}</h2><button type="button" class="icon only-narrow" id="toc-close" aria-label="{label('close')}" title="{label('close')}">{_ICONS['close']}</button></div>
<ol id="toc"{text_lang}>{toc}</ol>
</nav>
<div class="scrim" id="scrim" hidden></div>
<main id="text"{text_lang}>
{title_block}{note}{sections}
</main>
</div>
<div class="stage" id="stage" hidden>
<div class="stage-layer"><img class="stage-bg" alt=""><img class="stage-fg" alt=""></div>
<div class="stage-layer"><img class="stage-bg" alt=""><img class="stage-fg" alt=""></div>
<div class="stage-shade"></div>
<p class="stage-caption" id="stage-caption"{text_lang}></p>
<button type="button" class="icon stage-full" id="stage-full" aria-label="{label('fullscreen')}" title="{label('fullscreen')}">{_ICONS['expand']}</button>
</div>
<button type="button" class="pill" id="back-to-current" hidden>{label('back_to_current')}</button>
<div class="player" id="player" role="region" aria-label="{label('player')}">
{audio}
<div class="seek-row">
<div class="seek"><div id="ticks" aria-hidden="true"></div><input id="seek" type="range" min="0" step="0.1" value="0" aria-label="{label('seek')}"></div>
<span id="time">0:00 / {_clock(duration)}</span>
</div>
<div class="controls">
<div class="now" id="now"{text_lang}>{esc(data["chapters"][0]["title"]) if data["chapters"] else ""}</div>
<div class="buttons">
<button type="button" class="icon" id="prev-chapter" aria-label="{label('prev_chapter')}" title="{label('prev_chapter')}">{_ICONS['prev']}</button>
<button type="button" class="icon" id="back" aria-label="{label('back')}" title="{label('back')}">{_ICONS['back']}</button>
<button type="button" class="icon" id="play" aria-label="{label('play')}">{_ICONS['play']}{_ICONS['pause']}</button>
<button type="button" class="icon" id="forward" aria-label="{label('forward')}" title="{label('forward')}">{_ICONS['forward']}</button>
<button type="button" class="icon" id="next-chapter" aria-label="{label('next_chapter')}" title="{label('next_chapter')}">{_ICONS['next']}</button>
</div>
<div class="extras">
<label><span>{label('speed')}</span> <select id="speed" aria-label="{label('speed')}">{speeds}</select></label>
<button type="button" class="icon" id="keys-toggle" aria-label="{label('shortcuts')}" title="{label('shortcuts')}" aria-expanded="false" aria-controls="keys">?</button>
<div class="menu" id="keys" role="dialog" aria-label="{label('shortcuts')}" hidden><p>{label('keys')}</p><p>{label('keys_chapter')}</p></div>
</div>
</div>
</div>
{script}</body>
</html>
"""


def _text_lang(book_lang: str) -> str:
    """The attributes of an element holding the book's own text."""
    return f' lang="{html.escape(book_lang)}" dir="auto"'


def audio_name(output: str) -> str:
    """The book's file inside the export: an ``.m4b`` travels as ``.m4a`` (the
    same MP4 audio), which every browser plays."""
    stem, ext = os.path.splitext(os.path.basename(output))
    return f"{stem}{'.mp3' if ext.lower() == '.mp3' else '.m4a'}"


def write_export_zip(zip_path: str, *, page: str, audio_path: str, audio_entry: str,
                     cover_path: Optional[str] = None,
                     cover_entry: Optional[str] = None,
                     images: Optional[list] = None) -> int:
    """Write the export atomically (a temp file, then a rename): ``index.html``
    compressed, the audio, cover and slideshow pictures (``images``:
    ``[(path, entry)]``) stored as they are. Returns its size."""
    partial = f"{zip_path}.part"
    try:
        with zipfile.ZipFile(partial, "w") as archive:
            archive.writestr("index.html", page.encode("utf-8"), zipfile.ZIP_DEFLATED)
            archive.write(audio_path, audio_entry, zipfile.ZIP_STORED)
            if cover_path and cover_entry:
                archive.write(cover_path, cover_entry, zipfile.ZIP_STORED)
            for path, entry in images or []:
                archive.write(path, entry, zipfile.ZIP_STORED)
        os.replace(partial, zip_path)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    return os.path.getsize(zip_path)
