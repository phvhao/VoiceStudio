"""Audiobook creator — chapterized long-form narration (parity Wave 5).

Turns a chapter-delimited script into a chapterized audiobook. This module is
the engine-agnostic core:

  * ``parse_audiobook_script`` — pure parser: Markdown ``# H1`` headings become
    chapters; inline ``[voice:NAME]`` switches the narrator; ``[pause …]`` is
    delegated to the existing :func:`omnivoice.utils.text.parse_pause_markers`
    so audiobooks and single-shot synthesis share one pause dialect.
  * ``synthesize_chapter`` — orchestration: renders a chapter's spans through an
    injected ``synth(text, voice_id) -> tensor`` callable (reusing the
    ``chunked_tts`` splitter + crossfade), stitching the inter-span silences.
    Injecting the synth keeps this unit-testable with a stub backend (no torch
    model, no GPU).
  * ``build_chapter_ffmetadata`` / ``build_m4b_cmd`` — pure builders for the
    ffmpeg chapterized-m4b mux (FFMETADATA1 ``[CHAPTER]`` blocks + concat-demux
    argv). The actual ffmpeg run lives in the (impure) caller.

Scope (first cut): plain chapter-delimited text/Markdown input. epub/pdf
ingestion, the streaming synth job + UI are deferred follow-ups.
"""

from __future__ import annotations

import json
import re
import zlib
from dataclasses import dataclass, field, replace
from typing import Callable, Optional, Sequence


#: Mix constant for the per-occurrence seed nonce (#1208) — a large odd
#: multiplier (Knuth) so occurrence 0/1/2 land in well-separated regions of the
#: 2**31 seed space instead of adjacent integers.
_NONCE_MIX = 2654435761


def segment_seed(base_seed: int, text: str, nonce: int = 0) -> int:
    """Deterministic RNG seed for one longform synthesis call (#1139).

    A voice profile's pinned ``seed`` (locked takes, design profiles) makes
    ``/generate`` reproducible, but the longform path used to fetch the seed
    and never apply it — book renders were unseeded, so a profile pinned for
    consistency still drifted between fresh renders. Deriving the per-call
    seed from ``base_seed`` + a CRC of the chunk text mirrors ``/generate``'s
    per-chunk decorrelation (``used_seed + i``) while staying order- and
    cache-independent: a partially cached chapter re-renders its missing
    segments with the exact seeds a full render would have used. Pure —
    torch-free — so the router's synth wrappers stay unit-testable.

    Text-keyed on purpose: identical repeated lines get identical takes.
    That is already the longform pipeline's shipped semantic — the
    content-addressed SegmentCache (longform_render.segment_cache_key hashes
    text + voice sig, not position) replays one WAV for every identical span
    — and it only applies when the user pinned a seed, i.e. asked for
    reproducibility. Position-based keys would break it: inserting one
    paragraph would shift every later span's seed, so a partial re-render
    after an edit would no longer match the original render.

    ``nonce`` (default 0 — the shipped text-keyed behaviour, byte-identical)
    is the cache opt-out lever (#1208): when the user asks to *vary repeated
    lines*, the synth wrapper feeds a per-occurrence nonce so each repeat of an
    identical pinned-seed line gets a distinct-but-deterministic seed instead
    of replaying one take.
    """
    return (int(base_seed) + zlib.crc32(text.encode("utf-8")) + int(nonce) * _NONCE_MIX) % (2**31)


def punctuation_pause_pairs(pauses) -> Optional[tuple]:
    """``{family: ms}`` → the sorted, hashable pairs :class:`ExpressiveOptions`
    stores (``None`` stays ``None``: phrase rendering off)."""
    if pauses is None:
        return None
    return tuple(sorted((str(k), int(v)) for k, v in dict(pauses).items()))


def voice_gain_pairs(gains) -> Optional[tuple]:
    """``{voice name: dB}`` → the sorted, hashable pairs :class:`ExpressiveOptions`
    stores: names trimmed like the parser trims them, gains clamped to ±12 dB
    and rounded to 0.1 dB, 0 dB dropped — so no change at all stays ``None``
    and two requests that sound the same share one cache key."""
    if not gains:
        return None
    from services.voice_leveling import clamp_gain_db

    pairs = {}
    for name, db in dict(gains).items():
        value = round(clamp_gain_db(db), 1)
        if value:
            pairs[str(name).strip()] = value
    return tuple(sorted(pairs.items())) or None


