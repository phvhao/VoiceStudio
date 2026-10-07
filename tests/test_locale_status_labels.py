"""Status labels shown on their own start with a capital letter in every locale.

Settings → Models shows these keys alone on chips, buttons, summaries and status
lines, next to labels such as "Selected" and "In memory". Machine translation
lower-cased many of them ("không có sẵn", "nicht verfügbar", "installed"), left
a trailing colon on others ("安装失败："), and translated a few as the wrong word
entirely ("working" for an install in progress). None of these keys is used
inside a sentence, so each must read as a label in its own right; the engine
reason sentences the renderer shows for backend reason codes are held to the
same rule.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

_LOCALES = Path(__file__).resolve().parents[1] / "electron/src/renderer/src/i18n/locales"

STANDALONE = (
    "modelSettings.available",
    "modelSettings.unavailable",
    "modelSettings.select",
    "modelSettings.selected",
    "modelMaintenance.download",
    "modelMaintenance.install",
    "modelMaintenance.installing",
    "modelMaintenance.installed",
    "modelMaintenance.downloading",
    "modelMaintenance.failed",
    "modelMaintenance.incomplete",
    "modelMaintenance.inMemory",
    "modelMaintenance.online",
    "modelMaintenance.offline",
    "engines.testEngine",
    "engines.recheck",
    "engines.failed",
    "firstrun.chip_required",
    "firstrun.chip_optional",
    "firstrun.chip_recommended",
    "settings.llmskills_ready",
    "settings.llmskills_needs_setup",
    "settings.llmp_active_badge",
)


def _catalog(locale: str) -> dict:
    return json.loads((_LOCALES / f"{locale}.json").read_text(encoding="utf-8"))


def _labels(catalog: dict):
    for key in STANDALONE:
        value = catalog
        for part in key.split("."):
            value = value[part]
        yield key, value
    for group, reasons in catalog.get("engineReason", {}).items():
        for code, value in reasons.items():
            yield f"engineReason.{group}.{code}", value


def _starts_lower(text: str) -> bool:
    first = next((char for char in text if char.isalpha()), "")
    # Scripts without case (Arabic, Devanagari, Thai, CJK, Hangul) pass.
    return first.lower() != first.upper() and first.islower()


@pytest.mark.parametrize("locale", sorted(path.stem for path in _LOCALES.glob("*.json")))
def test_standalone_status_labels_read_as_labels(locale):
    problems = []
    for key, value in _labels(_catalog(locale)):
        if _starts_lower(value):
            problems.append(f"{key} starts lower-case: {value!r}")
        if value != value.strip() or value.rstrip().endswith((":", "：")):
            problems.append(f"{key} has trailing punctuation or space: {value!r}")
    assert not problems, f"{locale}:\n" + "\n".join(problems)


@pytest.mark.parametrize("locale", sorted(path.stem for path in _LOCALES.glob("*.json")))
def test_an_install_in_progress_is_not_called_work(locale):
    # en "working" was translated as "the work" / "is employed" in most
    # locales; the label sits on an Install button while it runs.
    installing = _catalog(locale)["modelMaintenance"]["installing"]
    english = _catalog("en")["modelMaintenance"]["installing"]
    assert english == "Installing"
    assert installing.casefold() not in {
        "working", "arbeiten", "trabajando", "travailler", "lavorando", "werken",
        "pracujący", "trabalhando", "работающий", "arbetar", "çalışıyor", "працює",
        "bekerja", "đang…", "काम…", "작업…", "働いている", "การทำงาน", "العمل", "处理中", "工作",
    }
