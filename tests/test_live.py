"""Live source against a real kanban DB in a temp HERMES_HOME. No API key, no network, no model.

Needs a Hermes with the kanban boards and workflow modules (main @ b524c8a4 or later). Point FOUNDRY_HERMES_SRC at
such a checkout if the interpreter's own hermes_cli is older; otherwise the tests skip.
"""

import importlib
import os
import sys

import pytest

from foundry_core.reducer import apply_events, apply_snapshot, to_snapshot


def _need_kanban():
    src = os.environ.get("FOUNDRY_HERMES_SRC")
    if src and src not in sys.path:
        sys.path.insert(0, src)
    try:
        for m in ("hermes_cli.kanban_db", "hermes_cli.kanban_db_boards", "hermes_cli.kanban_db_connect",
                  "hermes_cli.kanban_workflow"):
            importlib.import_module(m)
    except ImportError as exc:
        pytest.skip(f"newer kanban modules not importable: {exc}")


@pytest.fixture
def kb(tmp_path, monkeypatch):
    _need_kanban()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    for k in list(os.environ):
        if k.endswith("_API_KEY"):
            monkeypatch.delenv(k)
    boards = importlib.import_module("hermes_cli.kanban_db_boards")
    boards.create_board("atlas", name="Atlas")
    boards.create_board("harbor", name="Harbor")
    return importlib.import_module("hermes_cli.kanban_db"), importlib.import_module("hermes_cli.kanban_db_connect").connect


@pytest.fixture
def src(kb):
    from foundry_core.live import LiveSource
    return LiveSource(min_interval=0)


def _mk(kb, board, title, **kw):
    mod, connect = kb
    conn = connect(board=board)
    try:
        return mod.create_task(conn, title=title, **kw)
    finally:
        conn.close()


def _do(kb, board, fn):
    mod, connect = kb
    conn = connect(board=board)
    try:
        return fn(mod, conn)
    finally:
        conn.close()


def _strip(snap):
    return {k: v for k, v in snap.items() if k not in ("epoch", "cursor", "last_seq")}


def _converge(src, state, since):
    """Pull events like the pane does and assert the client equals the server's fresh snapshot."""
    ev = src.events(since)
    assert not ev["resync"]
    state = apply_events(state, ev["events"])
    assert not state["resync"]
    assert _strip(to_snapshot(state)) == _strip(src.snapshot())
    return state, ev["cursor"]


def test_snapshot_shape_and_ids(kb, src):
    t = _mk(kb, "atlas", "First", assignee="coder")
    snap = src.snapshot()
    assert snap["mode"] == "live" and snap["v"] == 1 and snap["last_seq"] == 0
    ids = {p["id"] for p in snap["projects"]}
    assert {"atlas", "harbor"} <= ids
    atlas = next(p for p in snap["projects"] if p["id"] == "atlas")
    assert atlas["name"] == "Atlas" and atlas["epics"] == []
    card = atlas["cards"][0]
    assert card["id"] == f"atlas:{t}" and card["epic_id"] is None and card["docs"] == []
    assert card["assignee_profile"] == "coder" and card["claimed_by"] is None
    assert card["status"] == "open" and card["status_native"] in ("ready", "todo")
    assert snap["workers"] == [] and snap["paused"] is False


def test_claim_makes_worker_and_converges(kb, src):
    t = _mk(kb, "atlas", "Work", assignee="coder")
    state = apply_snapshot(src.snapshot())
    cursor = src.snapshot()["cursor"]
    _do(kb, "atlas", lambda m, c: m.claim_task(c, t))
    state, cursor = _converge(src, state, cursor)
    snap = to_snapshot(state)
    card = next(c for p in snap["projects"] for c in p["cards"] if c["id"] == f"atlas:{t}")
    assert card["status"] == "running" and card["claimed_by"].startswith("atlas:r")
    (w,) = snap["workers"]
    assert w["id"] == card["claimed_by"] and w["card_id"] == card["id"] and w["state"] == "working"
    # releasing the claim removes the worker and clears claimed_by on the client
    refused = src.command({"type": "assign", "card_id": f"atlas:{t}", "profile": "other"})
    assert refused["ok"] is False and "running" in refused["error"]  # reassigning a claimed card is refused
    _do(kb, "atlas", lambda m, c: m.complete_task(c, t, result="ok"))
    state, cursor = _converge(src, state, cursor)
    assert to_snapshot(state)["workers"] == []


