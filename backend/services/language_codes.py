"""The spellings of a language the app sends engines, and the codes they name.

VoiceStudio names a language several ways: the Electron pickers' labels and
codes (``electron/src/shared/utils/languages.js``: "Arabic"/"ar", "Chinese
(Simplified)"/"cmn-Hans"), OmniVoice's own names and ids, which Clone and Voice
Design list ("Standard Arabic"/"arb"), and region or script tags from API
callers ("pt-BR"). Each engine reads one vocabulary. These helpers resolve every
spelling, so an engine accepts each spelling of a language it speaks, receives
it in its own vocabulary, and still refuses a language it cannot speak.

Pure data at import: no model, torch or network import (only
:func:`language_input_changed` reads the engine adapters it names).
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Optional

#: Picker labels OmniVoice's vocabulary spells another way or lacks, with the
#: code the picker sends beside each, plus two common alternatives (Mandarin,
#: Tagalog). tests/test_engine_language_spellings.py keeps it in step with
#: languages.js.
PICKER_LANGUAGE_CODES = {
    "arabic": "ar",
    "chinese (simplified)": "cmn-Hans",
    "chinese (traditional)": "cmn-Hant",
    "haitian creole": "ht",
    "kurdish": "ku",
    "kyrgyz": "ky",
    "latin": "la",
    "mandarin": "zh",
    "pashto": "ps",
    "punjabi": "pa",
    "samoan": "sm",
    "scots gaelic": "gd",
    "sundanese": "su",
    "tagalog": "tl",
}

#: Codes for the language another code names. A macrolanguage's code means one
#: member in practice: an engine that declares "ar" speaks Standard Arabic,
#: "zh" is Mandarin in either script, and "ku" is Kurmanji, as Dub translates
#: it. Filipino is standard Tagalog, Bokmål and Nynorsk are both Norwegian, and
#: "jw" is Whisper's code for Javanese. Other members (Egyptian Arabic,
#: Cantonese, Sorani) stay distinct: an engine that speaks the standard
#: language does not speak them. OmniVoice lists some languages only under the
#: codes on the left.
_SAME_LANGUAGE = {
    "arb": "ar",
    "cmn": "zh",
    "fil": "tl",
    "jw": "jv",
    "kmr": "ku",
    "nb": "no",
    "nn": "no",
    "npi": "ne",
    "ory": "or",
    "plt": "mg",
    "uzn": "uz",
    "ydd": "yi",
}

_ARABIC_SCRIPT = re.compile(r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufefc]")


def language_code(language: object) -> Optional[str]:
    """The code ``language`` names as spelled ("arb", "cmn"), None for Auto.

    OmniVoice's names and ids, the pickers' labels and codes, and region or
    script tags ("pt-BR", "cmn-Hans") resolve to their base code. A name no
    table knows comes back lowercased, so an engine with a finite set rejects
    it instead of silently using its default language.
    """
    if language is None:
        return None
    if not isinstance(language, str):
        raise ValueError("Language must be a string or None")
    value = language.strip().lower()
    if not value or value == "auto":
        return None
    from omnivoice.utils.lang_map import LANG_NAME_TO_ID

    code = LANG_NAME_TO_ID.get(value) or PICKER_LANGUAGE_CODES.get(value, value)
    head = code.replace("_", "-").split("-", 1)[0].lower()
    if head.isascii() and head.isalpha() and len(head) in (2, 3):
        return head
    return value


def engine_language_code(language: object) -> Optional[str]:
    """``language`` as the ISO 639 code engines declare, or None when it names none.

    A standard variety is named by its macrolanguage ("Standard Arabic" → "ar",
    "cmn-Hans" → "zh"). None for Auto and for a name no table knows, so the
    caller can forward that unchanged.
    """
    if not isinstance(language, str):
        return None
    code = language_code(language)
    if code is None or not (code.isascii() and code.isalpha() and len(code) in (2, 3)):
        return None
    return _SAME_LANGUAGE.get(code, code)


@lru_cache(maxsize=64)
def _spoken(declared: tuple[str, ...]) -> dict[str, str]:
    """Each language a declared set names, by its macrolanguage code, to its entry."""
    spoken: dict[str, str] = {}
    for entry in declared:
        code = language_code(entry)
        if code is not None:
            spoken.setdefault(_SAME_LANGUAGE.get(code, code), entry)
    return spoken


def declared_language(code: Optional[str], declared) -> Optional[str]:
    """The entry of ``declared`` that names the language ``code`` names, else None.

    An exact entry wins, so an engine that declares "cmn" receives "cmn". Any
    other code for the same language matches too ("arb" on an engine that
    declares "ar"); a code is never guessed from its first letters.
    """
    if code is None:
        return None
    if code in declared:
        return code
    return _spoken(tuple(declared)).get(_SAME_LANGUAGE.get(code, code))


def _mostly_arabic_script(text: object) -> bool:
    """Whether most of ``text``'s letters are written in Arabic script."""
    letters = [char for char in text if char.isalpha()] if isinstance(text, str) else []
    return sum(1 for char in letters if _ARABIC_SCRIPT.match(char)) * 2 > len(letters)