@dataclass(frozen=True)
class ExpressiveOptions:
    """Optional expressive/quality knobs for a longform render (#1208).

    Every field is ``None``/``False`` by default, and a default instance means
    *reproduce today's bytes exactly*: the audiobook/longform path renders at
    its documented quality preset (num_step 32, guidance 2.0, model-default
    temperatures, postprocess on) with no emotion and the shipped
    content-addressed caching. Any non-default field is folded into every cache
    signature via :meth:`cache_signature` (chapter cache, segment cache, and the
    preview cache all consume it) so a changed setting can never silently replay
    stale audio — the whole point of the CRITICAL TRAP guard. For the default
    engine, the steps and postprocessing the Settings → Performance preset
    renders at are written into ``num_step`` / ``postprocess_output`` before
    any key is derived (``api.routers.audiobook._preset_opts``), so the preset
    keys the caches too.

    ``emo_*`` reach only engines that understand them (IndexTTS2) through the
    generic synth closure; the VoiceStudio model rejects unknown config kwargs, so
    the omnivoice path forwards only the sampling knobs. ``vary_repeats`` is the
    cache opt-out: identical lines get distinct takes.
    """

    num_step: Optional[int] = None
    guidance_scale: Optional[float] = None
    position_temperature: Optional[float] = None
    class_temperature: Optional[float] = None
    postprocess_output: Optional[bool] = None
    seed: Optional[int] = None
    emo_vector: Optional[tuple] = None
    emo_text: Optional[str] = None
    emo_alpha: Optional[float] = None
    vary_repeats: bool = False
    #: Seamless joins (#2216): trim each render's own lead-in/tail, then add
    #: deliberate silence — ``line_gap_ms`` between consecutive lines that carry
    #: no explicit ``[pause]``, ``paragraph_gap_ms`` at a blank line inside one
    #: line. Zero/False = today's bytes (hard joins with engine padding kept).
    line_gap_ms: int = 0
    paragraph_gap_ms: int = 0
    trim_edges: bool = False
    #: Phrase-by-phrase rendering: each sentence/clause is its own engine take,
    #: joined with this silence per punctuation family (sorted ``(family, ms)``
    #: pairs, hashable for the frozen dataclass). ``None`` = one take per
    #: paragraph chunk, today's bytes. ``split_commas`` makes every comma a
    #: phrase boundary too.
    punctuation_pauses: Optional[tuple] = None
    split_commas: bool = False
    #: Listen back to each take with the installed ASR and retake the ones
    #: that say something else (``services.speech_verify``).
    verify_speech: bool = False
    #: Voice leveling (``services.voice_leveling``): bring every voice of a
    #: chapter to one speech level, plus the user's own volume per voice —
    #: sorted ``(name, dB)`` pairs, ``''`` naming the book's default voice.
    #: Both re-balance finished takes, so they key the chapter, never a take.
    level_voices: bool = False
    voice_gains: Optional[tuple] = None

    #: Manifest keys that shape the join, not the engine call — never forward
    #: these as synth kwargs.
    JOIN_KEYS = ("line_gap_ms", "paragraph_gap_ms", "trim_edges",
                 "punctuation_pauses", "split_commas", "level_voices", "voice_gains")
    #: Manifest keys that are never engine kwargs (the join, plus render-side
    #: switches such as the speech check).
    RENDER_KEYS = JOIN_KEYS + ("verify_speech",)

    def join_kwargs(self) -> dict:
        """The subset of options :func:`synthesize_chapter` takes directly."""
        kw = {k: getattr(self, k) for k in self.JOIN_KEYS}
        if kw["punctuation_pauses"] is not None:
            kw["punctuation_pauses"] = dict(kw["punctuation_pauses"])
        if kw["voice_gains"] is not None:
            kw["voice_gains"] = dict(kw["voice_gains"])
        return kw

    @property
    def is_default(self) -> bool:
        """True when every knob is untouched → today's exact render + caching."""
        return self == ExpressiveOptions()

    def cache_signature(self) -> str:
        """Deterministic content string folded into every cache key. Empty for a
        default instance (so unset → byte-identical keys to pre-#1208). Includes
        EVERY field, so a future forgotten knob still perturbs the key (the
        regression test loops over the fields asserting each changes this)."""
        if self.is_default:
            return ""
        payload = {
            "num_step": self.num_step,
            "guidance_scale": self.guidance_scale,
            "position_temperature": self.position_temperature,
            "class_temperature": self.class_temperature,
            "postprocess_output": self.postprocess_output,
            "seed": self.seed,
            "emo_vector": list(self.emo_vector) if self.emo_vector else None,
            "emo_text": self.emo_text,
            "emo_alpha": self.emo_alpha,
            "vary_repeats": self.vary_repeats,
        }
        # Keep pre-join-control keys for every legacy render, including ones
        # with a seed or emotion override (not only the all-default instance).
        if self.line_gap_ms or self.paragraph_gap_ms or self.trim_edges:
            payload.update({k: getattr(self, k) for k in
                            ("line_gap_ms", "paragraph_gap_ms", "trim_edges")})
        # Phrase rendering and the speech check change the audio, so they key
        # the caches — but only when on, so every existing key stays as it was.
        if self.punctuation_pauses is not None or self.split_commas:
            from services.chunked_tts import PHRASE_SPLIT_REVISION

            payload["punctuation_pauses"] = (dict(self.punctuation_pauses)
                                             if self.punctuation_pauses is not None else None)
            payload["split_commas"] = self.split_commas
            payload["phrase_split"] = PHRASE_SPLIT_REVISION
        if self.verify_speech:
            payload["verify_speech"] = True
        if self.level_voices:
            payload["level_voices"] = True
        if self.voice_gains:
            payload["voice_gains"] = dict(self.voice_gains)
        return json.dumps(payload, sort_keys=True, ensure_ascii=False)

    def take_signature(self) -> str:
        """:meth:`cache_signature` without what only joins finished takes:
        what keys a single take (the segment cache). Voice leveling re-balances
        finished takes and the gap between lines is silence put between spans,
        never inside one, so turning leveling on, changing a voice's volume or
        changing the line gap re-assembles chapters from the takes already
        cached instead of synthesizing them again."""
        return replace(self, level_voices=False, voice_gains=None, line_gap_ms=0).cache_signature()

    def legacy_take_signature(self) -> str:
        """:meth:`take_signature` as builds before the line gap left it keyed
        segments — so a segment cached under it is still found."""
        return replace(self, level_voices=False, voice_gains=None).cache_signature()

    def to_manifest(self) -> dict:
        """JSON-safe dict for the durable resume manifest (emo_vector → list).

        Voice leveling is written only when on: the remote chapter key hashes
        this manifest, so every chapter rendered without it keeps its key."""
        manifest = {
            "num_step": self.num_step,
            "guidance_scale": self.guidance_scale,
            "position_temperature": self.position_temperature,
            "class_temperature": self.class_temperature,
            "postprocess_output": self.postprocess_output,
            "seed": self.seed,
            "emo_vector": list(self.emo_vector) if self.emo_vector else None,
            "emo_text": self.emo_text,
            "emo_alpha": self.emo_alpha,
            "vary_repeats": self.vary_repeats,
            "line_gap_ms": self.line_gap_ms,
            "paragraph_gap_ms": self.paragraph_gap_ms,
            "trim_edges": self.trim_edges,
            "punctuation_pauses": (dict(self.punctuation_pauses)
                                   if self.punctuation_pauses is not None else None),
            "split_commas": self.split_commas,
            "verify_speech": self.verify_speech,
        }
        if self.level_voices:
            manifest["level_voices"] = True
        if self.voice_gains:
            manifest["voice_gains"] = dict(self.voice_gains)
        return manifest

    @classmethod
    def from_manifest(cls, data: Optional[dict]) -> "ExpressiveOptions":
        """Rebuild from a resume manifest dict (unknown keys ignored)."""
        if not data:
            return cls()
        ev = data.get("emo_vector")
        return cls(
            num_step=data.get("num_step"),
            guidance_scale=data.get("guidance_scale"),
            position_temperature=data.get("position_temperature"),
            class_temperature=data.get("class_temperature"),
            postprocess_output=data.get("postprocess_output"),
            seed=data.get("seed"),
            emo_vector=tuple(ev) if ev else None,
            emo_text=data.get("emo_text"),
            emo_alpha=data.get("emo_alpha"),
            vary_repeats=bool(data.get("vary_repeats", False)),
            line_gap_ms=int(data.get("line_gap_ms") or 0),
            paragraph_gap_ms=int(data.get("paragraph_gap_ms") or 0),
            trim_edges=bool(data.get("trim_edges", False)),
            punctuation_pauses=punctuation_pause_pairs(data.get("punctuation_pauses")),
            split_commas=bool(data.get("split_commas", False)),
            verify_speech=bool(data.get("verify_speech", False)),
            level_voices=bool(data.get("level_voices", False)),
            voice_gains=voice_gain_pairs(data.get("voice_gains")),
        )


def voice_map_signature(voice_map: Optional[dict]) -> str:
    """Deterministic cache-key fragment for a name→profile voice map (#1217).

    A longform render can carry a ``voice_map`` (``[voice:NAME]`` → profile id).
    Builds before per-voice keys folded the whole map into every cache key, so
    recasting one name re-rendered every line of the book; a span is now keyed
    by the voice it resolves to alone, and this fragment only rebuilds those
    older keys so their audio is still found. Empty for ``None``/``{}``; else
    canonical JSON over string keys."""
    if not voice_map:
        return ""
    return json.dumps({str(k): v for k, v in voice_map.items()},
                      sort_keys=True, ensure_ascii=False)


