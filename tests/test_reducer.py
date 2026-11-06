import copy

from foundry_core import fixture_data as fd
from foundry_core.reducer import apply_event, apply_events, apply_snapshot, make_cursor, parse_cursor, to_snapshot

T04, T03 = "atlas:t04", "atlas:t03"


def base(last_seq=0):
    s = fd.initial_snapshot()
    s["epoch"], s["last_seq"] = "t", last_seq
    s["cursor"] = make_cursor("t", last_seq)
    return apply_snapshot(s)


def ev(seq, typ, **payload):
    return {"seq": seq, "ts": f"2026-11-06T00:00:{seq:02d}Z", "type": typ, "payload": payload}


def card(state, cid):
    for p in state["snapshot"]["projects"]:
        for c in p["cards"]:
            if c["id"] == cid:
                return c


def worker(state, wid):
    return next(w for w in state["snapshot"]["workers"] if w["id"] == wid)


def upsert(seq, state, cid, **changes):
    c = {**copy.deepcopy(card(state, cid)), **changes}
    return ev(seq, "card_upsert", card=c)


def test_cursor_roundtrip_and_malformed():
    assert parse_cursor(make_cursor("fx-1", 7)) == ("fx-1", 7)
    assert parse_cursor("garbage") is None and parse_cursor(None) is None and parse_cursor(".5") is None


def test_pure_inputs_not_mutated():
    st = base()
    before = copy.deepcopy(st)
    apply_event(st, upsert(1, st, T04, status="running", status_native="running"))
    assert st == before


def test_snapshot_watermark_starts_at_last_seq_and_old_events_are_ignored():
    st = base(last_seq=5)
    assert st["seq"] == 5 and st["resync"] is False
    stale = upsert(5, st, T04, status="done", status_native="done")
    assert apply_events(st, [stale]) == st
    st2 = apply_events(st, [upsert(9, st, T04, status="done", status_native="done")])
    assert card(st2, T04)["status"] == "done" and st2["seq"] == 9


def test_snapshot_without_epoch_or_last_seq_needs_resync():
    s = fd.initial_snapshot()
    assert apply_snapshot(s)["resync"] is True
    s["epoch"] = "t"
    assert apply_snapshot(s)["resync"] is True
    s["last_seq"] = True  # bool is not an int here
    assert apply_snapshot(s)["resync"] is True


def test_card_upsert_replaces_whole_object():
    st = base()
    st = apply_event(st, upsert(1, st, T04, status="review", status_native="review", assignee_profile="writer",
                                title="Renamed"))
    c = card(st, T04)
    assert (c["status"], c["status_native"], c["assignee_profile"], c["title"]) == ("review", "review", "writer", "Renamed")


def test_card_upsert_creates_new_card_idempotently():
    st = base()
    new = {"id": "harbor:t99", "title": "New", "epic_id": None, "status": "open", "status_native": "ready",
           "assignee_profile": None, "claimed_by": None, "blocked_on": None, "docs": [], "updated_at": "x"}
    st = apply_events(st, [ev(1, "card_upsert", card=new)])
    st = apply_events(st, [ev(1, "card_upsert", card=new)])  # replay
    harbor = next(p for p in st["snapshot"]["projects"] if p["id"] == "harbor")
    assert sum(1 for c in harbor["cards"] if c["id"] == "harbor:t99") == 1


def test_upsert_for_unknown_board_or_epic_needs_resync():
    st = base()
    c = {**card(st, T04), "id": "nowhere:t1"}
    assert apply_event(st, ev(1, "card_upsert", card=c))["resync"] is True
    c2 = {**card(st, T04), "epic_id": "atlas:e99"}
    r = apply_event(st, ev(1, "card_upsert", card=c2))
    assert r["resync"] is True and r["seq"] == 0


def test_card_removed_and_unknown_removal_is_noop():
    st = base()
    st = apply_event(st, ev(1, "card_removed", card_id=T04))
    assert card(st, T04) is None
    st = apply_event(st, ev(2, "card_removed", card_id="atlas:t404"))
    assert st["resync"] is False and st["seq"] == 2


