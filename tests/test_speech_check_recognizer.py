"""The speech check's recognizer: one warm model per render, told the language.

Each checked phrase used to go through ``transcribe_reference``, which builds a
fresh backend per call for the whisper family: faster-whisper large-v3 loaded
again before every checked phrase (2.9–3.5 s on an RTX 3060, 6 loads in a
6-phrase render), auto-detected the language, and filled the reference-clip
transcript cache with takes (an identical retake was then served from it).

Now a render holds a lease and one instance serves all its checks; the model
is released when the render ends, when the memory it holds runs low (VRAM on
a GPU, RAM on the CPU), and by the make-room, idle and Unload paths — never in
the middle of a transcription — and no check waits on one that is stuck.
Stub recognizers throughout: no model, no GPU.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import threading
import types
import zlib

import numpy as np
import pytest
import torch

SR = 24000

SENTENCES = [
    "The lighthouse keeper climbed the stairs at dusk.",
    "Every evening he polished the great brass lamp.",
    "Ships passed far out beyond the rocky northern point.",
    "Storms came in winter and rattled every window pane.",
    "In spring the gulls returned to the cliffs again.",
    "He wrote each night in a leather logbook by the stove.",
]


def _mod(name: str):
    return importlib.import_module(name)


def _settled():
    """Wait for the release a render's end hands to a thread of its own."""
    for thread in threading.enumerate():
        if thread.name == "speech-check-release":
            thread.join(timeout=10)


def _take(text: str) -> torch.Tensor:
    """A take whose samples depend on its text (so no two phrases share audio)."""
    return torch.full((1, 2400), 0.05 + (zlib.crc32(text.encode()) % 100) / 1000.0)


class _Spoken:
    """What the stub engines said last — a stub recognizer hears exactly that."""

    text = ""


@pytest.fixture
def asr(monkeypatch):
    """``services.asr_backend`` with a fresh speech-check slot, the selected
    engine installed and no dictation engine or fallback installed."""
    ab = _mod("services.asr_backend")
    monkeypatch.setattr(ab, "_check_backend", None)
    monkeypatch.setattr(ab, "_check_backend_key", None)
    monkeypatch.setattr(ab, "_check_leases", 0)
    monkeypatch.setattr(ab, "_check_last_used", 0.0)
    monkeypatch.setattr(ab, "_check_unusable", set())
    monkeypatch.setattr(ab, "_check_held_since", None)
    monkeypatch.setattr(ab, "_check_stall_reported", None)
    monkeypatch.setattr(ab, "active_backend_id", lambda: "faster-whisper")
    monkeypatch.setattr(ab, "_probe_available", lambda cls: True)
    monkeypatch.setattr(ab, "_offline_asr_repo", lambda bid=None: "Systran/faster-whisper-large-v3")
    monkeypatch.setattr(
        ab, "asr_model_missing_error",
        lambda **kw: {"error": "asr_model_missing"} if kw.get("purpose") == "dictation" else None)
    monkeypatch.setattr(ab, "_installed_reference_fallbacks", lambda selected: [])
    # Plenty of memory unless a test says otherwise; the real policy decides.
    monkeypatch.setattr(_mod("services.memory_budget"), "available_memory",
                        lambda: {"ram_available_gb": 64.0, "vram_free_gb": 64.0})
    monkeypatch.setattr(_Spoken, "text", "")
    yield ab
    _settled()
    assert not ab._check_lock.locked(), "a test left the check lock held"


def _recognizer_class(ab, *, hears=lambda audio: _Spoken.text, waveform=True, device=None):
    """A stub recognizer: counts instances, loads and unloads, and records
    what it was handed. ``device`` is where it loads, as whisperx and
    faster-whisper record it (``None``: a CPU-only engine)."""

    class _Recognizer(ab.ASRBackend):
        id = "faster-whisper"
        accepts_waveform = waveform
        built = 0
        loads = 0
        unloads = 0
        heard: list = []

        def __init__(self):
            type(self).built += 1
            self._model = None
            if device is not None:
                self._device = device

        @classmethod
        def is_available(cls):
            return True, "ready"

        def transcribe(self, audio_path, *, word_timestamps=True, language=None):
            if self._model is None:
                type(self).loads += 1
                self._model = object()
            type(self).heard.append((audio_path, language))
            return {"text": hears(audio_path)}

        def unload(self):
            if self._model is not None:
                type(self).unloads += 1
            self._model = None

    _Recognizer.heard = []
    return _Recognizer


