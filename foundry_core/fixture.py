"""The fixture state machine: a deterministic stand-in for a live factory. No model calls, no credentials.

Each command has a scripted response. State changes go through the shared reducer
(one definition of how events change state); commands only decide which events to emit.
A failed command emits nothing and changes nothing. ``reset`` restores the start state.
"""

from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
from typing import Any

from . import fixture_data as fd
from .reducer import (CARD_STATUSES, apply_events, apply_snapshot, make_cursor, parse_cursor, to_snapshot)

EPOCH = "fx"


class FixtureSource:
    """Same interface as the live source: snapshot(), events(since), command(cmd)."""

    mode = "fixture"

    def __init__(self) -> None:
        self._events: list[dict[str, Any]] = []
        self._seq = 0
        self._tick = 0
        self._comments: dict[str, list[dict[str, str]]] = {}
        self._state = self._fresh_state()

    # -- source interface ---------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        return to_snapshot(self._state)

    def events(self, since: str | None) -> dict[str, Any]:
        """Envelope {"v","cursor","events","resync"}. resync means refetch the snapshot."""
        head = make_cursor(EPOCH, self._seq)
        parsed = parse_cursor(since)
        if parsed is None or parsed[0] != EPOCH or parsed[1] > self._seq:
            return {"v": 1, "cursor": head, "events": [], "resync": True}
        return {"v": 1, "cursor": head, "resync": False,
                "events": copy.deepcopy([e for e in self._events if e["seq"] > parsed[1]])}

    def comments(self, card_id: str) -> list[dict[str, str]]:
        return list(self._comments.get(card_id, []))

    def command(self, cmd: dict[str, Any]) -> dict[str, Any]:
        handler = getattr(self, "_cmd_" + str(cmd.get("type", "")), None) if isinstance(cmd, dict) else None
        if handler is None:
            return {"ok": False, "error": f"unknown command: {cmd.get('type') if isinstance(cmd, dict) else cmd!r}"}
        try:
            evs = handler(cmd)
        except _Reject as r:
            return {"ok": False, "error": str(r)}
        self._emit(evs)
        return {"ok": True}

    # -- internals ----------------------------------------------------------
    def _fresh_state(self) -> dict[str, Any]:
        snap = fd.initial_snapshot()
        snap["cursor"] = make_cursor(EPOCH, self._seq)
        return apply_snapshot(snap)

    def _now(self) -> str:
        self._tick += 1
        t = datetime(2026, 11, 6, tzinfo=timezone.utc) + timedelta(seconds=self._tick)
        return t.strftime("%Y-%m-%dT%H:%M:%SZ")

    def _emit(self, evs: list[tuple[str, dict[str, Any]]]) -> None:
        for typ, payload in evs:
            self._seq += 1
            ts = self._now()
            if typ in ("card_status", "card_assigned", "card_commented"):
                payload = {**payload, "updated_at": ts}
            ev = {"seq": self._seq, "ts": ts, "type": typ, "payload": payload}
            self._events.append(ev)
            self._state = apply_events(self._state, [ev])
            assert not self._state["resync"], f"fixture emitted an invalid event: {ev}"

    # lookups on the current state
    def _card(self, card_id: Any) -> dict[str, Any]:
        for p in self._state["snapshot"]["projects"]:
            for c in p["cards"]:
                if c["id"] == card_id:
                    return c
        raise _Reject(f"no such card: {card_id}")

    def _worker(self, worker_id: Any) -> dict[str, Any]:
        for w in self._state["snapshot"]["workers"]:
            if w["id"] == worker_id:
                return w
        raise _Reject(f"no such worker: {worker_id}")

    def _worker_holding(self, card_id: str) -> dict[str, Any] | None:
        return next((w for w in self._state["snapshot"]["workers"] if w["card_id"] == card_id), None)

    def _status_ev(self, card_id: str, status: str, blocked_on: str | None = None) -> tuple[str, dict[str, Any]]:
        return "card_status", {"card_id": card_id, "status": status, "blocked_on": blocked_on}

    def _assign_ev(self, card_id: str, worker_id: str | None) -> tuple[str, dict[str, Any]]:
        return "card_assigned", {"card_id": card_id, "worker_id": worker_id}

    # -- commands (each returns the events it wants emitted, or raises _Reject) ----
    def _cmd_assign(self, cmd: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        card = self._card(cmd.get("card_id"))
        if card["status"] == "done":
            raise _Reject("card is done")
        if card["status"] == "blocked":
            raise _Reject("card is blocked on a human; comment on it first")
        if self._state["snapshot"]["paused"]:
            raise _Reject("paused: ring stand off first")
        target = cmd.get("worker_id")
        evs: list[tuple[str, dict[str, Any]]] = []
        if target == "new":
            workers = self._state["snapshot"]["workers"]
            if len(workers) >= fd.MAX_WORKERS:
                raise _Reject("no free climber slots")
            n_new = len(workers) - 4
            wid = f"w{len(workers) + 1}"
            name = fd.NEW_WORKER_NAMES[n_new % len(fd.NEW_WORKER_NAMES)]
            evs.append(("worker_state", {"worker_id": wid, "name": name, "state": "idle", "card_id": None}))
        else:
            worker = self._worker(target)
            wid = worker["id"]
            if worker.get("state") == "waiting_human":
                raise _Reject("worker is waiting on a human")
            if card["assignee"] == wid:
                return []  # already held: a no-op
        if card["assignee"] and card["assignee"] != wid:
            evs.append(("worker_state", {"worker_id": card["assignee"], "state": "idle", "card_id": None}))
        previous = None if target == "new" else self._worker(wid)["card_id"]
        if previous and previous != card["id"]:
            evs += [self._status_ev(previous, "open"), self._assign_ev(previous, None)]
        evs.append(self._assign_ev(card["id"], wid))
        if card["id"] in fd.FIX_ON_ASSIGN:  # scripted: the fix lands, the scale turns to stone, the climber is free
            evs += [self._status_ev(card["id"], "done"), self._assign_ev(card["id"], None),
                    ("worker_state", {"worker_id": wid, "state": "idle", "card_id": None})]
            return evs
        evs += [self._status_ev(card["id"], "claimed"),
                ("worker_state", {"worker_id": wid, "state": "working", "card_id": card["id"]})]
        return evs

    def _cmd_set_status(self, cmd: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        card = self._card(cmd.get("card_id"))
        status = cmd.get("status")
        if status not in CARD_STATUSES:
            raise _Reject(f"bad status: {status!r}")
        if status == card["status"]:
            return []
        holder = self._worker_holding(card["id"])
        evs: list[tuple[str, dict[str, Any]]] = []
        if status == "open":
            evs.append(self._status_ev(card["id"], "open"))
            if card["assignee"]:
                evs.append(self._assign_ev(card["id"], None))
            if holder:
                evs.append(("worker_state", {"worker_id": holder["id"], "state": "idle", "card_id": None}))
        elif status == "claimed":
            if not card["assignee"]:
                raise _Reject("assign a worker first")
            evs.append(self._status_ev(card["id"], "claimed"))
            if holder:
                evs.append(("worker_state", {"worker_id": holder["id"], "state": "working"}))
        elif status == "blocked":
            evs.append(self._status_ev(card["id"], "blocked", "human"))
            if holder:
                evs.append(("worker_state", {"worker_id": holder["id"], "state": "waiting_human"}))
        else:  # done
            evs.append(self._status_ev(card["id"], "done"))
            if card["assignee"]:
                evs.append(self._assign_ev(card["id"], None))
            if holder:
                evs.append(("worker_state", {"worker_id": holder["id"], "state": "idle", "card_id": None}))
        return evs

    def _cmd_comment(self, cmd: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        card = self._card(cmd.get("card_id"))
        text = cmd.get("text")
        if not isinstance(text, str) or not text.strip():
            raise _Reject("empty comment")
        self._comments.setdefault(card["id"], []).append({"author": "you", "text": text})
        evs: list[tuple[str, dict[str, Any]]] = [
            ("card_commented", {"card_id": card["id"], "author": "you", "text": text})]
        if card["status"] == "blocked" and card["blocked_on"] == "human":  # scripted: the answer unblocks it
            evs.append(self._status_ev(card["id"], "claimed" if card["assignee"] else "open"))
            holder = self._worker_holding(card["id"])
            if holder:
                evs.append(("worker_state", {"worker_id": holder["id"], "state": "working"}))
        return evs

    def _cmd_message(self, cmd: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        worker = self._worker(cmd.get("worker_id"))
        text = cmd.get("text")
        if not isinstance(text, str) or not text.strip():
            raise _Reject("empty message")
        if self._state["snapshot"]["paused"]:
            raise _Reject("paused: ring stand off first")
        evs: list[tuple[str, dict[str, Any]]] = []
        if worker.get("state") == "looping":  # scripted: the nudge breaks the loop and the task lands
            cid = worker["card_id"]
            if worker["id"] in fd.FIX_ON_MESSAGE and cid:
                evs += [self._status_ev(cid, "done"), self._assign_ev(cid, None),
                        ("worker_state", {"worker_id": worker["id"], "state": "idle", "card_id": None})]
            else:
                evs.append(("worker_state", {"worker_id": worker["id"], "state": "working"}))
        return evs

    def _cmd_stand(self, cmd: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        on = cmd.get("on")
        if not isinstance(on, bool):
            raise _Reject("stand needs on: true|false")
        if on == self._state["snapshot"]["paused"]:
            return []
        return [("paused", {"paused": on})]

    def _cmd_reset(self, cmd: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        self._comments.clear()
        snap = fd.initial_snapshot()
        snap.pop("cursor", None)
        return [("reset", {"snapshot": snap})]


class _Reject(Exception):
    """A command refused before any event was emitted."""
