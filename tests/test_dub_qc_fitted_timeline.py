"""Dub QC matches what it hears on the timeline the track actually plays.

Smart Fit speeds a short line's video (and its track) up, and slows a long
one down; Stretch Video sets every line to its dub's length. Every later
line moves, so scoring the recognized speech against the ORIGINAL segment
times paired lines with the wrong audio and flagged correct dubs.
"""
from __future__ import annotations

import asyncio
import os

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")

# The first line was sped up from 5 s to 4 s: the second plays 1 s earlier.
_HEARD = [
    {"start": 0.0, "end": 4.0, "text": "hola mundo"},
    {"start": 4.5, "end": 5.5, "text": "muchas gracias"},
]


@pytest.fixture
def qc_job(tmp_path, monkeypatch):
    from api.routers import dub_export
    from services import asr_backend, dub_pipeline
    import services.model_manager as model_manager

    job_dir = tmp_path / "job-fit"
    job_dir.mkdir()
    (job_dir / "dubbed_es.wav").write_bytes(b"RIFF")
    job = {
        "id": "job-fit",
        "dubbed_tracks": {"es": {"path": str(job_dir / "dubbed_es.wav"), "timing_strategy": "smart_fit"}},
        "segments": [
            {"id": "a", "start": 0.0, "end": 5.0, "text": "hola mundo"},
            {"id": "b", "start": 5.5, "end": 6.5, "text": "muchas gracias"},
        ],
    }

    async def _guarded(_pool, fn, **_kw):
        return fn()

    class _Backend:
        id = "fake-asr"

        def transcribe(self, path, **_kw):
            return {"segments": [dict(row) for row in _HEARD]}

    monkeypatch.setattr(dub_export, "DUB_DIR", str(tmp_path))
    monkeypatch.setattr(dub_export, "_get_job", lambda jid: job if jid == "job-fit" else None)
    monkeypatch.setattr(asr_backend, "asr_model_missing_error", lambda: None)
    monkeypatch.setattr(asr_backend, "run_transcribe_guarded", _guarded)
    monkeypatch.setattr(asr_backend, "load_active_asr_backend", lambda: _Backend())
    monkeypatch.setattr(dub_pipeline, "put_job", lambda *a: None)
    monkeypatch.setattr(dub_pipeline, "save_job", lambda *a: None)
    monkeypatch.setattr(model_manager, "_get_gpu_pool", lambda: None)
    return dub_export, job


def _qc(module):
    return asyncio.run(module.dub_qc_pass("job-fit", lang="es", drift_threshold=0.5))


def test_original_times_mismatch_a_fitted_track(qc_job):
    """Control: with no fitted timing on record the second line is matched
    against the wrong audio — the failure the fitted times prevent."""
    module, _job = qc_job
    assert _qc(module)["flagged_count"] == 2


def test_smart_fit_track_is_scored_on_its_fitted_cues(qc_job):
    module, job = qc_job
    job["fit_plans"] = {"es": {
        "plan": [{"orig_start": 0.0, "orig_end": 5.0, "new_start": 0.0, "new_end": 4.0, "stretch_ratio": 0.8}],
        "fitted_segments": [
            {"id": "a", "start": 0.0, "end": 4.0},
            {"id": "b", "start": 4.5, "end": 5.5},
        ],
    }}
    result = _qc(module)
    assert result["flagged_count"] == 0
    assert [row["measured_start"] for row in result["segments"]] == [0.0, 4.5]
    # Annotations only: the stored timing stays on the original timeline.
    assert job["segments"][1]["start"] == 5.5


def test_stretch_video_track_is_scored_on_its_plan(qc_job):
    module, job = qc_job
    job["timing_strategy"] = "stretch_video"
    job["dubbed_tracks"]["es"]["timing_strategy"] = "stretch_video"
    job["video_stretch_plans"] = {"es": {"plan": [
        {"orig_start": 0.0, "orig_end": 5.0, "new_start": 0.0, "new_end": 4.0, "stretch_ratio": 0.8},
        {"orig_start": 5.5, "orig_end": 6.5, "new_start": 4.5, "new_end": 5.5, "stretch_ratio": 1.0},
    ]}}
    assert _qc(module)["flagged_count"] == 0
