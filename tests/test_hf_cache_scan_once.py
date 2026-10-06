"""One Hugging Face cache scan per request.

``is_cached(repo)`` answers from a whole-cache ``scan_cache_dir()`` walk. The
performance profile asks about 17 repos on a typical install, so each settings
poll walked the cache 17 times (0.3–0.5 s of CPU, every 30 s and during every
model load). ``hf_cache_scan_scope()`` shares one scan per request, and the
polled diarisation status reads only the pyannote directories.
"""
from __future__ import annotations

import importlib

import pytest

_MB = 1024 * 1024


@pytest.fixture
def models():
    return importlib.import_module("api.routers.setup.models")


@pytest.fixture
def hf_cache(tmp_path, monkeypatch):
    cache = tmp_path / "hub"
    cache.mkdir()
    for name in ("HUGGINGFACE_HUB_CACHE", "HF_HOME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HF_HUB_CACHE", str(cache))
    return cache


@pytest.fixture
def scans(hf_cache, monkeypatch):
    """Count scan_cache_dir() calls; each one really scans the temporary cache."""
    import huggingface_hub

    real = huggingface_hub.scan_cache_dir
    calls = []

    def counting(*_args, **_kwargs):
        calls.append(1)
        return real(cache_dir=hf_cache)

    monkeypatch.setattr(huggingface_hub, "scan_cache_dir", counting)
    return calls


def _repo(root, repo_id, files):
    snapshot = root / ("models--" + repo_id.replace("/", "--")) / "snapshots" / "rev1"
    snapshot.mkdir(parents=True)
    for name, size in files.items():
        with open(snapshot / name, "wb") as handle:
            handle.truncate(size)


def test_performance_profile_read_scans_the_cache_once(hf_cache, scans):
    from api.routers.settings import get_performance_profile

    _repo(hf_cache, "org/unrelated", {"model.safetensors": 16})
    state = get_performance_profile()
    assert state["downloads_started"] is False
    assert len(scans) == 1


def test_applying_a_preset_scans_the_cache_once(hf_cache, scans):
    profiles = importlib.import_module("services.performance_profiles")

    _repo(hf_cache, "org/unrelated", {"model.safetensors": 16})
    profiles.activate_performance_tier("balanced")
    assert len(scans) == 1


def test_scope_shares_one_scan_and_ends_with_the_request(models, hf_cache, scans):
    _repo(hf_cache, "org/a", {"model.bin": 16})
    with models.hf_cache_scan_scope():
        assert models.is_cached("org/a") is True
        assert models.is_cached("org/b") is False
        with models.hf_cache_scan_scope():
            assert models.is_cached("org/a") is True
        _repo(hf_cache, "org/b", {"model.bin": 16})
        assert models.is_cached("org/b") is False  # one request, one view of the disk
    assert len(scans) == 1
    # The next request reads the disk as it is now; nothing needs invalidating.
    assert models.is_cached("org/b") is True
    assert len(scans) == 2


def test_empty_files_do_not_count_as_cached(models, hf_cache, scans):
    _repo(hf_cache, "org/empty", {"model.bin": 0})
    with models.hf_cache_scan_scope():
        assert models.is_cached("org/empty") is False


def test_scan_failure_falls_back_to_disk_once_per_scope(models, hf_cache, monkeypatch, caplog):
    _repo(hf_cache, "org/a", {"model.bin": 16})
    attempts = []

    def raise_winerror(*_args, **_kwargs):
        attempts.append(1)
        raise OSError(22, "[WinError 448] The specified network resource is no longer available")

    monkeypatch.setattr("huggingface_hub.scan_cache_dir", raise_winerror)
    with models.hf_cache_scan_scope():
        assert models.is_cached("org/a") is True
        assert models.is_cached("org/b") is False
    assert len(attempts) == 1
    assert caplog.text.count("scan_cache_dir failed") == 1


def test_missing_cache_is_not_rescanned_within_a_scope(models, hf_cache, monkeypatch, caplog):
    class CacheNotFound(Exception):
        """Test double for huggingface_hub.errors.CacheNotFound."""

    attempts = []

    def missing(*_args, **_kwargs):
        attempts.append(1)
        raise CacheNotFound("Cache directory does not exist")

    monkeypatch.setattr("huggingface_hub.scan_cache_dir", missing)
    monkeypatch.setattr(
        models,
        "_is_cached_on_disk",
        lambda _repo: pytest.fail("an empty cache must not be walked again"),
    )
    with models.hf_cache_scan_scope():
        assert models.is_cached("org/a") is False
        assert models.is_cached("org/b") is False
    assert len(attempts) == 1
    assert "scan_cache_dir failed" not in caplog.text


def test_diarisation_status_does_not_scan_the_whole_cache(hf_cache, monkeypatch):
    from api.routers import engines

    monkeypatch.setattr(
        "huggingface_hub.scan_cache_dir",
        lambda *_a, **_k: pytest.fail("a polled status read walked the whole cache"),
    )

    def pyannote():
        return next(
            option for option in engines.diarisation_status()["options"]
            if option["model"] == "pyannote/speaker-diarization-3.1"
        )

    assert pyannote()["installed"] is False
    _repo(hf_cache, "pyannote/speaker-diarization-3.1", {"config.yaml": 32})
    assert pyannote()["installed"] is False  # the weight repositories are missing
    _repo(hf_cache, "pyannote/segmentation-3.0", {"pytorch_model.bin": 6 * _MB})
    _repo(hf_cache, "pyannote/wespeaker-voxceleb-resnet34-LM", {"pytorch_model.bin": 6 * _MB})
    assert pyannote()["installed"] is True


def test_default_cache_follows_xdg_cache_home(models, tmp_path, monkeypatch):
    """huggingface_hub stores repos under $XDG_CACHE_HOME/huggingface/hub when no
    cache variable is set; the direct-filesystem checks must look there too."""
    for name in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_HOME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    _repo(tmp_path / "huggingface" / "hub", "org/a", {"model.bin": 16})
    assert models.hf_cache_dir() == str(tmp_path / "huggingface")
    assert models._is_cached_on_disk("org/a") is True
