"""Persisted selection and installed-only resolution for diarisation runtimes."""
from __future__ import annotations

import os
from pathlib import Path

from core import prefs

PYANNOTE = "pyannote"
SORTFORMER = "audiocpp-sortformer"
SORTFORMER_REPO = "audio-cpp/audio.cpp-gguf"
SORTFORMER_FILE = "Sortformer-Diar-4spk-v1-GGUF/sortformer-diar-4spk-v1-q8_0.gguf"

# Why a runtime is not ready, as a stable code and its English sentence. The
# sentence is the API's text; the desktop app shows its own translation of the
# code (engineReason.diarisation.<code> in every locale), so a code never
# changes meaning.
REASONS = {
    "pyannote_not_installed": "Install the pyannote model bundle",
    "sortformer_model_missing": "Install the Sortformer model bundle",
    "sortformer_model_broken": "Repair the installed Sortformer model bundle",
    "sortformer_runtime_missing": (
        "The Sortformer model is installed. Install the audio.cpp runtime to use it"
    ),
    "sortformer_cli_missing": (
        "The installed audio.cpp runtime does not include speaker diarisation"
    ),
}


def reason_fields(code: str | None) -> dict:
    """The ``reason`` / ``reason_code`` pair for a status payload."""
    return {"reason": REASONS[code] if code else None, "reason_code": code}


def selected_backend() -> str:
    value = str(
        prefs.resolve(
            "diarization_backend",
            env="OMNIVOICE_DIARIZATION_BACKEND",
            default=PYANNOTE,
        )
    ).strip()
    return value if value in {PYANNOTE, SORTFORMER} else PYANNOTE


def sortformer_model_path() -> Path:
    configured = os.environ.get("OMNIVOICE_DIARIZATION_MODEL", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()

    # An installed-only lookup never reaches the network. Installation remains
    # an explicit Model Library action through the reviewed audio.cpp bundle.
    from huggingface_hub import hf_hub_download
    from services.hf_revisions import revision_for

    return Path(
        hf_hub_download(
            repo_id=SORTFORMER_REPO,
            filename=SORTFORMER_FILE,
            revision=revision_for(SORTFORMER_REPO),
            local_files_only=True,
        )
    ).resolve()


def select_backend(backend: str) -> None:
    if backend not in {PYANNOTE, SORTFORMER}:
        raise ValueError("Unknown diarisation engine")
    prefs.set_("diarization_backend", backend)


def sortformer_status() -> dict:
    """Return path-free readiness for the model and its native executable."""
    status = {
        "model": SORTFORMER_REPO,
        "model_installed": False,
        "runtime_installed": False,
        "installed": False,
        **reason_fields("sortformer_model_missing"),
    }
    try:
        model = sortformer_model_path()
    except Exception:
        return status
    try:
        if not model.is_file() or model.suffix.lower() != ".gguf":
            return status
        with model.open("rb") as model_file:
            if model_file.read(4) != b"GGUF":
                status.update(reason_fields("sortformer_model_broken"))
                return status
    except OSError:
        status.update(reason_fields("sortformer_model_broken"))
        return status

    status["model_installed"] = True
    status.update(reason_fields("sortformer_runtime_missing"))
    try:
        from engines.audiocpp.bootstrap import resolve_server_binary

        server = resolve_server_binary()
    except (OSError, RuntimeError):
        return status
    cli = server.with_name("audiocpp_cli.exe" if os.name == "nt" else "audiocpp_cli")
    if not cli.is_file() or (os.name != "nt" and not os.access(cli, os.X_OK)):
        status.update(reason_fields("sortformer_cli_missing"))
        return status
    status.update(runtime_installed=True, installed=True, **reason_fields(None))
    return status


def installed_backends() -> set[str]:
    """Return complete local runtimes without loading weights or downloading."""
    installed: set[str] = set()
    from api.routers.setup.models import KNOWN_MODELS, cache_is_complete, is_cached

    repo_id = "pyannote/speaker-diarization-3.1"
    spec = next(model for model in KNOWN_MODELS if model["repo_id"] == repo_id)
    if is_cached(repo_id) and cache_is_complete(spec):
        installed.add(PYANNOTE)

    try:
        native = sortformer_status()
        if not native["installed"]:
            return installed
        installed.add(SORTFORMER)
    except (OSError, RuntimeError, ValueError):
        pass
    return installed
