"""Voice leveling: one speech level for every voice of a chapter.

A cloned voice speaks at the loudness of its reference clip — OmniVoice scales
each take to the reference's RMS (``omnivoice.models.omnivoice.
_post_process_audio``) — so a cast cloned from a quiet and a loud recording
jumps in volume at every ``[voice:NAME]`` switch. Leveling measures each voice
over all of its spans in a chapter and moves it to :data:`TARGET_SPEECH_DB`
with ONE gain per voice: the voices meet, and each keeps its own dynamics (a
whisper still reads quieter than a shout). A volume the user set for the voice
is added on top. Each part is capped at ±:data:`MAX_LEVEL_GAIN_DB`, and a boost
stops before the voice's loudest sample passes :data:`PEAK_CEILING`, so
leveling never clips.

Pure and deterministic: measured on the CPU in float64, in bounded blocks so a
chapter-long span never needs a second full copy. torch is imported lazily so
the request models can use the constants without loading it.
"""
from __future__ import annotations

import math
from typing import Iterable, Mapping, Optional

#: Speech level every voice is brought to, in dBFS (gated RMS). OmniVoice
#: treats a reference at RMS 0.1 (-20 dBFS) as full level, and speech peaks
#: from there stay under :data:`PEAK_CEILING`.
TARGET_SPEECH_DB = -20.0
#: Largest cut or boost the leveling applies — and, separately, the largest a
#: user's own volume for one voice may be.
MAX_LEVEL_GAIN_DB = 12.0
#: A boost stops where the voice's loudest sample would reach this.
PEAK_CEILING = 0.97

_FRAME_S = 0.05
#: Frames quieter than this are silence.
_ABSOLUTE_GATE_DB = -60.0
#: Frames this far below the mean of the non-silent ones are breaths and room
#: tone, not speech.
_RELATIVE_GATE_DB = 20.0
#: Less gated speech than this (0.3 s) is too little to level by.
_MIN_SPEECH_FRAMES = 6
#: Frames measured per pass: one minute keeps the float64 copy small.
_FRAMES_PER_BLOCK = 1200


def span_voice_name(voice_id: Optional[str], default_voice: Optional[str] = None,
                    voice_map: Optional[Mapping] = None) -> str:
    """The voice a span is leveled under, and the key of its volume in
    ``voice_gains``: the name its ``[voice:NAME]`` tag wrote, ``''`` for the
    book's default voice.

    The parser writes the default voice's profile id into every run without a
    tag and after ``[voice:]``, and Stories writes a line's profile id;
    ``[voice:default]`` reads in the default voice too unless the cast gives
    that name a voice of its own. The editor keys volumes by the same rule
    (``voiceGainKey`` in ``electron/src/shared/utils/longformOverrides.js``).
    """
    if not voice_id or voice_id == default_voice:
        return ""
    if voice_id == "default" and not (voice_map or {}).get("default"):
        return ""
    return voice_id


def clamp_gain_db(db) -> float:
    """``db`` as a gain leveling may apply: within ±:data:`MAX_LEVEL_GAIN_DB`;
    anything that is not a finite number is 0 dB."""
    try:
        value = float(db)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(value):
        return 0.0
    return max(-MAX_LEVEL_GAIN_DB, min(MAX_LEVEL_GAIN_DB, value))


def _blocks(audio, size: int):
    """``audio`` as ``(channels, samples)`` float64 CPU blocks of ``size``
    samples, the last one possibly shorter."""
    import torch

    x = torch.as_tensor(audio).detach()
    if x.dim() == 0 or x.shape[-1] == 0:
        return
    x = x.reshape(-1, x.shape[-1])
    for start in range(0, x.shape[-1], size):
        yield x[:, start:start + size].to(device="cpu", dtype=torch.float64)


def _frame_powers(audio, sample_rate: int):
    """Mean square of every whole 50 ms frame of one take, across channels."""
    import torch

    n = max(1, round(sample_rate * _FRAME_S))
    powers = []
    for block in _blocks(audio, n * _FRAMES_PER_BLOCK):
        frames = block.shape[-1] // n
        if frames:
            powers.append(block[:, :frames * n].reshape(block.shape[0], frames, n)
                          .pow(2).mean(dim=(0, 2)))
    return torch.cat(powers) if powers else torch.zeros(0, dtype=torch.float64)


def _peak(audio) -> float:
    return max((float(block.abs().max()) for block in _blocks(audio, 1 << 20)
                if block.numel()), default=0.0)


def speech_level_db(audio, sample_rate: int) -> Optional[float]:
    """Speech level of ``audio`` in dBFS: one take, or a list of takes measured
    together (one voice across a chapter).

    The RMS of the 50 ms frames that are speech — louder than -60 dBFS, and
    within 20 dB of the mean of those — so pauses, breaths and room tone do not
    pull a sparse reading down. ``None`` with less than 0.3 s of speech.
    """
    import torch

    takes = audio if isinstance(audio, (list, tuple)) else [audio]
    if not takes:
        return None
    powers = torch.cat([_frame_powers(take, sample_rate) for take in takes])
    loud = powers[powers > 10.0 ** (_ABSOLUTE_GATE_DB / 10.0)]
    if not loud.numel():
        return None
    speech = loud[loud > float(loud.mean()) * 10.0 ** (-_RELATIVE_GATE_DB / 10.0)]
    if speech.numel() < _MIN_SPEECH_FRAMES:
        return None
    return 10.0 * math.log10(float(speech.mean()))


def peak_safe_gain_db(gain_db: float, peak: float, ceiling: float = PEAK_CEILING) -> float:
    """``gain_db``, lowered so audio peaking at ``peak`` stays at or under
    ``ceiling``. Only a boost is limited, and never below 0 dB: audio that
    already peaks past the ceiling is left as loud as it is, not cut."""
    if gain_db <= 0.0 or peak <= 0.0:
        return gain_db
    return max(0.0, min(gain_db, 20.0 * math.log10(ceiling / peak)))


def apply_gain(audio, gain_db: float):
    """``audio`` scaled by ``gain_db``; the same object at 0 dB, so a voice
    nothing moves keeps its exact samples."""
    if not gain_db:
        return audio
    return audio * (10.0 ** (gain_db / 20.0))


def voice_gains_db(takes: Iterable, sample_rate: int, *, level: bool = True,
                   offsets: Optional[Mapping] = None) -> dict:
    """The gain in dB for each voice of ``takes`` — ``(voice, audio)`` pairs.

    ``level`` moves each voice's speech level (all its takes measured
    together) to :data:`TARGET_SPEECH_DB`; a voice with too little speech to
    measure is not moved. ``offsets`` is the user's own volume per voice, added
    on top. Each part is capped at ±:data:`MAX_LEVEL_GAIN_DB`, and a boost stops
    before the voice's loudest sample passes :data:`PEAK_CEILING`. One gain per
    voice, so its takes keep their loudness relative to each other.
    """
    by_voice: dict = {}
    for voice, audio in takes:
        by_voice.setdefault(voice, []).append(audio)
    gains = {}
    for voice, voice_takes in by_voice.items():
        gain = clamp_gain_db((offsets or {}).get(voice, 0.0))
        if level:
            measured = speech_level_db(voice_takes, sample_rate)
            if measured is not None:
                gain += clamp_gain_db(TARGET_SPEECH_DB - measured)
        if gain > 0.0:
            gain = peak_safe_gain_db(gain, max(_peak(take) for take in voice_takes))
        gains[voice] = gain
    return gains
