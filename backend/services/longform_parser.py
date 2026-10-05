"""Canonical longform marker parser (#27) — the single source of grammar truth.

The longform marker dialect (``# heading``, ``[voice:NAME]``, ``[pause …]``,
``[slow]/[fast]/[emphasis]/[spell]``) was parsed by three independent code
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
    ``storyToSpans`` calls per spoken track."""
    runs, _ = _voice_runs(body, default_voice, default_voice)
    return _runs_to_spans(runs, default_speed)


def _runs_to_spans(
    runs: list[tuple[Optional[str], str]], default_speed: Optional[float],
) -> list[dict]:
    """Pause→SSML layering of voice runs into span dicts."""
    spans: list[dict] = []
    from services.ssml_lite import parse_ssml_lite, spell_out

    for voice, run_text in runs:
        for span_text, pause_ms in parse_pause_markers(run_text):
            t = span_text.strip()
            if not t and pause_ms == 0:
                continue  # pure whitespace between markers — nothing to render
            # (text, speed, paragraph_break_before). The whitespace BETWEEN two
            # kept segments is tracked so a blank line that happens to sit on a
            # markup boundary still ends the line instead of being swallowed.
            rendered: list[tuple[str, Optional[float], bool]] = []
            between = ""
            for seg in (parse_ssml_lite(t) if t else []):
                raw = seg["text"]
                st = (spell_out(raw) if seg["spell"] else raw).strip()
                if not st:
                    between += raw
                    continue
                # Inline SSML speed overrides the per-line default; a plain
                # segment inherits default_speed.
                sp = seg["speed"] if seg["speed"] is not None else default_speed
                lead = raw[:len(raw) - len(raw.lstrip())]
                rendered.append((st, sp, bool(_BLANK_LINE_RE.search(between + lead))))
                between = raw[len(raw.rstrip()):]
            if not rendered:
                # Only-markers / empty text but a real pause → carry the silence.
                if pause_ms > 0:
                    spans.append({"voice_id": voice, "text": "",
                                  "pause_ms_after": pause_ms, "speed": None})
                continue
            for j, (st, sp, _brk) in enumerate(rendered):
                span = {
                    "voice_id": voice, "text": st,
                    "pause_ms_after": pause_ms if j == len(rendered) - 1 else 0,
                    "speed": sp,
                }
                if j < len(rendered) - 1:
                    # Inline markup split one run of text. Say how this span
                    # joins the next: straight on, or across a blank line. Key
                    # present only here — plain scripts parse byte-identically.
                    span["join"] = "paragraph" if rendered[j + 1][2] else "continue"
                spans.append(span)
    return spans


def _parse_sectioned_body(
    body: str,
    *,
    default_voice: Optional[str] = None,
    default_speed: Optional[float] = None,
) -> list[dict]:
    """One Audiobook chapter body, ``##``/``###`` section headings included.

    A heading line is parsed like any other text (its tags work), without its
    marks, and the first of its spans that speaks carries ``section`` (the
    title as written) and ``section_level`` (2 or 3). It is a paragraph of its
    own: the span before it and its last span join what follows across a
    paragraph break (``join: "paragraph"``). The voice runs on across it.
    Without a heading this is exactly :func:`_parse_chapter_body`."""
    spans: list[dict] = []
    voice = default_voice
    pending: Optional[tuple[str, int]] = None
    breaks: set[int] = set()

    def add(text: str, heading: Optional[tuple[str, int]] = None) -> None:
        nonlocal voice, pending
        runs, voice = _voice_runs(text, default_voice, voice)
        block = _runs_to_spans(runs, default_speed)
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
    return spans


def parse_script_to_spans(
    text: Optional[str],
    *,
    default_voice: Optional[str] = None,
    default_speed: Optional[float] = None,
) -> list[dict]:
    """Parse a chapter-delimited script into ``[{"title", "spans": [...]}, …]``.

    span dict == ``{"voice_id": str|None, "text": str, "pause_ms_after": int,
    "speed": float|None}`` (key order matches ``Span.to_dict()``), plus
    ``join`` / ``section`` / ``section_level`` only where they apply.

    Contract:
      * None / "" / whitespace-only input → ``[]``.
      * CRLF/CR normalized to LF at entry (cross-platform parity).
      * H1 (``# <non-space>…``) opens a chapter; ``##``/``###`` open a
        section inside it, read aloud without the marks
        (:func:`_parse_sectioned_body`); ``####``…``######`` and ``# ``
        (no ``\\S`` title) are body.
      * Each chapter body resets the active voice to ``default_voice``.
      * A span is dropped iff its text is empty AND pause_ms_after == 0.
      * Chapters with no surviving spans are dropped; untitled bodies are
        numbered ``Chapter {kept_so_far + 1}`` (post-drop numbering).
    """
    text = _normalize(text)
    matches = list(_HEADING_RE.finditer(text))
    if not matches:
        raw = [(None, text)]
    else:
        raw = []
        intro = text[:matches[0].start()]
        if intro.strip():
            raw.append((None, intro))
        for i, m in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            raw.append((m.group(1).strip(), text[m.end():end]))

    chapters: list[dict] = []
    for title, body in raw:
        spans = _parse_sectioned_body(body, default_voice=default_voice,
                                      default_speed=default_speed)
        if not spans:
            continue
        chapters.append({"title": title or f"Chapter {len(chapters) + 1}",
                         "spans": spans})
    return chapters
