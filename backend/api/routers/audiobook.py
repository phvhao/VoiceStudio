"""Audiobook creator endpoints (parity Wave 5).

``POST /audiobook/plan`` — pure preview: parse a chapter-delimited script
(Markdown ``# H1`` chapters, inline ``[voice:NAME]`` / ``[pause …]``) into the
chapter/span plan, no synthesis.

``POST /audiobook`` — the synth job: render each chapter through the active TTS
backend (reusing ``services.audiobook.synthesize_chapter`` + ``chunked_tts``),
then mux the chapter WAVs into a chapterized **m4b** (FFMETADATA1 chapters via
``build_m4b_cmd``). Progress streams as Server-Sent Events, mirroring the dub
pipeline. ffmpeg-gated — without ffmpeg the job reports an error event and
stops (the m4b is the only output format).

``GET /audiobook/timeline/{output}`` — the rendered timeline of a finished
book: where each phrase is heard, measured while the chapters were joined
(``services.audiobook.book_timeline``), for the reader's highlight.

``GET /audiobook/sampling`` — the steps and postprocessing a render of the
active engine takes when the request leaves them unset (the performance
preset applied), so the app shows what a render will use.

``POST /audiobook/takes`` + ``POST /audiobook/retake`` — with phrase-by-phrase
reading every sentence is a take cached on its own: the first lists a
chapter's takes, the second asks for one of them again, so the next render or
preview synthesizes that take and reuses the rest. ``POST /longform/takes`` +
``POST /longform/retake`` do the same for a chapter of a posted plan (Stories).

``GET /audiobook/jobs`` + ``POST /audiobook/resume/{job_id}`` — durable
crash-resume: an interrupted render persists its plan + params to a
``resume.json`` manifest in the job work dir, so it can be resumed later (the
content-addressed chapter cache makes finished chapters instant) even without
the original script. The resume UI affordance remains a follow-up.

epub/pdf ingest, ACX mastering shipped; the resume UI surface remains a follow-up.
"""

import asyncio
import contextlib
import dataclasses
import json
import logging
import os
import re
import shutil
import time
import uuid

from collections.abc import Awaitable, Callable

from core import voice_leases
from core.render_trace import call as trace_call, stage as trace_stage

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from services.audiobook import (
    ExpressiveOptions,
    book_timeline,
    punctuation_pause_pairs,
    parse_audiobook_script,
    synthesize_chapter,
    voice_gain_pairs,
)
from services.chunked_tts import DEFAULT_PUNCTUATION_PAUSES
from services.speech_verify import recognizer_lease  # pure (no torch)
from services.longform_render import (
    ENCODER_PEAK_HEADROOM_DB,
    LONGFORM_CACHE_SUBDIR,
    LOUDNESS_PRESETS,
    CacheHold,
    build_concat_list,
    build_ffmetadata,
    build_render_cmd,
    load_chapter_timeline,
    peak_headroom_after,
    prune_cache_dir,
    read_json_file,
    wav_sample_rate,
    write_json_atomic,
    write_lf_text,
)
from services import longform_resume  # pure (no torch) — durable resume manifest
from services.voice_leveling import MAX_LEVEL_GAIN_DB, span_voice_name  # pure (no torch)

logger = logging.getLogger("omnivoice.audiobook")
router = APIRouter()

# A cover filename as produced by /audiobook/cover: 12 hex chars + image ext.
# An exact-match allowlist is the strongest barrier (and the one CodeQL's
# path-injection query recognizes) — anything else is rejected outright.
_COVER_NAME_RE = re.compile(r"^[0-9a-f]{12}\.(?:jpg|jpeg|png)$")
# A finished render as _render_longform_sse names it: ``<job type>_<job id>``
# (the id already reduced to [A-Za-z0-9_-]) + its format. Same exact-match
# barrier as the cover name.
_OUTPUT_NAME_RE = re.compile(r"^[a-z]{1,32}_[A-Za-z0-9_-]{1,64}\.(?:m4b|mp3)$")
#: The rendered timeline of a finished book: ``<output>.timeline.json`` next to it.
TIMELINE_SIDECAR_SUFFIX = ".timeline.json"
#: Where earlier versions left a book's HTML export: ``<output>.html.zip``
#: next to it. Exports wait in the temp folder now; one found here is removed.
HTML_EXPORT_SUFFIX = ".html.zip"
#: HTML exports wait in this folder of the app's data folder, outside the
#: outputs, until the app downloads them: each holds a full copy of the book's
#: audio, so it is served once and removed.
HTML_EXPORT_DIRNAME = "html_exports"
_HTML_EXPORT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
#: An export the app never asked for again (a browser download that did not
#: finish) is removed by the next export once it is this old, and at start-up.
_HTML_EXPORT_STALE_S = 60 * 60
# A day-long book is a few MB of timeline; anything far past that is not one.
_TIMELINE_MAX_BYTES = 64 * 1024 * 1024
#: Encodes a loudness-mastered book may take to stay under its peak ceiling:
#: the first, then up to two with more limiter headroom.
_MASTER_ENCODES = 3


def _safe_cover_path(cover_path: str | None) -> str | None:
    """Confine a user-supplied cover to the upload directory before it can flow
    into ffmpeg.

    Covers only ever come from ``/audiobook/cover``, which writes them to
    ``OUTPUTS_DIR/audiobook_covers`` with a generated name. We rebuild the path
    from the basename alone (``os.path.basename`` strips any directory component
    or ``..`` traversal) joined onto that fixed directory, so no caller-supplied
    path — absolute or relative — can escape it. Returns the path only if the
    file actually exists there, else None."""
    if not cover_path:
        return None
    from core.config import OUTPUTS_DIR
    name = os.path.basename(cover_path)
    if not _COVER_NAME_RE.match(name):
        return None  # not a name the upload endpoint could have produced
    cover_dir = os.path.realpath(os.path.join(OUTPUTS_DIR, "audiobook_covers"))
    real = os.path.realpath(os.path.join(cover_dir, name))
    # Containment check on the resolved path itself — it must live inside the
    # covers dir. Belt-and-suspenders over the regex+basename above; the
    # commonpath form is the path-injection barrier static analysis recognizes.
    if os.path.commonpath([real, cover_dir]) != cover_dir:
        return None
    return real if os.path.isfile(real) else None


class PunctuationPauses(BaseModel):
    """Silence (ms) after each punctuation family in a phrase-by-phrase render.
    Bounded like the line/paragraph gaps; defaults mirror
    ``chunked_tts.DEFAULT_PUNCTUATION_PAUSES``."""

    model_config = ConfigDict(extra="forbid")

    sentence: int = Field(default=DEFAULT_PUNCTUATION_PAUSES["sentence"], ge=0, le=5000)
    ellipsis: int = Field(default=DEFAULT_PUNCTUATION_PAUSES["ellipsis"], ge=0, le=5000)
    semicolon: int = Field(default=DEFAULT_PUNCTUATION_PAUSES["semicolon"], ge=0, le=5000)
    colon: int = Field(default=DEFAULT_PUNCTUATION_PAUSES["colon"], ge=0, le=5000)
    dash: int = Field(default=DEFAULT_PUNCTUATION_PAUSES["dash"], ge=0, le=5000)
    comma: int = Field(default=DEFAULT_PUNCTUATION_PAUSES["comma"], ge=0, le=5000)


class ExpressiveMixin(BaseModel):
    """Optional expressive/quality knobs shared by every longform front door
    (#1208). All optional — an omitted field reproduces today's exact render.

    * Sampling: ``num_step`` / ``guidance_scale`` / ``position_temperature`` /
      ``class_temperature`` / ``postprocess_output`` — the same surface the
      Voice page's Production Overrides expose. Unset → the documented longform
      preset (num_step 32, guidance 2.0, model-default temps, postprocess on),
      with the Settings → Performance preset's steps and postprocessing once
      one applies (``GET /audiobook/sampling`` says which).
    * ``seed`` — a book-level determinism override (else the profile's pinned
      seed, else fresh-render variety).
    * Emotion (IndexTTS2 only): ``emo_vector`` (8 floats) / ``emo_text`` /
      ``emo_alpha`` — reach engines that understand them via the generic synth
      closure; other engines ignore them.
    * ``vary_repeats`` — cache opt-out: give identical repeated lines distinct
      takes instead of replaying one recording (default off = today).
    * ``level_voices`` / ``voice_gains`` — voice leveling: one speech level for
      every voice of a chapter, plus a volume per voice (default off = today).
    """

    model_config = ConfigDict(allow_inf_nan=False)

    # Bounds so a loopback POST (reachable by a browser-tab CSRF) can't pin a
    # GPU-pool worker with an absurd step count or otherwise feed the sampler
    # nonsense. Ranges are generous supersets of the Voice-page controls; unset
    # (None) still means "use the longform default", unchanged. (#1208)
    # Seamless joins: trim each render's own lead-in/tail, then add deliberate
    # silence between lines (unless a [pause] says otherwise) and at blank
    # lines inside a line. Bounded so a request cannot pad a book with hours
    # of silence. Send 0 / false for the pre-existing hard joins.
    line_gap_ms: int = Field(default=0, ge=0, le=5000)
    # 350, not more: the trim keeps each paragraph's natural decay (~0.3-0.4 s of
    # near-silence), so the HEARD break is gap + decay. Measured on a full chapter
    # against a professional read, 600 put 26 breaks over a second; 300-400 matched.
    paragraph_gap_ms: int = Field(default=0, ge=0, le=5000)
    trim_edges: bool = False
    num_step: int | None = Field(default=None, ge=1, le=512)
    guidance_scale: float | None = Field(default=None, ge=0.0, le=20.0)
    position_temperature: float | None = Field(default=None, ge=0.0, le=100.0)
    class_temperature: float | None = Field(default=None, ge=0.0, le=100.0)
    postprocess_output: bool | None = None
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)
    emo_vector: list[float] | None = Field(default=None, min_length=8, max_length=8)
    emo_text: str | None = Field(default=None, max_length=500)
    emo_alpha: float | None = Field(default=None, ge=0.0, le=1.0)
    vary_repeats: bool = False
    # Phrase-by-phrase rendering: every sentence/clause is its own engine take,
    # joined with this silence per punctuation family (omitted families use the
    # defaults). Omitted entirely → one take per <=800-char chunk, today's audio.
    punctuation_pauses: "PunctuationPauses | None" = None
    split_commas: bool = False
    # Listen back to each take with the installed ASR; retake mismatches.
    verify_speech: bool = False
    # Follow Settings → Reading for whichever of the three fields above the
    # request leaves out. The app sends this; API callers that omit it keep
    # exactly the render they had (one take per paragraph, no check).
    use_app_reading: bool = False
    # Voice leveling: bring every voice of a chapter to one speech level, so a
    # cast cloned from quiet and loud recordings reads at one volume; and a
    # volume of the user's own per voice, in dB by [voice:NAME] name ('' = the
    # default voice), clamped to ±12 dB. Omitted → the audio renders as before.
    level_voices: bool | None = None
    voice_gains: Annotated[
        dict[Annotated[str, StringConstraints(max_length=128)], float],
        Field(max_length=64),
    ] | None = None

    @field_validator("voice_gains")
    @classmethod
    def _clamp_voice_gains(cls, gains: dict[str, float] | None) -> dict[str, float] | None:
        if gains is None:
            return None
        return {name: max(-MAX_LEVEL_GAIN_DB, min(MAX_LEVEL_GAIN_DB, db))
                for name, db in gains.items()}


def _reading_fields(req: "ExpressiveMixin") -> dict:
    """The request's reading fields, completed from Settings → Reading when it
    asks for that (``use_app_reading``) and leaves a field out."""
    given = req.model_fields_set
    pauses = (punctuation_pause_pairs(req.punctuation_pauses.model_dump())
              if req.punctuation_pauses is not None else None)
    split_commas, verify = bool(req.split_commas), bool(req.verify_speech)
    if req.use_app_reading:
        from services import reading_settings

        app = reading_settings.load()
        if "punctuation_pauses" not in given:
            pauses = punctuation_pause_pairs(reading_settings.phrase_pauses(app))
        if "split_commas" not in given:
            split_commas = app["split_commas"]
        if "verify_speech" not in given:
            verify = app["verify_speech"]
    return {"punctuation_pauses": pauses,
            "split_commas": bool(split_commas and pauses is not None),
            "verify_speech": verify}


def _expressive_opts(req: "ExpressiveMixin") -> ExpressiveOptions:
    """Lower a request's expressive fields into the typed engine-options object."""
    return ExpressiveOptions(
        num_step=req.num_step,
        guidance_scale=req.guidance_scale,
        position_temperature=req.position_temperature,
        class_temperature=req.class_temperature,
        postprocess_output=req.postprocess_output,
        seed=req.seed,
        emo_vector=tuple(req.emo_vector) if req.emo_vector else None,
        emo_text=(req.emo_text or None),
        emo_alpha=req.emo_alpha,
        vary_repeats=bool(req.vary_repeats),
        line_gap_ms=int(req.line_gap_ms),
        paragraph_gap_ms=int(req.paragraph_gap_ms),
        trim_edges=bool(req.trim_edges),
        **_reading_fields(req),
        level_voices=bool(req.level_voices),
        voice_gains=voice_gain_pairs(req.voice_gains),
    )


class AudiobookPlanRequest(BaseModel):
    text: str
    default_voice: str | None = None


@router.post("/audiobook/plan")
def audiobook_plan(req: AudiobookPlanRequest) -> dict:
    """Parse a script into a chapter/span plan (pure preview, no synthesis)."""
    plan = parse_audiobook_script(req.text, default_voice=req.default_voice)
    return plan.to_dict()


#: Cover size cap mirrors longform_render's guard (8 MB — a book cover, not a
#: payload). Kept in sync intentionally; the render builder re-validates too.
_COVER_MAX_BYTES = 8 * 1024 * 1024
#: Import upload cap — a generous ceiling for a .txt/.md/.epub manuscript that
#: still stops a memory-exhaustion upload (the whole file is read into RAM).
_IMPORT_MAX_BYTES = 64 * 1024 * 1024
#: Upper bound on chapters in a single /longform/render plan — far above any real
#: book, but stops a pathological request from allocating/holding the job forever.
_MAX_CHAPTERS = 10_000


@router.post("/audiobook/import")
async def audiobook_import(file: UploadFile = File(...)) -> dict:
    """Import a ``.txt``/``.md``/``.epub``/``.pdf`` into a chapter-delimited script.

    EPUB is parsed in spine order (stdlib only, local); PDF text is extracted
    with pypdf (pure-Python) then chapterized; plain text gets ``# `` headings
    inserted ahead of obvious chapter-title lines. Returns the script text (for
    the editor) + the resulting chapter count."""
    from services.longform_import import (
        chapterize_plaintext,
        epub_to_chapter_script,
        pdf_to_chapter_script,
    )

    name = (file.filename or "").lower()
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > _IMPORT_MAX_BYTES:
        raise HTTPException(status_code=400, detail="file too large (max 64 MB)")
    if name.endswith(".epub"):
        try:
            script = epub_to_chapter_script(data)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"couldn't parse EPUB: {e}")
    elif name.endswith(".pdf"):
        try:
            script = pdf_to_chapter_script(data)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"couldn't parse PDF: {e}")
    else:
        from services.text_upload import decode_text_upload
        script = chapterize_plaintext(decode_text_upload(data))
    if not script.strip():
        raise HTTPException(status_code=400, detail="no text found in the file")
    plan = parse_audiobook_script(script)
    return {"text": script, "chapters": plan.chapter_count}


@router.post("/audiobook/cover")
async def audiobook_cover(cover: UploadFile = File(...)) -> dict:
    """Upload a cover image; returns a server-side ``path`` to pass back as
    ``cover_path`` in the synth request. Validated here (jpg/png + size cap) and
    again at render time."""
    from core.config import OUTPUTS_DIR

    ext = os.path.splitext(cover.filename or "")[1].lower()
    if ext not in (".jpg", ".jpeg", ".png"):
        raise HTTPException(status_code=400, detail="cover must be a .jpg or .png")
    data = await cover.read()
    if not data or len(data) > _COVER_MAX_BYTES:
        raise HTTPException(status_code=400, detail="cover must be between 1 byte and 8 MB")
    cover_dir = os.path.join(OUTPUTS_DIR, "audiobook_covers")
    os.makedirs(cover_dir, exist_ok=True)
    path = os.path.join(cover_dir, f"{uuid.uuid4().hex[:12]}{ext}")
    with open(path, "wb") as f:
        f.write(data)
    return {"path": path}


class AudiobookRequest(ExpressiveMixin):
    text: str
    default_voice: str | None = None   # voice profile id; None = engine default
    language: str | None = None        # None/"Auto" → profile language, else autodetect (#505)
    bitrate: str = "128k"
    format: str = "m4b"                 # "m4b" | "mp3"
    loudness: str | None = None         # None/"off" | "acx" | "podcast" (opt-in)
    cover_path: str | None = None       # server-side path to a jpg/png cover
    # Global tags embedded in the output: {title, author, narrator, year,
    # genre, description}. Player-visible (Apple Books / Audible read these).
    metadata: dict | None = None
    # Optional pronunciation lexicon {word: respelling} applied before synthesis.
    lexicon: dict | None = None
    # Optional cast map {[voice:NAME] → profile id} for multi-voice books (#1217).
    # Absent/empty reproduces today's exact render + cache keys.
    voice_map: dict[str, str] | None = None
    # The editor's library project this render belongs to, kept on the job row
    # so the Projects library can group a book's renders and open the book.
    project_id: str | None = Field(default=None, max_length=64)


