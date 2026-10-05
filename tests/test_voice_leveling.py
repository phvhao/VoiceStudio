"""Voice leveling: every voice of a chapter at one speech level, plus a volume
per voice.

Cloned voices come out as loud as their reference clips, so a book cast from a
quiet and a loud recording jumped in volume at every [voice:NAME] switch. These
tests pin the measurement, the per-voice gains (target, ±12 dB caps, peak
guard, manual volume), the join integration in ``synthesize_chapter``, the
cache contract (leveling keys the chapter, never a take), the remote worker,
and the request bounds. Engine boundary stubbed throughout — no model, no GPU.
"""
import importlib
import json
import math
import os

import pytest
import torch

SR = 1000  # 50 samples per 50 ms frame: exact, and tiny


@pytest.fixture(autouse=True)
def _runtime_symbols():
    # Bound per test: other suites reload these modules.
    audiobook = importlib.import_module("services.audiobook")
    leveling = importlib.import_module("services.voice_leveling")
    for name in ("Chapter", "ExpressiveOptions", "Span", "synthesize_chapter", "voice_gain_pairs"):
        globals()[name] = getattr(audiobook, name)
    for name in ("MAX_LEVEL_GAIN_DB", "PEAK_CEILING", "TARGET_SPEECH_DB", "peak_safe_gain_db",
                 "span_voice_name", "speech_level_db", "voice_gains_db"):
        globals()[name] = getattr(leveling, name)


def _voice(db: float, seconds: float = 1.0):
    """A take whose every 50 ms frame sits at ``db`` dBFS RMS (and peaks there)."""
    n = int(SR * seconds)
    signs = torch.ones(n)
    signs[1::2] = -1.0
    return (signs * 10.0 ** (db / 20.0)).reshape(1, n)


def _rms_db(audio) -> float:
    return 10.0 * math.log10(float(audio.double().pow(2).mean()))


def _synth(takes: dict):
    """A stub engine: the take for each text, fresh every call."""
    return lambda text, *_args, **_kw: takes[text].clone()


def _parts(audio, seconds: list):
    out, start = [], 0
    for s in seconds:
        n = int(SR * s)
        out.append(audio[..., start:start + n])
        start += n
    assert start == audio.shape[-1]
    return out


# ── measurement ──────────────────────────────────────────────────────────────

def test_speech_level_ignores_silence_breaths_and_room_tone():
    speech = _voice(-20, 1.0)
    room = _voice(-45, 1.0)  # loud enough for the -60 dB gate, 25 dB under speech
    take = torch.cat([speech, torch.zeros(1, 2000), room], dim=-1)
    assert speech_level_db(take, SR) == pytest.approx(-20.0, abs=0.01)
    # Several takes of one voice are measured together.
    assert speech_level_db([_voice(-24), _voice(-30)], SR) == pytest.approx(
        10 * math.log10((10 ** -2.4 + 10 ** -3.0) / 2), abs=0.01)
    # Too little speech to judge, or none at all: no reading.
    assert speech_level_db(_voice(-20, 0.25), SR) is None
    assert speech_level_db(torch.zeros(1, 3000), SR) is None
    assert speech_level_db(torch.zeros(1, 0), SR) is None
    assert speech_level_db([], SR) is None


def test_a_boost_stops_at_the_peak_ceiling_and_never_turns_into_a_cut():
    assert peak_safe_gain_db(12.0, 0.5) == pytest.approx(20 * math.log10(PEAK_CEILING / 0.5))
    assert peak_safe_gain_db(3.0, 0.1) == 3.0      # room to spare: untouched
    assert peak_safe_gain_db(6.0, 0.99) == 0.0     # already past the ceiling: no boost
    assert peak_safe_gain_db(-3.0, 0.99) == -3.0   # a cut is never limited


def test_span_voice_name_follows_the_cast_rules():
    cast = {"Mara": "p-mara"}
    assert span_voice_name(None, "p-default", cast) == ""
    assert span_voice_name("", "p-default", cast) == ""
    # The parser writes the default voice's id into untagged runs.
    assert span_voice_name("p-default", "p-default", cast) == ""
    assert span_voice_name("Mara", "p-default", cast) == "Mara"
    assert span_voice_name("Unmapped", "p-default", cast) == "Unmapped"
    # [voice:default] is the default voice — unless the cast gives the name one.
    assert span_voice_name("default", "p-default", cast) == ""
    assert span_voice_name("default", "p-default", {"default": "p-x"}) == "default"
    # In any case, as the editor and Cast read it (isDefaultVoiceName).
    assert span_voice_name("Default", "p-default", cast) == ""
    assert span_voice_name("DEFAULT", "p-default", cast) == ""
    assert span_voice_name("Default", "p-default", {"Default": "p-x"}) == "Default"