@pytest.fixture
def selected(asr, monkeypatch):
    """The selected engine: a stub built anew on every load request, as
    ``load_active_asr_backend`` builds the whisper family."""
    cls = _recognizer_class(asr)
    monkeypatch.setattr(asr, "load_active_asr_backend", lambda **_kw: cls())
    return cls


# ── One load per render ──────────────────────────────────────────────────────

def _verifier(sr=SR, **kw):
    return _mod("services.speech_verify").SpeechVerifier(sr, **kw)


def _check_sentences(verifier):
    for text in SENTENCES:
        def take(_attempt, text=text):
            _Spoken.text = text
            return _take(text)
        verifier.render(text, take)


def test_a_render_loads_its_recognizer_once(selected):
    speech = _mod("services.speech_verify")
    with speech.recognizer_lease():
        verifier = _verifier()
        _check_sentences(verifier)
        assert selected.loads == 1 and selected.built == 1
    assert verifier.checked == len(SENTENCES) and verifier.retaken == 0
    # Released when the render ends.
    _settled()
    assert selected.unloads == 1 and _mod("services.asr_backend")._check_backend is None


def test_a_check_outside_any_render_does_not_keep_the_model(selected):
    _check_sentences(_verifier())
    assert selected.loads == len(SENTENCES) == selected.unloads


def test_identical_takes_are_both_heard(selected):
    """A take is never answered from the cache kept for voice references: a
    retake that renders the same samples is listened to again."""
    ab = _mod("services.asr_backend")
    before = dict(ab._ref_transcript_cache)
    _Spoken.text = "the words"
    take = np.full(16000, 0.1, np.float32)
    assert ab.transcribe_check(take) == ab.transcribe_check(take.copy()) == "the words"
    assert len(selected.heard) == 2
    assert dict(ab._ref_transcript_cache) == before


def test_generate_reading_loads_its_recognizer_once(selected, monkeypatch):
    gen = _mod("api.routers.generation")
    monkeypatch.setattr(_mod("services.chunked_tts"), "PHRASE_MIN_CHARS", 0)

    class _Model:
        sampling_rate = SR

        def create_voice_clone_prompt(self, ref_audio, ref_text=None, preprocess_prompt=True):
            return "PROMPT"

        def generate(self, **kw):
            _Spoken.text = kw["text"]
            return [_take(kw["text"])[0]]

    gen._run_inference(
        model=_Model(), text=" ".join(SENTENCES), language="English", ref_audio_path=None,
        ref_text=None, instruct=None, duration=None, num_step=4, guidance_scale=2.0, speed=1.0,
        t_shift=None, denoise=False, postprocess_output=False, layer_penalty_factor=None,
        position_temperature=None, class_temperature=None, used_seed=7, effect_preset="raw",
        reading={"pauses": dict(_mod("services.chunked_tts").DEFAULT_PUNCTUATION_PAUSES),
                 "split_commas": False, "verify": True},
    )
    _settled()
    assert len(selected.heard) == len(SENTENCES)
    assert selected.loads == 1 and selected.unloads == 1


