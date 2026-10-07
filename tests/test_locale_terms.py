"""Wording machine translation once got wrong stays fixed in every locale.

The renderer catalog was machine translated, and some of its mistakes named a
different thing entirely: "Export" and "Import" became international trade
("Xuất khẩu", "İhracat"), the story and dub "Cast" became the verb "to throw"
or "to broadcast" ("Бросать", "Diffusion automatique"), a diarised speaker
became a loudspeaker, and the examples that teach ``[pause 0.5s]`` and
``[voice:NAME]`` were translated into tags the long-form parser does not read,
so a user who copies them hears the brackets read aloud. The Vietnamese
choices are recorded in ``docs/i18n-glossary-vi.md``.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

import pytest

from omnivoice.utils.text import parse_pause_markers
from services.longform_parser import _HEADING_RE, _VOICE_RE
from services.ssml_lite import _TAG_RE

_LOCALES = Path(__file__).resolve().parents[1] / "electron/src/renderer/src/i18n/locales"
_ALL = sorted(path.stem for path in _LOCALES.glob("*.json"))
_TOKEN = re.compile(r"\[[^\[\]\n]*\]")


def _flat(node, prefix=""):
    for key, value in node.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            yield from _flat(value, path)
        else:
            yield path, value


def _catalog(locale: str) -> dict[str, str]:
    return dict(_flat(json.loads((_LOCALES / f"{locale}.json").read_text(encoding="utf-8"))))


_EN = _catalog("en")


def _markup(text: str) -> Counter:
    """Every bracket token in ``text``, as the long-form parsers read it."""
    found: Counter = Counter()
    for token in _TOKEN.findall(text):
        pause = parse_pause_markers(token)
        if pause[0][0] == "":
            found[f"[pause {pause[0][1]}ms]"] += 1
        elif voice := _VOICE_RE.fullmatch(token):
            found["[voice:NAME]" if voice.group(1).strip() else "[voice:]"] += 1
        else:
            # SSML-lite tags ([slow], [/slow], [volume -6dB]) and the engine's
            # reaction tags ([laughter]) are only ever read verbatim.
            found[token] += 1
    return found


def _teaches_markup(text: str) -> bool:
    return any(
        parse_pause_markers(token)[0][0] == "" or _VOICE_RE.fullmatch(token) or _TAG_RE.fullmatch(token)
        for token in _TOKEN.findall(text)
    )


_MARKUP_KEYS = sorted(key for key, value in _EN.items() if _teaches_markup(value) or _HEADING_RE.search(value))


def test_markup_examples_are_found():
    assert {"stories.linePlaceholder", "audiobook.script_placeholder", "audiobook.markup_hint"} <= set(_MARKUP_KEYS)


@pytest.mark.parametrize("locale", _ALL)
def test_markup_examples_keep_the_tags_the_parser_reads(locale):
    catalog = _catalog(locale)
    problems = []
    for key in _MARKUP_KEYS:
        value = catalog.get(key, "")
        if _markup(value) != _markup(_EN[key]):
            problems.append(f"{key}: {sorted(_markup(value).elements())} != {sorted(_markup(_EN[key]).elements())}")
        if len(_HEADING_RE.findall(value)) != len(_HEADING_RE.findall(_EN[key])):
            problems.append(f"{key}: a '# ' chapter heading was lost: {value!r}")
    assert not problems, f"{locale}:\n" + "\n".join(problems)


# The trade sense of export/import, by locale. File operations use the words
# the operating system uses ("Xuất", "Dışa aktar", "匯出", "エクスポート").
_TRADE = {
    "ar": r"صادرات|واردات",
    "ja": r"輸出|輸入",
    "ko": r"수출|수입",
    "tr": r"[İi]hracat|[İi]thalat|[İi]hra[cç]|[İi]thal",
    "vi": r"(?i)xuất khẩu|nhập khẩu",
    "zh-CN": r"出口|进口",
    "zh-TW": r"出口|進口",
}


@pytest.mark.parametrize("locale", sorted(_TRADE))
def test_export_and_import_are_file_operations(locale):
    catalog = _catalog(locale)
    trade = re.compile(_TRADE[locale])
    wrong = [
        f"{key}: {value!r}"
        for key, value in catalog.items()
        if re.search(r"(?i)\b(?:export|import)", _EN.get(key, "")) and trade.search(value)
    ]
    assert not wrong, f"{locale} names a file export/import as trade:\n" + "\n".join(wrong)


# A loudspeaker, by locale. Every "speaker" in the catalog is a person heard in
# a recording (diarisation, casting); Hindi's loanword means both.
_LOUDSPEAKER = {
    "ar": r"مكبر",
    "de": r"Lautsprecher",
    "es": r"(?i)altavo",
    "fr": r"(?i)haut-parleur",
    "id": r"(?i)pengeras suara",
    "it": r"(?i)altoparlant",
    "ja": r"スピーカー",
    "ko": r"스피커",
    "nl": r"(?i)luidspreker",
    "pl": r"(?i)głośnik",
    "pt": r"(?i)alto-falante",
    "ru": r"(?i)динамик",
    "sv": r"(?i)högtalar",
    "th": r"ลำโพง",
    "tr": r"(?i)hoparlör",
    "uk": r"(?i)динамік",
    "vi": r"(?i)\bloa\b",
    "zh-CN": r"扬声器",
    "zh-TW": r"揚聲器",
}


@pytest.mark.parametrize("locale", sorted(_LOUDSPEAKER))
def test_a_speaker_is_a_person(locale):
    catalog = _catalog(locale)
    loudspeaker = re.compile(_LOUDSPEAKER[locale])
    wrong = [
        f"{key}: {value!r}"
        for key, value in catalog.items()
        if "speaker" in _EN.get(key, "").lower() and loudspeaker.search(value)
    ]
    assert not wrong, f"{locale} calls a speaker a loudspeaker:\n" + "\n".join(wrong)


_CAST_KEYS = (
    "dub.cast",
    "stories.cast",
    "stories.castTitle",
    "stories.autocast",
    "stories.autocastEmpty",
    "stories.autocastDone",
    "audiobook.cast",
)
# "Cast" as throwing, broadcasting, transmitting or casting a spell — each one
# shipped in a locale before.
_CAST_AS_VERB = {
    "ar": r"يلقي|إرسال",
    "es": r"(?i)emisión|transmit",
    "fr": r"(?i)diffus",
    "id": r"(?i)transmisi",
    "it": r"(?i)trasm",
    "nl": r"(?i)gegoten",
    "pl": r"(?i)obrót|przesył",
    "pt": r"(?i)starring|transmi",
    "ru": r"(?i)бросать|трансл",
    "th": r"ส่ง",
    "tr": r"(?i)yayın",
    "uk": r"(?i)трансл|касти",
    "vi": r"(?i)^đúng$|truyền",
    "zh-TW": r"施法|投射",
}


@pytest.mark.parametrize("locale", _ALL)
def test_cast_is_the_voices_given_to_characters(locale):
    catalog = _catalog(locale)
    problems = []
    verb = _CAST_AS_VERB.get(locale)
    for key in _CAST_KEYS:
        if verb and re.search(verb, catalog[key]):
            problems.append(f"{key} reads as a verb: {catalog[key]!r}")
    # The panel's hover title starts with the panel's own name.
    if not catalog["stories.castTitle"].startswith(catalog["stories.cast"]):
        problems.append(
            f"stories.castTitle {catalog['stories.castTitle']!r} does not start with "
            f"stories.cast {catalog['stories.cast']!r}"
        )
    assert not problems, f"{locale}:\n" + "\n".join(problems)


# Vietnamese terms the glossary rules out: trade export/import, a motor for an
# engine, "kết xuất" for render, which users read as export ("Xuất"), and
# "tổng hợp" for synthesis, which reads as a summary.
_VI_AVOID = re.compile(r"(?i)xuất khẩu|nhập khẩu|động cơ|kết xuất|tổng hợp")


def test_vietnamese_follows_the_glossary():
    catalog = _catalog("vi")
    wrong = [f"{key}: {value!r}" for key, value in catalog.items() if _VI_AVOID.search(value)]
    for key in ("dub.cast", "stories.cast", "stories.castTitle", "audiobook.cast"):
        if not catalog[key].startswith("Dàn giọng"):
            wrong.append(f"{key} should name the cast 'Dàn giọng': {catalog[key]!r}")
    assert not wrong, "vi.json drifts from docs/i18n-glossary-vi.md:\n" + "\n".join(wrong)



def test_vietnamese_labels_are_in_sentence_case():
    """The glossary's style: "Dàn giọng", not "DÀN GIỌNG", even where English
    writes capitals; a kicker that should look like capitals uses CSS. Typed
    confirmation words, and acronyms and names English writes so too, stay."""
    catalog = _catalog("vi")
    shouting = []
    for key, value in catalog.items():
        words = re.findall(r"[^\W\d_]{2,}", re.sub(r"\{\{[^}]*\}\}|\[[^\]]*\]", "", value))
        if key.endswith("confirm_word") or not words or not all(w.isupper() for w in words):
            continue
        if not set(words) <= set(re.findall(r"[^\W\d_]{2,}", _EN.get(key, ""))):
            shouting.append(f"{key}: {value!r}")
    assert not shouting, "vi.json labels in capitals:\n" + "\n".join(shouting)


# "Code", by locale: the backend's exit code in a crash report says it; the
# tray's item that quits the app must not (vi, zh and ko once read "exit code").
_CODE = {
    "ar": r"رمز", "de": r"(?i)code", "en": r"(?i)code", "es": r"(?i)código", "fr": r"(?i)code",
    "hi": r"कोड", "id": r"(?i)kode", "it": r"(?i)codice", "ja": r"コード", "ko": r"코드",
    "nl": r"(?i)code", "pl": r"(?i)kod", "pt": r"(?i)código", "ru": r"(?i)код", "sv": r"(?i)kod",
    "th": r"รหัส", "tr": r"(?i)kod", "uk": r"(?i)код", "vi": r"(?i)\bmã\b", "zh-CN": r"码",
    "zh-TW": r"代碼|碼",
}


def test_every_locale_is_covered_by_the_code_words():
    assert sorted(_CODE) == _ALL


@pytest.mark.parametrize("locale", _ALL)
def test_the_tray_quits_and_a_crash_names_its_exit_code(locale):
    catalog = _catalog(locale)
    code = re.compile(_CODE[locale])
    assert code.search(catalog["crash.field_exit"]), catalog["crash.field_exit"]
    assert not code.search(catalog["app.quit"]), catalog["app.quit"]
    assert "{{app}}" in catalog["app.quit"]


def test_the_tray_quit_item_has_a_label_of_its_own():
    app = (_LOCALES.parents[1] / "app.tsx").read_text(encoding="utf-8")
    labels = app[app.index(".labels({"):]
    labels = labels[:labels.index("})")]
    assert "exit: t('app.quit'" in labels and "crash." not in labels