@dataclass
class Span:
    """One contiguous run of text in a single voice, plus trailing silence.

    ``speed`` (when set) is the per-span rate passed to the engine — Stories'
    per-line speed slider rides through here so the shared server render honours
    it the way the old client export did.
    """
    voice_id: Optional[str]
    text: str
    pause_ms_after: int = 0
    speed: Optional[float] = None
    #: How this span joins the NEXT one when inline markup ([slow], [emphasis],
    #: [spell]…) split one run of text into several spans. ``"continue"``: the
    #: sentence runs straight on — no gap. ``"paragraph"``: a blank line sat on
    #: the markup boundary — paragraph gap. ``None`` (every ordinary span): the
    #: line ends here — line gap. Emitted only when set, so every existing plan,
    #: manifest and cache key is byte-identical.
    join: Optional[str] = None
    #: The ``## Title`` / ``### Title`` section this span opens (the title as
    #: written) and its level (2 or 3); ``None`` on every other span. Read by
    #: the outline, the rendered timeline and the HTML export — never by
    #: synthesis, so no cache key sees it. Emitted only when set.
    section: Optional[str] = None
    section_level: Optional[int] = None
    #: A ``[volume -6dB]…[/volume]`` passage: the dB its audio is moved by,
    #: after voice leveling and the voice's own volume (``synthesize_chapter``).
    #: ``None`` on every other span. Emitted only when set, so every plan,
    #: manifest and cache key of a script without the tag is byte-identical.
    gain_db: Optional[float] = None
    #: ``"line"`` / ``"paragraph"`` when this span starts a new line or
    #: paragraph of the script (``parse_script_to_spans(layout=True)``); ``None``
    #: when it runs on in the same line or opens the chapter. Read by the
    #: rendered timeline only, for the reader's paragraphs — never by
    #: synthesis or a cache key. Emitted only when set.
    break_before: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"voice_id": self.voice_id, "text": self.text,
             "pause_ms_after": self.pause_ms_after, "speed": self.speed}
        if self.gain_db:
            d["gain_db"] = self.gain_db
        if self.join:
            d["join"] = self.join
        if self.section is not None:
            d["section"] = self.section
            d["section_level"] = self.section_level
        if self.break_before:
            d["break_before"] = self.break_before
        return d


@dataclass
class Chapter:
    title: str
    spans: list[Span] = field(default_factory=list)
    #: The script gave no title: ``title`` is the English "Chapter N" the
    #: file's chapter marks use, and a reader names it in its own language.
    untitled: bool = False

    @property
    def char_count(self) -> int:
        return sum(len(s.text) for s in self.spans)

    def to_dict(self) -> dict:
        doc = {"title": self.title, "char_count": self.char_count,
               "spans": [s.to_dict() for s in self.spans]}
        if self.untitled:
            doc["untitled"] = True
        return doc


@dataclass
class AudiobookPlan:
    chapters: list[Chapter] = field(default_factory=list)

    @property
    def char_count(self) -> int:
        return sum(c.char_count for c in self.chapters)

    @property
    def chapter_count(self) -> int:
        return len(self.chapters)

    def to_dict(self) -> dict:
        return {
            "chapters": [c.to_dict() for c in self.chapters],
            "chapter_count": self.chapter_count,
            "char_count": self.char_count,
        }


def parse_audiobook_script(text: str, *, default_voice: Optional[str] = None) -> AudiobookPlan:
    """Parse a chapter-delimited script into an :class:`AudiobookPlan`.

    Thin wrapper over the canonical :func:`services.longform_parser.
    parse_script_to_spans` (the single grammar source of truth, #27); wraps its
    span dicts in the ``Span``/``Chapter``/``AudiobookPlan`` dataclasses so the
    four router call sites and ``.to_dict()`` shape are unchanged.
    """
    from services.longform_parser import parse_script_to_spans

    chapters = [
        Chapter(title=c["title"], spans=[Span(**s) for s in c["spans"]],
                untitled=c.get("untitled", False))
        for c in parse_script_to_spans(text, default_voice=default_voice, layout=True)
    ]
    return AudiobookPlan(chapters=chapters)


#: Ceiling on the silence the join stage may ADD to one chapter. A real chapter
#: needs a few minutes at most (hundreds of paragraphs x 0.6 s); without a
#: ceiling a body of thousands of one-word paragraphs with a maxed-out gap
#: allocates gigabytes of zeros. Explicit [pause] markers are the script's own
#: and are not drawn from this budget.
MAX_JOIN_SILENCE_MS = 15 * 60 * 1000


class ChapterRenderCancelled(RuntimeError):
    """The chapter's GPU job was abandoned; stopped between chunks (#2287)."""


def _stop_if_abandoned() -> None:
    """Stop a chapter whose caller gave up, before it starts another chunk.

    A whole chapter runs as ONE GPU-pool job. When its budget runs out or the
    client disconnects, the pool guard stops waiting but cannot kill the
    thread, which then renders the rest of the chapter while holding the device
    (#2287). The guard cancels the job's scope, so check it between chunks.
    Finished spans are already in the segment cache, so a retry or resume picks
    up from there.
    """
    from services.inference_cancellation import current_cancellation

    scope = current_cancellation()
    if scope is not None and scope.cancelled.is_set():
        raise ChapterRenderCancelled(
            "Audiobook chapter stopped: its GPU job was abandoned (timed out or "
            "the client disconnected). Finished segments are cached."
        )


def _note_chunk_done() -> None:
    """Tell the pool guard that this chapter just finished a chunk (#2287).

    Without this signal, a long chapter that was still rendering chunk after
    chunk timed out as "too heavy for the available compute" when it reached
    its text-scaled budget. Same signal as /generate's (#1391). Never raises.
    """
    try:
        from services.model_manager import report_generate_progress

        report_generate_progress()
    except Exception:  # noqa: BLE001 — a liveness signal must not break a render
        pass


def _gap_after_span(span: Span, line_gap_ms: int, paragraph_gap_ms: int) -> int:
    if span.pause_ms_after > 0 or span.join == "continue":
        return 0
    if span.join == "paragraph":
        return paragraph_gap_ms or line_gap_ms
    return line_gap_ms


def _join_with_gap(parts: list, sample_rate: int, gap_ms: int, starts: Optional[list] = None):
    """Hard-concat rendered paragraphs with ``gap_ms`` of silence between them.

    ``starts`` (a list the caller owns) receives where each part begins in the
    result, in samples — ``None`` for a part that was empty."""
    import torch

    n = int(sample_rate * gap_ms / 1000.0)
    if starts is not None:
        cursor = 0
        for p in parts:
            if p is None or p.shape[-1] == 0:
                starts.append(None)
                continue
            if cursor and n > 0:
                cursor += n
            starts.append(cursor)
            cursor += p.shape[-1]
    parts = [p for p in parts if p is not None and p.shape[-1] > 0]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    from services.chunked_tts import concatenate_audio_chunks

    ref = parts[0]
    out: list = []
    for i, part in enumerate(parts):
        if i and n > 0:
            out.append(torch.zeros(*ref.shape[:-1], n, dtype=ref.dtype, device=ref.device))
        out.append(part)
    return concatenate_audio_chunks(out, sample_rate, crossfade_ms=0)


def _span_units(text: str, *, paragraph_gap_ms: int = 0,
                punctuation_pauses: Optional[dict] = None,
                split_commas: bool = False) -> list:
    """How one span's spoken text is cut into engine takes: per paragraph
    (when a paragraph gap is asked for), ``(takes, silence after each take)``
    — the phrases of a phrase-by-phrase render, else today's <=800-char chunks
    joined by the crossfade (``None``)."""
    from services.chunked_tts import (split_into_phrases, split_paragraphs,
                                      split_text_into_chunks)

    if not text:
        return []
    paragraphs = (split_paragraphs(text) if paragraph_gap_ms > 0 else []) or [text]
    units = []
    for paragraph in paragraphs:
        if punctuation_pauses is not None:
            phrases = split_into_phrases(paragraph, punctuation_pauses,
                                         split_commas=split_commas)
            units.append(([p for p, _ in phrases], [ms for _, ms in phrases]))
        else:
            units.append((split_text_into_chunks(paragraph), None))
    return units