def test_voice_gain_pairs_store_one_canonical_form():
    assert voice_gain_pairs(None) is None
    assert voice_gain_pairs({}) is None
    assert voice_gain_pairs({"Mara": 0, "": -0.02}) is None  # nothing audible
    assert voice_gain_pairs({" Mara ": 30, "": -3.04, "Cole": float("nan")}) == (
        ("", -3.0), ("Mara", 12.0))


# ── synthesize_chapter: the join levels each voice ───────────────────────────

def test_two_voices_meet_at_the_target():
    spans = [Span(voice_id="Quiet", text="q1"), Span(voice_id="Loud", text="l1"),
             Span(voice_id="Quiet", text="q2"), Span(voice_id="Loud", text="l2")]
    takes = {"q1": _voice(-30), "q2": _voice(-30), "l1": _voice(-14), "l2": _voice(-14)}
    before, _ = synthesize_chapter(spans, _synth(takes), SR)
    assert [round(_rms_db(p)) for p in _parts(before, [1] * 4)] == [-30, -14, -30, -14]

    audio, duration = synthesize_chapter(spans, _synth(takes), SR, level_voices=True)
    levels = [_rms_db(p) for p in _parts(audio, [1] * 4)]
    assert duration == 4.0
    assert all(abs(level - TARGET_SPEECH_DB) < 0.5 for level in levels), levels
    assert max(levels) - min(levels) < 0.5


def test_a_voice_keeps_its_own_dynamics():
    spans = [Span(voice_id="A", text="shout"), Span(voice_id="A", text="whisper"),
             Span(voice_id="B", text="other")]
    takes = {"shout": _voice(-24), "whisper": _voice(-30), "other": _voice(-10)}
    audio, _ = synthesize_chapter(spans, _synth(takes), SR, level_voices=True)
    shout, whisper, other = _parts(audio, [1, 1, 1])
    assert _rms_db(shout) - _rms_db(whisper) == pytest.approx(6.0, abs=0.01)  # one gain
    assert speech_level_db([shout, whisper], SR) == pytest.approx(TARGET_SPEECH_DB, abs=0.01)
    assert _rms_db(other) == pytest.approx(TARGET_SPEECH_DB, abs=0.01)


def test_leveling_moves_a_voice_by_twelve_db_at_most():
    spans = [Span(voice_id="Far", text="far"), Span(voice_id="Near", text="near")]
    takes = {"far": _voice(-40), "near": _voice(-3)}
    audio, _ = synthesize_chapter(spans, _synth(takes), SR, level_voices=True)
    far, near = (_rms_db(p) for p in _parts(audio, [1, 1]))
    assert far == pytest.approx(-40 + MAX_LEVEL_GAIN_DB, abs=0.01)
    assert near == pytest.approx(-3 - MAX_LEVEL_GAIN_DB, abs=0.01)


def test_a_boost_never_clips():
    take = _voice(-32)
    take[0, 500] = 0.6  # one transient: +12 dB would put it at 2.4
    audio, _ = synthesize_chapter([Span(voice_id="A", text="a")], _synth({"a": take}), SR,
                                  level_voices=True, voice_gains={"A": 12})
    assert float(audio.abs().max()) == pytest.approx(PEAK_CEILING, abs=1e-6)
    # The whole voice moved by the one guarded gain, the transient included.
    assert float(audio[0, 0] / take[0, 0]) == pytest.approx(PEAK_CEILING / 0.6, rel=1e-5)


def test_manual_volume_per_voice_with_and_without_leveling():
    spans = [Span(voice_id=None, text="narrator"), Span(voice_id="Mara", text="mara"),
             Span(voice_id="Cole", text="cole")]
    takes = {"narrator": _voice(-20), "mara": _voice(-20), "cole": _voice(-20)}
    plain, _ = synthesize_chapter(spans, _synth(takes), SR)
    audio, _ = synthesize_chapter(spans, _synth(takes), SR,
                                  voice_gains={"": -3.0, "Mara": 6.0, "Cole": 40.0})
    narrator, mara, cole = _parts(audio, [1, 1, 1])
    p_narrator, p_mara, p_cole = _parts(plain, [1, 1, 1])
    # Without leveling the volume is the whole change: exact gains, the default
    # voice under '', and a request past the cap held at +12 dB.
    assert torch.allclose(narrator, p_narrator * 10 ** (-3 / 20))
    assert torch.allclose(mara, p_mara * 10 ** (6 / 20))
    assert torch.allclose(cole, p_cole * 10 ** (12 / 20))

    takes = {"narrator": _voice(-26), "mara": _voice(-14), "cole": _voice(-20)}
    audio, _ = synthesize_chapter(spans, _synth(takes), SR, level_voices=True,
                                  voice_gains={"Mara": 3.0})
    levels = [_rms_db(p) for p in _parts(audio, [1, 1, 1])]
    assert levels == pytest.approx([TARGET_SPEECH_DB, TARGET_SPEECH_DB + 3, TARGET_SPEECH_DB],
                                   abs=0.01)


