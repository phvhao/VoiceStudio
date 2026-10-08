"""Canonical longform marker parser (#27) — the single source of grammar truth.

The longform marker dialect (``# heading``, ``[voice:NAME]``, ``[pause …]``,
``[slow]/[fast]/[emphasis]/[spell]``, ``[volume -6dB]``, ``[image: NAME]``) was parsed by three independent code
paths that disagreed (client/server/regex-level). This module is the one
canonical Python parser; ``electron/src/shared/utils/longformParser.js`` is its
mechanically-mirrored JS twin, and ``tests/fixtures/longform_parser_cases.json``
is the shared golden corpus asserted byte-for-byte against both.

Pure text→plan, import-light (no torch). Grammar precedence (outer→inner):

    # chapter  →  ## section  →  [voice:]  →  [pause]  →  SSML-lite  →  [spell]

It reuses the existing pause dialect (``omnivoice.utils.text.parse_pause_markers``)
and SSML-lite (``services.ssml_lite``) verbatim so those modules stay the single
home of their sub-grammars.
"""
from __future__ import annotations

import re
from typing import Optional

from omnivoice.utils.text import parse_pause_markers

# A Markdown H1 (``# Title``) starts a new chapter. ``##``/``###`` open a
# section inside it (``_SECTION_RE``); deeper headings stay ordinary text. The title capture starts with ``\S`` (a
# non-space) so the leading ``[ \t]+`` and the title's ``.*`` can't both match
# the same whitespace run — that overlap is what makes ``[ \t]+(.+)``
# polynomial-time on adversarial tabs (ReDoS). Moved verbatim from
# audiobook.py (already CodeQL-cleared). Stripped in code.
_HEADING_RE = re.compile(r"^[ \t]*#[ \t]+(\S.*)$", re.MULTILINE)
# ``## Title`` / ``### Title`` opens a section inside a chapter: the title is
# read aloud without its marks, as a paragraph of its own, in whatever voice
# is reading there (a section never resets the voice or starts a chapter).
# Same shape as ``_HEADING_RE``: ``#`` is not in ``[ \t]``, so no two
# quantifiers share a run. ``####``… stay ordinary text.
_SECTION_RE = re.compile(r"^[ \t]*(#{2,3})[ \t]+(\S.*)$", re.MULTILINE)
# ``[voice:NAME]`` switches the active narrator. The content class excludes BOTH
# brackets (``[^\]\[]``) so nested ``[voice:`` prefixes can't create overlapping
# match attempts across ``finditer`` (the ReDoS source). A voice name never
# contains a bracket; the value is stripped in code. Empty → default voice.
_VOICE_RE = re.compile(r"\[voice:([^\]\[]*)\]")
# A blank line (paragraph break). Linear: one ``\n``, a run of inline
# whitespace, one ``\n`` — no nested quantifiers.
_BLANK_LINE_RE = re.compile(r"\n[ \t\r]*\n")
#: Stands in, inside the whitespace between two texts, for markup the parser
#: took out there: a line holding only ``[pause]`` or ``[voice:B]`` is a line,
#: not a blank one.
LAYOUT_MARK = "\x00"
# ``[image: NAME]`` shows a picture from where it stands until the next one
# (``[image: NAME contain]``: the whole picture, not cropped to the frame;
# ``[image: NAME cover]``: always filling it; ``[image: none]``: back to the
# book's own backdrop). Display only: it is
# taken out of the text before anything else reads it (``extract_image_marks``),
# so it is never spoken and no span, join or cache key changes. The content
# excludes both brackets and line breaks: linear, like ``_VOICE_RE``.
_IMAGE_RE = re.compile(r"\[image:([^\]\[\n]*)\]", re.IGNORECASE)
#: How a picture meets the frame: ``auto`` (no word given) fills it when the
#: two are about the same shape and shows all of it otherwise, ``cover`` fills
#: it (cropping what spills over), ``contain`` shows all of it (on a blurred
#: copy of itself).
IMAGE_FITS = ("auto", "cover", "contain")
#: The name ``[image: none]`` uses: no picture of the script's from there on.
IMAGE_NONE = "none"


