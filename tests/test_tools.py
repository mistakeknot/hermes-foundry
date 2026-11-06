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


def test_replay_source_refuses_every_tool_and_is_marked_simulated():
    from foundry_core.service import make_source
    t = FoundryTools(make=lambda: make_source({"FOUNDRY_REPLAY": "1"}))
    for out in (_out(t.assign({"card_id": "a:1", "profile": "coder"})), _out(t.stand({"on": True})),
                _out(t.message({"worker_id": "fx:1", "text": "hi"}))):
        assert out["ok"] is False and out["error"] and out["simulated"] is True


# -- simulated is derived from the source mode on every path -------------------------------------------------------

BAD_CALLS = {
    "assign": lambda t: t.assign({"card_id": "", "profile": "coder"}),
    "stand": lambda t: t.stand({"on": "yes"}),
    "message": lambda t: t.message({"worker_id": "", "text": "x"}),
}


class _Mode(_StubSource):
    def __init__(self, mode, raises=False):
        super().__init__()
        self.mode, self._raises = mode, raises

    def command(self, body):
        if self._raises:
            raise ValueError("kaboom")
        return super().command(body)


@pytest.mark.parametrize("mode,expected", [("fixture", True), ("replay", True), ("live", False)])
@pytest.mark.parametrize("name", sorted(BAD_CALLS))
def test_simulated_on_validation_errors_follows_the_source_mode(mode, expected, name):
    out = _out(BAD_CALLS[name](FoundryTools(make=lambda: _Mode(mode))))
    assert out["ok"] is False and out["simulated"] is expected


@pytest.mark.parametrize("mode,expected", [("fixture", True), ("replay", True), ("live", False)])
def test_simulated_when_the_command_raises_follows_the_source_mode(mode, expected):
    t = FoundryTools(make=lambda: _Mode(mode, raises=True))
    out = _out(t.assign({"card_id": "a:1", "profile": "coder"}))
    assert out["ok"] is False and "kaboom" in out["error"] and out["simulated"] is expected


def test_simulated_on_invalid_fixture_arguments_and_a_real_fixture_failure(tools):
    for name in BAD_CALLS:
        out = _out(BAD_CALLS[name](tools))
        assert out["ok"] is False and out["simulated"] is True
    out = _out(tools.assign({"card_id": "ghost:nope", "profile": "coder"}))  # the fixture itself refuses
    assert out["ok"] is False and out["simulated"] is True


def test_simulated_on_replay_validation_failures(tmp_path):
    from foundry_core.service import make_source
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    t = FoundryTools(make=lambda: make_source({"FOUNDRY_REPLAY": str(bad)}))
    assert t.available() is False
    for out in (_out(t.assign({"card_id": "a:1", "profile": "coder"})), _out(t.stand({"on": True})),
                _out(t.message({"worker_id": "fx:1", "text": "hi"})), _out(BAD_CALLS["stand"](t))):
        assert out["ok"] is False and out["simulated"] is True
        assert "unusable" in out["error"] or "on must be" in out["error"]


def test_simulated_when_the_source_cannot_be_built_follows_the_configured_mode(monkeypatch):
    def boom():
        raise RuntimeError("no source")
    monkeypatch.delenv("FOUNDRY_MODE", raising=False)
    assert _out(FoundryTools(make=boom).stand({"on": True}))["simulated"] is True
    monkeypatch.setenv("FOUNDRY_MODE", "live")
    t = FoundryTools(make=boom)
    for out in (_out(t.stand({"on": True})), _out(BAD_CALLS["stand"](t))):
        assert out["ok"] is False and out["simulated"] is False


# -- a failing factory is built once ----------------------------------------------------------------------------------