def test_a_streamed_generate_loads_its_recognizer_once(selected, tmp_path, monkeypatch):
    """Each phrase of a streamed take renders as its own GPU job; the stream's
    lease keeps one recognizer for all of them."""
    import sqlite3

    from fastapi.testclient import TestClient

    import core.config as cfg
    gen = _mod("api.routers.generation")
    tts = _mod("services.tts_backend")
    monkeypatch.setattr(_mod("services.chunked_tts"), "PHRASE_MIN_CHARS", 0)
    outdir = tmp_path / "outputs"
    outdir.mkdir()
    monkeypatch.setattr(cfg, "OUTPUTS_DIR", str(outdir))
    monkeypatch.setattr(gen, "OUTPUTS_DIR", str(outdir))

    def _get_db():
        conn = sqlite3.connect(str(tmp_path / "history.db"))
        conn.row_factory = sqlite3.Row
        return conn

    monkeypatch.setitem(gen.ensure_schema.__globals__, "get_db", _get_db)
    gen.ensure_schema()

    class _Engine(tts.TTSBackend):
        id = "check-fake"
        display_name = "Speech-check fake engine (test)"
        gpu_compat = ("cpu",)

        @property
        def sample_rate(self) -> int:
            return SR

        @property
        def supported_languages(self) -> list[str]:
            return ["multi"]

        @classmethod
        def is_available(cls):
            return True, "ready"

        def generate(self, text, **_kw) -> torch.Tensor:
            _Spoken.text = text
            return _take(text)

    monkeypatch.setitem(tts._REGISTRY, "check-fake", _Engine)
    from main import app

    client = TestClient(app, client=("127.0.0.1", 50000))
    reading = json.dumps({"punctuation_pauses": {"sentence": 100}, "verify_speech": True})
    with client.stream("POST", "/generate", data={
        "text": " ".join(SENTENCES), "engine": "check-fake", "seed": "7",
        "stream": "true", "reading": reading,
    }) as response:
        assert response.status_code == 200
        events = [json.loads(line) for line in response.iter_lines() if line.strip()]
    _settled()
    assert events[-1]["type"] == "done", events
    assert len(selected.heard) == len(SENTENCES)
    assert selected.loads == 1 and selected.unloads == 1


@pytest.fixture
def longform(selected, tmp_path, monkeypatch):
    """The long-form router rendering through a stub engine at 24 kHz."""
    config = _mod("core.config")
    monkeypatch.setattr(config, "OUTPUTS_DIR", str(tmp_path))
    monkeypatch.setattr(config, "VOICES_DIR", str(tmp_path / "voices"))
    watermark = _mod("services.watermark")
    monkeypatch.setattr(watermark, "will_mark", lambda: False)
    monkeypatch.setattr(watermark, "mark_synthetic", lambda audio, *_a, **_k: audio)
    monkeypatch.setattr(_mod("services.chunked_tts"), "PHRASE_MIN_CHARS", 0)
    router = _mod("api.routers.audiobook")
    monkeypatch.setattr(_mod("services.tts_backend"), "active_backend_id", lambda: "eng")
    monkeypatch.setattr(router, "_local_sample_rate", lambda engine_id: SR)
    monkeypatch.setattr(_mod("services.gpu_gateway"), "decide",
                        lambda *_a, **_k: types.SimpleNamespace(remote=False))

    def synth(text, voice_id, speed=None, attempt=0):
        _Spoken.text = text
        return _take(text)

    def build_synth(default_voice=None, language=None, opts=None, voice_map=None, lease=None):
        return {"mode": "generic", "engine_id": "eng", "sample_rate": SR,
                "resolve": router._voice_resolver(default_voice, voice_map, lease),
                "synth": synth}

    monkeypatch.setattr(router, "_build_synth", build_synth)
    return router


def test_a_chapter_preview_loads_its_recognizer_once(longform, selected, monkeypatch):
    speech = _mod("services.speech_verify")
    real, made = speech.SpeechVerifier, []
    monkeypatch.setattr(speech, "SpeechVerifier",
                        lambda sr, **kw: made.append(real(sr, **kw)) or made[-1])
    result = asyncio.run(longform.audiobook_preview(longform.AudiobookPreviewRequest(
        text="# One\n" + " ".join(SENTENCES), verify_speech=True, language="English",
        punctuation_pauses={"sentence": 100})))
    _settled()
    assert result["speech_check"]["checked"] == len(SENTENCES)
    assert selected.loads == 1 and selected.unloads == 1
    # Told the chapter's language; a recognizer that is no Whisper model is
    # never handed it (it detects, as before).
    assert [verifier.language for verifier in made] == ["en"]
    assert {language for _audio, language in selected.heard} == {None}


@pytest.mark.skipif(importlib.import_module("services.ffmpeg_utils").find_ffmpeg() is None,
                    reason="ffmpeg required for a full render")
