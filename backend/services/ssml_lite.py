"""SSML-LITE — inline prosody/spell markup for longform lines (PR 8).

A *single line* of narration may carry inline tags that nudge the engine's
delivery without reaching for full SSML:

  * ``[slow]…[/slow]``         — speak slower   (``speed ≈ 0.85``)
  * ``[fast]…[/fast]``         — speak faster   (``speed ≈ 1.15``)
  * ``[emphasis]…[/emphasis]`` — mild emphasis: a gentle slow-down
                                 (``speed ≈ 0.92``) plus an ``emphasis`` flag
                                 the caller may use for future markup
  * ``[spell]…[/spell]``       — spell the run out letter-by-letter
                                 (``spell=True``; the caller spaces the chars)
  * ``[volume -6dB]…[/volume]`` — read the run quieter or louder: a gain in
                                 dB (``dB``/``db``, a space before it, or a
                                 bare number), ±:data:`MAX_PASSAGE_GAIN_DB`.
                                 Nested volumes add up, clamped again.

:func:`parse_ssml_lite` splits one line into ordered segments::

    [{"text": str, "speed": float | None, "spell": bool, "emphasis": bool}, …]

plus ``"gain_db": float`` on a segment a ``[volume]`` moves (never 0 dB:
segments without a gain keep the exact four keys above).

Semantics (kept deliberately small and predictable):

  * Plain text → exactly one segment ``{text, speed=None, spell=False,
    emphasis=False}``.
  * Tags nest; the **innermost** tag wins for any property it sets. ``speed``
    from an inner ``[fast]`` overrides an outer ``[slow]``; ``[spell]`` inside
    ``[slow]`` keeps the slow speed *and* turns spelling on.
  * An **unclosed** tag applies to the end of the line.
  * A stray close tag with no matching open is ignored (treated as literal
    nothing — the markers are always stripped from the emitted ``text``).
  * Adjacent segments that share identical (speed, spell, emphasis, gain) are
    merged so plain runs stay single segments.
  * A ``[volume]`` without a number it can read (``[volume]``, ``[volume
    loud]``, ``[/volume 3]``) is not a tag: it stays in the text, read aloud
    like any unknown tag.

This module is pure (no torch, no I/O) so it is cheap to import and unit-test.
The regex is ReDoS-safe: it is a fixed alternation of literal tag tokens (and
one bounded number) with no quantifier overlap, so matching is linear in the
input length.
"""

from __future__ import annotations

import re
from typing import Optional

# Speed multipliers. ``None`` means "engine default" (no override emitted).
SLOW_SPEED = 0.85
FAST_SPEED = 1.15
# Emphasis maps to a *mild* slow-down (between default and [slow]) plus a flag.
EMPHASIS_SPEED = 0.92

# Recognised tag names → the (speed_delta, spell, emphasis) they impose while
# open. ``speed`` of ``None`` for a tag means "this tag does not touch speed".
_TAGS: dict[str, dict] = {
    "slow": {"speed": SLOW_SPEED, "spell": None, "emphasis": None},
    "fast": {"speed": FAST_SPEED, "spell": None, "emphasis": None},
    "emphasis": {"speed": EMPHASIS_SPEED, "spell": None, "emphasis": True},
    "spell": {"speed": None, "spell": True, "emphasis": None},
}

#: Largest cut or boost one ``[volume]`` passage may carry, nested ones added
#: together (``services.voice_leveling.MAX_LEVEL_GAIN_DB``, the same bound).
MAX_PASSAGE_GAIN_DB = 12.0
_VOLUME = "volume"

# One regex that matches any open/close tag for the known names. It is an
# alternation of fixed literals — ``\[/?(?:slow|fast|emphasis|spell|volume)\]``
# — plus the bounded gain a ``[volume]`` opens with. Every quantifier is
# bounded or separated from the next by a literal, so it cannot backtrack
# polynomially (ReDoS-safe). ``finditer`` walks it left-to-right. ``[0-9]``,
# not ``\d``: Python's ``\d`` takes any Unicode digit, the JS twin's does not.
_TAG_RE = re.compile(
    r"\[(/?)(" + "|".join(re.escape(name) for name in (*_TAGS, _VOLUME))
    + r")(?:[ \t]+([+-]?[0-9]{1,4}(?:\.[0-9]{1,4})?)[ \t]?(?:db)?)?\]",
    re.IGNORECASE,
)


def _tag_of(m: re.Match) -> Optional[str]:
    """The stack entry a tag match stands for — the lowercase name, or
    ``"volume <gain>"`` for an opening ``[volume]`` — or ``None`` when the
    match is not a tag (a volume without its gain, a gain on anything else).
    The gain is kept as written, so :func:`open_tags` writes the tag back
    exactly and both parsers read the same number."""
    name = m.group(2).lower()
    if (m.group(3) is not None) != (name == _VOLUME and m.group(1) != "/"):
        return None
    return f"{name} {m.group(3)}" if m.group(3) is not None else name


