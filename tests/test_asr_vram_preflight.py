"""CTranslate2 Whisper VRAM preflight (#723).

On a card the TTS model fills, loading whisper large-v3 in fp16 dies as a
*native* CUDA abort — the process is killed outright, no Python exception
fires, and the UI reports "Can't reach the local backend". The load-time
fp16→int8 / OOM→CPU fallbacks never run because nothing is raised. The only
defense is a preflight: check the pick against actually-free VRAM
(`torch.cuda.mem_get_info`) right before loading, degrading
fp16 → int8_float16 → int8 → CPU.

WhisperX had it; faster-whisper — reference transcription, Clone capture, the
speech check, dub and batch, and the crash-isolated sidecar — did not: the
backend died loading faster-whisper large-v3 in float16 for a Clone reference
with 0.8 GB free. Every CTranslate2 Whisper load now asks the same preflight
(`core.ctranslate2_vram`).

Backend classes are resolved at RUNTIME (see test_asr_gpu_compat.py rationale).
"""
from __future__ import annotations

import ast
import importlib
import os
import sys
import threading
import types
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
ENGINES = ("whisperx", "faster-whisper")
LARGE_V3 = "Systran/faster-whisper-large-v3"


def _mod(name: str):
    return importlib.import_module(name)


def _backend(engine="whisperx"):
    from services.asr_backend import _REGISTRY
    b = _REGISTRY[engine].__new__(_REGISTRY[engine])  # skip __init__ (no torch probe)
    b._model_name = "large-v3"
    return b


def _degrade(b, free_gb, device="cuda", compute="float16"):
    b._free_vram_gb = lambda: free_gb
    return b._degrade_for_vram(device, compute)


