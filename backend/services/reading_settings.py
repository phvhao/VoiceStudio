"""App-wide reading settings: how text is cut into takes and how it is checked.

One place (Settings → Reading, stored in ``prefs.json``) decides, for every
surface that renders text — Audiobook, Stories, Clone and Voice Design
(``/generate``), Batch — whether long text is read sentence by sentence, the
silence after each punctuation mark, and whether takes are checked with the
installed speech recognizer. A request may still carry its own values (a
book with its own pacing); those win over these defaults. Dubbing never uses
them: its lines must fit their subtitle slots.
"""
from __future__ import annotations

from typing import Optional

from services.chunked_tts import DEFAULT_PUNCTUATION_PAUSES, PUNCTUATION_CLASSES

PREF_KEY = "reading"
MAX_PAUSE_MS = 5000

DEFAULTS = {
    "phrase_rendering": True,
    "punctuation_pauses": dict(DEFAULT_PUNCTUATION_PAUSES),
    "split_commas": False,
    "verify_speech": False,
}


def _clean(raw) -> dict:
    """Stored (possibly partial or hand-edited) settings → a complete, valid dict."""
    data = raw if isinstance(raw, dict) else {}
    pauses = dict(DEFAULT_PUNCTUATION_PAUSES)
    stored = data.get("punctuation_pauses")
    if isinstance(stored, dict):
        for family in PUNCTUATION_CLASSES:
            value = stored.get(family)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                pauses[family] = int(max(0, min(int(value), MAX_PAUSE_MS)))
    return {
        "phrase_rendering": bool(data.get("phrase_rendering", DEFAULTS["phrase_rendering"])),
        "punctuation_pauses": pauses,
        "split_commas": bool(data.get("split_commas", False)),
        "verify_speech": bool(data.get("verify_speech", False)),
    }


def load() -> dict:
    """The current settings, defaults filled in. Never raises."""
    try:
        from core import prefs

        return _clean(prefs.get(PREF_KEY, {}))
    except Exception:  # noqa: BLE001 — a broken prefs file must not stop speech
        return _clean({})


def save(changes: dict) -> dict:
    """Merge ``changes`` into the stored settings and return the result."""
    from core import prefs

    current = load()
    merged = {**current, **{k: v for k, v in changes.items() if v is not None}}
    if isinstance(changes.get("punctuation_pauses"), dict):
        merged["punctuation_pauses"] = {**current["punctuation_pauses"],
                                        **changes["punctuation_pauses"]}
    clean = _clean(merged)
    prefs.set_(PREF_KEY, clean)
    return clean


def phrase_pauses(settings: Optional[dict] = None) -> Optional[dict]:
    """Per-mark pauses when sentence-by-sentence reading is on, else ``None``."""
    settings = settings if settings is not None else load()
    return dict(settings["punctuation_pauses"]) if settings["phrase_rendering"] else None
