"""A recorded fixture session and its replay through the same feed (bead mk-q6lxl).

``record(steps)`` drives a fresh ``FixtureSource`` with a fixed command list and captures the start state, the
events each command produced, and the transcript lines it added. The result is plain JSON
(``foundry_core/session.json`` is the bundled one; ``scripts/record_session.py`` regenerates it).

``ReplaySource`` serves that recording through the ordinary source interface: the same snapshot, the same events
envelope, the same reducer. It releases one recorded step per ``step_seconds`` of wall clock, so a pane that only
polls sees the factory move on its own. It needs no model, no credentials and no fixture code at replay time, so
it still plays if the fixture's scripted behaviour later changes. Commands other than ``reset`` are refused
(``reset`` restarts the playback under a new epoch). This is an optional ambient demo; the interactive fixture
stays the primary one. Contract draft 4 is unchanged: replay reports ``mode: "fixture"`` (it is simulated).
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Any, Callable

from .fixture import FixtureSource, page_transcript
from .reducer import apply_events, apply_snapshot, make_cursor, parse_cursor, to_snapshot

BUNDLED = Path(__file__).resolve().parent / "session.json"
RECORDING_VERSION = 1

# The demo story, in order. Ids are contract ids; every step must succeed on the fixture (record() checks).
DEMO_STEPS: list[dict[str, Any]] = [
    {"type": "assign", "card_id": "atlas:t04", "profile": "reviewer"},
    {"type": "comment", "card_id": "atlas:t08", "text": "Refunds over 30 days go to the manual queue."},
    {"type": "message", "worker_id": "fx:3", "text": "You are repeating the proration test; skip it and read the diff."},
    {"type": "claim", "card_id": "atlas:t07", "worker_id": "fx:4"},
    {"type": "new_worker", "card_id": "harbor:t18"},
    {"type": "set_status", "card_id": "lumen:t30", "status_native": "done"},
    {"type": "stand", "on": True},
    {"type": "stand", "on": False},
    {"type": "set_status", "card_id": "atlas:t03", "status_native": "blocked"},
]


def record(steps: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Run ``steps`` on a fresh fixture and return the recording. Raises if any command is refused."""
    steps = DEMO_STEPS if steps is None else steps
    fx = FixtureSource(epoch_prefix="rec")
    base = fx.snapshot()
    worker_ids = [w["id"] for w in base["workers"]]
    transcripts = {w: fx.transcript(w, limit=200)["lines"] for w in worker_ids}
    base_transcripts = copy.deepcopy(transcripts)
    cursor, out = base["cursor"], []
    for cmd in steps:
        res = fx.command(copy.deepcopy(cmd))
        if not res.get("ok"):
            raise ValueError(f"recording step refused: {cmd} -> {res}")
        feed = fx.events(cursor)
        assert not feed["resync"]
        cursor = feed["cursor"]
        added: dict[str, list[dict[str, Any]]] = {}
        for w in [x["id"] for x in fx.snapshot()["workers"]]:
            have = len(transcripts.get(w, []))
            lines = fx.transcript(w, limit=200)["lines"]
            if len(lines) > have:
                added[w] = lines[have:]
                transcripts[w] = lines
        out.append({"command": copy.deepcopy(cmd), "events": feed["events"], "transcript": added})
    return {"v": RECORDING_VERSION, "kind": "foundry-recording",
            "base": {"snapshot": base, "transcripts": base_transcripts}, "steps": out}


def load(path: str | Path | None = None) -> dict[str, Any]:
    rec = json.loads(Path(path or BUNDLED).read_text())
    if not isinstance(rec, dict) or rec.get("kind") != "foundry-recording" or rec.get("v") != RECORDING_VERSION:
        raise ValueError(f"not a v{RECORDING_VERSION} foundry recording: {path or BUNDLED}")
    return rec


class ReplaySource:
    """Same interface as the fixture and live sources; plays a recording on the wall clock."""

    mode = "fixture"

    def __init__(self, recording: dict[str, Any], step_seconds: float = 2.0, epoch_prefix: str = "rp",
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._rec = recording
        self._step_seconds = float(step_seconds)
        self._prefix = epoch_prefix
        self._clock = clock
        self._generation = 0
        self._start()

    @property
    def epoch(self) -> str:
        return f"{self._prefix}-{self._generation}"

    # -- source interface ---------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        self._advance()
        return to_snapshot(self._state)

    def events(self, since: str | None, epoch: str | None = None) -> dict[str, Any]:
        self._advance()
        seq = self._state["seq"]
        head = make_cursor(self.epoch, seq)
        parsed = parse_cursor(since)
        if (parsed is None or parsed[0] != self.epoch or parsed[1] > seq
                or (epoch is not None and epoch != self.epoch)):
            return {"v": 1, "epoch": self.epoch, "cursor": head, "events": [], "resync": True}
        return {"v": 1, "epoch": self.epoch, "cursor": head, "resync": False,
                "events": copy.deepcopy([e for e in self._log if e["seq"] > parsed[1]])}

    def transcript(self, worker_id: str, limit: int = 50, before: int | None = None) -> dict[str, Any]:
        self._advance()
        known = worker_id in self._transcripts or any(w["id"] == worker_id for w in self._state["snapshot"]["workers"])
        if not known:
            raise KeyError(worker_id)  # a worker with no lines yet is served as empty, like the fixture
        return page_transcript(self._transcripts.get(worker_id, []), limit, before)

    def command(self, cmd: dict[str, Any]) -> dict[str, Any]:
        if isinstance(cmd, dict) and cmd.get("type") == "reset":
            self._start()
            return {"ok": True}
        return {"ok": False, "error": "replaying a recorded session; only reset (restart) is accepted"}

    @property
    def finished(self) -> bool:
        self._advance()
        return self._applied >= len(self._rec["steps"])

    # -- internals ----------------------------------------------------------
    def _start(self) -> None:
        self._generation += 1
        base = copy.deepcopy(self._rec["base"]["snapshot"])
        base["epoch"], base["last_seq"] = self.epoch, 0
        self._state = apply_snapshot(base)
        self._transcripts = copy.deepcopy(self._rec["base"]["transcripts"])
        self._log: list[dict[str, Any]] = []
        self._applied = 0
        self._t0 = self._clock()

    def _advance(self) -> None:
        total = len(self._rec["steps"])
        if self._step_seconds <= 0:
            due = total
        else:
            due = min(total, int((self._clock() - self._t0) / self._step_seconds))
        while self._applied < due:
            step = self._rec["steps"][self._applied]
            self._state = apply_events(self._state, step["events"])
            assert not self._state["resync"], f"recording step {self._applied} does not apply: {step['command']}"
            self._log.extend(copy.deepcopy(step["events"]))
            for wid, lines in step["transcript"].items():
                self._transcripts.setdefault(wid, []).extend(copy.deepcopy(lines))
            self._applied += 1
