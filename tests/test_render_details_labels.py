"""Every setting a render records is one the Projects page can show.

``_render_summary`` records each ``ExpressiveOptions`` field that differs from
its default, and ``RenderDetails`` (``render-details.tsx``) shows only the keys
its ``OPTION_LABELS`` names — so a field added without a label silently drops
out of "How it was made" (``level_voices``/``voice_gains`` and the reading
switches did exactly that). This pins the two lists together.
"""

import dataclasses
import pathlib
import re

from services.audiobook import ExpressiveOptions

_RENDER_DETAILS = (
    pathlib.Path(__file__).resolve().parents[1]
    / "electron/src/renderer/src/features/projects/render-details.tsx"
)


def _option_labels() -> set[str]:
    source = _RENDER_DETAILS.read_text(encoding="utf-8")
    block = re.search(r"const OPTION_LABELS[^=]*=\s*\{(.*?)\n\};", source, re.S)
    assert block, "OPTION_LABELS not found in render-details.tsx"
    return set(re.findall(r"^\s*(\w+):", block.group(1), re.M))


def test_every_recorded_option_has_a_label():
    fields = {field.name for field in dataclasses.fields(ExpressiveOptions)}
    assert fields - _option_labels() == set()


def test_labels_name_only_recorded_options():
    fields = {field.name for field in dataclasses.fields(ExpressiveOptions)}
    assert _option_labels() - fields == set()
