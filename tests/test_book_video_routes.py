"""``/audiobook/export/video``: what a video needs, its event stream, its file."""
import json
import os
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routers import audiobook as audiobook_router
from api.routers import book_video as router_mod
from services import book_video


@pytest.fixture
def env(tmp_path, monkeypatch):
    import core.config as config

    outputs = tmp_path / "outputs"
    outputs.mkdir()
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(outputs))
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    (outputs / "audiobook_ab12.m4b").write_bytes(b"audio")
    timeline = {"version": 1, "output": "audiobook_ab12.m4b", "duration": 4.0, "chapters": []}
    (outputs / "audiobook_ab12.m4b.timeline.json").write_text(json.dumps(timeline))
    monkeypatch.setattr("services.ffmpeg_utils.find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(router_mod, "_tools", {"ffmpeg": []})
    app = FastAPI()
    app.include_router(router_mod.router)
    return TestClient(app), tmp_path


def _events(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def test_refuses_what_a_video_needs_before_it_starts(env, monkeypatch):
    client, root = env
    post = lambda body: client.post("/audiobook/export/video", json=body)
    assert post({"output": "audiobook_zz.m4b"}).json()["detail"]["code"] == "video_no_book"
    assert post({"output": "../secret.m4b"}).status_code == 404
    os.remove(root / "outputs" / "audiobook_ab12.m4b.timeline.json")
    res = post({"output": "audiobook_ab12.m4b"})
    assert res.status_code == 409 and res.json()["detail"]["code"] == "video_needs_timeline"


def test_refuses_an_ffmpeg_without_h264_or_libass(env, monkeypatch):
    client, _ = env
    monkeypatch.setattr(router_mod, "_tools", {"ffmpeg": ["libx264", "ass"]})
    res = client.post("/audiobook/export/video", json={"output": "audiobook_ab12.m4b"})
    assert res.status_code == 503 and res.json()["detail"]["lacking"] == ["libx264", "ass"]


def test_an_ffmpeg_check_that_could_not_run_refuses_nothing_and_is_asked_again(env, monkeypatch):
    client, _ = env
    monkeypatch.setattr(router_mod, "_tools", {})
    asked = []
    monkeypatch.setattr(book_video, "missing_tools", lambda ffmpeg: asked.append(ffmpeg))
    monkeypatch.setattr(router_mod.shutil, "disk_usage",
                        lambda path: SimpleNamespace(total=10, used=9, free=1))
    for _ in range(2):
        res = client.post("/audiobook/export/video", json={"output": "audiobook_ab12.m4b"})
        # Past the ffmpeg check, to the next one.
        assert res.json()["detail"]["code"] == "video_disk_full"
    assert asked == ["ffmpeg", "ffmpeg"] and router_mod._tools == {}
    monkeypatch.setattr(book_video, "missing_tools", lambda ffmpeg: ["ass"])
    res = client.post("/audiobook/export/video", json={"output": "audiobook_ab12.m4b"})
    assert res.json()["detail"]["code"] == "video_ffmpeg_lacks" and router_mod._tools == {"ffmpeg": ["ass"]}


def test_refuses_when_the_disk_is_too_full(env, monkeypatch):
    client, _ = env
    monkeypatch.setattr(router_mod.shutil, "disk_usage",
                        lambda path: SimpleNamespace(total=10, used=9, free=1))
    res = client.post("/audiobook/export/video", json={"output": "audiobook_ab12.m4b"})
    assert res.status_code == 507 and res.json()["detail"]["code"] == "video_disk_full"


@pytest.mark.parametrize("body", [
    {"output": "audiobook_ab12.m4b", "aspect": "4:3"},
    {"output": "audiobook_ab12.m4b", "quality": 480},
    {"output": "audiobook_ab12.m4b", "accent": "red"},
    {"output": "audiobook_ab12.m4b", "size": "xl"},
])
def test_rejects_options_it_does_not_offer(env, body):
    client, _ = env
    assert client.post("/audiobook/export/video", json=body).status_code == 422


def test_streams_progress_then_keeps_the_video_until_discarded(env, monkeypatch):
    client, root = env
    seen = {}

    async def fake_render(**kwargs):
        seen.update(kwargs)
        yield {"type": "start", "frames": 100, "parts": 1, "missing": []}
        yield {"type": "progress", "frame": 50, "frames": 100, "percent": 50.0}
        with open(kwargs["output"], "wb") as fh:
            fh.write(b"mp4!")
        yield {"type": "finishing"}

    monkeypatch.setattr(book_video, "render_video", fake_render)
    res = client.post("/audiobook/export/video",
                      json={"output": "audiobook_ab12.m4b", "aspect": "9:16", "quality": 720,
                            "title": "Book", "cover_path": "../../etc/passwd"})
    events = _events(res)
    assert [e["type"] for e in events] == ["start", "progress", "finishing", "done"]
    done = events[-1]
    assert done["bytes"] == 4 and done["duration"] == 4.0
    assert seen["options"].aspect == "9:16" and seen["options"].quality == 720
    assert seen["cover"] is None  # a cover that is not an upload is never read
    folder = root / router_mod.VIDEO_EXPORT_DIRNAME
    assert sorted(os.listdir(folder)) == [f"{done['id']}.mp4"]  # its work folder is gone
    # Saved more than once if a save fails; removed when discarded.
    for _ in range(2):
        got = client.get(f"/audiobook/export/video/{done['id']}")
        assert got.status_code == 200 and got.content == b"mp4!"
    assert client.delete(f"/audiobook/export/video/{done['id']}").json() == {"deleted": done["id"]}
    assert client.get(f"/audiobook/export/video/{done['id']}").status_code == 404
    assert client.get("/audiobook/export/video/not-an-id").status_code == 404


def test_a_failed_video_is_an_error_event_and_leaves_nothing(env, monkeypatch):
    client, root = env

    async def failing(**kwargs):
        yield {"type": "start", "frames": 1, "parts": 1, "missing": []}
        raise book_video.VideoFailed("video_encode_failed", "ffmpeg could not encode the video.")

    monkeypatch.setattr(book_video, "render_video", failing)
    events = _events(client.post("/audiobook/export/video", json={"output": "audiobook_ab12.m4b"}))
    assert events[-1] == {"type": "error", "error_code": "video_encode_failed",
                          "error": "ffmpeg could not encode the video."}
    assert os.listdir(root / router_mod.VIDEO_EXPORT_DIRNAME) == []


def test_startup_sweep_removes_what_an_earlier_run_left(env):
    _, root = env
    folder = root / router_mod.VIDEO_EXPORT_DIRNAME
    (folder / "abc.work").mkdir(parents=True)
    (folder / "abc.mp4").write_bytes(b"old")
    router_mod.sweep_video_exports()
    assert os.listdir(folder) == []