def _resolve_voice(profile_id: str | None) -> dict:
    """Map a voice-profile id to (ref_audio, ref_text, instruct, seed).

    Compact form of the resolver in generation.py — covers locked, design and
    clone profiles. Returns all-None for the engine default (no profile).
    """
    out = {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}
    if not profile_id:
        return out
    from core.config import VOICES_DIR
    from core.db import db_conn

    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        return out
    try:
        kind = row["kind"] or "clone"
    except (KeyError, IndexError):
        kind = "clone"
    if row["is_locked"] and row["locked_audio_path"]:
        out["ref_audio"] = os.path.join(VOICES_DIR, row["locked_audio_path"])
        out["ref_text"] = row["ref_text"]
        out["instruct"] = row["instruct"]
    elif kind == "design":
        out["ref_audio"] = os.path.join(VOICES_DIR, row["ref_audio_path"]) if row["ref_audio_path"] else None
        out["ref_text"] = row["ref_text"] if out["ref_audio"] else None
        out["instruct"] = row["instruct"]
    else:
        out["ref_audio"] = os.path.join(VOICES_DIR, row["ref_audio_path"]) if row["ref_audio_path"] else None
        out["ref_text"] = row["ref_text"]
        out["instruct"] = row["instruct"]
    try:
        if row["seed"] is not None:
            out["seed"] = row["seed"]
    except (KeyError, IndexError):
        pass
    return out


def _portable_ref_audio(ref_audio: str | None) -> str | None:
    """A reference-audio path as the cache keys see it (#2279).

    Inside the voices dir it becomes ``voices:<relative path>`` — the same for
    any data-dir location or spelling; anything else (engine default, a path a
    caller passed through) is returned unchanged.
    """
    if not ref_audio:
        return ref_audio
    from core.config import VOICES_DIR

    try:
        rel = os.path.relpath(os.path.abspath(ref_audio), os.path.abspath(VOICES_DIR))
    except ValueError:  # another drive on Windows
        return ref_audio
    if rel == os.curdir or rel.startswith(os.pardir) or os.path.isabs(rel):
        return ref_audio
    return "voices:" + rel.replace(os.sep, "/")


def _voices_dir() -> str:
    from core.config import VOICES_DIR

    return VOICES_DIR


def _legacy_ref_audios(ref_audio: str | None, old_roots: list[str]) -> list[str | None]:
    """Every absolute spelling a pre-#2279 build could have keyed ``ref_audio``
    by: the current one, then one per voices root the cache was rendered
    under before (``remember_voices_root``) — so an entry written before a
    data-dir move is still found after it. Index-aligned with
    ``[current, *old_roots]``."""
    from core.config import VOICES_DIR
    from services.longform_render import rebase_path

    return [ref_audio, *(rebase_path(ref_audio, VOICES_DIR, r) for r in old_roots)]


def _voice_profile_exists(profile_id: str | None) -> bool:
    """True iff ``profile_id`` names a real voice profile (#1217).

    Used to distinguish an exact profile id (a UUID someone passed as a span
    voice) from a bare ``[voice:NAME]`` name that has no cast mapping — the
    former resolves as-is, the latter falls back to the book default instead of
    silently missing and dropping to the engine default."""
    if not profile_id:
        return False
    from core.db import db_conn

    with db_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM voice_profiles WHERE id=? LIMIT 1", (profile_id,)
        ).fetchone()
    return row is not None


def _render_summary(chapters, default_voice, voice_map, language, fmt, opts) -> dict:
    """The finished render's summary: resolve the voices it used to profile names."""
    from core.db import db_conn
    from services.longform_render import render_summary
    from services.tts_backend import OmniVoiceBackend, active_backend_id, get_backend_class

    ids: list[str] = []
    for chapter in chapters:
        for span in chapter.spans:
            pid = _map_span_voice(span.voice_id, default_voice, voice_map)
            if pid and pid not in ids:
                ids.append(pid)
    names: dict[str, str] = {}
    if ids:
        marks = ",".join("?" * len(ids))
        with db_conn() as conn:
            rows = conn.execute(f"SELECT id, name FROM voice_profiles WHERE id IN ({marks})", ids).fetchall()  # nosec B608 — placeholders only
        names = {row["id"]: row["name"] for row in rows}
    # Options that differ from the defaults — by VALUE, so an explicit seed=0 or
    # postprocess_output=False is recorded, and an untouched default is not.
    defaults = ExpressiveOptions().to_manifest()
    engine_id = active_backend_id()
    opts = _preset_opts(opts or ExpressiveOptions(), engine_id)
    chosen = opts.to_manifest()
    cls = get_backend_class(engine_id)
    if cls is OmniVoiceBackend or getattr(cls, "supports_native_omnivoice_controls", False):
        # Record effective tier values as well as explicit overrides: two
        # requests with identical synthesis settings must have identical details.
        chosen.update(_omnivoice_sampling_kwargs(opts))
    return render_summary(
        chapters,
        voices=[{"id": pid, "name": names.get(pid, "")} for pid in ids],
        engine_id=engine_id, language=language, fmt=fmt,
        options={k: v for k, v in chosen.items() if v != defaults.get(k)},
    )


def _map_span_voice(
    voice_id: str | None, default_voice: str | None, voice_map: dict | None
) -> str | None:
    """Translate a span's voice token to the profile id to synthesize with (#1217).

    A span's ``voice_id`` is whatever the longform parser captured from
    ``[voice:NAME]`` — the raw human NAME, never a profile id. Resolve it:

      * ``None``/empty (a run with no ``[voice:]``) → ``default_voice``.
      * a NAME present in ``voice_map`` → its mapped profile id. THIS is the
        multi-voice cast fix: before it, a NAME was handed straight to
        ``_resolve_voice`` as if it were a profile id, always missed (profile
        ids are UUIDs), and every ``[voice:…]`` silently rendered in the engine
        default — so ``[voice:Mara]``/``[voice:Cole]`` sounded identical.
      * an unmapped token that IS a real profile id (someone passed an exact id)
        → itself, unchanged (exact-id back-compat, e.g. Stories spans).
      * an unmapped token that is NOT a real profile id (a NAME with no cast
        entry) → ``default_voice`` (fixes the silent-default bug for unmapped
        names: no longer treated as a literal id).
    """
    if not voice_id:
        return default_voice
    if voice_map:
        mapped = voice_map.get(voice_id)
        if mapped:
            return mapped
    if _voice_profile_exists(voice_id):
        return voice_id
    return default_voice


def _resolve_default_language(language: str | None, default_voice: str | None) -> str | None:
    """Pick the language to thread into the longform synth callable.

    Priority (mirrors the single-shot /generate path, #533): an explicit
    non-Auto request ``language`` wins; otherwise the selected profile's stored
    language drives it; otherwise ``None`` (genuine Auto — the engine
    autodetects, exactly as before). Hardcoding ``None`` here (#505 B2) let the
    engine re-autodetect per chunk, so a non-English clone flipped to the wrong
    language on short/ambiguous chapters.
    """
    if language and language != "Auto":
        return language
    if default_voice:
        from core.db import db_conn
        with db_conn() as conn:
            row = conn.execute(
                "SELECT language FROM voice_profiles WHERE id=?", (default_voice,)
            ).fetchone()
        if row:
            try:
                prof_lang = row["language"]
            except (KeyError, IndexError):
                prof_lang = None
            if prof_lang and prof_lang != "Auto":
                return prof_lang
    return None


#: Longform renders run at the model's documented quality preset (#1139).
#: This used to be an accident of omission — the synth wrappers below passed
#: no num_step/guidance_scale, silently inheriting OmniVoiceGenerationConfig's
#: defaults (32 / 2.0) while interactive /generate defaults to num_step=16 —
#: and users correctly heard audiobooks as more stable than the Voice page.
#: Named constants make the divergence a documented decision (a book is a
#: cached batch job: quality beats latency) and pin book quality against any
#: upstream config-default drift. The Settings → Performance preset replaces
#: the step count once one applies (:func:`_preset_opts`) — Balanced, the one
#: a new install starts on, renders at 16.
LONGFORM_NUM_STEP = 32
LONGFORM_GUIDANCE_SCALE = 2.0


def _seed_segment_rng(base_seed, text: str, nonce: int = 0) -> int | None:
    """Apply a profile's pinned seed to this synth call (#1139).

    ``_resolve_voice`` has always fetched the profile ``seed`` — but only the
    cache signature ever used it; generation itself ran unseeded, so a locked
    take's pinned seed silently did nothing here while /generate honored it.
    No pinned seed → no-op (fresh-render variety unchanged).

    Concurrency contract: this seeds the process-global torch RNG, exactly
    like /generate's #526 seeding (generation.py's ``torch.manual_seed`` in
    ``_run_inference``/``_run_backend_inference``, same GPU pool). Both are
    strictly deterministic wherever the pool has one worker — the default on
    MPS/CPU and small-VRAM CUDA (model_manager._pick_gpu_workers) — and
    best-effort when a >1-worker CUDA pool runs another seeded job in the
    same window. Making that window race-free requires threading a per-call
    torch.Generator through the model's samplers app-wide; if that lands, it
    must cover /generate and here together, not one path.
    """
    if base_seed is None:
        return None
    import torch

    from services.audiobook import segment_seed
    seed = segment_seed(base_seed, text, nonce)
    torch.manual_seed(seed)
    return seed


def _base_seed(opts: ExpressiveOptions, voice: dict):
    """The seed that drives this render's determinism: an explicit book-level
    ``seed`` override wins, else the selected profile's pinned seed, else None
    (fresh-render variety, unchanged)."""
    return opts.seed if opts.seed is not None else voice.get("seed")


def _retake_seed_input(text: str, attempt: int, next_nonce, *, occurrence: int | None = None,
                       retake: str = "", vary: bool = False) -> tuple[str, int]:
    """``(text, nonce)`` to seed a take with: ``services.audiobook.
    take_seed_input``, the rule a remote worker seeds by too."""
    from services.audiobook import take_seed_input

    return take_seed_input(text, attempt, next_nonce, occurrence=occurrence, retake=retake,
                           vary=vary)


def _make_occ_counter(opts: ExpressiveOptions):
    """Per-closure occurrence counter for the cache opt-out (#1208).

    When ``vary_repeats`` is on, every synth call gets a monotonically rising
    nonce so a pinned-seed line that repeats is seeded distinctly per take (the
    segment cache is defeated per-occurrence in parallel). Off → always 0, so
    the seed derivation is byte-identical to pre-#1208."""
    state = {"n": 0}

    def next_nonce() -> int:
        if not opts.vary_repeats:
            return 0
        n = state["n"]
        state["n"] = n + 1
        return n

    return next_nonce


def _omnivoice_sampling_kwargs(opts: ExpressiveOptions) -> dict:
    """VoiceStudio-model generate kwargs for the sampling knobs. UNSET reproduces
    today exactly: num_step 32, guidance 2.0, and NO temperature/postprocess
    kwargs (the model keeps its own defaults). Emotion is never forwarded —
    the VoiceStudio config rejects unknown kwargs.

    Reads ``opts`` only: the Settings → Performance preset is written into
    them first (:func:`_preset_opts`), so what the engine receives and what
    the cache keys hash can never come from two different reads of it."""
    kw = {
        "num_step": opts.num_step if opts.num_step is not None else LONGFORM_NUM_STEP,
        "guidance_scale": (
            opts.guidance_scale if opts.guidance_scale is not None else LONGFORM_GUIDANCE_SCALE
        ),
    }
    if opts.position_temperature is not None:
        kw["position_temperature"] = opts.position_temperature
    if opts.class_temperature is not None:
        kw["class_temperature"] = opts.class_temperature
    if opts.postprocess_output is not None:
        kw["postprocess_output"] = opts.postprocess_output
    return kw


def _tiered_engine(engine_id: str | None) -> bool:
    """Whether ``engine_id`` takes the default engine's sampling controls — the
    ones a performance preset tunes (the model itself, or a native proxy)."""
    from services.tts_backend import OmniVoiceBackend, get_backend_class

    try:
        cls = get_backend_class(engine_id)
    except ValueError:
        return False
    return cls is OmniVoiceBackend or bool(getattr(cls, "supports_native_omnivoice_controls", False))


def _preset_opts(opts: ExpressiveOptions, engine_id: str | None = None) -> ExpressiveOptions:
    """``opts`` with the sampling the Settings → Performance preset gives the
    default engine written in: its step count and whether its output is
    postprocessed — the longform preset's (32 steps, postprocessing on) when
    none is chosen.

    A render resolves this once per chapter and hands the result to the synth,
    the cache keys and a remote worker alike, so each preset keys its own
    audio — the keys used to hash only the request, so a chapter rendered at
    64 steps replayed at 16 — and a worker renders what this machine would.
    Both values are written at every preset, Quality's included: a key without
    them is the one builds before this wrote at any preset, which the legacy
    lookup still adopts once, so audio this build renders must never be keyed
    that way or it would pass for every other preset's. An explicit request
    value always wins. Other engines take no preset, so their options are
    returned as they are."""
    from services.performance_profiles import tts_defaults
    from services.tts_backend import active_backend_id

    if not _tiered_engine(engine_id or active_backend_id()):
        return opts
    defaults = tts_defaults()
    preset: dict = {}
    if opts.num_step is None:
        preset["num_step"] = int(defaults.get("num_step", LONGFORM_NUM_STEP))
    if opts.postprocess_output is None:
        # Not sent at all means the model's own default: on.
        preset["postprocess_output"] = defaults.get("postprocess_output") is not False
    return dataclasses.replace(opts, **preset) if preset else opts


@router.get("/audiobook/sampling")
def audiobook_sampling() -> dict:
    """The sampling a long-form render of the active engine uses for every
    control a request leaves unset — the longform preset with the Settings →
    Performance preset written in (:func:`_preset_opts`) — so the app shows
    the steps a render will actually take. ``None``: the engine keeps its own
    defaults (one without the default engine's controls)."""
    from services.tts_backend import active_backend_id

    engine_id = active_backend_id()
    if not _tiered_engine(engine_id):
        return {"engine": engine_id, "num_step": None, "guidance_scale": None,
                "postprocess_output": None}
    kw = _omnivoice_sampling_kwargs(_preset_opts(ExpressiveOptions(), engine_id))
    return {"engine": engine_id, "num_step": kw["num_step"],
            "guidance_scale": kw["guidance_scale"],
            "postprocess_output": kw["postprocess_output"]}


def _generic_extra_kwargs(opts: ExpressiveOptions) -> dict:
    """Extra generate kwargs for a non-VoiceStudio engine. UNSET → empty dict →
    byte-identical to the pre-#1208 generic call. Only present knobs are added,
    and every shipped backend's ``generate(self, text, **kw)`` ignores the ones
    it doesn't understand (never TypeError) — the engine-options contract. The
    emotion trio reaches IndexTTS2's arbitration; other engines drop it."""
    kw: dict = {}
    if opts.num_step is not None:
        kw["num_step"] = opts.num_step
    if opts.guidance_scale is not None:
        kw["guidance_scale"] = opts.guidance_scale
    if opts.position_temperature is not None:
        kw["position_temperature"] = opts.position_temperature
    if opts.class_temperature is not None:
        kw["class_temperature"] = opts.class_temperature
    if opts.postprocess_output is not None:
        kw["postprocess_output"] = opts.postprocess_output
    if opts.emo_vector:
        kw["emo_vector"] = list(opts.emo_vector)
    if opts.emo_text:
        kw["emo_text"] = opts.emo_text
        kw["use_emo_text"] = True
    if opts.emo_alpha is not None:
        kw["emo_alpha"] = opts.emo_alpha
    return kw


def _voice_resolver(default_voice: str | None, voice_map: dict | None = None,
                    lease: "voice_leases.VoiceFileLease | None" = None):
    """``resolve(voice_id)`` → the profile refs a span's voice token reads,
    cached per token and per profile; ``lease`` holds each reference file."""
    cache: dict = {}
    token_cache: dict = {}

    def resolve(voice_id):
        # Translate the span token ([voice:NAME] / exact id / None) to a profile
        # id first (#1217) — the cast fix lives here, not in the parser, so the
        # parser stays a pure text→plan and exact ids keep working. Cache the
        # translation so a book of hundreds of same-name spans does one DB check.
        if voice_id not in token_cache:
            token_cache[voice_id] = _map_span_voice(voice_id, default_voice, voice_map)
        key = token_cache[voice_id]
        if key not in cache:
            cache[key] = _resolve_voice(key)
            voice_leases.hold(lease, cache[key].get("ref_audio"))
        return cache[key]

    return resolve


def _omnivoice_sample_rate(model) -> int:
    """The rate VoiceStudio-model chapters render (and are cached) at."""
    return getattr(model, "sampling_rate", 24000)


def _build_synth(
    default_voice: str | None,
    language: str | None = None,
    opts: ExpressiveOptions | None = None,
    voice_map: dict | None = None,
    lease: "voice_leases.VoiceFileLease | None" = None,
) -> dict:
    """Describe how to synthesize for the active TTS engine.

    Returns a dict with ``mode``, ``resolve`` (voice-id → resolved refs, cached
    per id) and ``engine_id``. For VoiceStudio it also carries the async
    ``get_model``; other engines carry a ready ``synth`` + ``sample_rate``.
    :func:`_prepare_synth` turns this into a uniform ``(synth, sr, resolve,
    engine_id)`` once the (async) model is in hand.

    ``language`` (already resolved by :func:`_resolve_default_language`) is
    threaded into every chunk's ``generate`` so a non-English clone stays in its
    language instead of re-autodetecting per chunk (#505 B2). ``None`` keeps the
    engine's autodetect behavior unchanged.

    ``opts`` (#1208) carries the expressive/quality knobs + cache opt-out. A
    default instance reproduces today's exact synth call and caching.

    ``lease`` (#2535) holds every resolved reference file for the render, so
    the retired-voice sweep never removes a take this job still reads.
    """
    from services.tts_backend import OmniVoiceBackend, active_backend_id, get_backend_class

    opts = opts or ExpressiveOptions()
    resolve = _voice_resolver(default_voice, voice_map, lease)
    engine_id = active_backend_id()
    cls = get_backend_class(engine_id)
    if cls is OmniVoiceBackend:
        from services.model_manager import get_model
        return {"mode": "omnivoice", "resolve": resolve, "engine_id": engine_id,
                "get_model": get_model, "language": language, "opts": opts}

    backend = cls()
    native_proxy = bool(getattr(cls, "supports_native_omnivoice_controls", False))
    extra = (_omnivoice_sampling_kwargs(opts) if native_proxy
             else _generic_extra_kwargs(opts))
    next_nonce = _make_occ_counter(opts)

    def synth(text, voice_id, speed=None, attempt=0, occurrence=None, retake=""):
        v = resolve(voice_id)
        seed = _seed_segment_rng(_base_seed(opts, v), *_retake_seed_input(
            text, attempt, next_nonce, occurrence=occurrence, retake=retake,
            vary=opts.vary_repeats))
        call_extra = dict(extra)
        if native_proxy and seed is not None:
            call_extra["seed"] = seed
        return backend.generate(
            text, language=language, ref_audio=v["ref_audio"],
            ref_text=v["ref_text"], instruct=v["instruct"], duration=None,
            speed=float(speed) if speed else 1.0, **call_extra,
        )
    return {"mode": "generic", "resolve": resolve, "engine_id": engine_id,
            "synth": synth, "sample_rate": backend.sample_rate}