def test_silence_and_silent_takes_are_left_alone():
    spans = [Span(voice_id="A", text="", pause_ms_after=500),
             Span(voice_id="A", text="hush", pause_ms_after=250),
             Span(voice_id="B", text="b")]
    takes = {"hush": torch.zeros(1, 400), "b": _voice(-30)}
    audio, _ = synthesize_chapter(spans, _synth(takes), SR, level_voices=True,
                                  voice_gains={"A": 6.0})
    pause, hush, gap, b = _parts(audio, [0.5, 0.4, 0.25, 1.0])
    assert not pause.any() and not hush.any() and not gap.any()
    assert _rms_db(b) == pytest.approx(TARGET_SPEECH_DB, abs=0.01)
    # A chapter of pauses only is unchanged.
    only = [Span(voice_id="A", text="", pause_ms_after=300)]
    assert torch.equal(synthesize_chapter(only, _synth({}), SR, level_voices=True)[0],
                       synthesize_chapter(only, _synth({}), SR)[0])


def test_without_leveling_the_chapter_is_byte_identical():
    spans = [Span(voice_id="A", text="a", pause_ms_after=100), Span(voice_id="B", text="b")]
    takes = {"a": _voice(-30), "b": _voice(-14)}
    today, _ = synthesize_chapter(spans, _synth(takes), SR)
    for kw in ({"level_voices": False, "voice_gains": None}, {"voice_gains": {}},
               ExpressiveOptions().join_kwargs()):
        assert torch.equal(synthesize_chapter(spans, _synth(takes), SR, **kw)[0], today)
    assert ExpressiveOptions().cache_signature() == ""
    assert ExpressiveOptions().take_signature() == ""


def test_voice_names_group_spans_whatever_their_voice_id():
    # The remote worker's spans carry row indexes as voice ids.
    spans = [Span(voice_id="0", text="a"), Span(voice_id="1", text="b")]
    takes = {"a": _voice(-24), "b": _voice(-30)}
    audio, _ = synthesize_chapter(spans, _synth(takes), SR, level_voices=True,
                                  voice_names=["Mara", "Mara"])
    a, b = (_rms_db(p) for p in _parts(audio, [1, 1]))
    assert a - b == pytest.approx(6.0, abs=0.01)
    with pytest.raises(ValueError, match="every span"):
        synthesize_chapter(spans, _synth(takes), SR, voice_names=["Mara"])


def test_voice_gains_db_skips_measuring_voices_nothing_moves(monkeypatch):
    leveling = importlib.import_module("services.voice_leveling")
    monkeypatch.setattr(leveling, "speech_level_db", lambda *_a: pytest.fail("measured"))
    gains = voice_gains_db([("A", _voice(-20)), ("B", _voice(-20))], SR, level=False,
                           offsets={"B": -4.0})
    assert gains == {"A": 0.0, "B": -4.0}


# ── options, caches and the remote worker ────────────────────────────────────

def test_leveling_rides_the_manifest_only_when_on():
    opts = ExpressiveOptions(level_voices=True, voice_gains=(("", -2.0), ("Mara", 3.0)))
    assert ExpressiveOptions.from_manifest(opts.to_manifest()) == opts
    assert opts.join_kwargs()["voice_gains"] == {"": -2.0, "Mara": 3.0}
    assert opts.join_kwargs()["level_voices"] is True
    default = ExpressiveOptions().to_manifest()
    assert "level_voices" not in default and "voice_gains" not in default
    # Never an engine kwarg (the worker strips RENDER_KEYS from the manifest).
    assert {"level_voices", "voice_gains"} <= set(ExpressiveOptions.RENDER_KEYS)
    # Every chapter key moves with it; no take key does.
    assert opts.cache_signature() and opts.take_signature() == ""
    seeded = ExpressiveOptions(seed=3)
    assert ExpressiveOptions(seed=3, level_voices=True).take_signature() == seeded.cache_signature()