@pytest.fixture(autouse=True)
def _preflight_on(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_ASR_VRAM_PREFLIGHT", raising=False)
    monkeypatch.delenv("ASR_COMPUTE_TYPE", raising=False)


# ── The #723 crash scenario: TTS resident, ~2 GB free, fp16 requested ──────

@pytest.mark.parametrize("engine", ENGINES)
def test_starved_card_falls_back_to_cpu(engine):
    assert _degrade(_backend(engine), 2.0) == ("cpu", "int8")


@pytest.mark.parametrize("engine", ENGINES)
def test_mid_vram_degrades_to_int8_on_cuda(engine):
    # 3.5 GB free: can't hold fp16 (5.0) or int8_float16 (3.5 is not > needed
    # headroom boundary — equal passes), int8 (3.0) certainly fits.
    dev, ct = _degrade(_backend(engine), 3.2)
    assert (dev, ct) == ("cuda", "int8")


@pytest.mark.parametrize("engine", ENGINES)
def test_ample_vram_keeps_fp16(engine):
    assert _degrade(_backend(engine), 7.0) == ("cuda", "float16")


# ── Preflight must never *break* ASR ────────────────────────────────────────

@pytest.mark.parametrize("engine", ENGINES)
def test_unknown_vram_is_left_alone(engine):
    assert _degrade(_backend(engine), None) == ("cuda", "float16")


@pytest.mark.parametrize("engine", ENGINES)
def test_cpu_pick_is_untouched(engine):
    b = _backend(engine)
    b._free_vram_gb = lambda: 0.5
    assert b._degrade_for_vram("cpu", "int8") == ("cpu", "int8")


@pytest.mark.parametrize("engine", ENGINES)
def test_small_models_not_over_evicted(engine):
    # A 2 GB-free card comfortably runs whisper-small fp16 (5.0 * 0.25 budget);
    # the large-v3 budgets must not evict smaller models from CUDA.
    b = _backend(engine)
    b._model_name = "small"
    assert _degrade(b, 2.0) == ("cuda", "float16")


@pytest.mark.parametrize("engine", ENGINES)
def test_env_opt_out(engine, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_ASR_VRAM_PREFLIGHT", "0")
    assert _degrade(_backend(engine), 0.5) == ("cuda", "float16")


# ── A model is sized by its own name ────────────────────────────────────────

@pytest.mark.parametrize("name, scale", [
    ("large-v3", 1.0), (LARGE_V3, 1.0), ("Systran/faster-whisper-medium", 0.5),
    ("small", 0.25), ("Systran/faster-whisper-base", 0.15), ("tiny", 0.1),
    # Turbo and Distil-Whisper carry "large" in their names too.
    ("deepdml/faster-whisper-large-v3-turbo-ct2", 0.55), ("turbo", 0.55),
    ("Systran/faster-distil-whisper-large-v3", 0.55),
    # An installed snapshot is sized by its repo, never by the folders above it.
    (r"C:\Users\turbo\hf\hub\models--Systran--faster-whisper-large-v3\snapshots\a1b2", 1.0),
    ("/home/small/.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/a1b2",
     0.25),
    ("my-own-ct2-model", 1.0), ("", 1.0), (None, 1.0),
])
def test_a_model_is_sized_by_its_own_name(name, scale):
    assert _mod("core.ctranslate2_vram").model_scale(name) == scale


def test_a_turbo_model_keeps_float16_where_large_v3_would_not():
    b = _backend("faster-whisper")
    b._model_name = "deepdml/faster-whisper-large-v3-turbo-ct2"
    assert _degrade(b, 3.0) == ("cuda", "float16")  # needs 2.75 GB, not large-v3's 5.0


@pytest.mark.parametrize("name, identity", [
    (r"C:\Users\me\hf\hub\models--Systran--faster-whisper-large-v3\snapshots\a1b2", LARGE_V3),
    ("/cache/hub/models--deepdml--faster-whisper-large-v3-turbo-ct2/snapshots/a1b2",
     "deepdml/faster-whisper-large-v3-turbo-ct2"),
    (LARGE_V3, LARGE_V3), ("large-v3", "large-v3"), (None, ""),
])
def test_a_snapshot_directory_names_its_repo(name, identity):
    assert _mod("core.ctranslate2_vram").model_identity(name) == identity


# ── Wiring: _ensure_asr must preflight BEFORE whisperx.load_model ──────────

def test_ensure_asr_applies_preflight_before_load(monkeypatch):
    calls = {}

    fake_whisperx = types.ModuleType("whisperx")
    def _load_model(name, device=None, compute_type=None, **kw):
        calls["load"] = (device, compute_type)
        return object()
    fake_whisperx.load_model = _load_model
    monkeypatch.setitem(sys.modules, "whisperx", fake_whisperx)

    b = _backend()
    b._asr = None
    b._device, b._compute_type = "cuda", "float16"
    b._free_vram_gb = lambda: 2.0          # the #723 card state
    b._allow_vad_pickle_globals = lambda: None

    b._ensure_asr()
    assert calls["load"] == ("cpu", "int8")   # degraded BEFORE the load call


# ── faster-whisper: every load path, on a card the TTS model fills ──────────

#: Peak VRAM (GB) a large-v3 load and transcription takes per compute type:
#: float16 and int8 as faster-whisper's own benchmark measures them,
#: int8_float16 between the two (the preflight's budgets add headroom).
MEASURED_PEAK_GB = {"float16": 4.5, "int8_float16": 3.3, "int8": 2.9}
#: What CTranslate2 4.4 runs on this CPU (``get_supported_compute_types``).
CPU_COMPUTE_TYPES = {"float32", "int8", "int8_float32"}


class _NativeAbort(BaseException):
    """A CUDA load that does not fit: CTranslate2 aborts the process, so
    nothing a caller could catch is raised (no ``except Exception`` stops it)."""


class _Segment(SimpleNamespace):
    pass


@pytest.fixture
def card(monkeypatch):
    """A CUDA host with 0.8 GB of VRAM free — the log line before the backend
    died — and a faster-whisper whose CUDA load aborts the process when it does
    not fit. ``card.loads`` lists the loads attempted; ``card.free`` sets the
    free VRAM."""
    ab = _mod("services.asr_backend")
    card = SimpleNamespace(free=0.8, loads=[])

    class WhisperModel:
        supported_languages = ["en", "vi"]

        def __init__(self, name, device="auto", compute_type="default", **_kw):
            card.loads.append((device, compute_type))
            if device == "cpu" and compute_type not in CPU_COMPUTE_TYPES:
                # CTranslate2's own refusal (get_supported_compute_types("cpu")).
                raise ValueError(f"Requested {compute_type} compute type, but the target "
                                 f"device or backend do not support efficient "
                                 f"{compute_type} computation.")
            if device == "cuda" and card.free < MEASURED_PEAK_GB[compute_type]:
                raise _NativeAbort(f"{name} in {compute_type} with {card.free} GB free")

        def transcribe(self, audio, **_kw):
            info = SimpleNamespace(language="en", language_probability=1.0, duration=1.0)
            return iter([_Segment(text=" the words", start=0.0, end=1.0, words=[])]), info

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = WhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    # The module asr_backend holds, and the one the sidecar imports (the same
    # unless an earlier test purged core.* from sys.modules).
    for vram in {id(m): m for m in (ab.ctranslate2_vram, _mod("core.ctranslate2_vram"))}.values():
        monkeypatch.setattr(vram, "free_vram_gb", lambda: card.free)
    monkeypatch.setattr(ab, "_ctranslate2_cuda_ok", lambda: True)
    monkeypatch.setattr(ab, "_ctranslate2_execstack_ok", lambda: (True, "ok"))
    monkeypatch.setattr(ab, "_local_model_source", lambda name: name)
    monkeypatch.setattr(ab.FasterWhisperBackend, "is_available",
                        classmethod(lambda cls: (True, "ready")))
    # faster-whisper is the selected engine, its model installed; no dictation
    # engine or fallback is.
    monkeypatch.setattr(ab, "active_backend_id", lambda: "faster-whisper")
    monkeypatch.setattr(ab, "faster_whisper_model_id", lambda: LARGE_V3)
    monkeypatch.setattr(ab, "_offline_asr_repo", lambda bid=None: LARGE_V3)
    monkeypatch.setattr(ab, "_probe_available", lambda cls: True)
    monkeypatch.setattr(
        ab, "asr_model_missing_error",
        lambda **kw: {"error": "asr_model_missing"} if kw.get("purpose") == "dictation" else None)
    monkeypatch.setattr(ab, "_fallback_whisper_snapshot", lambda _exclude: None)
    monkeypatch.setattr(ab, "_fallback_dictation_spec", lambda _exclude: None)
    monkeypatch.setattr(ab, "_RUNTIME_EVIDENCE", {})
    monkeypatch.setattr(ab, "_ref_transcript_cache", OrderedDict())
    for name, value in (("_check_backend", None), ("_check_backend_key", None),
                        ("_check_leases", 0), ("_check_last_used", 0.0),
                        ("_check_unusable", set()), ("_check_held_since", None),
                        ("_check_stall_reported", None), ("_capture_backend", None),
                        ("_capture_backend_key", None)):
        monkeypatch.setattr(ab, name, value)
    monkeypatch.setattr(_mod("services.memory_budget"), "available_memory",
                        lambda: {"ram_available_gb": 64.0, "vram_free_gb": card.free})
    yield card
    for thread in threading.enumerate():
        if thread.name == "speech-check-release":
            thread.join(timeout=10)


def _clip(tmp_path) -> str:
    clip = tmp_path / "clip.wav"
    clip.write_bytes(os.urandom(64))
    return str(clip)


def _reference(ab, tmp_path, monkeypatch):
    return ab.transcribe_reference(_clip(tmp_path))


def _capture(ab, tmp_path, monkeypatch):
    monkeypatch.setattr(ab, "dictation_model_id", lambda: None)
    monkeypatch.setattr(ab, "_capture_prefers_parakeet", lambda: False)
    monkeypatch.setattr(ab.MLXWhisperBackend, "is_available", classmethod(lambda cls: (False, "")))
    backend = ab.get_capture_asr_backend()
    return ab._transcript_text(backend.transcribe(_clip(tmp_path), word_timestamps=False))


def _clone_reference_capture(ab, tmp_path, monkeypatch):
    # POST /capture/transcribe?mode=reference: Clone's reference transcription.
    backend = ab.load_active_asr_backend(require_installed=True)
    return ab._transcript_text(backend.transcribe(_clip(tmp_path), word_timestamps=False))


def _speech_check(ab, tmp_path, monkeypatch):
    return ab.transcribe_check(np.zeros(16000, np.float32), language="en")


def _dub_and_batch(ab, tmp_path, monkeypatch):
    backend = ab.load_active_asr_backend()
    return ab._transcript_text(backend.transcribe(_clip(tmp_path)))


@pytest.mark.parametrize("path", [
    _reference, _capture, _clone_reference_capture, _speech_check, _dub_and_batch,
], ids=["reference", "dictation-capture", "clone-reference", "speech-check", "dub-batch"])
def test_every_faster_whisper_path_loads_on_the_cpu_instead_of_aborting(
        card, tmp_path, monkeypatch, path):
    assert path(_mod("services.asr_backend"), tmp_path, monkeypatch) == "the words"
    assert card.loads == [("cpu", "int8")], "a CUDA load was started that cannot fit"


def test_the_clone_reference_request_that_killed_the_backend_now_answers(card):
    """POST /transcribe with mode=reference — Clone's reference transcription —
    loaded faster-whisper large-v3 in float16 with 0.8 GB free, and the
    backend died."""
    from fastapi.testclient import TestClient

    from main import app

    response = TestClient(app, client=("127.0.0.1", 50000)).post(
        "/transcribe", files={"audio": ("reference.wav", b"\x00" * 32000, "audio/wav")},
        data={"mode": "reference"})
    assert response.status_code == 200, response.text
    assert response.json()["engine"] == "faster-whisper"
    assert card.loads == [("cpu", "int8")]


@pytest.mark.parametrize("free, loaded", [
    (0.8, ("cpu", "int8")), (3.2, ("cuda", "int8")), (4.0, ("cuda", "int8_float16")),
    (7.0, ("cuda", "float16")),
])
def test_faster_whisper_loads_in_what_the_free_vram_holds(card, free, loaded):
    ab = _mod("services.asr_backend")
    card.free = free
    backend = ab.FasterWhisperBackend(model_name=LARGE_V3)
    backend._ensure_model()
    assert card.loads == [loaded]
    assert (backend._device, backend._compute_type) == loaded
    # The execution evidence diagnostics read says why it runs on the CPU.
    assert (backend._fallback_stage == "vram_preflight") is (loaded[0] == "cpu")


def test_a_reload_reports_where_it_loaded_this_time(card):
    ab = _mod("services.asr_backend")
    backend = ab.FasterWhisperBackend(model_name=LARGE_V3)
    backend._ensure_model()
    assert backend._fallback_reason is not None
    backend.unload()
    card.free, card.loads = 7.0, []
    backend._ensure_model()
    assert card.loads == [("cuda", "float16")]
    assert backend._fallback_reason is None and backend._fallback_stage is None


@pytest.mark.parametrize("free, loaded", [(3.2, ("cuda", "int8")), (0.8, ("cpu", "int8"))])
def test_a_pinned_compute_type_is_kept_or_moved_to_the_cpu(card, monkeypatch, free, loaded):
    monkeypatch.setenv("ASR_COMPUTE_TYPE", "int8")
    card.free = free
    _mod("services.asr_backend").FasterWhisperBackend(model_name=LARGE_V3)._ensure_model()
    assert card.loads == [loaded]


@pytest.mark.parametrize("pin", ["int8_float16", "float16", "bfloat16", "int8_bfloat16"])
def test_a_gpu_only_pinned_compute_type_loads_on_the_cpu_with_int8(card, monkeypatch, pin):
    """With too little VRAM the load moves to the CPU, which refuses a GPU-only
    ASR_COMPUTE_TYPE pin: it used to keep the pin there, and every
    transcription — clone reference, dub, batch, the speech check — failed."""
    monkeypatch.setenv("ASR_COMPUTE_TYPE", pin)
    card.free = 2.0
    _mod("services.asr_backend").FasterWhisperBackend(model_name=LARGE_V3)._ensure_model()
    assert card.loads == [("cpu", "int8")]


def test_the_speech_checks_fallback_shows_in_memory_as_its_catalogue_model(card, monkeypatch):
    """With the selected model not installed, the check falls back to the
    largest installed faster-whisper snapshot. It loads on the CPU when the
    card is full, and the loaded-model list names it by its repo, which Model
    Catalogue's In memory badge matches — not by a folder on disk."""
    ab = _mod("services.asr_backend")
    lifecycle = _mod("services.model_lifecycle")
    snapshot = os.path.join("hf", "hub", "models--Systran--faster-whisper-large-v3",
                            "snapshots", "a1b2c3")
    monkeypatch.setattr(ab, "asr_model_missing_error",
                        lambda **_kw: {"error": "asr_model_missing"})
    monkeypatch.setattr(ab, "_fallback_whisper_snapshot", lambda _exclude: snapshot)
    with _mod("services.speech_verify").recognizer_lease():
        assert ab.transcribe_check(np.zeros(16000, np.float32)) == "the words"
        listed = {m["id"]: m for m in lifecycle.list_loaded()["models"]}
        assert listed["speech-check-asr"]["checkpoint"] == LARGE_V3
        assert listed["speech-check-asr"]["device"] == "cpu"
    assert card.loads == [("cpu", "int8")]


def test_the_selected_speech_check_recognizer_shows_as_its_model(card):
    ab = _mod("services.asr_backend")
    card.free = 7.0
    with _mod("services.speech_verify").recognizer_lease():
        assert ab.transcribe_check(np.zeros(16000, np.float32)) == "the words"
        listed = {m["id"]: m for m in _mod("services.model_lifecycle").list_loaded()["models"]}
        assert listed["speech-check-asr"]["checkpoint"] == LARGE_V3
        assert listed["speech-check-asr"]["device"] == "cuda"


@pytest.mark.parametrize("free, loaded", [
    (0.8, ("cpu", "int8")), (3.2, ("cuda", "int8")), (7.0, ("cuda", "float16")),
])
def test_the_crash_isolated_sidecar_loads_in_what_the_free_vram_holds(
        card, monkeypatch, free, loaded):
    """The sidecar's abort only kills the child, but every retry respawns it
    into the same full card: it asks the same preflight before loading."""
    from core.device_caps import HostCaps
    from engines._asr_sidecar import main as sidecar

    monkeypatch.setattr(sidecar, "_model", None)
    monkeypatch.delenv("ASR_MODEL_FW", raising=False)
    monkeypatch.delenv("ASR_MODEL_FASTER", raising=False)
    monkeypatch.setattr("core.execstack.ensure_ctranslate2_loadable", lambda: (True, "ok"))
    monkeypatch.setattr("core.device_caps.detect_host_caps",
                        lambda: HostCaps(family="cuda", available_families=("cuda", "cpu")))
    card.free = free
    assert sidecar._get_model() is not None
    assert card.loads == [loaded]


@pytest.mark.parametrize("pin", ["int8_float16", "float16"])
def test_the_sidecar_loads_a_gpu_only_pin_on_the_cpu_with_int8(card, monkeypatch, pin):
    from core.device_caps import HostCaps
    from engines._asr_sidecar import main as sidecar

    monkeypatch.setattr(sidecar, "_model", None)
    monkeypatch.setenv("ASR_COMPUTE_TYPE", pin)
    monkeypatch.delenv("ASR_MODEL_FW", raising=False)
    monkeypatch.delenv("ASR_MODEL_FASTER", raising=False)
    monkeypatch.setattr("core.execstack.ensure_ctranslate2_loadable", lambda: (True, "ok"))
    monkeypatch.setattr("core.device_caps.detect_host_caps",
                        lambda: HostCaps(family="cuda", available_families=("cuda", "cpu")))
    card.free = 2.0
    assert sidecar._get_model() is not None
    assert card.loads == [("cpu", "int8")]


# ── Every CTranslate2 Whisper load asks first ──────────────────────────────

_PREFLIGHT_CALLS = {"_degrade_for_vram", "_fitting_compute_types", "fitting_compute_types"}


def _loads_without_preflight(root: Path) -> list[str]:
    """Functions under ``root`` that build a CTranslate2 Whisper model —
    ``WhisperModel(...)`` or ``whisperx.load_model(...)`` — without asking the
    VRAM preflight in the same function."""
    found = []
    for path in sorted(root.rglob("*.py")):
        parts = path.relative_to(root).parts
        if {"tests", "__pycache__", "site-packages"} & set(parts) or any(
                part.startswith(".") for part in parts):
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        if "WhisperModel" not in source and "load_model" not in source:
            continue
        for func in ast.walk(ast.parse(source)):
            if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            called, loads = set(), False
            for node in ast.walk(func):
                if not isinstance(node, ast.Call):
                    continue
                target = node.func
                name = target.attr if isinstance(target, ast.Attribute) else getattr(target, "id", None)
                called.add(name)
                owner = getattr(getattr(target, "value", None), "id", None)
                loads |= name == "WhisperModel" or (name == "load_model" and owner == "whisperx")
            if loads and not called & _PREFLIGHT_CALLS:
                found.append(f"{path.relative_to(root).as_posix()}:{func.lineno} {func.name}")
    return found


def test_every_ctranslate2_whisper_load_asks_the_vram_preflight_first():
    """A new load path that skips it is the #723 abort waiting for a full card."""
    assert _loads_without_preflight(ROOT / "backend") == []