def _accepts_attempt(synth) -> bool:
    """Whether ``synth`` takes ``attempt=`` (a retake that must differ)."""
    import inspect

    try:
        params = inspect.signature(synth).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(p.name == "attempt" or p.kind is p.VAR_KEYWORD for p in params)


def synthesize_chapter(
    spans: list[Span],
    synth: Callable[[str, Optional[str], Optional[float]], "object"],
    sample_rate: int,
    *,
    crossfade_ms: int = 50,
    line_gap_ms: int = 0,
    paragraph_gap_ms: int = 0,
    trim_edges: bool = False,
    lexicon: Optional[dict] = None,
    segment_cache: Optional["object"] = None,
    punctuation_pauses: Optional[dict] = None,
    split_commas: bool = False,
    verifier: Optional["object"] = None,
    level_voices: bool = False,
    voice_gains: Optional[dict] = None,
    voice_names: Optional[Sequence[str]] = None,
    timing: Optional[list] = None,
    recognizer: Optional[bool] = None,
):
    """Render a chapter's spans to one waveform via an injected ``synth``.

    ``synth(text, voice_id, speed)`` returns a float32 audio tensor — 1-D
    ``(samples,)`` or ``(channels, samples)``; real engines emit ``(1, samples)``
    per the ``TTSBackend`` contract (#897) — for a span of text in the given
    voice (``speed`` may be ``None`` for the engine default). Long spans are split with the ``chunked_tts`` splitter and
    crossfaded; inter-span ``pause_ms_after`` becomes silence. ``lexicon`` (when
    given) respells each span's text before chunking so the engine pronounces
    tricky words correctly; a ``None``/empty lexicon is a no-op pass-through.
    ``segment_cache`` (when given — a :class:`services.longform_render.
    SegmentCache`) is consulted per spoken span: a cached segment WAV is reused
    instead of synthesizing, and every freshly rendered span is stored the
    moment it finishes — so a one-sentence edit re-renders one segment and an
    interrupted chapter resumes from its finished segments. Pauses are
    synthesized silence and never touch the cache.

    ``punctuation_pauses`` (when given) renders phrase by phrase: every
    sentence and clause is its own engine take (``chunked_tts.
    split_into_phrases``) joined with that silence per punctuation family,
    instead of up to 800 characters per take. ``verifier`` (a
    :class:`services.speech_verify.SpeechVerifier`) listens back to each take
    and retakes the ones that say something else; ``synth`` then receives
    ``attempt=n`` for a retake when it accepts that keyword, so a pinned seed
    still yields a different take. What it found is kept with each span in
    the segment cache — takes it could not listen to (no working recognizer)
    counted as unchecked, never as checked — and the chapter's total, cached
    spans included, goes in the timing document (``speech_check``). A cached
    span with unchecked takes is rendered again, and checked, once the
    recognizer answers: asked once per chapter with that span's audio, unless
    ``recognizer`` already says it does (``True``) or does not (``False``).

    ``level_voices`` / ``voice_gains`` re-balance the rendered spans before
    they are joined (:mod:`services.voice_leveling`): each voice — span ``i``
    speaks ``voice_names[i]``, ``''`` for the book's default voice (default:
    the span's ``voice_id``) — is measured over all its spans and brought to
    one speech level, plus its own volume from ``voice_gains`` (dB by name).
    It runs after the segment cache, which keeps the takes as rendered, so
    turning it on or changing a volume re-assembles a chapter without
    synthesizing again. Silence is untouched. A span's own ``gain_db`` (a
    ``[volume]`` passage) moves it after that, with the same peak guard, and
    leveling never measures it — so a whispered line does not raise its voice.

    ``timing`` (a list the caller owns) receives the chapter's timing
    document: where every take sits in the returned audio, measured after
    every trim and join (see :func:`chapter_timing_doc`). The segment cache
    keeps each span's take ranges next to its WAV; a span loaded from a
    segment cached before that is timed as a whole.

    Returns ``(audio_tensor, duration_seconds)``. torch + chunked_tts are
    imported lazily so this module stays import-light for the pure parser path.
    """
    import torch
    from core.render_trace import call as trace_call
    from services.chunked_tts import (concatenate_audio_chunks,
                                      join_phrases,
                                      join_rendered_chunks)
    from services.pronunciation import apply_inline_overrides, apply_lexicon

    if voice_names is None:
        voice_names = [span.voice_id or "" for span in spans]
    elif len(voice_names) != len(spans):
        raise ValueError("voice_names must name the voice of every span")
    # ("a", tensor, voice) for audio, ("s", n_samples, None) for silence
    items: list = []
    pending_gap_ms = 0  # join silence owed before the next spoken span
    # Validate the complete requested silence before touching synthesis/cache.
    # Incremental shortening would bake context-dependent gaps into reusable
    # segment audio, and cache hits could evade the chapter's silence budget.
    paragraphs_by_span = []
    planned_gap_ms = 0
    total_join_ms = 0
    for span in spans:
        # Same order as apply_pronunciation: lexicon first, then the script's
        # own [[word|respelling]] overrides, so an inline override always wins.
        text = apply_inline_overrides(apply_lexicon(span.text, lexicon)) if span.text else ""
        units = _span_units(text, paragraph_gap_ms=paragraph_gap_ms,
                            punctuation_pauses=punctuation_pauses,
                            split_commas=split_commas)
        paragraphs_by_span.append(units)
        if span.text:
            total_join_ms += sum(sum(gaps) for _, gaps in units if gaps)
            total_join_ms += planned_gap_ms + max(0, len(units) - 1) * paragraph_gap_ms
            if total_join_ms > MAX_JOIN_SILENCE_MS:
                raise ValueError(
                    "Requested join silence exceeds 15 minutes in one chapter; "
                    "reduce the line/paragraph gaps or split the chapter."
                )
            planned_gap_ms = _gap_after_span(span, line_gap_ms, paragraph_gap_ms)
        if span.pause_ms_after > 0:
            planned_gap_ms = 0
    # Per-occurrence index for identical spans (#1208 cache opt-out). The
    # segment cache folds it into its key ONLY when vary_repeats is on (else
    # the key is byte-identical to pre-#1208), so a repeated identical line
    # gets a distinct cache slot — and therefore a distinct take — instead of
    # replaying one WAV. Always computed (cheap); inert when the cache ignores it.
    occ_counts: dict = {}
    retake_kw = _accepts_attempt(synth)

    def _take(text, span):
        def take(attempt):
            if attempt:
                _stop_if_abandoned()
                kw = {"attempt": attempt} if retake_kw else {}
                return trace_call("synthesis", synth, text, span.voice_id, span.speed, **kw)
            return trace_call("synthesis", synth, text, span.voice_id, span.speed)
        return verifier.render(text, take) if verifier is not None else take(0)

    # What the speech check found in this chapter: the spans rendered now and
    # what was kept with the spans reused from the cache (from a verifier that
    # counts what it listened to, as SpeechVerifier does).
    report = speech_check_record() if _counts_checks(verifier) else None
    listens = {"answer": recognizer}

    def rechecks(audio) -> bool:
        """Whether a cached span the check could not listen to is rendered
        again now: only while the recognizer answers."""
        if getattr(verifier, "unavailable", False):
            return False
        if listens["answer"] is None:
            listens["answer"] = speech_check_answers(verifier, audio, sample_rate)
        return listens["answer"]

    # Take ranges inside each span's audio, by the index of its "a" item:
    # ``[[take index, start, end], …]`` in samples, ``None`` where unknown.
    span_timing: dict = {}
    for index, (span, paragraphs, voice) in enumerate(zip(spans, paragraphs_by_span, voice_names)):
        if span.text:
            occ_key = (span.voice_id, span.text, getattr(span, "speed", None))
            occ = occ_counts.get(occ_key, 0)
            occ_counts[occ_key] = occ + 1
            audio = trace_call("cache", segment_cache.load, span, nonce=occ) if segment_cache is not None else None
            units = None
            if audio is not None:
                found = (_cached_check(segment_cache, span, occ, audio.shape[-1])
                         if report is not None else None)
                if found and found["unchecked"] and rechecks(audio):
                    # Rendered while no recognizer answered: check it now.
                    if hasattr(segment_cache, "discount"):
                        segment_cache.discount()
                    audio = None
                else:
                    units = _cached_take_ranges(segment_cache, span, occ, audio.shape[-1])
                    if found:
                        add_speech_check(report, found)
            if audio is None:
                # A blank line inside one span is a paragraph break: render
                # each paragraph on its own so the join can put a deliberate
                # gap there instead of running the paragraphs together.
                # With no paragraph gap asked for, the span stays ONE engine
                # call — the pre-existing bytes, seeds and prosody.
                rendered_paragraphs = []
                paragraph_ranges = []
                first_take = 0
                before = _check_marks(verifier) if report is not None else None
                for chunks, gaps in paragraphs:
                    rendered = []
                    for c in chunks:
                        _stop_if_abandoned()
                        rendered.append(_take(c, span))
                        _note_chunk_done()
                    # Deliberately NOT pre-filtered (#1330). Dropping the empties
                    # here both hid them — a chapter would come back short with
                    # nothing said about it — and misaligned `rendered` from
                    # `chunks`, so the concat could not name which text was lost.
                    ranges: list = []
                    if gaps is not None:
                        joined = join_phrases(rendered, sample_rate, gaps,
                                              texts=chunks, trim_edges=trim_edges,
                                              ranges=ranges)
                    else:
                        joined = join_rendered_chunks(rendered, sample_rate,
                                                      crossfade_ms=crossfade_ms,
                                                      texts=chunks, trim_edges=trim_edges,
                                                      ranges=ranges)
                    if joined is not None:
                        rendered_paragraphs.append(joined)
                        paragraph_ranges.append([(first_take + k, a, b) for k, a, b in ranges])
                    first_take += len(chunks)
                starts: list = []
                audio = _join_with_gap(
                    rendered_paragraphs, sample_rate,
                    paragraph_gap_ms, starts=starts)
                if audio is not None:
                    units = [[k, start + a, start + b]
                             for start, ranges in zip(starts, paragraph_ranges)
                             if start is not None for k, a, b in ranges if b > a] or None
                found = _span_check(verifier, before, paragraphs) if report is not None else None
                if found is not None:
                    add_speech_check(report, found)
                if audio is not None and segment_cache is not None:
                    trace_call("cache", segment_cache.store, span, audio, nonce=occ)
                    if (units or found) and hasattr(segment_cache, "store_timing"):
                        extra = {"check": found} if found is not None else {}
                        segment_cache.store_timing(span, units or [], nonce=occ,
                                                   samples=audio.shape[-1], **extra)
            if audio is not None:
                if pending_gap_ms > 0:
                    n = int(sample_rate * pending_gap_ms / 1000.0)
                    if n > 0:
                        items.append(("s", n, None))
                span_timing[len(items)] = (index, units)
                items.append(("a", audio, voice))
                # What follows this span: nothing in the middle of a line that
                # inline markup split, the paragraph gap where a blank line sat
                # on that split (line gap if no paragraph gap is set), else the
                # line gap. An explicit [pause] below replaces any of them.
                pending_gap_ms = _gap_after_span(span, line_gap_ms, paragraph_gap_ms)
        if span.pause_ms_after > 0:
            pending_gap_ms = 0
            n = int(sample_rate * span.pause_ms_after / 1000.0)
            if n > 0:
                items.append(("s", n, None))

    if report is not None and getattr(verifier, "unavailable", False):
        report["unavailable"] = True
    if not items:
        if timing is not None:
            timing.append(chapter_timing_doc([], sample_rate, 0,
                                             phrases=punctuation_pauses is not None,
                                             speech_check=report))
        return torch.zeros(0, dtype=torch.float32), 0.0
    # What leveling measured per voice, for the timing document.
    levels: dict = {}
    if level_voices or voice_gains:
        from services.voice_leveling import apply_gain, voice_gains_db

        gains = voice_gains_db([(voice, audio) for kind, audio, voice in items if kind == "a"],
                               sample_rate, level=level_voices, offsets=voice_gains,
                               report=levels)
        # Replaced one span at a time: leveling never holds a second copy of
        # the chapter.
        for i, (kind, audio, voice) in enumerate(items):
            if kind == "a":
                items[i] = (kind, apply_gain(audio, gains[voice]), voice)
    # A [volume] passage moves after its voice is leveled, so leveling measured
    # the voice as written and a whisper never raises the whole voice.
    for i, (index, _units) in span_timing.items():
        passage_db = getattr(spans[index], "gain_db", None)
        if passage_db:
            from services.voice_leveling import apply_passage_gain

            kind, audio, voice = items[i]
            items[i] = (kind, apply_passage_gain(audio, passage_db), voice)
    # Engines return (1, samples) per the TTSBackend contract while a bare
    # zeros(n) is 1-D — mixing the two crashed the final concat (#897). So
    # materialize inter-span silence AFTER the loop, matching the rendered
    # audio's channel dims / dtype / device (same pattern as generation.py's
    # _render_with_pauses). A silence-only chapter stays 1-D float32 as before.
    ref = next((t for kind, t, _ in items if kind == "a"), None)
    parts: list = [
        val if kind == "a"
        else (torch.zeros(val, dtype=torch.float32) if ref is None
              else torch.zeros(*ref.shape[:-1], val, dtype=ref.dtype, device=ref.device))
        for kind, val, _ in items
    ]
    # Hard-concat spans + silences (crossfading silence would bleed the gap).
    audio = parts[0] if len(parts) == 1 else concatenate_audio_chunks(parts, sample_rate, crossfade_ms=0)
    if timing is not None:
        # Leveling scales takes and never changes a length, so each span
        # starts where the lengths before it add up to.
        entries, cursor = [], 0
        for i, part in enumerate(parts):
            if i in span_timing:
                index, units = span_timing[i]
                entries.append({
                    "span": index, "start": cursor, "end": cursor + part.shape[-1],
                    "units": [[k, cursor + a, cursor + b] for k, a, b in units] if units else None,
                })
            cursor += part.shape[-1]
        if cursor == audio.shape[-1]:
            timing.append(chapter_timing_doc(entries, sample_rate, cursor,
                                             phrases=punctuation_pauses is not None,
                                             levels=levels, speech_check=report))
    return audio, audio.shape[-1] / float(sample_rate)


