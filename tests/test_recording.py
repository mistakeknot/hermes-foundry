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
    r["steps"][3]["events"][0] = {"seq": r["steps"][3]["events"][0]["seq"], "type": "card_upsert",
                                  "payload": {"card": {"id": "ghost:t1"}}}


def _comment_on_ghost(r):
    r["steps"][1]["events"][-1] = {"seq": r["steps"][1]["events"][-1]["seq"], "type": "comment_added",
                                   "payload": {"card_id": "ghost:t1"}}


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


BAD_RECORDINGS = {
    "header-only": (_header_only, "base"),
    "missing-base": (_del_base, "base"),
    "missing-steps": (_no_steps_key, "steps"),
    "bad-step-shape": (_bad_step_shape, "step 0"),
    "bad-event-payload": (_bad_payload, "does not apply"),
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
