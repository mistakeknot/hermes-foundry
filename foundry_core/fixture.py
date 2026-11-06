"""The fixture state machine: a deterministic stand-in for a live factory. No model calls, no credentials.

Each command has a scripted response. A command edits working copies of the cards and workers it touches
(a ``_Plan``); on success the plan emits one full-object ``card_upsert`` / ``worker_upsert`` per object that
actually changed (contract draft 3), and the shared reducer applies them. A failed command emits nothing and
changes nothing. ``claimed_by`` on the card is the only ownership fact; a worker's ``card_id`` is derived from it.
``reset`` starts a new epoch. Everything here is simulated: the pane labels fixture mode "simulated".
"""

from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
from typing import Any

from . import fixture_data as fd
from .reducer import apply_events, apply_snapshot, make_cursor, parse_cursor, to_snapshot

TRANSCRIPT_CAP = 200
LINE_CHARS = 2000


class _Reject(Exception):
    """A command refused before any event was emitted."""


class _Plan:
    """Working copies of the objects one command touches. Nothing here is visible until ``FixtureSource._commit``."""

    def __init__(self, snap: dict[str, Any]) -> None:
        self._snap = snap
        self._cards: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}   # id -> (original, working)
        self._workers: dict[str, tuple[dict[str, Any] | None, dict[str, Any]]] = {}
        self.paused: bool = snap["paused"]
        self.comments: list[dict[str, str]] = []                      # {card_id, author, text}
        self.says: list[tuple[str, str, str]] = []                    # (worker_id, role, text)

    # -- reads (always through the working copy) --------------------------------
    def card(self, card_id: Any) -> dict[str, Any]:
        if not isinstance(card_id, str):
            raise _Reject("card_id must be a string")
        if card_id in self._cards:
            return self._cards[card_id][1]
        for p in self._snap["projects"]:
            for c in p["cards"]:
                if c["id"] == card_id:
                    self._cards[card_id] = (c, copy.deepcopy(c))
                    return self._cards[card_id][1]
        raise _Reject(f"no such card: {card_id}")

    def worker(self, worker_id: Any) -> dict[str, Any]:
        if not isinstance(worker_id, str):
            raise _Reject("worker_id must be a string")
        if worker_id in self._workers:
            return self._workers[worker_id][1]
        for w in self._snap["workers"]:
            if w["id"] == worker_id:
                self._workers[worker_id] = (w, copy.deepcopy(w))
                return self._workers[worker_id][1]
        raise _Reject(f"no such worker: {worker_id}")

    def worker_ids(self) -> list[str]:
        ids = [w["id"] for w in self._snap["workers"]]
        return ids + [i for i in self._workers if i not in ids]

    def add_worker(self, worker: dict[str, Any]) -> dict[str, Any]:
        self._workers[worker["id"]] = (None, worker)
        return worker

    def held_id(self, worker_id: str) -> str | None:
        """The id of the card a worker holds, read from the (working) cards' claimed_by. Does not touch anything."""
        for p in self._snap["projects"]:
            for c in p["cards"]:
                c = self._cards[c["id"]][1] if c["id"] in self._cards else c
                if c.get("claimed_by") == worker_id:
                    return c["id"]
        return None

    def held_by(self, worker_id: str) -> dict[str, Any] | None:
        """The working copy of the card a worker holds (safe to edit)."""
        cid = self.held_id(worker_id)
        return self.card(cid) if cid else None

    # -- the diff ---------------------------------------------------------------
    def changes(self) -> list[tuple[str, dict[str, Any]]]:
        """(type, payload) for every changed object, cards first. Worker card_id is derived from claimed_by."""
        out: list[tuple[str, dict[str, Any]]] = []
        for _, (orig, work) in self._cards.items():
            if orig != work:
                out.append(("card_upsert", {"card": work}))
        for wid in self.worker_ids():
            if wid in self._workers:
                orig, work = self._workers[wid]
            else:
                orig = next(w for w in self._snap["workers"] if w["id"] == wid)
                work = copy.deepcopy(orig)
            work["card_id"] = self.held_id(wid)
            if orig != work:
                out.append(("worker_upsert", {"worker": work}))
        return out


