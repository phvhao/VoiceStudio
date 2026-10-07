"""The reading fonts bundled with the app, served to its own reader.

``GET /fonts`` lists the families (``services.book_fonts``: the manifest in
``backend/assets/fonts``) and ``GET /fonts/{family}/{file}`` serves one of
their WOFF2 files or their ``OFL.txt``, so the reader shows a book in the
font its design chose — from this backend, never the network. HTML exports
embed the same files.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from services import book_fonts

router = APIRouter()

#: The files never change for a given app version: a browser may keep them.
_CACHE = "public, max-age=604800"


@router.get("/fonts")
def list_fonts() -> dict:
    """Every bundled family: id, family name, category, licence, and its
    files (style, weight range, size)."""
    return {"families": book_fonts.listing(), "system": book_fonts.SYSTEM}


@router.get("/fonts/{font_id}/{file_name}")
def font_file(font_id: str, file_name: str) -> FileResponse:
    """One file of a bundled family — a font or its licence. 404 for any
    name the manifest does not list."""
    path = book_fonts.file_path(font_id, file_name)
    if path is None:
        raise HTTPException(status_code=404, detail="No such font file")
    media = "font/woff2" if file_name.endswith(".woff2") else "text/plain; charset=utf-8"
    return FileResponse(path, media_type=media, headers={"Cache-Control": _CACHE})
