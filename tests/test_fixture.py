import pytest

from foundry_core import fixture_data as fd
from foundry_core.fixture import FixtureSource
from foundry_core.reducer import CARD_STATUSES, WORKER_STATES, apply_events, apply_snapshot


def cards(snap):
    return {c["id"]: c for p in snap["projects"] for c in p["cards"]}


def workers(snap):
    return {w["id"]: w for w in snap["workers"]}


def invariants(snap):
    cs, ws = cards(snap), workers(snap)
    held = {}
    for c in cs.values():
        assert c["status"] in CARD_STATUSES
        assert c["status"] == fd.display_status(c["status_native"])
        assert (c["status"] == "blocked") == (c["blocked_on"] == "human")
        if c["claimed_by"]:
            assert c["claimed_by"] in ws
            assert c["claimed_by"] not in held, "a worker holds one card"
            held[c["claimed_by"]] = c["id"]
            assert c["status"] in ("running", "blocked")
        if c["status"] == "running":
            assert c["claimed_by"]
        if c["status"] == "done":
            assert c["claimed_by"] is None
    for w in ws.values():
        assert w["state"] in WORKER_STATES
        assert w["card_id"] == held.get(w["id"]), w


def test_seed_shape():
    s = FixtureSource().snapshot()
    assert s["v"] == 1 and s["mode"] == "fixture" and len(s["projects"]) == 3
    assert [p["id"] for p in s["projects"]] == ["atlas", "harbor", "lumen"]  # bare board slugs
    assert len(cards(s)) == 40 and len(s["workers"]) == 4
    assert s["last_seq"] == 0 and s["cursor"] == f"{s['epoch']}.0"
    assert sum(1 for w in s["workers"] if w["state"] == "looping") == 1
    blocked = [c for c in cards(s).values() if c["status"] == "blocked"]
    assert len(blocked) == 1 and blocked[0]["blocked_on"] == "human"
    assert any(c["epic_id"] is None for c in cards(s).values())  # ungrouped limb
    assert {c["status_native"] for c in cards(s).values()} >= {"triage", "todo", "ready", "running", "blocked", "review", "done"}
    invariants(s)


def test_deterministic_across_instances():
    a, b = FixtureSource(), FixtureSource()
    for src in (a, b):
        src.command({"type": "claim", "card_id": "atlas:t04", "worker_id": "fx:4"})
        src.command({"type": "comment", "card_id": "atlas:t08", "text": "ok"})
    assert a.snapshot() == b.snapshot() and a.events(f"{a.epoch}.0") == b.events(f"{b.epoch}.0")


def test_assign_sets_profile_only_and_never_claims():
    f = FixtureSource()
    assert f.command({"type": "assign", "card_id": "atlas:t04", "profile": "reviewer"}) == {"ok": True}
    c = cards(f.snapshot())["atlas:t04"]
    assert c["assignee_profile"] == "reviewer" and c["claimed_by"] is None and c["status_native"] == "todo"
    assert [e["type"] for e in f.events(f"{f.epoch}.0")["events"]] == ["card_upsert"]
    invariants(f.snapshot())


def test_assign_same_profile_emits_nothing():
    f = FixtureSource()
    f.command({"type": "assign", "card_id": "atlas:t04", "profile": "coder"})
    head = f.snapshot()["cursor"]
    f.command({"type": "assign", "card_id": "atlas:t04", "profile": "coder"})
    assert f.events(head)["events"] == []


def test_claim_moves_worker_off_old_card():
    f = FixtureSource()
    assert f.command({"type": "claim", "card_id": "atlas:t04", "worker_id": "fx:1"})["ok"]  # fx:1 held atlas:t03
    s = f.snapshot()
    cs = cards(s)
    assert cs["atlas:t03"]["claimed_by"] is None and cs["atlas:t03"]["status_native"] == "ready"
    assert cs["atlas:t04"]["claimed_by"] == "fx:1" and cs["atlas:t04"]["status"] == "running"
    assert workers(s)["fx:1"]["card_id"] == "atlas:t04"
    invariants(s)