class FixtureSource:
    """Same interface as the live source: snapshot(), events(since, epoch), transcript(), command()."""

    mode = "fixture"

    def __init__(self, epoch_prefix: str = "fx") -> None:
        self._prefix = epoch_prefix  # a server restart must change this (service passes a boot token)
        self._generation = 0
        self._tick = 0
        self._start()

    # -- source interface ---------------------------------------------------
    @property
    def epoch(self) -> str:
        return f"{self._prefix}-{self._generation}"

    def snapshot(self) -> dict[str, Any]:
        return to_snapshot(self._state)  # epoch, cursor and last_seq from one state: atomic

    def events(self, since: str | None, epoch: str | None = None) -> dict[str, Any]:
        """Envelope {"v","epoch","cursor","events","resync"}. resync means refetch the snapshot."""
        head = make_cursor(self.epoch, self._seq)
        parsed = parse_cursor(since)
        stale = (parsed is None or parsed[0] != self.epoch or parsed[1] > self._seq
                 or (epoch is not None and epoch != self.epoch))
        if stale:
            return {"v": 1, "epoch": self.epoch, "cursor": head, "events": [], "resync": True}
        return {"v": 1, "epoch": self.epoch, "cursor": head, "resync": False,
                "events": copy.deepcopy([e for e in self._events if e["seq"] > parsed[1]])}

    def comments(self, card_id: str) -> list[dict[str, str]]:
        return list(self._comments.get(card_id, []))

    def transcript(self, worker_id: str, limit: int = 50, before: int | None = None) -> dict[str, Any]:
        """Contract paging: ascending seq, at most ``limit`` (cap 200), ``before`` exclusive.

        ``truncated`` is true when older lines exist; then ``next_before`` is the smallest seq returned.
        Raises KeyError for an unknown worker.
        """
        if worker_id not in self._transcripts:
            raise KeyError(worker_id)
        limit = max(1, min(int(limit), TRANSCRIPT_CAP))
        lines = [ln for ln in self._transcripts[worker_id] if before is None or ln["seq"] < before]
        page = lines[-limit:]
        truncated = len(lines) > len(page)
        return {"lines": copy.deepcopy(page), "truncated": truncated,
                "next_before": page[0]["seq"] if truncated else None}

    def command(self, cmd: dict[str, Any]) -> dict[str, Any]:
        handler = getattr(self, "_cmd_" + str(cmd.get("type", "")), None) if isinstance(cmd, dict) else None
        if handler is None:
            return {"ok": False, "error": f"unknown command: {cmd.get('type') if isinstance(cmd, dict) else cmd!r}"}
        if cmd["type"] == "reset":
            self._start()  # new epoch: every client's next poll gets resync
            return {"ok": True}
        plan = _Plan(self._state["snapshot"])
        try:
            handler(cmd, plan)
        except _Reject as r:
            return {"ok": False, "error": str(r)}
        self._commit(plan)
        return {"ok": True}

    # -- internals ----------------------------------------------------------
    def _start(self) -> None:
        """(Re)build the start state under a fresh epoch."""
        self._generation += 1
        self._tick = 0  # a reset replays the same timestamps as a fresh start (epoch aside)
        self._events: list[dict[str, Any]] = []
        self._seq = 0
        self._comments: dict[str, list[dict[str, str]]] = {}
        self._transcripts: dict[str, list[dict[str, Any]]] = {
            wid: [{"seq": i + 1, "role": role, "text": text} for i, (role, text) in enumerate(seed)]
            for wid, seed in fd.TRANSCRIPT_SEED.items()}
        snap = fd.initial_snapshot()
        snap["epoch"] = self.epoch
        snap["last_seq"] = 0
        self._state = apply_snapshot(snap)

    def _now(self) -> str:
        self._tick += 1
        t = datetime(2026, 11, 6, tzinfo=timezone.utc) + timedelta(seconds=self._tick)
        return t.strftime("%Y-%m-%dT%H:%M:%SZ")

    def _emit(self, typ: str, payload: dict[str, Any]) -> None:
        self._seq += 1
        ts = self._now()
        if typ == "card_upsert":
            payload["card"]["updated_at"] = ts  # a change stamps the card with the event time
        ev = {"seq": self._seq, "ts": ts, "type": typ, "payload": payload}
        self._events.append(ev)
        self._state = apply_events(self._state, [ev])
        assert not self._state["resync"], f"fixture emitted an invalid event: {ev}"

    def _commit(self, plan: _Plan) -> None:
        for c in plan.comments:
            self._comments.setdefault(c["card_id"], []).append({"author": c["author"], "text": c["text"]})
            self._emit("comment_added", dict(c))
        for typ, payload in plan.changes():
            self._emit(typ, copy.deepcopy(payload))
        if plan.paused != self._state["snapshot"]["paused"]:
            self._emit("paused", {"paused": plan.paused})
        for wid, role, text in plan.says:
            lines = self._transcripts.setdefault(wid, [])
            lines.append({"seq": (lines[-1]["seq"] + 1) if lines else 1, "role": role, "text": text[:LINE_CHARS]})

    # -- card helpers -------------------------------------------------------
    @staticmethod
    def _set_status(card: dict[str, Any], native: str, blocked_on: str | None = None) -> None:
        card["status_native"] = native
        card["status"] = fd.display_status(native)
        card["blocked_on"] = blocked_on

    def _release(self, plan: _Plan, card: dict[str, Any], native: str) -> None:
        """Move a card to a non-running status and free whoever held it."""
        self._set_status(card, native)
        if card["claimed_by"]:
            plan.worker(card["claimed_by"])["state"] = "idle"
            card["claimed_by"] = None

    def _take(self, plan: _Plan, card: dict[str, Any], worker_id: str) -> None:
        """Worker ``worker_id`` (known to the plan) takes ``card``."""
        worker = plan.worker(worker_id)
        previous = plan.held_by(worker_id)
        if previous is not None and previous["id"] != card["id"]:  # it drops what it held
            self._set_status(previous, "ready")
            previous["claimed_by"] = None
        if card["claimed_by"] and card["claimed_by"] != worker_id:  # it takes the card from another worker
            plan.worker(card["claimed_by"])["state"] = "idle"
        card["claimed_by"] = worker_id
        if card["id"] in fd.FIX_ON_CLAIM:  # scripted: the fix lands, the scale turns to stone, the climber is free
            self._set_status(card, "done")
            card["claimed_by"] = None
            worker["state"] = "idle"
        else:
            self._set_status(card, "running")
            worker["state"] = "working"

    @staticmethod
    def _check_workable(plan: _Plan, card: dict[str, Any]) -> None:
        if card["status"] == "done":
            raise _Reject("card is done")
        if card["status"] == "blocked":
            raise _Reject("card is blocked on a human; comment on it first")
        if plan.paused:
            raise _Reject("paused: ring stand off first")

    # -- live-capable commands ----------------------------------------------
    def _cmd_assign(self, cmd: dict[str, Any], plan: _Plan) -> None:
        """Assigns a profile only. It never claims the card."""
        card = plan.card(cmd.get("card_id"))
        profile = cmd.get("profile")
        if profile is not None and (not isinstance(profile, str) or profile not in fd.PROFILES):
            raise _Reject(f"unknown profile: {profile!r}")
        if card["status"] == "done":
            raise _Reject("card is done")
        card["assignee_profile"] = profile

    def _cmd_set_status(self, cmd: dict[str, Any], plan: _Plan) -> None:
        card = plan.card(cmd.get("card_id"))
        native = cmd.get("status_native")
        if not isinstance(native, str) or native not in fd.MANUAL_STATUSES:
            raise _Reject(f"not a manual move: {native!r}")
        if native == card["status_native"]:
            return
        if native == "blocked":
            self._set_status(card, "blocked", "human")
            if card["claimed_by"]:
                plan.worker(card["claimed_by"])["state"] = "waiting_human"
            return
        self._release(plan, card, native)

    def _cmd_comment(self, cmd: dict[str, Any], plan: _Plan) -> None:
        card = plan.card(cmd.get("card_id"))
        text = cmd.get("text")
        if not isinstance(text, str) or not text.strip():
            raise _Reject("empty comment")
        plan.comments.append({"card_id": card["id"], "author": "you", "text": text})
        if card["status"] == "blocked" and card["blocked_on"] == "human":  # scripted: the answer unblocks it
            holder = card["claimed_by"]
            self._set_status(card, "running" if holder else "ready")
            if holder:
                plan.worker(holder)["state"] = "working"
                plan.says += [(holder, "user", text), (holder, "assistant", "Thanks, continuing with that answer.")]

    # -- fixture-only commands (simulated) ----------------------------------
    def _cmd_claim(self, cmd: dict[str, Any], plan: _Plan) -> None:
        card = plan.card(cmd.get("card_id"))
        worker = plan.worker(cmd.get("worker_id"))
        self._check_workable(plan, card)
        if worker["state"] == "waiting_human":
            raise _Reject("worker is waiting on a human")
        if card["claimed_by"] == worker["id"]:
            return
        self._take(plan, card, worker["id"])

    def _cmd_new_worker(self, cmd: dict[str, Any], plan: _Plan) -> None:
        card = plan.card(cmd.get("card_id"))
        self._check_workable(plan, card)
        n = len(plan.worker_ids())
        if n >= fd.MAX_WORKERS:
            raise _Reject("no free climber slots")
        wid = f"fx:{n + 1}"
        name = fd.NEW_WORKER_NAMES[(n - 4) % len(fd.NEW_WORKER_NAMES)]
        plan.add_worker({"id": wid, "name": name, "state": "idle", "card_id": None})
        self._transcripts.setdefault(wid, [])
        self._take(plan, card, wid)

    def _cmd_message(self, cmd: dict[str, Any], plan: _Plan) -> None:
        worker = plan.worker(cmd.get("worker_id"))
        text = cmd.get("text")
        if not isinstance(text, str) or not text.strip():
            raise _Reject("empty message")
        if plan.paused:
            raise _Reject("paused: ring stand off first")
        plan.says += [(worker["id"], "user", text), (worker["id"], "assistant", "Understood.")]
        if worker["state"] != "looping":
            return
        held = plan.held_by(worker["id"])  # scripted: the nudge breaks the loop
        if worker["id"] in fd.FIX_ON_MESSAGE and held is not None:
            self._set_status(held, "done")
            held["claimed_by"] = None
            worker["state"] = "idle"
        else:
            worker["state"] = "working"

    def _cmd_stand(self, cmd: dict[str, Any], plan: _Plan) -> None:
        on = cmd.get("on")
        if not isinstance(on, bool):
            raise _Reject("stand needs on: true|false")
        plan.paused = on

    def _cmd_reset(self, _cmd: dict[str, Any], _plan: _Plan) -> None:  # handled in command(); present for dispatch
        raise AssertionError("unreachable")
