"""Live source: the Hermes kanban, mapped into the contract's snapshot / events / commands.

The kanban stays the source of truth. Nothing is stored here except a diff baseline and a bounded event log:

  * a project is one non-archived board, its id the bare slug; a card is a non-archived task, id ``"<board>:<task>"``;
  * kanban has no epic concept (parents and children are links), so ``epics`` is empty and ``epic_id`` is null;
  * kanban cards link no files, so ``docs`` is empty;
  * a worker is one *running* task with an active run, id ``"<board>:r<run_id>"``; its state is ``working`` while the
    claim is live and ``unknown`` once it has expired. ``looping`` and ``waiting_human`` cannot be derived from the
    source, so they are never emitted (a blocked card says ``blocked_on`` instead);
  * ``claimed_by`` is set only for a running task with an active run, never inferred from the assignee profile;
  * ``paused`` is always false (no pause source);
  * events are produced by diffing the database on each poll against the last model and numbering the differences
    with our own ``seq``; the epoch is new for every process, so a restart makes clients resync. A change the events
    cannot express (a board appears or disappears or is renamed) bumps ``seq`` and raises the resync floor.

Reads open each board's existing database read-only (sqlite ``mode=ro``, bounded busy wait): they never initialise,
migrate, repair or create a database, a lock file or a schema, and a board without a database is simply absent. Each
board is read inside ONE read transaction, so its tasks, events and comments are a single consistent snapshot (a
comment is never seen without its card). One thing SQLite itself does and a reader cannot avoid: opening an existing
WAL-mode database may create its ``-wal`` and ``-shm`` sidecar files next to it (not when the directory is read-only,
where the open fails and the poll raises instead). Those are the only files a read can create; the database file is
never written. ``immutable=1`` would avoid them but is unsafe on a database that changes, so it is not used. Board names (from
``FOUNDRY_BOARDS`` or a card id) must be canonical lowercase slugs that Hermes lists, before any path is formed.
Commands write through Hermes's own functions, and only to a listed board that already has a database.

The module imports ``hermes_cli`` lazily, so importing it on a Hermes without the kanban modules raises at
``from_env`` and ``make_source`` reports that instead of faking live data.
"""

from __future__ import annotations

import collections
import copy
import importlib
import importlib.util
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .reducer import apply_snapshot, make_cursor, parse_cursor, to_snapshot

STATUS_DISPLAY = {"triage": "open", "todo": "open", "scheduled": "open", "ready": "open",
                  "running": "running", "blocked": "blocked", "review": "review", "done": "done"}
LOG_LIMIT = 2000
COMMENT_AUTHOR = "foundry"
READ_BUSY_MS = 2000  # a read waits at most this long for a writer; then it raises instead of hanging the poll
BOARD_SLUG = re.compile(r"^[a-z0-9][a-z0-9\-_]{0,63}$")  # Hermes's canonical board slug: lowercase, no path characters


def parse_boards(raw: list[str] | None) -> list[str] | None:
    """Validate a FOUNDRY_BOARDS list: canonical lowercase slugs, no duplicates. Raises ValueError otherwise."""
    if raw is None:
        return None
    seen: set[str] = set()
    for name in raw:
        if not isinstance(name, str) or not BOARD_SLUG.match(name):
            raise ValueError(f"invalid board name {name!r}: use the lowercase board slug (a-z, 0-9, '-', '_')")
        if name in seen:
            raise ValueError(f"duplicate board name {name!r}")
        seen.add(name)
    return list(raw)


