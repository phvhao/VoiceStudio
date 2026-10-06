"""The ``[volume -6dB]…[/volume]`` tag and the measured auto level.

A passage tag moves the loudness of the wrapped words only. These tests pin
that synthesis applies it AFTER voice leveling and the voice's own volume (so
leveling measures the voice as written and a whisper never raises the voice),
with the same peak guard; that scripts without the tag keep their exact cache
keys; that the gain reaches every render path (local cache, remote worker,
Stories' posted plan); and that what leveling measured per voice travels with
each chapter's audio to the SSE ``chapter`` event. The parser grammar itself is
pinned by the shared golden corpus (``fixtures/longform_parser_cases.json``).
Engine boundary stubbed throughout — no model, no GPU.
"""
import asyncio
import importlib
import json
import math

import pytest
import torch

SR = 1000  # 50 samples per 50 ms leveling frame: exact, and tiny


@pytest.fixture(autouse=True)
def _runtime_symbols():
    # Bound per test: other suites reload these modules.
    audiobook = importlib.import_module("services.audiobook")
    for name in ("Chapter", "ExpressiveOptions", "Span", "synthesize_chapter",
                 "parse_audiobook_script"):
        globals()[name] = getattr(audiobook, name)
    leveling = importlib.import_module("services.voice_leveling")
    for name in ("PEAK_CEILING", "TARGET_SPEECH_DB"):
        globals()[name] = getattr(leveling, name)


def _voice(db: float, seconds: float = 1.0):
    """A take whose every 50 ms frame sits at ``db`` dBFS RMS (and peaks there)."""
    n = int(SR * seconds)
    signs = torch.ones(n)
    signs[1::2] = -1.0
    return (signs * 10.0 ** (db / 20.0)).reshape(1, n)


def _rms_db(audio) -> float:
    return 10.0 * math.log10(float(torch.as_tensor(audio).double().pow(2).mean()))


def _synth(takes: dict):
    return lambda text, *_args, **_kw: takes[text].clone()


def _parts(audio, count: int):
    n = audio.shape[-1] // count
    return [audio[..., i * n:(i + 1) * n] for i in range(count)]


# ── synthesis order ──────────────────────────────────────────────────────────

def test_a_passage_moves_after_leveling_which_never_measures_it():
    spans = [Span(voice_id="A", text="said"), Span(voice_id="A", text="whispered", gain_db=-6.0),
             Span(voice_id="B", text="other")]
    takes = {"said": _voice(-26), "whispered": _voice(-26), "other": _voice(-14)}
    timing: list = []
    audio, _ = synthesize_chapter(spans, _synth(takes), SR, level_voices=True,
                                  voice_names=["A", "A", "B"], timing=timing)
    said, whispered, other = (_rms_db(p) for p in _parts(audio, 3))
    # Leveling read voice A as written (-26 dB): +6 dB lands it on the target.
    # Had it measured the whisper at -32 dB, A would have been pushed louder.
    assert said == pytest.approx(TARGET_SPEECH_DB, abs=0.01)
    assert other == pytest.approx(TARGET_SPEECH_DB, abs=0.01)
    # The passage moves on top of its voice's gain: 6 dB under the voice.
    assert whispered == pytest.approx(TARGET_SPEECH_DB - 6.0, abs=0.01)
    # What leveling measured, per voice, rides the chapter's timing document.
    assert timing[0]["levels"] == {"A": {"level_db": pytest.approx(-26.0), "auto_db": 6.0},
                                   "B": {"level_db": pytest.approx(-14.0), "auto_db": -6.0}}


def test_a_passage_moves_without_leveling_and_adds_to_the_voice_volume():
    spans = [Span(voice_id="A", text="a"), Span(voice_id="A", text="b", gain_db=4.0)]
    takes = {"a": _voice(-30), "b": _voice(-30)}
    audio, _ = synthesize_chapter(spans, _synth(takes), SR)
    assert [round(_rms_db(p), 2) for p in _parts(audio, 2)] == [-30.0, -26.0]
    audio, _ = synthesize_chapter(spans, _synth(takes), SR, voice_gains={"A": 3.0},
                                  voice_names=["A", "A"])
    assert [round(_rms_db(p), 2) for p in _parts(audio, 2)] == [-27.0, -23.0]


def test_a_passage_boost_stops_at_the_peak_ceiling():
    take = _voice(-32)
    take[0, 500] = 0.6  # +12 dB would put this transient at 2.4
    audio, _ = synthesize_chapter([Span(voice_id="A", text="a", gain_db=12.0)],
                                  _synth({"a": take}), SR)
    assert float(audio.abs().max()) == pytest.approx(PEAK_CEILING, abs=1e-6)
    # A cut is never limited, and a gain past ±12 dB is capped.
    audio, _ = synthesize_chapter([Span(voice_id="A", text="a", gain_db=-40.0)],
                                  _synth({"a": _voice(-20)}), SR)
    assert _rms_db(audio) == pytest.approx(-32.0, abs=0.01)