async def _prepare_synth(
    default_voice: str | None,
    language: str | None = None,
    opts: ExpressiveOptions | None = None,
    voice_map: dict | None = None,
    lease: "voice_leases.VoiceFileLease | None" = None,
):
    """Resolve :func:`_build_synth` into ``(synth, sample_rate, resolve,
    engine_id)`` — awaiting the VoiceStudio model load when needed. Shared by the
    full job and the per-chapter preview. ``language`` is threaded into every
    chunk so a non-English clone holds its language (#505 B2). ``opts`` (#1208)
    carries the expressive knobs; a default instance reproduces today exactly."""
    opts = opts or ExpressiveOptions()
    info = _build_synth(default_voice, language=language, opts=opts, voice_map=voice_map,
                        lease=lease)
    resolve, engine_id = info["resolve"], info["engine_id"]
    if info["mode"] == "omnivoice":
        lang = info["language"]
        model = await info["get_model"]()
        sr = _omnivoice_sample_rate(model)

        from services.tts_backend import generate_with_cached_ref

        sampling = _omnivoice_sampling_kwargs(opts)
        next_nonce = _make_occ_counter(opts)

        def synth(text, voice_id, speed=None, attempt=0, occurrence=None, retake=""):
            v = resolve(voice_id)
            _seed_segment_rng(_base_seed(opts, v), *_retake_seed_input(
                text, attempt, next_nonce, occurrence=occurrence, retake=retake,
                vary=opts.vary_repeats))
            # A book is the worst case for the re-encode this avoids: hundreds of
            # segments, one voice. The reference is encoded on the first segment
            # and reused for every one after it.
            return generate_with_cached_ref(
                model, ref_audio=v["ref_audio"], ref_text=v["ref_text"],
                text=text, language=lang, instruct=v["instruct"], duration=None,
                speed=float(speed) if speed else 1.0, **sampling,
            )[0]
        return synth, sr, resolve, engine_id
    return info["synth"], info["sample_rate"], resolve, engine_id


@dataclasses.dataclass
class _ChapterKeys:
    """What one chapter's cache is keyed by (see :func:`_chapter_cache_keys`)."""

    #: The chapter's spans as synthesis reads them (normalized text).
    spans: list
    voice_sigs: dict
    legacy_voice_sigs: list
    #: The segment layer's extra signature, and the one builds before
    #: per-voice keys derived for the same request.
    seg_extra_sig: str
    legacy_seg_extra_sig: str
    #: What keys a phrase take besides its voice, text and speed
    #: (:func:`_take_signature`).
    take_sig: str
    #: The voice each span is leveled under.
    voice_names: list
    #: The chapter WAV under the current key, then under every legacy one.
    wav_path: str
    legacy_paths: list
    content_id: str
    inputs: dict
    #: The chapter's title as a retake is kept with it (``None``: untitled).
    title: str | None = None
    #: Its phrase takes by span, when a retake was asked for in the cache or
    #: the chapter is a passage read in its chapter (:func:`_phrase_plan`);
    #: ``None`` otherwise — then they are planned as they are cut.
    takes: list | None = None

    @property
    def names(self) -> list:
        """Every name this chapter's audio may be cached under (the current
        key first) — what a book's timeline recorded it as."""
        return [_cache_name(path) for path in dict.fromkeys((self.wav_path, *self.legacy_paths))]


#: Voices a chapter event reports leveling for, at most.
_MAX_LEVEL_VOICES = 200


def _chapter_levels(timing) -> dict:
    """What voice leveling measured in one chapter, from its timing document
    (``services.audiobook.chapter_timing_doc``): voice name → ``{"level_db",
    "auto_db"}``, rounded to 0.1 dB. Only well-formed entries — the document
    may come from a remote worker — and ``{}`` when leveling was off or the
    chapter was cached before this was kept."""
    import math

    raw = timing.get("levels") if isinstance(timing, dict) else None
    if not isinstance(raw, dict):
        return {}
    levels = {}
    for name, entry in list(raw.items())[:_MAX_LEVEL_VOICES]:
        if not isinstance(name, str) or len(name) > 200 or not isinstance(entry, dict):
            continue
        values = [entry.get("level_db"), entry.get("auto_db")]
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
               for v in values):
            levels[name] = {"level_db": round(float(values[0]), 1),
                            "auto_db": round(float(values[1]), 1)}
    return levels


def _chapter_speech_check(timing) -> dict | None:
    """What the speech check found in one chapter, from its timing document
    (``services.audiobook.chapter_timing_doc``), checked on the way in;
    ``None`` when the check did not run there — a remote worker never runs
    it — or the chapter was cached before results were kept."""
    from services.longform_render import valid_speech_check

    return valid_speech_check(timing.get("speech_check")) if isinstance(timing, dict) else None


def _language_input_marker(engine_id, language) -> str:
    """``language_codes.LANGUAGE_INPUT_RENDER`` (as text) when ``engine_id``
    receives ``language`` otherwise than older audio was rendered with, else
    ``""``: only those keys move, every other stays byte-identical."""
    from services.language_codes import LANGUAGE_INPUT_RENDER, language_input_changed

    return str(LANGUAGE_INPUT_RENDER) if language_input_changed(engine_id, language) else ""


def _voice_signature(voice: dict) -> str:
    """A resolved voice as the cache keys name it: its reference audio by its
    path inside the data dir (#2279), its transcript, instruct and seed."""
    return (f"{_portable_ref_audio(voice.get('ref_audio'))}|{voice.get('ref_text')}"
            f"|{voice.get('instruct')}|{voice.get('seed')}")


def _take_signature(opts: ExpressiveOptions, language, language_input: str) -> str:
    """What keys one phrase take besides its voice, text and speed: the
    take-level options the engine receives (``ExpressiveOptions.
    take_level_signature``) and the language it is told — never what only
    cuts, checks or joins takes, nor the lexicon, which reaches a take
    through its text."""
    return json.dumps({"options": opts.take_level_signature(), "language": language or None,
                       "language input": language_input or None},
                      sort_keys=True, ensure_ascii=False)


def _split_kwargs(opts: ExpressiveOptions) -> dict:
    """How ``opts`` cut a span's text into takes (``services.audiobook.
    chapter_units``)."""
    return {"paragraph_gap_ms": opts.paragraph_gap_ms,
            "punctuation_pauses": (dict(opts.punctuation_pauses)
                                   if opts.punctuation_pauses is not None else None),
            "split_commas": opts.split_commas}


@dataclasses.dataclass(frozen=True)
class _ReadIn:
    """Where a passage preview is read in its book (``PassageContext``): the
    chapter it is part of, as the script parses it, and that chapter's
    spans before the passage."""

    chapter: object
    lead: list


def _chapter_title(chapter) -> str | None:
    """A chapter's title as a retake is kept with it: ``None`` when the
    script left it untitled (its title is then only its place)."""
    return None if getattr(chapter, "untitled", False) else (chapter.title or None)


def _spoken_span(span, language):
    """``span`` as synthesis reads it: its text normalized for ``language``."""
    from services.audiobook import Span
    from services.text_normalization import normalize_for_tts

    return Span(voice_id=span.voice_id, text=normalize_for_tts(span.text, language),
                pause_ms_after=span.pause_ms_after, speed=getattr(span, "speed", None),
                join=getattr(span, "join", None), gain_db=getattr(span, "gain_db", None))


def _phrase_plan(spans, voice_sigs: dict, *, resolve, language, lexicon, opts: ExpressiveOptions,
                 take_sig: str, cache_dir: str, title: str | None,
                 read_in: _ReadIn | None = None) -> tuple[list | None, list | None]:
    """``(takes, alone)`` of a chapter whose spans read ``spans`` (normalized
    text), read sentence by sentence: its phrase takes by span with the
    retakes asked for placed on them (``longform_render.chapter_takes``) —
    and, for a passage read in its chapter (``read_in``), named as that
    chapter names them (``longform_render.passage_takes``), with ``alone``
    the passage's takes planned on their own. ``(None, None)`` when neither
    applies: the takes are then planned as they are cut."""
    from services.audiobook import chapter_units
    from services.longform_render import chapter_takes, load_retakes, passage_takes

    if opts.punctuation_pauses is None:
        return None, None
    retakes = load_retakes(cache_dir)
    if not retakes and read_in is None:
        return None, None
    split = _split_kwargs(opts)
    sigs = dict(voice_sigs)

    def plan(chapter_spans, records=None, name=None):
        return chapter_takes(chapter_spans, chapter_units(chapter_spans, lexicon=lexicon, **split),
                             voice_sig=sigs, take_sig=take_sig, retakes=records, title=name)

    if read_in is None:
        return plan(spans, retakes, title), None
    around = [_spoken_span(span, language) for span in read_in.chapter.spans]
    lead = [_spoken_span(span, language) for span in read_in.lead]
    for span in (*around, *lead):
        if (span.voice_id or "") not in sigs:
            sigs[span.voice_id or ""] = _voice_signature(resolve(span.voice_id))
    before = sum(len(texts) for units in chapter_units(lead, lexicon=lexicon, **split)
                 for texts, _gaps in units)
    alone = plan(spans)
    return (passage_takes(alone, plan(around, retakes, _chapter_title(read_in.chapter)), before),
            alone)


def _takes_fragment(takes: list | None, alone: list | None) -> str:
    """What a chapter's phrase takes (:func:`_phrase_plan`) add to its cache
    key: each take read otherwise than its text alone says — a retake asked
    for (the take and the retake's salt) or, in a passage read in its
    chapter, a take that chapter names otherwise — as JSON. ``""`` without
    one, so every other chapter keeps its key."""
    if takes is None:
        return ""
    own = [ref for refs in alone for ref in refs] if alone is not None else None
    changed = [[ref.identity, ref.salt]
               for j, ref in enumerate(ref for refs in takes for ref in refs)
               if ref.salt or (own is not None and ref.identity != own[j].identity)]
    return json.dumps(changed) if changed else ""


def _span_key_tuple(span) -> tuple:
    """``(voice_id, text, pause_ms_after, speed[, join[, gain_db]])`` — what
    :func:`services.longform_render.chapter_cache_key` hashes of one span. A
    ``[volume]`` gain (the 6th element, behind ``join`` or a ``None`` in its
    place) and ``join`` are appended only when set: every span without them
    keeps its pre-existing key."""
    key = (span.voice_id, span.text, span.pause_ms_after, getattr(span, "speed", None))
    gain = getattr(span, "gain_db", None)
    if gain:
        return key + (span.join, gain)
    return key + ((span.join,) if span.join else ())


def _chapter_cache_keys(chapter, sr, engine_id, resolve, cache_dir, *, lexicon=None,
                        language=None, opts=None, voice_map=None,
                        default_voice=None, request_opts=None,
                        read_in: _ReadIn | None = None) -> _ChapterKeys:
    """Derive where a chapter's rendered audio is cached — the single
    derivation the render (:func:`_render_chapter_cached`) and the outline's
    status (:func:`_chapter_cache_state`) both read, so the two can never
    disagree about whether a chapter is rendered. Renders nothing; ``resolve``
    reads voice profiles only.

    ``opts`` are the options the engine receives (:func:`_preset_opts`);
    ``request_opts`` the request's own, before the preset was written in
    (default: ``opts``). Builds before this keyed both layers with the
    request's options, the whole cast map and — for a take — the gap between
    lines; that derivation is kept as the legacy key family, so their cached
    audio is still found (and moved to the current key) instead of rendering
    again. ``read_in`` places a passage preview in its chapter
    (:func:`_phrase_plan`): its takes are then that chapter's own, and its
    key says so where they differ from the passage's own."""
    import json

    from services.audiobook import ExpressiveOptions, voice_map_signature
    from services.longform_render import (
        chapter_cache_key,
        chapter_content_id,
        remember_voices_root,
    )
    from core.config import VOICES_DIR
    from services.pronunciation import normalize_lexicon
    from services.watermark import will_mark

    opts = opts or ExpressiveOptions()
    request_opts = request_opts or opts

    spans = [_spoken_span(s, language) for s in chapter.spans]
    # `join` and a [volume] gain enter the tuple only when set, so a plan
    # without inline-markup splits keeps its pre-existing chapter cache key.
    spans_tuples = [_span_key_tuple(s) for s in spans]
    # A voice's signature names its reference audio by its path INSIDE the
    # data dir, not the absolute path (#2279): the same profile must key the
    # same cache after the data dir is moved, remounted or spelled differently
    # (Settings → storage relocation, a symlink, an env override). Caches keyed
    # by the absolute path — every one written before this — are still found
    # through the legacy signatures below — one per voices root this cache has
    # been rendered under, so a move right after upgrading still finds them —
    # and moved to the portable key.
    old_roots = remember_voices_root(cache_dir, VOICES_DIR)
    voice_sigs: dict = {}
    legacy_voice_sigs: list[dict] = [{} for _ in range(1 + len(old_roots))]
    resolved: dict = {}
    for s in spans:
        k = s.voice_id or ""
        if k not in voice_sigs:
            v = resolved[k] = resolve(s.voice_id)
            tail = f"{v.get('ref_text')}|{v.get('instruct')}|{v.get('seed')}"
            voice_sigs[k] = _voice_signature(v)
            for sigs, ref in zip(legacy_voice_sigs,
                                 _legacy_ref_audios(v.get("ref_audio"), old_roots)):
                sigs[k] = f"{ref}|{tail}"
    sig: dict = {}
    lex_sig = ""
    if lexicon:
        # Fold the lexicon into the cache key so editing pronunciations
        # invalidates cached chapters (reserved key can't collide with a voice id).
        lex_sig = json.dumps(normalize_lexicon(lexicon), sort_keys=True)
        sig["\x00lexicon"] = lex_sig
    # The voice each span is leveled under follows the default voice as well
    # as the cast (a Stories line read by the default voice's profile shares
    # its volume), so with leveling on it keys the chapter too.
    voice_names = [span_voice_name(s.voice_id, default_voice, voice_map) for s in spans]
    leveled_sig = ""
    if opts.level_voices or opts.voice_gains:
        leveled_sig = json.dumps(dict(zip((s.voice_id or "" for s in spans), voice_names)),
                                 sort_keys=True, ensure_ascii=False)
        sig["\x00leveled voices"] = leveled_sig
    # The resolved synthesis language reaches every engine call, and
    # normalization can leave two languages' text identical, so it must key
    # BOTH layers or a French render replays the English audio (#2524). Genuine
    # autodetect (None) adds nothing: its keys stay byte-identical.
    lang_sig = f"\x00language={language}" if language else ""
    if language:
        sig["\x00language"] = language
    language_input = _language_input_marker(engine_id, language)
    if language_input:
        # The engine now receives this language otherwise than when older
        # audio was rendered for it (OmniVoice read "Arabic" as Auto): that
        # audio is not replayed, under the current or any legacy key.
        sig["\x00language input"] = language_input
        lang_sig += f"\x00language input={language_input}"
    marking = will_mark()
    if marking:
        # Provenance-marked chapters cache under their own key (#1169): a
        # chapter WAV rendered while watermarking was off/unavailable —
        # including every cache entry written before marking existed — must
        # never satisfy a request made while it's on. Deliberately one-time
        # invalidates pre-#1169 chapter caches (the SEGMENT cache underneath
        # is untouched, so re-rendering is assembly + one embed, not re-TTS);
        # with marking off the key is byte-identical to the released
        # derivation, so those caches keep hitting.
        sig["\x00watermark"] = "1"
    # A phrase take is keyed by the options the engine receives and the
    # language alone (the lexicon reaches it through its text). A retake the
    # user asked for renders that take again, and a passage read in its
    # chapter reads that chapter's takes, so either moves the chapter's key —
    # only where it applies.
    take_sig = _take_signature(opts, language, language_input)
    title = _chapter_title(chapter)
    takes, alone = _phrase_plan(spans, voice_sigs, resolve=resolve, language=language,
                                lexicon=lexicon, opts=opts, take_sig=take_sig,
                                cache_dir=cache_dir, title=title, read_in=read_in)
    retakes = _takes_fragment(takes, alone)
    if retakes:
        sig["\x00retakes"] = retakes

    def chapter_sig(expressive: str, cast: str = "") -> dict:
        extra = {"\x00expressive": expressive} if expressive else {}
        if cast:
            extra["\x00voicemap"] = cast
        return {**sig, **extra}

    def seg_sig(take: str, cast: str = "") -> str:
        out = f"{lex_sig}\x00{take}" if take else lex_sig
        return (f"{out}\x00{cast}" if cast else out) + lang_sig

    # Fold the #1208 expressive signature into BOTH cache layers so changing any
    # knob (sampling, emotion, seed, cache opt-out) re-renders instead of
    # replaying stale audio (the CRITICAL TRAP). Empty for a default render, so
    # the derivation stays byte-identical to pre-#1208 and released caches hit.
    # It hashes the options the engine receives: a performance preset's step
    # count keys its own audio. A take never depends on voice leveling or the
    # gap between lines, so the segment layer keys the options without them.
    expr_sig = opts.cache_signature()
    seg_extra_sig = seg_sig(opts.take_signature())
    # Each span is keyed by the voice it resolves to (``voice_sigs``), never by
    # the whole cast map (#1217 used to fold it into both layers): recasting
    # one name re-renders that voice's lines, and the chapters it is not in
    # keep their keys.
    vmap_sig = voice_map_signature(voice_map)
    key = chapter_cache_key(spans_tuples, sample_rate=sr, engine_id=engine_id,
                            voice_sig={**voice_sigs, **chapter_sig(expr_sig)})
    wav_path = os.path.join(cache_dir, f"{key}.wav")
    # Audio builds before per-voice keys rendered: keyed with the request's
    # own options (no preset written in), the cast map, and the gap between
    # lines in a take — under the portable reference path or, older still,
    # the absolute one under any voices root the cache was rendered under.
    legacy_sig = chapter_sig(request_opts.cache_signature(), vmap_sig)
    legacy_seg_extra_sig = seg_sig(request_opts.legacy_take_signature(), vmap_sig)
    legacy_paths = [
        os.path.join(cache_dir, chapter_cache_key(
            spans_tuples, sample_rate=sr, engine_id=engine_id,
            voice_sig={**sigs, **legacy_sig}) + ".wav")
        for sigs in (voice_sigs, *legacy_voice_sigs)
    ]
    legacy_paths = [path for path in dict.fromkeys(legacy_paths) if path != wav_path]
    cast = {token: voice_map[token] for token in voice_sigs if voice_map and token in voice_map}

    # What a miss is explained against (#2279): every input the key folds in,
    # by name, so the log says WHICH one changed instead of only "cached:
    # false". Keyed by the chapter's raw script, which no render input moves.
    content_id = chapter_content_id(
        [(s.voice_id, s.text, s.pause_ms_after, getattr(s, "speed", None),
          getattr(s, "join", None))
         + ((s.gain_db,) if getattr(s, "gain_db", None) else ()) for s in chapter.spans])
    inputs: dict = {
        "sample rate": sr, "engine": engine_id, "normalized text": spans_tuples,
        "pronunciation lexicon": lex_sig, "expressive settings": expr_sig,
        # The casting of this chapter's own voices: what of the map it reads.
        "voice map": voice_map_signature(cast), "watermark": marking,
    }
    if language:
        inputs["language"] = language
    if language_input:
        inputs["language input"] = language_input
    if leveled_sig:
        inputs["leveled voices"] = leveled_sig
    if retakes:
        inputs["retakes"] = retakes
    for k, v in resolved.items():
        label = f"voice {re.sub(r'[^A-Za-z0-9_-]', '', k)[:40] or '(default)'}"
        inputs[f"{label} reference audio"] = _portable_ref_audio(v.get("ref_audio"))
        inputs[f"{label} reference text"] = v.get("ref_text")
        inputs[f"{label} instruct"] = v.get("instruct")
        inputs[f"{label} seed"] = v.get("seed")
    return _ChapterKeys(spans=spans, voice_sigs=voice_sigs, legacy_voice_sigs=legacy_voice_sigs,
                        seg_extra_sig=seg_extra_sig, legacy_seg_extra_sig=legacy_seg_extra_sig,
                        take_sig=take_sig, voice_names=voice_names, wav_path=wav_path,
                        legacy_paths=legacy_paths, content_id=content_id, inputs=inputs,
                        title=title, takes=takes)


