"""Sentence-level helpers for Dub translation.

Sentence-trained translators (NLLB-200, and the OpenNMT models Argos runs)
learned from single sentences. Handed a segment that holds several, they often
translate one and drop the rest: NLLB returned "the opposite, which means that
you forget as much as you learn. But the important question is, what do you
forget?" as the second sentence alone, in Vietnamese, Japanese, German and most
other targets. Dub translation therefore cuts each segment into sentences
(:func:`split_for_translation`), translates them as rows of one batch and joins
the results per target script (:func:`join_translations`). A sentence too short
to stand alone — "No.", "Oh.", a list's "1." — stays with its neighbour: alone,
NLLB answers it with a sentence of its own ("- Nein, ich weiß nicht."). A
quotation's closing mark stays with the sentence it closes, and the words that
go on after it ("「行こう。」と彼は言った", "'Stop!' he said") stay with it too.

Every translator's output then goes through :func:`omission_verdict`, which
flags a line that came back much shorter than its source, or with fewer
sentences, so the segment row can offer a second, more literal pass before
the line is dubbed.

Pure text: no model, torch or network import.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

from services.sentence_chunker import _split_sentences
from services.speech_rate import expected_duration

#: A character that can be voiced: a letter or digit in any script.
_SPEAKABLE = re.compile(r"[^\W_]")
#: Marks a translation may keep inside one sentence row: the next sentence
#: continues after a semicolon, so it stays in the same row.
_SEMICOLONS = ";；؛"
#: Clause breaks for the literal second pass: a comma, semicolon or colon
#: followed by a space (Latin, Cyrillic, Arabic...), or a fullwidth one.
#: "1,000" and "10:30" carry no space and stay whole.
_CLAUSE_BREAK = re.compile(r"(?<=[,;:،؛])\s+|(?<=[、，；：])")
#: A sentence or clause with less speech than this many Latin letters joins
#: its neighbour ("No." / "Well," / "1."): alone it translates into a
#: fragment, or into a sentence the translator makes up.
_MIN_CLAUSE_CHARS = 8
#: Base languages written without spaces between words or sentences.
_NO_SPACE_LANGUAGES = frozenset({"zh", "zho", "cmn", "yue", "wuu", "lzh", "ja", "jpn"})
#: Languages that separate sentences with a space instead of a mark, so a
#: sentence count says nothing about what a translation left out.
_UNPUNCTUATED_LANGUAGES = frozenset({"th", "lo"})
#: Fullwidth mark that ends a sentence or clause in a no-space script, by the
#: mark its source sentence ended on (default: the ideographic full stop).
_FULLWIDTH_MARK = {
    "?": "？", "？": "？", "؟": "？",
    "!": "！", "！": "！",
    ",": "，", "，": "，", "،": "，", "、": "、",
    ";": "；", "；": "；", "؛": "；",
    ":": "：", "：": "：",
}
#: Closing quote or bracket → the opening mark it closes. The sentence
#: splitter keeps only ``"`` and ``”`` with the sentence they end; any other
#: one would start the next sentence. German closes „…“ and ‚…‘, and writes
#: »…« where French writes «…».
_OPENERS = {
    ")": "(", "]": "[", "}": "{", "）": "（", "］": "［", "｝": "｛",
    "」": "「", "』": "『", "】": "【", "〕": "〔", "〉": "〈", "》": "《",
    "”": "“", "’": "‘", "“": "„", "‘": "‚", "»": "«", "«": "»", "›": "‹", "‹": "›",
    '"': '"', "'": "'",
}
_CLOSERS = "".join(_OPENERS)
#: Marks that are an apostrophe between two letters ("don't", "don’t").
_APOSTROPHES = "'’"
#: A numbered list item opens with its number ("3. Read it."). Its number
#: tells the translator what it is: NLLB translates "3. Read it." alone, where
#: a bare "Read it." came back as "- ¿Qué quieres?", and joined to the item
#: before it the item could be dropped.
_LIST_ITEM = re.compile(r"\d{1,3}[.)]\s")
#: A sentence the splitter cut that is only a list's number ("2."): it opens
#: the item after it, and is never a sentence of its own.
_LIST_NUMBER = re.compile(r"\d{1,3}[.)]")
#: An aside in brackets — "(Laughs.)", "[Music]" — is no speech a translation
#: must keep: NLLB rightly leaves "(Laughs.)" out of "Okay, fangen wir an."
_ASIDE = re.compile(r"\([^()]*\)|\[[^\[\]]*\]|（[^（）]*）|［[^［］]*］|【[^【】]*】")

#: Spoken length of a complete translation into each language, relative to
#: English, as :func:`services.speech_rate.expected_duration` measures it
#: (median over NLLB-200 translations of eight multi-sentence English lines,
#: one sentence per row). Dense scripts read shorter than that table's rates
#: assume; German and Indonesian run longer. Unlisted languages count as 1.0.
_RELATIVE_LENGTH = {
    "en": 1.0, "es": 1.0, "ru": 1.05, "de": 1.2, "id": 1.25, "vi": 0.9,
    "ar": 0.9, "hi": 0.85, "th": 1.2, "ko": 0.8, "zh": 0.75, "ja": 0.55,
}
#: The same, for the language a source was SPOKEN in. NLLB writes Japanese
#: compressed; a speaker's Japanese — polite forms above all — runs about as
#: long as its English (a polite "Sorry, we are closed for today" measures
#: 2.8 s in Japanese and 2.1 s in English; five such complete lines measured
#: 1.0–1.35× their English). Judged against 0.55, a complete English or
#: Spanish line from Japanese read as half missing.
_SOURCE_RELATIVE_LENGTH = {**_RELATIVE_LENGTH, "ja": 1.0}
#: Dense scripts by Unicode block: what each character's speech is measured
#: as (see :func:`_voiced_length`).
_DENSE_BLOCKS = (
    (0x3040, 0x30FF, "ja"),  # kana
    (0x4E00, 0x9FFF, "zh"), (0x3400, 0x4DBF, "zh"), (0xF900, 0xFAFF, "zh"),  # Han
    (0xAC00, 0xD7AF, "ko"), (0x1100, 0x11FF, "ko"),  # Hangul
    (0x0E00, 0x0E7F, "th"),
)
#: Latin letters of speech one dense-script character carries, by the rates
#: :func:`expected_duration` reads at: a Han character about 2.5, kana, a
#: Hangul syllable or a Thai letter about 1.5.
_DENSE_WEIGHT = {
    language: expected_duration("x", language) / expected_duration("x", "en")
    for language in ("ja", "zh", "ko", "th")
}
#: Sources shorter than this (expected seconds of speech) are not judged:
#: "Yes." against "Si." says nothing about omissions.
OMISSION_MIN_SOURCE_S = 2.0
#: Below this share of the expected length a translation is flagged whatever
#: its sentences. Complete translations measured no lower than about 0.77.
OMISSION_SHORT_RATIO = 0.55
#: A translation with fewer sentences than its source is flagged below this
#: share; merged sentences of a complete translation stay above it.
OMISSION_SENTENCE_RATIO = 0.9
#: A sentence that takes less than this (expected seconds) to say — "Oh.",
#: "No.", "Okay." — is no sentence a translation can be missing: translators
#: fold such a word into the next sentence or leave it out.
_COUNTED_SENTENCE_S = 0.5


def _speakable(text: str) -> bool:
    return bool(_SPEAKABLE.search(text))


def _dense_language(char: str) -> Optional[str]:
    """The dense script ``char`` is written in (see :data:`_DENSE_BLOCKS`)."""
    code = ord(char)
    for first, last, language in _DENSE_BLOCKS:
        if first <= code <= last:
            return language
    return None


def _voiced_length(text: str) -> float:
    """How much ``text`` says, in Latin letters: its letters and digits, a
    dense-script character counted as the letters its speech takes."""
    return sum(_DENSE_WEIGHT.get(_dense_language(char), 1.0) for char in _SPEAKABLE.findall(text))


def _short(text: str) -> bool:
    return _voiced_length(text) < _MIN_CLAUSE_CHARS


def _marks(text: str, mark: str) -> int:
    """How many ``mark`` quote ``text``; an apostrophe inside a word is no quote."""
    if mark not in _APOSTROPHES:
        return text.count(mark)
    return sum(
        1 for at, char in enumerate(text)
        if char == mark and not (0 < at < len(text) - 1 and text[at - 1].isalnum() and text[at + 1].isalnum())
    )


def _closes(sentence: str, mark: str) -> bool:
    """Whether closing ``mark`` closes a quote or bracket ``sentence`` opened."""
    opener = _OPENERS[mark]
    if opener == mark:  # a straight quote opens and closes alike
        return _marks(sentence, mark) % 2 == 1
    return _marks(sentence, opener) > _marks(sentence, mark)


def _continues(line: str, end: int, start: int) -> bool:
    """Whether the sentence starting at ``start`` continues the one ending at
    ``end`` (exclusive) — a split the sentence splitter makes for speech but a
    translator must not see."""
    before = line[:end].rstrip(_CLOSERS)
    if not before or start >= len(line):
        return False
    last, first = before[-1], line[start]
    if last in _SEMICOLONS:
        return True
    lower = first.isdigit() or (first.isalpha() and first.islower())
    if last == "…" and lower:
        return True  # "I was… thinking"
    if len(before) < end:
        # A quotation ended the sentence, and its sentence goes on after it:
        # "'Stop!' he said", or glued to it in a script without spaces
        # ("「行こう。」と彼は言った").
        return lower or (start == end and first.isalpha())
    # "readme.txt", "Node.js": a period glued to a lowercase word or a digit.
    return last == "." and start == end and lower


def _merge_spans(text: str, spans: list[list[int]], joins) -> list[list[int]]:
    """Merge adjacent ``[start, end)`` spans of ``text`` where ``joins(previous,
    span)`` asks for it, and fold spans that carry no speech (a lone dash or
    quote) into a neighbour. Merged spans keep the text between them as
    written, so a no-space script never gains a space."""
    out: list[list[int]] = []
    for span in spans:
        if out and (joins(out[-1], span) or not (_speakable(text[span[0]:span[1]])
                                                and _speakable(text[out[-1][0]:out[-1][1]]))):
            out[-1][1] = span[1]
        else:
            out.append(list(span))
    return out


def _close_quotes(flat: str, spans: list[list[int]]) -> list[list[int]]:
    """Give each closing mark the splitter left at the start of a sentence
    back to the sentence before it, whose quote or bracket it closes —
    "(Laughs." + ") Okay" is "(Laughs.)" + "Okay"."""
    for before, span in zip(spans, spans[1:]):
        while (
            span[0] < span[1]
            and not flat[before[1]:span[0]].strip()
            and flat[span[0]] in _OPENERS
            and _closes(flat[before[0]:before[1]], flat[span[0]])
        ):
            before[1] = span[0] + 1
            span[0] += 1
            while span[0] < span[1] and flat[span[0]].isspace():
                span[0] += 1
    return [span for span in spans if span[0] < span[1]]


def _join_short(text: str, spans: list[list[int]], *, across_lines: bool) -> list[list[int]]:
    """Join a span that says less than :data:`_MIN_CLAUSE_CHARS` Latin letters
    to the next one, the last to the one before — unless it is a numbered
    list's item (:data:`_LIST_ITEM`). Unless ``across_lines``, a line break
    between two spans keeps them apart: a caption's lines stay its lines."""
    def joins(before: list[int], after: list[int]) -> bool:
        return across_lines or "\n" not in text[before[1]:after[0]]

    spans = _merge_spans(text, spans, lambda before, after: _short(text[before[0]:before[1]]) and joins(before, after))
    if (
        len(spans) > 1
        and _short(text[spans[-1][0]:spans[-1][1]])
        and joins(spans[-2], spans[-1])
        and not _LIST_ITEM.match(text, spans[-1][0])
    ):
        spans[-2:] = [[spans[-2][0], spans[-1][1]]]
    return spans


