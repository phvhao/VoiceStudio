"""The picture library behind ``[image: NAME]`` script tags."""
import io
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from api.routers import longform_images as router_mod
from services import longform_images


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setattr(longform_images, "DATA_DIR", str(tmp_path))
    return tmp_path / longform_images.IMAGES_DIRNAME


@pytest.fixture
def client(library):
    app = FastAPI()
    app.include_router(router_mod.router)
    return TestClient(app)


def _jpeg(size=(64, 32), color=(200, 40, 40), exif_orientation=None) -> bytes:
    image = Image.new("RGB", size, color)
    out = io.BytesIO()
    if exif_orientation:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation  # Orientation
        exif[0x010F] = "PhoneMaker"      # Make: must not survive
        image.save(out, "JPEG", exif=exif.tobytes())
    else:
        image.save(out, "JPEG")
    return out.getvalue()


def _png_alpha() -> bytes:
    out = io.BytesIO()
    Image.new("RGBA", (40, 40), (0, 120, 255, 100)).save(out, "PNG")
    return out.getvalue()


@pytest.mark.parametrize("filename, stem", [
    ("Rừng Đêm (1).JPG", "rung-dem-1"),
    ("../../etc/passwd", "passwd"),
    ("   ", "image"),
    (None, "image"),
    ("con.jpg", "con-image"),
    ("LPT1", "lpt1-image"),
    ("ảnh__bìa--mới.webp", "anh__bia-moi"),
])
def test_names_are_plain_ascii_and_safe(filename, stem):
    assert longform_images.plain_stem(filename) == stem


def test_upload_keeps_a_rewritten_picture_under_a_plain_unique_name(client, library):
    first = client.post("/longform/images", files={"file": ("Rừng Đêm.JPG", _jpeg(), "image/jpeg")})
    assert first.status_code == 200
    assert first.json()["image"] == {"name": "rung-dem.jpg", "width": 64, "height": 32,
                                     "bytes": first.json()["image"]["bytes"], "reused": False}
    # The same picture again keeps its name; another picture gets the next one.
    again = client.post("/longform/images", files={"file": ("copy.jpg", _jpeg(), "image/jpeg")})
    assert again.json()["image"]["name"] == "rung-dem.jpg" and again.json()["image"]["reused"]
    other = client.post("/longform/images",
                        files={"file": ("rừng đêm.png", _jpeg(color=(1, 2, 3)), "image/png")})
    assert other.json()["image"]["name"] == "rung-dem-2.jpg"
    names = [item["name"] for item in client.get("/longform/images").json()["images"]]
    assert sorted(names) == ["rung-dem-2.jpg", "rung-dem.jpg"]


def test_upload_applies_orientation_and_drops_metadata(client, library):
    # Orientation 6: the camera held sideways; the picture is stored upright.
    res = client.post("/longform/images",
                      files={"file": ("photo.jpg", _jpeg((60, 20), exif_orientation=6), "image/jpeg")})
    image = res.json()["image"]
    assert (image["width"], image["height"]) == (20, 60)
    with Image.open(library / image["name"]) as stored:
        assert not stored.getexif()


@pytest.mark.parametrize("fmt,mode", [("JPEG", "RGB"), ("GIF", "P"), ("PNG", "RGBA")])
def test_upload_drops_comments_too(client, library, fmt, mode):
    out = io.BytesIO()
    Image.new(mode, (16, 16)).save(out, fmt, comment=b"Taken at 12 Home Street")
    res = client.post("/longform/images", files={"file": (f"p.{fmt.lower()}", out.getvalue(), "image/x")})
    stored = (library / res.json()["image"]["name"]).read_bytes()
    assert b"Home Street" not in stored
    with Image.open(io.BytesIO(stored)) as image:
        assert "comment" not in image.info


def test_transparency_is_kept_as_png_and_large_pictures_are_shrunk(client, library, monkeypatch):
    res = client.post("/longform/images", files={"file": ("logo.png", _png_alpha(), "image/png")})
    assert res.json()["image"]["name"] == "logo.png"
    monkeypatch.setattr(longform_images, "MAX_SIDE", 16)
    res = client.post("/longform/images", files={"file": ("wide.jpg", _jpeg((64, 32)), "image/jpeg")})
    assert (res.json()["image"]["width"], res.json()["image"]["height"]) == (16, 8)


@pytest.mark.parametrize("payload, status, code", [
    (b"not a picture at all", 415, "image_unsupported"),
    (b"%PDF-1.4 fake", 415, "image_unsupported"),
])
def test_refuses_what_is_not_a_picture(client, payload, status, code):
    res = client.post("/longform/images", files={"file": ("x.jpg", payload, "image/jpeg")})
    assert res.status_code == status and res.json()["detail"]["code"] == code


def test_refuses_oversized_uploads_and_pixel_bombs(client, monkeypatch):
    monkeypatch.setattr(longform_images, "MAX_UPLOAD_BYTES", 100)
    res = client.post("/longform/images", files={"file": ("big.jpg", _jpeg((300, 300)), "image/jpeg")})
    assert res.status_code == 413
    monkeypatch.setattr(longform_images, "MAX_UPLOAD_BYTES", 40 * 2**20)
    monkeypatch.setattr(longform_images, "MAX_PIXELS", 100)
    res = client.post("/longform/images", files={"file": ("many.jpg", _jpeg((20, 20)), "image/jpeg")})
    assert res.status_code == 422 and res.json()["detail"]["code"] == "image_too_many_pixels"


def test_serves_pictures_and_thumbnails_by_library_name_only(client, library):
    name = client.post("/longform/images", files={"file": ("a.jpg", _jpeg((900, 450)), "image/jpeg")}
                       ).json()["image"]["name"]
    full = client.get(f"/longform/images/{name}")
    assert full.status_code == 200 and full.headers["content-type"] == "image/jpeg"
    thumb = client.get(f"/longform/images/{name.upper()}?thumb=1")
    assert thumb.status_code == 200
    with Image.open(io.BytesIO(thumb.content)) as small:
        assert max(small.size) == longform_images.THUMB_SIDE
    for bad in ("..%2F..%2Fsecret.jpg", "nope.jpg", "a.gif", ".thumbs", "a.jpg.jpg"):
        assert client.get(f"/longform/images/{bad}").status_code == 404


def test_delete_removes_the_picture_and_its_thumbnail(client, library):
    name = client.post("/longform/images", files={"file": ("d.jpg", _jpeg(), "image/jpeg")}
                       ).json()["image"]["name"]
    client.get(f"/longform/images/{name}?thumb=1")
    assert client.delete(f"/longform/images/{name}").json() == {"deleted": name}
    assert not (library / name).exists()
    assert not os.listdir(library / longform_images.THUMBS_DIRNAME)
    assert client.delete(f"/longform/images/{name}").status_code == 404
