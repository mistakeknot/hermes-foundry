import copy
import json

import pytest

from foundry_core.fixture import FixtureSource
from foundry_core.recording import BUNDLED, DEMO_STEPS, ReplaySource, load, record, validate_recording
from foundry_core.reducer import apply_events, apply_snapshot, to_snapshot
from foundry_core.service import make_source, run_command


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


@pytest.fixture(scope="module")
def rec():
    return load()


def played(rec, **kw):
    """A replay with every step already due (a clock far past the end)."""
    clock = Clock()
    rp = ReplaySource(rec, step_seconds=1.0, clock=clock, **kw)
    clock.t += len(rec["steps"]) + 1
    return rp


def _strip(snap):
    return {k: v for k, v in snap.items() if k not in ("epoch", "cursor", "last_seq")}


def test_bundled_session_is_current():
    """session.json must equal a fresh recording of DEMO_STEPS (run scripts/record_session.py to refresh)."""
    assert json.loads(BUNDLED.read_text()) == json.loads(json.dumps(record()))


def test_every_demo_step_is_recorded_and_changes_something(rec):
    assert [s["command"] for s in rec["steps"]] == DEMO_STEPS
    assert all(s["events"] for s in rec["steps"])
    seqs = [e["seq"] for s in rec["steps"] for e in s["events"]]
    assert seqs == sorted(set(seqs)) and seqs[0] == 1


def test_record_refuses_a_step_the_fixture_refuses():
    with pytest.raises(ValueError, match="refused"):
        record([{"type": "claim", "card_id": "atlas:t08", "worker_id": "fx:1"}])  # blocked on a human


def test_replay_end_state_equals_driving_the_fixture(rec):
    fx = FixtureSource("x")
    for cmd in DEMO_STEPS:
        assert fx.command(copy.deepcopy(cmd))["ok"]
    rp = played(rec)
    assert rp.finished
    assert _strip(rp.snapshot()) == _strip(fx.snapshot())
    for w in [w["id"] for w in fx.snapshot()["workers"]]:
        assert rp.transcript(w, limit=200) == fx.transcript(w, limit=200)


def test_replay_is_gated_by_the_clock(rec):
    clock = Clock()
    rp = ReplaySource(rec, step_seconds=2.0, clock=clock)
    first = rp.snapshot()
    assert first["last_seq"] == 0 and not rp.finished
    clock.t += 1.9
    assert rp.snapshot()["last_seq"] == 0
    clock.t += 0.2  # 2.1 s: step 1 is due
    assert rp.snapshot()["last_seq"] == len(rec["steps"][0]["events"])
    clock.t += 2.0 * len(rec["steps"])
    assert rp.finished
    assert rp.snapshot()["last_seq"] == sum(len(s["events"]) for s in rec["steps"])


def test_client_following_the_feed_converges(rec):
    clock = Clock()
    rp = ReplaySource(rec, step_seconds=1.0, clock=clock)
    snap = rp.snapshot()
    state, cursor = apply_snapshot(snap), snap["cursor"]
    for _ in range(len(rec["steps"]) + 2):
        clock.t += 1.0
        feed = rp.events(cursor, snap["epoch"])
        assert feed["resync"] is False
        state = apply_events(state, feed["events"])
        cursor = feed["cursor"]
        assert not state["resync"]
        assert _strip(to_snapshot(state)) == _strip(rp.snapshot())  # the client never drifts from the server
    assert rp.finished


def test_events_are_idempotent_and_stale_cursors_resync(rec):
    rp = played(rec)
    snap = rp.snapshot()
    again = rp.events(snap["cursor"])
    assert again["events"] == rp.events(snap["cursor"])["events"] and not again["resync"]
    assert rp.events("garbage")["resync"] is True
    assert rp.events(None)["resync"] is True
    assert rp.events(snap["cursor"], "other-epoch")["resync"] is True
    future = f"{rp.epoch}.{snap['last_seq'] + 999}"
    assert rp.events(future)["resync"] is True


def test_reset_restarts_playback_under_a_new_epoch(rec):
    rp = played(rec)
    old = rp.snapshot()
    assert old["last_seq"] > 0
    assert rp.command({"type": "reset"}) == {"ok": True}
    new_epoch = rp.epoch
    assert new_epoch != old["epoch"]
    assert rp.events(old["cursor"], old["epoch"]) ["resync"] is True