def _sentence_spans(text: str, *, join_short: bool = True) -> list[list[int]]:
    """Sentence spans of ``text`` as the shared sentence splitter cuts them,
    with the cuts a translator should not see joined back: a closing quote
    goes with the sentence it closes, and a sentence that goes on after a
    quote or a period inside a word stays whole. With ``join_short``, one too
    short to translate alone joins its neighbour on its line. A line break
    inside a sentence does not cut it: the translator needs the whole
    sentence."""
    flat = text.replace("\n", " ")  # what the splitter reads; same offsets
    spans: list[list[int]] = []
    cursor = 0
    for sentence, _start, _end in _split_sentences(text, min_sentence_len=0):
        at = flat.find(sentence, cursor)
        if at < 0:  # the splitter returns verbatim text; never cut blind
            return [[0, len(text)]]
        spans.append([at, at + len(sentence)])
        cursor = at + len(sentence)
    spans = _merge_spans(
        text, _close_quotes(flat, spans),
        lambda before, after: _continues(flat, before[1], after[0]) or (
            bool(_LIST_NUMBER.fullmatch(text[before[0]:before[1]].strip()))
            and "\n" not in text[before[1]:after[0]]
        ),
    )
    return _join_short(text, spans, across_lines=False) if join_short else spans


def _clause_spans(text: str, start: int, end: int) -> list[list[int]]:
    """Clause spans inside the sentence ``text[start:end]``; a clause that says
    less than :data:`_MIN_CLAUSE_CHARS` Latin letters stays with the next one
    (the last with the one before)."""
    cuts = [start] + [start + m.end() for m in _CLAUSE_BREAK.finditer(text[start:end])] + [end]
    spans = [[a, b] for a, b in zip(cuts, cuts[1:]) if text[a:b].strip()]
    return _join_short(text, spans, across_lines=True)