def test_comment_added_changes_nothing_but_needs_known_card():
    st = base()
    st2 = apply_event(st, ev(1, "comment_added", card_id=T04, author="a", text="hi"))
    assert st2["snapshot"] == st["snapshot"] and st2["seq"] == 1
    assert apply_event(st, ev(1, "comment_added", card_id="nope", author="a", text="hi"))["resync"] is True


def test_claimed_by_is_the_single_source_of_worker_card_id():
    st = base()
    assert worker(st, "fx:4")["card_id"] is None
    st = apply_event(st, upsert(1, st, T04, claimed_by="fx:4", status="running", status_native="running"))
    assert worker(st, "fx:4")["card_id"] == T04
    # releasing the card clears the worker's card_id with no worker event at all
    st = apply_event(st, upsert(2, st, T04, claimed_by=None, status="open", status_native="ready"))
    assert worker(st, "fx:4")["card_id"] is None


def test_worker_upsert_cannot_override_card_id():
    st = base()
    w = {**worker(st, "fx:1"), "card_id": "atlas:t01", "state": "idle"}
    st = apply_event(st, ev(1, "worker_upsert", worker=w))
    assert worker(st, "fx:1")["state"] == "idle" and worker(st, "fx:1")["card_id"] == T03


def test_worker_upsert_adds_and_unknown_state_is_kept():
    st = base()
    st = apply_event(st, ev(1, "worker_upsert", worker={"id": "main:s1", "name": "Z", "state": "unknown", "card_id": None}))
    assert worker(st, "main:s1")["state"] == "unknown"
    st = apply_event(st, ev(2, "worker_removed", worker_id="main:s1"))
    assert all(w["id"] != "main:s1" for w in st["snapshot"]["workers"])


def test_snapshot_card_id_is_recomputed_when_it_disagrees():
    s = fd.initial_snapshot()
    s["workers"][3]["card_id"] = "atlas:t01"  # fx:4 claims nothing
    s["epoch"], s["last_seq"] = "t", 0
    assert worker(apply_snapshot(s), "fx:4")["card_id"] is None


def test_paused_event():
    st = apply_event(base(), ev(1, "paused", paused=True))
    assert st["snapshot"]["paused"] is True


def test_duplicates_ignored_and_order_independent():
    st = base()
    a = upsert(1, st, T04, status="review", status_native="review")
    b = upsert(2, st, T04, status="done", status_native="done")
    in_order = apply_events(st, [a, b])
    shuffled = apply_events(st, [b, a, b, a])
    assert in_order == shuffled and card(in_order, T04)["status"] == "done"


def test_gaps_in_seq_are_fine():
    st = base()
    st = apply_events(st, [upsert(3, st, T04, status="review", status_native="review"),
                           ev(10, "paused", paused=True)])
    assert st["resync"] is False and st["seq"] == 10 and st["snapshot"]["paused"] is True


def test_bad_reference_stops_and_keeps_applied_prefix():
    st = base()
    good = upsert(1, st, T04, status="review", status_native="review")
    bad = ev(2, "comment_added", card_id="nope", author="a", text="x")
    after = ev(3, "paused", paused=True)
    r = apply_events(st, [good, bad, after])
    assert r["resync"] is True and r["seq"] == 1 and r["snapshot"]["paused"] is False
    # once resync is set nothing else applies
    assert apply_events(r, [after]) == r


def test_unknown_type_advances_watermark_without_changing_state():
    st = base()
    r = apply_event(st, ev(4, "some_future_event", x=1))
    assert r["seq"] == 4 and r["snapshot"] == st["snapshot"] and r["resync"] is False


def test_unknown_native_status_passes_through():
    st = base()
    st = apply_event(st, upsert(1, st, T04, status="unknown", status_native="quarantined"))
    c = card(st, T04)
    assert (c["status"], c["status_native"]) == ("unknown", "quarantined")


def test_to_snapshot_has_epoch_cursor_and_last_seq():
    st = apply_events(base(), [ev(2, "paused", paused=True)])
    snap = to_snapshot(st)
    assert (snap["epoch"], snap["cursor"], snap["last_seq"], snap["paused"]) == ("t", "t.2", 2, True)
    assert apply_snapshot(snap) == st


def test_there_is_no_reset_event():
    """A reset is a new epoch, not an event: an unknown 'reset' type must not change state."""
    st = base()
    r = apply_event(st, ev(1, "reset"))
    assert r["snapshot"] == st["snapshot"]
