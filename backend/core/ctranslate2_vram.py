"""What a CTranslate2 Whisper load needs in VRAM, asked before it starts (#723).

whisperx, faster-whisper and the crash-isolated faster-whisper sidecar all load
Whisper through CTranslate2. A CUDA load that does not fit in the VRAM left
does not raise: CTranslate2 aborts natively and the process dies with it — the
backend for the in-process engines (no exception, no log line, "Can't reach
the local backend" in the UI), the sidecar for the isolated one, again on every
retry. The TTS model holding most of the card is the usual reason: a Clone
reference transcription loaded faster-whisper large-v3 in float16 with 0.8 GB
free and took the backend down. The only defense is never to start that load,
so each loader asks :func:`fitting_compute_types` right before it loads: its
compute-type chain from the first type that fits the VRAM free now (float16 →
int8_float16 → int8), or none, and the model loads on the CPU instead.

Stdlib-only, like ``core.cudnn8`` and ``core.execstack``: the sidecar runs with
a clean import path and must not import the heavy ``services`` package. torch
is imported only to read free VRAM, for a CUDA load.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Callable, Iterable, Optional

logger = logging.getLogger("omnivoice.asr")

#: Peak VRAM (GB) to load *and* transcribe whisper large-v3 per CTranslate2
#: compute type: weights, encoder/decoder workspace and headroom.
#: faster-whisper's own benchmark peaks at 4.5–4.8 GB in float16 and
#: 2.9–3.1 GB in int8, CUDA context included; float32 holds twice float16's
#: weights. A type missing here (``auto``, ``default``) loads as asked.
CUDA_VRAM_BUDGET_GB = {
    "float32": 9.0,
    "float16": 5.0, "bfloat16": 5.0,
    "int8_float16": 3.5, "int8_bfloat16": 3.5,
    "int8": 3.0, "int8_float32": 3.0,
}

#: The CUDA compute types a load steps down through, best first.
CUDA_LADDER = ("float16", "int8_float16", "int8")

#: Share of large-v3's budget a model needs, by a word in its name. Turbo and
#: Distil-Whisper keep large-v3's encoder under a much smaller decoder, so they
#: are matched before "large", which their names also carry.
MODEL_VRAM_SCALE = (
    ("turbo", 0.55), ("distil", 0.55), ("large", 1.0), ("medium", 0.5),
    ("small", 0.25), ("base", 0.15), ("tiny", 0.1),
)

_PATH_PARTS = re.compile(r"[\\/]+")
_SNAPSHOT_DIR = "models--"


def model_identity(model_name: object) -> str:
    """The model ``model_name`` names, as Model Catalogue names it.

    An installed snapshot directory
    (``…/models--Systran--faster-whisper-large-v3/snapshots/<revision>``) is
    its repo, ``Systran/faster-whisper-large-v3`` (Hugging Face never allows
    ``--`` inside a repo id). A repo id, a size alias or any other path is
    returned as given.
    """
    name = str(model_name or "").strip()
    for part in reversed(_PATH_PARTS.split(name)):
        if part.startswith(_SNAPSHOT_DIR) and len(part) > len(_SNAPSHOT_DIR):
            return part[len(_SNAPSHOT_DIR):].replace("--", "/")
    return name


def model_scale(model_name: object) -> float:
    """Share of large-v3's VRAM ``model_name`` needs; 1.0 when its size is
    unknown. Only the model's own name counts, never the folders above it."""
    label = _PATH_PARTS.split(model_identity(model_name))[-1].lower()
    return next((scale for word, scale in MODEL_VRAM_SCALE if word in label), 1.0)


def preflight_enabled() -> bool:
    """Off with ``OMNIVOICE_ASR_VRAM_PREFLIGHT=0`` (``false``/``no``)."""
    return os.environ.get("OMNIVOICE_ASR_VRAM_PREFLIGHT", "1").strip().lower() not in (
        "0", "false", "no")


def free_vram_gb() -> Optional[float]:
    """Device-wide free VRAM in GB (other processes count), or None when it
    cannot be read."""
    try:
        import torch

        if torch.cuda.is_available():
            free, _total = torch.cuda.mem_get_info()
            return free / 1024**3
    except Exception:  # noqa: BLE001 — the preflight must never block ASR
        pass
    return None


def fitting_compute_types(
    model_name: object,
    compute_types: Iterable[str],
    *,
    engine: str,
    free_vram: Optional[Callable[[], Optional[float]]] = None,
) -> list[str]:
    """A CUDA load's compute-type chain (best first) from the first type that
    fits the VRAM free now; ``[]`` when none fits — the model belongs on the
    CPU. The chain comes back as given with the preflight off, when free VRAM
    cannot be read, and from a type no budget sizes on (it loads as asked, as
    before the preflight). ``engine`` names the loader in the log;
    ``free_vram`` reads free VRAM (:func:`free_vram_gb` by default)."""
    chain = list(compute_types)
    if not chain or not preflight_enabled():
        return chain
    free = (free_vram or free_vram_gb)()
    if free is None:
        return chain
    scale = model_scale(model_name)
    model = model_identity(model_name)
    for index, compute_type in enumerate(chain):
        budget = CUDA_VRAM_BUDGET_GB.get(compute_type)
        if budget is None or free >= budget * scale:
            if index:
                logger.warning(
                    "%s VRAM preflight: %.1f GB free < %.1f GB needed for %s %s "
                    "— degrading to %s (#723)",
                    engine, free, CUDA_VRAM_BUDGET_GB[chain[0]] * scale, model, chain[0],
                    compute_type,
                )
            return chain[index:]
    logger.warning(
        "%s VRAM preflight: %.1f GB free is too little for %s on CUDA (needs "
        "≥%.1f GB even at %s) — loading it on the CPU instead. Free VRAM "
        "(flush the TTS model, or close other GPU apps) for GPU-speed ASR, or "
        "set OMNIVOICE_ASR_VRAM_PREFLIGHT=0 to skip this check. (#723)",
        engine, free, model, CUDA_VRAM_BUDGET_GB[chain[-1]] * scale, chain[-1],
    )
    return []
