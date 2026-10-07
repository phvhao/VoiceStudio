"""The reading fonts that ship with the app, for HTML books and the reader.

``backend/assets/fonts`` holds each family's WOFF2 files and its ``OFL.txt``,
and ``manifest.json`` — written by ``scripts/build_book_fonts.py`` at
development time — lists them: family, category, files (style, weight range,
size, SHA-256) and licence. That manifest is the one source of truth: the
export embeds only the families a book's design names, and ``GET /fonts``
serves the same files to the app's reader. Nothing here touches the network.

Pure apart from reading those files: no torch, no FastAPI.
"""
from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "assets", "fonts")
MANIFEST = "manifest.json"
#: The design choice that embeds no font: the reader's own fonts, the smallest page.
SYSTEM = "system"
CATEGORIES = ("serif", "sans", "display", "rounded", "handwriting", "mono")

#: What each category falls back to on a computer, Vietnamese included (Georgia
#: lacks its letters: they would come apart into marks).
SYSTEM_STACKS = {
    "serif": '"Noto Serif","Source Serif 4","Source Serif Pro",Cambria,"Times New Roman",serif',
    "sans": 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif',
    "display": '"Noto Serif Display","Noto Serif",Cambria,"Times New Roman",serif',
    "rounded": 'ui-rounded,"Nunito","Segoe UI",system-ui,-apple-system,Roboto,"Noto Sans",sans-serif',
    "handwriting": '"Segoe Print","Comic Sans MS","Noto Sans",system-ui,sans-serif',
    "mono": 'ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,"Liberation Mono",monospace',
}

_ID_RE = re.compile(r"^[a-z0-9-]{1,40}$")
_FILE_RE = re.compile(r"^[A-Za-z0-9-]{1,80}\.woff2$")


@dataclass(frozen=True)
class FontFile:
    name: str           # the file name inside the family's folder
    style: str          # "normal" | "italic"
    weight: tuple       # (lowest, highest): one weight, or a variable font's range
    size: int
    sha256: str


@dataclass(frozen=True)
class FontFamily:
    id: str
    family: str
    category: str
    files: tuple
    license_file: str

    @property
    def size(self) -> int:
        return sum(f.size for f in self.files)

    def faces(self, *, italic: bool = True) -> tuple:
        return tuple(f for f in self.files if italic or f.style != "italic")


@lru_cache(maxsize=1)
def families() -> dict:
    """Every bundled family by id, as the manifest lists it; ``{}`` when the
    manifest is missing or unreadable (the app then offers system fonts only)."""
    try:
        with open(os.path.join(FONTS_DIR, MANIFEST), encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return {}
    found = {}
    for item in doc.get("families") or []:
        try:
            fid = str(item["id"])
            files = tuple(
                FontFile(name=str(f["file"]).split("/", 1)[1], style=str(f["style"]),
                         weight=(int(f["weight"][0]), int(f["weight"][1])),
                         size=int(f["bytes"]), sha256=str(f["sha256"]))
                for f in item["files"])
            family = FontFamily(id=fid, family=str(item["family"]),
                                category=str(item["category"]), files=files,
                                license_file=str(item["license_file"]).split("/", 1)[1])
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if (_ID_RE.fullmatch(fid) and family.category in CATEGORIES and files
                and all(_FILE_RE.fullmatch(f.name) and f.style in ("normal", "italic")
                        for f in files)):
            found[fid] = family
    return found


def family(font_id: Optional[str]) -> Optional[FontFamily]:
    return families().get(font_id or "")


def file_path(font_id: str, name: str) -> Optional[str]:
    """The path of a bundled family's file — one of its fonts or its licence —
    or ``None`` for anything the manifest does not list (no other path in the
    folder is ever reached)."""
    found = family(font_id)
    if found is None or not (name == found.license_file or any(f.name == name for f in found.files)):
        return None
    root = os.path.realpath(FONTS_DIR)
    path = os.path.realpath(os.path.join(root, found.id, name))
    if os.path.commonpath([path, root]) != root or not os.path.isfile(path):
        return None
    return path


def stack(font_id: Optional[str], category: str) -> str:
    """The CSS ``font-family`` for a design's font: the bundled family first
    (when ``font_id`` names one) and the computer's fonts of its kind after
    it; else the computer's fonts of ``category``."""
    fallback = SYSTEM_STACKS.get(category, SYSTEM_STACKS["sans"])
    found = family(font_id)
    if found is None:
        return fallback
    return f'"{found.family}",{SYSTEM_STACKS.get(found.category, fallback)}'


def face_css(font_ids, *, italic: bool = True) -> str:
    """``@font-face`` rules embedding each bundled family of ``font_ids`` (each
    once) as base64 WOFF2 — a page opened from disk cannot load a font file
    beside it in every browser, so the page carries them. Unknown ids and
    :data:`SYSTEM` embed nothing; ``italic`` false leaves italics out."""
    ids = [f for f in dict.fromkeys(font_ids) if family(f) is not None]
    return "".join(_family_faces(f, italic) for f in ids)


@lru_cache(maxsize=64)
def _family_faces(font_id: str, italic: bool) -> str:
    """One family's ``@font-face`` rules, read once: the files ship with the app."""
    found = family(font_id)
    rules = []
    for face in found.faces(italic=italic) if found else ():
        path = file_path(found.id, face.name)
        if path is None:
            continue
        with open(path, "rb") as fh:
            data = base64.b64encode(fh.read()).decode("ascii")
        low, high = face.weight
        weight = f"{low} {high}" if low != high else str(low)
        rules.append(f'@font-face{{font-family:"{found.family}";font-style:{face.style};'
                     f"font-weight:{weight};font-display:swap;"
                     f"src:url(data:font/woff2;base64,{data}) format(\"woff2\")}}")
    return "".join(rules)


def listing() -> list:
    """The bundled families as ``GET /fonts`` lists them."""
    return [{"id": f.id, "family": f.family, "category": f.category, "bytes": f.size,
             "license": "OFL-1.1", "license_file": f.license_file,
             "files": [{"file": face.name, "style": face.style, "weight": list(face.weight),
                        "bytes": face.size} for face in f.files]}
            for f in families().values()]
