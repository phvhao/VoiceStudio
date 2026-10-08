"""The picture library of long-form books (``[image: NAME]`` script tags).

Pictures live in ``DATA_DIR/longform_images`` under the names the scripts use:
the uploaded file's name made plain (ASCII, lower case, ``-`` for anything
else) and unique, so a tag reads like the file it came from
(``[image: rung-dem.jpg]``) and never depends on how a file system spells
accented names. Every upload is decoded and written again: its orientation
applied, its metadata (camera, GPS) left behind, its longest side at most
:data:`MAX_SIDE`, JPEG unless it has transparency (then PNG). The same picture
uploaded twice keeps one name.

Nothing here reads the network; everything is local files.
"""
from __future__ import annotations

import io
import os
import re
import tempfile
import threading
import unicodedata
import warnings
from typing import Optional

from core.config import DATA_DIR
from core.path_security import contained_join

IMAGES_DIRNAME = "longform_images"
THUMBS_DIRNAME = ".thumbs"
#: An upload larger than this is refused before it is decoded.
MAX_UPLOAD_BYTES = 40 * 1024 * 1024
#: Decoded pixels allowed (a 50-megapixel photo); more is refused, never decoded.
MAX_PIXELS = 50_000_000
#: The longest side kept: enough for a 4K frame and a slow zoom into 1080p.
MAX_SIDE = 3840
#: The longest side of the thumbnails the editor's picker shows.
THUMB_SIDE = 360
#: The names the library gives (and so the only ones it serves).
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}\.(?:jpg|png)$")
_FORMATS = {"JPEG", "PNG", "WEBP", "GIF", "BMP", "TIFF", "MPO"}
_STEM_MAX = 60
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(10)),
             *(f"lpt{i}" for i in range(10))}

_lock = threading.Lock()
_sizes: dict = {}


