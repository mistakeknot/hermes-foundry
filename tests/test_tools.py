"""foundry_assign / foundry_stand / foundry_message: fixture behaviour, honesty flags, registration.

The live assign is in test_live.py (needs a Hermes with the kanban modules).
"""

import json

import pytest

from foundry_core.fixture import FixtureSource
from foundry_core.tools import (ASSIGN_DESCRIPTION, MESSAGE_DESCRIPTION, STAND_DESCRIPTION, TEXT_MAX,
                                FoundryTools, register_tools)


@pytest.fixture
def tools():
    return FoundryTools(make=lambda: FixtureSource(epoch_prefix="fxt"))


def _out(raw):
    assert isinstance(raw, str)
    return json.loads(raw)


def _first_ids(tools):
    snap = tools._get_source().snapshot()
    card = next(c for p in snap["projects"] for c in p["cards"] if c["status"] != "done")
    return card["id"], snap["workers"][0]["id"]


def test_assign_in_fixture_is_simulated(tools):
    card_id, _ = _first_ids(tools)
    out = _out(tools.assign({"card_id": card_id, "profile": "reviewer"}))
    assert out == {"ok": True, "simulated": True}
    snap = tools._get_source().snapshot()
    card = next(c for p in snap["projects"] for c in p["cards"] if c["id"] == card_id)
    assert card["assignee_profile"] == "reviewer"


@pytest.mark.parametrize("args", [None, {}, {"card_id": "", "profile": "coder"}, {"card_id": "a:b", "profile": " "},
                                  {"card_id": 3, "profile": "coder"}, {"card_id": "a:b", "profile": None}])
def test_assign_bad_args(tools, args):
    out = _out(tools.assign(args))
    assert out["ok"] is False and out["error"]


def test_assign_unknown_card_and_profile_refused(tools):
    card_id, _ = _first_ids(tools)
    assert _out(tools.assign({"card_id": "ghost:nope", "profile": "coder"}))["ok"] is False
    assert _out(tools.assign({"card_id": card_id, "profile": "no-such-profile"}))["ok"] is False


def test_stand_toggles_fixture_pause(tools):
    assert _out(tools.stand({"on": True})) == {"ok": True, "simulated": True}
    assert tools._get_source().snapshot()["paused"] is True
    assert _out(tools.stand({"on": False}))["ok"] is True
    assert tools._get_source().snapshot()["paused"] is False


@pytest.mark.parametrize("args", [None, {}, {"on": "yes"}, {"on": 1}, {"on": None}])
def test_stand_needs_a_real_boolean(tools, args):
    out = _out(tools.stand(args))
    assert out["ok"] is False and "true or false" in out["error"]


def test_message_in_fixture_is_simulated_and_lands_in_transcript(tools):
    _, worker_id = _first_ids(tools)
    out = _out(tools.message({"worker_id": worker_id, "text": "hello there"}))
    assert out == {"ok": True, "simulated": True}
    lines = tools._get_source().transcript(worker_id)["lines"]
    assert any(l["role"] == "user" and l["text"] == "hello there" for l in lines)


@pytest.mark.parametrize("args", [None, {}, {"worker_id": "", "text": "x"}, {"worker_id": "w", "text": "  "},
                                  {"worker_id": "w", "text": "x" * (TEXT_MAX + 1)}, {"worker_id": 4, "text": "x"}])
def test_message_bad_args(tools, args):
    out = _out(tools.message(args))
    assert out["ok"] is False and out["error"]


def test_message_text_at_the_cap_passes_validation(tools):
    _, worker_id = _first_ids(tools)
    assert _out(tools.message({"worker_id": worker_id, "text": "x" * TEXT_MAX}))["ok"] is True


def test_message_to_unknown_worker_refused(tools):
    assert _out(tools.message({"worker_id": "fx:ghost", "text": "hi"}))["ok"] is False


class _StubSource:
    """Stands in for a live board: stand and message must be refused as fixture only, with no simulated flag."""
    mode = "live"

    def __init__(self):
        self.commands = []

    def command(self, body):
        self.commands.append(body)
        return {"ok": True}


def test_stand_and_message_are_fixture_only_in_live_mode():
    src = _StubSource()
    t = FoundryTools(make=lambda: src)
    for out in (_out(t.stand({"on": True})), _out(t.message({"worker_id": "atlas:1", "text": "hi"}))):
        assert out["ok"] is False and "fixture only" in out["error"] and out["simulated"] is False
    assert src.commands == []  # never reached the source
    assert _out(t.assign({"card_id": "atlas:1", "profile": "coder"})) == {"ok": True, "simulated": False}
    assert [c["type"] for c in src.commands] == ["assign"]


def test_non_live_source_is_marked_simulated():
    class Replay(_StubSource):
        mode = "replay"
    assert _out(FoundryTools(make=lambda: Replay()).assign({"card_id": "a:1", "profile": "p"}))["simulated"] is True


def test_source_failure_is_reported_not_raised():
    def boom():
        raise RuntimeError("FOUNDRY_MODE=live but the kanban source is unavailable: nope")
    t = FoundryTools(make=boom)
    assert t.available() is False
    out = _out(t.stand({"on": True}))
    assert out["ok"] is False and "unavailable" in out["error"]


def test_source_command_raising_is_reported_not_raised():
    class Raises(_StubSource):
        mode = "fixture"

        def command(self, body):
            raise ValueError("kaboom")
    out = _out(FoundryTools(make=lambda: Raises()).stand({"on": True}))
    assert out["ok"] is False and "kaboom" in out["error"]


class _Ctx:
    def __init__(self, refuse=(), raise_on=()):
        self.calls, self.refuse, self.raise_on = [], set(refuse), set(raise_on)

    def register_tool(self, **kw):
        if kw["name"] in self.raise_on:
            raise RuntimeError("registry exploded")
        self.calls.append(kw)
        return None if kw["name"] in self.refuse else object()


def test_register_tools_registers_three_with_honest_descriptions(tools):
    ctx = _Ctx()
    assert register_tools(ctx, tools) == ["foundry_assign", "foundry_stand", "foundry_message"]
    by = {c["name"]: c for c in ctx.calls}
    assert all(c["toolset"] == "foundry" and c["check_fn"] == tools.available for c in ctx.calls)
    assert by["foundry_assign"]["description"] == ASSIGN_DESCRIPTION and "simulated" in ASSIGN_DESCRIPTION
    for name, text in (("foundry_stand", STAND_DESCRIPTION), ("foundry_message", MESSAGE_DESCRIPTION)):
        assert by[name]["description"] == text and text.startswith("FIXTURE ONLY (simulated)")
        assert by[name]["schema"]["description"] == text
    for c in ctx.calls:
        s = c["schema"]
        assert s["name"] == c["name"] and s["parameters"]["type"] == "object" and s["parameters"]["required"]


def test_register_tools_survives_a_name_clash_and_a_raising_registry(tools):
    ctx = _Ctx(refuse={"foundry_stand"}, raise_on={"foundry_message"})
    assert register_tools(ctx, tools) == ["foundry_assign"]


def test_plugin_register_never_raises(monkeypatch):
    import importlib.util
    import pathlib
    spec = importlib.util.spec_from_file_location("foundry_plugin_root", pathlib.Path(__file__).parent.parent / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    ctx = _Ctx()
    mod.register(ctx)
    assert [c["name"] for c in ctx.calls] == ["foundry_assign", "foundry_stand", "foundry_message"]
    mod.register(object())  # a context without register_tool: logged, not raised