def omnivoice_language(language: object, text: object = None) -> object:
    """``language`` as the OmniVoice vocabulary id that guides the model.

    The pickers' labels and codes ("Arabic", "cmn-Hans", "Kurdish", "ku"),
    OmniVoice's own names and region tags resolve to the id the model was
    trained with ("arb", "zh", "kmr"). Kurdish follows the script of ``text``:
    Sorani (Central Kurdish) is written in Arabic script, Kurmanji (Northern)
    in Latin. None for Auto. A language the vocabulary lacks is returned as it
    came, and the model reads it as Auto, as before.
    """
    if not isinstance(language, str):
        return language
    code = language_code(language)
    if code is None:
        return None
    from omnivoice.utils.lang_map import LANG_IDS

    if code in LANG_IDS:
        return code
    same = _SAME_LANGUAGE.get(code, code)
    if same == "ku":
        return "ckb" if _mostly_arabic_script(text) else "kmr"
    if same in LANG_IDS:
        return same
    return next((member for member, macro in _SAME_LANGUAGE.items()
                 if macro == same and member in LANG_IDS), language)


# ── What an engine receives, for cache keys ─────────────────────────────────

#: Long-form caches key a chapter by the language as the request names it
#: ("Arabic"), while each engine receives its own spelling of it. When an
#: adapter changes that spelling, audio rendered before must not be replayed:
#: the keys of a language an engine now receives differently carry this
#: revision (:func:`language_input_changed`); every other key stays as it
#: was. 1: OmniVoice reads the pickers' Arabic, both Chinese scripts, Kurdish,
#: region tags and a few others as those languages instead of Auto, and
#: sidecars receive their own codes ("German" reached Confucius4 as "ge",
#: "Swedish" Supertonic-3 as Swahili's "sw"). Bump it, and teach
#: :func:`_language_inputs` what builds before sent, with the next change.
LANGUAGE_INPUT_RENDER = 1

#: The names the omnivoice-gguf binary was given before revision 1; any other
#: code went capitalized ("vi" as "Vi", which it read as Auto).
_GGUF_NAMES_BEFORE = {
    "en": "English", "fr": "French", "de": "German", "es": "Spanish", "it": "Italian",
    "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "ar": "Arabic",
    "ru": "Russian",
}


def _omnivoice_reads(language: object) -> Optional[str]:
    """The id OmniVoice's model reads ``language`` as — its own
    ``_resolve_language``: an id, or a name in any case — None for Auto."""
    if not isinstance(language, str) or language.lower() == "none":
        return None
    from omnivoice.utils.lang_map import LANG_IDS, LANG_NAME_TO_ID

    if language in LANG_IDS:
        return language
    return LANG_NAME_TO_ID.get(language.lower())


