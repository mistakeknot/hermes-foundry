import pytest

from foundry_core.fixture import FixtureSource
from foundry_core.service import make_source, run_command


def test_default_and_explicit_fixture():
    assert make_source({}).mode == "fixture"
    assert make_source({"FOUNDRY_MODE": "Fixture"}).mode == "fixture"


def test_live_requested_but_unavailable_raises_not_fakes(monkeypatch):
    with pytest.raises(RuntimeError, match="live"):
        make_source({"FOUNDRY_MODE": "live", "HERMES_HOME": "/nonexistent-foundry-test"})


def test_run_command_validation():
    f = FixtureSource()
    assert run_command(f, None)["ok"] is False
    assert run_command(f, {"type": 3})["ok"] is False
    assert run_command(f, {"type": "nope"})["error"].startswith("unknown command")


def test_reset_is_fixture_only():
    class Live:
        mode = "live"
        def command(self, c): raise AssertionError("must not reach the source")
    assert run_command(Live(), {"type": "reset"}) == {"ok": False, "error": "reset is fixture only"}
