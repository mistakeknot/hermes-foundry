import copy

from foundry_core import fixture_data as fd
from foundry_core.reducer import apply_event, apply_events, apply_snapshot, make_cursor, parse_cursor, to_snapshot


def base():
    s = fd.initial_snapshot()
    s["cursor"] = make_cursor("t", 0)
    return apply_snapshot(s)


def ev(seq, typ, **payload):
    return {"seq": seq, "ts": "2026-11-06T00:00:00Z", "type": typ, "payload": payload}


def card(state, cid):
    for p in state["snapshot"]["projects"]:
        for c in p["cards"]:
            if c["id"] == cid:
                return c


def test_cursor_roundtrip_and_malformed():
    assert parse_cursor(make_cursor("fx", 7)) == ("fx", 7)
    assert parse_cursor("garbage") is None and parse_cursor(None) is None and parse_cursor(".5") is None


def test_pure_inputs_not_mutated():
    st = base()
    before = copy.deepcopy(st)
    apply_event(st, ev(1, "card_status", card_id="c04", status="claimed", blocked_on=None))
    assert st == before


def test_status_assigned_commented():
    st = apply_events(base(), [
        ev(1, "card_assigned", card_id="c04", worker_id="w4", updated_at="T1"),
        ev(2, "card_status", card_id="c04", status="claimed", blocked_on=None, updated_at="T2"),
        ev(3, "card_commented", card_id="c04", author="you", text="hi", updated_at="T3"),
    ])
    c = card(st, "c04")
    assert (c["assignee"], c["status"], c["updated_at"], st["seq"]) == ("w4", "claimed", "T3", 3)
    assert not st["resync"]


def test_duplicates_ignored_and_order_independent():
    e1 = ev(1, "card_status", card_id="c04", status="claimed", blocked_on=None)
    e2 = ev(2, "card_status", card_id="c04", status="done", blocked_on=None)
    a = apply_events(base(), [e1, e2])
    b = apply_events(base(), [e2, e1, e1, e2])
    assert a == b and card(a, "c04")["status"] == "done"
    assert apply_events(a, [e1, e2]) == a  # replay is a no-op


def test_gap_sets_resync_and_stops():
    st = apply_events(base(), [ev(1, "paused", paused=True), ev(3, "paused", paused=False)])
    assert st["resync"] and st["seq"] == 1 and st["snapshot"]["paused"] is True
    # once resync is set nothing more applies
    assert apply_events(st, [ev(2, "paused", paused=False)]) == st


def test_unknown_reference_sets_resync():
    st = apply_events(base(), [ev(1, "card_status", card_id="nope", status="done", blocked_on=None)])
    assert st["resync"] and st["seq"] == 0


def test_unknown_type_advances_seq_forward_compatible():
    st = apply_events(base(), [ev(1, "future_thing", x=1)])
    assert st["seq"] == 1 and not st["resync"]


def test_worker_state_upsert_and_omit():
    st = apply_events(base(), [
        ev(1, "worker_state", worker_id="w5", name="Esme", state="idle", card_id=None),
        ev(2, "worker_state", worker_id="w5", state=None),
    ])
    w = [x for x in st["snapshot"]["workers"] if x["id"] == "w5"][0]
    assert w["name"] == "Esme" and "state" not in w  # omitted, never guessed


def test_worker_moved_and_card_created_idempotent():
    new = {"id": "c99", "title": "t", "epic_id": None, "status": "open", "assignee": None,
           "blocked_on": None, "docs": [], "updated_at": "T"}
    st = apply_events(base(), [
        ev(1, "worker_moved", worker_id="w4", card_id="c04"),
        ev(2, "card_created", project_id="p1", card=new),
        ev(3, "card_created", project_id="p1", card=new),
    ])
    assert [w for w in st["snapshot"]["workers"] if w["id"] == "w4"][0]["card_id"] == "c04"
    assert sum(1 for c in st["snapshot"]["projects"][0]["cards"] if c["id"] == "c99") == 1


def test_reset_replaces_state():
    st = apply_events(base(), [ev(1, "card_status", card_id="c04", status="done", blocked_on=None)])
    st = apply_events(st, [ev(2, "reset", snapshot=fd.initial_snapshot())])
    assert card(st, "c04")["status"] == "open" and st["seq"] == 2


def test_to_snapshot_has_cursor():
    st = apply_events(base(), [ev(1, "paused", paused=True)])
    snap = to_snapshot(st)
    assert snap["cursor"] == "t.1" and snap["paused"] is True


def test_bad_cursor_snapshot_forces_resync():
    s = fd.initial_snapshot()
    s["cursor"] = "bad"
    assert apply_snapshot(s)["resync"]
