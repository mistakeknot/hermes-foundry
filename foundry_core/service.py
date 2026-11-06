"""Pick the data source and shape router replies. No FastAPI imports: unit-testable anywhere."""

from __future__ import annotations

import os
from typing import Any

from .fixture import FixtureSource

COMMAND_TYPES = ("assign", "set_status", "comment", "message", "stand", "reset")


def make_source(env: dict[str, str] | None = None) -> Any:
    """Fixture is the default. Live only when FOUNDRY_MODE=live and the kanban DB is importable."""
    env = os.environ if env is None else env
    if env.get("FOUNDRY_MODE", "fixture").strip().lower() == "live":
        try:
            from .live import LiveSource
            return LiveSource.from_env(env)
        except Exception as exc:  # live was asked for but is unusable: say so, do not fake it
            raise RuntimeError(f"FOUNDRY_MODE=live but the kanban source is unavailable: {exc}") from exc
    return FixtureSource()


def run_command(source: Any, body: Any) -> dict[str, Any]:
    """Validate the command envelope, reject reset on live, delegate. Always {ok, error?}."""
    if not isinstance(body, dict) or not isinstance(body.get("type"), str):
        return {"ok": False, "error": "command must be an object with a string 'type'"}
    if body["type"] not in COMMAND_TYPES:
        return {"ok": False, "error": f"unknown command: {body['type']}"}
    if body["type"] == "reset" and getattr(source, "mode", "") != "fixture":
        return {"ok": False, "error": "reset is fixture only"}
    return source.command(body)