def _render_chapter_cached(chapter, synth, sr, engine_id, resolve, cache_dir, lexicon=None,
                           language=None, opts=None, voice_map=None, default_voice=None,
                           request_opts=None, read_in: _ReadIn | None = None):
    """Render one chapter, content-addressed so a re-run reuses it (resume).

    Returns ``(wav_path, duration_s, was_cached, seg_stats)``. Two cache
    layers:

    * Outer — the WAV at ``cache_dir/<key>.wav`` where ``key`` is
      :func:`chapter_cache_key` over the chapter's spans + sample rate +
      engine + each voice's resolved signature (+ the lexicon, so a lexicon
      edit re-renders). A fully-unchanged chapter hits here and never touches
      segment files. With invisible watermarking active the key also carries a
      watermark tag (#1169) — pre-#1169 chapter caches (unmarked audio)
      deliberately miss once and re-render marked; with watermarking off the
      derivation is unchanged and released-version caches keep hitting.
      ``seg_stats`` is ``None``.
    * Inner — on a chapter miss, each spoken span goes through the
      :class:`services.longform_render.SegmentCache` under
      ``cache_dir/segments``: cached segments load from disk, only the
      edited/missing ones synthesize, and each fresh segment persists the
      moment it renders (an interrupted chapter resumes from them).
      ``seg_stats`` is ``{"total": spoken_spans, "cached": reused}``.
    * Takes — with phrase-by-phrase reading, a span not cached whole is
      assembled from its phrase takes, each cached on its own under
      ``cache_dir/takes`` (:class:`services.longform_render.TakeCache`) the
      moment it finishes: an edit renders only the takes whose spoken text
      changed, an assembly-level change (pauses, trimming, gaps, leveling,
      volume) renders none, and such a span is not stored whole as well.
      ``seg_stats`` then counts takes: ``{"total": takes, "cached":
      reused}``. A passage preview read in its chapter (``read_in``) reads
      that chapter's takes (:func:`_phrase_plan`).

    Every segment and take the chapter may read is held from eviction while
    it renders (:class:`services.longform_render.CacheHold`), so another
    render's pruning cannot drop the takes this one is about to reuse.

    Span text is normalized (``services.text_normalization``) up front — BEFORE
    either cache key and BEFORE ``synthesize_chapter``'s lexicon pass, so the
    per-project dictionary operates on normalized text and toggling / changing
    normalization output naturally invalidates cached chapters and segments.

    Voice leveling (``opts.level_voices`` / ``opts.voice_gains``) keys only the
    outer layer: it re-balances finished takes, so the segments stay as
    rendered and a leveling change re-assembles the chapter from them.
    ``default_voice`` tells which spans the default voice reads for it.

    With the speech check on, what it found is kept with the chapter's timing
    and each segment's or take's, so a cached chapter still reports it; a
    cached chapter with takes the check could not listen to is checked once a
    recognizer answers (see :func:`services.audiobook.synthesize_chapter`) —
    a phrase take by listening to it, rendering it again only if it fails.
    ``opts`` / ``request_opts``: see :func:`_chapter_cache_keys`.

    Runs in the GPU-pool executor.
    """
    from services.audio_io import atomic_save_wav
    from services.audiobook import ExpressiveOptions, speech_check_answers
    from services.longform_render import (
        SegmentCache,
        TakeCache,
        explain_chapter_miss,
        record_chapter_inputs,
        remove_timeline_sidecar,
        write_chapter_timeline,
    )
    from services.watermark import mark_synthetic

    opts = opts or ExpressiveOptions()
    keys = _chapter_cache_keys(chapter, sr, engine_id, resolve, cache_dir, lexicon=lexicon,
                               language=language, opts=opts, voice_map=voice_map,
                               default_voice=default_voice, request_opts=request_opts,
                               read_in=read_in)
    spans, voice_sigs, voice_names = keys.spans, keys.voice_sigs, keys.voice_names
    wav_path, content_id, inputs = keys.wav_path, keys.content_id, keys.inputs

    verifier = None
    if opts.verify_speech:
        from services.speech_verify import SpeechVerifier

        # Told the chapter's language; the render's lease keeps its
        # recognizer loaded from one chapter to the next.
        verifier = SpeechVerifier(sr, language=language)
    recognizer = None
    found = _chapter_cache_lookup(keys, sr)
    if found is not None:
        candidate, dur = found
        if verifier is None or not _unchecked_takes(candidate):
            return _use_cached_chapter(keys, candidate, cache_dir), dur, True, None
        # Rendered while no recognizer answered: reused as it is until one
        # does, then its unchecked takes are checked (and only those render).
        recognizer = speech_check_answers(verifier, _wav_head(candidate), sr)
        if not recognizer:
            return _use_cached_chapter(keys, candidate, cache_dir), dur, True, None
        logger.info("Chapter %r has takes the speech check could not listen to "
                    "when it rendered; checking them now", str(chapter.title)[:80])
    else:
        changed = explain_chapter_miss(cache_dir, content_id, inputs)
        if changed:
            logger.info("Chapter cache miss for %r: changed since its cached render: %s",
                        str(chapter.title)[:80], ", ".join(changed))
        elif changed == []:
            logger.info("Chapter cache miss for %r: inputs unchanged, but the cached "
                        "audio file is gone (evicted or deleted)", str(chapter.title)[:80])

    seg_cache = SegmentCache(cache_dir, sample_rate=sr, engine_id=engine_id,
                             voice_sig=voice_sigs, extra_sig=keys.seg_extra_sig,
                             vary_repeats=opts.vary_repeats,
                             legacy_voice_sigs=keys.legacy_voice_sigs,
                             legacy_extra_sig=keys.legacy_seg_extra_sig)
    take_cache = (TakeCache(cache_dir, sample_rate=sr, engine_id=engine_id,
                            voice_sig=voice_sigs, take_sig=keys.take_sig)
                  if opts.punctuation_pauses is not None else None)
    takes = (_chapter_take_plan(keys, opts=opts, lexicon=lexicon)
             if take_cache is not None else None)
    timing: list = []
    with CacheHold() as hold:
        _hold_chapter_audio(hold, keys, seg_cache, take_cache, takes,
                            attempts=getattr(verifier, "retries", 0))
        if read_in is not None and take_cache is not None:
            # The chapter around the passage, keyed as a render of it would be.
            around = _chapter_cache_keys(read_in.chapter, sr, engine_id, resolve, cache_dir,
                                         lexicon=lexicon, language=language, opts=opts,
                                         voice_map=voice_map, default_voice=default_voice,
                                         request_opts=request_opts)
            _cut_chapter_around(takes, around, take_cache, hold, cache_dir=cache_dir, opts=opts,
                                lexicon=lexicon, checking=verifier is not None)
        audio, dur = synthesize_chapter(spans, synth, sr, lexicon=lexicon,
                                        segment_cache=seg_cache, verifier=verifier,
                                        voice_names=voice_names, timing=timing,
                                        recognizer=recognizer, take_cache=take_cache,
                                        takes=takes, **opts.join_kwargs())
    # Invisible provenance mark on the assembled chapter (#1169), tensor stage,
    # before the WAV lands in the cache — this single site covers every
    # longform front door (/audiobook, /longform/render [Stories],
    # /audiobook/preview, /audiobook/resume/{id}): the m4b/mp3 mux only
    # concatenates these WAVs, and AudioSeal survives the lossy encode.
    # Segments in the segment cache stay unmarked by design — they're
    # intermediate assembly inputs, re-marked here on every chapter render.
    # Already runs in the GPU-pool executor; never raises (degrades to
    # unmarked on failure).
    audio = trace_call("watermark", mark_synthetic, audio, sr, context="longform.chapter")
    # Durable: a power-off right after this chapter must not leave a torn
    # file under its key (#2279). Its timing sidecar follows the audio, and an
    # older one under this key goes first, so it never describes other audio.
    remove_timeline_sidecar(wav_path)
    atomic_save_wav(wav_path, audio, sr, durable=True)
    write_chapter_timeline(wav_path, timing[0] if timing else None)
    record_chapter_inputs(cache_dir, content_id, inputs)
    counted = take_cache if take_cache is not None else seg_cache
    stats = {"total": counted.hits + counted.misses, "cached": counted.hits}
    if verifier is not None:
        # The chapter's whole result, spans reused from the cache included.
        stats["speech_check"] = (timing[0].get("speech_check") if timing else None) or verifier.stats()
    return wav_path, dur, False, stats


def _hold_chapter_audio(hold, keys: _ChapterKeys, segments, store, takes: list | None, *,
                        attempts: int = 0) -> None:
    """Hold every file a chapter render may read (``hold``, a ``CacheHold``):
    each spoken span's segment, under its current key and every legacy one,
    and each planned take with the retakes the speech check may have chosen
    of it (up to ``attempts``). Held up front, before the render reads the
    first: another render's pruning walks past them, so a take this one has
    yet to reach — likely the oldest file in the cache — is never evicted and
    rendered again (with an unpinned voice, read differently)."""
    seen: dict = {}
    for span in keys.spans:
        if not span.text:
            continue
        # The occurrence synthesis keys a repeated span's segment by.
        repeat = (span.voice_id, span.text, getattr(span, "speed", None))
        occurrence = seen.get(repeat, 0)
        seen[repeat] = occurrence + 1
        for path in segments.paths(span, occurrence):
            hold.add(path)
    for refs in takes or []:
        for ref in refs:
            for attempt in range(attempts + 1):
                hold.add(store.path(ref, attempt))


def _cut_chapter_around(takes: list, around: _ChapterKeys, store, hold, *, cache_dir: str, opts,
                        lexicon, checking: bool) -> None:
    """A passage read in its chapter reads that chapter's takes (``takes``,
    by span): where a span of the chapter ``around`` holding takes it has not
    cached is cached whole — rendered before takes were kept — that span is
    cut into its takes first (``services.audiobook.cut_cached_span``), so the
    passage plays the audio the book holds and renders only what it does not
    (a retaken take). Each segment read is held (``hold``) like the
    passage's own."""
    from services.audiobook import cut_cached_span
    from services.longform_render import SegmentCache

    missing = {store.path(ref) for refs in takes for ref in refs if not store.has(ref)}
    if not missing:
        return
    segments = SegmentCache(cache_dir, sample_rate=store.sample_rate, engine_id=store.engine_id,
                            voice_sig=around.voice_sigs, extra_sig=around.seg_extra_sig,
                            vary_repeats=opts.vary_repeats,
                            legacy_voice_sigs=around.legacy_voice_sigs,
                            legacy_extra_sig=around.legacy_seg_extra_sig)
    seen: dict = {}
    for span, refs in zip(around.spans, _chapter_take_plan(around, opts=opts, lexicon=lexicon)):
        if not span.text:
            continue
        # The occurrence synthesis keys a repeated span's segment by.
        repeat = (span.voice_id, span.text, getattr(span, "speed", None))
        occurrence = seen.get(repeat, 0)
        seen[repeat] = occurrence + 1
        if not any(store.path(ref) in missing for ref in refs):
            continue
        for path in segments.paths(span, occurrence):
            hold.add(path)
        audio = segments.load(span, occurrence)
        if audio is not None:
            cut_cached_span(store, segments, span, occurrence, audio, refs, checking=checking)


def _chapter_cache_lookup(keys: _ChapterKeys, sr: int) -> tuple[str, float] | None:
    """The chapter's cached WAV — under its current key, else a legacy one —
    and its length in seconds, or ``None``. Reads headers only; renders and
    moves nothing."""
    import wave

    from services.longform_render import wav_is_complete

    for candidate in dict.fromkeys((keys.wav_path, *keys.legacy_paths)):
        if not os.path.exists(candidate):
            continue
        # A header that promises more audio than the file holds is a write a
        # power-off tore; it opens fine and plays short, so it is a miss.
        if not wav_is_complete(candidate):
            continue
        try:
            with wave.open(candidate, "rb") as w:
                return candidate, w.getnframes() / float(w.getframerate() or sr)
        except Exception:
            continue  # corrupt cache entry — try the next, else re-render
    return None


def _use_cached_chapter(keys: _ChapterKeys, candidate: str, cache_dir: str) -> str:
    """Serve a cached chapter: moved to its current key when found under a
    legacy one, and marked used so eviction keeps what a book reuses
    (chapter hits used to leave the file's age alone, so eviction dropped the
    chapters a book kept reusing first). Returns where it now is."""
    from services.longform_render import (
        adopt_cached_file,
        has_chapter_inputs,
        record_chapter_inputs,
        touch_cached_file,
    )

    if candidate != keys.wav_path:
        candidate = adopt_cached_file(candidate, keys.wav_path)
    touch_cached_file(candidate)
    if not has_chapter_inputs(cache_dir, keys.content_id):
        record_chapter_inputs(cache_dir, keys.content_id, keys.inputs)
    return candidate


def _unchecked_takes(wav_path: str) -> int:
    """How many takes of a cached chapter the speech check could not listen
    to, from the result kept with its timing (0 when none was kept)."""
    from services.longform_render import load_chapter_timeline

    return (_chapter_speech_check(load_chapter_timeline(wav_path)) or {}).get("unchecked", 0)


def _wav_head(path: str, seconds: float = 30.0):
    """The first ``seconds`` of a WAV as a ``(channels, samples)`` tensor, or
    ``None`` — what the speech check's recognizer is asked to listen to."""
    try:
        import soundfile as sf
        import torch

        info = sf.info(path)
        data, _rate = sf.read(path, frames=int(info.samplerate * seconds), dtype="float32",
                              always_2d=True)
        return torch.from_numpy(data.T.copy())
    except Exception:  # noqa: BLE001 — no audio: the recognizer is not asked
        return None


def _worker_takes(takes: list | None, alone: list | None) -> list:
    """``[[span, take, occurrence, salt], …]``: each take a remote worker must
    read otherwise than it plans the chapter it is sent (its spans alone, no
    retakes known) — a retake asked for, or a passage's sentence the chapter
    it is read in repeats — so it seeds the take as this machine would
    (``services.audiobook.take_seed_input``)."""
    told = []
    for row, refs in enumerate(takes or []):
        for k, ref in enumerate(refs):
            own = alone[row][k] if alone is not None else ref
            if ref.salt or ref.occurrence != own.occurrence:
                told.append([row, k, ref.occurrence, ref.salt])
    return told