def _resolve(_voice_id):
    return {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}


def test_leveling_reassembles_cached_chapters_without_new_takes(tmp_path, monkeypatch):
    import soundfile as sf

    from api.routers.audiobook import _render_chapter_cached

    watermark = importlib.import_module("services.watermark")
    monkeypatch.setattr(watermark, "will_mark", lambda: False)
    monkeypatch.setattr(watermark, "mark_synthetic", lambda audio, *_a, **_k: audio)
    calls = []

    def synth(text, voice_id, speed=None):
        calls.append(text)
        return _voice(-20).reshape(-1)

    # Untagged runs carry the default voice's profile id, as the parser writes them.
    chapter = Chapter(title="C", spans=[Span(voice_id="p-narrator", text="Narrator line."),
                                        Span(voice_id="Mara", text="Mara line.")])

    def render(opts):
        path, _dur, cached, _stats = _render_chapter_cached(
            chapter, synth, SR, "eng", _resolve, str(tmp_path), None, None, opts, None,
            default_voice="p-narrator")
        return path, cached

    plain, _ = render(ExpressiveOptions())
    assert len(calls) == 2
    leveled, cached = render(ExpressiveOptions(level_voices=True))
    louder, _ = render(ExpressiveOptions(level_voices=True, voice_gains=(("", 6.0),)))
    assert len({plain, leveled, louder}) == 3 and not cached
    assert len(calls) == 2  # both re-assembled from the cached takes
    audio, _ = sf.read(louder, dtype="float32", always_2d=True)
    narrator, mara = audio[:1000, 0], audio[1000:, 0]
    level = lambda x: 10 * math.log10(float((x.astype("float64") ** 2).mean()))  # noqa: E731
    assert level(narrator) == pytest.approx(TARGET_SPEECH_DB + 6, abs=0.1)
    assert level(mara) == pytest.approx(TARGET_SPEECH_DB, abs=0.1)
    # The same request again is a chapter hit.
    assert render(ExpressiveOptions(level_voices=True, voice_gains=(("", 6.0),))) == (louder, True)


def test_the_default_voice_keys_a_leveled_chapter(tmp_path):
    from api.routers.audiobook import _render_chapter_cached

    chapter = Chapter(title="C", spans=[Span(voice_id="p-actor", text="Line.")])
    synth = lambda text, vid, speed=None: _voice(-20).reshape(-1)  # noqa: E731

    def key(opts, default_voice):
        path, *_ = _render_chapter_cached(chapter, synth, SR, "eng", _resolve, str(tmp_path),
                                          None, None, opts, None, default_voice=default_voice)
        return os.path.basename(path)

    # A Stories line read by the book's default voice takes the default
    # voice's volume, so which voice is the default must key the chapter...
    gained = ExpressiveOptions(voice_gains=(("", 6.0),))
    assert key(gained, "p-actor") != key(gained, "p-other")
    # ...but only while leveling is on: every other key stays as it was.
    assert key(ExpressiveOptions(), "p-actor") == key(ExpressiveOptions(), "p-other")


def _remote_call(tmp_path, monkeypatch, opts):
    ab = importlib.import_module("api.routers.audiobook")
    monkeypatch.setattr(ab, "_resolve_voice", _resolve)
    monkeypatch.setattr(ab, "_voice_profile_exists", lambda _id: False)
    chapter = Chapter(title="C", spans=[Span(voice_id="p-narrator", text="Hello."),
                                        Span(voice_id="Mara", text="Hi."),
                                        Span(voice_id="default", text="Back.")])
    call, _path = ab._remote_chapter_call(
        chapter, engine_id="eng", default_voice="p-narrator", voice_map={"Mara": "p-mara"},
        language=None, lexicon=None, opts=opts, cache_dir=str(tmp_path))
    return call


def test_remote_chapters_carry_leveling_only_when_on(tmp_path, monkeypatch):
    plain = _remote_call(tmp_path, monkeypatch, ExpressiveOptions())
    assert all("voice" not in row for row in plain.params["spans"])
    assert plain.params["expressive"] == ExpressiveOptions().to_manifest()
    leveled = _remote_call(tmp_path, monkeypatch, ExpressiveOptions(level_voices=True))
    assert [row["voice"] for row in leveled.params["spans"]] == ["", "Mara", ""]
    assert leveled.params["expressive"]["level_voices"] is True
    gained = _remote_call(tmp_path, monkeypatch,
                          ExpressiveOptions(level_voices=True, voice_gains=(("Mara", 2.0),)))
    keys = {c.idempotency_key for c in (plain, leveled, gained)}
    assert len(keys) == 3


