"""The shared reducer: snapshot + ordered events -> state. Pure; no I/O; no clock.

State is a plain dict::

    {"snapshot": <contract snapshot without epoch/cursor/last_seq>, "epoch": str, "seq": int, "resync": bool}

``seq`` is the watermark: the snapshot's ``last_seq``, raised as events apply.
Rules (docs/contract.md, draft 3, "Events"):
  * events apply in seq order; an event with seq <= the watermark is a duplicate or replay and is ignored;
  * seq need not be contiguous: there is no gap detection (completeness is the server's job, via resync);
  * events carry whole objects (card_upsert, worker_upsert), so applying one is a replace;
  * ``claimed_by`` on a card is the single source of ownership; after every event each worker's
    ``card_id`` is recomputed from the cards, so the two cannot disagree;
  * an event naming a card the snapshot lacks, or a board/epic it cannot place a card under, sets ``resync``
    and stops applying: the caller must refetch the snapshot;
  * unknown event types advance the watermark and leave state unchanged (forward compatible);
  * a reset is a new epoch, not an event.
The cursor is opaque to clients; on the server side it is ``"<epoch>.<seq>"``.
Every function returns new state and never mutates its input.
"""

from __future__ import annotations

import copy
from typing import Any, Iterable

EVENT_TYPES = ("card_upsert", "card_removed", "comment_added", "worker_upsert", "worker_removed", "paused")
# Display statuses (contract). "unknown" is a native status that maps to nothing.
CARD_STATUSES = ("open", "running", "blocked", "review", "done", "unknown")
WORKER_STATES = ("working", "waiting_human", "looping", "idle", "unknown")


def make_cursor(epoch: str, seq: int) -> str:
    return f"{epoch}.{seq}"


def parse_cursor(cursor: str | None) -> tuple[str, int] | None:
    """Return (epoch, seq), or None when the cursor is absent or malformed. Server-side only."""
    if not isinstance(cursor, str) or "." not in cursor:
        return None
    epoch, _, seq = cursor.rpartition(".")
    if not epoch or not seq.isdigit():
        return None
    return epoch, int(seq)


def apply_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Build state from a snapshot. A snapshot without an epoch or an integer ``last_seq`` yields ``resync`` state."""
    epoch, last_seq = snapshot.get("epoch"), snapshot.get("last_seq")
    ok = isinstance(epoch, str) and bool(epoch) and isinstance(last_seq, int) and not isinstance(last_seq, bool) \
        and last_seq >= 0
    snap = copy.deepcopy({k: v for k, v in snapshot.items() if k not in ("cursor", "epoch", "last_seq")})
    snap.setdefault("projects", [])
    snap.setdefault("workers", [])
    snap.setdefault("paused", False)
    _derive_worker_cards(snap)
    return {"snapshot": snap, "epoch": epoch if ok else "", "seq": last_seq if ok else 0, "resync": not ok}


def to_snapshot(state: dict[str, Any]) -> dict[str, Any]:
    """The contract snapshot (epoch, cursor, last_seq) for a state."""
    out = copy.deepcopy(state["snapshot"])
    out["epoch"] = state["epoch"]
    out["cursor"] = make_cursor(state["epoch"], state["seq"])
    out["last_seq"] = state["seq"]
    return out


def apply_event(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    """Apply one event to a copy of ``state``."""
    return apply_events(state, [event])


def apply_events(state: dict[str, Any], events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Apply events in seq order. Duplicates are ignored; a bad reference sets resync."""
    new = copy.deepcopy(state)
    if new["resync"]:
        return new
    for ev in sorted(events, key=lambda e: e["seq"]):
        if ev["seq"] <= new["seq"]:
            continue
        if not _apply(new["snapshot"], ev):
            new["resync"] = True
            break
        _derive_worker_cards(new["snapshot"])
        new["seq"] = ev["seq"]
    return new


# --- internals -------------------------------------------------------------

def _locate(snap: dict[str, Any], card_id: Any) -> tuple[dict[str, Any], int] | None:
    for p in snap["projects"]:
        for i, c in enumerate(p["cards"]):
            if c["id"] == card_id:
                return p, i
    return None


def _derive_worker_cards(snap: dict[str, Any]) -> None:
    held: dict[str, str] = {}
    for p in snap["projects"]:
        for c in p["cards"]:
            if c.get("claimed_by") and c["claimed_by"] not in held:
                held[c["claimed_by"]] = c["id"]
    for w in snap["workers"]:
        w["card_id"] = held.get(w["id"])


def _apply(snap: dict[str, Any], ev: dict[str, Any]) -> bool:
    """Mutate ``snap`` (already a private copy). False means a bad reference: caller resyncs."""
    t, p = ev.get("type"), ev.get("payload") or {}
    if t == "card_upsert":
        card = p.get("card")
        if not isinstance(card, dict) or not isinstance(card.get("id"), str):
            return False
        board = card["id"].partition(":")[0]  # a project is one board; its id is the bare slug
        proj = next((x for x in snap["projects"] if x["id"] == board), None)
        if proj is None:
            return False
        epic = card.get("epic_id")
        if epic is not None and not any(e["id"] == epic for e in proj.get("epics", [])):
            return False  # a new epic is not expressible as an event: refetch
        found = _locate(snap, card["id"])
        if found:
            found[0]["cards"][found[1]] = copy.deepcopy(card)
        else:
            proj["cards"].append(copy.deepcopy(card))
        return True
    if t == "card_removed":
        found = _locate(snap, p.get("card_id"))
        if found:  # removing a card the snapshot never had is a no-op
            del found[0]["cards"][found[1]]
        return True
    if t == "comment_added":
        return _locate(snap, p.get("card_id")) is not None  # comments are not in the snapshot
    if t == "worker_upsert":
        w = p.get("worker")
        if not isinstance(w, dict) or not isinstance(w.get("id"), str):
            return False
        for i, old in enumerate(snap["workers"]):
            if old["id"] == w["id"]:
                snap["workers"][i] = copy.deepcopy(w)
                break
        else:
            snap["workers"].append(copy.deepcopy(w))
        return True
    if t == "worker_removed":
        snap["workers"] = [w for w in snap["workers"] if w["id"] != p.get("worker_id")]
        return True
    if t == "paused":
        snap["paused"] = bool(p.get("paused"))
        return True
    return True  # unknown future type: the watermark advances, state is unchanged