def _image_mark(content: str) -> dict:
    """The picture an ``[image: …]`` tag names: ``{"name", "fit"}``, the name
    lower-cased (the library's names are) and ``None`` for ``none``/empty."""
    parts = content.split()
    name = parts[0].lower() if parts else ""
    fit = parts[1].lower() if len(parts) > 1 else ""
    return {"name": None if name in ("", IMAGE_NONE) else name[:120],
            "fit": fit if fit in IMAGE_FITS else IMAGE_FITS[0]}


def extract_image_marks(text: str) -> tuple[str, list[dict]]:
    """``text`` without its ``[image:]`` tags, and each tag's mark:
    ``{"pos": where it stood in the returned text, "name", "fit"}``, in order.

    The text left is what the script would say without the tags: a tag alone
    on its line goes with its line (and one line break), one inside a line
    with one space next to it. So a script parses (spans, joins, every cache
    key) exactly as it would if the pictures were never there."""
    if "[" not in text:
        return text, []
    marks: list[dict] = []
    pos = 0
    while True:
        m = _IMAGE_RE.search(text, pos)
        if m is None:
            break
        s, e = m.start(), m.end()
        line_start = text.rfind("\n", 0, s) + 1
        line_end = text.find("\n", e)
        if line_end < 0:
            line_end = len(text)
        if not text[line_start:s].strip(" \t") and not text[e:line_end].strip(" \t"):
            if line_end < len(text):
                cut, at = (line_start, line_end + 1), line_start
            elif line_start > 0:
                cut, at = (line_start - 1, line_end), line_start - 1
            else:
                cut, at = (line_start, line_end), line_start
        else:
            if e < len(text) and text[e] in " \t":
                cut = (s, e + 1)
            elif s > 0 and text[s - 1] in " \t":
                cut = (s - 1, e)
            else:
                cut = (s, e)
            at = cut[0]
        removed = cut[1] - cut[0]
        # Only marks standing at the cut can move (the scan runs forward), and
        # they are the last ones: linear even for a line of thousands of tags.
        for mark in reversed(marks):
            if mark["pos"] <= cut[0]:
                break
            mark["pos"] = max(cut[0], mark["pos"] - removed)
        marks.append({"pos": at, **_image_mark(m.group(1))})
        text = text[:cut[0]] + text[cut[1]:]
        pos = cut[0]
    return text, marks


def _attach_image_marks(body: str, spans: list[dict], marks: list[dict]) -> list[dict]:
    """Give each of ``marks`` (``pos`` in ``body``) to the span read there:
    ``images: [{"at", "name", "fit"}]`` on it, ``at`` the character of its
    text the picture shows from (its length: from the span after it). A tag
    on a ``##`` heading's line shows with the heading. A span's text is found
    in ``body`` in order; one that is not there as written (``[spell]``
    spelled it out) is passed over. Returns the marks after every span, for
    whatever is read next."""
    located: list = []
    cursor = 0
    for span in spans:
        found = body.find(span["text"], cursor) if span["text"] else -1
        if found < 0:
            located.append(None)
            continue
        located.append((found, found + len(span["text"])))
        cursor = found + len(span["text"])
    last = max((k for k, loc in enumerate(located) if loc is not None), default=None)
    left: list[dict] = []
    k = 0  # marks come in order: one walk over the spans serves them all
    for mark in marks:
        pos, target = mark["pos"], None
        while k < len(located):
            loc = located[k]
            if loc is None or loc[1] < pos or (loc[1] == pos and "section" not in spans[k]):
                k += 1
                continue
            target = (k, 0 if loc[1] == pos else max(0, pos - loc[0]))
            break
        if target is None:
            if last is None:
                left.append(mark)
                continue
            target = (last, len(spans[last]["text"]))
        spans[target[0]].setdefault("images", []).append(
            {"at": target[1], "name": mark["name"], "fit": mark["fit"]})
    return left


def _give_carried_images(spans: list[dict], carried: list[dict]) -> list[dict]:
    """Marks left over from text with nothing spoken after them go to the
    first span that speaks, from its start; still left when there is none."""
    first = next((span for span in spans if span["text"]), None)
    if first is None or not carried:
        return carried
    first["images"] = ([{"at": 0, "name": m["name"], "fit": m["fit"]} for m in carried]
                       + first.get("images", []))
    return []