def test_other_commands_are_refused_and_change_nothing(rec):
    rp = played(rec)
    before = rp.snapshot()
    for cmd in ({"type": "comment", "card_id": "atlas:t08", "text": "x"}, {"type": "stand", "on": True}, {"type": "x"}, None, 7):
        r = rp.command(cmd)
        assert r["ok"] is False and r["error"]
    assert rp.snapshot() == before


def test_transcript_paging_and_unknown_worker(rec):
    rp = played(rec)
    page = rp.transcript("fx:3", limit=2)
    assert len(page["lines"]) == 2 and page["truncated"] is True
    older = rp.transcript("fx:3", limit=200, before=page["next_before"])
    assert older["lines"][-1]["seq"] < page["lines"][0]["seq"]
    with pytest.raises(KeyError):
        rp.transcript("fx:99")


def test_a_new_worker_from_the_recording_has_a_transcript(rec):
    rp = played(rec)
    ids = [w["id"] for w in rp.snapshot()["workers"]]
    assert "fx:5" in ids
    rp.transcript("fx:5")  # served (possibly empty), not a KeyError


def test_recording_does_not_need_the_fixture_to_play(rec, monkeypatch):
    monkeypatch.setattr("foundry_core.recording.FixtureSource", None)  # replay must not construct a fixture
    rp = played(rec)
    assert rp.snapshot()["mode"] == "fixture"


def test_load_rejects_a_wrong_file(tmp_path):
    p = tmp_path / "x.json"
    p.write_text(json.dumps({"kind": "other"}))
    with pytest.raises(ValueError):
        load(p)


def test_make_source_replay_env(tmp_path):
    src = make_source({"FOUNDRY_REPLAY": "1", "FOUNDRY_REPLAY_STEP_SECONDS": "0.001"})
    assert isinstance(src, ReplaySource) and src.mode == "fixture"
    assert run_command(src, {"type": "reset"}) == {"ok": True}  # fixture-only command passes the router gate
    assert run_command(src, {"type": "stand", "on": True})["ok"] is False  # but replay refuses it
    custom = tmp_path / "s.json"
    custom.write_text(BUNDLED.read_text())
    assert isinstance(make_source({"FOUNDRY_REPLAY": str(custom)}), ReplaySource)


def test_make_source_replay_errors_are_loud(tmp_path):
    with pytest.raises(RuntimeError, match="unusable"):
        make_source({"FOUNDRY_REPLAY": str(tmp_path / "missing.json")})
    with pytest.raises(RuntimeError, match="not a number"):
        make_source({"FOUNDRY_REPLAY": "1", "FOUNDRY_REPLAY_STEP_SECONDS": "fast"})
    with pytest.raises(RuntimeError, match="choose one"):
        make_source({"FOUNDRY_MODE": "live", "FOUNDRY_REPLAY": "1"})


# -- round 1 review: validate the whole recording up front, and refuse a bad pace -----------------------------

def _write(tmp_path, rec):
    p = tmp_path / "r.json"
    p.write_text(json.dumps(rec))
    return p


def _mut(rec, fn):
    out = copy.deepcopy(rec)
    fn(out)
    return out


def _del_base(r):
    del r["base"]


def _header_only(r):
    for k in ("base", "steps"):
        r.pop(k, None)


def _first_card(r):
    return r["base"]["snapshot"]["projects"][0]["cards"][0]


def _first_upsert(r):
    return next(e for st in r["steps"] for e in st["events"] if e["type"] == "card_upsert")


def _bad_payload(r):
    r["steps"][0]["events"][0]["payload"] = {}


def _bad_payload_type(r):
    r["steps"][0]["events"][0]["payload"] = "x"


def _out_of_order(r):
    r["steps"][1]["events"][0]["seq"] = 1


def _dup_seq_within_step(r):
    ev = next(s["events"] for s in r["steps"] if len(s["events"]) >= 2)
    ev[-1]["seq"] = ev[0]["seq"]


def _unknown_type(r):
    r["steps"][2]["events"][0]["type"] = "nope"


def _bad_ref(r):
    ev = r["steps"][3]["events"][0]  # a well-formed card on a board that does not exist: the reducer asks for a resync
    ev["payload"] = {"card": dict(_first_card(r), id="ghost:t1", epic_id=None)}


