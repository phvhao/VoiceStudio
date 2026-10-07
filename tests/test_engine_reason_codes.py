"""Engine and model status reasons travel as stable codes the app translates.

Settings → Models showed the backend's English sentences verbatim in every
language: "Install the pyannote model bundle", "This engine's package isn't
installed yet…", "Engine unavailable. Check installation and configuration.",
a routing tooltip, and "Could not unload: in use by dictation". Each sentence
now has a stable ``*_code`` beside it. The sentence stays for API clients; the
desktop renderer shows ``engineReason.<group>.<code>`` from its own catalog.

The contract test at the bottom is the point: every code the backend can send
must have a translation in every renderer locale, or that language shows the
English fallback again.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from api import public_engine_metadata as meta

_LOCALES = Path(__file__).resolve().parents[1] / "electron/src/renderer/src/i18n/locales"
_CODE = re.compile(r"^[a-z][a-z0-9_]*$")
_PRIVATE = "/home/alice/.cache/hf_secret-token"


def _engine_row(**fields):
    return meta.public_backends([{"id": "e", **fields}])[0]


@pytest.mark.parametrize(
    ("diagnostic", "one_click", "code"),
    [
        ("voxcpm package not installed.", None, "not_installed"),
        ("voxcpm package not installed.", False, "not_installed_manual"),
        ("file is missing", None, "file_missing"),
        ("file is missing", False, "file_missing_manual"),
        ("Supertonic-3 license not accepted. Open Model Catalogue", None, "license_not_accepted"),
        ("MLX requires Apple Silicon; this host is win32/AMD64", None, "platform_unsupported"),
        ("Apple Silicon detected but torch MPS unavailable", None, "mps_unavailable"),
        ("Set ELEVENLABS_API_KEY environment variable.", None, "needs_config"),
        ("something entirely unexpected", None, "unavailable"),
    ],
)
def test_an_unavailable_engine_sends_the_code_of_its_sentence(diagnostic, one_click, code):
    fields = {"reason": f"{diagnostic} {_PRIVATE}"}
    if one_click is not None:
        fields["one_click_install"] = one_click
    row = _engine_row(**fields)
    assert row["reason_code"] == code
    assert meta.UNAVAILABLE_REASON_CODES[row["reason"]] == code
    assert _PRIVATE not in repr(row)


def test_an_available_engine_sends_no_reason_code():
    row = _engine_row(reason=None, routing_reason=None, routing_status="accelerated")
    assert "reason_code" not in row
    assert "routing_reason_code" not in row


@pytest.mark.parametrize(
    ("status", "diagnostic", "code"),
    [
        ("cpu_fallback", "no CUDA path", "cpu_fallback"),
        ("cpu_only", "DirectML present; CPU path", "cpu_only"),
        ("unavailable", "requires cuda; this host has cpu", "no_device"),
        ("mystery", "?", "unknown"),
        ("accelerated", "sm_120 may fail at kernel launch", "accelerator_kernel_risk"),
        ("accelerated", "RTX has 4.0 GB VRAM; this engine wants about 8 GB.", "accelerator_low_vram"),
        ("accelerated", "a caveat", "accelerator_advisory"),
    ],
)
def test_a_routing_caveat_sends_the_code_of_its_sentence(status, diagnostic, code, monkeypatch):
    if code == "accelerator_kernel_risk":
        diagnostic = f"{diagnostic} — {meta.KERNEL_RISK_MARKER}"
    row = _engine_row(routing_status=status, routing_reason=f"{diagnostic} {_PRIVATE}")
    assert row["routing_reason_code"] == code
    assert meta.ROUTING_REASON_CODES[row["routing_reason"]] == code
    assert _PRIVATE not in repr(row)


@pytest.mark.parametrize(
    ("detail", "code"),
    [
        (None, None),
        ("import 'deep_translator' failed: No module named 'deep_translator'", "not_installed"),
        ("NLLB model weights are not installed", "not_installed"),
        ("Translation provider is not configured", "needs_config"),
        ("ctranslate2's native library requests an executable stack", "unavailable"),
    ],
)
def test_a_provider_probe_is_classified_like_an_engine(detail, code):
    assert meta.public_unavailability_code(detail) == code
    sentence = meta.public_unavailability(detail)
    assert (sentence is None) is (code is None)
    if sentence is not None:
        assert meta.UNAVAILABLE_REASON_CODES[sentence] == code


def test_the_code_maps_are_one_to_one_and_stable_shaped():
    for codes in (meta.UNAVAILABLE_REASON_CODES, meta.ROUTING_REASON_CODES):
        assert len(set(codes.values())) == len(codes)
        assert all(_CODE.match(code) for code in codes.values())


@pytest.fixture
def engines_client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.routers import engines

    # Selecting must not persist a fake engine into the suite's prefs.
    monkeypatch.setattr(engines.prefs, "set_", lambda *args, **kwargs: None)
    app = FastAPI()
    app.include_router(engines.router)
    return engines, TestClient(app, client=("127.0.0.1", 12345))


def test_translation_providers_send_their_reason_code(engines_client, monkeypatch):
    engines, client = engines_client
    monkeypatch.setattr(
        engines.translation_engines,
        "list_engines",
        lambda: [
            {"id": "deepl", "installed": True, "availability_reason": "Translation provider is not configured"},
            {"id": "google", "installed": False, "availability_reason": f"import 'x' failed at {_PRIVATE}"},
            {"id": "argos", "installed": True, "availability_reason": None},
        ],
    )
    body = client.get("/engines/translation").json()
    codes = {entry["id"]: entry["availability_reason_code"] for entry in body["engines"]}
    assert codes == {"deepl": "needs_config", "google": "not_installed", "argos": None}
    assert _PRIVATE not in repr(body)


def test_selecting_an_engine_echoes_the_public_routing_reason(engines_client, monkeypatch):
    engines, client = engines_client
    row = {
        "id": "fake-asr",
        "available": True,
        "routing_status": "cpu_fallback",
        "effective_device": "cpu",
        "routing_reason": f"no CUDA build at {_PRIVATE}",
    }
    monkeypatch.setattr(engines.asr_backend, "list_backends", lambda: [row])
    monkeypatch.setattr(engines.asr_backend, "active_backend_id", lambda: "fake-asr")

    response = client.post("/engines/select", json={"family": "asr", "backend_id": "fake-asr"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["routing_reason"] == "GPU acceleration is unavailable; this engine will use CPU."
    assert body["routing_reason_code"] == "cpu_fallback"
    assert _PRIVATE not in response.text


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        (
            {"available": False, "reason": f"voxcpm package not installed at {_PRIVATE}"},
            "not ready: This engine's package isn't installed yet.",
        ),
        (
            {"available": True, "routing_status": "unavailable", "routing_reason": f"needs cuda; {_PRIVATE}"},
            "can't run on this machine: This engine has no compatible compute device on this host. Pick",
        ),
    ],
)
def test_a_refused_selection_never_echoes_the_probe_text(engines_client, monkeypatch, row, expected):
    engines, client = engines_client
    monkeypatch.setattr(engines.asr_backend, "list_backends", lambda: [{"id": "fake-asr", **row}])

    response = client.post("/engines/select", json={"family": "asr", "backend_id": "fake-asr"})

    assert response.status_code == 400
    assert expected in response.json()["detail"]
    assert _PRIVATE not in response.text


def test_diarisation_reasons_are_coded():
    from services import diarization_runtime

    assert all(_CODE.match(code) for code in diarization_runtime.REASONS)
    assert diarization_runtime.reason_fields(None) == {"reason": None, "reason_code": None}
    assert diarization_runtime.reason_fields("pyannote_not_installed") == {
        "reason": "Install the pyannote model bundle",
        "reason_code": "pyannote_not_installed",
    }


@pytest.mark.parametrize(
    ("notice", "code"),
    [
        (("cpu_fallback", "CUDA kernel image unavailable for sm_120"), "cpu_fallback"),
        (("cpu_fallback", None), "cpu_fallback"),
        (("accelerated", "NVIDIA GeForce RTX 3050 has 4.0 GB VRAM; this engine wants about 6 GB."),
         "accelerator_low_vram"),
        (("accelerated", "Driver advisory for this card."), "accelerator_advisory"),
    ],
)
def test_a_render_on_fallback_sends_the_code_of_its_routing_reason(notice, code):
    """The Synthesize notice showed the engine's English routing sentence
    (with the GPU's name) in every language; the code beside it is what the
    app translates, as Settings does."""
    from api.routers.generation import _apply_routing_headers

    headers = _apply_routing_headers({}, notice, None)
    assert headers["X-OmniVoice-Routing"] == notice[0]
    assert headers["X-OmniVoice-Routing-Reason-Code"] == code
    assert code in meta.ROUTING_REASON_CODES.values()


def test_a_worker_notice_sends_no_routing_code():
    from types import SimpleNamespace

    from api.routers.generation import _apply_routing_headers

    remote = SimpleNamespace(remote=True, label="gpu2", reason="chosen")
    headers = _apply_routing_headers({}, None, remote)
    assert headers["X-OmniVoice-Routing"] == "remote"
    assert "X-OmniVoice-Routing-Reason-Code" not in headers


def test_a_declined_unload_sends_its_code(monkeypatch):
    import asyncio

    from services import model_lifecycle

    monkeypatch.setattr(model_lifecycle.mm, "_diar_pipeline", None)
    result = asyncio.run(model_lifecycle.unload("diarization"))
    assert result == {
        "unloaded": "diarization",
        "success": False,
        "reason": "not loaded",
        "reason_code": "not_loaded",
    }
    assert all(_CODE.match(code) for code in model_lifecycle.UNLOAD_DECLINED)


def _backend_codes() -> dict[str, set[str]]:
    from services import diarization_runtime, model_lifecycle

    return {
        "unavailable": set(meta.UNAVAILABLE_REASON_CODES.values()),
        "routing": set(meta.ROUTING_REASON_CODES.values()),
        "diarisation": set(diarization_runtime.REASONS),
        "unload": set(model_lifecycle.UNLOAD_DECLINED),
    }


@pytest.mark.parametrize("locale", sorted(path.stem for path in _LOCALES.glob("*.json")))
def test_every_reason_code_is_translated_in_every_locale(locale):
    catalog = json.loads((_LOCALES / f"{locale}.json").read_text(encoding="utf-8"))
    translated = catalog.get("engineReason", {})
    for group, codes in _backend_codes().items():
        strings = translated.get(group, {})
        missing = sorted(codes - set(strings))
        assert not missing, f"{locale}: engineReason.{group} lacks {missing}"
        assert all(isinstance(text, str) and text.strip() for text in strings.values())
        # A translated code the backend can no longer send is dead text.
        assert set(strings) <= codes, f"{locale}: engineReason.{group} has stale codes"
    assert set(translated) == set(_backend_codes()), f"{locale}: unexpected engineReason groups"