def test_a_book_loads_its_recognizer_once_for_all_chapters(longform, selected):
    half = len(SENTENCES) // 2
    script = ("# One\n" + " ".join(SENTENCES[:half]) + "\n# Two\n" + " ".join(SENTENCES[half:]))

    async def render():
        response = await longform.audiobook_synthesize(longform.AudiobookRequest(
            text=script, verify_speech=True, punctuation_pauses={"sentence": 100}))
        return [json.loads(frame[len("data:"):]) async for frame in response.body_iterator]

    events = asyncio.run(asyncio.wait_for(render(), timeout=120))
    _settled()
    assert events[-1]["type"] == "done", events
    assert sum(e["speech_check"]["checked"] for e in events if e["type"] == "chapter") \
        == len(SENTENCES)
    assert selected.loads == 1 and selected.unloads == 1


# ── The language ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("language, code", [
    ("Vietnamese", "vi"), ("vietnamese", "vi"), ("English", "en"), ("Chinese", "zh"),
    ("Standard Arabic", "ar"), ("Arabic", "ar"), ("Chinese (Traditional)", "zh"),
    ("Javanese", "jw"), ("Norwegian Bokmål", "no"), ("Filipino", "tl"), ("Nepali", "ne"),
    ("vi", "vi"), ("pt-BR", "pt"), ("zh_CN", "zh"), ("cmn-Hans", "zh"), ("Auto", None),
    ("", None), (None, None), ("Klingon", None), ("Cantonese", None),
    ("Northern Kurdish", None), ("Zulu", None),
])
def test_the_render_language_becomes_a_whisper_code(language, code):
    assert _mod("services.speech_verify").recognizer_language(language) == code


def test_every_picker_language_whisper_knows_gets_its_code():
    """The long-form pickers send their labels: each one Whisper transcribes
    is told to it (the others are detected, as before)."""
    import pathlib
    import re

    js = (pathlib.Path(__file__).resolve().parents[1] / "electron" / "src" / "shared"
          / "utils" / "languages.js").read_text(encoding="utf-8")
    labels = re.findall(r"label: '([^']+)'", js)
    assert len(labels) > 80
    speech = _mod("services.speech_verify")
    untold = {label for label in labels if speech.recognizer_language(label) is None}
    # Languages Whisper does not transcribe. A new picker label lands here
    # only if Whisper lacks it too; else spell it in services.language_codes.
    assert untold == {"Kurdish", "Kyrgyz", "Samoan", "Scots Gaelic", "Xhosa", "Zulu"}


class _Segment(types.SimpleNamespace):
    pass


def _whisper_class(ab, languages):
    """faster-whisper itself over a stub model that knows ``languages``."""

    class _Whisper(ab.FasterWhisperBackend):
        calls: list = []

        def __init__(self):
            super().__init__(model_name="Systran/faster-whisper-large-v3")

        def _ensure_model(self):
            if self._model is not None:
                return
            calls = type(self).calls

            class _Model:
                supported_languages = list(languages)

                def transcribe(self, audio, **kw):
                    calls.append((audio, kw))
                    info = types.SimpleNamespace(language=kw.get("language", "en"),
                                                 language_probability=1.0, duration=1.0)
                    return iter([_Segment(text=" the lamp held", start=0.0, end=1.0,
                                          words=[])]), info

            self._model = _Model()

    _Whisper.calls = []
    return _Whisper


@pytest.mark.parametrize("languages, told", [(("en", "vi"), "vi"), (("en",), None)])
def test_whisper_is_told_a_language_its_model_knows(asr, monkeypatch, languages, told):
    whisper = _whisper_class(asr, languages)
    monkeypatch.setattr(asr, "load_active_asr_backend", lambda **_kw: whisper())
    audio = np.zeros(16000, np.float32)
    assert asr.transcribe_check(audio, language="vi") == "the lamp held"
    sent, options = whisper.calls[0]
    assert options.get("language") == told
    assert sent is audio, "faster-whisper takes the 16 kHz array, not a temp WAV"


def test_a_take_is_handed_over_at_16_khz_mono(selected):
    speech = _mod("services.speech_verify")
    _Spoken.text = "the words"
    stereo_48k = torch.zeros(2, 48000)
    assert speech.transcribe_take(stereo_48k, 48000) == "the words"
    audio, _language = selected.heard[0]
    assert isinstance(audio, np.ndarray) and audio.dtype == np.float32
    assert audio.shape == (16000,)


