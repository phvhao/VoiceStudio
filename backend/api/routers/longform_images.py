"""The picture library long-form scripts show with ``[image: NAME]``.

``services.longform_images`` keeps the files; this is their HTTP surface for
the editors' picker, the reader's slideshow and the tag cards.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from core.browser_guard import reject_cross_site_get
from services import longform_images

router = APIRouter()

_STATUS = {"too_large": 413, "unsupported": 415, "too_many_pixels": 422}


@router.get("/longform/images")
def list_longform_images() -> dict:
    """Every picture in the library, the newest first."""
    return {"images": longform_images.listing()}


@router.post("/longform/images")
async def upload_longform_image(file: UploadFile = File(...)) -> dict:
    """Keep a picture for scripts to show. The file is decoded and written
    again (orientation applied, metadata dropped, at most 3840 px); the same
    picture uploaded twice keeps one name (``reused``)."""
    data = await file.read(longform_images.MAX_UPLOAD_BYTES + 1)
    try:
        image = await asyncio.to_thread(longform_images.save, data, file.filename)
    except longform_images.ImageRejected as exc:
        raise HTTPException(status_code=_STATUS.get(exc.code, 422),
                            detail={"code": f"image_{exc.code}", "message": str(exc)})
    return {"image": image}


# A media GET, like the app's audio: refused when another site asks for it.
@router.get("/longform/images/{name}", dependencies=[Depends(reject_cross_site_get)])
def get_longform_image(name: str, thumb: bool = False) -> FileResponse:
    """The picture ``name`` (``thumb``: a small JPEG of it for the picker)."""
    path = longform_images.thumb_of(name) if thumb else longform_images.path_of(name)
    if path is None:
        raise HTTPException(status_code=404, detail="No such picture")
    media = "image/png" if path.endswith(".png") else "image/jpeg"
    # Names are reused after a picture is removed: always ask again (ETag).
    return FileResponse(path, media_type=media, headers={"Cache-Control": "no-cache"})


@router.delete("/longform/images/{name}")
def delete_longform_image(name: str) -> dict:
    """Remove the picture ``name`` from the library. Scripts that still name
    it show the picture before it instead (the editor says it is missing)."""
    if not longform_images.delete(name):
        raise HTTPException(status_code=404, detail="No such picture")
    return {"deleted": name.strip().lower()}