def layout_break(gap: str) -> Optional[str]:
    """How the text after ``gap`` (the whitespace before it, markup as
    :data:`LAYOUT_MARK`) starts: ``"paragraph"`` after a blank line, ``"line"``
    after a line break, ``None`` on the same line."""
    if _BLANK_LINE_RE.search(gap):
        return "paragraph"
    return "line" if "\n" in gap else None


def _normalize(text: Optional[str]) -> str:
    """Coerce None→'' and normalize CRLF/CR→LF so ``$`` (re.MULTILINE) and span
    text never carry a stray ``\\r`` on Windows-authored scripts — a
    cross-platform default-behaviour divergence the JS twin mirrors exactly."""
    if not text:
        return ""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _voice_runs(
    body: str, default_voice: Optional[str], voice: Optional[str],
) -> tuple[list[tuple[Optional[str], str]], Optional[str]]:
    """Split ``body`` at its ``[voice:NAME]`` tags, starting in ``voice``:
    ``([(voice, text), …], the voice in effect at its end)``."""
    runs: list[tuple[Optional[str], str]] = []
    last = 0
    for m in _VOICE_RE.finditer(body):
        if m.start() > last:
            runs.append((voice, body[last:m.start()]))
        voice = (m.group(1).strip() or default_voice)
        last = m.end()
    runs.append((voice, body[last:]))
    return runs, voice


def _parse_chapter_body(
    body: str,
    *,
    default_voice: Optional[str] = None,
    default_speed: Optional[float] = None,
) -> list[dict]:
    """Voice→pause→SSML layering for ONE chapter body (no chapter split).

    Returns a list of span dicts ``{voice_id, text, pause_ms_after, speed}``.
    A ``#`` inside ``body`` is NOT treated as a heading here — that is the
    caller's (chapter-split) concern. The JS twin (``parseChapterBody``) is what
    ``storyToSpans`` calls per spoken track. ``[image:]`` tags are taken out
    first and given to the spans read where they stood (``images``); one with
    nothing spoken after it goes to the end of the last span."""
    body, marks = extract_image_marks(body or "")
    runs, _ = _voice_runs(body, default_voice, default_voice)
    spans = _runs_to_spans(runs, default_speed)
    if marks:
        _attach_image_marks(body, spans, marks)
    return spans