# ── Speech-check results kept with the audio ────────────────────────────────

#: Seconds of a cached span played to the recognizer to learn whether it
#: answers — enough speech for any recognizer to return words.
_PROBE_SECONDS = 30


def speech_check_record() -> dict:
    """An empty speech-check result (``longform_render.valid_speech_check``)."""
    return {"checked": 0, "retaken": 0, "unchecked": 0, "suspect": [], "unavailable": False,
            "no_recognizer": False}


def add_speech_check(total: dict, part: dict) -> None:
    """Add one span's (or chapter's) speech-check result to ``total``."""
    for key in ("checked", "retaken", "unchecked"):
        total[key] += part.get(key, 0)
    total["suspect"].extend(part.get("suspect") or [])
    for flag in ("unavailable", "no_recognizer"):
        total[flag] = bool(total.get(flag) or part.get(flag))


def speech_check_answers(verifier, audio, sample_rate: int) -> bool:
    """Whether ``verifier``'s recognizer answers now — asked before takes it
    could not listen to earlier are rendered again for it, so a render with
    no working recognizer reuses them instead of synthesizing them again to
    learn the same. Plays it up to :data:`_PROBE_SECONDS` of ``audio`` (speech
    already rendered); a recognizer that already listened to a take of this
    chapter has answered; one with no recognizer installed to ask
    (``may_answer``) is not asked at all. Never raises."""
    if getattr(verifier, "unavailable", False):
        return False
    if getattr(verifier, "checked", 0):
        return True
    hear = getattr(verifier, "hear", None)
    transcribe = getattr(verifier, "transcribe", None)
    if (hear is None and transcribe is None) or audio is None:
        return False
    try:
        may_answer = getattr(verifier, "may_answer", None)
        if may_answer is not None and not may_answer():
            return False
        head = audio[..., :int(sample_rate * _PROBE_SECONDS)]
        if hear is not None and getattr(verifier, "sample_rate", sample_rate) == sample_rate:
            # Asked the way the checks ask (the render's language, timed).
            return hear(head) is not None
        return transcribe(head, sample_rate) is not None
    except Exception:  # noqa: BLE001 — a check never fails a render
        return False