def _remote_chapter_call(chapter, *, engine_id, default_voice, voice_map,
                         language, lexicon, opts, cache_dir, lease=None,
                         request_opts=None, names: list | None = None,
                         read_in: _ReadIn | None = None):
    """Build one opaque remote chapter task without loading a local TTS model.

    ``opts`` are what the engine receives (:func:`_preset_opts`), so the
    worker renders at this machine's performance preset; ``request_opts``
    the request's own, which keyed remote chapters before that. ``names`` (a
    list the caller owns) receives every name the chapter may be cached under
    (the current key first), as a book's timeline may have recorded it.
    ``read_in``: a passage preview read in its chapter (:func:`_phrase_plan`)."""
    import hashlib

    from services import gpu_gateway
    from services.chunked_tts import PHRASE_SPLIT_REVISION
    from services.text_normalization import normalize_for_tts
    from services.watermark import is_enabled as watermark_enabled

    request_opts = request_opts or opts
    # The worker never runs the speech check (it has no say over this
    # machine's recognizer and no budget for it), so a remote chapter is
    # always an unchecked render: asking for one is what the task says and
    # what its key hashes. Turning the check on or off then reuses the same
    # remote chapter instead of rendering identical audio again under a key
    # that claimed a check.
    opts = dataclasses.replace(opts, verify_speech=False)
    leveling = bool(opts.level_voices or opts.voice_gains)
    rows, voices, refs = [], [], []
    for span in chapter.spans:
        profile_id = _map_span_voice(span.voice_id, default_voice, voice_map)
        voice = _resolve_voice(profile_id)
        voice_leases.hold(lease, voice.get("ref_audio"))
        row = {
            "text": normalize_for_tts(span.text, language),
            "pause_ms_after": span.pause_ms_after,
            "speed": getattr(span, "speed", None),
            "join": getattr(span, "join", None),
        }
        if getattr(span, "gain_db", None):
            # A [volume] passage. Sent only where the script has one, so
            # every other chapter keeps its remote key.
            row["gain_db"] = span.gain_db
        if leveling:
            # The worker knows a span only by its row, so it is told which
            # voice to level it under. Sent only with leveling on, so every
            # other chapter keeps its remote key.
            row["voice"] = span_voice_name(span.voice_id, default_voice, voice_map)
        rows.append(row)
        refs.append(voice.get("ref_audio"))
        voices.append({
            "ref_text": voice.get("ref_text"), "instruct": voice.get("instruct"),
            "seed": voice.get("seed"),
        })
    params = {
        "spans": rows, "voices": voices, "ref_audio": refs,
        "language": language, "lexicon": lexicon,
        "expressive": opts.to_manifest(), "watermark": bool(watermark_enabled()),
    }
    # The worker cuts the phrases, so the splitter's revision keys the result
    # too (it is not part of the manifest the worker receives); so does a
    # language the engine now receives otherwise than older audio was
    # rendered with (see _chapter_cache_keys).
    revisions = ({"phrase_split": PHRASE_SPLIT_REVISION}
                 if opts.punctuation_pauses is not None or opts.split_commas else {})
    language_input = _language_input_marker(engine_id, language)
    if language_input:
        revisions["language_input"] = language_input
    # A worker renders the whole chapter and keeps no takes, so it is told
    # which takes to read otherwise than it plans them: a retake asked for
    # (its salt seeds the take anew) and, for a passage read in its chapter,
    # the occurrence that chapter gives a repeated sentence. Sent only where
    # there is one, so every other chapter keeps its remote key; a worker
    # that cannot read them is refused at registration (audiobook_takes_v1).
    from services.audiobook import Span

    spoken = [Span(voice_id=span.voice_id, text=row["text"], speed=row["speed"])
              for span, row in zip(chapter.spans, rows)]
    sigs: dict = {}
    for span, voice, ref in zip(chapter.spans, voices, refs):
        sigs.setdefault(span.voice_id or "", _voice_signature({**voice, "ref_audio": ref}))
    takes, alone = _phrase_plan(
        spoken, sigs,
        resolve=lambda voice_id: _resolve_voice(_map_span_voice(voice_id, default_voice, voice_map)),
        language=language, lexicon=lexicon, opts=opts,
        take_sig=_take_signature(opts, language, language_input), cache_dir=cache_dir,
        title=_chapter_title(chapter), read_in=read_in)
    told = _worker_takes(takes, alone)
    if told:
        params["takes"] = told

    def _signature(ref_audio: list, expressive: dict | None = None) -> str:
        payload = {**params, **revisions, "ref_audio": ref_audio}
        if expressive is not None:
            payload["expressive"] = expressive
        return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()

    # Keyed by the data-dir-relative reference path, like the local chapter
    # key (#2279); an entry cached under an absolute path — the current voices
    # root or one this cache was rendered under before — is moved over. If the
    # move fails the legacy file is still a valid hit, so it is used in place.
    # Builds before the preset reached the worker keyed a chapter with the
    # request's own options (the speech check as asked); those keys are
    # looked up too, under every spelling of the reference path.
    from services.longform_render import adopt_cached_file, remember_voices_root

    portable = [_portable_ref_audio(r) for r in refs]
    signature = _signature(portable)
    wav_path = os.path.join(cache_dir, f"remote-{signature}.wav")
    current = wav_path
    if names is not None or not os.path.exists(wav_path):
        legacy = request_opts.to_manifest()
        old_roots = remember_voices_root(cache_dir, _voices_dir())
        spellings = [_legacy_ref_audios(r, old_roots) for r in refs]
        legacy_paths = list(dict.fromkeys(
            os.path.join(cache_dir, f"remote-{_signature(list(spelled), legacy)}.wav")
            for spelled in (portable, *zip(*spellings))))
        legacy_paths = [path for path in legacy_paths if path != current]
        if not os.path.exists(wav_path):
            for legacy_path in legacy_paths:
                if os.path.exists(legacy_path):
                    wav_path = adopt_cached_file(legacy_path, wav_path)
                    break
        if names is not None:
            names.extend(_cache_name(path) for path in (current, *legacy_paths))
    # The worker synthesizes from ``spans``, but the gateway and scheduler read
    # top-level ``text`` to scale the remote execution deadline. Add this after
    # the signature so existing content-addressed remote cache keys still hit.
    params["text"] = "\n".join(row["text"] for row in rows)

    def decode(result):
        import soundfile as sf
        from core.durable_io import flush_dir, flush_file
        from services.longform_render import wav_is_complete

        if not wav_is_complete(wav_path):
            # Durable like the local chapter write (#2279): a power-off right
            # after publishing must not leave a torn file under the key.
            partial = f"{wav_path}.part"
            shutil.copyfile(result.path, partial)
            flush_file(partial)
            os.replace(partial, wav_path)
            flush_dir(os.path.dirname(wav_path))
        info = sf.info(wav_path)
        return wav_path, float(info.duration), False, None

    return gpu_gateway.RemoteCall(
        engine=engine_id, operation="audiobook", params=params,
        idempotency_key=f"audiobook:{signature}", decode=decode,
    ), wav_path


def _chapter_opts(opts: ExpressiveOptions, chapter, default_voice, voice_map) -> ExpressiveOptions:
    """``opts`` with the volumes of only the voices this chapter speaks: turning
    one voice up re-assembles the chapters it is in (and re-renders them on a
    remote worker), and leaves every other chapter's cache key as it was."""
    if not opts.voice_gains:
        return opts
    spoken = {span_voice_name(s.voice_id, default_voice, voice_map)
              for s in chapter.spans if s.text}
    return dataclasses.replace(
        opts, voice_gains=tuple(p for p in opts.voice_gains if p[0] in spoken) or None)


async def _run_chapter(chapter, *, operation="audiobook", decision, job, default_voice, language, opts,
                       voice_map, lexicon, cache_dir, lease=None, read_in: _ReadIn | None = None):
    """Run one chapter through the gateway; local preparation stays lazy.

    The performance preset is read once here (:func:`_preset_opts`): the
    synth, the cache keys and a remote worker all get the same sampling. A
    chapter this machine renders that is already cached is served without
    loading the model — a fully cached book after the model idled out used
    to wait for a load it never used.

    ``lease`` holds the reference files the chapter resolves (#2535);
    ``read_in`` places a passage preview in its chapter (:func:`_phrase_plan`)."""
    from services import gpu_gateway
    from services.tts_backend import active_backend_id, get_backend_class

    request_opts = _chapter_opts(opts, chapter, default_voice, voice_map)
    engine_id = active_backend_id()
    opts = _preset_opts(request_opts, engine_id)
    remote, remote_cache = _remote_chapter_call(
        chapter, engine_id=engine_id, default_voice=default_voice,
        voice_map=voice_map, language=language, lexicon=lexicon,
        opts=opts, cache_dir=cache_dir, lease=lease, request_opts=request_opts,
        read_in=read_in,
    )
    from services.longform_render import touch_cached_file, wav_is_complete

    if decision.remote and wav_is_complete(remote_cache):
        import soundfile as sf
        touch_cached_file(remote_cache)
        info = sf.info(remote_cache)
        return remote_cache, float(info.duration), True, None

    def cached_here():
        return _cached_local_chapter(
            chapter, engine_id=engine_id, default_voice=default_voice, language=language,
            opts=opts, request_opts=request_opts, voice_map=voice_map, lexicon=lexicon,
            cache_dir=cache_dir, lease=lease, read_in=read_in)

    looked = not decision.remote or (job is not None and job.latched_local)
    if looked:
        hit = await asyncio.to_thread(cached_here)
        if hit is not None:
            return hit

    async def prepare_local():
        from services.model_manager import generate_timeout_s

        if not looked:
            # A remote unit that fell back to this machine.
            hit = await asyncio.to_thread(cached_here)
            if hit is not None:
                return gpu_gateway.LocalCall(fn=lambda: hit, what="Audiobook chapter")
        synth, sr, resolve, local_engine = await _prepare_synth(
            default_voice, language=language, opts=opts, voice_map=voice_map,
            lease=lease,
        )
        try:
            timeout_engine = get_backend_class(local_engine)
        except ValueError:
            # Tests and third-party integrations may inject a synth under a
            # non-catalogue id. Keep the canonical host/text policy available;
            # registered production engines still add their routing metadata.
            timeout_engine = None
        return gpu_gateway.LocalCall(
            fn=lambda: _render_chapter_cached(
                chapter, synth, sr, local_engine, resolve, cache_dir, lexicon,
                language, opts, voice_map, default_voice=default_voice,
                request_opts=request_opts, read_in=read_in,
            ),
            what="Audiobook chapter",
            timeout=generate_timeout_s(
                remote.params["text"], engine=timeout_engine
            ),
        )

    return await gpu_gateway.run(
        operation, local=gpu_gateway.LocalCall(prepare=prepare_local),
        remote=remote, decision=decision, job=job,
    )


def _cached_local_chapter(chapter, *, engine_id, default_voice, language, opts, request_opts,
                          voice_map, lexicon, cache_dir, lease=None,
                          read_in: _ReadIn | None = None):
    """``(wav_path, duration, True, None)`` when the chapter's audio is in the
    local cache, found without loading a model — the key needs only the
    engine's sample rate (:func:`_local_sample_rate`); ``None`` otherwise, and
    when that rate is only known to a loaded model. A chapter whose takes the
    speech check could not listen to is left to the render, which asks the
    recognizer first — unless none is installed to ask: the render would
    then serve this same audio, only after loading the model for it."""
    sr = _local_sample_rate(engine_id)
    if sr is None:
        return None
    keys = _chapter_cache_keys(chapter, sr, engine_id,
                               _voice_resolver(default_voice, voice_map, lease), cache_dir,
                               lexicon=lexicon, language=language, opts=opts,
                               voice_map=voice_map, default_voice=default_voice,
                               request_opts=request_opts, read_in=read_in)
    found = _chapter_cache_lookup(keys, sr)
    if found is None:
        return None
    candidate, dur = found
    if opts.verify_speech and _unchecked_takes(candidate):
        from services.speech_verify import SpeechVerifier

        if SpeechVerifier(sr).may_answer():
            return None
    return _use_cached_chapter(keys, candidate, cache_dir), dur, True, None


class PassageContext(BaseModel):
    """Where a passage preview is read in its book: the script text of the
    chapter it is part of, its ``# Title`` line included, and where the
    passage starts and ends in that text (``start`` / ``end``). The
    passage's sentences are then the chapter's own takes: a sentence the
    chapter says before it is the repeat it is there, and a retake asked
    for in the chapter plays in it."""

    chapter: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)


class AudiobookPreviewRequest(ExpressiveMixin):
    text: str
    chapter_index: int = 0
    default_voice: str | None = None
    language: str | None = None   # None/"Auto" → profile language, else autodetect
    lexicon: dict | None = None
    # Cast map {[voice:NAME] → profile id} — MUST match the full render's so a
    # preview warms exactly the cache slot the render reuses (#1217).
    voice_map: dict[str, str] | None = None
    # A passage preview (``text`` is the passage as a one-chapter script):
    # where it is read in its book, so it reads the book's own takes.
    context: PassageContext | None = None


def _passage_read_in(req: AudiobookPreviewRequest) -> _ReadIn | None:
    """The chapter a passage preview is read in (``req.context``), as the
    script parses it; ``None`` without a context, or with one that is not a
    single chapter holding the passage — the passage is then read on its
    own."""
    context = req.context
    if context is None or not context.start <= context.end <= len(context.chapter):
        return None
    around = parse_audiobook_script(context.chapter, default_voice=req.default_voice).chapters
    if len(around) != 1:
        return None
    lead = parse_audiobook_script(context.chapter[:context.start],
                                  default_voice=req.default_voice).chapters
    return _ReadIn(chapter=around[0], lead=lead[0].spans if len(lead) == 1 else [])


@router.post("/audiobook/preview")
async def audiobook_preview(req: AudiobookPreviewRequest) -> dict:
    """Render a single chapter so the user can audition it before the full run.

    Reuses the same content-addressed cache as the job, so a preview warms the
    cache (the later full render reuses it) and a re-preview is instant. A
    passage preview sends where the passage is read (``context``), so its
    sentences are its chapter's takes — the ones the book reads there.
    """
    from core.config import OUTPUTS_DIR
    from services import gpu_gateway

    plan = parse_audiobook_script(req.text, default_voice=req.default_voice)
    if not plan.chapters:
        raise HTTPException(status_code=400, detail="no chapters parsed from the script")
    n = len(plan.chapters)
    if not (0 <= req.chapter_index < n):
        raise HTTPException(status_code=400, detail=f"chapter_index out of range (0..{n - 1})")

    chapter = plan.chapters[req.chapter_index]
    cache_dir = os.path.join(OUTPUTS_DIR, LONGFORM_CACHE_SUBDIR)  # shared with _render_longform_sse
    os.makedirs(cache_dir, exist_ok=True)
    resolved_lang = _resolve_default_language(req.language, req.default_voice)
    opts = _expressive_opts(req)
    decision = gpu_gateway.decide("audiobook")
    with voice_leases.VoiceFileLease() as lease, recognizer_lease(checking=opts.verify_speech):
        wav_path, dur, was_cached, seg_stats = await _run_chapter(
            chapter, decision=decision, job=None, default_voice=req.default_voice,
            language=resolved_lang, opts=opts, voice_map=req.voice_map,
            lexicon=req.lexicon, cache_dir=cache_dir, lease=lease,
            read_in=_passage_read_in(req),
        )
    check = (seg_stats or {}).get("speech_check")
    if check is None and opts.verify_speech:
        # A cached chapter: what the check found is kept with its timing.
        check = _chapter_speech_check(load_chapter_timeline(wav_path))
    return {
        "output": os.path.relpath(wav_path, OUTPUTS_DIR),  # served via /audio
        "duration_s": round(dur, 2),
        "cached": was_cached,
        "title": chapter.title,
        **_untitled(chapter),
        **({"speech_check": check} if check is not None else {}),
    }


class AudiobookRetakeRequest(AudiobookPreviewRequest):
    """A chapter preview's inputs plus the take to render anew: its ``span``
    in the chapter (the index into that chapter's spans as ``/audiobook/plan``
    lists them) and ``take``, its index among that span's takes in reading
    order — the position ``/audiobook/takes`` lists it at. ``phrase`` (the
    take's ``text`` there), when given, refuses the retake (409) if the take
    at that position now says something else."""

    span: int = Field(ge=0)
    take: int = Field(ge=0)
    phrase: str | None = Field(default=None, max_length=2000)


def _take_store(keys: _ChapterKeys, cache_dir: str, sr: int, engine_id: str):
    """The take cache a render of a chapter keyed ``keys`` reads."""
    from services.longform_render import TakeCache

    return TakeCache(cache_dir, sample_rate=sr, engine_id=engine_id,
                     voice_sig=keys.voice_sigs, take_sig=keys.take_sig)


def _chapter_take_plan(keys: _ChapterKeys, *, opts, lexicon) -> list:
    """Every phrase take of a chapter keyed ``keys``, by span: as
    :func:`_chapter_cache_keys` planned them (retakes placed, a passage read
    in its chapter), else — none applied when its key was derived — as
    synthesis cuts the chapter with ``opts``. One plan for the key, the
    render and the lists, so they never disagree about a take."""
    from services.audiobook import chapter_units
    from services.longform_render import chapter_takes

    if keys.takes is not None:
        return keys.takes
    units = chapter_units(keys.spans, lexicon=lexicon, **_split_kwargs(opts))
    return chapter_takes(keys.spans, units, voice_sig=keys.voice_sigs, take_sig=keys.take_sig)


class _CacheListing:
    """The file names in a long-form cache's take and segment folders, each
    folder read once, on first use: the outline counts a whole book's takes
    from two directory listings instead of a look at the disk per take."""

    def __init__(self, cache_dir: str) -> None:
        self.cache_dir = cache_dir
        self._names: dict = {}

    def names(self, subdir: str) -> frozenset:
        if subdir not in self._names:
            try:
                with os.scandir(os.path.join(self.cache_dir, subdir)) as entries:
                    self._names[subdir] = frozenset(entry.name for entry in entries)
            except OSError:
                self._names[subdir] = frozenset()
        return self._names[subdir]