class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def test_a_failing_factory_is_called_once_until_reset_or_the_retry_interval():
    calls = []

    def boom():
        calls.append(1)
        raise RuntimeError("unreadable board")
    clock = _Clock()
    t = FoundryTools(make=boom, retry_seconds=30, clock=clock)
    for _ in range(5):
        assert t.available() is False
    assert _out(t.stand({"on": True}))["ok"] is False
    assert len(calls) == 1
    clock.now += 29
    assert t.available() is False and len(calls) == 1   # still inside the interval
    clock.now += 2
    assert t.available() is False and len(calls) == 2   # interval over: one retry
    t.reset()
    assert t.available() is False and len(calls) == 3   # explicit reset: retry at once


def test_a_retry_after_the_cause_is_fixed_builds_the_source():
    state = {"ok": False}

    def make():
        if not state["ok"]:
            raise RuntimeError("down")
        return FixtureSource(epoch_prefix="fxr")
    clock = _Clock()
    t = FoundryTools(make=make, retry_seconds=30, clock=clock)
    assert t.available() is False
    state["ok"] = True
    assert t.available() is False   # cached failure
    clock.now += 31
    assert t.available() is True and _out(t.stand({"on": True}))["ok"] is True


def test_module_reset_clears_the_default_tools(monkeypatch):
    import foundry_core.tools as mod
    monkeypatch.setattr(mod, "_default", None)
    first = mod.default_tools()
    assert mod.default_tools() is first
    first._failure, first._failed_at = "cached", 1e12
    mod.reset()
    assert first._failure is None and first._source is None


# -- the label belongs to the source that answered, not to whatever is configured afterwards ------------------------

def test_a_reset_and_config_flip_during_the_command_does_not_relabel_a_fixture_answer(monkeypatch):
    monkeypatch.setenv("FOUNDRY_MODE", "fixture")
    box = {}

    class Racing(_Mode):
        def command(self, body):
            box["tools"].reset()                      # a concurrent reset ...
            monkeypatch.setenv("FOUNDRY_MODE", "live")  # ... after the configuration switched to live
            box["next"] = True
            return {"ok": True}

    t = box["tools"] = FoundryTools(make=lambda: _Mode("live") if box.get("next") else Racing("fixture"))
    assert _out(t.stand({"on": True})) == {"ok": True, "simulated": True}


def test_a_reset_during_a_raising_command_does_not_relabel_the_error(monkeypatch):
    monkeypatch.setenv("FOUNDRY_MODE", "fixture")
    box = {}

    class Racing(_Mode):
        def command(self, body):
            box["tools"].reset()
            monkeypatch.setenv("FOUNDRY_MODE", "live")
            raise ValueError("kaboom")

    t = box["tools"] = FoundryTools(make=lambda: Racing("fixture"))
    out = _out(t.stand({"on": True}))
    assert out["ok"] is False and "kaboom" in out["error"] and out["simulated"] is True


def test_a_live_answer_stays_live_when_reset_flips_the_next_source_to_fixture(monkeypatch):
    box = {}

    class Racing(_Mode):
        def command(self, body):
            box["tools"].reset()
            box["next"] = True
            return {"ok": True}

    t = box["tools"] = FoundryTools(make=lambda: _Mode("fixture") if box.get("next") else Racing("live"))
    assert _out(t.assign({"card_id": "a:1", "profile": "coder"})) == {"ok": True, "simulated": False}


def test_a_real_concurrent_reset_never_mislabels_a_fixture_answer(monkeypatch):
    import threading
    monkeypatch.setenv("FOUNDRY_MODE", "live")  # configuration says live, the source is the fixture
    t = FoundryTools(make=lambda: FixtureSource(epoch_prefix="fxc"))
    stop, bad = threading.Event(), []

    def resetter():
        while not stop.is_set():
            t.reset()
    th = threading.Thread(target=resetter)
    th.start()
    try:
        for i in range(300):
            out = _out(t.stand({"on": bool(i % 2)}))
            if out["simulated"] is not True:
                bad.append(out)
    finally:
        stop.set()
        th.join()
    assert bad == []