def _piece(text: str) -> str:
    """A span's text for the translator: trimmed, a line break read as a space."""
    return re.sub(r"\s*\n\s*", " ", text.strip())


def split_for_translation(text: str, *, clauses: bool = False) -> list[tuple[str, str]]:
    """``text`` as ``(sentence, separator)`` pairs, in order.

    ``separator`` is what followed the sentence: the line breaks of a
    multi-line caption when one ends there (kept as written), ``" "`` for any
    other gap, ``""`` after the last sentence. With ``clauses`` every sentence
    is cut again at its commas, semicolons and colons: the literal second pass
    for a line that came back with content missing.
    """
    text = (text or "").strip()
    if not text:
        return []
    spans = _sentence_spans(text) or [[0, len(text)]]
    if clauses:
        spans = [clause for a, b in spans for clause in _clause_spans(text, a, b)]
    out: list[tuple[str, str]] = []
    for k, (a, b) in enumerate(spans):
        gap = text[b:spans[k + 1][0]] if k + 1 < len(spans) else ""
        separator = "\n" * gap.count("\n") if "\n" in gap else (" " if k + 1 < len(spans) else "")
        out.append((_piece(text[a:b]), separator))
    return out


def _base_language(code: Optional[str]) -> Optional[str]:
    from services.language_codes import engine_language_code

    try:
        return engine_language_code(code)
    except Exception:  # noqa: BLE001 — a malformed code reads as unknown
        return None