def _reused_takes(keys: _ChapterKeys, plan: list, store, *, opts, cache_dir,
                  listing: _CacheListing | None = None) -> list:
    """Which phrase takes of ``plan`` a render would reuse, by span, one bool
    per take — decided as :func:`services.audiobook.synthesize_chapter` does:
    a span cached whole (by a version before takes were kept) serves all of
    its takes; once one of them was asked for again, the others are cut from
    it where it keeps their ranges (``longform_render.cuttable_takes``); any
    other take is reused from the take cache (``store``). Reads file names
    (from ``listing`` when given), WAV headers and timing sidecars only:
    nothing is loaded or moved."""
    from services.longform_render import (
        SEGMENT_SUBDIR,
        TAKE_SUBDIR,
        SegmentCache,
        cuttable_takes,
    )

    segments = SegmentCache(cache_dir, sample_rate=store.sample_rate, engine_id=store.engine_id,
                            voice_sig=keys.voice_sigs, extra_sig=keys.seg_extra_sig,
                            vary_repeats=opts.vary_repeats,
                            legacy_voice_sigs=keys.legacy_voice_sigs,
                            legacy_extra_sig=keys.legacy_seg_extra_sig)
    whole_names = listing.names(SEGMENT_SUBDIR) if listing is not None else None
    take_names = listing.names(TAKE_SUBDIR) if listing is not None else None

    def kept(ref) -> bool:
        if take_names is None:
            return store.has(ref)
        return os.path.basename(store.path(ref)) in take_names

    seen: dict = {}
    out = []
    for span, refs in zip(keys.spans, plan):
        whole, cut = False, frozenset()
        if span.text:
            # The occurrence synthesis keys a repeated span's segment by.
            repeat = (span.voice_id, span.text, getattr(span, "speed", None))
            occurrence = seen.get(repeat, 0)
            seen[repeat] = occurrence + 1
            if refs and segments.holds(span, occurrence, names=whole_names):
                if not any(ref.salt for ref in refs):
                    whole = True
                elif (timing := segments.timing_at(span, occurrence)) is not None:
                    cut = cuttable_takes(timing["units"], timing["check"],
                                         checking=opts.verify_speech)
        out.append([whole or (k in cut and not ref.salt) or kept(ref)
                    for k, ref in enumerate(refs)])
    return out


@dataclasses.dataclass
class _TakeListing:
    """A chapter's phrase takes as :func:`_list_takes` lists them: each
    ``(entry, take)`` in reading order, and the chapter's title as a retake
    is kept with it (``None``: untitled)."""

    takes: list
    title: str | None


def _list_takes(chapter, *, default_voice, language, opts, voice_map, lexicon,
                cache_dir) -> _TakeListing | None:
    """Every phrase take of ``chapter`` as a render (or preview) with these
    inputs cuts it, in reading order, each with its take
    (``longform_render.TakeRef``): ``{"span", "take", "text",
    "retake", "cached"}`` — the span's index in the chapter, the take's index
    in that span (as the timing documents count them), its text as the reader
    shows it, the retakes asked for so far, and whether a render would reuse
    its audio (:func:`_reused_takes`; ``None`` while the engine's rate is
    unknown until its model loads). ``None`` without phrase-by-phrase
    reading: the chapter is then read in takes of up to 800 characters,
    which are not kept one by one. Renders and loads nothing."""
    from services.audiobook import span_display_takes
    from services.tts_backend import active_backend_id

    request_opts = _chapter_opts(opts, chapter, default_voice, voice_map)
    engine_id = active_backend_id()
    opts = _preset_opts(request_opts, engine_id)
    if opts.punctuation_pauses is None:
        return None
    sr = _local_sample_rate(engine_id)
    keys = _chapter_cache_keys(chapter, sr or 0, engine_id,
                               _voice_resolver(default_voice, voice_map), cache_dir,
                               lexicon=lexicon, language=language, opts=opts,
                               voice_map=voice_map, default_voice=default_voice,
                               request_opts=request_opts)
    split = _split_kwargs(opts)
    store = _take_store(keys, cache_dir, sr or 0, engine_id)
    plan = _chapter_take_plan(keys, opts=opts, lexicon=lexicon)
    reused = _reused_takes(keys, plan, store, opts=opts, cache_dir=cache_dir) if sr else None
    out = []
    for index, (span, spoken, refs) in enumerate(zip(chapter.spans, keys.spans, plan)):
        if not refs:
            continue
        shown = span_display_takes(span.text, spoken.text, lexicon=lexicon, **split)
        for k, ref in enumerate(refs):
            out.append(({"span": index, "take": k,
                         "text": shown[k] if k < len(shown) else ref.text,
                         "retake": ref.retake,
                         "cached": reused[index][k] if reused is not None else None},
                        ref))
    return _TakeListing(takes=out, title=keys.title)


def _script_chapter(req: AudiobookPreviewRequest):
    """Chapter ``req.chapter_index`` of ``req.text`` as the render parses it;
    400 for a script or chapter index with nothing."""
    plan = parse_audiobook_script(req.text, default_voice=req.default_voice)
    if not plan.chapters:
        raise HTTPException(status_code=400, detail="no chapters parsed from the script")
    n = len(plan.chapters)
    if not (0 <= req.chapter_index < n):
        raise HTTPException(status_code=400, detail=f"chapter_index out of range (0..{n - 1})")
    return plan.chapters[req.chapter_index]


async def _chapter_takes(chapter, req) -> tuple[_TakeListing | None, str]:
    """``(the takes of chapter as _list_takes gives them, the cache dir)``,
    read with ``req``'s voices, cast, language, lexicon and options — a
    chapter preview's request, or a Stories chapter's."""
    from core.config import OUTPUTS_DIR

    cache_dir = os.path.join(OUTPUTS_DIR, LONGFORM_CACHE_SUBDIR)
    os.makedirs(cache_dir, exist_ok=True)
    takes = await asyncio.to_thread(
        _list_takes, chapter, default_voice=req.default_voice,
        language=_resolve_default_language(req.language, req.default_voice),
        opts=_expressive_opts(req), voice_map=req.voice_map, lexicon=req.lexicon,
        cache_dir=cache_dir)
    return takes, cache_dir


def _takes_reply(chapter, listing: _TakeListing | None) -> dict:
    """``/audiobook/takes``' (and ``/longform/takes``') answer."""
    return {"title": chapter.title, **_untitled(chapter), "phrases": listing is not None,
            "takes": [entry for entry, _ref in listing.takes] if listing is not None else []}


@router.post("/audiobook/takes")
async def audiobook_takes(req: AudiobookPreviewRequest) -> dict:
    """The phrase takes of one chapter, as a render or preview with the same
    inputs cuts it (see :func:`_list_takes`): where each sentence of the
    script is, so the app can ask for one again (``/audiobook/retake``).
    ``phrases`` is false — and ``takes`` empty — without phrase-by-phrase
    reading. Renders nothing."""
    chapter = _script_chapter(req)
    takes, _cache_dir = await _chapter_takes(chapter, req)
    return _takes_reply(chapter, takes)


@router.post("/audiobook/retake")
async def audiobook_retake(req: AudiobookRetakeRequest) -> dict:
    """Ask for one phrase take again ("retake this sentence"): a retake is
    kept for that sentence where it is read — the sentences around it and
    its chapter's title (``longform_render.take_anchor``), so the same
    sentence read elsewhere keeps its take, and an edit around it keeps the
    retake — and it keys that take, and its chapter, anew: the next render
    or preview of the chapter synthesizes that take and reuses every other.
    Returns the take as ``/audiobook/takes`` lists it, with the new count.
    Renders nothing itself."""
    takes, cache_dir = await _chapter_takes(_script_chapter(req), req)
    return await _ask_again(req, takes, cache_dir)


async def _ask_again(req, listing: _TakeListing | None, cache_dir: str) -> dict:
    """Ask once more for the take at ``req.span`` / ``req.take`` of
    ``listing`` (:func:`_list_takes`), where the chapter reads it: 400
    without phrase-by-phrase reading, 404 for no take there, 409 when
    ``req.phrase`` says that take now reads something else, 500 when the
    retake cannot be saved."""
    from services.longform_render import bump_retake, take_anchor

    if listing is None:
        raise HTTPException(status_code=400,
                            detail="retakes need sentence-by-sentence reading")
    found = next(((at, entry, ref) for at, (entry, ref) in enumerate(listing.takes)
                  if entry["span"] == req.span and entry["take"] == req.take), None)
    if found is None:
        raise HTTPException(status_code=404, detail="no take at that span and take index")
    at, entry, ref = found
    if req.phrase is not None and " ".join(req.phrase.split()) != " ".join(entry["text"].split()):
        raise HTTPException(status_code=409,
                            detail="the take at that position says something else now")
    anchor = take_anchor([take.text for _entry, take in listing.takes], at, listing.title)
    try:
        count = await asyncio.to_thread(bump_retake, cache_dir, ref, anchor)
    except (OSError, ValueError):
        logger.warning("Could not save a retake", exc_info=True)
        raise HTTPException(status_code=500, detail="the retake could not be saved")
    return {**entry, "retake": count, "cached": False}


def _untitled(chapter) -> dict:
    """``{"untitled": True}`` for a chapter the script left untitled, else ``{}``.

    Its ``title`` is then the parser's English "Chapter N" (the file's chapter
    marks need one); every response that carries a chapter title carries this
    flag beside it, so the app names the chapter in its own language instead.
    """
    return {"untitled": True} if getattr(chapter, "untitled", False) else {}


def _cache_name(wav_path: str) -> str:
    """A chapter's cache key as a book records it: its cached WAV's name."""
    return os.path.splitext(os.path.basename(wav_path))[0]


def _local_sample_rate(engine_id: str) -> int | None:
    """The rate a local render of ``engine_id`` caches chapters at, read
    without loading a model; ``None`` when only a loaded model knows it."""
    from services.tts_backend import OmniVoiceBackend, get_backend_class, output_sample_rate

    try:
        cls = get_backend_class(engine_id)
    except ValueError:
        return None
    if cls is OmniVoiceBackend:
        from services import model_manager

        return _omnivoice_sample_rate(getattr(model_manager, "model", None))
    return output_sample_rate(engine_id)


def _chapter_cache_state(chapter, *, decision, default_voice, language, opts, voice_map,
                         lexicon, cache_dir, takes: dict | None = None,
                         listing: _CacheListing | None = None
                         ) -> tuple[str | None, bool | None, list]:
    """``(cache key, cached, names)`` of one chapter, looked up exactly as
    :func:`_run_chapter` would: the remote cache when the job would run
    remotely, else the local chapter cache through :func:`_chapter_cache_keys`.
    ``names`` lists every key its audio may be cached under, the legacy ones
    too — a book rendered before the current key recorded one of those.
    Renders and loads nothing; ``cached`` is ``None`` when the local engine's
    sample rate is unknown until its model loads.

    ``takes`` (a dict the caller owns) receives, for a chapter rendered here
    sentence by sentence and not cached whole, how many phrase takes a render
    of it reads (``total``) and how many of those it would reuse
    (``cached``, :func:`_reused_takes`, from ``listing`` when given) — so the
    app can tell a chapter that only joins its takes again from one that
    renders some."""
    from services.longform_render import wav_is_complete
    from services.tts_backend import active_backend_id

    request_opts = _chapter_opts(opts, chapter, default_voice, voice_map)
    engine_id = active_backend_id()
    opts = _preset_opts(request_opts, engine_id)
    if decision.remote:
        names: list = []
        _, path = _remote_chapter_call(
            chapter, engine_id=engine_id, default_voice=default_voice, voice_map=voice_map,
            language=language, lexicon=lexicon, opts=opts, cache_dir=cache_dir,
            request_opts=request_opts, names=names)
        return _cache_name(path), wav_is_complete(path), names
    sr = _local_sample_rate(engine_id)
    if sr is None:
        return None, None, []
    keys = _chapter_cache_keys(chapter, sr, engine_id, _voice_resolver(default_voice, voice_map),
                               cache_dir, lexicon=lexicon, language=language, opts=opts,
                               voice_map=voice_map, default_voice=default_voice,
                               request_opts=request_opts)
    cached = any(os.path.exists(path) and wav_is_complete(path)
                 for path in dict.fromkeys((keys.wav_path, *keys.legacy_paths)))
    if takes is not None and not cached and opts.punctuation_pauses is not None:
        store = _take_store(keys, cache_dir, sr, engine_id)
        plan = _chapter_take_plan(keys, opts=opts, lexicon=lexicon)
        reused = _reused_takes(keys, plan, store, opts=opts, cache_dir=cache_dir,
                               listing=listing)
        takes.update(total=sum(map(len, reused)), cached=sum(map(sum, reused)))
    return _cache_name(keys.wav_path), cached, keys.names


class AudiobookOutlineRequest(ExpressiveMixin):
    """The same inputs as a render (and a chapter preview), so the outline
    looks each chapter up under the key that render would use."""

    text: str
    default_voice: str | None = None
    language: str | None = None
    lexicon: dict | None = None
    voice_map: dict[str, str] | None = None
    # The last finished book (a render's output name): chapters whose key it
    # does not hold have changed since it.
    output: str | None = None


@router.post("/audiobook/outline")
async def audiobook_outline(req: AudiobookOutlineRequest) -> dict:
    """Where each chapter of a script stands, index-aligned with
    ``/audiobook/plan``: ``rendered`` (its audio is cached for the current
    script and settings, or the last book holds it as it is now), ``changed``
    (the last book holds another version of it, or none), or ``not_rendered``.
    ``cached`` is the cache lookup itself (``None`` when it cannot be told
    without loading the engine) and ``in_book`` whether the last book holds
    this version (``None`` without a book that recorded its chapters). A
    chapter rendered here sentence by sentence and not cached whole adds
    ``takes``: ``{"total", "cached"}``, how many phrase takes it reads and
    how many of them a render would reuse (all of them: it only joins them
    again)."""
    from core.config import OUTPUTS_DIR
    from services import gpu_gateway

    plan = parse_audiobook_script(req.text, default_voice=req.default_voice)
    cache_dir = os.path.join(OUTPUTS_DIR, LONGFORM_CACHE_SUBDIR)
    os.makedirs(cache_dir, exist_ok=True)
    resolved_lang = _resolve_default_language(req.language, req.default_voice)
    opts = _expressive_opts(req)
    decision = gpu_gateway.decide("audiobook")
    book = _read_book_timeline(req.output) if req.output else None
    book_keys = None
    if book is not None:
        keys = [c.get("key") for c in book.get("chapters") or [] if isinstance(c, dict)]
        book_keys = {k for k in keys if isinstance(k, str)} if any(keys) else None
    takes: list[dict] = [{} for _ in plan.chapters]
    listing = _CacheListing(cache_dir)

    def check() -> list:
        return [_chapter_cache_state(
            chapter, decision=decision, default_voice=req.default_voice,
            language=resolved_lang, opts=opts, voice_map=req.voice_map,
            lexicon=req.lexicon, cache_dir=cache_dir, takes=counts, listing=listing)
            for chapter, counts in zip(plan.chapters, takes)]

    chapters = []
    for chapter, (key, cached, names), counts in zip(plan.chapters, await asyncio.to_thread(check),
                                                     takes):
        # A book rendered before the current keys recorded a legacy one: the
        # same audio, so the chapter has not changed since it.
        in_book = None if book_keys is None or key is None else not book_keys.isdisjoint(names)
        status = ("rendered" if in_book or (in_book is None and cached)
                  else "changed" if in_book is False else "not_rendered")
        chapters.append({"title": chapter.title, **_untitled(chapter), "status": status,
                         "cached": cached, "in_book": in_book,
                         **({"takes": counts} if counts else {})})
    return {"chapters": chapters, "book": book is not None}


def _project_token(value) -> str | None:
    """The editor's library project id as a safe token (no path separators,
    no CR/LF), or None — what job rows, manifests and listings carry."""
    return re.sub(r"[^A-Za-z0-9_-]", "", value if isinstance(value, str) else "")[:64] or None


def _job_project(job_id: str) -> str | None:
    """The project a job row was created for (best-effort; None without one)."""
    try:
        from core import job_store
        return (job_store.get(job_id) or {}).get("project_id")
    except Exception:
        return None