def test_a_recognizer_that_reads_files_gets_a_16_khz_wav_it_never_keeps(asr, monkeypatch):
    import os

    import soundfile as sf

    seen = {}

    def hears(path):
        seen["path"], seen["rate"] = path, sf.info(path).samplerate
        return "the words"

    cls = _recognizer_class(asr, hears=hears, waveform=False)
    monkeypatch.setattr(asr, "load_active_asr_backend", lambda **_kw: cls())
    assert asr.transcribe_check(np.zeros(8000, np.float32)) == "the words"
    assert seen["rate"] == 16000
    assert not os.path.exists(seen["path"])


# ── Released whenever synthesis may need the memory ─────────────────────────

def test_low_memory_releases_it_between_checks(selected, monkeypatch):
    monkeypatch.setattr(_mod("services.memory_budget"), "available_memory",
                        lambda: {"ram_available_gb": 0.8})
    with _mod("services.speech_verify").recognizer_lease():
        _check_sentences(_verifier())
    assert selected.loads == len(SENTENCES) == selected.unloads


def test_make_room_and_unload_release_it_between_checks(selected):
    ab = _mod("services.asr_backend")
    lifecycle = _mod("services.model_lifecycle")
    with _mod("services.speech_verify").recognizer_lease():
        verifier = _verifier()
        _check_sentences(verifier)
        listed = {m["id"]: m for m in lifecycle.list_loaded()["models"]}
        assert listed["speech-check-asr"]["unloadable"] is True
        _mod("services.model_manager")._release_idle_tts_memory("load")
        assert ab._check_backend is None and selected.unloads == 1
        _check_sentences(verifier)  # the next check loads it again
        assert selected.loads == 2
        result = asyncio.run(lifecycle.unload("speech-check-asr"))
        assert result["success"] is True and selected.unloads == 2
        assert asyncio.run(lifecycle.unload("speech-check-asr"))["reason"] == "not loaded"


def test_a_generate_takes_back_gpu_memory_the_recognizer_holds(asr, monkeypatch):
    """The make-room policy before a generate or a model load looks at free
    RAM only; a recognizer on the GPU also gives way when free VRAM runs low."""
    ab = _mod("services.asr_backend")
    mm = _mod("services.model_manager")
    budget = _mod("services.memory_budget")
    cls = _recognizer_class(ab, device="cuda")
    monkeypatch.setattr(ab, "load_active_asr_backend", lambda **_kw: cls())
    monkeypatch.setattr(mm, "_should_make_room_for_generate", lambda: False)
    with _mod("services.speech_verify").recognizer_lease():
        _check_sentences(_verifier())
        mm.make_room_before_generate()
        mm._make_room_before_tts_load()
        assert ab._check_backend is not None, "plenty of memory: kept for the next check"
        monkeypatch.setattr(budget, "available_memory",
                            lambda: {"ram_available_gb": 64.0, "vram_free_gb": 0.8})
        mm.make_room_before_generate()
        assert ab._check_backend is None and cls.unloads == 1