class ImageRejected(ValueError):
    """An upload the library will not keep; ``code`` says why (``too_large``,
    ``unsupported``, ``too_many_pixels``)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def images_dir() -> str:
    path = os.path.join(DATA_DIR, IMAGES_DIRNAME)
    os.makedirs(path, exist_ok=True)
    return path


def plain_stem(filename: Optional[str]) -> str:
    """The name part of ``filename`` as the library writes it: accents
    dropped (``đ`` is ``d``), lower case, runs of anything but letters,
    digits, ``.``, ``_`` and ``-`` as one ``-``; ``image`` when nothing is left."""
    stem = os.path.splitext(os.path.basename(str(filename or "")))[0]
    stem = unicodedata.normalize("NFKD", stem.replace("đ", "d").replace("Đ", "D"))
    stem = "".join(ch for ch in stem if not unicodedata.combining(ch))
    stem = stem.encode("ascii", "ignore").decode("ascii").lower()
    stem = re.sub(r"[^a-z0-9._-]+", "-", stem)
    stem = re.sub(r"-{2,}", "-", stem).strip("-._")
    stem = stem[:_STEM_MAX].rstrip("-._") or "image"
    # Windows refuses these names whatever the extension ("con.jpg").
    if stem.split(".")[0] in _RESERVED:
        stem = f"{stem}-image"
    return stem


def _normalized(data: bytes) -> tuple[bytes, str, int, int]:
    """``data`` decoded and written again: ``(bytes, ".jpg"|".png", width,
    height)``. Raises :class:`ImageRejected`."""
    from PIL import Image, ImageOps

    if len(data) > MAX_UPLOAD_BYTES:
        raise ImageRejected("too_large", f"The picture is larger than {MAX_UPLOAD_BYTES // 2**20} MB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))
            if image.format not in _FORMATS:
                raise ImageRejected("unsupported", "Use a JPEG, PNG, WebP, GIF, BMP or TIFF picture.")
            if image.width * image.height > MAX_PIXELS:
                raise ImageRejected("too_many_pixels", "The picture has too many pixels (over 50 megapixels).")
            image.seek(0)  # the first frame of an animation
            image = ImageOps.exif_transpose(image)
            image.load()
    except ImageRejected:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ImageRejected("too_many_pixels", "The picture has too many pixels (over 50 megapixels).")
    except Exception:
        raise ImageRejected("unsupported", "This file is not a picture VoiceStudio can read.")
    alpha = image.mode in ("RGBA", "LA", "PA") or (
        image.mode == "P" and "transparency" in image.info)
    image = image.convert("RGBA" if alpha else "RGB")
    if max(image.size) > MAX_SIDE:
        image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    # Only the pixels travel: Pillow writes some of what it read back out
    # unasked (a JPEG or GIF comment, a colour profile).
    image.info = {}
    out = io.BytesIO()
    if alpha:
        image.save(out, "PNG", optimize=True)
        ext = ".png"
    else:
        image.save(out, "JPEG", quality=90, optimize=True)
        ext = ".jpg"
    return out.getvalue(), ext, image.width, image.height


def _write_atomic(path: str, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(prefix=".upload-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def save(data: bytes, filename: Optional[str]) -> dict:
    """Keep an uploaded picture: ``{"name", "width", "height", "bytes",
    "reused"}``. The same picture as one already kept returns that one's name
    (``reused``); another with a taken name gets ``-2``, ``-3``…"""
    body, ext, width, height = _normalized(data)
    folder = images_dir()
    stem = plain_stem(filename)
    with _lock:
        for entry in os.scandir(folder):
            if (entry.is_file() and NAME_RE.fullmatch(entry.name) and entry.name.endswith(ext)
                    and entry.stat().st_size == len(body)):
                with open(entry.path, "rb") as fh:
                    if fh.read() == body:
                        return {"name": entry.name, "width": width, "height": height,
                                "bytes": len(body), "reused": True}
        name, n = f"{stem}{ext}", 1
        while os.path.exists(os.path.join(folder, name)):
            n += 1
            name = f"{stem}-{n}{ext}"
        _write_atomic(os.path.join(folder, name), body)
    return {"name": name, "width": width, "height": height, "bytes": len(body), "reused": False}


def path_of(name: Optional[str]) -> Optional[str]:
    """The kept picture called ``name`` (the library's own spelling, any
    case), or ``None``."""
    name = str(name or "").strip().lower()
    if not NAME_RE.fullmatch(name):
        return None
    path = contained_join(images_dir(), name)
    return path if path and os.path.isfile(path) else None


def size_of(path: str) -> tuple[int, int]:
    """``(width, height)`` of a kept picture, read once per version of it."""
    from PIL import Image

    stat = os.stat(path)
    key = (path, stat.st_mtime_ns, stat.st_size)
    if key not in _sizes:
        with Image.open(path) as image:
            _sizes[key] = image.size
        if len(_sizes) > 4096:
            _sizes.clear()
    return _sizes[key]


def listing() -> list[dict]:
    """Every kept picture, the newest first: ``{"name", "width", "height",
    "bytes", "version"}`` (``version`` changes when the file does)."""
    out = []
    for entry in os.scandir(images_dir()):
        if not entry.is_file() or not NAME_RE.fullmatch(entry.name):
            continue
        stat = entry.stat()
        try:
            width, height = size_of(entry.path)
        except Exception:
            continue  # not a picture any more (written by hand): not listed
        out.append({"name": entry.name, "width": width, "height": height,
                    "bytes": stat.st_size, "version": stat.st_mtime_ns,
                    "_order": stat.st_mtime_ns})
    out.sort(key=lambda item: (-item.pop("_order"), item["name"]))
    return out


def thumb_of(name: Optional[str]) -> Optional[str]:
    """A small JPEG of the picture ``name`` for the editor (made once per
    version of it), or ``None`` when there is no such picture."""
    from PIL import Image

    source = path_of(name)
    if source is None:
        return None
    folder = os.path.join(images_dir(), THUMBS_DIRNAME)
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, os.path.basename(source) + ".jpg")
    try:
        if os.stat(target).st_mtime_ns >= os.stat(source).st_mtime_ns:
            return target
    except OSError:
        pass
    with Image.open(source) as image:
        image.thumbnail((THUMB_SIDE, THUMB_SIDE), Image.LANCZOS)
        if image.mode != "RGB":
            backdrop = Image.new("RGB", image.size, (128, 128, 128))
            backdrop.paste(image, mask=image.convert("RGBA").getchannel("A"))
            image = backdrop
        out = io.BytesIO()
        image.save(out, "JPEG", quality=82)
    _write_atomic(target, out.getvalue())
    return target


def delete(name: Optional[str]) -> bool:
    """Remove the picture ``name`` and its thumbnail; ``False`` when there is
    no such picture."""
    source = path_of(name)
    if source is None:
        return False
    os.remove(source)
    try:
        os.remove(os.path.join(images_dir(), THUMBS_DIRNAME, os.path.basename(source) + ".jpg"))
    except OSError:
        pass
    return True
