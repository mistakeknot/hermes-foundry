import copy

import pytest

from foundry_core.fixture import FixtureSource
from foundry_core.reducer import CARD_STATUSES, WORKER_STATES, apply_events, apply_snapshot


def cards(snap):
    return {c["id"]: c for p in snap["projects"] for c in p["cards"]}


def workers(snap):
    return {w["id"]: w for w in snap["workers"]}


def invariants(snap):
    cs, ws = cards(snap), workers(snap)
    for c in cs.values():
        assert c["status"] in CARD_STATUSES
        assert (c["status"] == "blocked") == (c["blocked_on"] == "human")
        if c["assignee"]:
            assert ws[c["assignee"]]["card_id"] == c["id"], c
        if c["status"] == "claimed":
            assert c["assignee"]
        if c["status"] == "done":
            assert c["assignee"] is None
    for w in ws.values():
        if "state" in w:
            assert w["state"] in WORKER_STATES
        if w["card_id"]:
            assert cs[w["card_id"]]["assignee"] == w["id"], w


def test_seed_shape():
    s = FixtureSource().snapshot()
    assert s["v"] == 1 and s["mode"] == "fixture" and len(s["projects"]) == 3
    assert len(cards(s)) == 40 and len(s["workers"]) == 4
    assert sum(1 for w in s["workers"] if w["state"] == "looping") == 1
    blocked = [c for c in cards(s).values() if c["status"] == "blocked"]
    assert len(blocked) == 1 and blocked[0]["blocked_on"] == "human"
    assert any(c["epic_id"] is None for c in cards(s).values())  # ungrouped limb
    invariants(s)


def test_deterministic_across_instances():
    a, b = FixtureSource(), FixtureSource()
    for src in (a, b):
        src.command({"type": "assign", "card_id": "c04", "worker_id": "w4"})
        src.command({"type": "comment", "card_id": "c08", "text": "ok"})
    assert a.snapshot() == b.snapshot() and a.events("fx.0") == b.events("fx.0")


def test_assign_existing_worker():
    f = FixtureSource()
    assert f.command({"type": "assign", "card_id": "c04", "worker_id": "w4"}) == {"ok": True}
    s = f.snapshot()
    assert cards(s)["c04"]["status"] == "claimed" and cards(s)["c04"]["assignee"] == "w4"
    assert workers(s)["w4"]["state"] == "working" and workers(s)["w4"]["card_id"] == "c04"
    invariants(s)


def test_assign_moves_worker_off_old_card():
    f = FixtureSource()
    f.command({"type": "assign", "card_id": "c04", "worker_id": "w1"})  # w1 was on c03
    s = f.snapshot()
    assert cards(s)["c03"]["status"] == "open" and cards(s)["c03"]["assignee"] is None
    invariants(s)


def test_assign_new_worker_and_cap():
    f = FixtureSource()
    assert f.command({"type": "assign", "card_id": "c10", "worker_id": "new"})["ok"]
    s = f.snapshot()
    assert len(s["workers"]) == 5 and workers(s)["w5"]["name"] == "Esme"
    invariants(s)
    for cid in ("c11", "c12", "c13"):
        assert f.command({"type": "assign", "card_id": cid, "worker_id": "new"})["ok"]
    assert len(f.snapshot()["workers"]) == 8
    r = f.command({"type": "assign", "card_id": "c14", "worker_id": "new"})
    assert r["ok"] is False and len(f.snapshot()["workers"]) == 8


def test_fix_lands_on_weak_point():
    f = FixtureSource()
    f.command({"type": "assign", "card_id": "c07", "worker_id": "new"})
    s = f.snapshot()
    assert cards(s)["c07"]["status"] == "done" and workers(s)["w5"]["state"] == "idle"
    invariants(s)


def test_blocked_flow_answer_unblocks():
    f = FixtureSource()
    assert f.command({"type": "assign", "card_id": "c08", "worker_id": "w4"})["ok"] is False
    assert f.command({"type": "comment", "card_id": "c08", "text": "use the ledger"}) == {"ok": True}
    s = f.snapshot()
    assert cards(s)["c08"]["status"] == "claimed" and workers(s)["w2"]["state"] == "working"
    assert f.comments("c08") == [{"author": "you", "text": "use the ledger"}]
    invariants(s)


def test_message_looping_worker_lands_task():
    f = FixtureSource()
    assert f.command({"type": "message", "worker_id": "w3", "text": "try the cache"})["ok"]
    s = f.snapshot()
    assert cards(s)["c06"]["status"] == "done" and workers(s)["w3"]["state"] == "idle"
    invariants(s)


def test_message_to_nonloop_worker_is_accepted_no_change():
    f = FixtureSource()
    before = f.snapshot()
    assert f.command({"type": "message", "worker_id": "w1", "text": "status?"}) == {"ok": True}
    assert f.snapshot() == before