def _counts_checks(verifier) -> bool:
    """Whether ``verifier`` counts what it listened to (``checked``,
    ``retaken``, ``suspect``), so what it found can be kept per span."""
    return verifier is not None and all(
        hasattr(verifier, name) for name in ("checked", "retaken", "suspect"))


def _check_marks(verifier) -> tuple:
    """Where ``verifier``'s counters stand, to tell one span's takes apart."""
    return (verifier.checked, verifier.retaken, len(verifier.suspect))


def _span_check(verifier, before: tuple, paragraphs: list) -> dict:
    """What the speech check found in the takes of one span just rendered.

    A take the recognizer could not judge — too short — needs no check; one
    long enough that it did not listen to (no recognizer installed, or one
    that heard no words or failed) is counted ``unchecked``, so the span is
    never kept as checked; ``no_recognizer`` says it was the first."""
    from services.speech_verify import checkable

    checked, retaken, suspects = before
    listened = verifier.checked - checked
    judged = sum(1 for chunks, _gaps in paragraphs for text in chunks if checkable(text))
    unchecked = max(0, judged - listened)
    return {"checked": listened, "retaken": verifier.retaken - retaken,
            "unchecked": unchecked,
            "suspect": [dict(item) for item in verifier.suspect[suspects:]],
            "unavailable": bool(unchecked and getattr(verifier, "unavailable", False)),
            "no_recognizer": bool(unchecked and getattr(verifier, "no_recognizer", False))}


def _cached_check(segment_cache, span, nonce: int, samples: int) -> Optional[dict]:
    """The speech-check result kept with a cached segment, or ``None``."""
    load = getattr(segment_cache, "load_check", None)
    if load is None:
        return None
    try:
        return load(span, nonce, samples=samples)
    except Exception:  # noqa: BLE001 — a missing result only means unknown
        return None


def _cached_take_ranges(segment_cache, span, nonce: int, samples: int) -> Optional[list]:
    """Take ranges kept with a cached segment, or ``None`` (a segment cached
    before timing was kept, or a cache that keeps none)."""
    load = getattr(segment_cache, "load_timing", None)
    if load is None:
        return None
    try:
        units = load(span, nonce, samples=samples)
    except Exception:  # noqa: BLE001 — timing is a nicety; the audio is what counts
        return None
    from services.longform_render import valid_segment_timing

    return valid_segment_timing(
        {"version": TIMELINE_VERSION, "samples": samples, "units": units}, samples)


def chapter_timing_doc(spans: list, sample_rate: int, samples: int, *, phrases: bool,
                       levels: Optional[dict] = None,
                       speech_check: Optional[dict] = None) -> dict:
    """The timing document of one rendered chapter (version 1).

    ``spans`` lists every span that put audio in the chapter: ``{"span":
    index in the chapter, "start", "end", "units": [[take index, start, end],
    …] | None}`` in samples of the chapter audio, ``samples`` long at
    ``sample_rate``. A take index counts the span's takes in order across its
    paragraphs (a take the engine returned nothing for has no range).
    ``phrases`` says the takes are sentences and clauses (phrase-by-phrase
    reading) rather than <=800-character chunks; ``units`` is ``None`` for a
    span only known as a whole.

    ``levels`` (written only when voice leveling measured a voice) maps each
    voice name (``''`` = the default voice) to ``{"level_db", "auto_db"}``
    (:func:`services.voice_leveling.voice_gains_db`). It travels with the
    chapter's audio — the cache sidecar, a remote worker's embedded chunk — so
    a chapter replayed from the cache still reports its leveling. Readers
    ignore keys they do not know.

    ``speech_check`` (written only when the speech check ran) is what it
    found in the chapter, spans reused from the cache included
    (``longform_render.valid_speech_check``) — kept the same way, so a cached
    chapter still lists the phrases to listen to.
    """
    doc = {"version": TIMELINE_VERSION, "sample_rate": int(sample_rate),
           "samples": int(samples), "phrases": bool(phrases), "spans": spans}
    if levels:
        doc["levels"] = levels
    if speech_check is not None:
        doc["speech_check"] = speech_check
    return doc


# ── Rendered timeline (what the reader highlights) ──────────────────────────

#: A single-bracket tag left in span text ([laugh], [sigh]…): read by the
#: engine, never shown. ``[[…]]`` overrides are resolved before this applies.
_TAG_RE = re.compile(r"\[[^\[\]\n]{0,256}\]")
_SPACE_RE = re.compile(r"\s+")


def _written_overrides(text: str) -> str:
    """``text`` with each ``[[word|respelling]]`` shown as ``word`` (and
    ``[[respelling]]`` as ``respelling``): what the script says, not what the
    engine was told to say."""
    from services.pronunciation import _INLINE_RE

    if not text or "[[" not in text:
        return text or ""
    return _INLINE_RE.sub(lambda m: m.group(1).split("|", 1)[0], text)


def _display_text(text: str) -> str:
    """Take text as the listener reads it: tags removed, whitespace collapsed."""
    return _SPACE_RE.sub(" ", _TAG_RE.sub(" ", text or "")).strip()


#: How strongly a break parts two texts: a paragraph outranks a line.
_BREAK_RANK = {None: 0, "line": 1, "paragraph": 2}


def _stronger(a: Optional[str], b: Optional[str]) -> Optional[str]:
    return a if _BREAK_RANK.get(a, 0) >= _BREAK_RANK.get(b, 0) else b