def test_claim_takes_card_from_other_worker():
    f = FixtureSource()
    f.command({"type": "claim", "card_id": "atlas:t03", "worker_id": "fx:4"})
    s = f.snapshot()
    assert workers(s)["fx:1"]["state"] == "idle" and workers(s)["fx:1"]["card_id"] is None
    assert workers(s)["fx:4"]["card_id"] == "atlas:t03"
    invariants(s)


def test_new_worker_and_cap():
    f = FixtureSource()
    assert f.command({"type": "new_worker", "card_id": "atlas:t10"})["ok"]
    s = f.snapshot()
    assert len(s["workers"]) == 5 and workers(s)["fx:5"]["name"] == "Esme"
    invariants(s)
    for cid in ("atlas:t11", "atlas:t12", "atlas:t13"):
        assert f.command({"type": "new_worker", "card_id": cid})["ok"]
    assert len(f.snapshot()["workers"]) == 8
    r = f.command({"type": "new_worker", "card_id": "atlas:t14"})
    assert r["ok"] is False and len(f.snapshot()["workers"]) == 8
    invariants(f.snapshot())


def test_fix_lands_on_weak_point():
    f = FixtureSource()
    f.command({"type": "new_worker", "card_id": "atlas:t07"})
    s = f.snapshot()
    assert cards(s)["atlas:t07"]["status"] == "done" and cards(s)["atlas:t07"]["claimed_by"] is None
    assert workers(s)["fx:5"]["state"] == "idle"
    invariants(s)


def test_blocked_flow_answer_unblocks():
    f = FixtureSource()
    assert f.command({"type": "claim", "card_id": "atlas:t08", "worker_id": "fx:4"})["ok"] is False
    assert f.command({"type": "comment", "card_id": "atlas:t08", "text": "use the ledger"}) == {"ok": True}
    s = f.snapshot()
    assert cards(s)["atlas:t08"]["status"] == "running" and workers(s)["fx:2"]["state"] == "working"
    assert f.comments("atlas:t08") == [{"author": "you", "text": "use the ledger"}]
    types = [e["type"] for e in f.events(f"{f.epoch}.0")["events"]]
    assert types == ["comment_added", "card_upsert", "worker_upsert"]
    invariants(s)


def test_message_looping_worker_lands_task():
    f = FixtureSource()
    assert f.command({"type": "message", "worker_id": "fx:3", "text": "try the cache"})["ok"]
    s = f.snapshot()
    assert cards(s)["atlas:t06"]["status"] == "done" and workers(s)["fx:3"]["state"] == "idle"
    invariants(s)


def test_message_to_nonloop_worker_is_accepted_no_change():
    f = FixtureSource()
    before = f.snapshot()
    assert f.command({"type": "message", "worker_id": "fx:1", "text": "status?"}) == {"ok": True}
    assert f.snapshot() == before
    assert f.transcript("fx:1")["lines"][-1]["text"] == "Understood."


def test_set_status_transitions():
    f = FixtureSource()
    assert f.command({"type": "set_status", "card_id": "atlas:t03", "status_native": "blocked"})["ok"]
    s = f.snapshot()
    assert cards(s)["atlas:t03"]["blocked_on"] == "human" and workers(s)["fx:1"]["state"] == "waiting_human"
    invariants(s)
    assert f.command({"type": "set_status", "card_id": "atlas:t03", "status_native": "done"})["ok"]
    s = f.snapshot()
    assert workers(s)["fx:1"]["state"] == "idle" and workers(s)["fx:1"]["card_id"] is None
    assert cards(s)["atlas:t03"]["status"] == "done"
    invariants(s)
    # "running" is a claim, not a manual move
    assert f.command({"type": "set_status", "card_id": "atlas:t04", "status_native": "running"})["ok"] is False
    # review keeps its native name
    assert f.command({"type": "set_status", "card_id": "atlas:t04", "status_native": "review"})["ok"]
    assert cards(f.snapshot())["atlas:t04"]["status"] == "review"


