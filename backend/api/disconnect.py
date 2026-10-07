"""Stop a request's work the moment its client goes away.

Starlette never cancels the handler of a plain (non-streaming) response when
its client disconnects: it only notices when it sends the response, after the
work is done. A preview the user stopped kept its GPU worker rendering every
take to the end, and its render trace said "complete".

:func:`cancel_on_disconnect` runs the work as a task and looks at the
connection while it runs. Once the client is gone it cancels the work — the
GPU-pool guard abandons its job, whose cancellation scope stops it before its
next take (``services.inference_cancellation``) — ends the request's render
trace as ``cancelled`` and answers 499, to nobody. A streaming response needs
none of this: Starlette cancels its generator when the client disconnects.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import TypeVar

from fastapi import HTTPException, Request

logger = logging.getLogger("omnivoice.api")

T = TypeVar("T")

#: How often a request looks at its connection while its work runs: well
#: under one take, so a Stop frees the GPU once the take in progress ends.
DISCONNECT_POLL_S = 0.25

#: What a request its client gave up on answers ("client closed request").
CLIENT_CLOSED_REQUEST = 499


async def client_gone(is_disconnected: Callable[[], Awaitable[bool]]) -> bool:
    """Whether the client went away; a probe that fails proves nothing."""
    try:
        return bool(await is_disconnected())
    except Exception:  # noqa: BLE001 — a failed probe must not stop the work
        return False


def cancel_task(task: asyncio.Future) -> None:
    """Cancel ``task`` unless it is done, and never leave its outcome unread
    (no "exception was never retrieved" for a task nobody awaits any more)."""
    if not task.done():
        task.cancel()
    task.add_done_callback(_read_outcome)


def _read_outcome(task: asyncio.Future) -> None:
    if not task.cancelled():
        task.exception()


async def cancel_on_disconnect(request: Request | None, work: Awaitable[T], *,
                               poll_s: float = DISCONNECT_POLL_S) -> T:
    """Await ``work``; cancel it once ``request``'s client disconnects.

    Returns what the work returns and raises what it raises. When the client
    goes away first, the work is cancelled and left to unwind (the pool guard
    abandons its job before the request's own cleanup runs), the request's
    render trace ends ``cancelled`` and :class:`HTTPException` 499 is raised.
    ``request`` ``None`` — an in-process call — only awaits the work.
    """
    task = asyncio.ensure_future(work)
    if request is None:
        return await task
    try:
        while True:
            done, _pending = await asyncio.wait({task}, timeout=poll_s)
            if done:
                return task.result()
            if await client_gone(request.is_disconnected):
                break
    finally:
        cancel_task(task)
    await asyncio.gather(task, return_exceptions=True)
    from core import render_trace

    render_trace.cancel_current()
    logger.info("%s %s: the client went away, so its work was cancelled",
                request.method, request.url.path)
    raise HTTPException(status_code=CLIENT_CLOSED_REQUEST,
                        detail="The client closed the request.")
