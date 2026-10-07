"""The reading fonts bundled for HTML books and the reader.

* ``backend/assets/fonts/manifest.json`` is the one source of truth: every
  file it lists is there with its size and SHA-256, every family ships its
  ``OFL.txt``, and every family writes Vietnamese in full.
* A family with a Reserved Font Name is shipped whole (only recompressed): a
  subset is a Modified Version, which may not use that name (OFL-FAQ 2.6).
* ``GET /fonts`` lists them and ``GET /fonts/{id}/{file}`` serves only what
  the manifest lists; Docker and the desktop package carry them.
"""
from __future__ import annotations

import fnmatch
import hashlib
import importlib
import json
import pathlib
import re

import pytest

_ROOT = pathlib.Path(__file__).resolve().parent.parent
_FONTS = _ROOT / "backend" / "assets" / "fonts"
#: Every precomposed Vietnamese letter, upper and lower case.
_VIETNAMESE = sorted(set(
    "ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯư"
    + "".join(chr(c) for c in range(0x1EA0, 0x1EFA))))


def _manifest() -> dict:
    return json.loads((_FONTS / "manifest.json").read_text(encoding="utf-8"))


def _mod(name: str):
    return importlib.import_module(name)


def test_the_manifest_lists_every_file_with_its_hash_and_licence():
    doc = _manifest()
    families = doc["families"]
    assert len(families) >= 12
    listed = set()
    for family in families:
        assert family["license"] == "OFL-1.1"
        licence = _FONTS / family["license_file"]
        text = licence.read_bytes()
        assert b"SIL OPEN FONT LICENSE VERSION 1.1" in text.upper(), family["id"]
        assert hashlib.sha256(text).hexdigest() == family["license_sha256"], family["id"]
        listed.add(licence)
        for entry in family["files"]:
            path = _FONTS / entry["file"]
            data = path.read_bytes()
            assert data[:4] == b"wOF2", entry["file"]
            assert len(data) == entry["bytes"], entry["file"]
            assert hashlib.sha256(data).hexdigest() == entry["sha256"], entry["file"]
            listed.add(path)
    # Nothing ships that the manifest does not list.
    on_disk = {p for p in _FONTS.rglob("*") if p.is_file() and p.name != "manifest.json"}
    assert on_disk == listed
    # The backend reads the same manifest.
    assert {f.id for f in _mod("services.book_fonts").families().values()} == {
        f["id"] for f in families}


def test_every_family_writes_vietnamese_in_full():
    ttlib = pytest.importorskip("fontTools.ttLib")
    pytest.importorskip("brotli")
    for family in _manifest()["families"]:
        for entry in family["files"]:
            cmap = ttlib.TTFont(_FONTS / entry["file"]).getBestCmap()
            missing = [c for c in _VIETNAMESE if ord(c) not in cmap]
            assert not missing, (entry["file"], "".join(missing))


#: "Reserved Font Name(s) "A" and "B"" — the quotes straight or curly, single
#: or double (Source Serif 4's own copyright reads 'Source').
_RFN = re.compile(r"Reserved\s+Font\s+Names?\s+((?:[\"'“‘][^\"'”’]+[\"'”’][\s,]*(?:and\s+)?)+)",
                  re.IGNORECASE)


def _reserved(text: str) -> set:
    return {name.strip() for group in _RFN.findall(text)
            for name in re.findall(r"[\"'“‘]([^\"'”’]+)[\"'”’]", group)}


def test_a_reserved_font_name_ships_only_with_the_whole_font():
    # Read from the licence AND from each font's own copyright and licence
    # records: google/fonts' OFL.txt for Source Serif 4 omits the "Source"
    # its binaries reserve, and a subset shipped under it broke OFL §3.
    ttlib = pytest.importorskip("fontTools.ttLib")
    pytest.importorskip("brotli")
    for family in _manifest()["families"]:
        reserved = _reserved((_FONTS / family["license_file"]).read_text(encoding="utf-8"))
        for entry in family["files"]:
            names = ttlib.TTFont(_FONTS / entry["file"])["name"]
            reserved |= _reserved(" ".join(str(names.getDebugName(i) or "") for i in (0, 13)))
        if reserved:
            assert family["prepared"] == "recompressed", (family["id"], reserved)
            assert set((family["reserved_font_name"] or "").split(", ")) == reserved, family["id"]
        else:
            assert family["prepared"] == "subset", family["id"]
            assert family["reserved_font_name"] is None, family["id"]


def test_the_reserved_name_reader_matches_every_quote_style():
    assert _reserved("(c) 2014 Adobe, with Reserved Font Name 'Source'.") == {"Source"}
    assert _reserved("with Reserved Font Name “Lora”.") == {"Lora"}
    assert _reserved('Reserved Font Names "A Sans" and "B"') == {"A Sans", "B"}
    # The OFL's own definition of the term reserves nothing.
    assert not _reserved('"Reserved Font Name" refers to any names specified as such')


def test_the_font_route_serves_only_what_the_manifest_lists():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(_mod("api.routers.fonts").router)
    client = TestClient(app)
    listing = client.get("/fonts").json()
    assert listing["system"] == "system"
    family = next(f for f in listing["families"] if f["id"] == "literata")
    assert family["category"] == "serif" and family["license"] == "OFL-1.1"
    name = family["files"][0]["file"]
    got = client.get(f"/fonts/literata/{name}")
    assert got.status_code == 200 and got.headers["content-type"] == "font/woff2"
    assert got.content == (_FONTS / "literata" / name).read_bytes()
    assert "max-age" in got.headers["cache-control"]
    assert b"Open Font License" in client.get("/fonts/literata/OFL.txt").content
    for path in ("/fonts/literata/manifest.json", "/fonts/nope/OFL.txt",
                 "/fonts/literata/..%2Fmanifest.json", "/fonts/..%2F..%2Fmain.py/x"):
        assert client.get(path).status_code == 404, path


def test_docker_and_the_package_carry_the_fonts():
    # The image copies the whole backend; nothing ignored may reach the fonts.
    assert "COPY backend/ ./backend/" in (_ROOT / "deploy" / "Dockerfile").read_text(
        encoding="utf-8")
    patterns = [line.strip().rstrip("/") for line in
                (_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.startswith("#")]
    for path in _FONTS.rglob("*"):
        rel = path.relative_to(_ROOT).as_posix()
        assert not any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(path.name, p)
                       or rel.startswith(p + "/") for p in patterns), rel
    # The desktop package copies backend/** but caches (packaging-contract.mjs
    # checks the built package).
    config = (_ROOT / "electron" / "electron-builder.config.mjs").read_text(encoding="utf-8")
    block = config[config.index("from: '../backend'"):]
    block = block[:block.index("}")]
    assert "'**/*'" in block and "fonts" not in block and "woff" not in block