def _comment_on_ghost(r):
    ev = r["steps"][1]["events"][-1]
    ev["type"], ev["payload"] = "comment_added", {"card_id": "ghost:t1", "author": "you", "text": "hi"}


def _no_steps_key(r):
    del r["steps"]


def _bad_step_shape(r):
    r["steps"][0] = {"command": {}, "events": []}


def _bad_snapshot(r):
    r["base"]["snapshot"] = []


def _no_projects(r):
    del r["base"]["snapshot"]["projects"]


def _project_without_cards(r):
    del r["base"]["snapshot"]["projects"][0]["cards"]


def _bad_transcripts(r):
    r["base"]["transcripts"] = []


def _transcript_out_of_order(r):
    lines = r["base"]["transcripts"]["fx:3"]
    lines[0]["seq"], lines[1]["seq"] = lines[1]["seq"], lines[0]["seq"]


def _step_transcript_reuses_seq(r):
    r["steps"][2]["transcript"]["fx:3"][0]["seq"] = 1


def _step_transcript_not_a_list(r):
    r["steps"][2]["transcript"]["fx:3"] = {"seq": 9}


# -- contract schema (draft 4): required fields on cards, workers and every event payload --------------------
def _thin_card(r):
    _first_upsert(r)["payload"]["card"] = {"id": "atlas:t04"}


def _card_bad_status(r):
    _first_upsert(r)["payload"]["card"]["status"] = "sideways"


def _card_no_title(r):
    del _first_upsert(r)["payload"]["card"]["title"]


def _card_wrong_board(r):
    _first_upsert(r)["payload"]["card"]["id"] = "zz:t1"


def _card_bad_docs(r):
    _first_upsert(r)["payload"]["card"]["docs"] = [{"path": 1}]


def _card_blocked_on_other(r):
    _first_upsert(r)["payload"]["card"]["blocked_on"] = "robot"


def _card_unknown_epic(r):
    _first_upsert(r)["payload"]["card"]["epic_id"] = "atlas:e99"


def _thin_base_card(r):
    r["base"]["snapshot"]["projects"][0]["cards"][0] = {"id": "atlas:t01"}


def _base_duplicate_card(r):
    cards = r["base"]["snapshot"]["projects"][0]["cards"]
    cards.append(copy.deepcopy(cards[0]))


def _base_no_mode(r):
    del r["base"]["snapshot"]["mode"]


def _base_paused_string(r):
    r["base"]["snapshot"]["paused"] = "no"


def _base_worker_thin(r):
    r["base"]["snapshot"]["workers"][0] = {"id": "fx:1"}


def _worker_event_bad_state(r):
    ev = next(e for st in r["steps"] for e in st["events"] if e["type"] == "worker_upsert")
    ev["payload"]["worker"]["state"] = "dancing"


def _paused_not_bool(r):
    ev = next(e for st in r["steps"] for e in st["events"] if e["type"] == "paused")
    ev["payload"]["paused"] = 1


def _event_no_ts(r):
    del r["steps"][0]["events"][0]["ts"]


def _event_seq_beyond_cursor_range(r):
    r["steps"][-1]["events"][-1]["seq"] = 10 ** 15


def _transcript_bad_role(r):
    r["base"]["transcripts"]["fx:3"][0]["role"] = "wizard"


# -- the contract's field, enum and mapping rules (round 3) -----------------------------------------------------
def _card_no_blocked_on(r):
    del _first_upsert(r)["payload"]["card"]["blocked_on"]


def _base_card_no_blocked_on(r):
    del _first_card(r)["blocked_on"]


def _status_disagrees_with_native(r):
    card = _first_upsert(r)["payload"]["card"]
    card["status_native"], card["status"] = "done", "open"  # the reviewer's reproduction


def _base_status_disagrees(r):
    card = _first_card(r)
    card["status_native"], card["status"] = "running", "done"


def _unknown_native_with_a_known_status(r):
    card = _first_upsert(r)["payload"]["card"]
    card["status_native"], card["status"] = "wip", "running"  # must be "unknown"


def _archived_card_in_an_upsert(r):
    card = _first_upsert(r)["payload"]["card"]
    card["status_native"], card["status"] = "archived", "unknown"


def _archived_card_in_the_base(r):
    card = _first_card(r)
    card["status_native"], card["status"] = "archived", "unknown"


