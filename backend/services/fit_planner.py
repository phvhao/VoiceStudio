"""Smart Fit planner — dub-length fitting v2, Phase A.

Pure planning functions for the ``smart_fit`` timing strategy: given the
original segment timeline and the *natural-rate* duration of each dubbed
segment's TTS audio, decide per segment how to reconcile the two in both
directions: a line that runs long gets a mild pitch-preserving audio
speed-up and, past that, a mild video slow-down; a line that runs short
gets a mild audio slow-down and, past that, a mild video speed-up.

Clean-room note: this is a reimplementation from a *published description*
of the audio-speedup + video-slowdown fitting approach (see
docs/competitive-analysis.md, "Dub-length fitting"). No GPL source was
consulted.

Algorithm per segment (defaults in :class:`FitParams`):

1. **Slack absorption** — the usable slot extends past the segment's
   original end into the silent gap before the next segment, keeping a
   small ``gap_guard_s`` clear of the next onset (the last segment may run
   to the end of the video). ``need = natural_dur / slot``.
2. **Underrun** (``natural_dur`` shorter than the original speech
   ``[start, end]``, beyond ``UNDERRUN_TOLERANCE``) — the on-screen mouth
   would keep moving after the dub stops. With a video speed-up allowed,
   the audio slows to ``fill = natural_dur / speech`` but never below
   ``min_audio_rate_with_video`` (0.9×), and the speech span's video speeds
   up for the rest, to at most ``video_speed_cap`` (1.25×, so
   ``video_ratio`` ≥ 0.8). Without it, the audio alone slows, never below
   ``min_audio_rate`` (0.85×). Whatever both limits leave stays a short
   hole. The silent gap after ``end`` is never sped up.
3. ``need <= 1.0`` otherwise — fits as-is; nothing to do.
4. ``1.0 < need <= max_audio_only_rate`` — audio-only speed-up at exactly
   ``need`` (imperceptible up to ~1.2×).
5. ``need > max_audio_only_rate`` — geometric 50/50 split:
   ``audio_rate = min(sqrt(need), audio_rate_cap)`` and
   ``video_ratio = min(need / audio_rate, video_slow_cap)``. Whatever the
   caps can't absorb becomes ``overflow_s`` (rejected at mix time).
6. **Video permissions** — ``allow_video_retime=False`` turns both video
   directions off (audio-only: rate capped at the legacy
   ``MAX_AUDIO_RATE_HARD``, 1.8, matching dub_generate's MAX_STRETCH_RATIO
   guard rail). A segment's ``video_fit`` overrides it: ``"keep"`` (no
   video retime), ``"shrink"`` or ``"stretch"`` (that direction only). A
   segment flagged ``may_be_incomplete`` (its translation may be missing
   content) is never sped up — that would hide the gap instead of showing
   it; slowing it down for a dub that runs long hides nothing, so that
   follows the same choice as any segment's.
7. **Timeline cursor** — mirrors the existing ``stretch_video`` layout
   loop: pre-roll and inter-segment gaps pass through at 1.0×; each
   segment's video chunk ``[start, effective_end]`` (``[start, end]`` when
   sped up) occupies its length × ``video_ratio`` on the new timeline,
   which grows with slow-downs and shrinks with speed-ups.

This module is deliberately I/O-free and torch-free so it can be unit- and
golden-tested without a model, ffmpeg, or an event loop.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

# Hard ceiling for audio-only compression when video retiming is disabled.
# Matches dub_generate.MAX_STRETCH_RATIO — above ~1.8× speech becomes a
# garbled stream no DSP can rescue.
MAX_AUDIO_RATE_HARD = 1.8

# Underrun fill: a dubbed line that finishes well before the original speech
# leaves a hole — on screen the mouth keeps moving while the dub has gone
# quiet, and what the listener hears in the hole is the thin under-speech
# residue of the separated background (measured at ~37% of the original's
# energy), which reads as dead air. Translations routinely run shorter than
# the source delivery (measured live: 8.8s of holes across 18.7s of speech),
# so this is the common case, not a corner. Speech spans filled to within
# this fraction are left alone — a <5% hole is imperceptible and not worth an
# ffmpeg pass.
UNDERRUN_TOLERANCE = 0.95

#: Per-segment ``video_fit`` overrides: video directions each one allows,
#: as ``(slow down, speed up)``.
VIDEO_FIT_MODES = {"keep": (False, False), "shrink": (False, True), "stretch": (True, False)}

_EPS = 1e-9


@dataclass(frozen=True)
class FitParams:
    """Tunable knobs for the Smart Fit planner.

    All defaults are deliberately conservative: ≤1.2× audio-only is
    imperceptible to most listeners; 1.5× audio is the intelligibility
    cap; 2.0× video slow-down is the limit before motion looks syrupy, and
    a 1.25× speed-up the limit before it looks hurried.
    """
    max_audio_only_rate: float = 1.2
    audio_rate_cap: float = 1.5
    video_slow_cap: float = 2.0
    gap_guard_s: float = 0.05
    allow_video_retime: bool = True
    # Underrun fill floor: a segment shorter than its speech is slowed toward
    # it (pitch-preserving), never below this rate — 0.85× stays comfortably
    # natural-sounding. 1.0 disables the audio side of the fill.
    min_audio_rate: float = 0.85
    # Underrun speed-up: when the segment's video may speed up, the audio
    # slows no further than this and the video covers the rest, up to
    # video_speed_cap (setpts ≥ 1 / cap). A cap of 1.0 disables the speed-up.
    min_audio_rate_with_video: float = 0.9
    video_speed_cap: float = 1.25


@dataclass
class SegmentFit:
    """Planner verdict for one segment."""
    index: int
    seg_id: str
    audio_rate: float       # pitch-preserving rate: >1 speeds up (fit), <1 slows down (fill)
    video_ratio: float      # setpts factor of the video chunk: >1 slows it down, <1 speeds it up
    new_start: float        # placement on the fitted timeline
    new_end: float          # end of the video chunk on the fitted timeline
    orig_start: float
    orig_end: float
    effective_end: float    # orig_end + absorbed slack (≤ next start − gap guard)
    # "fits" | "audio_stretched" | "hybrid" | "overflow_trimmed" | "audio_slowed" | "video_shrunk"
    status: str
    overflow_s: float       # seconds of (stretched) audio that still don't fit


@dataclass
class FitPlan:
    """Full plan for one dub track."""
    segments: list[SegmentFit] = field(default_factory=list)
    # EXACT dict shape consumed by dub_export._build_video_stretch_filter_graph.
    video_plan: list[dict] = field(default_factory=list)
    total_duration: float = 0.0
    orig_duration: float = 0.0
    params: FitParams = field(default_factory=FitParams)

    @property
    def needs_video_retime(self) -> bool:
        return any(abs(s.video_ratio - 1.0) > 1e-6 for s in self.segments)


def video_directions(segment: dict, params: FitParams) -> tuple[bool, bool]:
    """``(slow down, speed up)``: the video retimes this segment may get.

    Its ``video_fit`` override wins over ``params.allow_video_retime``. A
    segment flagged ``may_be_incomplete`` is never sped up; it is slowed down
    as any segment is. (Never slowing it either left only the audio to absorb
    an overrun, and one such line past 1.8× stopped the whole render.)
    """
    mode = segment.get("video_fit") or ""
    slow, speed = VIDEO_FIT_MODES.get(mode, (params.allow_video_retime, params.allow_video_retime))
    return slow, speed and not segment.get("may_be_incomplete")


def _fit_one(need: float, params: FitParams, *, stretch: bool = True) -> tuple[float, float, str]:
    """Resolve a segment's need ratio (natural / slot, no underrun) into
    (audio_rate, video_ratio, status)."""
    if need <= 1.0 + _EPS:
        return 1.0, 1.0, "fits"
    if need <= params.max_audio_only_rate + _EPS:
        return need, 1.0, "audio_stretched"
    if not stretch:
        audio_rate = min(need, MAX_AUDIO_RATE_HARD)
        status = "audio_stretched" if audio_rate >= need - _EPS else "overflow_trimmed"
        return audio_rate, 1.0, status
    # Geometric 50/50 split: equal perceptual burden on audio and video.
    audio_rate = min(math.sqrt(need), params.audio_rate_cap)
    video_ratio = min(need / audio_rate, params.video_slow_cap)
    if audio_rate * video_ratio >= need - _EPS:
        return audio_rate, video_ratio, "hybrid"
    return audio_rate, video_ratio, "overflow_trimmed"


def _fill_one(fill: float, params: FitParams, *, shrink: bool) -> tuple[float, float, str]:
    """Resolve an underrun (``fill`` = natural / speech span < 1) into
    (audio_rate, video_ratio, status): the audio slows toward the speech span,
    and with ``shrink`` the span's video speeds up for what the audio's floor
    leaves."""
    shrink = shrink and params.video_speed_cap > 1.0 + _EPS
    floor = max(params.min_audio_rate, params.min_audio_rate_with_video) if shrink else params.min_audio_rate
    audio_rate = max(fill, floor) if floor < 1.0 - _EPS else 1.0
    video_ratio = max(fill / audio_rate, 1.0 / params.video_speed_cap) if shrink else 1.0
    if video_ratio < 1.0 - _EPS:
        return audio_rate, video_ratio, "video_shrunk"
    if audio_rate < 1.0 - _EPS:
        return audio_rate, 1.0, "audio_slowed"
    return 1.0, 1.0, "fits"


def plan_fit(
    segments: list[dict],
    natural_durs_s: list[float],
    total_dur_s: float,
    params: FitParams | None = None,
) -> FitPlan:
    """Plan the Smart Fit layout for a dub track.

    ``segments``: original-timeline segments in chronological order, each a
    dict with ``id``, ``start``, ``end`` (seconds), and optionally
    ``video_fit`` / ``may_be_incomplete`` (see :func:`video_directions`).
    ``natural_durs_s``: the natural-rate TTS audio duration for each segment
    (parallel list). ``total_dur_s``: original video duration (0/unknown
    tolerated — the last segment then gets no tail slack).

    Pure function: no I/O, no torch, deterministic.
    """
    params = params or FitParams()
    n = len(segments)
    if len(natural_durs_s) != n:
        raise ValueError(
            f"segments ({n}) and natural_durs_s ({len(natural_durs_s)}) must be parallel"
        )

    plan = FitPlan(params=params, orig_duration=round(float(total_dur_s), 4))
    if n == 0:
        plan.total_duration = round(max(0.0, float(total_dur_s)), 4)
        return plan

    cursor = 0.0
    chunk_end = 0.0
    for i, seg in enumerate(segments):
        start = float(seg["start"])
        end = float(seg["end"])
        natural = max(0.0, float(natural_durs_s[i]))

        # (a) Slack absorption. Extend-only: the slot never shrinks below
        # the original [start, end] even when segments are back-to-back.
        if i + 1 < n:
            next_start = float(segments[i + 1]["start"])
            effective_end = max(end, next_start - params.gap_guard_s)
            # Never bleed past the next segment's onset (overlapping or
            # near-touching source segments).
            effective_end = min(max(effective_end, start), max(next_start, end))
        else:
            effective_end = max(end, float(total_dur_s)) if total_dur_s > 0 else end
        slot = max(effective_end - start, 1e-3)
        speech = max(end - start, 1e-3)

        # (b) An underrun is measured against the original speech, where the
        # mouth moves; anything else against the slot, gap included.
        stretch, shrink = video_directions(seg, params)
        if 0.0 < natural < speech * UNDERRUN_TOLERANCE:
            audio_rate, video_ratio, status = _fill_one(natural / speech, params, shrink=shrink)
        else:
            need = natural / slot if natural > 0 else 0.0
            audio_rate, video_ratio, status = _fit_one(need, params, stretch=stretch)
        # A sped-up chunk is the speech alone: the silent gap after it keeps
        # its pace, so the next line still starts after a natural pause.
        chunk_end = end if video_ratio < 1.0 - _EPS else effective_end
        chunk = max(chunk_end - start, 1e-3)

        # (f) Timeline cursor — mirror the stretch_video layout loop:
        # pre-roll and gaps at 1.0×, the segment's video chunk
        # [start, chunk_end] occupies its length × video_ratio.
        if i == 0:
            cursor = start  # pre-roll preserved at native rate
        new_start = cursor
        new_end = new_start + chunk * video_ratio
        cursor = new_end
        if i + 1 < n:
            # Unretimed sliver between this chunk and the next chunk's
            # start (the gap guard, the whole gap after a sped-up chunk, or
            # more if extend-only clamped).
            cursor += max(0.0, float(segments[i + 1]["start"]) - chunk_end)

        # Residual overflow after both knobs: stretched audio length vs the
        # segment's new video slot.
        stretched = natural / audio_rate if audio_rate > 0 else natural
        overflow_s = max(0.0, stretched - chunk * video_ratio)
        if overflow_s <= 1e-6:
            overflow_s = 0.0
        elif status != "overflow_trimmed":
            status = "overflow_trimmed"

        plan.segments.append(SegmentFit(
            index=i,
            seg_id=str(seg.get("id", f"seg_{i}")),
            audio_rate=round(audio_rate, 6),
            video_ratio=round(video_ratio, 6),
            new_start=round(new_start, 4),
            new_end=round(new_end, 4),
            orig_start=round(start, 4),
            orig_end=round(end, 4),
            effective_end=round(effective_end, 4),
            status=status,
            overflow_s=round(overflow_s, 4),
        ))
        plan.video_plan.append({
            "orig_start": round(start, 4),
            "orig_end": round(chunk_end, 4),
            "new_start": round(new_start, 4),
            "new_end": round(new_end, 4),
            "stretch_ratio": round(video_ratio, 4),
        })

    # Tail (anything after the last video chunk) at 1.0×. A sped-up segment
    # shortens the fitted timeline below the original duration.
    cursor += max(0.0, float(total_dur_s) - round(chunk_end, 4))
    shortened = any(s.video_ratio < 1.0 - 1e-6 for s in plan.segments)
    plan.total_duration = round(cursor if shortened else max(cursor, float(total_dur_s)), 4)
    return plan