def test_without_leveling_no_levels_are_reported():
    timing: list = []
    synthesize_chapter([Span(voice_id="A", text="a")], _synth({"a": _voice(-20)}), SR,
                       voice_gains={"A": 3.0}, timing=timing)
    assert "levels" not in timing[0]


# ── plan, cache keys and render paths ────────────────────────────────────────

_TAG_FREE = "# One\nPlain line.\n[slow]Slow words[/slow] then more.\n[voice:Mara] Hi. [pause 1s] Bye."


def test_tag_free_scripts_keep_their_cache_keys():
    from api.routers.audiobook import _span_key_tuple
    from services.longform_render import chapter_cache_key

    plan = parse_audiobook_script(_TAG_FREE, default_voice="p-narrator")
    spans = plan.chapters[0].spans
    assert all(s.gain_db is None and "gain_db" not in s.to_dict() for s in spans)
    tuples = [_span_key_tuple(s) for s in spans]
    assert tuples[0] == ("p-narrator", "Plain line.", 0, None, "continue")
    assert tuples[2] == ("p-narrator", "then more.", 0, None)
    # Pinned: the key this plan had before the tag existed.
    assert chapter_cache_key(tuples, sample_rate=24000, engine_id="omnivoice",
                             voice_sig={"p-narrator": "a|b|c", "Mara": "d|e|f"}) \
        == "76997b5855f592abe67a"


def test_a_volume_moves_the_chapter_key():
    from api.routers.audiobook import _span_key_tuple
    from services.longform_render import chapter_cache_key

    plain = parse_audiobook_script("Hello there. Quiet now.").chapters[0].spans
    tagged = parse_audiobook_script("Hello there. [volume -6]Quiet now.[/volume]").chapters[0].spans
    louder = parse_audiobook_script("Hello there. [volume -3]Quiet now.[/volume]").chapters[0].spans
    assert tagged[1].gain_db == -6.0 and tagged[1].to_dict()["gain_db"] == -6.0
    keys = {chapter_cache_key([_span_key_tuple(s) for s in spans], sample_rate=SR, engine_id="e")
            for spans in (plain, tagged, louder)}
    assert len(keys) == 3
    # A gain without a join still hashes apart from a join.
    assert _span_key_tuple(Span(voice_id=None, text="x", gain_db=2.0)) == (None, "x", 0, None,
                                                                            None, 2.0)


def _resolve(_voice_id):
    return {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}


@pytest.fixture
def unmarked(monkeypatch):
    watermark = importlib.import_module("services.watermark")
    monkeypatch.setattr(watermark, "will_mark", lambda: False)
    monkeypatch.setattr(watermark, "mark_synthetic", lambda audio, *_a, **_k: audio)


def test_cached_chapter_keeps_its_levels_and_reassembles_a_new_volume(tmp_path, unmarked):
    import soundfile as sf

    from api.routers.audiobook import _chapter_levels, _render_chapter_cached
    from services.longform_render import load_chapter_timeline

    calls = []

    def synth(text, voice_id, speed=None):
        calls.append(text)
        return _voice(-26).reshape(-1)

    def render(gain):
        chapter = Chapter(title="C", spans=[
            Span(voice_id="p-narrator", text="Said."),
            Span(voice_id="p-narrator", text="Whispered.", gain_db=gain)])
        path, _dur, cached, _stats = _render_chapter_cached(
            chapter, synth, SR, "eng", _resolve, str(tmp_path), None, None,
            ExpressiveOptions(level_voices=True), None, default_voice="p-narrator")
        return path, cached

    quiet, _ = render(-6.0)
    quieter, cached = render(-9.0)
    assert quiet != quieter and not cached
    assert calls == ["Said.", "Whispered."]  # re-assembled from the cached takes
    audio, _ = sf.read(quieter, dtype="float32", always_2d=True)
    assert _rms_db(audio[1000:, 0]) - _rms_db(audio[:1000, 0]) == pytest.approx(-9.0, abs=0.05)
    # The levels are kept with the chapter's audio, so a cache hit reports them.
    assert render(-9.0) == (quieter, True)
    assert _chapter_levels(load_chapter_timeline(quieter)) == {
        "": {"level_db": -26.0, "auto_db": 6.0}}


