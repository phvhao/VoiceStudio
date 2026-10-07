"""Saved voices report their clip's length (the voice chooser's "12s")."""

import io
import wave

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def wav_bytes(frames: int, rate: int = 16000) -> bytes:
    data = io.BytesIO()
    with wave.open(data, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"\x01\x00" * frames)
    return data.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    from api.routers import profiles
    from core import db

    monkeypatch.setattr(profiles, "VOICES_DIR", str(tmp_path / "voices"))
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "profiles.db"))
    db.init_db()

    async def no_transcript(_path):
        return ""

    monkeypatch.setattr(profiles, "_auto_transcribe_reference", no_transcript)
    monkeypatch.setattr(profiles.event_bus, "emit", lambda *a: None)
    app = FastAPI()
    app.include_router(profiles.router)
    with TestClient(app) as test_client:
        yield test_client


def create(client, name, body):
    response = client.post(
        "/profiles", data={"name": name}, files={"ref_audio": ("voice.wav", body, "audio/wav")}
    )
    assert response.status_code == 200, response.text
    return response.json()


def listed(client, profile_id):
    return next(p for p in client.get("/profiles").json() if p["id"] == profile_id)


def test_a_saved_voice_reports_its_clip_length(client):
    created = create(client, "Scarlet", wav_bytes(24000))
    assert created["audio_duration_seconds"] == 1.5
    assert listed(client, created["id"])["audio_duration_seconds"] == 1.5


def test_a_replaced_clip_reports_the_new_length(client):
    created = create(client, "Scarlet", wav_bytes(24000))
    assert listed(client, created["id"])["audio_duration_seconds"] == 1.5
    replaced = client.put(
        f"/profiles/{created['id']}/audio",
        files={"ref_audio": ("longer.wav", wav_bytes(72000), "audio/wav")},
    )
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["audio_duration_seconds"] == 4.5
    assert listed(client, created["id"])["audio_duration_seconds"] == 4.5


def test_an_unreadable_clip_has_no_length(client):
    created = create(client, "Scarlet", b"RIFF" + bytes(2000))
    assert created["audio_url"]
    assert created["audio_duration_seconds"] is None
    assert listed(client, created["id"])["audio_duration_seconds"] is None