def _gain_tenths(value: str) -> int:
    """A ``[volume]`` gain in tenths of a dB, rounded half to even (the JS twin
    rounds the same way), so nested gains add up exactly."""
    return int(round(float(value) * 10))


def _clamp_tenths(tenths: int) -> int:
    bound = int(MAX_PASSAGE_GAIN_DB * 10)
    return max(-bound, min(bound, tenths))


def _resolve(stack: list[str]) -> dict:
    """Collapse an open-tag stack into the effective segment properties.

    Outer→inner walk: a later (more-deeply-nested) tag overrides any property
    it sets, leaving untouched properties from outer tags intact. So
    ``[slow][spell]`` yields ``speed=SLOW_SPEED, spell=True``.
    """
    speed: Optional[float] = None
    spell = False
    emphasis = False
    gain = 0
    for name in stack:
        if name.startswith(_VOLUME):
            # Nested volumes add up; each tag and their sum are clamped.
            gain += _clamp_tenths(_gain_tenths(name.split(" ", 1)[1]))
            continue
        spec = _TAGS[name]
        if spec["speed"] is not None:
            speed = spec["speed"]
        if spec["spell"] is not None:
            spell = bool(spec["spell"])
        if spec["emphasis"] is not None:
            emphasis = bool(spec["emphasis"])
    props = {"speed": speed, "spell": spell, "emphasis": emphasis}
    gain = _clamp_tenths(gain)
    if gain:
        props["gain_db"] = gain / 10
    return props


def _step(stack: list[str], tag: str, closing: bool) -> None:
    """Apply one tag (:func:`_tag_of`) to the open-tag stack: an open pushes
    it; a close drops the nearest open of its name, and an unmatched close is
    ignored."""
    if closing:
        for i in range(len(stack) - 1, -1, -1):
            if stack[i].split(" ", 1)[0] == tag:
                del stack[i]
                break
    else:
        stack.append(tag)  # unclosed opens stay on the stack to EOL


def open_tags(text: str) -> list[str]:
    """The tags still open where ``text`` ends, outermost first (lowercase),
    each as it is written between its brackets (``slow``, ``volume -6``)."""
    stack: list[str] = []
    for m in _TAG_RE.finditer(text or ""):
        tag = _tag_of(m)
        if tag is not None:
            _step(stack, tag, m.group(1) == "/")
    return stack


def parse_ssml_lite(text: str) -> list[dict]:
    """Split one line of SSML-LITE markup into ordered prosody segments.

    See the module docstring for the full contract. Always returns at least one
    segment for non-empty input; returns ``[]`` for ``None``/empty input.
    """
    if not text:
        return []
    if "[" not in text:
        return [{"text": text, "speed": None, "spell": False, "emphasis": False}]

    segments: list[dict] = []
    stack: list[str] = []
    last = 0

    def emit(chunk: str) -> None:
        if not chunk:
            return
        props = _resolve(stack)
        seg = {"text": chunk, **props}
        # Merge with the previous segment when prosody is identical so plain
        # text never fragments into multiple identical-styled pieces.
        if segments:
            prev = segments[-1]
            if (
                prev["speed"] == seg["speed"]
                and prev["spell"] == seg["spell"]
                and prev["emphasis"] == seg["emphasis"]
                and prev.get("gain_db") == seg.get("gain_db")
            ):
                prev["text"] += chunk
                return
        segments.append(seg)

    for m in _TAG_RE.finditer(text):
        tag = _tag_of(m)
        if tag is None:
            continue  # not a tag: it stays in the text
        emit(text[last:m.start()])
        last = m.end()
        _step(stack, tag, m.group(1) == "/")

    emit(text[last:])

    if not segments:
        # Input was only tag markers (e.g. "[slow][/slow]"): nothing to speak.
        return []
    return segments


def spell_out(word: str) -> str:
    """Space out a run for the ``[spell]`` case: ``"USA"`` → ``"U S A"``.

    Collapses surrounding whitespace, then joins the remaining characters with
    single spaces so the engine pronounces each letter discretely. Whitespace
    inside the run is treated as a separator (each token spelled, joined by a
    single space), so ``"go USA"`` → ``"g o U S A"``.
    """
    if not word:
        return ""
    # Drop all existing whitespace, then interleave the visible characters with
    # spaces. ``split()`` + ``"".join`` removes runs of whitespace first.
    compact = "".join(word.split())
    return " ".join(compact)
