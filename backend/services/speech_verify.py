"""Listen back to rendered phrases and retake the ones that say something else.

Opt-in for long-form renders (``verify_speech``). Masked, non-autoregressive
engines occasionally drop, repeat or swap words inside a take; nothing in the
audio itself reveals it. Each rendered phrase is transcribed with the ASR
engine that is already installed (never downloading one), compared with the
text it was asked to say, and retaken with a fresh seed when the two differ
too much. The best-matching take is kept, and phrases that still differ after
the retries are reported so the user knows what to listen to.

One recognizer serves a whole render: the render holds a
:func:`recognizer_lease` from its first check to its end, so the model loads
once instead of before every phrase, and is told the render's language
(:func:`recognizer_language`) instead of detecting it each time.

Verification never fails a render: no installed ASR, or one that keeps
failing, simply turns it off for the rest of the chapter, and the summary says
which of the two it was (``no_recognizer``).
"""
from __future__ import annotations

import logging
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Callable, Optional

logger = logging.getLogger("omnivoice.speech_verify")

#: Takes whose transcript matches the text less than this are retaken.
MATCH_THRESHOLD = 0.8
#: Extra takes per phrase before it is reported.
MAX_RETRIES = 2
#: Phrases shorter than this (letters/digits) are too short for ASR to judge.
MIN_CHECK_CHARS = 12
#: Consecutive transcription failures that turn verification off.
MAX_ASR_FAILURES = 2

_TAG_RE = re.compile(r"\[[^\]]*\]")
_WORD_CHARS_RE = re.compile(r"[^\W_]+", re.UNICODE)


def comparable(text: str) -> str:
    """Letters and digits only, lower-cased and without diacritics.

    Bracket tags are not words. Tone marks and accents are dropped because
    speech recognizers misplace them far more often than a voice says the
    wrong word (Vietnamese "Hạ" heard as "Hà" is the same take). ``đ`` has no
    decomposition, so it is mapped by hand.
    """
    text = _TAG_RE.sub(" ", text or "").lower().replace("đ", "d")
    text = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    return "".join(_WORD_CHARS_RE.findall(text))


def match_score(expected: str, heard: str) -> float:
    """How closely ``heard`` says ``expected``, from 0 to 1.

    A character-level ratio over :func:`comparable` text: a dropped clause
    shortens the transcript, a repeated one lengthens it, a swapped one breaks
    the order, and each lowers the score. Works the same for spaced and
    unspaced scripts.
    """
    a, b = comparable(expected), comparable(heard)
    if not a:
        return 1.0
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


def checkable(text: str) -> bool:
    return len(comparable(text)) >= MIN_CHECK_CHARS


#: Whisper's language codes (faster-whisper, WhisperX and mlx-whisper share
#: them). Cantonese (``yue``) is left out: only large-v3 knows it.
_WHISPER_LANGUAGES = frozenset({
    "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "ca",
    "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fa", "fi", "fo", "fr",
    "gl", "gu", "ha", "haw", "he", "hi", "hr", "ht", "hu", "hy", "id", "is", "it",
    "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb", "ln", "lo", "lt", "lv",
    "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "nn", "no",
    "oc", "pa", "pl", "ps", "pt", "ro", "ru", "sa", "sd", "si", "sk", "sl", "sn",
    "so", "sq", "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl", "tr",
    "tt", "uk", "ur", "uz", "vi", "yi", "yo", "zh",
})
#: Codes of the app's language table (OmniVoice's ISO 639 ids) that Whisper
#: spells another way.
_WHISPER_SPELLING = {
    "arb": "ar", "cmn": "zh", "zho": "zh", "fil": "tl", "jv": "jw", "nb": "no",
    "npi": "ne", "uzn": "uz", "ydd": "yi", "plt": "mg", "pbt": "ps", "pbu": "ps",
    "pst": "ps",
}
#: Language names callers use that OmniVoice's table does not list: the
#: long-form pickers' labels (``electron/src/shared/utils/languages.js``) and
#: Whisper's own names.
_NAME_ALIASES = {
    "arabic": "ar", "chinese (simplified)": "zh", "chinese (traditional)": "zh",
    "mandarin": "zh", "tagalog": "tl", "punjabi": "pa", "pashto": "ps",
    "myanmar": "my", "haitian creole": "ht", "sundanese": "su", "malagasy": "mg",
    "latin": "la", "faroese": "fo", "nynorsk": "nn",
}
#: The sample rate speech recognizers take.
_RECOGNIZER_RATE = 16000


def recognizer_language(language: Optional[str]) -> Optional[str]:
    """The Whisper language code for a render's ``language`` — a name from
    the language picker ("Vietnamese") or an ISO code ("vi", "pt-BR") — or
    ``None`` for Auto, an unknown name or a language Whisper does not know:
    the recognizer then detects it, as it did before. A recognizer is only
    told a code its model knows (``services.asr_backend``), because a code it
    does not know fails the transcription, and failed checks turn the check
    off."""
    if not isinstance(language, str):
        return None
    value = language.strip().lower()
    if not value or value == "auto":
        return None
    try:
        from omnivoice.utils.lang_map import LANG_NAME_TO_ID
    except Exception:  # noqa: BLE001 — names unknown here; ISO codes still map
        LANG_NAME_TO_ID = {}
    code = LANG_NAME_TO_ID.get(value) or _NAME_ALIASES.get(value)
    if code is None:
        head = value.replace("_", "-").split("-", 1)[0]
        if not (head.isascii() and head.isalpha() and len(head) in (2, 3)):
            return None
        code = head
    code = _WHISPER_SPELLING.get(code, code)
    return code if code in _WHISPER_LANGUAGES else None