def _epic_of_another_board(r):
    r["base"]["snapshot"]["projects"][0]["epics"][0]["id"] = "harbor:e1"


def _project_id_not_a_slug(r):
    r["base"]["snapshot"]["projects"][0]["id"] = "Atlas API"


def _worker_id_without_a_board(r):
    r["base"]["snapshot"]["workers"][0]["id"] = "plain"


def _worker_card_id_disagrees_with_claims(r):
    r["base"]["snapshot"]["workers"][0]["card_id"] = "atlas:t01"  # that card is not claimed by this worker


def _base_transcript_line_too_long(r):
    r["base"]["transcripts"]["fx:3"][0]["text"] = "x" * 2001


def _step_transcript_line_too_long(r):
    next(ls for st in r["steps"] for ls in st["transcript"].values() if ls)[0]["text"] = "y" * 2001


# -- timestamps and numbers that overflow --------------------------------------------------------------------
def _claimed_card_year_one(r):
    card = _first_upsert(r)["payload"]["card"]
    card["claimed_by"] = r["base"]["snapshot"]["workers"][0]["id"]
    card["updated_at"] = "0001-01-01T00:00:00+01:00"


def _stamp_year_nine_thousand_far_offset(r):
    _first_upsert(r)["payload"]["card"]["updated_at"] = "9999-12-31T23:59:59-23:59"


def _stamp_not_a_stamp(r):
    _first_upsert(r)["payload"]["card"]["updated_at"] = "yesterday"


def _stamp_no_offset(r):
    _first_upsert(r)["payload"]["card"]["updated_at"] = "2026-11-06T00:00:00"


def _event_ts_overflows(r):
    r["steps"][0]["events"][0]["ts"] = "0001-01-01T00:00:00+01:00"


BAD_RECORDINGS = {
    "header-only": (_header_only, "base"),
    "missing-base": (_del_base, "base"),
    "missing-steps": (_no_steps_key, "steps"),
    "bad-step-shape": (_bad_step_shape, "step 0"),
    "bad-event-payload": (_bad_payload, "card"),
    "payload-not-a-dict": (_bad_payload_type, "payload"),
    "out-of-order-seq": (_out_of_order, "not above"),
    "duplicate-seq": (_dup_seq_within_step, "not above"),
    "unknown-event-type": (_unknown_type, "known type"),
    "event-on-unknown-card": (_bad_ref, "does not apply"),
    "comment-on-unknown-card": (_comment_on_ghost, "does not apply"),
    "snapshot-not-a-dict": (_bad_snapshot, "snapshot"),
    "snapshot-without-projects": (_no_projects, "projects"),
    "project-without-cards": (_project_without_cards, "cards"),
    "transcripts-not-a-dict": (_bad_transcripts, "transcripts"),
    "transcript-out-of-order": (_transcript_out_of_order, "transcript seq"),
    "step-transcript-reuses-a-seq": (_step_transcript_reuses_seq, "transcript seq"),
    "step-transcript-not-a-list": (_step_transcript_not_a_list, "list"),
    "thin-card-in-an-upsert": (_thin_card, "needs a string title"),
    "card-bad-status": (_card_bad_status, "status must be"),
    "card-without-title": (_card_no_title, "string title"),
    "card-on-another-board": (_card_wrong_board, "not in project|does not apply"),
    "card-bad-docs": (_card_bad_docs, "docs"),
    "card-blocked-on-something-else": (_card_blocked_on_other, "blocked_on"),
    "card-in-an-unknown-epic": (_card_unknown_epic, "does not apply"),
    "thin-card-in-the-base": (_thin_base_card, "string title"),
    "duplicate-card-in-the-base": (_base_duplicate_card, "duplicate id"),
    "base-without-mode": (_base_no_mode, "mode"),
    "base-paused-not-a-bool": (_base_paused_string, "paused"),
    "thin-worker-in-the-base": (_base_worker_thin, "string name"),
    "worker-event-bad-state": (_worker_event_bad_state, "state must be"),
    "paused-event-not-a-bool": (_paused_not_bool, "boolean paused"),
    "event-without-ts": (_event_no_ts, "ts"),
    "event-seq-beyond-the-cursor-range": (_event_seq_beyond_cursor_range, "above"),
    "transcript-bad-role": (_transcript_bad_role, "role"),
    "card-without-blocked-on": (_card_no_blocked_on, "blocked_on"),
    "base-card-without-blocked-on": (_base_card_no_blocked_on, "blocked_on"),
    "status-disagrees-with-native": (_status_disagrees_with_native, "does not match status_native"),
    "base-status-disagrees-with-native": (_base_status_disagrees, "does not match status_native"),
    "unknown-native-with-a-known-status": (_unknown_native_with_a_known_status, "maps it to 'unknown'"),
    "archived-card-in-an-upsert": (_archived_card_in_an_upsert, "archived"),
    "archived-card-in-the-base": (_archived_card_in_the_base, "archived"),
    "epic-of-another-board": (_epic_of_another_board, "epic id"),
    "project-id-not-a-slug": (_project_id_not_a_slug, "board-slug"),
    "worker-id-without-a-board": (_worker_id_without_a_board, "worker id"),
    "worker-card-id-disagrees-with-claims": (_worker_card_id_disagrees_with_claims, "derivation"),
    "base-transcript-line-too-long": (_base_transcript_line_too_long, "2001 characters"),
    "step-transcript-line-too-long": (_step_transcript_line_too_long, "2001 characters"),
    "claimed-card-dated-year-one": (_claimed_card_year_one, "RFC3339"),
    "stamp-overflows-at-the-far-end": (_stamp_year_nine_thousand_far_offset, "RFC3339"),
    "stamp-is-not-a-stamp": (_stamp_not_a_stamp, "RFC3339"),
    "stamp-has-no-offset": (_stamp_no_offset, "RFC3339"),
    "event-ts-overflows": (_event_ts_overflows, "RFC3339"),
}