@pytest.mark.parametrize("device, free, released", [
    # Pinned to the CPU on a CUDA card: the model sits in RAM, which runs low.
    ("cpu", {"ram_available_gb": 1.0, "vram_free_gb": 11.2}, True),
    # On the CPU (a ROCm card, or a load that ran out of VRAM): unloading it
    # frees no VRAM, and the next check would only load it again.
    ("cpu", {"ram_available_gb": 20.0, "vram_free_gb": 0.8}, False),
    ("cuda", {"ram_available_gb": 1.0, "vram_free_gb": 11.2}, False),
    ("cuda", {"ram_available_gb": 20.0, "vram_free_gb": 0.8}, True),
    # A computer without a GPU, and an engine that runs only on the CPU.
    (None, {"ram_available_gb": 1.0}, True),
    (None, {"ram_available_gb": 1.0, "vram_free_gb": 11.2}, True),
], ids=["cpu-low-ram", "cpu-low-vram", "gpu-low-ram", "gpu-low-vram", "no-gpu", "cpu-engine"])
def test_the_recognizer_gives_way_when_the_memory_it_holds_runs_low(
        asr, monkeypatch, device, free, released):
    """Free VRAM decides only for a recognizer on the GPU; one on the CPU
    is weighed against free RAM — before a generate and after each check."""
    ab = _mod("services.asr_backend")
    cls = _recognizer_class(ab, device=device)
    monkeypatch.setattr(ab, "load_active_asr_backend", lambda **_kw: cls())
    memory = {"free": {"ram_available_gb": 64.0, "vram_free_gb": 64.0}}
    monkeypatch.setattr(_mod("services.memory_budget"), "available_memory",
                        lambda: dict(memory["free"]))
    with _mod("services.speech_verify").recognizer_lease():
        verifier = _verifier()
        _check_sentences(verifier)
        assert cls.loads == 1
        memory["free"] = free
        assert ab.release_check_recognizer_when_memory_low() is released
        cls.loads = 0
        _check_sentences(verifier)
        assert cls.loads == (len(SENTENCES) if released else 0)


def test_a_check_in_progress_is_never_interrupted(selected):
    ab = _mod("services.asr_backend")
    lifecycle = _mod("services.model_lifecycle")
    lease = _mod("services.speech_verify").recognizer_lease()
    _check_sentences(_verifier())
    with ab._check_lock:  # a transcription is running
        assert ab.release_check_recognizer() is False
        result = asyncio.run(lifecycle.unload("speech-check-asr"))
        assert result["success"] is False and "speech check" in result["reason"]
        assert selected.unloads == 0
    lease.release()
    _settled()
    assert selected.unloads == 1


def test_a_render_ending_mid_check_releases_it_once_the_check_is_done(selected):
    ab = _mod("services.asr_backend")
    lease = _mod("services.speech_verify").recognizer_lease()
    _check_sentences(_verifier())
    ab._check_lock.acquire()  # a check is transcribing on a GPU worker

    async def end_render():  # the render's own finally, on the event loop
        lease.release()

    asyncio.run(end_render())
    assert selected.unloads == 0
    ab._check_lock.release()
    _settled()
    assert selected.unloads == 1 and ab._check_backend is None


def test_a_stuck_check_never_stalls_another_renders_checks(selected, monkeypatch, caplog):
    """#730: an in-process transcription can wedge for good on a starved GPU.
    Every other render's check used to block behind it forever, and the model
    could no longer be released. Now a check gives way after CHECK_WAIT_S —
    its take unchecked, and the chapter's check turns itself off — later
    checks do not wait at all, and the release paths decline, once."""
    ab = _mod("services.asr_backend")
    lifecycle = _mod("services.model_lifecycle")
    monkeypatch.setattr(ab, "CHECK_WAIT_S", 0.3)
    caplog.set_level("WARNING", logger="omnivoice.asr")
    lease = _mod("services.speech_verify").recognizer_lease()
    _check_sentences(_verifier())
    assert ab._take_check_lock()  # this check never returns
    try:
        verifier = _verifier()
        other_render = threading.Thread(target=_check_sentences, args=(verifier,), daemon=True)
        other_render.start()
        other_render.join(timeout=5)
        assert not other_render.is_alive(), "a stuck check stalled another render's checks"
        assert verifier.unavailable and verifier.checked == 0
        assert ab.transcribe_check(np.zeros(16000, np.float32)) is None
        assert ab.release_check_recognizer(wait=True) is False
        assert ab.release_check_recognizer() is False
        result = asyncio.run(lifecycle.unload("speech-check-asr"))
        assert result["success"] is False and "speech check" in result["reason"]
        said = [r for r in caplog.records if "stuck or crawling" in r.getMessage()]
        assert len(said) == 1, "said once for the stuck check, not once per take"
    finally:
        ab._let_go_of_check_lock()
    # Once it returns, the checks go on with the loaded model.
    _Spoken.text = "the words"
    assert ab.transcribe_check(np.zeros(16000, np.float32)) == "the words"
    assert selected.loads == 1
    lease.release()