def _waveform_16k(audio, sample_rate: int):
    """``audio`` — ``(samples,)`` or ``(channels, samples)`` — as the 16 kHz
    mono float32 array a speech recognizer takes."""
    import torch

    wav = torch.as_tensor(audio).detach().float().cpu()
    if wav.dim() > 1:
        wav = wav.reshape(-1, wav.shape[-1]).mean(dim=0)
    if sample_rate != _RECOGNIZER_RATE:
        import torchaudio

        wav = torchaudio.functional.resample(wav, sample_rate, _RECOGNIZER_RATE)
    return wav.contiguous().numpy()


def transcribe_take(audio, sample_rate: int, *, language: Optional[str] = None) -> Optional[str]:
    """Transcript of one rendered take, or ``None`` when no ASR can say.

    Asks the speech check's recognizer (``asr_backend.transcribe_check``):
    the selected offline engine, kept loaded while the render holds a
    :func:`recognizer_lease`, else an installed dictation engine or an
    installed fallback; it never downloads weights. The take goes over as a
    16 kHz mono array, and ``language`` (a Whisper code, see
    :func:`recognizer_language`) spares the recognizer detecting it.
    """
    from services.asr_backend import transcribe_check

    try:
        return transcribe_check(_waveform_16k(audio, sample_rate), language=language)
    except Exception:  # noqa: BLE001 — verification must never fail a render
        logger.warning("speech check: transcription failed", exc_info=True)
        return None


class _NoLease:
    """The lease of a render that does not check: holds nothing."""

    def release(self) -> None:
        pass

    def __enter__(self) -> "_NoLease":
        return self

    def __exit__(self, *_exc) -> None:
        pass


def recognizer_lease(*, checking: bool = True):
    """Keep the speech check's recognizer loaded for one render: taken where
    the render starts, released (``release()``, or the end of a ``with``
    block) where it ends, so its checks share one loaded model. A render that
    is not ``checking`` gets a lease that holds nothing."""
    if not checking:
        return _NoLease()
    from services.asr_backend import check_recognizer_lease

    return check_recognizer_lease()


def recognizer_installed() -> bool:
    """Whether :func:`transcribe_take` has an installed recognizer to ask,
    told without loading one (``False`` only when it would answer ``None``
    without trying)."""
    from services.asr_backend import reference_recognizer_installed

    return reference_recognizer_installed()


class SpeechVerifier:
    """Retake phrases whose transcript does not match their text.

    ``render(text, take)`` calls ``take(attempt)`` (attempt 0 first, then 1,
    2, ... for retakes) and returns the best take. Counters and the phrases
    that still differ are kept for the render summary. ``language`` is the
    render's language as the request names it (see
    :func:`recognizer_language`).
    """

    def __init__(self, sample_rate: int, *,
                 transcribe: Callable[[object, int], Optional[str]] = transcribe_take,
                 threshold: float = MATCH_THRESHOLD, retries: int = MAX_RETRIES,
                 language: Optional[str] = None):
        self.sample_rate = sample_rate
        self.transcribe = transcribe
        self.threshold = threshold
        self.retries = retries
        #: The Whisper code the recognizer is told (``None``: it detects).
        self.language = recognizer_language(language)
        self.checked = 0
        self.retaken = 0
        self.suspect: list[dict] = []
        self.unavailable = False
        #: Why the last take it could not listen to went unheard: no speech
        #: recognizer installed (``True``), or one that heard no words, failed
        #: or was busy (``False``).
        self.no_recognizer = False
        self._failures = 0

    def may_answer(self) -> bool:
        """Whether a recognizer may answer, told without loading one: ``False``
        only when the installed one this verifier asks by default has none to
        ask. A verifier given its own ``transcribe`` is always asked."""
        return self.transcribe is not transcribe_take or recognizer_installed()

    def hear(self, audio) -> Optional[str]:
        """What the recognizer hears in ``audio`` (``None``: it could not
        say), timed as the render's ``speech_check`` stage."""
        from core.render_trace import call as trace_call

        if self.transcribe is transcribe_take:
            return trace_call("speech_check", transcribe_take, audio, self.sample_rate,
                              language=self.language)
        return trace_call("speech_check", self.transcribe, audio, self.sample_rate)

    def _score(self, text: str, audio) -> Optional[float]:
        if audio is None or getattr(audio, "shape", (0,))[-1] == 0:
            return 0.0
        heard = self.hear(audio)
        if heard is None:
            self.no_recognizer = not self.may_answer()
            self._failures += 1
            if self._failures >= MAX_ASR_FAILURES:
                self.unavailable = True
                logger.warning("speech check: no working speech recognizer; "
                               "rendering continues without checking")
            return None
        self._failures = 0
        return match_score(text, heard)

    def render(self, text: str, take: Callable[[int], object]):
        audio = take(0)
        if self.unavailable or not checkable(text):
            return audio
        score = self._score(text, audio)
        if score is None:
            return audio
        self.checked += 1
        best, best_score, attempt = audio, score, 0
        while best_score < self.threshold and attempt < self.retries and not self.unavailable:
            attempt += 1
            self.retaken += 1
            candidate = take(attempt)
            candidate_score = self._score(text, candidate)
            if candidate_score is not None and candidate_score > best_score:
                best, best_score = candidate, candidate_score
        if best_score < self.threshold:
            logger.info("speech check: still differs after %d retake(s) (%.2f): %r",
                        attempt, best_score, text[:120])
            self.suspect.append({"text": text[:300], "score": round(best_score, 2)})
        return best

    def stats(self) -> dict:
        return {"checked": self.checked, "retaken": self.retaken,
                "suspect": list(self.suspect), "unavailable": self.unavailable,
                "no_recognizer": self.no_recognizer}