def _shown_marks(text: str) -> tuple[str, list]:
    """What ``text`` shows, character by character: its characters without
    whitespace or tags (:func:`_display_text` without its spaces), and the
    break before each — ``"line"`` / ``"paragraph"`` on the first character
    after a line break / blank line (a line holding only a tag is not blank,
    as in :func:`services.longform_parser.layout_break`), else ``None``."""
    from services.longform_parser import LAYOUT_MARK, layout_break

    text = text or ""
    keys: list = []
    breaks: list = []
    gap = ""

    def walk(chunk: str) -> None:
        nonlocal gap
        for char in chunk:
            if char.isspace():
                gap += char
                continue
            breaks.append(layout_break(gap) if keys and "\n" in gap else None)
            keys.append(char)
            gap = ""

    last = 0
    for m in _TAG_RE.finditer(text):
        walk(text[last:m.start()])
        gap += LAYOUT_MARK
        last = m.end()
    walk(text[last:])
    return "".join(keys), breaks


def _cut_at_breaks(shown: str, keys: str, breaks: list, at: int) -> Optional[tuple]:
    """``shown`` (a text as :func:`_display_text` gives it) read against
    :func:`_shown_marks` from its character ``at``: ``([[text, break before],
    …], the character after it)`` — one piece, plus one for each line or
    paragraph that starts inside it. ``None`` when ``shown`` is not the text
    found there (normalization respelled it, say)."""
    own = "".join(shown.split())
    if keys[at:at + len(own)] != own:
        return None
    if not own:
        return [[shown.strip(), None]], at
    pieces, begin, brk, k = [], 0, breaks[at], 0
    for pos, char in enumerate(shown):
        if char.isspace():
            continue
        if k and breaks[at + k]:
            pieces.append([shown[begin:pos].strip(), brk])
            begin, brk = pos, breaks[at + k]
        k += 1
    pieces.append([shown[begin:].strip(), brk])
    return pieces, at + len(own)


def _take_layouts(takes: list, keys: str, breaks: list) -> list:
    """Each take's pieces (:func:`_cut_at_breaks`), read in order through its
    span's marks; once a take does not line up, it and those after it are one
    piece with no break."""
    layouts, at = [], 0
    for take in takes:
        cut = _cut_at_breaks(take, keys, breaks, at) if at is not None else None
        if cut is None:
            layouts.append([[take, None]])
            at = None
        else:
            layouts.append(cut[0])
            at = cut[1]
    return layouts


def _timed_pieces(pieces: list, start: float, end: float) -> list:
    """``pieces`` over ``[start, end]``, each by its share of the characters:
    ``[(text, start, end, break), …]``."""
    if len(pieces) == 1:
        return [(pieces[0][0], start, end, pieces[0][1])]
    total = sum(len(text) for text, _ in pieces) or 1
    out, at = [], 0
    for text, brk in pieces:
        begin = start + (end - start) * at / total
        at += len(text)
        out.append((text, begin, start + (end - start) * at / total, brk))
    return out


def _strongest_break(layout: list) -> Optional[str]:
    strongest = None
    for _, brk in layout:
        strongest = _stronger(strongest, brk)
    return strongest


def _take_texts(text: str, **split) -> list:
    return [take for takes, _ in _span_units(text, **split) for take in takes]


def span_display_takes(original: str, normalized: str, *, lexicon: Optional[dict] = None,
                       **split) -> list:
    """The display text of each take of one span, by take index.

    The span's ``original`` text (as the parser wrote it) is cut with the same
    rules as the text the engine spoke — ``normalized`` text with the lexicon
    and inline overrides applied — and paired with it take by take. When the
    two cut differently (normalization spelled a number out, the lexicon
    added a full stop), the normalized text is cut instead, overrides still
    shown as written, and failing that the spoken takes themselves.
    ``split`` is :func:`_span_units`' keywords.
    """
    from services.pronunciation import apply_inline_overrides, apply_lexicon

    spoken = _take_texts(apply_inline_overrides(apply_lexicon(normalized, lexicon)), **split)
    for candidate in (original, normalized):
        takes = _take_texts(_written_overrides(candidate), **split)
        if len(takes) == len(spoken):
            return [_display_text(t) for t in takes]
    return [_display_text(t) for t in spoken]