async def _render_longform_sse(
    plan,
    *,
    default_voice: str | None,
    language: str | None = None,
    fmt: str = "m4b",
    bitrate: str = "128k",
    loudness: str | None = None,
    cover_path: str | None = None,
    metadata: dict | None = None,
    lexicon: dict | None = None,
    opts: ExpressiveOptions | None = None,
    voice_map: dict | None = None,
    job_type: str = "audiobook",
    job_id: str | None = None,
    project_id: str | None = None,
    resume: bool = False,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    on_completed: Callable[[], None] | None = None,
):
    """Shared chapterized-render SSE generator for Audiobook *and* Stories.

    Takes a ready ``plan`` (``.chapters`` → ``.title`` + ``.spans``) — Audiobook
    parses it from a script, Stories compiles it from cast/lines — and renders
    each chapter (content-addressed cache → resume), isolating per-chapter
    failures, then muxes the successful chapters into a tagged file. This is the
    convergence point: one renderer, two front doors.
    """
    from core.config import OUTPUTS_DIR
    from core.failure import build_failure, build_failure_event
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg
    from services import gpu_gateway

    opts = opts or ExpressiveOptions()

    # Resume reuses the original job_id (continuing the same job row + cached
    # chapters); a fresh render generates a new one. The id may arrive from the
    # /resume/{job_id} path param, so strip it to a safe token (no path
    # separators, no CR/LF) before it ever reaches a filesystem path or a log
    # line — CodeQL py/path-injection + py/log-injection. Empty after the strip
    # → a fresh id.
    job_id = re.sub(r"[^A-Za-z0-9_-]", "", job_id or "")[:64] or uuid.uuid4().hex[:16]
    project_id = _project_token(project_id)
    try:
        from core import job_store
        if not resume:
            job_store.create(job_id, type=job_type, project_id=project_id)
        job_store.mark_running(job_id)
    except Exception:
        job_store = None  # job history is best-effort; never block synthesis

    # Persist a durable resume manifest (plan + params) so an interrupted render
    # can be resumed later even without the original script. Best-effort.
    # An untitled first chapter's "Chapter 1" is no name for the book: without
    # a title the job stays untitled, and the app says so in its own language.
    title = (metadata or {}).get("title") or (
        plan.chapters[0].title if plan.chapters and not _untitled(plan.chapters[0]) else "")
    try:
        longform_resume.write_manifest(longform_resume.build_manifest(
            job_id=job_id, job_type=job_type, title=title, project_id=project_id,
            plan_chapters=[
                {"title": c.title, "spans": [s.to_dict() for s in c.spans],
                 **({"untitled": True} if getattr(c, "untitled", False) else {})}
                for c in plan.chapters
            ],
            params={
                "default_voice": default_voice, "language": language,
                "fmt": fmt, "bitrate": bitrate,
                "loudness": loudness, "cover_path": cover_path,
                "metadata": metadata, "lexicon": lexicon,
                # #1208: persist the expressive knobs so a resumed render is
                # byte-consistent with the interrupted one (same cache keys).
                "expressive": opts.to_manifest(),
                # #1217: persist the cast map so a resumed render resolves and
                # caches every [voice:NAME] identically to the interrupted one.
                "voice_map": voice_map,
            },
        ))
    except Exception:  # resume durability is an enhancement; never block the render
        logger.debug("[%s] resume manifest write skipped", job_id, exc_info=True)

    def _retire_failed(store, jid: str, reason: str) -> None:
        """A pre-render refusal ends the job; it must not stay `running`."""
        if store is not None:
            try:
                store.retire_if_active(jid, "failed", reason)
            except Exception:
                pass  # best-effort job history

    def _emit(payload: dict) -> str:
        if job_store is not None:
            try:
                job_store.append_event(job_id, json.dumps(payload))
            except Exception:
                pass  # best-effort job history; never block the stream
        return f"data: {json.dumps(payload)}\n\n"

    if not plan.chapters:
        _retire_failed(job_store, job_id, "nothing to render (no chapters)")
        yield _emit({"type": "error", "error": "nothing to render (no chapters)"})
        return
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        _retire_failed(job_store, job_id, "ffmpeg not available; the output needs it")
        yield _emit({"type": "error", "error": "ffmpeg not available; the output needs it"})
        return

    # Confined work dir (job_id is already token-sanitized above; work_dir adds
    # the basename + realpath barrier so CodeQL sees a clean path).
    work = longform_resume.work_dir(job_type, job_id)
    if work is None:
        _retire_failed(job_store, job_id, "invalid job id")
        yield _emit({"type": "error", "error": "invalid job id"})
        return
    os.makedirs(work, exist_ok=True)
    # Chapter WAVs are content-addressed in a shared cache so a re-run (after a
    # failure or interruption) reuses what already rendered — only the
    # missing/changed chapters synthesize again (resume). Shared across both
    # front doors: an identical chapter renders once.
    cache_dir = os.path.join(OUTPUTS_DIR, LONGFORM_CACHE_SUBDIR)
    os.makedirs(cache_dir, exist_ok=True)
    # Bound disk before this job adds its chapters. It walks every cached
    # file, so it runs off the event loop.
    await asyncio.to_thread(prune_cache_dir, cache_dir)
    # Every reference take this render resolves stays held until it ends, so a
    # re-lock mid-book never lets the retired-voice sweep delete it (#2535).
    voice_lease = voice_leases.VoiceFileLease()
    # With the speech check on, its recognizer loads once for the whole book.
    check_lease = recognizer_lease(checking=opts.verify_speech)
    # The chapters it has finished stay until the mux has read them: another
    # render's pruning walks past them.
    chapter_hold = CacheHold()
    try:
        resolved_lang = _resolve_default_language(language, default_voice)
        operation = "audiobook" if job_type == "audiobook" else "longform"
        decision = gpu_gateway.decide(operation)
        chapter_run = gpu_gateway.JobRun(operation)

        total = len(plan.chapters)
        chapter_files: list[str] = []
        chapters_meta: list[tuple[str, int]] = []
        # (chapter, exact duration, timing, cache key) of every chapter in the
        # file, for the rendered timeline the reader follows.
        rendered_timing: list[tuple] = []
        cached_n = 0
        failed: list[int] = []
        # Kept so the terminal "all chapters failed" event can name the cause
        # instead of restating the symptom (#1321).
        last_chapter_exc: Exception | None = None
        interrupted = False
        yield _emit({"type": "started", "job_id": job_id, "chapters": total})

        for i, chapter in enumerate(plan.chapters):
            # Client-disconnect cancellation (#1216): if the browser aborted the
            # request (the user hit Stop), stop scheduling further chapters
            # instead of rendering the whole book into a stream nobody reads.
            # Checked at the chapter boundary so a stop is clean and the finished
            # chapters — content-addressed in the shared cache — plus the resume
            # manifest are left in place, so a later Create/resume finishes the
            # rest cheaply. (Starlette also cancels this task on disconnect; the
            # explicit poll makes the stop deterministic and lets us emit a clean
            # terminal `stopped` event. This render parks no model on CPU the way
            # the dub transcribe does — #1191 — so there is no restore debt to
            # pay on exit; stopping is simply "schedule no more chapters".)
            if is_disconnected is not None:
                try:
                    gone = await is_disconnected()
                except Exception:
                    gone = False
                if gone:
                    interrupted = True
                    break
            try:
                wav_path, dur, was_cached, seg_stats = await _run_chapter(
                    chapter, operation=operation, decision=decision, job=chapter_run,
                    default_voice=default_voice, language=resolved_lang,
                    opts=opts, voice_map=voice_map, lexicon=lexicon,
                    cache_dir=cache_dir, lease=voice_lease,
                )
            except Exception as e:  # isolate a bad chapter — keep going
                logger.warning("[%s] chapter %d (%s) failed to render",
                               job_id, i, chapter.title, exc_info=True)
                failed.append(i)
                # Carry the real reason (#1321). The old event said only
                # "chapter failed to render", so a failed chapter was a red row
                # and nothing else — the cause existed solely in the backend log,
                # which is why the report for this arrived as a bare traceback.
                # build_failure guarantees a non-empty reason even for exceptions
                # whose str() is empty (a generator-based engine that yields
                # nothing raises a bare StopIteration), sanitizes paths/tokens,
                # and adds the docs deeplink + hint. `error` stays populated —
                # build_failure mirrors reason into it — so older frontends and
                # the Stories exporter keep working.
                last_chapter_exc = e
                yield _emit({"type": "chapter_error", "index": i, "total": total,
                             "title": chapter.title, **_untitled(chapter),
                             # No env diagnostic per chapter: a book can fail
                             # hundreds of times and it is identical every time.
                             # The terminal error below carries one.
                             **build_failure(e, stage="audiobook_chapter",
                                             include_diagnostic=False)})
                continue
            chapter_hold.add(wav_path)
            chapter_files.append(wav_path)
            chapter_timing = load_chapter_timeline(wav_path)
            rendered_timing.append((chapter, dur, chapter_timing, _cache_name(wav_path)))
            dur_ms = int(round(dur * 1000))
            chapters_meta.append((chapter.title, dur_ms))
            cached_n += 1 if was_cached else 0
            # `duration_ms` (additive; old clients ignore it) is exactly what
            # the embedded m4b chapters are built from, so a client summing it
            # reproduces their START offsets; `duration_s` is display-rounded.
            ev = {"type": "chapter", "index": i, "total": total,
                  "title": chapter.title, **_untitled(chapter), "duration_s": round(dur, 2),
                  "duration_ms": dur_ms, "cached": was_cached}
            if seg_stats is not None:
                # Additive fields (old clients ignore them): segment-level
                # reuse inside a re-rendered chapter.
                ev["segments"] = seg_stats["total"]
                ev["cached_segments"] = seg_stats["cached"]
            check = (seg_stats or {}).get("speech_check") or _chapter_speech_check(chapter_timing)
            if check is not None:
                # Phrases that still differ from the script after their
                # retakes — what the listener should check. Kept with the
                # chapter's audio, so a cached chapter reports it too.
                ev["speech_check"] = check
            levels = _chapter_levels(chapter_timing)
            if levels:
                # Additive: what voice leveling measured and added per voice
                # (name → {level_db, auto_db}), for the Cast panel. Kept with
                # the chapter's audio, so a cached chapter reports it too.
                ev["levels"] = levels
            yield _emit(ev)

        route_notice = chapter_run.notice()
        if route_notice is not None:
            yield _emit({"type": "routing_notice", "status": route_notice[0],
                         "reason": route_notice[1]})

        if interrupted:
            logger.info("[%s] client disconnected — stopped after %d/%d chapters",
                        job_id, len(chapter_files), total)
            if job_store is not None:
                try:
                    # A client disconnect here is a user-initiated Stop, not a
                    # failure — record it as cancelled so job history reads right
                    # and the resumable state isn't mistaken for a broken render.
                    job_store.mark_cancelled(job_id)
                except Exception:
                    pass  # best-effort job history
            # Deliberately DO NOT clear the resume manifest: the rendered chapters
            # are cached, so Create-again / resume picks up where this left off.
            # Emit a terminal `stopped` event (a fully-disconnected client won't
            # receive it, but a same-origin proxy or a partial read still gets a
            # clean close instead of a dangling stream).
            yield _emit({"type": "stopped", "rendered": len(chapter_files),
                         "total": total, "cached_chapters": cached_n,
                         "failed_chapters": failed})
            return

        if not chapter_files:
            # Every chapter failed, so the render is over — this is the event the
            # UI turns into a toast, and it used to carry only the symptom
            # (#1321). Lead with the summary, then the cause; docs_topic/hint are
            # classified from the raw exception text, so prefixing the reason
            # afterwards cannot mis-route the deeplink.
            if last_chapter_exc is not None:
                ev = build_failure_event(last_chapter_exc, stage="audiobook_render")
                ev["reason"] = f"all {total} chapters failed to render — {ev['reason']}"
                ev["error"] = ev["reason"]
            else:
                ev = {"type": "error", "error": "all chapters failed to render",
                      "reason": "all chapters failed to render"}
            # Terminal failure — record it. This branch used to return without
            # touching job history, so the row stayed `running` forever: the next
            # startup read it as an interrupted job, and the retained manifest
            # offered a render that had already failed every chapter as
            # resumable (Greptile P1 on #1321). The manifest IS kept on purpose —
            # a failure whose cause the user can now see (a missing voice, an
            # engine that can't read the script) is worth retrying once fixed,
            # and the chapter cache is empty here so a retry costs nothing extra.
            if job_store is not None:
                try:
                    job_store.mark_failed(job_id, ev["reason"])
                except Exception:
                    pass  # best-effort job history; never block the stream
            yield _emit(ev)
            return

        yield _emit({"type": "assembling"})
        meta_path = os.path.join(work, "chapters.ffmeta")
        write_lf_text(meta_path, build_ffmetadata(chapters_meta, global_meta=metadata))
        concat_path = os.path.join(work, "concat.txt")
        write_lf_text(concat_path, build_concat_list(chapter_files))
        ext = "mp3" if (fmt or "").lower() == "mp3" else "m4b"
        out_name = f"{job_type}_{job_id}.{ext}"
        out_path = os.path.join(OUTPUTS_DIR, out_name)
        # A timeline or HTML export left by an earlier file of this name
        # describes that file.
        _remove_book_derivatives(out_path)

        # Two-pass loudness master (#28): for a known preset, measure the
        # concatenated program first, then feed the measured values back into the
        # single mux encode. `measured is None` (skip OR any failure) → the mux
        # falls back to single-pass. Gated identically to the pure builders
        # (.lower(), no strip), so off/None/unknown/whitespace skip cleanly.
        measured = None
        sample_rate = None
        norm = (loudness or "").lower()
        if norm in LOUDNESS_PRESETS:
            yield _emit({"type": "mastering", "preset": norm})
            from services.loudness import measure_loudness
            measured = await measure_loudness(ffmpeg, concat_path, norm, job_id=job_id)
            # The joined chapters share one rate; the master keeps it.
            sample_rate = wav_sample_rate(chapter_files[0])

        # A mastered file's peak is checked once encoded: lossy encoding can
        # push it back over the preset's ceiling, and then it is encoded again
        # with that much more room under the limiter.
        headroom = ENCODER_PEAK_HEADROOM_DB
        for encode in range(_MASTER_ENCODES):
            with trace_stage("mux"):
                await run_ffmpeg(
                    build_render_cmd(
                        ffmpeg, concat_path, meta_path, out_path,
                        fmt=ext, bitrate=bitrate, cover_path=_safe_cover_path(cover_path),
                        loudness=loudness, measured=measured,
                        sample_rate=sample_rate, peak_headroom=headroom,
                    ),
                    job_id=job_id,
                )
            if norm not in LOUDNESS_PRESETS or encode == _MASTER_ENCODES - 1:
                break
            from services.loudness import measure_true_peak
            peak = await measure_true_peak(ffmpeg, out_path, job_id=job_id)
            headroom = peak_headroom_after(norm, headroom, peak)
            if headroom is None:
                break
            logger.info("[%s] mastered peak %.1f dBTP is over the %s ceiling — encoding again",
                        job_id, peak, norm)

        if job_store is not None:
            try:
                job_store.mark_done(job_id)
            except Exception:
                pass  # best-effort job history
        # The render finished — drop the resume manifest so this job is no longer
        # offered for resume.
        longform_resume.clear_manifest(job_type, job_id)
        # A partial output still needs the original plan for failed chapters.
        if on_completed is not None and not failed:
            try:
                on_completed()
            except Exception:
                logger.debug("[%s] previous resume checkpoint cleanup skipped", job_id, exc_info=True)
        total_s = sum(d for _, d in chapters_meta) / 1000.0
        done = {"type": "done", "output": out_name,
                "chapters": len(chapter_files), "duration_s": round(total_s, 2),
                "cached_chapters": cached_n, "failed_chapters": failed}
        # Where each sentence of the file is heard, for the reader (additive:
        # served by GET /audiobook/timeline/{output}; old clients ignore it).
        if await asyncio.to_thread(
                _write_book_timeline, out_path, out_name, rendered_timing,
                default_voice=default_voice, voice_map=voice_map, language=resolved_lang,
                lexicon=lexicon, opts=opts):
            done["timeline"] = True
        # Say what this render IS, so the library can show more than a filename
        # (#2233). Additive keys; best-effort — a summary never fails a render.
        if title:
            done["title"] = str(title)[:200]
        try:
            # Only what is IN the file: chapters that failed are not summarised,
            # and the language is the one synthesis actually used.
            rendered = [c for i, c in enumerate(plan.chapters) if i not in set(failed)]
            done["summary"] = _render_summary(
                rendered, default_voice, voice_map, resolved_lang, fmt, opts)
        except Exception:
            logger.warning("longform: could not build the render summary", exc_info=True)
        # Loudness verdict only when a preset was requested — off/None paths keep
        # the exact legacy `done` shape (additive, old clients unaffected).
        if norm in LOUDNESS_PRESETS:
            p = LOUDNESS_PRESETS[norm]
            done["loudness"] = {
                "preset": norm, "target_i": p.i, "target_tp": p.tp,
                "two_pass": measured is not None,
                "measured_i": measured.input_i if measured else None,
            }
        yield _emit(done)
    except (asyncio.CancelledError, GeneratorExit):
        # The response was cancelled (transport dropped mid-render) or its
        # iterator was closed. Neither is an `Exception`, so the handler below
        # never saw them and the job stayed `running` for history/job consumers
        # (#2536). Retire it as cancelled — a no-op once it is already
        # done/failed — keep the resume manifest, and let the cancel propagate.
        if job_store is not None:
            try:
                job_store.retire_if_active(job_id, "cancelled")
            except Exception:
                pass  # best-effort job history
        raise
    except Exception as e:  # surface, don't 500 the stream
        logger.exception("[%s] longform render failed", job_id)
        if job_store is not None:
            try:
                job_store.mark_failed(job_id, str(e))
            except Exception:
                pass  # best-effort job history
        # Generic message only — don't leak the stack/exception text to the client.
        yield _emit({"type": "error", "error": "render failed (see backend log)"})
    finally:
        voice_lease.release()
        check_lease.release()
        chapter_hold.release()


def _write_book_timeline(out_path: str, out_name: str, chapters: list, **kwargs) -> bool:
    """Write the finished book's rendered timeline next to it, atomically
    (temp file + replace). Best-effort: a book without one reads with
    estimated timing, so a failure here never fails the render."""
    try:
        doc = book_timeline(out_name, chapters, **kwargs)
    except Exception:  # noqa: BLE001 — the timeline is a reading aid
        logger.warning("longform: could not build the rendered timeline", exc_info=True)
        return False
    return write_json_atomic(out_path + TIMELINE_SIDECAR_SUFFIX, doc)


def _book_path(output: str | None, suffix: str = "") -> str | None:
    """``OUTPUTS_DIR/<output><suffix>`` for a finished render's own name, else
    ``None``. Exact-match name allowlist plus a realpath barrier: nothing but
    a render's own files in OUTPUTS_DIR is ever reached (CodeQL path-injection)."""
    from core.config import OUTPUTS_DIR

    if not _OUTPUT_NAME_RE.fullmatch(output or ""):
        return None
    root = os.path.realpath(OUTPUTS_DIR)
    path = os.path.realpath(os.path.join(root, output + suffix))
    return path if os.path.dirname(path) == root else None


def _read_book_timeline(output: str | None) -> dict | None:
    """The rendered timeline of a finished book, or ``None`` (none kept, or
    unreadable, or written for another file)."""
    path = _book_path(output, TIMELINE_SIDECAR_SUFFIX)
    doc = read_json_file(path, max_bytes=_TIMELINE_MAX_BYTES) if path else None
    return doc if isinstance(doc, dict) and doc.get("output") == output else None