def _runs_to_spans(
    runs: list[tuple[Optional[str], str]], default_speed: Optional[float],
    layout: Optional[dict] = None,
) -> list[dict]:
    """Pause→SSML layering of voice runs into span dicts.

    ``layout`` (``{"gap": str, "seen": bool}``, carried across calls for one
    chapter) asks for ``break_before`` on each span that starts a new line
    (``"line"``) or paragraph (``"paragraph"``) of the script: the whitespace
    since the previous text, whatever markup sat in it, decides
    (:func:`layout_break`). Only the reader's layout reads it."""
    spans: list[dict] = []
    from services.ssml_lite import parse_ssml_lite, spell_out

    for voice, run_text in runs:
        for span_text, pause_ms in parse_pause_markers(run_text):
            if layout is not None:
                # A voice tag or a pause marker ends every run and piece.
                layout["gap"] += LAYOUT_MARK
            t = span_text.strip()
            if not t and pause_ms == 0:
                if layout is not None:
                    layout["gap"] += span_text
                continue  # pure whitespace between markers — nothing to render
            # (text, speed, paragraph_break_before, gain_db). The whitespace
            # BETWEEN two kept segments is tracked so a blank line that happens
            # to sit on a markup boundary still ends the line instead of being
            # swallowed.
            rendered: list[tuple[str, Optional[float], bool, Optional[float]]] = []
            between = ""
            # The layout gap before each kept segment (SSML tags as marks).
            gaps: list[str] = []
            gap = (layout["gap"] + span_text[:len(span_text) - len(span_text.lstrip())]
                   if layout is not None else "")
            for seg in (parse_ssml_lite(t) if t else []):
                raw = seg["text"]
                st = (spell_out(raw) if seg["spell"] else raw).strip()
                gap += LAYOUT_MARK
                if not st:
                    between += raw
                    gap += raw
                    continue
                # Inline SSML speed overrides the per-line default; a plain
                # segment inherits default_speed.
                sp = seg["speed"] if seg["speed"] is not None else default_speed
                lead = raw[:len(raw) - len(raw.lstrip())]
                rendered.append((st, sp, bool(_BLANK_LINE_RE.search(between + lead)),
                                 seg.get("gain_db")))
                gaps.append(gap + lead)
                between = raw[len(raw.rstrip()):]
                gap = between
            if layout is not None:
                layout["gap"] = gap + span_text[len(span_text.rstrip()):] if t else gap
            if not rendered:
                # Only-markers / empty text but a real pause → carry the silence.
                if pause_ms > 0:
                    spans.append({"voice_id": voice, "text": "",
                                  "pause_ms_after": pause_ms, "speed": None})
                continue
            for j, (st, sp, _brk, gain) in enumerate(rendered):
                span = {
                    "voice_id": voice, "text": st,
                    "pause_ms_after": pause_ms if j == len(rendered) - 1 else 0,
                    "speed": sp,
                }
                if gain:
                    # A [volume] passage: its gain in dB, applied after voice
                    # leveling. Key present only here — every other span (and
                    # so every cache key of a script without the tag) is
                    # byte-identical.
                    span["gain_db"] = gain
                if j < len(rendered) - 1:
                    # Inline markup split one run of text. Say how this span
                    # joins the next: straight on, or across a blank line. Key
                    # present only here — plain scripts parse byte-identically.
                    span["join"] = "paragraph" if rendered[j + 1][2] else "continue"
                if layout is not None:
                    brk = layout_break(gaps[j]) if layout["seen"] else None
                    if brk:
                        span["break_before"] = brk
                    layout["seen"] = True
                spans.append(span)
    return spans


def _open_delivery(text: str) -> str:
    """The delivery tags (``[slow]``, ``[spell]``…) still open where ``text``
    ends, written out to open them again where the text goes on.

    Delivery never runs past a voice switch or a pause (each part is parsed on
    its own), so only the stretch after the last of those counts."""
    from services.ssml_lite import open_tags

    runs, _ = _voice_runs(text, None, None)
    stretch, pause_ms = parse_pause_markers(runs[-1][1])[-1]
    if pause_ms:
        return ""
    return "".join(f"[{name}]" for name in open_tags(stretch))


def _parse_sectioned_body(
    body: str,
    *,
    default_voice: Optional[str] = None,
    default_speed: Optional[float] = None,
    layout: bool = False,
) -> list[dict]:
    """One Audiobook chapter body, ``##``/``###`` section headings included.

    A heading line is parsed like any other text (its tags work), without its
    marks, and the first of its spans that speaks carries ``section`` (the
    title as written) and ``section_level`` (2 or 3). It is a paragraph of its
    own: the span before it and its last span join what follows across a
    paragraph break (``join: "paragraph"``). The voice runs on across it, and
    so does a delivery tag open around it (``[slow]`` … ``## Part`` …
    ``[/slow]``), as if the heading were ordinary text. Without a heading this
    is exactly :func:`_parse_chapter_body`. ``layout`` adds ``break_before``
    (:func:`_runs_to_spans`); a heading is a paragraph of its own there too."""
    spans: list[dict] = []
    voice = default_voice
    pending: Optional[tuple[str, int]] = None
    breaks: set[int] = set()
    carry = ""
    state = {"gap": "", "seen": False} if layout else None

    def add(text: str, heading: Optional[tuple[str, int]] = None) -> None:
        nonlocal voice, pending, carry
        text = carry + text
        carry = _open_delivery(text)
        runs, voice = _voice_runs(text, default_voice, voice)
        block = _runs_to_spans(runs, default_speed, state)
        if heading is not None:
            if spans:
                breaks.add(len(spans) - 1)
            pending = heading
        for span in block:
            if pending is not None and span["text"]:
                span["section"], span["section_level"] = pending
                pending = None
            spans.append(span)
        if heading is not None and block:
            breaks.add(len(spans) - 1)

    last = 0
    for m in _SECTION_RE.finditer(body):
        add(body[last:m.start()])
        add(m.group(2), (m.group(2).strip(), len(m.group(1))))
        last = m.end()
    add(body[last:])
    for i in sorted(breaks):
        span = spans[i]
        if (i < len(spans) - 1 and span["text"] and not span["pause_ms_after"]
                and "join" not in span):
            span["join"] = "paragraph"
    if layout:
        for i in sorted(breaks):
            # The first text after a heading boundary opens a paragraph.
            after = next((k for k in range(i + 1, len(spans)) if spans[k]["text"]), None)
            if after is not None and any(spans[k]["text"] for k in range(after)):
                spans[after]["break_before"] = "paragraph"
    return spans


