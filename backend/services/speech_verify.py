"""Listen back to rendered phrases and retake the ones that say something else.

Opt-in for long-form renders (``verify_speech``). Masked, non-autoregressive
engines occasionally drop, repeat or swap words inside a take; nothing in the
audio itself reveals it. Each rendered phrase is transcribed with the ASR
engine that is already installed (never downloading one), compared with the
text it was asked to say, and retaken with a fresh seed when the two differ
too much. The best-matching take is kept, and phrases that still differ after
the retries are reported so the user knows what to listen to.

Verification never fails a render: no installed ASR, or one that keeps
failing, simply turns it off for the rest of the chapter.
"""
from __future__ import annotations

import logging
import os
import re
import tempfile
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


def transcribe_take(audio, sample_rate: int) -> Optional[str]:
    """Transcript of one rendered take, or ``None`` when no ASR can say.

    Uses the installed recognizer through ``transcribe_reference``: it picks
    the selected offline engine, else an installed dictation engine, and never
    downloads weights.
    """
    from services.asr_backend import transcribe_reference
    from services.audio_io import atomic_save_wav

    handle, path = tempfile.mkstemp(prefix="voicestudio-verify-", suffix=".wav")
    os.close(handle)
    try:
        wav = audio if audio.dim() > 1 else audio.unsqueeze(0)
        atomic_save_wav(path, wav.detach().float().cpu(), sample_rate)
        return transcribe_reference(path)
    except Exception:  # noqa: BLE001 — verification must never fail a render
        logger.warning("speech check: transcription failed", exc_info=True)
        return None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


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
    that still differ are kept for the render summary.
    """

    def __init__(self, sample_rate: int, *,
                 transcribe: Callable[[object, int], Optional[str]] = transcribe_take,
                 threshold: float = MATCH_THRESHOLD, retries: int = MAX_RETRIES):
        self.sample_rate = sample_rate
        self.transcribe = transcribe
        self.threshold = threshold
        self.retries = retries
        self.checked = 0
        self.retaken = 0
        self.suspect: list[dict] = []
        self.unavailable = False
        self._failures = 0

    def may_answer(self) -> bool:
        """Whether a recognizer may answer, told without loading one: ``False``
        only when the installed one this verifier asks by default has none to
        ask. A verifier given its own ``transcribe`` is always asked."""
        return self.transcribe is not transcribe_take or recognizer_installed()

    def _score(self, text: str, audio) -> Optional[float]:
        if audio is None or getattr(audio, "shape", (0,))[-1] == 0:
            return 0.0
        heard = self.transcribe(audio, self.sample_rate)
        if heard is None:
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
                "suspect": list(self.suspect), "unavailable": self.unavailable}