def test_chapter_levels_reads_only_well_formed_entries():
    from api.routers.audiobook import _chapter_levels

    assert _chapter_levels(None) == {} and _chapter_levels({"version": 1}) == {}
    assert _chapter_levels({"levels": {
        "Mara": {"level_db": -26.04, "auto_db": 6.04},
        "Cole": {"level_db": float("nan"), "auto_db": 1},
        "Bad": {"level_db": True, "auto_db": 1},
        "Gone": "x",
    }}) == {"Mara": {"level_db": -26.0, "auto_db": 6.0}}


def test_remote_chapters_carry_the_gain_only_where_the_script_has_one(tmp_path, monkeypatch):
    ab = importlib.import_module("api.routers.audiobook")
    monkeypatch.setattr(ab, "_resolve_voice", _resolve)
    monkeypatch.setattr(ab, "_voice_profile_exists", lambda _id: False)

    def call(script):
        chapter = parse_audiobook_script(script).chapters[0]
        return ab._remote_chapter_call(
            chapter, engine_id="eng", default_voice=None, voice_map={}, language=None,
            lexicon=None, opts=ExpressiveOptions(), cache_dir=str(tmp_path))[0]

    plain = call("Hello there.")
    assert all("gain_db" not in row for row in plain.params["spans"])
    tagged = call("Hello there. [volume -6]Quiet.[/volume]")
    assert [row.get("gain_db") for row in tagged.params["spans"]] == [None, -6.0]
    assert plain.idempotency_key != tagged.idempotency_key


def test_the_worker_applies_the_passage_gain():
    from worker.executor import TaskExecutor

    class Backend:
        sample_rate = SR

        def generate(self, text, **kwargs):
            return _voice(-20)

    rows = [{"text": "Said."}, {"text": "Whispered.", "gain_db": -6.0},
            {"text": "Bogus.", "gain_db": "loud"}]
    audio = TaskExecutor._synthesize_audiobook(
        Backend(), rows, [{"ref_text": None, "instruct": None}] * 3,
        {"ref_audio": [None] * 3, "watermark": False, "expressive": {}})
    audio = torch.as_tensor(audio).reshape(1, -1)
    assert [round(_rms_db(p), 1) for p in _parts(audio, 3)] == [-20.0, -26.0, -20.0]


def test_stories_plans_carry_the_gain_into_the_render():
    from pydantic import ValidationError

    from api.routers.audiobook import LongformSpan

    assert LongformSpan(text="x", gain_db=-6).gain_db == -6.0
    assert LongformSpan(text="x").gain_db is None
    with pytest.raises(ValidationError):
        LongformSpan(text="x", gain_db=40)


# ── SSE: what leveling measured, per chapter ─────────────────────────────────

@pytest.fixture
def outputs(tmp_path, monkeypatch):
    from core import config, db

    monkeypatch.setattr(config, "OUTPUTS_DIR", str(tmp_path))
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "jobs.db"))
    db.init_db()
    return tmp_path


def test_chapter_events_report_the_measured_levels(outputs, monkeypatch):
    import soundfile as sf

    from api.routers import audiobook
    from services import ffmpeg_utils, gpu_gateway
    from services.longform_render import write_chapter_timeline

    monkeypatch.setattr(ffmpeg_utils, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(audiobook, "_resolve_default_language", lambda *_a: None)
    monkeypatch.setattr(gpu_gateway, "decide", lambda *_a: object())
    plan = parse_audiobook_script("# A\nOne.\n# B\nTwo.")

    async def chapter(ch, **_kw):
        wav = outputs / f"{ch.title}.wav"
        sf.write(str(wav), torch.zeros(1000).numpy(), SR)
        doc = {"version": 1, "sample_rate": SR, "samples": 1000, "phrases": False,
               "spans": [{"span": 0, "start": 0, "end": 1000, "units": None}]}
        if ch.title == "A":  # B was rendered with leveling off
            doc["levels"] = {"": {"level_db": -26.0, "auto_db": 6.0},
                             "Mara": {"level_db": -15.04, "auto_db": -4.96}}
        write_chapter_timeline(str(wav), doc)
        return str(wav), 1.0, False, None

    async def mux(command, **_kw):
        with open(command[-1], "wb") as f:
            f.write(b"book")

    monkeypatch.setattr(audiobook, "_run_chapter", chapter)
    monkeypatch.setattr(ffmpeg_utils, "run_ffmpeg", mux)

    async def run():
        return [e async for e in audiobook._render_longform_sse(
            plan, default_voice=None, opts=ExpressiveOptions(level_voices=True), job_id="lv1")]

    events = [json.loads(e[len("data: "):]) for e in asyncio.run(run())]
    chapters = [e for e in events if e["type"] == "chapter"]
    assert chapters[0]["levels"] == {"": {"level_db": -26.0, "auto_db": 6.0},
                                     "Mara": {"level_db": -15.0, "auto_db": -5.0}}
    assert "levels" not in chapters[1]