def _remove_book_derivatives(out_path: str) -> None:
    """Remove what was derived from a finished book — its timeline and its
    HTML export — before a new file takes the name. Best-effort."""
    for suffix in (TIMELINE_SIDECAR_SUFFIX, HTML_EXPORT_SUFFIX):
        with contextlib.suppress(OSError):
            os.remove(out_path + suffix)


@router.get("/audiobook/timeline/{output}")
def audiobook_timeline(output: str) -> dict:
    """The rendered timeline of a finished book in the outputs folder: where
    each phrase is heard (see ``services.audiobook.book_timeline``). 404 when
    the book has none — rendered before timelines were kept — so the reader
    falls back to estimated timing."""
    doc = _read_book_timeline(output)
    if doc is None:
        raise HTTPException(status_code=404, detail="No timeline for that output")
    return doc


_LANG_TAG_RE = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$")


class AudiobookHtmlExportRequest(BaseModel):
    output: str
    title: str = Field(default="", max_length=500)
    # Book tags as the render took them ({author, narrator, …}).
    metadata: dict[str, str | None] | None = None
    cover_path: str | None = None
    # The script the book was rendered from and each of its chapters' length
    # in seconds (None: failed, so not in the file). Read only for a book
    # rendered without a timeline, to estimate one.
    text: str | None = None
    chapter_durations: list[float | None] | None = None
    # The app's language (an HTML lang tag) and direction, and the page's
    # words in that language.
    lang: str = Field(default="en", max_length=35)
    direction: Literal["ltr", "rtl"] = "ltr"
    labels: dict[str, str] | None = None
    # The language of the book's text (an HTML lang tag); "" when not known.
    book_lang: str = Field(default="", max_length=35)


def _html_export_dir() -> str:
    # The app's own data folder, not the shared system temp: a fixed name in
    # a world-writable directory could be pre-created or linked by another
    # local user, who would then read or swap the book on its way out.
    from core.config import DATA_DIR

    return os.path.join(DATA_DIR, HTML_EXPORT_DIRNAME)


def _remove_quietly(path: str) -> None:
    with contextlib.suppress(OSError):
        os.remove(path)


def _prune_html_exports(directory: str, max_age_s: float | None = _HTML_EXPORT_STALE_S) -> None:
    """Remove the exports in ``directory`` nobody downloaded that are older
    than ``max_age_s`` (``None``: all of them). Best-effort."""
    cutoff = None if max_age_s is None else time.time() - max_age_s
    with contextlib.suppress(OSError), os.scandir(directory) as entries:
        for entry in entries:
            with contextlib.suppress(OSError):
                if entry.is_file() and (cutoff is None or entry.stat().st_mtime < cutoff):
                    os.remove(entry.path)


def sweep_html_exports() -> None:
    """Remove every HTML export an earlier run left — a full copy of a book
    each, from a download that never finished or a crash. Run at start-up,
    before the export routes are served, so no export of this run is pending."""
    _prune_html_exports(_html_export_dir(), max_age_s=None)


@router.post("/audiobook/export/html")
async def audiobook_export_html(req: AudiobookHtmlExportRequest) -> dict:
    """Export a finished book as a web page: a ZIP holding ``index.html`` —
    one self-contained page that reads the book along with its audio —
    ``audio/<book>`` and the cover. It waits in the app's data folder under
    ``id`` until ``GET /audiobook/export/html/{id}`` downloads it, once, or
    ``DELETE`` discards it."""
    from core.config import OUTPUTS_DIR
    from services.audiobook_html import (
        audio_name,
        chapter_title,
        estimated_timeline,
        labels_for,
        render_page,
        write_export_zip,
    )
    from services.audiobook import timeline_with_layout
    from services.ffmpeg_utils import probe_duration

    audio_path = _book_path(req.output)
    legacy_zip = _book_path(req.output, HTML_EXPORT_SUFFIX)
    if audio_path is None or legacy_zip is None or not os.path.isfile(audio_path):
        raise HTTPException(status_code=404, detail="No such audiobook")
    # An earlier version kept the export beside the book, a second copy of it.
    _remove_quietly(legacy_zip)
    timeline = _read_book_timeline(req.output)
    if timeline is None and req.text:
        durations = req.chapter_durations
        total = None
        if durations is None:
            total = await probe_duration(audio_path, allowed_root=OUTPUTS_DIR)
        timeline = estimated_timeline(req.output, req.text, chapter_durations=durations,
                                      duration=total)
    elif timeline is not None and req.text:
        # A book timed before phrases kept their line and paragraph breaks
        # takes them from the script it was rendered from.
        timeline = await asyncio.to_thread(timeline_with_layout, timeline, req.text)
    meta = req.metadata or {}
    chapters = [c for c in (timeline or {}).get("chapters") or [] if isinstance(c, dict)]
    labels = labels_for(req.labels)
    # The page names an untitled opening in its own words, never as the title.
    named = next((c for c in chapters if not c.get("untitled") and c.get("title")), None)
    title = (req.title.strip() or (meta.get("title") or "").strip()
             or (chapter_title(named, 1, labels) if named else "") or req.output)
    cover = _safe_cover_path(req.cover_path)
    cover_entry = f"cover{os.path.splitext(cover)[1].lower()}" if cover else None
    entry = f"audio/{audio_name(req.output)}"
    page = render_page(
        title=title, timeline=timeline, audio_src=entry, labels=labels,
        author=(meta.get("author") or "").strip(), narrator=(meta.get("narrator") or "").strip(),
        cover_src=cover_entry, lang=req.lang if _LANG_TAG_RE.fullmatch(req.lang) else "en",
        direction=req.direction,
        book_lang=req.book_lang if _LANG_TAG_RE.fullmatch(req.book_lang) else "",
        duration=float((timeline or {}).get("duration") or 0))
    directory = _html_export_dir()
    os.makedirs(directory, exist_ok=True)
    _prune_html_exports(directory)
    export_id = uuid.uuid4().hex
    zip_path = os.path.join(directory, f"{export_id}.zip")
    size = await asyncio.to_thread(write_export_zip, zip_path, page=page, audio_path=audio_path,
                                   audio_entry=entry, cover_path=cover, cover_entry=cover_entry)
    return {"id": export_id, "bytes": size}


@router.get("/audiobook/export/html/{export_id}")
def audiobook_export_html_download(export_id: str) -> FileResponse:
    """Download an HTML export once: it is removed once it has been sent."""
    path = os.path.join(_html_export_dir(), f"{export_id}.zip")
    if not _HTML_EXPORT_ID_RE.fullmatch(export_id) or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="No such export")
    return FileResponse(path, media_type="application/zip",
                        background=BackgroundTask(_remove_quietly, path))


@router.delete("/audiobook/export/html/{export_id}")
def audiobook_export_html_discard(export_id: str) -> dict:
    """Discard an HTML export that will not be downloaded: its save was
    cancelled or failed. One already gone is not an error."""
    if not _HTML_EXPORT_ID_RE.fullmatch(export_id):
        raise HTTPException(status_code=404, detail="No such export")
    _remove_quietly(os.path.join(_html_export_dir(), f"{export_id}.zip"))
    return {"deleted": export_id}


async def _public_longform_stream(plan, **render_kwargs):
    """Keep generator diagnostics local if setup fails before its own guard."""
    try:
        # aclosing: closing this stream must finalize the renderer now, not
        # whenever the garbage collector gets to it, so its job is retired
        # before the response is considered finished (#2536).
        async with contextlib.aclosing(_render_longform_sse(plan, **render_kwargs)) as events:
            async for event in events:
                yield event
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        from core.public_errors import public_failure

        error = public_failure(
            logger,
            "Longform response stream failed",
            exc,
            response="Render failed; check the backend log for details.",
        )
        yield f"data: {json.dumps({'type': 'error', 'error': error})}\n\n"


@router.post("/audiobook")
async def audiobook_synthesize(req: AudiobookRequest, request: Request = None):
    """Synthesize a chapterized audiobook from a script, streaming SSE progress."""
    plan = parse_audiobook_script(req.text, default_voice=req.default_voice)
    # `request` is injected by FastAPI on the HTTP path (the default only applies
    # to a direct in-process call, e.g. a unit test); its disconnect poll is what
    # lets Stop cancel the render mid-book (#1216).
    return StreamingResponse(
        _public_longform_stream(
            plan, default_voice=req.default_voice, language=req.language,
            fmt=req.format, bitrate=req.bitrate,
            loudness=req.loudness, cover_path=req.cover_path, metadata=req.metadata,
            lexicon=req.lexicon, opts=_expressive_opts(req), voice_map=req.voice_map,
            job_type="audiobook", project_id=req.project_id,
            is_disconnected=request.is_disconnected if request is not None else None,
        ),
        media_type="text/event-stream",
    )


# ── Shared longform render: Stories (and any future front door) post a plan ──

class LongformSpan(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    voice_id: str | None = None
    text: str
    pause_ms_after: int = 0
    speed: float | None = None
    # Set by the parser only where inline markup split one run of text.
    join: Literal["continue", "paragraph"] | None = None
    # A [volume] passage's gain in dB (the parser clamps it to ±12; so does
    # synthesis).
    gain_db: float | None = Field(default=None, ge=-MAX_LEVEL_GAIN_DB, le=MAX_LEVEL_GAIN_DB)


class LongformChapter(BaseModel):
    title: str = ""
    spans: list[LongformSpan] = []


class LongformRenderRequest(ExpressiveMixin):
    chapters: list[LongformChapter] = []
    default_voice: str | None = None
    language: str | None = None        # None/"Auto" → profile language, else autodetect (#505)
    bitrate: str = "128k"
    format: str = "m4b"
    loudness: str | None = None
    cover_path: str | None = None
    metadata: dict | None = None
    lexicon: dict | None = None
    # Cast map {[voice:NAME] → profile id} (#1217); absent/empty = today's render.
    voice_map: dict[str, str] | None = None
    # The editor's library project (see AudiobookRequest.project_id).
    project_id: str | None = Field(default=None, max_length=64)


def _story_chapter(chapter: LongformChapter, index: int = 0):
    """Chapter ``index`` of a posted plan as the render reads it, or ``None``
    when it holds nothing to render: a span is kept if it has text to speak
    or a pause to render (pause-only spans carry the silence between lines)."""
    from services.audiobook import Chapter, Span

    spans = [Span(voice_id=s.voice_id, text=(s.text or "").strip(),
                  pause_ms_after=max(0, int(s.pause_ms_after)), speed=s.speed,
                  join=s.join, gain_db=s.gain_db or None)
             for s in chapter.spans if ((s.text and s.text.strip()) or s.pause_ms_after > 0)]
    if not spans:
        return None
    return Chapter(title=chapter.title or f"Chapter {index + 1}", spans=spans,
                   untitled=not chapter.title)


@router.post("/longform/render")
async def longform_render(req: LongformRenderRequest, request: Request = None):
    """Render a pre-built chapter/span plan (the Stories Editor's compiled
    cast+lines) through the shared chapterized renderer — same resume, loudness,
    cover, metadata, and output formats as the Audiobook job."""
    from services.audiobook import AudiobookPlan

    if len(req.chapters) > _MAX_CHAPTERS:
        raise HTTPException(status_code=422, detail=f"too many chapters (max {_MAX_CHAPTERS})")

    chapters = [chapter for chapter in (_story_chapter(c, i) for i, c in enumerate(req.chapters))
                if chapter is not None]
    plan = AudiobookPlan(chapters=chapters)
    return StreamingResponse(
        _public_longform_stream(
            plan, default_voice=req.default_voice, language=req.language,
            fmt=req.format, bitrate=req.bitrate,
            loudness=req.loudness, cover_path=req.cover_path, metadata=req.metadata,
            lexicon=req.lexicon, opts=_expressive_opts(req), voice_map=req.voice_map,
            job_type="story", project_id=req.project_id,
            is_disconnected=request.is_disconnected if request is not None else None,
        ),
        media_type="text/event-stream",
    )


class LongformTakesRequest(ExpressiveMixin):
    """One chapter of a posted plan (one of ``/longform/render``'s
    ``chapters``: a Stories chapter) with the inputs that render reads it
    with — what ``/longform/takes`` lists the phrase takes of."""

    chapter: LongformChapter
    default_voice: str | None = None
    language: str | None = None
    lexicon: dict | None = None
    voice_map: dict[str, str] | None = None


class LongformRetakeRequest(LongformTakesRequest):
    """``/longform/takes``' request plus the take to render anew, as
    :class:`AudiobookRetakeRequest` names it."""

    span: int = Field(ge=0)
    take: int = Field(ge=0)
    phrase: str | None = Field(default=None, max_length=2000)


def _posted_chapter(req: LongformTakesRequest):
    """``req.chapter`` as the render reads it; 400 when it has nothing to read."""
    chapter = _story_chapter(req.chapter)
    if chapter is None:
        raise HTTPException(status_code=400, detail="nothing to read in this chapter")
    return chapter


@router.post("/longform/takes")
async def longform_takes(req: LongformTakesRequest) -> dict:
    """``/audiobook/takes`` for a chapter of a posted plan (Stories): its
    phrase takes as ``/longform/render`` cuts them, for "retake this
    sentence" (``/longform/retake``). Renders nothing."""
    chapter = _posted_chapter(req)
    takes, _cache_dir = await _chapter_takes(chapter, req)
    return _takes_reply(chapter, takes)


@router.post("/longform/retake")
async def longform_retake(req: LongformRetakeRequest) -> dict:
    """``/audiobook/retake`` for a chapter of a posted plan (Stories): the
    next ``/longform/render`` renders that take anew and reuses every other."""
    takes, cache_dir = await _chapter_takes(_posted_chapter(req), req)
    return await _ask_again(req, takes, cache_dir)


# ── Durable resume: interrupted longform renders ────────────────────────────


def _chapters_done(job_id: str) -> int:
    """Count chapters that finished rendering, from the job's persisted events.
    Best-effort (0 if unavailable) — used only to show resume progress."""
    try:
        from core import job_store
        n = 0
        for ev in job_store.events_since(job_id, 0, limit=100_000):
            try:
                if json.loads(ev["payload"]).get("type") == "chapter":
                    n += 1
            except (ValueError, KeyError, TypeError):
                continue
        return n
    except Exception:
        return 0


@router.get("/audiobook/jobs")
def list_resumable_jobs() -> dict:
    """List interrupted longform renders that can be resumed — a work dir that
    still holds a resume manifest (a job left mid-render by a crash/quit). The
    ids come from scanning the filesystem, so the UI can offer one-click resume."""
    from core import job_store

    out = []
    for e in longform_resume.scan_resumable():
        jid = e["job_id"]
        manifest = longform_resume.load_manifest_file(e["manifest_path"]) or {}
        job = job_store.get(jid) or {}
        out.append({
            "job_id": jid,
            "type": e["job_type"],
            "status": job.get("status", "interrupted"),
            "title": manifest.get("title", ""),
            "total_chapters": manifest.get("total_chapters", 0),
            "chapters_done": _chapters_done(jid),
            "created_at": job.get("created_at"),
            # The book it renders, so Resume finishes it there and nowhere else.
            "project_id": _project_token(manifest.get("project_id") or job.get("project_id")),
        })
    return {"jobs": out}


@router.post("/audiobook/resume/{job_id}")
async def resume_longform(job_id: str, request: Request = None):
    """Resume an interrupted longform render from its persisted manifest. The
    already-rendered chapters are content-addressed in the shared cache, so they
    return instantly — only the unrendered chapters synthesize again. Streams the
    same SSE event shape as the original render, under a fresh job_id."""
    from services.audiobook import AudiobookPlan, Chapter, Span

    # Find the requested job among the trusted filesystem scan (every path there
    # is os.listdir-sourced, never request input) and read its manifest via the
    # scan's own trusted path — the request job_id is used ONLY to *select* an
    # entry, never to build a path. No request-controlled value reaches a file
    # operation (CodeQL py/path-injection-safe).
    entry = next((e for e in longform_resume.scan_resumable()
                  if e["job_id"] == job_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="No resumable job for that id")
    manifest = longform_resume.load_manifest_file(entry["manifest_path"])
    if not manifest:
        raise HTTPException(status_code=404, detail="No resume manifest for that job")

    chapters = [
        Chapter(title=c.get("title", ""),
                spans=[Span(**s) for s in c.get("spans", [])],
                untitled=bool(c.get("untitled")))
        for c in manifest["plan"]
    ]
    plan = AudiobookPlan(chapters=chapters)
    p = manifest.get("params", {})
    # The response generator is lazy and checkpoint sync is best-effort. Keep
    # the original plan until rendering succeeds, even when a new checkpoint
    # was published: that write cannot confirm durability on every filesystem.
    def retire_checkpoint():
        longform_resume.discard_manifest_file(entry["manifest_path"])
    # Resume under a FRESH job id (job_id=None → a server uuid in the renderer).
    # The chapter cache is content-addressed (keyed by chapter content, not the
    # job id), so the already-rendered chapters still hit instantly — only the
    # unrendered ones synthesize. Using a fresh id means the request's job_id
    # never names a work dir / output file (defence-in-depth path-injection).
    return StreamingResponse(
        _public_longform_stream(
            plan, default_voice=p.get("default_voice"), language=p.get("language"),
            fmt=p.get("fmt", "m4b"), bitrate=p.get("bitrate", "128k"),
            loudness=p.get("loudness"), cover_path=p.get("cover_path"),
            metadata=p.get("metadata"), lexicon=p.get("lexicon"),
            opts=ExpressiveOptions.from_manifest(p.get("expressive")),
            voice_map=p.get("voice_map"),
            job_type=entry["job_type"],
            # The resumed job (and its checkpoint) still belongs to its book.
            project_id=_project_token(manifest.get("project_id")
                                      or _job_project(entry["job_id"])),
            on_completed=retire_checkpoint,
            is_disconnected=request.is_disconnected if request is not None else None,
        ),
        media_type="text/event-stream",
    )
