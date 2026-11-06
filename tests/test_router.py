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
    assert body["mode"] == "fixture" and body["v"] == 1 and body["cursor"] == "fx.0"


def test_command_then_events_roundtrip(client):
    r = client.post("/api/plugins/foundry/command", json={"type": "assign", "card_id": "c04", "worker_id": "w4"})
    assert r.json() == {"ok": True}
    feed = client.get("/api/plugins/foundry/events", params={"since": "fx.0"}).json()
    assert feed["resync"] is False and feed["events"][0]["type"] == "card_assigned"
    assert feed["cursor"] == f"fx.{feed['events'][-1]['seq']}"


def test_failed_command_is_http_200_ok_false(client):
    r = client.post("/api/plugins/foundry/command", json={"type": "assign", "card_id": "zz", "worker_id": "w1"})
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
