"""Foundry backend routes, mounted by Hermes at /api/plugins/foundry/.

Loaded by path, so the plugin root is put on sys.path before importing foundry_core.
Handlers are plain ``def`` (Hermes runs them in a worker thread) so a slow kanban read
never blocks the gateway's event loop.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Any

_ROOT = str(Path(__file__).resolve().parent.parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from fastapi import APIRouter, Body, HTTPException, Query  # noqa: E402

from foundry_core.service import make_source, run_command  # noqa: E402

router = APIRouter()
_lock = threading.Lock()       # guards creating the source
_call_lock = threading.RLock()  # the sources are not thread-safe: one call at a time
_source: Any = None


def _get_source() -> Any:
    global _source
    with _lock:
        if _source is None:
            try:
                _source = make_source()
            except RuntimeError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
        return _source


@router.get("/snapshot")
def snapshot() -> dict[str, Any]:
    with _call_lock:
        return _get_source().snapshot()


@router.get("/events")
def events(since: str | None = Query(None), epoch: str | None = Query(None)) -> dict[str, Any]:
    with _call_lock:
        return _get_source().events(since, epoch)


@router.get("/transcript")
def transcript(worker_id: str = Query(...), limit: int = Query(50, ge=1),
               before: int | None = Query(None)) -> dict[str, Any]:
    with _call_lock:
        src = _get_source()
        fn = getattr(src, "transcript", None)
        if fn is None:
            raise HTTPException(status_code=404, detail="this source gives no transcripts")
        try:
            return fn(worker_id, limit, before)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"no such worker: {worker_id}") from None


@router.post("/command")
def command(body: Any = Body(...)) -> dict[str, Any]:
    with _call_lock:
        return run_command(_get_source(), body)
