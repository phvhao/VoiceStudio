"""A clip length reads in the locale's own unit of seconds.

Every voice card in the Clone chooser shows its reference's length through
``clone.duration_seconds``. Machine translation had read the English "12s" as
a plural: Turkish showed "12'ler" ("the twelves") and Dutch "12's"; Russian,
Arabic and Chinese showed a Latin "s" where their other strings write "с", "ث"
and "秒". The unit after ``{{seconds}}`` must be one the same locale already
writes after a number of seconds elsewhere.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

_LOCALES = Path(__file__).resolve().parents[1] / "electron/src/renderer/src/i18n/locales"
# Strings that put a unit right after a number of seconds.
_SECONDS = re.compile(r"\{\{seconds\}\}\s*([^\s{}()（）,.:;!?'’\"]+\.?)")


def _strings(node, path=""):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _strings(value, f"{path}.{key}" if path else key)
    elif isinstance(node, str):
        yield path, node


@pytest.mark.parametrize("locale", sorted(path.stem for path in _LOCALES.glob("*.json")))
def test_a_clip_length_uses_the_locales_own_unit_of_seconds(locale):
    catalog = json.loads((_LOCALES / f"{locale}.json").read_text(encoding="utf-8"))
    duration = catalog["clone"]["duration_seconds"]
    match = _SECONDS.search(duration)
    assert match, f"{locale}: clone.duration_seconds has no unit after {{{{seconds}}}}: {duration!r}"
    unit = match.group(1)
    elsewhere = {
        found.group(1)
        for path, text in _strings(catalog)
        if path != "clone.duration_seconds"
        for found in _SECONDS.finditer(text)
    }
    assert unit in elsewhere, (
        f"{locale}: clone.duration_seconds writes {unit!r} after the seconds; "
        f"this locale writes {sorted(elsewhere)} elsewhere"
    )


def test_turkish_and_dutch_no_longer_read_as_plurals():
    for locale, plural in (("tr", "'ler"), ("nl", "'s")):
        catalog = json.loads((_LOCALES / f"{locale}.json").read_text(encoding="utf-8"))
        assert plural not in catalog["clone"]["duration_seconds"]