def _dots_reads(value: object) -> Optional[str]:
    """The language dots.tts reads its sidecar's ``value`` as: a 2-letter
    code, or a plain language name ("Arabic", read as "ar"); any other
    spelling ("Chinese (Simplified)", "cmn-Hans") as itself."""
    if not isinstance(value, str):
        return None
    if len(value) == 2 and value.isalpha():
        return value.lower()
    if all(word.isalpha() for word in value.split()):
        code = engine_language_code(value)
        if code and len(code) == 2:
            return code
    return value.lower()


def _guarded(engine_cls, language: object) -> Optional[str]:
    """The declared code ``engine_cls``'s language check passes on for
    ``language`` (what its sidecar is sent); raises where it refuses it."""
    return object.__new__(engine_cls)._check_language(language)


def _language_inputs(engine_id: str):
    """``(before, now)``: what ``engine_id``'s model read for a request's
    language before :data:`LANGUAGE_INPUT_RENDER`, and what it reads now,
    each as a value two spellings of one input compare equal by. ``None``
    for an engine whose input did not change."""
    if engine_id in ("omnivoice", "omnivoice-subprocess"):
        # The model resolves names and ids itself; it was handed the
        # request's spelling, and is handed its own id now.
        return _omnivoice_reads, lambda language: _omnivoice_reads(omnivoice_language(language))
    if engine_id == "omnivoice-gguf":
        from engines.omnivoice_gguf.backend import _iso_to_omnivoice_lang

        def gguf_before(language):
            value = language.strip().lower()
            return _omnivoice_reads(_GGUF_NAMES_BEFORE.get(value, value.capitalize()))

        return gguf_before, lambda language: _omnivoice_reads(_iso_to_omnivoice_lang(language))
    if engine_id == "supertonic3":
        from engines.supertonic3.backend import sidecar_language
        from engines.supertonic3.sidecar import _normalize_lang

        # The sidecar kept the first two letters of what it was sent.
        return (lambda language: language.strip().lower()[:2],
                lambda language: _normalize_lang(sidecar_language(language)))
    if engine_id == "confucius4-tts":
        from engines.confucius4 import Confucius4Backend
        from engines.confucius4.main import _normalize_language

        return _normalize_language, lambda language: _normalize_language(
            _guarded(Confucius4Backend, language))
    if engine_id == "cosyvoice":
        from engines.cosyvoice_subprocess import CosyVoiceSubprocessBackend
        from engines.cosyvoice_subprocess.main import _lang_tag

        return _lang_tag, lambda language: _lang_tag(_guarded(CosyVoiceSubprocessBackend, language))
    if engine_id == "dots-tts":
        from engines.dots_tts import sidecar_language as dots_language
        from engines.dots_tts.main import _normalize_language as dots_value

        return (lambda language: _dots_reads(dots_value(language)),
                lambda language: _dots_reads(dots_value(dots_language(language))))
    if engine_id == "moss-tts-v15":
        from engines.moss_tts_v15 import sidecar_language as moss_language
        from engines.moss_tts_v15.main import _resolve_language as moss_name

        return (lambda language: (moss_name(language) or "").lower(),
                lambda language: (moss_name(moss_language(language)) or "").lower())
    return None


def language_input_changed(engine_id: str, language: object) -> bool:
    """Whether ``engine_id`` receives ``language`` otherwise than builds
    before :data:`LANGUAGE_INPUT_RENDER` did — what its model reads then and
    now, compared, so a respelling it reads the same way changes nothing.
    False for Auto, for an engine whose input did not change, and for a
    language it refuses now (nothing renders under that key).

    A change that follows the text (OmniVoice picks Kurdish's variety by
    script) is a change for any text, so the language alone decides."""
    if not isinstance(language, str) or language.strip().lower() in ("", "auto"):
        return False
    try:
        inputs = _language_inputs(engine_id)
    except Exception:  # noqa: BLE001 — an adapter that cannot be read keeps its keys
        return False
    if inputs is None:
        return False
    before, now = inputs
    try:
        then = before(language)
    except Exception:  # noqa: BLE001 — nothing to compare with: the keys stay
        return False
    try:
        return now(language) != then
    except Exception:  # noqa: BLE001 — refused now: nothing renders under the key
        return False