def test_the_bundled_recording_validates(rec):
    validate_recording(rec)


@pytest.mark.parametrize("name", sorted(BAD_RECORDINGS))
def test_a_bad_recording_is_refused_up_front(rec, tmp_path, name):
    mutate, needle = BAD_RECORDINGS[name]
    bad = _mut(rec, mutate)
    with pytest.raises(ValueError, match=needle):
        validate_recording(bad)
    with pytest.raises(ValueError, match=needle):
        ReplaySource(bad, step_seconds=1.0)  # direct construction is guarded too
    path = _write(tmp_path, bad)
    with pytest.raises(ValueError, match=needle):
        load(path)
    with pytest.raises(RuntimeError, match="unusable"):  # the one descriptive path the router turns into a 503
        make_source({"FOUNDRY_REPLAY": str(path)})


def test_a_validated_recording_never_fails_at_request_time(rec):
    rp = played(rec)
    for _ in range(3):  # every read path, repeatedly, after the whole recording is released
        rp.snapshot()
        rp.events(None)
        rp.transcript("fx:3")
    assert rp.finished


def test_editing_the_recording_after_construction_cannot_break_playback(rec):
    mine = copy.deepcopy(rec)
    clock = Clock()
    rp = ReplaySource(mine, step_seconds=1.0, clock=clock)
    mine["steps"][0]["events"] = "garbage"
    del mine["base"]
    clock.t += len(rec["steps"]) + 1
    assert rp.snapshot()["last_seq"] == sum(len(s["events"]) for s in rec["steps"])


def test_a_deeply_nested_file_is_a_value_error(tmp_path):
    p = tmp_path / "deep.json"
    p.write_text("[" * 100000 + "]" * 100000)
    with pytest.raises(ValueError):
        load(p)


@pytest.mark.parametrize("step", [float("nan"), float("inf"), float("-inf"), 0, 0.0, -1, -0.5, "x", None])
def test_replay_source_refuses_a_bad_pace(rec, step):
    with pytest.raises(ValueError, match="step_seconds"):
        ReplaySource(rec, step_seconds=step)


@pytest.mark.parametrize("step", ["nan", "NaN", "inf", "-inf", "0", "0.0", "-1", "-0.5"])
def test_make_source_refuses_a_bad_pace(step):
    with pytest.raises(RuntimeError, match="FOUNDRY_REPLAY_STEP_SECONDS must be a finite number above 0"):
        make_source({"FOUNDRY_REPLAY": "1", "FOUNDRY_REPLAY_STEP_SECONDS": step})