def test_a_check_waits_for_one_that_is_merely_slow(selected, monkeypatch):
    ab = _mod("services.asr_backend")
    monkeypatch.setattr(ab, "CHECK_WAIT_S", 10.0)
    assert ab._take_check_lock()  # another render's check, a little slow
    threading.Timer(0.3, ab._let_go_of_check_lock).start()
    _Spoken.text = "the words"
    assert ab.transcribe_check(np.zeros(16000, np.float32)) == "the words"


def test_the_idle_reaper_releases_it_only_once_unused(selected):
    ab = _mod("services.asr_backend")
    lease = _mod("services.speech_verify").recognizer_lease()
    _check_sentences(_verifier())
    used = ab._check_last_used
    assert ab.release_check_recognizer(idle_s=900, now=used + 10) is False
    assert ab.release_check_recognizer(idle_s=900, now=used + 901) is True
    assert selected.unloads == 1
    lease.release()


def test_mlx_whisper_stays_resident(asr, monkeypatch):
    """Its weights live in mlx-whisper's own singleton: the check keeps
    them, as every other mlx-whisper caller does."""
    unloads = []

    class _MLX(asr.MLXWhisperBackend):
        def transcribe(self, audio_path, **_kw):
            return {"text": "the words"}

        def unload(self):
            unloads.append(1)

    monkeypatch.setattr(asr, "load_active_asr_backend", lambda **_kw: _MLX())
    with _mod("services.speech_verify").recognizer_lease():
        assert asr.transcribe_check(np.zeros(16000, np.float32)) == "the words"
    _settled()
    assert unloads == [] and asr._check_backend is None


# ── Failures, and the chain the check keeps ─────────────────────────────────

def test_a_recognizer_that_does_not_load_is_tried_once_per_render(asr, monkeypatch):
    attempts = []

    def broken(**_kw):
        attempts.append(1)
        raise RuntimeError("cuDNN failed to initialize")

    monkeypatch.setattr(asr, "load_active_asr_backend", broken)
    speech = _mod("services.speech_verify")
    with speech.recognizer_lease():
        for _ in range(3):
            assert asr.transcribe_check(np.zeros(16000, np.float32)) is None
    assert attempts == [1]
    assert asr.transcribe_check(np.zeros(16000, np.float32)) is None
    assert attempts == [1, 1], "a new render tries again"


def test_a_render_that_starts_later_tries_a_failed_recognizer_again(asr, monkeypatch):
    """A failure found during one long render is no verdict for a render
    that starts after it, while the first still runs: the model may have been
    repaired since."""
    attempts = []

    def broken(**_kw):
        attempts.append(1)
        raise RuntimeError("cuDNN failed to initialize")

    monkeypatch.setattr(asr, "load_active_asr_backend", broken)
    speech = _mod("services.speech_verify")
    book = speech.recognizer_lease()
    for _ in range(2):
        assert asr.transcribe_check(np.zeros(16000, np.float32)) is None
    assert attempts == [1]
    repaired = _recognizer_class(asr)
    monkeypatch.setattr(asr, "load_active_asr_backend", lambda **_kw: repaired())
    with speech.recognizer_lease():  # a preview while the book renders
        _Spoken.text = "the words"
        assert asr.transcribe_check(np.zeros(16000, np.float32)) == "the words"
    # The book benefits too.
    assert asr.transcribe_check(np.zeros(16000, np.float32)) == "the words"
    assert repaired.loads == 1
    book.release()


def test_a_model_installed_mid_render_answers_from_the_next_take(selected, asr, monkeypatch):
    """Whether a model is installed is read from disk at every check: one the
    user installs while a book renders checks the rest of the book."""
    installed = {"selected": False}
    monkeypatch.setattr(asr, "asr_model_missing_error", lambda **kw: (
        None if kw.get("purpose") != "dictation" and installed["selected"]
        else {"error": "asr_model_missing"}))
    _Spoken.text = "the words"
    with _mod("services.speech_verify").recognizer_lease():
        assert asr.transcribe_check(np.zeros(16000, np.float32)) is None
        installed["selected"] = True
        assert asr.transcribe_check(np.zeros(16000, np.float32)) == "the words"
    assert selected.loads == 1