def book_timeline(output: str, chapters: list, *, default_voice: Optional[str] = None,
                  voice_map: Optional[dict] = None, language: Optional[str] = None,
                  lexicon: Optional[dict] = None,
                  opts: Optional[ExpressiveOptions] = None) -> dict:
    """The rendered-timeline sidecar of a finished book (version 1).

    ``chapters`` lists what the file holds, in order: ``(chapter, duration
    seconds, timing document or None[, cache key])`` — the plan's
    :class:`Chapter`, its exact audio length, what :func:`synthesize_chapter`
    measured, and the name of the cached chapter audio it came from (kept as
    ``key``, so the outline can tell which chapters changed since this book).
    Times are seconds in the output file, rounded to 1 ms. A chapter's
    precision is ``"phrase"`` when every take of it is known, ``"span"`` when
    some span is only known as a whole (a segment cached before timing was
    kept, or <=800-character chunks), and ``"chapter"`` when nothing inside it
    is known: its text is then one entry per section, timed by its share of
    the characters.

    ``sections`` lists the chapter's ``##``/``###`` headings in order:
    ``{"title", "level", "start", "phrase"}`` — the title as the listener reads
    it, where it is heard, and the index of its first entry in ``phrases``.

    A phrase that starts a new line or paragraph of the script carries
    ``"break": "line" | "paragraph"`` (never the first of a chapter), from the
    plan's ``break_before`` and the line breaks inside its spans; an entry is
    cut where one starts inside it, its time shared by characters. Readers
    that do not know the key show the text as before.
    """
    from services.text_normalization import normalize_for_tts
    from services.voice_leveling import span_voice_name

    opts = opts or ExpressiveOptions()
    split = {"paragraph_gap_ms": opts.paragraph_gap_ms,
             "punctuation_pauses": (dict(opts.punctuation_pauses)
                                    if opts.punctuation_pauses is not None else None),
             "split_commas": opts.split_commas}

    def voice_of(span) -> Optional[str]:
        return span_voice_name(span.voice_id, default_voice, voice_map) or None

    def entry(text, start, end, voice) -> dict:
        return {"text": text, "start": round(start, 3), "end": round(end, 3), "voice": voice}

    out, offset = [], 0.0
    for chapter, duration, timing, *rest in chapters:
        start, end = offset, offset + float(duration)
        offset = end
        spans = list(chapter.spans)
        if timing is not None and any(not 0 <= s["span"] < len(spans) for s in timing["spans"]):
            timing = None  # describes another plan — never trust it
        # Each entry in ``phrases`` and the span it was read from.
        phrases, owners, precision = [], [], "chapter"
        # A break whose text put no entry here yet: the next entry takes it.
        pending: Optional[str] = None

        def add(text, a, b, voice, owner, brk) -> None:
            nonlocal pending
            item = entry(text, a, b, voice)
            brk = _stronger(pending, brk)
            pending = None
            if brk and phrases:
                item["break"] = brk
            phrases.append(item)
            owners.append(owner)

        if timing is not None:
            rate = float(timing["sample_rate"])
            precision = "phrase" if timing["phrases"] else "span"
            heard = -1
            for item in timing["spans"]:
                index = item["span"]
                span = spans[index]
                for quiet in spans[heard + 1:index]:  # put no audio in the chapter
                    pending = _stronger(pending, getattr(quiet, "break_before", None))
                heard = max(heard, index)
                voice = voice_of(span)
                written = _written_overrides(span.text)
                marks = _shown_marks(written)
                if item["units"] is None:
                    precision = "span"
                    shown = _display_text(written)
                    layouts = [(_cut_at_breaks(shown, *marks, 0) or ([[shown, None]],))[0]]
                    ranges = [(0, item["start"], item["end"])]
                else:
                    takes = span_display_takes(span.text, normalize_for_tts(span.text, language),
                                               lexicon=lexicon, **split)
                    layouts = _take_layouts(takes, *marks)
                    ranges = item["units"]
                if layouts:
                    layouts[0][0][1] = _stronger(getattr(span, "break_before", None),
                                                 layouts[0][0][1])
                following = 0
                for k, a, b in ranges:
                    for missing in layouts[following:k]:  # takes that came back empty
                        pending = _stronger(pending, _strongest_break(missing))
                    following = max(following, k + 1)
                    if k >= len(layouts):
                        continue
                    for text, s, e, brk in _timed_pieces(layouts[k], min(end, start + a / rate),
                                                         min(end, start + b / rate)):
                        if text:
                            add(text, s, e, voice, index, brk)
                        else:
                            pending = _stronger(pending, brk)
                for missing in layouts[following:]:
                    pending = _stronger(pending, _strongest_break(missing))
        else:
            # The whole chapter as one entry per paragraph or line — and with
            # sections, each heading and the text after it as entries of their
            # own — timed by their share of the chapter's characters.
            blocks: list = []  # [first span, texts, break before, voices]
            heading = False
            for index, span in enumerate(spans):
                opens = getattr(span, "section", None) is not None
                if not blocks or opens or heading:
                    blocks.append([index, [], None, set()])
                heading = opens
                if not span.text:
                    continue
                written = _written_overrides(span.text)
                shown = _display_text(written)
                pieces = (_cut_at_breaks(shown, *_shown_marks(written), 0) or ([[shown, None]],))[0]
                pieces[0][1] = _stronger(getattr(span, "break_before", None), pieces[0][1])
                for text, brk in pieces:
                    if brk and blocks[-1][1]:
                        blocks.append([index, [], None, set()])
                    blocks[-1][2] = _stronger(blocks[-1][2], brk)
                    blocks[-1][1].append(text)
                    blocks[-1][3].add(voice_of(span))
            texts = [_display_text(" ".join(parts)) for _, parts, _, _ in blocks]
            total = sum(len(t) for t in texts)
            at = 0
            for (first, _, brk, voices), text in zip(blocks, texts):
                if text:
                    add(text, start + (end - start) * at / total,
                        start + (end - start) * (at + len(text)) / total,
                        voices.pop() if len(voices) == 1 else None, first, brk)
                else:
                    pending = _stronger(pending, brk)
                at += len(text)
        sections = []
        for index, span in enumerate(spans):
            if getattr(span, "section", None) is None:
                continue
            # Heard from the first entry read at or after its heading.
            first = next((k for k, owner in enumerate(owners) if owner >= index), None)
            if first is None:
                continue
            sections.append({"title": _display_text(_written_overrides(span.section)),
                             "level": span.section_level or 2,
                             "start": phrases[first]["start"], "phrase": first})
        doc = {"title": chapter.title, "start": round(start, 3), "end": round(end, 3),
               "precision": precision, "phrases": phrases, "sections": sections}
        if getattr(chapter, "untitled", False):
            doc["untitled"] = True
        if rest and rest[0]:
            doc["key"] = str(rest[0])
        out.append(doc)
    return {"version": TIMELINE_VERSION, "output": output, "duration": round(offset, 3),
            "chapters": out}


def timeline_with_layout(timeline: dict, script: str) -> dict:
    """A timeline written before phrases carried ``break`` (see
    :func:`book_timeline`), given the lines and paragraphs of the script it
    was rendered from: each chapter whose text is exactly the next chapter of
    the script gets its breaks — an entry cut where one starts inside it, its
    time shared by characters, its sections' entry indices moved along. A
    timeline that has breaks already, and a chapter whose text the script no
    longer holds, come back as they are. Never changes ``timeline``."""
    found = timeline.get("chapters") if isinstance(timeline, dict) else None
    if not script or not isinstance(found, list):
        return timeline
    listed = [c.get("phrases") for c in found if isinstance(c, dict)]
    if any(isinstance(p, dict) and "break" in p
           for phrases in listed if isinstance(phrases, list) for p in phrases):
        return timeline
    marks = []
    for chapter in parse_audiobook_script(script).chapters:
        keys, breaks = [], []
        for span in chapter.spans:
            own, brks = _shown_marks(_written_overrides(span.text))
            if own and keys:
                brks[0] = _stronger(span.break_before, brks[0])
            if own:
                keys.append(own)
                breaks.extend(brks)
        marks.append(("".join(keys), breaks))
    out, after = [], 0
    for chapter in found:
        phrases = chapter.get("phrases") if isinstance(chapter, dict) else None
        if not isinstance(phrases, list) or not all(
                isinstance(p, dict) and isinstance(p.get("text"), str)
                and isinstance(p.get("start"), (int, float))
                and isinstance(p.get("end"), (int, float)) for p in phrases):
            out.append(chapter)
            continue
        own = "".join("".join(p["text"].split()) for p in phrases)
        match = next((j for j in range(after, len(marks)) if own and marks[j][0] == own), None)
        if match is None:
            out.append(chapter)
            continue
        after = match + 1
        keys, breaks = marks[match]
        laid, moved, at = [], [], 0
        for phrase in phrases:
            pieces, at = (_cut_at_breaks(phrase["text"], keys, breaks, at)
                          or ([[phrase["text"], None]], at))
            moved.append(len(laid))
            for text, s, e, brk in _timed_pieces(pieces, phrase["start"], phrase["end"]):
                item = {**phrase, "text": text, "start": round(s, 3), "end": round(e, 3)}
                if brk and laid:
                    item["break"] = brk
                laid.append(item)
        doc = {**chapter, "phrases": laid}
        if isinstance(chapter.get("sections"), list):
            doc["sections"] = [
                {**s, "phrase": moved[s["phrase"]]}
                if isinstance(s, dict) and type(s.get("phrase")) is int
                and 0 <= s["phrase"] < len(moved) else s
                for s in chapter["sections"]]
        out.append(doc)
    return {**timeline, "chapters": out}


# ── ffmpeg / metadata builders ──────────────────────────────────────────────
#
# These now live in the shared ``longform_render`` core (Stories + Audiobook
# converge on one mux). The thin wrappers below preserve the original
# audiobook-only call sites/signatures; new callers should use
# ``longform_render`` directly to reach global metadata, cover art, loudness,
# and mp3 output.
from services.longform_render import (  # noqa: E402
    TIMELINE_VERSION,
    build_concat_list,
    build_ffmetadata,
    build_render_cmd,
)


def build_chapter_ffmetadata(chapters: list[tuple[str, int]]) -> str:
    """Backward-compatible alias: chapters-only FFMETADATA (no global tags)."""
    return build_ffmetadata(chapters)


def build_m4b_cmd(
    ffmpeg: str,
    concat_list_path: str,
    metadata_path: str,
    out_path: str,
    *,
    bitrate: str = "128k",
) -> list[str]:
    """Backward-compatible alias: a chapterized faststart m4b, no cover/loudness."""
    return build_render_cmd(
        ffmpeg, concat_list_path, metadata_path, out_path,
        fmt="m4b", bitrate=bitrate,
    )
