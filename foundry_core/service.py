"""Pick the data source and shape router replies. No FastAPI imports: unit-testable anywhere."""

from __future__ import annotations

import os
import secrets
from typing import Any

from .fixture import FixtureSource

LIVE_COMMANDS = ("assign", "set_status", "comment")
# Simulated until each is proven against stock Hermes (docs/contract.md, "Commands").
FIXTURE_ONLY_COMMANDS = ("claim", "message", "stand", "new_worker", "reset")
COMMAND_TYPES = LIVE_COMMANDS + FIXTURE_ONLY_COMMANDS


def make_source(env: dict[str, str] | None = None) -> Any:
    """Fixture is the default. Live only when FOUNDRY_MODE=live and the kanban DB is importable."""
    env = os.environ if env is None else env
    if env.get("FOUNDRY_MODE", "fixture").strip().lower() == "live":
        try:
            from .live import LiveSource
            return LiveSource.from_env(env)
        except Exception as exc:  # live was asked for but is unusable: say so, do not fake it
            raise RuntimeError(f"FOUNDRY_MODE=live but the kanban source is unavailable: {exc}") from exc
    # A restart loses the fixture state, so each process gets its own epoch prefix.
    return FixtureSource(epoch_prefix="fx" + secrets.token_hex(3))


def run_command(source: Any, body: Any) -> dict[str, Any]:
    """Validate the command envelope, reject fixture-only commands on live, delegate. Always {ok, error?}."""
    if not isinstance(body, dict) or not isinstance(body.get("type"), str):
        return {"ok": False, "error": "command must be an object with a string 'type'"}
    if body["type"] not in COMMAND_TYPES:
        return {"ok": False, "error": f"unknown command: {body['type']}"}
    if body["type"] in FIXTURE_ONLY_COMMANDS and getattr(source, "mode", "") != "fixture":
        return {"ok": False, "error": f"{body['type']} is fixture only"}
    return source.command(body)