def test_the_summary_says_whether_a_recognizer_was_missing(selected, asr, monkeypatch):
    """A take an installed recognizer heard no words in (near-silent) is no
    reason to install one; only a take nothing was installed to hear is."""
    take = _take(SENTENCES[0])
    _Spoken.text = ""  # the recognizer hears nothing in the take
    heard_nothing = _verifier()
    heard_nothing.render(SENTENCES[0], lambda _attempt: take)
    assert heard_nothing.stats()["no_recognizer"] is False
    monkeypatch.setattr(asr, "asr_model_missing_error", lambda **_kw: {"error": "asr_model_missing"})
    monkeypatch.setattr(asr, "reference_recognizer_installed", lambda: False)
    nothing_installed = _verifier()
    nothing_installed.render(SENTENCES[0], lambda _attempt: take)
    assert nothing_installed.stats()["no_recognizer"] is True
    assert selected.loads == 1  # only the installed one was ever loaded


def test_a_model_that_fails_while_loading_is_tried_once_per_render(asr, monkeypatch):
    class _Broken(_recognizer_class(asr)):
        def transcribe(self, audio_path, **_kw):
            type(self).loads += 1
            raise RuntimeError("CUDA failed with error out of memory")

    monkeypatch.setattr(asr, "load_active_asr_backend", lambda **_kw: _Broken())
    with _mod("services.speech_verify").recognizer_lease():
        for _ in range(3):
            assert asr.transcribe_check(np.zeros(16000, np.float32)) is None
    assert _Broken.loads == 1


def test_the_installed_dictation_engine_and_fallbacks_still_answer(selected, asr, monkeypatch):
    """The selected engine hearing nothing falls through the same chain as a
    reference transcript: the dictation engine, then installed fallbacks."""
    _Spoken.text = ""
    asked = []
    capture = _recognizer_class(asr, hears=lambda _a: asked.append("capture") or "")
    capture.id = "sherpa-onnx-asr"
    fallback = _recognizer_class(asr, hears=lambda _a: asked.append("fallback") or "the words")
    monkeypatch.setattr(asr, "asr_model_missing_error", lambda **_kw: None)
    monkeypatch.setattr(asr, "get_capture_asr_backend", lambda **_kw: capture())
    monkeypatch.setattr(asr, "_installed_reference_fallbacks", lambda selected: [fallback()])
    assert asr.transcribe_check(np.zeros(16000, np.float32)) == "the words"
    assert asked == ["capture", "fallback"]
    monkeypatch.setattr(asr, "_installed_reference_fallbacks", lambda selected: [])
    verifier = _verifier()
    for _ in range(3):
        verifier.render(SENTENCES[0], lambda _attempt: _take(SENTENCES[0]))
    assert verifier.unavailable and verifier.checked == 0


def test_an_engine_this_host_cannot_run_is_never_loaded(asr, monkeypatch):
    """A pinned CTranslate2 engine without its cuDNN 8 kills the process when
    it loads (#1371): the check asks first, as auto-detect does."""
    monkeypatch.setattr(asr, "_probe_available", lambda cls: False)
    monkeypatch.setattr(asr, "load_active_asr_backend",
                        lambda **_kw: pytest.fail("loaded an engine reported unusable"))
    assert asr.transcribe_check(np.zeros(16000, np.float32)) is None


def test_without_an_installed_recognizer_nothing_loads(asr, monkeypatch):
    monkeypatch.setattr(asr, "asr_model_missing_error", lambda **_kw: {"error": "asr_model_missing"})
    monkeypatch.setattr(asr, "load_active_asr_backend",
                        lambda **_kw: pytest.fail("loaded a recognizer that is not installed"))
    with _mod("services.speech_verify").recognizer_lease():
        assert asr.transcribe_check(np.zeros(16000, np.float32)) is None


# ── What a render trace shows ───────────────────────────────────────────────

def test_checks_show_in_the_render_trace(selected):
    trace = _mod("core.render_trace").RenderTrace("audiobook")
    with trace.activate():
        _check_sentences(_verifier())
    stage = trace.snapshot()["stages"]["speech_check"]
    assert stage["calls"] == len(SENTENCES) and stage["failures"] == 0