# -- playback arithmetic -------------------------------------------------------------------------------------
@pytest.mark.parametrize("step", [5e-324, 1e-320, 1e-300, 1e-200, 1e-9])
def test_a_tiny_but_valid_pace_plays_to_the_end_without_overflow(rec, step):
    clock = Clock()
    rp = ReplaySource(rec, step_seconds=step, clock=clock)
    assert rp.snapshot()["last_seq"] == 0  # no time has passed yet
    clock.t += 1.0  # a second is an enormous number of steps at this pace
    assert rp.snapshot()["last_seq"] == sum(len(s["events"]) for s in rec["steps"])
    assert rp.events(None)["resync"] is True
    assert rp.finished


@pytest.mark.parametrize("step", [1e300, 1e308, 1.7976931348623157e308])
def test_a_huge_pace_never_releases_a_step_and_never_overflows(rec, step):
    clock = Clock()
    rp = ReplaySource(rec, step_seconds=step, clock=clock)
    clock.t += 1e6
    assert rp.snapshot()["last_seq"] == 0
    assert not rp.finished


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), -50.0])
def test_a_broken_or_backwards_clock_releases_nothing_and_does_not_raise(rec, bad):
    clock = Clock()
    rp = ReplaySource(rec, step_seconds=1.0, clock=clock)
    clock.t = bad
    assert rp.snapshot()["last_seq"] == 0
    assert rp.events(None)["resync"] is True
    assert not rp.finished


def test_the_clock_going_backwards_after_progress_keeps_what_was_released(rec):
    clock = Clock()
    rp = ReplaySource(rec, step_seconds=1.0, clock=clock)
    clock.t += 2.5
    seq = rp.snapshot()["last_seq"]
    assert seq > 0
    clock.t -= 100
    assert rp.snapshot()["last_seq"] == seq


def test_a_year_one_claim_is_a_503_over_http_not_an_uncaught_overflow(rec, tmp_path):
    bad = _mut(rec, _claimed_card_year_one)
    path = _write(tmp_path, bad)
    with pytest.raises(RuntimeError, match="unusable.*RFC3339"):
        make_source({"FOUNDRY_REPLAY": str(path)})


def test_a_thin_card_in_an_upsert_is_refused_before_the_reducer_sees_it(rec, tmp_path):
    bad = _mut(rec, _thin_card)
    with pytest.raises(ValueError, match="needs a string title"):
        validate_recording(bad)
    with pytest.raises(RuntimeError, match="unusable"):
        make_source({"FOUNDRY_REPLAY": str(_write(tmp_path, bad))})


def test_a_reducer_overflow_is_normalised_even_if_the_schema_checks_miss_it(rec, monkeypatch):
    import foundry_core.recording as mod

    def boom(state, events):
        raise OverflowError("timestamp out of range for platform time_t")

    monkeypatch.setattr(mod, "apply_events", boom)
    with pytest.raises(ValueError, match="does not replay: OverflowError"):
        validate_recording(copy.deepcopy(rec))


def test_a_line_of_exactly_the_cap_is_served_whole_and_one_over_is_refused(rec):
    ok = copy.deepcopy(rec)
    ok["base"]["transcripts"]["fx:3"][0]["text"] = "z" * 2000
    validate_recording(ok)
    assert len(played(ok).transcript("fx:3", limit=200)["lines"][0]["text"]) == 2000
    bad = copy.deepcopy(rec)
    bad["base"]["transcripts"]["fx:3"][0]["text"] = "z" * 2001
    with pytest.raises(ValueError, match="2001 characters"):
        ReplaySource(bad)


def test_every_served_transcript_line_is_within_the_cap(rec):
    rp = played(rec)
    for w in rp.snapshot()["workers"]:
        assert all(len(ln["text"]) <= 2000 for ln in rp.transcript(w["id"], limit=200)["lines"])


def test_a_native_status_outside_the_table_is_allowed_when_shown_as_unknown(rec):
    ok = copy.deepcopy(rec)
    card = _first_upsert(ok)["payload"]["card"]
    card["status_native"], card["status"] = "wip", "unknown"
    validate_recording(ok)
    for native, shown in (("triage", "open"), ("todo", "open"), ("scheduled", "open"), ("ready", "open"),
                          ("running", "running"), ("blocked", "blocked"), ("review", "review"), ("done", "done")):
        card["status_native"], card["status"] = native, shown
        validate_recording(ok)
