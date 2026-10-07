"""Smart Fit planner (dub-length fitting v2, Phase A) — unit + golden tests.

The planner is pure (no I/O, no torch), so these tests pin down the exact
numeric behaviour:

  - threshold boundaries (need = 0.9 / 1.0 / 1.2 / 1.21 / 4.0);
  - cap saturation → overflow_trimmed with the residual reported;
  - slack absorption into the silent gap, minus the gap guard;
  - last-segment tail absorption to the end of the video;
  - timeline-cursor monotonicity (no overlap on the fitted timeline);
  - two-way fit: a short line slows its audio to 0.9× at most and speeds
    its speech's video up to 1.25× at most; per-segment Keep / Allow shrink /
    Allow stretch overrides; a line that may be missing content is never
    sped up;
  - allow_video_retime=False audio-only mode;
  - video_plan shape — fed straight into dub_export's
    `_build_video_stretch_filter_graph`, which must accept it and emit a
    parsable graph (the Phase B export pipeline consumes exactly this);
  - GOLDEN fixtures: canned scenarios → committed JSON; any drift in the
    algorithm is a deliberate diff to the fixture, never a silent change;
  - `fit_fingerprint` canonicalisation (the #281 regression class: int vs
    float, omitted vs default must hash identically).
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import asdict

import pytest

from services.fit_planner import FitParams, FitPlan, MAX_AUDIO_RATE_HARD, plan_fit
from services.incremental import fit_fingerprint
from api.routers.dub_export import _build_video_stretch_filter_graph


def _single_seg_plan(natural: float, *, slot: float = 1.0, params: FitParams | None = None) -> FitPlan:
    """One segment [0, slot] covering the whole video — no slack, no tail."""
    return plan_fit(
        [{"id": "s0", "start": 0.0, "end": slot}],
        [natural],
        slot,
        params or FitParams(),
    )


# ── Threshold boundaries ───────────────────────────────────────────────


def test_need_below_one_is_slowed_toward_the_slot():
    """Underrun fill: a line shorter than its slot is slowed (pitch-preserving)
    so speech covers the on-screen mouth time instead of leaving a hole of
    thin bed residue (measured live: 8.8s of holes across 18.7s of speech)."""
    p = _single_seg_plan(0.9)
    sf = p.segments[0]
    assert sf.status == "audio_slowed"
    assert sf.audio_rate == pytest.approx(0.9)   # exactly fills the slot
    assert sf.video_ratio == 1.0
    assert sf.overflow_s == 0.0


def test_underrun_fill_is_bounded_by_the_floor():
    """Without a video speed-up, a drastically short line only slows to
    min_audio_rate — 0.6× speech would sound wrong; a smaller hole remains,
    honestly."""
    p = _single_seg_plan(0.6, params=FitParams(video_speed_cap=1.0))
    sf = p.segments[0]
    assert sf.status == "audio_slowed"
    assert sf.audio_rate == pytest.approx(FitParams().min_audio_rate)
    assert sf.video_ratio == 1.0


def test_near_full_slots_are_left_alone():
    """Within UNDERRUN_TOLERANCE the hole is imperceptible — no ffmpeg pass."""
    p = _single_seg_plan(0.97)
    sf = p.segments[0]
    assert sf.status == "fits"
    assert sf.audio_rate == 1.0


def test_underrun_fill_disabled_via_min_audio_rate():
    """min_audio_rate=1.0 turns the audio side off; the video still speeds
    up, and with its cap at 1.0 too nothing is retimed."""
    p = _single_seg_plan(0.6, params=FitParams(min_audio_rate=1.0))
    sf = p.segments[0]
    assert sf.audio_rate == 1.0
    assert sf.video_ratio == pytest.approx(0.8)
    p = _single_seg_plan(0.6, params=FitParams(min_audio_rate=1.0, video_speed_cap=1.0))
    sf = p.segments[0]
    assert sf.status == "fits"
    assert sf.audio_rate == 1.0
    assert sf.video_ratio == 1.0


def test_empty_audio_is_not_slowed():
    p = _single_seg_plan(0.0)
    assert p.segments[0].status == "fits"
    assert p.segments[0].audio_rate == 1.0


def test_need_exactly_one_fits():
    p = _single_seg_plan(1.0)
    sf = p.segments[0]
    assert sf.status == "fits"
    assert sf.audio_rate == 1.0
    assert sf.video_ratio == 1.0


def test_need_at_audio_only_boundary_is_audio_only():
    """need = 1.2 (the max_audio_only_rate default) → audio only, no video."""
    p = _single_seg_plan(1.2)
    sf = p.segments[0]
    assert sf.status == "audio_stretched"
    assert sf.audio_rate == pytest.approx(1.2)
    assert sf.video_ratio == 1.0
    assert sf.overflow_s == 0.0


def test_need_just_past_boundary_goes_hybrid():
    """need = 1.21 → geometric split: sqrt(1.21) = 1.1 on each side."""
    p = _single_seg_plan(1.21)
    sf = p.segments[0]
    assert sf.status == "hybrid"
    assert sf.audio_rate == pytest.approx(1.1)
    assert sf.video_ratio == pytest.approx(1.1)
    assert sf.overflow_s == 0.0
    # Timeline grew by the video ratio.
    assert p.total_duration == pytest.approx(1.1, abs=1e-3)


def test_need_four_saturates_both_caps_and_overflows():
    """need = 4.0: sqrt(4)=2 > audio cap 1.5 → audio=1.5; video=min(4/1.5, 2)=2.
    Combined 3.0× < 4.0× → residual overflow trimmed at mix time."""
    p = _single_seg_plan(4.0)
    sf = p.segments[0]
    assert sf.status == "overflow_trimmed"
    assert sf.audio_rate == pytest.approx(1.5)
    assert sf.video_ratio == pytest.approx(2.0)
    # Stretched audio = 4/1.5 ≈ 2.667 s; new video slot = 1×2 = 2 s.
    assert sf.overflow_s == pytest.approx(4.0 / 1.5 - 2.0, abs=1e-3)


# ── Cap saturation / overflow accounting ──────────────────────────────


def test_custom_caps_are_respected():
    params = FitParams(audio_rate_cap=1.3, video_slow_cap=1.5)
    p = _single_seg_plan(4.0, params=params)
    sf = p.segments[0]
    assert sf.audio_rate == pytest.approx(1.3)
    assert sf.video_ratio == pytest.approx(1.5)
    assert sf.status == "overflow_trimmed"
    assert sf.overflow_s == pytest.approx(4.0 / 1.3 - 1.5, abs=1e-3)


# ── Slack absorption ───────────────────────────────────────────────────


def test_gap_slack_absorbed_minus_gap_guard():
    """A 1.9 s natural dub in a 1 s slot fits because the following 1 s gap
    is absorbed, leaving only the 50 ms guard before the next onset."""
    p = plan_fit(
        [
            {"id": "a", "start": 0.0, "end": 1.0},
            {"id": "b", "start": 2.0, "end": 3.0},
        ],
        [1.9, 0.5],
        4.0,
    )
    a, b = p.segments
    assert a.effective_end == pytest.approx(1.95)  # 2.0 − gap_guard_s
    assert a.status == "fits"                      # 1.9 / 1.95 < 1.0
    # The unretimed guard sliver keeps b anchored at its original start.
    assert b.new_start == pytest.approx(2.0)


def test_back_to_back_segments_do_not_shrink_the_slot():
    """Extend-only: when the next segment starts immediately, the slot stays
    the original [start, end] — it never shrinks below it."""
    p = plan_fit(
        [
            {"id": "a", "start": 0.0, "end": 1.0},
            {"id": "b", "start": 1.0, "end": 2.0},
        ],
        [1.0, 1.0],
        2.0,
    )
    assert p.segments[0].effective_end == pytest.approx(1.0)
    assert p.segments[0].status == "fits"


# ── Last-segment tail ──────────────────────────────────────────────────


def test_last_segment_absorbs_tail_to_video_end():
    """A 4.5 s line after 1 s of speech fits in the tail at natural rate. It
    already runs past the mouth; slowing it further toward the end of the
    video (what the fill used to do, measuring underruns against the slot)
    only made the drift worse."""
    p = plan_fit(
        [{"id": "a", "start": 0.0, "end": 1.0}],
        [4.5],
        5.0,
    )
    sf = p.segments[0]
    assert sf.effective_end == pytest.approx(5.0)
    assert sf.status == "fits"
    assert sf.audio_rate == 1.0
    assert sf.video_ratio == 1.0
    assert p.total_duration == pytest.approx(5.0)


def test_line_covering_its_speech_is_not_slowed_into_the_gap():
    """The fill aims at the original speech [start, end], never the silent
    gap after it: a dub as long as the speech is left alone."""
    p = plan_fit(
        [{"id": "a", "start": 0.0, "end": 2.0}, {"id": "b", "start": 3.0, "end": 4.0}],
        [2.0, 1.0],
        4.0,
    )
    a = p.segments[0]
    assert a.effective_end == pytest.approx(2.95)
    assert (a.status, a.audio_rate, a.video_ratio) == ("fits", 1.0, 1.0)


def test_unknown_total_duration_gives_last_segment_no_tail():
    p = plan_fit([{"id": "a", "start": 0.0, "end": 1.0}], [1.1], 0.0)
    sf = p.segments[0]
    assert sf.effective_end == pytest.approx(1.0)
    assert sf.status == "audio_stretched"


# ── Cursor monotonicity ────────────────────────────────────────────────


def test_cursor_monotonic_no_overlap_on_fitted_timeline():
    segs = [
        {"id": "a", "start": 0.5, "end": 2.0},
        {"id": "b", "start": 2.3, "end": 4.0},
        {"id": "c", "start": 4.1, "end": 6.0},
        {"id": "d", "start": 7.0, "end": 9.0},
    ]
    naturals = [3.0, 1.0, 4.0, 8.0]  # mix of fits / audio-only / hybrid / overflow
    p = plan_fit(segs, naturals, 10.0)
    prev_end = 0.0
    for sf in p.segments:
        assert sf.new_start >= prev_end - 1e-6, f"overlap at seg {sf.index}"
        assert sf.new_end >= sf.new_start
        prev_end = sf.new_end
    # Pre-roll preserved at native rate.
    assert p.segments[0].new_start == pytest.approx(0.5)
    # This mix slows down more video than it speeds up: the timeline grows.
    assert p.total_duration >= 10.0 - 1e-6


# ── allow_video_retime=False ───────────────────────────────────────────


def test_audio_only_mode_caps_at_legacy_hard_limit():
    params = FitParams(allow_video_retime=False)
    p = _single_seg_plan(4.0, params=params)
    sf = p.segments[0]
    assert sf.audio_rate == pytest.approx(MAX_AUDIO_RATE_HARD)
    assert sf.video_ratio == 1.0
    assert sf.status == "overflow_trimmed"
    assert sf.overflow_s == pytest.approx(4.0 / MAX_AUDIO_RATE_HARD - 1.0, abs=1e-3)
    # No video retime → timeline doesn't grow.
    assert p.total_duration == pytest.approx(1.0)
    assert not p.needs_video_retime


def test_audio_only_mode_within_hard_limit_has_no_overflow():
    params = FitParams(allow_video_retime=False)
    p = _single_seg_plan(1.6, params=params)
    sf = p.segments[0]
    assert sf.audio_rate == pytest.approx(1.6)
    assert sf.status == "audio_stretched"
    assert sf.overflow_s == 0.0


# ── Two-way fit: short lines speed the video up ────────────────────────


def test_short_line_slows_audio_to_its_floor_then_speeds_the_video_up():
    """need 0.6 of a 1 s speech span: the audio slows to 0.9× (0.667 s), the
    video speeds up to 1.25× (0.8 s) — the most both allow; 0.13 s of hole
    remains instead of 0.4 s."""
    p = _single_seg_plan(0.6)
    sf = p.segments[0]
    assert sf.status == "video_shrunk"
    assert sf.audio_rate == pytest.approx(0.9)
    assert sf.video_ratio == pytest.approx(0.8)
    assert sf.new_end - sf.new_start == pytest.approx(0.8, abs=1e-3)
    assert sf.overflow_s == 0.0
    assert p.total_duration == pytest.approx(0.8, abs=1e-3)
    assert p.needs_video_retime


def test_mildly_short_line_shares_the_fill_between_audio_and_video():
    """need 0.85: the audio slows to its 0.9× floor and the video speeds up
    by the rest, so the dub ends exactly with the sped-up speech."""
    p = _single_seg_plan(0.85)
    sf = p.segments[0]
    assert sf.status == "video_shrunk"
    assert sf.audio_rate == pytest.approx(0.9)
    assert sf.video_ratio == pytest.approx(0.85 / 0.9)
    stretched = 0.85 / sf.audio_rate
    assert stretched == pytest.approx(sf.new_end - sf.new_start, abs=1e-3)


def test_speed_up_covers_the_speech_and_keeps_the_gap_after_it():
    """Only [start, end] speeds up; the silent gap before the next line keeps
    its pace, and every later line moves earlier by what was saved."""
    p = plan_fit(
        [{"id": "a", "start": 1.0, "end": 3.0}, {"id": "b", "start": 4.0, "end": 5.0}],
        [1.2, 1.0],
        6.0,
    )
    a, b = p.segments
    assert a.status == "video_shrunk"
    assert a.video_ratio == pytest.approx(0.8)
    assert a.new_start == pytest.approx(1.0)
    assert a.new_end == pytest.approx(1.0 + 2.0 * 0.8)
    assert b.new_start == pytest.approx(a.new_end + 1.0)       # the whole 1 s gap
    assert b.status == "fits"
    assert p.video_plan[0]["orig_end"] == pytest.approx(3.0)   # speech only
    assert p.total_duration == pytest.approx(6.0 - 0.4, abs=1e-3)


def test_keep_override_never_retimes_the_video():
    keep = {"id": "s0", "start": 0.0, "end": 1.0, "video_fit": "keep"}
    short = plan_fit([keep], [0.6], 1.0).segments[0]
    assert (short.status, short.video_ratio) == ("audio_slowed", 1.0)
    assert short.audio_rate == pytest.approx(0.85)       # the audio-only floor
    long = plan_fit([keep], [4.0], 1.0).segments[0]
    assert long.video_ratio == 1.0
    assert long.audio_rate == pytest.approx(MAX_AUDIO_RATE_HARD)


def test_allow_shrink_override_speeds_up_but_never_slows_down():
    seg = {"id": "s0", "start": 0.0, "end": 1.0, "video_fit": "shrink"}
    assert plan_fit([seg], [0.6], 1.0).segments[0].video_ratio == pytest.approx(0.8)
    long = plan_fit([seg], [1.6], 1.0).segments[0]
    assert long.video_ratio == 1.0
    assert (long.status, long.audio_rate) == ("audio_stretched", pytest.approx(1.6))


def test_allow_stretch_override_slows_down_but_never_speeds_up():
    seg = {"id": "s0", "start": 0.0, "end": 1.0, "video_fit": "stretch"}
    short = plan_fit([seg], [0.6], 1.0).segments[0]
    assert (short.status, short.video_ratio) == ("audio_slowed", 1.0)
    long = plan_fit([seg], [1.21], 1.0).segments[0]
    assert long.status == "hybrid"
    assert long.video_ratio == pytest.approx(1.1)


def test_overrides_win_over_a_job_without_video_retime():
    params = FitParams(allow_video_retime=False)
    auto = plan_fit([{"id": "s0", "start": 0.0, "end": 1.0}], [0.6], 1.0, params).segments[0]
    assert auto.video_ratio == 1.0
    shrink = plan_fit(
        [{"id": "s0", "start": 0.0, "end": 1.0, "video_fit": "shrink"}], [0.6], 1.0, params,
    ).segments[0]
    assert shrink.video_ratio == pytest.approx(0.8)


@pytest.mark.parametrize("video_fit", [None, "shrink", "stretch"])
def test_line_that_may_be_missing_content_is_never_sped_up(video_fit):
    """Speeding the video up to meet a translation that dropped a sentence
    would hide the omission; the line keeps its video and slows only its
    audio, so the gap stays audible."""
    seg = {"id": "s0", "start": 0.0, "end": 1.0, "video_fit": video_fit, "may_be_incomplete": True}
    sf = plan_fit([seg], [0.6], 1.0).segments[0]
    assert sf.video_ratio == 1.0
    assert sf.status == "audio_slowed"
    assert sf.audio_rate == pytest.approx(0.85)


def test_line_that_may_be_missing_content_is_slowed_down_like_any_line():
    """Slowing the video for a dub that runs long hides no gap. Refusing it
    left the audio alone to absorb an overrun: a flagged line needing 2.5×
    overflowed past 1.8× and stopped the whole render."""
    seg = {"id": "s0", "start": 0.0, "end": 1.0, "may_be_incomplete": True}
    auto = plan_fit([seg], [1.21], 1.0).segments[0]
    assert auto.status == "hybrid"
    assert auto.video_ratio == pytest.approx(1.1)
    long = plan_fit([seg], [2.5], 1.0).segments[0]
    assert long.status == "hybrid" and long.overflow_s == 0.0
    assert (long.audio_rate, long.video_ratio) == (pytest.approx(1.5), pytest.approx(2.5 / 1.5))
    # Keep, and video retime turned off, still leave its video alone.
    kept = plan_fit([seg | {"video_fit": "keep"}], [1.21], 1.0).segments[0]
    assert (kept.status, kept.video_ratio) == ("audio_stretched", 1.0)
    off = plan_fit([seg], [1.21], 1.0, FitParams(allow_video_retime=False)).segments[0]
    assert (off.status, off.video_ratio) == ("audio_stretched", 1.0)
    # Allow shrink only ever sped it up, which it never is.
    shrink = plan_fit([seg | {"video_fit": "shrink"}], [0.6], 1.0).segments[0]
    assert shrink.video_ratio == 1.0


def test_sped_up_plan_feeds_the_stretch_filter_graph_builder():
    p = plan_fit(
        [{"id": "a", "start": 1.0, "end": 3.0}, {"id": "b", "start": 4.0, "end": 5.0}],
        [1.2, 1.0],
        6.0,
    )
    graph, label = _build_video_stretch_filter_graph(p.video_plan, orig_dur=p.orig_duration)
    assert label == "[vstretched]"
    assert "trim=start=1.0000:end=3.0000,setpts=PTS-STARTPTS,setpts=0.800000*PTS" in graph
    assert "trim=start=3.0000:end=4.0000,setpts=PTS-STARTPTS,setpts=1.000000*PTS" in graph


# ── video_plan shape — consumed by the export filter-graph builder ─────


def test_video_plan_feeds_the_stretch_filter_graph_builder():
    p = plan_fit(
        [
            {"id": "a", "start": 1.0, "end": 3.0},
            {"id": "b", "start": 4.0, "end": 6.0},
        ],
        [2.0, 5.0],
        8.0,
    )
    for entry in p.video_plan:
        assert set(entry) == {"orig_start", "orig_end", "new_start", "new_end", "stretch_ratio"}
    graph, label = _build_video_stretch_filter_graph(p.video_plan, orig_dur=p.orig_duration)
    assert label == "[vstretched]"
    assert "split=" in graph and "concat=n=" in graph
    # Every chunk is a well-formed trim+setpts node; the graph parses as
    # `;`-separated filter chains with bracketed labels.
    for part in graph.split(";"):
        assert part.startswith("[")


def test_empty_segment_list_yields_empty_plan():
    p = plan_fit([], [], 10.0)
    assert p.segments == []
    assert p.video_plan == []
    assert p.total_duration == pytest.approx(10.0)
    graph, label = _build_video_stretch_filter_graph(p.video_plan, orig_dur=10.0)
    assert graph == "" and label == "[0:v]"


def test_mismatched_inputs_raise():
    with pytest.raises(ValueError):
        plan_fit([{"id": "a", "start": 0.0, "end": 1.0}], [1.0, 2.0], 3.0)


# ── GOLDEN fixtures ────────────────────────────────────────────────────
#
# Exact serialized FitPlans committed under tests/fixtures/fit_planner/.
# If the algorithm changes, these fail — regenerate the fixture ON PURPOSE
# (and explain the behaviour change in the PR), never loosen the assert.

_FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "fit_planner")

_GOLDEN_SCENARIOS = {
    "all_fit": dict(
        segments=[
            {"id": "g0", "start": 0.0, "end": 2.0},
            {"id": "g1", "start": 3.0, "end": 5.0},
        ],
        naturals=[1.5, 2.5],
        total=6.0,
        params=FitParams(),
    ),
    "audio_only_and_hybrid": dict(
        segments=[
            {"id": "g0", "start": 0.0, "end": 1.0},
            {"id": "g1", "start": 1.5, "end": 2.5},
            {"id": "g2", "start": 3.0, "end": 4.0},
        ],
        naturals=[1.6, 2.0, 0.4],
        total=5.0,
        params=FitParams(),
    ),
    "overflow_caps": dict(
        segments=[
            {"id": "g0", "start": 0.5, "end": 1.5},
            {"id": "g1", "start": 2.0, "end": 3.0},
        ],
        naturals=[5.0, 1.0],
        total=3.5,
        params=FitParams(),
    ),
    "no_video_retime": dict(
        segments=[
            {"id": "g0", "start": 0.0, "end": 1.0},
            {"id": "g1", "start": 2.0, "end": 3.0},
        ],
        naturals=[2.5, 1.3],
        total=4.0,
        params=FitParams(allow_video_retime=False),
    ),
    "two_way_overrides": dict(
        segments=[
            {"id": "g0", "start": 0.5, "end": 2.5},
            {"id": "g1", "start": 3.0, "end": 4.0, "video_fit": "keep"},
            {"id": "g2", "start": 4.5, "end": 5.5, "may_be_incomplete": True},
            {"id": "g3", "start": 6.0, "end": 7.0, "video_fit": "stretch"},
            {"id": "g4", "start": 7.5, "end": 8.5, "video_fit": "shrink"},
        ],
        naturals=[1.5, 0.5, 0.6, 1.5, 0.7],
        total=9.0,
        params=FitParams(),
    ),
}


def _plan_payload(p: FitPlan) -> dict:
    return {
        "segments": [asdict(s) for s in p.segments],
        "video_plan": p.video_plan,
        "total_duration": p.total_duration,
        "orig_duration": p.orig_duration,
    }


@pytest.mark.parametrize("name", sorted(_GOLDEN_SCENARIOS))
def test_golden_fit_plan(name):
    sc = _GOLDEN_SCENARIOS[name]
    plan = plan_fit(sc["segments"], sc["naturals"], sc["total"], sc["params"])
    got = _plan_payload(plan)
    with open(os.path.join(_FIXTURE_DIR, f"{name}.json"), encoding="utf-8") as f:
        expected = json.load(f)
    assert got == expected, (
        f"FitPlan for scenario {name!r} drifted from the committed golden "
        f"fixture. If this is an intentional algorithm change, regenerate "
        f"tests/fixtures/fit_planner/{name}.json and call out the change."
    )


# ── fit_fingerprint canonicalisation (#281 regression class) ───────────


def test_fit_fingerprint_empty_equals_fully_spelled_defaults():
    full = {
        "timing_strategy": "smart_fit",
        "max_audio_only_rate": 1.2,
        "audio_rate_cap": 1.5,
        "video_slow_cap": 2.0,
        "gap_guard_s": 0.05,
        "allow_video_retime": True,
    }
    assert fit_fingerprint({}) == fit_fingerprint(full)
    assert fit_fingerprint(None) == fit_fingerprint(full)


def test_fit_fingerprint_int_vs_float():
    """JS sends `video_slow_cap: 2`, pydantic parses `2.0` — same hash."""
    assert fit_fingerprint({"video_slow_cap": 2}) == fit_fingerprint({"video_slow_cap": 2.0})
    assert fit_fingerprint({"audio_rate_cap": 1}) == fit_fingerprint({"audio_rate_cap": 1.0})


def test_fit_fingerprint_omitted_vs_none_vs_default():
    assert fit_fingerprint({"audio_rate_cap": None}) == fit_fingerprint({})
    assert fit_fingerprint({"audio_rate_cap": 1.5}) == fit_fingerprint({})


def test_fit_fingerprint_real_changes_flip_the_hash():
    base = fit_fingerprint({})
    assert fit_fingerprint({"audio_rate_cap": 1.4}) != base
    assert fit_fingerprint({"allow_video_retime": False}) != base
    assert fit_fingerprint({"timing_strategy": "strict_slot"}) != base
    assert fit_fingerprint({"gap_guard_s": 0.1}) != base
    assert fit_fingerprint({"video_speed_cap": 1.0}) != base
    assert fit_fingerprint({"video_fit": "s1:keep"}) != base
    assert fit_fingerprint({"video_fit": "s1:keep"}) != fit_fingerprint({"video_fit": "s1:shrink"})


def test_fit_fingerprint_later_knobs_at_default_keep_stored_hashes():
    """The speed-up cap and per-segment overrides arrived after fit_fp
    shipped: at their defaults they must not change a stored digest."""
    base = fit_fingerprint({})
    assert fit_fingerprint({"video_speed_cap": 1.25, "video_fit": ""}) == base
    assert fit_fingerprint({"video_speed_cap": None, "video_fit": None}) == base


def test_fit_fingerprint_is_stable():
    """Pin the digest of the default config: existing fit_fp values stored in
    omnivoice_data/ jobs must stay valid across releases (same guarantee
    segment hashes have)."""
    import hashlib

    payload = {
        "allow_video_retime": True,
        "audio_rate_cap": 1.5,
        "gap_guard_s": 0.05,
        "max_audio_only_rate": 1.2,
        "timing_strategy": "smart_fit",
        "video_slow_cap": 2.0,
    }
    expected = hashlib.sha1(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]
    assert fit_fingerprint({}) == expected