def test_set_status_transitions():
    f = FixtureSource()
    assert f.command({"type": "set_status", "card_id": "c03", "status": "blocked"})["ok"]
    s = f.snapshot()
    assert cards(s)["c03"]["blocked_on"] == "human" and workers(s)["w1"]["state"] == "waiting_human"
    invariants(s)
    assert f.command({"type": "set_status", "card_id": "c03", "status": "done"})["ok"]
    s = f.snapshot()
    assert workers(s)["w1"]["state"] == "idle" and workers(s)["w1"]["card_id"] is None
    invariants(s)
    assert f.command({"type": "set_status", "card_id": "c04", "status": "claimed"})["ok"] is False  # no assignee


def test_stand_pauses_and_blocks_new_work():
    f = FixtureSource()
    assert f.command({"type": "stand", "on": True}) == {"ok": True}
    assert f.snapshot()["paused"] is True
    assert f.command({"type": "assign", "card_id": "c04", "worker_id": "w4"})["ok"] is False
    assert f.command({"type": "stand", "on": False}) == {"ok": True}
    assert f.command({"type": "assign", "card_id": "c04", "worker_id": "w4"})["ok"]


@pytest.mark.parametrize("cmd", [
    {"type": "assign", "card_id": "nope", "worker_id": "w1"},
    {"type": "assign", "card_id": "c04", "worker_id": "nope"},
    {"type": "assign", "card_id": "c01", "worker_id": "w4"},          # done
    {"type": "assign", "card_id": "c04", "worker_id": "w2"},          # waiting on human
    {"type": "set_status", "card_id": "c04", "status": "weird"},
    {"type": "comment", "card_id": "c04", "text": "  "},
    {"type": "message", "worker_id": "w1", "text": ""},
    {"type": "stand", "on": "yes"},
    {"type": "bogus"},
])
def test_failed_command_changes_nothing(cmd):
    f = FixtureSource()
    before, cursor_before = f.snapshot(), f.snapshot()["cursor"]
    r = f.command(cmd)
    assert r["ok"] is False and r["error"]
    assert f.snapshot() == before and f.snapshot()["cursor"] == cursor_before
    assert f.events(cursor_before)["events"] == []


def test_reset_restores_start_and_bumps_seq():
    f = FixtureSource()
    start = f.snapshot()
    f.command({"type": "assign", "card_id": "c04", "worker_id": "new"})
    f.command({"type": "stand", "on": True})
    f.command({"type": "reset"})
    s = f.snapshot()
    assert {k: v for k, v in s.items() if k != "cursor"} == {k: v for k, v in start.items() if k != "cursor"}
    assert s["cursor"] != start["cursor"]


def test_client_reducer_converges_with_machine():
    """A client that applies snapshot + event feed ends in the machine's state, with resets in the middle."""
    f = FixtureSource()
    client = apply_snapshot(f.snapshot())
    script = [
        {"type": "assign", "card_id": "c04", "worker_id": "w4"},
        {"type": "assign", "card_id": "c10", "worker_id": "new"},
        {"type": "comment", "card_id": "c08", "text": "go"},
        {"type": "message", "worker_id": "w3", "text": "nudge"},
        {"type": "assign", "card_id": "c07", "worker_id": "w5"},
        {"type": "set_status", "card_id": "c03", "status": "blocked"},
        {"type": "stand", "on": True},
        {"type": "reset"},
        {"type": "assign", "card_id": "c11", "worker_id": "new"},
    ]
    for cmd in script:
        f.command(cmd)
        feed = f.events(f"fx.{client['seq']}")
        assert not feed["resync"]
        client = apply_events(client, feed["events"])
        assert not client["resync"]
        snap = f.snapshot()
        assert {k: v for k, v in client["snapshot"].items()} == {k: v for k, v in snap.items() if k != "cursor"}
        invariants(snap)


def test_events_resync_on_bad_or_foreign_or_future_cursor():
    f = FixtureSource()
    f.command({"type": "stand", "on": True})
    for since in (None, "", "bad", "other.1", "fx.99"):
        r = f.events(since)
        assert r["resync"] is True and r["events"] == [] and r["cursor"] == "fx.1"
    r = f.events("fx.0")
    assert r["resync"] is False and [e["type"] for e in r["events"]] == ["paused"]
    assert f.events("fx.1")["events"] == []


def test_event_envelope_and_timestamps_are_deterministic_rfc3339():
    f = FixtureSource()
    f.command({"type": "assign", "card_id": "c04", "worker_id": "w4"})
    evs = f.events("fx.0")["events"]
    assert [e["seq"] for e in evs] == list(range(1, len(evs) + 1))
    assert all(e["ts"].endswith("Z") and e["ts"].startswith("2026-11-06T") for e in evs)