def _dense_script(text: str) -> Optional[str]:
    """The language whose rates fit ``text`` when it is mostly a dense script
    (Han, kana, Hangul, Thai), whatever code the request named; else None."""
    counts = {"ja": 0, "zh": 0, "ko": 0, "th": 0}
    letters = 0
    for ch in text:
        if not ch.isalpha():
            continue
        letters += 1
        language = _dense_language(ch)
        if language:
            counts[language] += 1
    if not letters:
        return None
    if (counts["zh"] + counts["ja"]) * 2 >= letters:
        return "ja" if counts["ja"] else "zh"
    if counts["ko"] * 2 >= letters:
        return "ko"
    if counts["th"] * 2 >= letters:
        return "th"
    return None


def _length_language(text: str, code: Optional[str]) -> str:
    return _dense_script(text) or _base_language(code) or "en"


def join_translations(pieces: list[tuple[str, str]], translated: list[str], target_lang: Optional[str]) -> str:
    """Join per-sentence translations back into one line for ``target_lang``.

    Line breaks of the source are kept. Otherwise sentences are joined with a
    space, except in scripts written without spaces (Chinese, Japanese), where
    they are joined directly and a sentence the translator left unterminated
    gets the fullwidth mark of its source sentence, so two sentences never run
    together.
    """
    texts = [(text or "").strip() for text in translated]
    no_space = (_base_language(target_lang) in _NO_SPACE_LANGUAGES
                or _dense_script("".join(texts)) in ("zh", "ja"))
    out = ""
    previous: tuple[str, str] | None = None
    for (source, separator), text in zip(pieces, texts):
        if not text:
            continue
        if out and previous is not None:
            source_before, joiner = previous
            if "\n" not in joiner:
                if no_space:
                    last = out.rstrip(_CLOSERS)[-1:]
                    if last and not unicodedata.category(last).startswith("P"):
                        mark = source_before.rstrip(_CLOSERS)[-1:]
                        out += _FULLWIDTH_MARK.get(mark, "。")
                    joiner = ""
                else:
                    joiner = " "
            out += joiner
        out += text
        previous = (source, separator)
    return out