def test_commands_assign_comment_status(kb, src):
    t = _mk(kb, "atlas", "Cmd")
    cid = f"atlas:{t}"
    state = apply_snapshot(src.snapshot())
    cursor = src.snapshot()["cursor"]
    assert src.command({"type": "assign", "card_id": cid, "profile": "reviewer"}) == {"ok": True}
    assert src.command({"type": "comment", "card_id": cid, "text": "hello"}) == {"ok": True}
    ev = src.events(cursor)
    types = [e["type"] for e in ev["events"]]
    assert "card_upsert" in types and "comment_added" in types
    comment = next(e for e in ev["events"] if e["type"] == "comment_added")["payload"]
    assert comment == {"card_id": cid, "author": "foundry", "text": "hello"}
    state, cursor = _converge(src, state, cursor)
    card = next(c for p in to_snapshot(state)["projects"] for c in p["cards"] if c["id"] == cid)
    assert card["assignee_profile"] == "reviewer" and card["claimed_by"] is None  # assigned, never claimed
    # a manual move the workflow allows goes through the stock PATCH
    assert src.command({"type": "set_status", "card_id": cid, "status_native": "todo"}) == {"ok": True}
    refused = src.command({"type": "set_status", "card_id": cid, "status_native": "done"})  # todo -> done: no
    assert refused["ok"] is False and "not a manual move" in refused["error"]
    assert src.command({"type": "set_status", "card_id": cid, "status_native": "ready"}) == {"ok": True}
    # the stock PATCH enforces its own rules: completing needs a result, so the workflow's reason comes back
    blocked = src.command({"type": "set_status", "card_id": cid, "status_native": "done"})
    assert blocked["ok"] is False and "result" in blocked["error"]
    assert src.command({"type": "set_status", "card_id": cid, "status_native": "blocked"}) == {"ok": True}
    state, cursor = _converge(src, state, cursor)
    card = next(c for p in to_snapshot(state)["projects"] for c in p["cards"] if c["id"] == cid)
    assert card["status"] == "blocked" and card["status_native"] == "blocked"


def test_command_errors_are_ok_false(kb, src):
    t = _mk(kb, "atlas", "Err")
    cid = f"atlas:{t}"
    for bad in (
        {"type": "assign", "card_id": cid, "profile": ""},
        {"type": "comment", "card_id": cid, "text": "  "},
        {"type": "set_status", "card_id": cid, "status_native": "running"},  # not a manual move
        {"type": "set_status", "card_id": cid, "status_native": "archived"},
        {"type": "assign", "card_id": "nocolon", "profile": "x"},
        {"type": "assign", "card_id": "atlas:t_missing", "profile": "x"},
        {"type": "assign", "card_id": "ghost:t_1", "profile": "x"},
        {"type": "claim", "card_id": cid, "worker_id": "w"},
        {"type": "nope"},
    ):
        r = src.command(bad)
        assert r["ok"] is False and r["error"], bad


def test_archived_card_is_removed(kb, src):
    t = _mk(kb, "harbor", "Gone")
    state = apply_snapshot(src.snapshot())
    cursor = src.snapshot()["cursor"]
    _do(kb, "harbor", lambda m, c: m.archive_task(c, t))
    ev = src.events(cursor)
    assert [e["type"] for e in ev["events"]] == ["card_removed"]
    state, cursor = _converge(src, state, cursor)
    assert all(not p["cards"] for p in to_snapshot(state)["projects"] if p["id"] == "harbor")


def test_new_board_forces_resync(kb, src):
    state = apply_snapshot(src.snapshot())
    cursor = src.snapshot()["cursor"]
    importlib.import_module("hermes_cli.kanban_db_boards").create_board("lumen", name="Lumen")
    assert src.events(cursor)["resync"] is True
    assert any(p["id"] == "lumen" for p in src.snapshot()["projects"])


def test_old_epoch_and_future_cursor_resync(kb, src):
    snap = src.snapshot()
    assert src.events("other-epoch.0")["resync"] is True
    assert src.events(f"{snap['epoch']}.999")["resync"] is True
    assert src.events(None)["resync"] is True
    assert src.events(snap["cursor"], epoch="stale")["resync"] is True
    assert src.events(snap["cursor"], epoch=snap["epoch"])["resync"] is False


def test_epoch_differs_per_instance(kb):
    from foundry_core.live import LiveSource
    assert LiveSource(min_interval=0).epoch != LiveSource(min_interval=0).epoch


def test_board_filter(kb):
    from foundry_core.live import LiveSource
    s = LiveSource(boards=["atlas"], min_interval=0)
    assert [p["id"] for p in s.snapshot()["projects"]] == ["atlas"]
    t = _mk(kb, "harbor", "x")
    assert s.command({"type": "assign", "card_id": f"harbor:{t}", "profile": "p"})["ok"] is False


def test_make_source_live_end_to_end(kb):
    from foundry_core.service import make_source
    s = make_source({"FOUNDRY_MODE": "live"})
    assert s.mode == "live" and s.snapshot()["mode"] == "live"


def test_transcript_unsupported(kb, src):
    with pytest.raises(KeyError):
        src.transcript("atlas:r1")


def test_live_never_emits_looping_or_waiting_human(kb, src):
    for i in range(3):
        t = _mk(kb, "atlas", f"w{i}")
        _do(kb, "atlas", lambda m, c, t=t: m.claim_task(c, t))
    _do(kb, "atlas", lambda m, c: c.execute("UPDATE tasks SET claim_expires = 1 WHERE id = (SELECT id FROM tasks LIMIT 1)"))
    states = {w["state"] for w in src.snapshot()["workers"]}
    assert states <= {"working", "unknown"} and "unknown" in states


def test_blocked_on_human_only_for_needs_input(kb, src):
    a, b = _mk(kb, "atlas", "asks"), _mk(kb, "atlas", "waits")
    _do(kb, "atlas", lambda m, c: m.block_task(c, a, reason="which db?", kind="needs_input"))
    _do(kb, "atlas", lambda m, c: m.block_task(c, b, reason="capability", kind="capability"))
    cards = {c["id"]: c for p in src.snapshot()["projects"] for c in p["cards"]}
    assert cards[f"atlas:{a}"]["status"] == "blocked" and cards[f"atlas:{a}"]["blocked_on"] == "human"
    assert cards[f"atlas:{b}"]["status"] == "blocked" and cards[f"atlas:{b}"]["blocked_on"] is None
