"""Router tests: load dashboard/plugin_api.py by path (as Hermes does) and drive it over HTTP."""
import importlib.util
from pathlib import Path

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

API = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.delenv("FOUNDRY_MODE", raising=False)
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_foundry_test", API)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    app = FastAPI()
    app.include_router(mod.router, prefix="/api/plugins/foundry")
    return TestClient(app)


def test_snapshot_default_is_fixture(client):
    r = client.get("/api/plugins/foundry/snapshot")
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "fixture" and body["v"] == 1
    assert body["last_seq"] == 0 and body["cursor"] == f"{body['epoch']}.0"


def test_command_then_events_roundtrip(client):
    snap = client.get("/api/plugins/foundry/snapshot").json()
    r = client.post("/api/plugins/foundry/command", json={"type": "assign", "card_id": "atlas:t04", "profile": "writer"})
    assert r.json() == {"ok": True}
    feed = client.get("/api/plugins/foundry/events", params={"since": snap["cursor"], "epoch": snap["epoch"]}).json()
    assert feed["resync"] is False and feed["epoch"] == snap["epoch"]
    assert feed["events"][0]["type"] == "card_upsert"
    assert feed["events"][0]["payload"]["card"]["assignee_profile"] == "writer"
    assert feed["cursor"] == f"{snap['epoch']}.{feed['events'][-1]['seq']}"
    stale = client.get("/api/plugins/foundry/events", params={"since": snap["cursor"], "epoch": "old"}).json()
    assert stale["resync"] is True


def test_failed_command_is_http_200_ok_false(client):
    r = client.post("/api/plugins/foundry/command", json={"type": "assign", "card_id": "zz", "profile": "coder"})
    assert r.status_code == 200 and r.json()["ok"] is False and "zz" in r.json()["error"]
    r = client.post("/api/plugins/foundry/command", json=["not", "an", "object"])
    assert r.status_code == 200 and r.json()["ok"] is False


def test_events_without_cursor_asks_for_resync(client):
    r = client.get("/api/plugins/foundry/events").json()
    assert r["resync"] is True and r["events"] == []


def test_reset_over_http(client):
    client.post("/api/plugins/foundry/command", json={"type": "stand", "on": True})
    assert client.post("/api/plugins/foundry/command", json={"type": "reset"}).json() == {"ok": True}
    assert client.get("/api/plugins/foundry/snapshot").json()["paused"] is False


def test_fixture_only_command_goes_through_in_fixture_mode(client):
    r = client.post("/api/plugins/foundry/command", json={"type": "stand", "on": True})
    assert r.json() == {"ok": True}


def test_transcript_route(client):
    r = client.get("/api/plugins/foundry/transcript", params={"worker_id": "fx:3", "limit": 3})
    assert r.status_code == 200
    body = r.json()
    assert [ln["seq"] for ln in body["lines"]] == [5, 6, 7] and body["next_before"] == 5 and body["truncated"] is True
    older = client.get("/api/plugins/foundry/transcript",
                       params={"worker_id": "fx:3", "limit": 3, "before": body["next_before"]}).json()
    assert [ln["seq"] for ln in older["lines"]] == [2, 3, 4]
    assert client.get("/api/plugins/foundry/transcript", params={"worker_id": "nope"}).status_code == 404


@pytest.mark.parametrize("cmd", [
    {"type": "assign", "card_id": ["atlas:t04"], "profile": "coder"},
    {"type": "assign", "card_id": {"a": 1}, "profile": "coder"},
    {"type": "assign", "card_id": "atlas:t04", "profile": ["coder"]},
    {"type": "set_status", "card_id": 5, "status_native": "todo"},
    {"type": "set_status", "card_id": "atlas:t04", "status_native": ["todo"]},
    {"type": "comment", "card_id": None, "text": "x"},
    {"type": "claim", "card_id": "atlas:t04", "worker_id": ["fx:1"]},
    {"type": "claim", "card_id": [], "worker_id": "fx:1"},
    {"type": "message", "worker_id": {"x": 1}, "text": "hi"},
    {"type": "new_worker", "card_id": ["atlas:t04"]},
])
def test_non_string_fields_are_ok_false_and_change_nothing(client, cmd):
    base = "/api/plugins/foundry"
    before = client.get(f"{base}/snapshot").json()
    r = client.post(f"{base}/command", json=cmd)
    assert r.status_code == 200 and r.json()["ok"] is False and r.json()["error"]
    assert client.get(f"{base}/snapshot").json() == before
    assert client.get(f"{base}/events", params={"since": before["cursor"]}).json()["events"] == []


def test_garbage_cursor_over_http_is_resync(client):
    for since in ("e.²", "x." + "9" * 5000):
        r = client.get("/api/plugins/foundry/events", params={"since": since})
        assert r.status_code == 200 and r.json()["resync"] is True


def test_replay_over_http(monkeypatch):
    monkeypatch.setenv("FOUNDRY_REPLAY", "1")
    monkeypatch.setenv("FOUNDRY_REPLAY_STEP_SECONDS", "1")
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_foundry_replay", API)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    app = FastAPI()
    app.include_router(mod.router, prefix="/api/plugins/foundry")
    c = TestClient(app)
    c.get("/api/plugins/foundry/snapshot")  # the source starts on first use
    src = mod._source
    src._clock = lambda: src._t0 + 3600.0  # an injected clock: an hour has passed, so every step is due
    snap = c.get("/api/plugins/foundry/snapshot").json()
    assert snap["mode"] == "fixture" and snap["last_seq"] > 0  # the recording has been played to the end
    assert c.post("/api/plugins/foundry/command", json={"type": "stand", "on": True}).json()["ok"] is False
    assert c.post("/api/plugins/foundry/command", json={"type": "reset"}).json() == {"ok": True}
    assert c.get("/api/plugins/foundry/events", params={"since": snap["cursor"], "epoch": snap["epoch"]}).json()["resync"] is True
    assert c.get("/api/plugins/foundry/transcript", params={"worker_id": "fx:3"}).status_code == 200


@pytest.mark.parametrize("step", ["nan", "inf", "0", "-1"])
def test_replay_bad_step_is_a_503_not_a_broken_feed(monkeypatch, step):
    monkeypatch.setenv("FOUNDRY_REPLAY", "1")
    monkeypatch.setenv("FOUNDRY_REPLAY_STEP_SECONDS", step)
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_foundry_badstep", API)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    app = FastAPI()
    app.include_router(mod.router, prefix="/api/plugins/foundry")
    r = TestClient(app).get("/api/plugins/foundry/snapshot")
    assert r.status_code == 503 and "FOUNDRY_REPLAY_STEP_SECONDS" in r.json()["detail"]


def test_replay_unusable_recording_is_a_503(monkeypatch, tmp_path):
    bad = tmp_path / "r.json"
    bad.write_text('{"kind": "foundry-recording", "v": 1}')  # header only
    monkeypatch.setenv("FOUNDRY_REPLAY", str(bad))
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_foundry_badrec", API)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    app = FastAPI()
    app.include_router(mod.router, prefix="/api/plugins/foundry")
    c = TestClient(app)
    for path in ("snapshot", "events"):
        r = c.get(f"/api/plugins/foundry/{path}")
        assert r.status_code == 503 and "unusable" in r.json()["detail"] and "base" in r.json()["detail"]
