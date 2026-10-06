"""A loudness-mastered book (ACX / podcast preset) as the render writes it.

The mux keeps the chapters' sample rate (loudnorm works at 192 kHz, and the
encoder otherwise kept 96 kHz AAC / 48 kHz MP3), and the encoded file's true
peak is checked: lossy encoding can push it back over the preset's ceiling,
and then the book is encoded again with more limiter headroom, a bounded
number of times. ffmpeg and the engine are stubbed — no audio is encoded.
"""
import asyncio
import json

import numpy as np
import pytest

SR = 22050  # an engine rate that is not the 24 kHz most voices have

_MEASURE = """[Parsed_loudnorm_0 @ 0x55]
{ "input_i" : "-21.75", "input_tp" : "-6.06", "input_lra" : "4.00",
  "input_thresh" : "-31.75", "target_offset" : "0.05" }
"""


def _meter(peak: float) -> bytes:
    return f"[Parsed_ebur128_0 @ 01] Summary:\n\n  True peak:\n    Peak:  {peak:5.1f} dBFS\n".encode()


@pytest.fixture
def outputs(tmp_path, monkeypatch):
    from core import config, db

    monkeypatch.setattr(config, "OUTPUTS_DIR", str(tmp_path))
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "jobs.db"))
    db.init_db()
    return tmp_path


def _render(outputs, monkeypatch, *, loudness, fmt="m4b", peaks=()):
    """Render a two-chapter book; ``peaks`` is what each true-peak check reads
    (None: the meter fails). Returns (events, mux argvs, checks run)."""
    import soundfile as sf

    from api.routers import audiobook
    from services import ffmpeg_utils, gpu_gateway

    monkeypatch.setattr(ffmpeg_utils, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(audiobook, "_resolve_default_language", lambda *_a: None)
    monkeypatch.setattr(gpu_gateway, "decide", lambda *_a: object())
    plan = audiobook.parse_audiobook_script("# A\nOne.\n# B\nTwo.")

    async def chapter(ch, **_kw):
        wav = outputs / f"{ch.title}.wav"
        sf.write(str(wav), np.zeros(SR // 10, dtype=np.float32), SR)
        return str(wav), 0.1, False, None

    muxes, checks = [], []
    readings = list(peaks)

    async def run_ffmpeg(cmd, *_a, **_kw):
        filters = " ".join(cmd[i + 1] for i, a in enumerate(cmd) if a == "-af")
        if "print_format=json" in filters:
            return 0, b"", _MEASURE.encode()
        if "ebur128" in filters:
            checks.append(cmd)
            peak = readings.pop(0)
            return (1, b"", b"") if peak is None else (0, b"", _meter(peak))
        muxes.append(cmd)
        with open(cmd[-1], "wb") as f:
            f.write(b"book")
        return 0, b"", b""

    monkeypatch.setattr(audiobook, "_run_chapter", chapter)
    monkeypatch.setattr(ffmpeg_utils, "run_ffmpeg", run_ffmpeg)

    async def run():
        return [e async for e in audiobook._render_longform_sse(
            plan, default_voice=None, loudness=loudness, fmt=fmt, job_id="m1")]

    events = [json.loads(e[len("data: "):]) for e in asyncio.run(run())]
    return events, muxes, checks


def _arg(cmd, flag):
    return cmd[cmd.index(flag) + 1] if flag in cmd else None


def test_a_mastered_book_keeps_the_chapter_rate_and_is_checked(outputs, monkeypatch):
    events, muxes, checks = _render(outputs, monkeypatch, loudness="acx", peaks=[-3.4])
    assert events[-1]["type"] == "done"
    assert len(muxes) == 1 and len(checks) == 1
    assert _arg(muxes[0], "-ar") == str(SR)
    assert ":TP=-3.5:" in _arg(muxes[0], "-af")  # the ceiling less the encoder headroom
    assert checks[0][checks[0].index("-i") + 1] == muxes[0][-1]  # the file just written
    assert events[-1]["loudness"]["target_tp"] == -3.0  # the ceiling the file meets


def test_a_book_over_its_ceiling_is_encoded_again_with_more_headroom(outputs, monkeypatch):
    # AAC overshoots the limiter by about 1 dB at low bitrates.
    events, muxes, checks = _render(outputs, monkeypatch, loudness="acx", peaks=[-2.6, -3.3])
    assert events[-1]["type"] == "done"
    assert len(muxes) == 2 and len(checks) == 2
    # 0.5 dB headroom + 0.4 dB over + 0.3 dB margin.
    assert ":TP=-4.2:" in _arg(muxes[1], "-af")
    assert muxes[1][-1] == muxes[0][-1]
    assert _arg(muxes[1], "-ar") == str(SR)


def test_re_encoding_stops_after_the_last_encode(outputs, monkeypatch):
    events, muxes, checks = _render(outputs, monkeypatch, loudness="podcast", peaks=[-1.0, -1.2])
    assert events[-1]["type"] == "done"
    assert len(muxes) == 3 and len(checks) == 2
    assert [_arg(m, "-af").split(":TP=")[1].split(":")[0] for m in muxes] == ["-2.0", "-2.8", "-3.4"]


def test_an_unknown_peak_keeps_the_first_encode(outputs, monkeypatch):
    events, muxes, checks = _render(outputs, monkeypatch, loudness="acx", peaks=[None])
    assert events[-1]["type"] == "done"
    assert len(muxes) == 1 and len(checks) == 1


def test_acx_mp3_is_encoded_as_acx_takes_it(outputs, monkeypatch):
    _events, muxes, _checks = _render(outputs, monkeypatch, loudness="acx", fmt="mp3", peaks=[-3.7])
    assert (_arg(muxes[0], "-ar"), _arg(muxes[0], "-b:a")) == ("44100", "192k")


@pytest.mark.parametrize("loudness", [None, "off"])
def test_an_unmastered_book_is_encoded_once_as_before(outputs, monkeypatch, loudness):
    events, muxes, checks = _render(outputs, monkeypatch, loudness=loudness)
    assert events[-1]["type"] == "done" and "loudness" not in events[-1]
    assert len(muxes) == 1 and checks == []
    assert "-ar" not in muxes[0] and "-af" not in muxes[0]
