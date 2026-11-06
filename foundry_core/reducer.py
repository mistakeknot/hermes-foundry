"""The shared reducer: snapshot + ordered events -> state. Pure; no I/O; no clock.

State is a plain dict::

    {"snapshot": <contract snapshot without "cursor">, "epoch": str, "seq": int, "resync": bool}

Rules (docs/contract.md, "Events"):
  * events apply in seq order; an event with seq <= state.seq is a duplicate and is ignored;
  * a gap (seq > state.seq + 1) or an event naming an unknown card/worker/project sets
    ``resync`` and stops applying: the caller must refetch the snapshot;
  * the cursor is opaque to clients; here it is ``"<epoch>.<seq>"``.
Every function returns new state and never mutates its input.
"""

from __future__ import annotations

import copy
from typing import Any, Iterable

EVENT_TYPES = (
    "card_created", "card_status", "card_assigned", "card_commented",
    "worker_state", "worker_moved", "paused", "reset",
)
CARD_STATUSES = ("open", "claimed", "blocked", "done")
WORKER_STATES = ("working", "waiting_human", "looping", "idle")


def make_cursor(epoch: str, seq: int) -> str:
    return f"{epoch}.{seq}"


def parse_cursor(cursor: str | None) -> tuple[str, int] | None:
    """Return (epoch, seq), or None when the cursor is absent or malformed."""
    if not isinstance(cursor, str) or "." not in cursor:
        return None
    epoch, _, seq = cursor.rpartition(".")
    if not epoch or not seq.isdigit():
        return None
    return epoch, int(seq)


def apply_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Build state from a snapshot. An unparseable cursor yields ``resync`` state."""
    parsed = parse_cursor(snapshot.get("cursor"))
    snap = copy.deepcopy({k: v for k, v in snapshot.items() if k != "cursor"})
    snap.setdefault("projects", [])
    snap.setdefault("workers", [])
    snap.setdefault("paused", False)
    epoch, seq = parsed if parsed else ("", 0)
    return {"snapshot": snap, "epoch": epoch, "seq": seq, "resync": parsed is None}


def to_snapshot(state: dict[str, Any]) -> dict[str, Any]:
    """The contract snapshot (with cursor) for a state."""
    out = copy.deepcopy(state["snapshot"])
    out["cursor"] = make_cursor(state["epoch"], state["seq"])
    return out


def apply_event(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    """Apply one event to a copy of ``state``."""
    return apply_events(state, [event])


def apply_events(state: dict[str, Any], events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Apply events in seq order. Duplicates are ignored; a gap or a bad reference sets resync."""
    new = copy.deepcopy(state)
    if new["resync"]:
        return new
    for ev in sorted(events, key=lambda e: e["seq"]):
        seq = ev["seq"]
        if seq <= new["seq"]:
            continue
        if seq != new["seq"] + 1:
            new["resync"] = True
            break
        if not _apply(new["snapshot"], ev):
            new["resync"] = True
            break
        new["seq"] = seq
    return new


# --- internals -------------------------------------------------------------

def _find_card(snap: dict[str, Any], card_id: str) -> dict[str, Any] | None:
    for p in snap["projects"]:
        for c in p["cards"]:
            if c["id"] == card_id:
                return c
    return None


def _find_worker(snap: dict[str, Any], worker_id: str) -> dict[str, Any] | None:
    for w in snap["workers"]:
        if w["id"] == worker_id:
            return w
    return None


def _apply(snap: dict[str, Any], ev: dict[str, Any]) -> bool:
    """Mutate ``snap`` (already a private copy). False means a bad reference: caller resyncs."""
    t, p = ev.get("type"), ev.get("payload") or {}
    if t == "card_created":
        proj = next((x for x in snap["projects"] if x["id"] == p.get("project_id")), None)
        card = p.get("card")
        if proj is None or not isinstance(card, dict) or "id" not in card:
            return False
        if _find_card(snap, card["id"]) is None:  # idempotent on re-create
            proj["cards"].append(copy.deepcopy(card))
        return True
    if t in ("card_status", "card_assigned", "card_commented"):
        card = _find_card(snap, p.get("card_id", ""))
        if card is None:
            return False
        if t == "card_status":
            card["status"] = p["status"]
            card["blocked_on"] = p.get("blocked_on")
        elif t == "card_assigned":
            card["assignee"] = p.get("worker_id")
        if "updated_at" in p:
            card["updated_at"] = p["updated_at"]
        return True
    if t == "worker_state":
        wid = p.get("worker_id")
        if not wid:
            return False
        w = _find_worker(snap, wid)
        if w is None:
            w = {"id": wid, "name": p.get("name", wid), "card_id": None}
            snap["workers"].append(w)
        if "name" in p:
            w["name"] = p["name"]
        if "card_id" in p:
            w["card_id"] = p["card_id"]
        if "state" in p:
            if p["state"] is None:  # the source cannot give a state: omit it, never guess
                w.pop("state", None)
            else:
                w["state"] = p["state"]
        return True
    if t == "worker_moved":
        w = _find_worker(snap, p.get("worker_id", ""))
        if w is None:
            return False
        w["card_id"] = p.get("card_id")
        return True
    if t == "paused":
        snap["paused"] = bool(p.get("paused"))
        return True
    if t == "reset":
        new = p.get("snapshot")
        if not isinstance(new, dict):
            return False
        snap.clear()
        snap.update(copy.deepcopy({k: v for k, v in new.items() if k != "cursor"}))
        return True
    return True  # unknown future type: seq advances, state unchanged (forward compatible)
