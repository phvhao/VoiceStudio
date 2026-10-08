"""MP4 video export of a finished long-form book (``services.book_video``).

``POST /audiobook/export/video`` checks what a video needs (the book, its
rendered timeline, an ffmpeg that can encode H.264 and burn captions, room on
the disk) and answers with an event stream while it is made; the finished file
waits in ``DATA_DIR/video_exports`` for the app to save it
(``GET …/{id}``, which may be asked again if a save fails) and is removed when
the app says so (``DELETE …/{id}``), after :data:`_STALE_S`, or at the next
start-up. Closing the stream stops the encoding.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import time
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from core.browser_guard import reject_cross_site_get
from services import book_video, longform_images

router = APIRouter()
logger = logging.getLogger("omnivoice.book_video")

VIDEO_EXPORT_DIRNAME = "video_exports"
_ID_RE = re.compile(r"^[0-9a-f]{32}$")
#: An unsaved video is kept this long (a long book takes a while to save).
_STALE_S = 6 * 60 * 60
#: Free space wanted, as a multiple of the video's expected size (its parts,
#: the joined file, and room to spare).
_SPACE_FACTOR = 2.5
_busy = asyncio.Lock()
_tools: dict = {}


class BookVideoRequest(BaseModel):
    """What the video of a finished book (``output`` in the outputs folder) looks like."""
    output: str = Field(max_length=200)
    title: str | None = Field(default=None, max_length=300)
    author: str | None = Field(default=None, max_length=300)
    cover_path: str | None = Field(default=None, max_length=300)
    aspect: Literal["16:9", "9:16", "1:1"] = "16:9"
    quality: Literal[720, 1080] = 1080
    motion: bool = True
    transitions: bool = True
    captions: bool = True
    karaoke: bool = True
    font: str | None = Field(default=None, max_length=40)
    size: Literal["s", "m", "l"] = "m"
    titles: bool = True
    accent: str = Field(default=book_video.DEFAULT_ACCENT, pattern=r"^#[0-9a-fA-F]{6}$")


def _export_dir() -> str:
    # The app's own data folder, never the shared system temp (see _html_export_dir).
    from core.config import DATA_DIR

    return os.path.join(DATA_DIR, VIDEO_EXPORT_DIRNAME)


def _prune(directory: str, max_age_s: float | None = _STALE_S) -> None:
    """Remove the videos (and unfinished work folders) in ``directory`` older
    than ``max_age_s`` (``None``: all of them). Best-effort."""
    cutoff = None if max_age_s is None else time.time() - max_age_s
    with contextlib.suppress(OSError), os.scandir(directory) as entries:
        for entry in entries:
            with contextlib.suppress(OSError):
                if cutoff is not None and entry.stat().st_mtime >= cutoff:
                    continue
                if entry.is_dir(follow_symlinks=False):
                    shutil.rmtree(entry.path, ignore_errors=True)
                else:
                    os.remove(entry.path)


def sweep_video_exports() -> None:
    """Remove every video an earlier run left (unsaved, or half made by a
    crash). Run at start-up, before the export routes are served."""
    _prune(_export_dir(), max_age_s=None)


def _refuse(status: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def _event(doc: dict) -> str:
    return f"data: {json.dumps(doc, ensure_ascii=False)}\n\n"


@router.post("/audiobook/export/video")
async def export_book_video(req: BookVideoRequest):
    """Make the MP4 video of a finished book, as an event stream:
    ``start`` (frames, parts, pictures the library no longer has), ``progress``
    (``percent``), ``finishing``, then ``done`` (``id``, ``bytes``) or
    ``error`` (``error_code``, ``error``). Refused before it starts (HTTP
    error with a ``code``) when something it needs is missing."""
    from api.routers.audiobook import _book_path, _read_book_timeline, _safe_cover_path
    from services.ffmpeg_utils import find_ffmpeg

    audio = _book_path(req.output)
    if not audio or not os.path.isfile(audio):
        raise _refuse(404, "video_no_book", "That book is no longer in the outputs folder.")
    timeline = _read_book_timeline(req.output)
    if timeline is None:
        raise _refuse(409, "video_needs_timeline",
                      "This book was made before VoiceStudio kept its timing. "
                      "Create it again (the audio it already has is reused), then make the video.")
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise _refuse(503, "video_no_ffmpeg",
                      "ffmpeg is not installed. Install it from Settings → Audio tools.")
    lacking = _tools.get(ffmpeg)
    if lacking is None:
        lacking = await asyncio.to_thread(book_video.missing_tools, ffmpeg)
        # An answer is kept; a check that could not run is no refusal, and is
        # asked again next time (the encode says so if ffmpeg truly cannot).
        if lacking is not None:
            _tools[ffmpeg] = lacking
    if lacking:
        raise _refuse(503, "video_ffmpeg_lacks",
                      "This ffmpeg cannot make the video (it lacks "
                      f"{', '.join(lacking)}). Use the ffmpeg VoiceStudio installs "
                      "(Settings → Audio tools) instead of the one set in FFMPEG_PATH.",
                      lacking=lacking)
    if _busy.locked():
        raise _refuse(409, "video_busy", "Another video is being made. Wait for it to finish.")
    directory = _export_dir()
    os.makedirs(directory, exist_ok=True)
    _prune(directory)
    need = int(book_video.expected_bytes(float(timeline.get("duration") or 0.0), req.quality)
               * _SPACE_FACTOR)
    free = shutil.disk_usage(directory).free
    if free < need:
        raise _refuse(507, "video_disk_full",
                      f"Not enough free disk space: about {need / 2**30:.1f} GB is needed, "
                      f"{free / 2**30:.1f} GB is free.", need=need, free=free)
    options = book_video.VideoOptions(
        aspect=req.aspect, quality=req.quality, motion=req.motion,
        transitions=req.transitions, captions=req.captions, karaoke=req.karaoke,
        font=req.font, size=req.size, titles=req.titles, accent=req.accent)
    export_id = uuid.uuid4().hex
    return StreamingResponse(
        _stream(export_id, directory, ffmpeg=ffmpeg, audio=audio, timeline=timeline,
                options=options, cover=_safe_cover_path(req.cover_path),
                title=req.title, author=req.author),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _stream(export_id: str, directory: str, *, ffmpeg: str, audio: str, timeline: dict,
                  options: book_video.VideoOptions, cover, title, author):
    workdir = os.path.join(directory, f"{export_id}.work")
    output = os.path.join(directory, f"{export_id}.mp4")
    made = os.path.join(workdir, "video.mp4")
    async with _busy:
        os.makedirs(workdir, exist_ok=True)
        try:
            render = book_video.render_video(
                ffmpeg=ffmpeg, audio=audio, timeline=timeline, options=options,
                workdir=workdir, output=made, picture_path=longform_images.path_of,
                cover=cover, book_title=title, author=author, job_id=f"video-{export_id}")
            # aclosing: a closed stream (the app stopped it) stops the encode now.
            async with contextlib.aclosing(render) as events:
                async for event in events:
                    yield _event(event)
            os.replace(made, output)
            yield _event({"type": "done", "id": export_id, "bytes": os.path.getsize(output),
                          "duration": timeline.get("duration")})
        except book_video.VideoFailed as exc:
            logger.warning("video export failed (%s): %s", exc.code, exc)
            yield _event({"type": "error", "error_code": exc.code, "error": str(exc)})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — reported, never a dead stream
            from core.public_errors import public_failure

            error = public_failure(logger, "Video export failed", exc,
                                   response="The video could not be made; check the backend log.")
            yield _event({"type": "error", "error_code": "video_failed", "error": error})
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


def _video_path(export_id: str) -> str:
    if not _ID_RE.fullmatch(export_id or ""):
        raise HTTPException(status_code=404, detail="No such video")
    return os.path.join(_export_dir(), f"{export_id}.mp4")


# A large file the app may ask for again when a save fails: kept, not spent.
@router.get("/audiobook/export/video/{export_id}", dependencies=[Depends(reject_cross_site_get)])
def download_book_video(export_id: str) -> FileResponse:
    """The finished video ``export_id`` (kept until the app discards it)."""
    path = _video_path(export_id)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="No such video")
    return FileResponse(path, media_type="video/mp4")


@router.delete("/audiobook/export/video/{export_id}")
def discard_book_video(export_id: str) -> dict:
    """Remove a finished video (saved, or not wanted). One already gone is not an error."""
    with contextlib.suppress(OSError):
        os.remove(_video_path(export_id))
    return {"deleted": export_id}
