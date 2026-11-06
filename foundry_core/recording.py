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
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .fixture import FixtureSource, page_transcript
from .reducer import CARD_STATUSES, EVENT_TYPES, WORKER_STATES, apply_events, apply_snapshot, make_cursor, parse_cursor, to_snapshot

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


def _int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


MAX_SEQ = 10 ** 15 - 1  # parse_cursor accepts at most 15 digits; a larger seq would make every cursor unreadable
TRANSCRIPT_ROLES = ("user", "assistant", "tool")
TRANSCRIPT_TEXT_MAX = 2000  # contract: each transcript line's text is cut to 2000 characters
BOARD_SLUG = re.compile(r"[a-z0-9][a-z0-9\-_]{0,63}")  # contract: a project id is a bare board slug, never with ':'
# Contract status mapping (display from native). Anything else is passed through with status "unknown";
# "archived" cards are omitted from the feed, so a recording may not contain one.
NATIVE_TO_STATUS = {"triage": "open", "todo": "open", "scheduled": "open", "ready": "open",
                    "running": "running", "blocked": "blocked", "review": "review", "done": "done"}


def _str_or_none(v: Any) -> bool:
    return v is None or isinstance(v, str)


def _check_stamp(where: str, v: Any) -> None:
    """RFC3339 with an offset that converts to a UTC instant (0001-01-01T00:00:00+01:00 does not)."""
    try:
        if not isinstance(v, str):
            raise ValueError("not a string")
        dt = datetime.fromisoformat(v.strip().replace("Z", "+00:00").replace("z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError("no offset")
        when = dt.astimezone(timezone.utc).timestamp()
        if not math.isfinite(when):
            raise ValueError("not finite")
    except (ValueError, OverflowError, OSError) as exc:
        raise ValueError(f"{where}: {v!r} is not an RFC3339 timestamp with an offset in a usable range") from exc


def _check_card(where: str, card: Any, board: str | None = None) -> None:
    """A full contract card (draft 4). ``board``, when given, is the project the card must belong to."""
    if not isinstance(card, dict):
        raise ValueError(f"{where}: a card must be an object")
    for key in ("id", "title", "status_native", "updated_at"):
        if not isinstance(card.get(key), str):
            raise ValueError(f"{where}: card needs a string {key}")
    cid = card["id"]
    if ":" not in cid or not cid.partition(":")[0] or not cid.partition(":")[2]:
        raise ValueError(f"{where}: card id {cid!r} is not '<board>:<id>'")
    if board is not None and cid.partition(":")[0] != board:
        raise ValueError(f"{where}: card id {cid!r} is not in project {board!r}")
    if card.get("status") not in CARD_STATUSES:
        raise ValueError(f"{where}: card status must be one of {', '.join(CARD_STATUSES)}")
    native = card["status_native"]
    if native == "archived":
        raise ValueError(f"{where}: archived cards are omitted from the feed, so a card may not be archived")
    if card["status"] != NATIVE_TO_STATUS.get(native, "unknown"):
        raise ValueError(f"{where}: status {card['status']!r} does not match status_native {native!r} "
                         f"(the contract maps it to {NATIVE_TO_STATUS.get(native, 'unknown')!r})")
    for key in ("epic_id", "assignee_profile", "claimed_by"):
        if key not in card or not _str_or_none(card[key]):
            raise ValueError(f"{where}: card {key} must be a string or null")
    if "blocked_on" not in card or card["blocked_on"] not in (None, "human"):
        raise ValueError(f"{where}: card needs blocked_on, 'human' or null")
    docs = card.get("docs")
    if not isinstance(docs, list) or not all(isinstance(d, dict) and isinstance(d.get("path"), str)
                                             and isinstance(d.get("title"), str) for d in docs):
        raise ValueError(f"{where}: card docs must be a list of objects with a string path and title")
    _check_stamp(f"{where}.updated_at", card["updated_at"])


def _check_worker(where: str, w: Any) -> None:
    """A full contract worker (draft 4)."""
    if not isinstance(w, dict):
        raise ValueError(f"{where}: a worker must be an object")
    for key in ("id", "name"):
        if not isinstance(w.get(key), str):
            raise ValueError(f"{where}: worker needs a string {key}")
    if not w["id"].partition(":")[0] or not w["id"].partition(":")[2]:
        raise ValueError(f"{where}: worker id {w['id']!r} is not '<board>:<id>' or 'fx:<n>'")
    if w.get("state") not in WORKER_STATES:
        raise ValueError(f"{where}: worker state must be one of {', '.join(WORKER_STATES)}")
    if "card_id" not in w or not _str_or_none(w["card_id"]):
        raise ValueError(f"{where}: worker card_id must be a string or null")


def _check_payload(where: str, etype: str, payload: dict[str, Any]) -> None:
    """The payload each event type carries (draft 4 events table)."""
    if etype == "card_upsert":
        _check_card(f"{where} payload.card", payload.get("card"))
    elif etype == "worker_upsert":
        _check_worker(f"{where} payload.worker", payload.get("worker"))
    elif etype == "card_removed":
        if not isinstance(payload.get("card_id"), str):
            raise ValueError(f"{where}: card_removed needs a string card_id")
    elif etype == "worker_removed":
        if not isinstance(payload.get("worker_id"), str):
            raise ValueError(f"{where}: worker_removed needs a string worker_id")
    elif etype == "comment_added":
        if not all(isinstance(payload.get(k), str) for k in ("card_id", "author", "text")):
            raise ValueError(f"{where}: comment_added needs a string card_id, author and text")
    elif etype == "paused":
        if not isinstance(payload.get("paused"), bool):
            raise ValueError(f"{where}: paused needs a boolean paused")


def _check_base_snapshot(snap: dict[str, Any]) -> None:
    """The recording's first snapshot: contract shape, unique ids, cards in their own project and epic."""
    if snap.get("v") != 1 or snap.get("mode") != "fixture" or not isinstance(snap.get("paused"), bool):
        raise ValueError('recording base snapshot needs v 1, mode "fixture" and a boolean paused')
    for key in ("projects", "workers"):
        if not isinstance(snap.get(key), list):
            raise ValueError(f"recording base snapshot has no {key} list")
    seen: set[str] = set()

    def fresh(where: str, ident: str) -> None:
        if ident in seen:
            raise ValueError(f"{where}: duplicate id {ident!r}")
        seen.add(ident)

    for pi, proj in enumerate(snap["projects"]):
        where = f"base snapshot projects[{pi}]"
        if not isinstance(proj, dict) or not isinstance(proj.get("id"), str) \
                or not BOARD_SLUG.fullmatch(proj["id"]) or not isinstance(proj.get("name"), str) or not isinstance(proj.get("cards"), list) \
                or not isinstance(proj.get("epics"), list):
            raise ValueError(f"{where} needs a board-slug id (a-z, 0-9, '-' or '_'), a string name, an epics list and a cards list")
        fresh(where, proj["id"])
        epics: set[str] = set()
        for ei, ep in enumerate(proj["epics"]):
            if not isinstance(ep, dict) or not isinstance(ep.get("id"), str) or not isinstance(ep.get("title"), str):
                raise ValueError(f"{where}.epics[{ei}] needs a string id and title")
            if ep["id"].partition(":")[0] != proj["id"] or not ep["id"].partition(":")[2]:
                raise ValueError(f"{where}.epics[{ei}]: epic id {ep['id']!r} is not '{proj['id']}:<id>'")
            fresh(f"{where}.epics[{ei}]", ep["id"])
            epics.add(ep["id"])
        for ci, card in enumerate(proj["cards"]):
            cwhere = f"{where}.cards[{ci}]"
            _check_card(cwhere, card, board=proj["id"])
            fresh(cwhere, card["id"])
            if card["epic_id"] is not None and card["epic_id"] not in epics:
                raise ValueError(f"{cwhere}: epic_id {card['epic_id']!r} is not an epic of {proj['id']!r}")
    for wi, w in enumerate(snap["workers"]):
        _check_worker(f"base snapshot workers[{wi}]", w)
        fresh(f"base snapshot workers[{wi}]", w["id"])
    derived = {w["id"]: w["card_id"] for w in apply_snapshot({**snap, "epoch": "validate", "last_seq": 0})
               ["snapshot"]["workers"]}
    for wi, w in enumerate(snap["workers"]):  # contract: the snapshot's worker card_id must match the derivation
        if w["card_id"] != derived[w["id"]]:
            raise ValueError(f"base snapshot workers[{wi}]: card_id {w['card_id']!r} does not match the cards that "
                             f"claim {w['id']!r} (the derivation gives {derived[w['id']]!r})")


def _check_lines(where: str, lines: Any, last: int) -> int:
    """Transcript lines: dicts with an int ``seq`` strictly ascending above ``last``. Returns the new last seq."""
    if not isinstance(lines, list):
        raise ValueError(f"{where}: transcript lines must be a list")
    for i, ln in enumerate(lines):
        if not isinstance(ln, dict) or not _int(ln.get("seq")) or not isinstance(ln.get("text"), str) \
                or not isinstance(ln.get("role"), str):
            raise ValueError(f"{where}[{i}]: a transcript line needs an int seq and string role and text")
        if len(ln["text"]) > TRANSCRIPT_TEXT_MAX:
            raise ValueError(f"{where}[{i}]: transcript text is {len(ln['text'])} characters; "
                             f"the contract allows {TRANSCRIPT_TEXT_MAX}")
        if ln["role"] not in TRANSCRIPT_ROLES:
            raise ValueError(f"{where}[{i}]: transcript role must be one of {', '.join(TRANSCRIPT_ROLES)}")
        if ln["seq"] > MAX_SEQ:
            raise ValueError(f"{where}[{i}]: transcript seq {ln['seq']} is above {MAX_SEQ}")
        if ln["seq"] <= last:
            raise ValueError(f"{where}[{i}]: transcript seq {ln['seq']} is not above {last}")
        last = ln["seq"]
    return last


def validate_recording(rec: Any) -> None:
    """Raise ValueError unless ``rec`` can be played end to end.

    Checks the shape of the base snapshot, base transcripts and every step, then dry-runs all steps through the
    reducer exactly as playback will, so a recording that loads never fails later at request time.
    """
    if not isinstance(rec, dict) or rec.get("kind") != "foundry-recording" or rec.get("v") != RECORDING_VERSION:
        raise ValueError(f"not a v{RECORDING_VERSION} foundry recording")
    base = rec.get("base")
    if not isinstance(base, dict):
        raise ValueError("recording has no base (a dict with snapshot and transcripts)")
    snap, transcripts = base.get("snapshot"), base.get("transcripts")
    if not isinstance(snap, dict):
        raise ValueError("recording base has no snapshot")
    _check_base_snapshot(snap)
    if not isinstance(transcripts, dict):
        raise ValueError("recording base has no transcripts dict")
    last_line: dict[str, int] = {}
    for wid, lines in transcripts.items():
        last_line[wid] = _check_lines(f"base transcripts[{wid!r}]", lines, 0)
    steps = rec.get("steps")
    if not isinstance(steps, list):
        raise ValueError("recording has no steps list")
    watermark = 0
    for si, step in enumerate(steps):
        if not isinstance(step, dict) or not isinstance(step.get("command"), dict) \
                or not isinstance(step.get("events"), list) or not isinstance(step.get("transcript"), dict):
            raise ValueError(f"step {si} needs a command dict, an events list and a transcript dict")
        for ei, ev in enumerate(step["events"]):
            where = f"step {si} event {ei}"
            if not isinstance(ev, dict) or not _int(ev.get("seq")) or ev.get("type") not in EVENT_TYPES \
                    or not isinstance(ev.get("payload"), dict):
                raise ValueError(f"{where}: needs an int seq, a known type and a payload dict")
            if ev["seq"] > MAX_SEQ:
                raise ValueError(f"{where}: seq {ev['seq']} is above {MAX_SEQ}")
            _check_stamp(f"{where}.ts", ev.get("ts"))
            _check_payload(where, ev["type"], ev["payload"])
            if ev["seq"] <= watermark:
                raise ValueError(f"{where}: seq {ev['seq']} is not above {watermark} (events must ascend across steps)")
            watermark = ev["seq"]
        for wid, lines in step["transcript"].items():
            last_line[wid] = _check_lines(f"step {si} transcript[{wid!r}]", lines, last_line.get(wid, 0))
    # Dry run: apply every step the way playback does and demand no resync.
    probe = copy.deepcopy(snap)
    probe["epoch"], probe["last_seq"] = "validate", 0
    try:
        state = apply_snapshot(probe)
        if state["resync"]:
            raise ValueError("base snapshot does not load")
        for si, step in enumerate(steps):
            state = apply_events(state, step["events"])
            if state["resync"]:
                raise ValueError(f"step {si} does not apply to the state before it: {step['command']}")
        to_snapshot(state)
    except ValueError:
        raise
    except Exception as exc:  # whatever the reducer trips on (overflow, a bad type) is an unplayable recording
        raise ValueError(f"recording does not replay: {type(exc).__name__}: {exc}") from exc


def load(path: str | Path | None = None) -> dict[str, Any]:
    """Read and fully validate a recording. Every failure is a ValueError or OSError with a clear message."""
    where = path or BUNDLED
    try:
        rec = json.loads(Path(where).read_text())
    except RecursionError as exc:
        raise ValueError(f"not a v{RECORDING_VERSION} foundry recording: {where} (nested too deeply)") from exc
    try:
        validate_recording(rec)
    except ValueError as exc:
        raise ValueError(f"{where}: {exc}") from exc
    return rec


def check_step_seconds(value: Any) -> float:
    """The playback pace: a finite number of seconds above zero. nan, inf, 0 and negatives are refused."""
    try:
        step = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"step_seconds is not a number: {value!r}") from exc
    if not math.isfinite(step) or step <= 0:
        raise ValueError(f"step_seconds must be a finite number above 0, got {value!r}")
    return step


class ReplaySource:
    """Same interface as the fixture and live sources; plays a recording on the wall clock."""

    mode = "fixture"

    def __init__(self, recording: dict[str, Any], step_seconds: float = 2.0, epoch_prefix: str = "rp",
                 clock: Callable[[], float] = time.monotonic) -> None:
        validate_recording(recording)
        self._rec = copy.deepcopy(recording)  # validated once; later edits by the caller cannot break playback
        self._step_seconds = check_step_seconds(step_seconds)
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
        elapsed = self._clock() - self._t0
        if not math.isfinite(elapsed) or elapsed <= 0:  # a stalled, backwards or broken clock releases nothing
            due = 0
        elif elapsed >= total * self._step_seconds:  # compare before dividing: a tiny pace would overflow the quotient
            due = total
        else:
            due = min(total, int(elapsed / self._step_seconds))
        while self._applied < due:
            step = self._rec["steps"][self._applied]
            self._state = apply_events(self._state, step["events"])
            if self._state["resync"]:  # unreachable for a validated recording
                raise RuntimeError(f"recording step {self._applied} does not apply: {step['command']}")
            self._log.extend(copy.deepcopy(step["events"]))
            for wid, lines in step["transcript"].items():
                self._transcripts.setdefault(wid, []).extend(copy.deepcopy(lines))
            self._applied += 1