def _content(text: str, language: Optional[str]) -> tuple[list[str], str]:
    """The sentences of ``text`` (written in ``language``) a translation must
    keep, and the language its length is read in. Left out: an aside in
    brackets ("(Laughs.)", "[Music]"), and a sentence that takes less than
    :data:`_COUNTED_SENTENCE_S` to say ("Oh.", "No.") unless it is a list's
    item — a complete translation drops or folds those and loses nothing."""
    text = _ASIDE.sub(" ", text or "").strip()
    rate_language = _length_language(text, language)
    kept = []
    for a, b in _sentence_spans(text, join_short=False):
        sentence = text[a:b]
        if any(char.isalpha() for char in sentence) and (
            _LIST_ITEM.match(sentence)
            or expected_duration(sentence, rate_language) >= _COUNTED_SENTENCE_S
        ):
            kept.append(sentence)
    return kept, rate_language


def sentence_count(text: str, language: Optional[str] = None) -> int:
    """Sentences in ``text`` (written in ``language``) a translation must keep
    (see :func:`_content`): "1. Mở hộp." counts as the "1. Open the box." it
    translates, and an "Oh." a translation folds into the next sentence does
    not count at all."""
    return len(_content(text, language)[0])


def omission_verdict(source: str, translation: str, source_lang: Optional[str],
                     target_lang: Optional[str]) -> Optional[dict]:
    """Why ``translation`` may be missing part of ``source``, or None.

    Both lengths are expected seconds of speech in their own language, of the
    sentences a translation must keep (:func:`_content`: no bracketed asides,
    no "Oh." before a sentence), and the translation is compared with what a
    complete one usually measures for that language pair
    (:data:`_RELATIVE_LENGTH` for the translation, and
    :data:`_SOURCE_RELATIVE_LENGTH` for the spoken source; dense scripts are
    recognized by their characters, so a mislabelled source still measures
    right). A line is flagged ``short`` below :data:`OMISSION_SHORT_RATIO` of
    that, or ``sentences`` when it also has fewer sentences than its source and
    falls below :data:`OMISSION_SENTENCE_RATIO`. Thai and Lao separate
    sentences with spaces, so only their length is judged.
    """
    source = (source or "").strip()
    translation = (translation or "").strip()
    if not source or not translation:
        return None
    source_sentences, source_language = _content(source, source_lang)
    target_sentences, target_language = _content(translation, target_lang)
    source_s = sum(expected_duration(sentence, source_language) for sentence in source_sentences)
    if source_s < OMISSION_MIN_SOURCE_S:
        return None
    expected = source_s * (_RELATIVE_LENGTH.get(target_language, 1.0)
                           / _SOURCE_RELATIVE_LENGTH.get(source_language, 1.0))
    ratio = sum(expected_duration(sentence, target_language) for sentence in target_sentences) / expected
    source_n = len(source_sentences)
    target_n = len(target_sentences)
    verdict = {"ratio": round(ratio, 2), "source_sentences": source_n, "target_sentences": target_n}
    if ratio < OMISSION_SHORT_RATIO:
        return {"reason": "short", **verdict}
    if (source_n >= 2 and target_n < source_n and ratio < OMISSION_SENTENCE_RATIO
            and not {source_language, target_language} & _UNPUNCTUATED_LANGUAGES):
        return {"reason": "sentences", **verdict}
    return None