def test_a_volume_only_moves_the_chapters_its_voice_speaks_in(tmp_path, monkeypatch):
    import asyncio

    from worker.routing import Decision

    ab = importlib.import_module("api.routers.audiobook")
    gpu_gateway = importlib.import_module("services.gpu_gateway")
    monkeypatch.setattr(ab, "_resolve_voice", _resolve)
    monkeypatch.setattr(ab, "_voice_profile_exists", lambda _id: False)
    monkeypatch.setattr("services.tts_backend.active_backend_id", lambda: "test")
    sent = []

    async def fake_run(op, *, local, remote, decision, job):
        sent.append(remote)
        return "remote.wav", 1.0, False, None

    monkeypatch.setattr(gpu_gateway, "run", fake_run)

    def run(chapter, opts):
        asyncio.run(ab._run_chapter(
            chapter, decision=Decision(True, "w1", "gpu2"), job=gpu_gateway.JobRun("audiobook"),
            default_voice=None, language=None, opts=opts, voice_map=None, lexicon=None,
            cache_dir=str(tmp_path)))
        return sent[-1]

    volumes = ExpressiveOptions(voice_gains=(("Cole", 3.0), ("Mara", -2.0)))
    mara = Chapter("One", [Span("Mara", "Hi."), Span("Cole", "", pause_ms_after=200)])
    assert run(mara, volumes).params["expressive"]["voice_gains"] == {"Mara": -2.0}
    # No volume for any voice the chapter speaks: exactly the untouched request.
    narration = Chapter("Two", [Span(None, "Narration.")])
    assert (run(narration, volumes).idempotency_key
            == run(narration, ExpressiveOptions()).idempotency_key)


def test_the_worker_levels_by_the_voice_each_row_names():
    from worker.executor import TaskExecutor

    class Backend:
        sample_rate = SR

        def generate(self, text, **kwargs):
            assert "level_voices" not in kwargs and "voice_gains" not in kwargs
            return _voice(-30 if kwargs["ref_text"] == "quiet" else -14)

    rows = [{"text": "One.", "voice": "Quiet"}, {"text": "Two.", "voice": "Loud"},
            {"text": "Three.", "voice": "Quiet"}]
    voices = [{"ref_text": "quiet"}, {"ref_text": "loud"}, {"ref_text": "quiet"}]
    audio = TaskExecutor._synthesize_audiobook(
        Backend(), rows, voices,
        {"ref_audio": [None] * 3, "expressive": {"level_voices": True}, "watermark": False})
    levels = [_rms_db(p) for p in _parts(torch.as_tensor(audio), [1, 1, 1])]
    assert levels == pytest.approx([TARGET_SPEECH_DB] * 3, abs=0.01)


# ── request bounds ───────────────────────────────────────────────────────────

def test_request_fields_are_bounded_and_reach_the_options():
    from pydantic import ValidationError

    from api.routers.audiobook import (AudiobookPreviewRequest, AudiobookRequest,
                                       LongformRenderRequest, _expressive_opts)

    opts = _expressive_opts(LongformRenderRequest(
        level_voices=True, voice_gains={"Mara": 30, "": -40, "Cole": 0, " Ann ": 2.04}))
    assert opts.level_voices is True
    assert dict(opts.voice_gains) == {"": -12.0, "Ann": 2.0, "Mara": 12.0}
    for body in ('{"voice_gains": {"Mara": 1e999}}', '{"voice_gains": {"Mara": NaN}}'):
        with pytest.raises(ValidationError):
            LongformRenderRequest.model_validate_json(body)
    with pytest.raises(ValidationError):
        LongformRenderRequest(voice_gains={str(i): 1.0 for i in range(65)})
    with pytest.raises(ValidationError):
        LongformRenderRequest(voice_gains={"x" * 129: 1.0})
    LongformRenderRequest(voice_gains={str(i): 1.0 for i in range(64)})
    # Omitted, off or empty: the render is exactly what it was.
    for req in (AudiobookRequest(text="x"), AudiobookPreviewRequest(text="x"),
                AudiobookRequest(text="x", level_voices=False, voice_gains={"Mara": 0})):
        assert _expressive_opts(req).is_default
    assert json.loads(_expressive_opts(AudiobookRequest(
        text="x", level_voices=True)).cache_signature())["level_voices"] is True