def parse_script_to_spans(
    text: Optional[str],
    *,
    default_voice: Optional[str] = None,
    default_speed: Optional[float] = None,
    layout: bool = False,
) -> list[dict]:
    """Parse a chapter-delimited script into ``[{"title", "spans": [...]}, …]``.

    span dict == ``{"voice_id": str|None, "text": str, "pause_ms_after": int,
    "speed": float|None}`` (key order matches ``Span.to_dict()``), plus
    ``gain_db`` / ``join`` / ``section`` / ``section_level`` only where they
    apply (``gain_db``: the dB a ``[volume]`` passage is moved by).

    Contract:
      * None / "" / whitespace-only input → ``[]``.
      * CRLF/CR normalized to LF at entry (cross-platform parity).
      * ``[image: NAME]`` tags are taken out before anything else
        (:func:`extract_image_marks`), so they change no span; the span read
        where one stood carries ``images: [{"at", "name", "fit"}]`` (``at``:
        the character of its text the picture shows from). One with nothing
        spoken after it in its chapter goes to the chapter's last span, at its
        end; one in a chapter with nothing spoken goes to the next chapter's
        first span.
      * H1 (``# <non-space>…``) opens a chapter; ``##``/``###`` open a
        section inside it, read aloud without the marks
        (:func:`_parse_sectioned_body`); ``####``…``######`` and ``# ``
        (no ``\\S`` title) are body.
      * Each chapter body resets the active voice to ``default_voice``.
      * A span is dropped iff its text is empty AND pause_ms_after == 0.
      * Chapters with no surviving spans are dropped; untitled bodies are
        numbered ``Chapter {kept_so_far + 1}`` (post-drop numbering) and
        carry ``untitled: True``, so a reader can name them in its own
        language (key present only there).
      * ``layout=True`` (Python only — the server builds the reader's
        timeline) adds ``break_before: "line" | "paragraph"`` to each span
        that starts a new line or paragraph of the script, never to the
        first text of a chapter. It is display only: synthesis and every
        cache key ignore it, and the golden corpus parses without it.
    """
    text, marks = extract_image_marks(_normalize(text))
    matches = list(_HEADING_RE.finditer(text))
    # (title, body, where the body starts in ``text``, where the text the
    # chapter owns starts: its heading line, so a tag there opens it).
    if not matches:
        raw = [(None, text, 0, 0)]
    else:
        raw = []
        intro = text[:matches[0].start()]
        if intro.strip():
            raw.append((None, intro, 0, 0))
        for i, m in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            raw.append((m.group(1).strip(), text[m.end():end], m.end(), m.start() if raw else 0))

    chapters: list[dict] = []
    carried: list[dict] = []
    for n, (title, body, offset, owns) in enumerate(raw):
        spans = _parse_sectioned_body(body, default_voice=default_voice,
                                      default_speed=default_speed, layout=layout)
        if marks:
            limit = raw[n + 1][3] if n + 1 < len(raw) else len(text) + 1
            mine = [{**m, "pos": max(0, m["pos"] - offset)} for m in marks
                    if owns <= m["pos"] < limit]
            carried = _give_carried_images(spans, carried)
            carried += _attach_image_marks(body, spans, mine)
        if not spans:
            continue
        chapter = {"title": title or f"Chapter {len(chapters) + 1}", "spans": spans}
        if not title:
            chapter["untitled"] = True
        chapters.append(chapter)
    return chapters