def test_upserts_stamp_updated_at_with_event_time():
    f = FixtureSource()
    f.command({"type": "assign", "card_id": "atlas:t04", "profile": "writer"})
    ev = f.events(f"{f.epoch}.0")["events"][0]
    assert ev["payload"]["card"]["updated_at"] == ev["ts"]
    assert cards(f.snapshot())["atlas:t04"]["updated_at"] == ev["ts"]


def test_stand_pauses_and_blocks_new_work():
    f = FixtureSource()
    assert f.command({"type": "stand", "on": True}) == {"ok": True}
    assert f.snapshot()["paused"] is True
    assert f.command({"type": "claim", "card_id": "atlas:t04", "worker_id": "fx:4"})["ok"] is False
    assert f.command({"type": "stand", "on": False}) == {"ok": True}
    assert f.command({"type": "claim", "card_id": "atlas:t04", "worker_id": "fx:4"})["ok"]


@pytest.mark.parametrize("cmd", [
    {"type": "assign", "card_id": "nope", "profile": "coder"},
    {"type": "assign", "card_id": "atlas:t04", "profile": "nobody"},
    {"type": "assign", "card_id": "atlas:t01", "profile": "coder"},       # done
    {"type": "claim", "card_id": "atlas:t04", "worker_id": "nope"},
    {"type": "claim", "card_id": "atlas:t01", "worker_id": "fx:4"},       # done
    {"type": "claim", "card_id": "atlas:t04", "worker_id": "fx:2"},       # waiting on human
    {"type": "set_status", "card_id": "atlas:t04", "status_native": "weird"},
    {"type": "comment", "card_id": "atlas:t04", "text": "  "},
    {"type": "message", "worker_id": "fx:1", "text": ""},
    {"type": "stand", "on": "yes"},
    {"type": "bogus"},
])
def test_failed_command_changes_nothing(cmd):
    f = FixtureSource()
    before = f.snapshot()
    r = f.command(cmd)
    assert r["ok"] is False and r["error"]
    assert f.snapshot() == before
    assert f.events(before["cursor"])["events"] == []


def test_reset_restores_start_under_new_epoch():
    f = FixtureSource()
    start = f.snapshot()
    f.command({"type": "new_worker", "card_id": "atlas:t04"})
    f.command({"type": "stand", "on": True})
    f.command({"type": "reset"})
    s = f.snapshot()
    assert s["epoch"] != start["epoch"]
    strip = lambda x: {k: v for k, v in x.items() if k not in ("epoch", "cursor")}  # noqa: E731
    assert strip(s) == strip(start)
    assert s["last_seq"] == 0
    assert f.transcript("fx:1")["lines"] == FixtureSource().transcript("fx:1")["lines"]


def test_client_reducer_converges_with_machine():
    """A client that applies snapshot + event feed ends in the machine's state, with a reset in the middle."""
    f = FixtureSource()
    client = apply_snapshot(f.snapshot())
    script = [
        {"type": "claim", "card_id": "atlas:t04", "worker_id": "fx:4"},
        {"type": "new_worker", "card_id": "atlas:t10"},
        {"type": "comment", "card_id": "atlas:t08", "text": "go"},
        {"type": "message", "worker_id": "fx:3", "text": "nudge"},
        {"type": "assign", "card_id": "harbor:t16", "profile": "reviewer"},
        {"type": "set_status", "card_id": "atlas:t03", "status_native": "blocked"},
        {"type": "stand", "on": True},
        {"type": "reset"},
        {"type": "new_worker", "card_id": "atlas:t11"},
    ]
    for cmd in script:
        f.command(cmd)
        cursor = f"{client['epoch']}.{client['seq']}"
        feed = f.events(cursor, client["epoch"])
        if feed["resync"]:  # only the reset step
            assert cmd["type"] == "reset"
            client = apply_snapshot(f.snapshot())
        else:
            client = apply_events(client, feed["events"])
        assert not client["resync"]
        snap = f.snapshot()
        assert {**client["snapshot"], "epoch": client["epoch"], "last_seq": client["seq"],
                "cursor": f"{client['epoch']}.{client['seq']}"} == snap
        invariants(snap)