def _rfc3339(epoch: int | float | None) -> str:
    return datetime.fromtimestamp(epoch or 0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class LiveSource:
    mode = "live"

    def __init__(self, boards: list[str] | None = None, min_interval: float = 0.5) -> None:
        self._kb = importlib.import_module("hermes_cli.kanban_db")
        self._connect = importlib.import_module("hermes_cli.kanban_db_connect").connect
        self._boards_mod = importlib.import_module("hermes_cli.kanban_db_boards")
        self._workflow = importlib.import_module("hermes_cli.kanban_workflow").DEFAULT_WORKFLOW
        self._only = parse_boards(boards)
        self._min = min_interval
        self._lock = threading.RLock()
        self.epoch = "live-" + secrets.token_hex(4)
        self._seq = 0
        self._floor = 0  # a client whose cursor seq is below this must resync
        self._log: collections.deque[dict[str, Any]] = collections.deque()
        self._model: dict[str, Any] | None = None
        self._last_comment: dict[str, int] = {}
        self._checked = float("-inf")

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "LiveSource":
        raw = (env.get("FOUNDRY_BOARDS") or "").strip()
        boards = [b.strip() for b in raw.split(",") if b.strip()] or None
        src = cls(boards=boards)
        missing = [b for b in (boards or []) if b not in src._discovered()]
        if missing:
            raise ValueError(f"FOUNDRY_BOARDS names no such board: {', '.join(missing)}")
        src.snapshot()  # fail now, not on the first poll, if the kanban cannot be read
        return src

    # -- reads --------------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            self._refresh()
            snap = {"v": 1, "mode": "live", **copy.deepcopy(self._model or {}), "paused": False}
            state = apply_snapshot({**snap, "epoch": self.epoch, "last_seq": self._seq})
            return to_snapshot(state) | {"mode": "live"}

    def events(self, since: str | None, epoch: str | None = None) -> dict[str, Any]:
        with self._lock:
            self._refresh()
            head = make_cursor(self.epoch, self._seq)
            parsed = parse_cursor(since)
            stale = (parsed is None or parsed[0] != self.epoch or parsed[1] > self._seq or parsed[1] < self._floor
                     or (epoch is not None and epoch != self.epoch))
            if stale:
                return {"v": 1, "epoch": self.epoch, "cursor": head, "events": [], "resync": True}
            return {"v": 1, "epoch": self.epoch, "cursor": head, "resync": False,
                    "events": copy.deepcopy([e for e in self._log if e["seq"] > parsed[1]])}

    def transcript(self, worker_id: str, limit: int = 50, before: int | None = None) -> dict[str, Any]:
        # The kanban gives no per-worker transcript; the contract lets the live source omit it.
        raise KeyError(worker_id)

    # -- commands -----------------------------------------------------------
    def command(self, cmd: dict[str, Any]) -> dict[str, Any]:
        try:
            handler = getattr(self, "_cmd_" + str(cmd.get("type", "")), None)
            if handler is None or cmd["type"] not in ("assign", "set_status", "comment"):
                return {"ok": False, "error": f"unknown command: {cmd.get('type')}"}
            card_id = cmd.get("card_id")
            board, _, task_id = card_id.partition(":") if isinstance(card_id, str) else ("", "", "")
            if not board or not task_id:
                return {"ok": False, "error": "card_id must be '<board>:<task>'"}
            if board not in self._slugs():  # only a real, listed board ever reaches connect(): no path-shaped names
                return {"ok": False, "error": f"unknown board: {board}"}
            if not self._kb.kanban_db_path(board=board).is_file():  # connect() would create it; a command never does
                return {"ok": False, "error": f"board has no database: {board}"}
            conn = self._connect(board=board)
            try:
                if self._kb.get_task(conn, task_id) is None:
                    return {"ok": False, "error": f"unknown card: {card_id}"}
                result = handler(conn, board, task_id, cmd)
            finally:
                conn.close()
        except Exception as exc:  # health: allow BLE001 -- a command never raises into the router; it reports
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        with self._lock:
            self._checked = float("-inf")  # the next read sees the change at once
        return result

    def _cmd_assign(self, conn: Any, board: str, task_id: str, cmd: dict[str, Any]) -> dict[str, Any]:
        profile = cmd.get("profile")
        if not isinstance(profile, str) or not profile.strip():
            return {"ok": False, "error": "profile must be a non-empty string"}
        if not self._kb.assign_task(conn, task_id, profile.strip()):  # assigns a profile; it does not claim
            return {"ok": False, "error": "assignment refused (the card may be running)"}
        return {"ok": True}

    def _cmd_comment(self, conn: Any, board: str, task_id: str, cmd: dict[str, Any]) -> dict[str, Any]:
        text = cmd.get("text")
        if not isinstance(text, str) or not text.strip():
            return {"ok": False, "error": "text must be a non-empty string"}
        self._kb.add_comment(conn, task_id, COMMENT_AUTHOR, text.strip())
        return {"ok": True}

    def _cmd_set_status(self, conn: Any, board: str, task_id: str, cmd: dict[str, Any]) -> dict[str, Any]:
        target = cmd.get("status_native")
        current = self._kb.get_task(conn, task_id).status
        allowed = self._workflow.manual.get(current, frozenset())
        if not isinstance(target, str) or target not in allowed or target == "archived":
            return {"ok": False, "error": f"{current} -> {target} is not a manual move; allowed: "
                                          f"{', '.join(sorted(allowed - {'archived'})) or 'none'}"}
        api = self._kanban_router()
        try:
            api.update_task(task_id, api.UpdateTaskBody(status=target), board=board)
        except Exception as exc:  # fastapi.HTTPException carries the workflow's reason in .detail
            return {"ok": False, "error": str(getattr(exc, "detail", None) or exc)}
        return {"ok": True}

    @staticmethod
    def _kanban_router() -> Any:
        """The stock kanban dashboard module, so a status move runs the stock PATCH logic (parents, runs, events)."""
        mod = sys.modules.get("hermes_dashboard_plugin_kanban")
        if mod is not None:
            return mod
        import hermes_cli
        path = Path(hermes_cli.__file__).resolve().parent.parent / "plugins" / "kanban" / "dashboard" / "plugin_api.py"
        spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_kanban", path)
        if spec is None or spec.loader is None or not path.exists():
            raise RuntimeError("the stock kanban router is not installed")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod  # pydantic resolves string annotations through sys.modules
        try:
            spec.loader.exec_module(mod)
        except Exception:
            sys.modules.pop(spec.name, None)
            raise
        return mod

    # -- the diff -----------------------------------------------------------
    def _refresh(self) -> None:
        now = time.monotonic()
        if self._model is not None and now - self._checked < self._min:
            return
        self._checked = now
        new, comments = self._read()
        if self._model is None:  # first read: the baseline, no history
            self._model = new
            self._last_comment = {b: c[0] for b, c in comments.items()}
            return
        old = self._model
        emitted: list[tuple[str, dict[str, Any]]] = []
        if self._shape(old) != self._shape(new):
            self._seq += 1  # unrepresentable: no event, but clients below this seq must refetch
            self._floor = self._seq
        old_cards = {c["id"]: c for p in old["projects"] for c in p["cards"]}
        new_cards = {c["id"]: c for p in new["projects"] for c in p["cards"]}
        old_w = {w["id"]: w for w in old["workers"]}
        new_w = {w["id"]: w for w in new["workers"]}
        for wid in sorted(new_w):
            if old_w.get(wid) != new_w[wid]:
                emitted.append(("worker_upsert", {"worker": new_w[wid]}))
        for cid in sorted(new_cards):
            if old_cards.get(cid) != new_cards[cid]:
                emitted.append(("card_upsert", {"card": new_cards[cid]}))
        for cid in sorted(set(old_cards) - set(new_cards)):
            emitted.append(("card_removed", {"card_id": cid}))
        for board in sorted(comments):
            for cid, author, text in comments[board][1]:
                if f"{board}:{cid}" in new_cards:
                    emitted.append(("comment_added", {"card_id": f"{board}:{cid}", "author": author, "text": text}))
        for wid in sorted(set(old_w) - set(new_w)):
            emitted.append(("worker_removed", {"worker_id": wid}))
        ts = _rfc3339(time.time())
        for typ, payload in emitted:
            self._seq += 1
            self._log.append({"seq": self._seq, "ts": ts, "type": typ, "payload": payload})
        while len(self._log) > LOG_LIMIT:
            self._floor = max(self._floor, self._log.popleft()["seq"])
        self._model = new
        self._last_comment.update({b: c[0] for b, c in comments.items()})

    @staticmethod
    def _shape(model: dict[str, Any]) -> list[tuple[str, str]]:
        return [(p["id"], p["name"]) for p in model["projects"]]

    def _discovered(self) -> list[str]:
        """Non-archived boards Hermes lists, canonical slugs only. Nothing outside this list is ever opened."""
        return [b["slug"] for b in self._boards_mod.list_boards(include_archived=False)
                if isinstance(b.get("slug"), str) and BOARD_SLUG.match(b["slug"])]

    def _slugs(self) -> list[str]:
        found = self._discovered()
        if self._only is None:
            return found
        return [s for s in found if s in self._only]  # a filtered name that is not (or no longer) a board is absent

    def _open_ro(self, slug: str) -> sqlite3.Connection | None:
        """Open an existing board DB read-only, inside an open read transaction (the caller closes the connection,
        which ends it): no schema init, migration, repair or lock file, bounded wait. None when the board has no database yet (or no kanban schema), so a read never creates anything."""
        path = self._kb.kanban_db_path(board=slug)
        if not path.is_file():
            return None
        # isolation_level=None: no implicit transactions; we BEGIN explicitly and hold one snapshot for the whole board.
        conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=READ_BUSY_MS / 1000.0,
                               isolation_level=None)
        try:
            conn.execute(f"PRAGMA busy_timeout={READ_BUSY_MS}")
            conn.execute("BEGIN")  # deferred: the first SELECT below fixes the snapshot; every later read sees it
            conn.row_factory = sqlite3.Row
            lossy = getattr(self._kb, "_lossy_text", None)
            if lossy is not None:
                conn.text_factory = lossy
            if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").fetchone() is None:
                conn.close()
                return None
        except BaseException:
            conn.close()
            raise
        return conn

    def _read(self) -> tuple[dict[str, Any], dict[str, tuple[int, list[tuple[str, str, str]]]]]:
        """(model, {board: (max comment id, [(task_id, author, text) newer than the last seen])})."""
        projects, workers = [], []
        comments: dict[str, tuple[int, list[tuple[str, str, str]]]] = {}
        now = time.time()
        for slug in self._slugs():
            conn = self._open_ro(slug)
            if conn is None:
                continue
            try:
                tasks = self._kb.list_tasks(conn, include_archived=False, order_by=None)
                touched = {r[0]: r[1] for r in conn.execute(
                    "SELECT task_id, MAX(created_at) FROM task_events GROUP BY task_id")}
                last = self._last_comment.get(slug)
                rows = conn.execute(
                    "SELECT id, task_id, author, body FROM task_comments ORDER BY id").fetchall()
                top = rows[-1][0] if rows else 0
                comments[slug] = (top, [] if last is None else [(r[1], r[2], r[3]) for r in rows if r[0] > last])
                cards = []
                for t in sorted(tasks, key=lambda t: t.id):
                    active = t.status == "running" and t.current_run_id is not None
                    wid = f"{slug}:r{t.current_run_id}" if active else None
                    if wid:
                        # Only "working" or "unknown" are ever emitted here. "looping" and "waiting_human" cannot be
                        # derived from the kanban (it records no loop or human-wait state per worker), so the live
                        # source never says them; a blocked card says blocked_on instead.
                        live = t.claim_expires is None or t.claim_expires > now
                        workers.append({"id": wid, "name": t.assignee or f"run {t.current_run_id}",
                                        "state": "working" if live else "unknown", "card_id": f"{slug}:{t.id}"})
                    cards.append({
                        "id": f"{slug}:{t.id}", "title": t.title, "epic_id": None,
                        "status": STATUS_DISPLAY.get(t.status, "unknown"), "status_native": t.status,
                        "assignee_profile": t.assignee or None, "claimed_by": wid,
                        "blocked_on": "human" if t.status == "blocked" and t.block_kind == "needs_input" else None,
                        "docs": [],
                        "updated_at": _rfc3339(max(touched.get(t.id) or 0, t.created_at or 0)),
                    })
                meta = self._boards_mod.read_board_metadata(slug)
                projects.append({"id": slug, "name": meta.get("name") or slug, "epics": [], "cards": cards})
            finally:
                conn.close()
        return {"projects": projects, "workers": sorted(workers, key=lambda w: w["id"])}, comments