def test_events_resync_on_bad_foreign_or_future_cursor():
    f = FixtureSource()
    f.command({"type": "stand", "on": True})
    e = f.epoch
    for since in (None, "", "bad", "other.1", f"{e}.99"):
        r = f.events(since)
        assert r["resync"] is True and r["events"] == [] and r["cursor"] == f"{e}.1"
    assert f.events(f"{e}.1", "stale-epoch")["resync"] is True
    r = f.events(f"{e}.0", e)
    assert r["resync"] is False and [x["type"] for x in r["events"]] == ["paused"]
    assert f.events(f"{e}.1")["events"] == []


def test_event_envelope_and_timestamps_are_deterministic_rfc3339():
    f = FixtureSource()
    f.command({"type": "claim", "card_id": "atlas:t04", "worker_id": "fx:4"})
    evs = f.events(f"{f.epoch}.0")["events"]
    assert [e["seq"] for e in evs] == list(range(1, len(evs) + 1))
    assert all(e["ts"].endswith("Z") and e["ts"].startswith("2026-11-06T") for e in evs)
    assert {e["type"] for e in evs} <= {"card_upsert", "worker_upsert"}


def test_transcript_paging():
    f = FixtureSource()
    full = f.transcript("fx:3", limit=50)
    assert [ln["seq"] for ln in full["lines"]] == list(range(1, 8))
    assert full["truncated"] is False and full["next_before"] is None
    p1 = f.transcript("fx:3", limit=3)
    assert [ln["seq"] for ln in p1["lines"]] == [5, 6, 7] and p1["truncated"] and p1["next_before"] == 5
    p2 = f.transcript("fx:3", limit=3, before=p1["next_before"])
    assert [ln["seq"] for ln in p2["lines"]] == [2, 3, 4] and p2["next_before"] == 2
    p3 = f.transcript("fx:3", limit=3, before=p2["next_before"])
    assert [ln["seq"] for ln in p3["lines"]] == [1] and p3["truncated"] is False and p3["next_before"] is None
    assert f.transcript("fx:4")["lines"] == []
    with pytest.raises(KeyError):
        f.transcript("fx:99")


def test_transcript_limit_cap_and_line_cut():
    f = FixtureSource()
    for _ in range(210):
        f.command({"type": "message", "worker_id": "fx:1", "text": "x" * 3000})
    t = f.transcript("fx:1", limit=10_000)
    assert len(t["lines"]) == 200 and t["truncated"] is True
    assert all(len(ln["text"]) <= 2000 for ln in t["lines"])


def test_reset_replays_identically_to_a_fresh_start():
    script = [{"type": "claim", "card_id": "atlas:t04", "worker_id": "fx:4"},
              {"type": "comment", "card_id": "atlas:t04", "text": "hi"},
              {"type": "stand", "on": True}, {"type": "stand", "on": False}]

    def run(f):
        f.command({"type": "reset"}) if f._seq else None
        base = f.snapshot()["cursor"]
        for c in script:
            f.command(c)
        evs = f.events(base)["events"]
        snap = f.snapshot()
        return evs, {k: v for k, v in snap.items() if k not in ("epoch", "cursor")}

    fresh = run(FixtureSource())
    f = FixtureSource()
    run(f)  # advance the clock, then reset and replay
    f.command({"type": "reset"})
    again = run(f)
    assert again == fresh  # timestamps included: the tick restarts with the epoch
