"""Hermes agent tools for Foundry: foundry_assign, foundry_stand, foundry_message.

Each tool is a thin adapter over ``service.run_command``, so the contract's rules and the fixture/live gating are
the same as on the HTTP path. No FastAPI imports, no model call, no credentials.

Honesty rules (docs/contract.md, "Commands"):
  * ``foundry_assign`` is live: it assigns a profile to a card on the Hermes kanban (it never claims the card).
  * ``foundry_stand`` and ``foundry_message`` are fixture only. Stock Hermes has no pause switch for the pane's ring
    and no way to address a kanban worker (a separate process with no session key), so they are not proven live.
    In live mode they answer ``ok: false`` ("fixture only"). They are never wired to ``inject_message``.
  * Every result carries ``simulated``: true when the answering source is the fixture or a replay, not the live board.

The tool process holds its own source. In live mode that is the shared kanban database, so an assignment is seen by
the pane. In fixture mode the state is private to the tool process and is not the pane's fixture.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Callable

from .service import make_source, run_command

log = logging.getLogger("foundry.tools")

TEXT_MAX = 2000  # same cut as a transcript line
RETRY_SECONDS = 30.0  # a failed source construction is not retried before this, or until reset()

ASSIGN_DESCRIPTION = (
    "Assign a Hermes profile to a Foundry kanban card (card_id is '<board>:<task>'). Assigns only; it does not "
    "claim or start the card. Live on the Hermes kanban. Against the fixture or a replay the result is marked "
    "simulated."
)
STAND_DESCRIPTION = (
    "FIXTURE ONLY (simulated): pause or resume the Foundry fixture's ring stand. Stock Hermes has no equivalent, so "
    "this answers ok=false ('fixture only') when Foundry runs against the live kanban."
)
MESSAGE_DESCRIPTION = (
    "FIXTURE ONLY (simulated): send text to a worker in the Foundry fixture. Stock Hermes cannot address a kanban "
    "worker, so this answers ok=false ('fixture only') when Foundry runs against the live kanban. It never "
    "reaches a real session."
)

ASSIGN_PARAMETERS = {
    "type": "object",
    "properties": {
        "card_id": {"type": "string", "description": "Card id, '<board>:<task>'."},
        "profile": {"type": "string", "description": "Hermes profile name to assign."},
    },
    "required": ["card_id", "profile"],
    "additionalProperties": False,
}
STAND_PARAMETERS = {
    "type": "object",
    "properties": {"on": {"type": "boolean", "description": "true pauses the fixture, false resumes it."}},
    "required": ["on"],
    "additionalProperties": False,
}
MESSAGE_PARAMETERS = {
    "type": "object",
    "properties": {
        "worker_id": {"type": "string", "description": "Worker id as shown in the Foundry snapshot."},
        "text": {"type": "string", "maxLength": TEXT_MAX, "description": "Message text."},
    },
    "required": ["worker_id", "text"],
    "additionalProperties": False,
}


def _configured_simulated(env: dict[str, str] | None = None) -> bool:
    """The simulated flag when no source exists: only FOUNDRY_MODE=live means a live board."""
    env = os.environ if env is None else env
    return env.get("FOUNDRY_MODE", "fixture").strip().lower() != "live"


class FoundryTools:
    """Holds the tool process's source and serialises calls (the sources are not thread-safe).

    A failed construction is cached for ``retry_seconds`` (or until ``reset()``), so repeated registry checks do not
    rebuild an unusable source each time.
    """

    def __init__(self, make: Callable[[], Any] = make_source, *, retry_seconds: float = RETRY_SECONDS,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._make = make
        self._retry = retry_seconds
        self._clock = clock
        self._lock = threading.RLock()
        self._source: Any = None
        self._failure: str | None = None
        self._failed_at = 0.0

    def reset(self) -> None:
        """Forget the source and any cached failure; the next call builds a fresh source."""
        with self._lock:
            self._source, self._failure, self._failed_at = None, None, 0.0

    def _get_source(self) -> Any:
        with self._lock:
            if self._source is not None:
                return self._source
            if self._failure is not None and self._clock() - self._failed_at < self._retry:
                raise RuntimeError(self._failure)
            try:
                self._source = self._make()  # RuntimeError when live was asked for and is unusable
            except Exception as exc:  # health: allow BLE001 -- cache the failure, then let the caller report it
                self._failure, self._failed_at = f"{type(exc).__name__}: {exc}", self._clock()
                raise
            self._failure = None
            return self._source

    def _simulated(self) -> bool:
        """True unless the answering source is the live board. Same value on every path: the built source's mode,
        or, if it cannot be built, the configured mode."""
        try:
            return getattr(self._get_source(), "mode", "") != "live"
        except Exception:  # health: allow BLE001 -- a failed source falls back to the configured mode
            return _configured_simulated()

    def available(self) -> bool:
        """check_fn: hide the tools when the configured source cannot be built."""
        try:
            self._get_source()
        except Exception as exc:  # health: allow BLE001 -- a check never raises into the tool registry
            log.warning("foundry tools hidden: %s", exc)
            return False
        return True

    def call(self, body: dict[str, Any]) -> str:
        """Run one command; return the JSON text {ok, error?, simulated}."""
        try:
            with self._lock:
                source = self._get_source()
                result = dict(run_command(source, body))
        except Exception as exc:  # health: allow BLE001 -- a tool reports, it never raises into the agent loop
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        return self._out(result)

    def _out(self, result: dict[str, Any]) -> str:
        return json.dumps({**result, "simulated": self._simulated()}, sort_keys=True)

    # -- handlers (Hermes calls handler(args)) --------------------------------
    def assign(self, args: Any, **_: Any) -> str:
        a = args if isinstance(args, dict) else {}
        card_id, profile = a.get("card_id"), a.get("profile")
        if not isinstance(card_id, str) or not card_id.strip():
            return self._bad("card_id must be a non-empty string")
        if not isinstance(profile, str) or not profile.strip():
            return self._bad("profile must be a non-empty string")
        return self.call({"type": "assign", "card_id": card_id.strip(), "profile": profile.strip()})

    def stand(self, args: Any, **_: Any) -> str:
        on = args.get("on") if isinstance(args, dict) else None
        if not isinstance(on, bool):
            return self._bad("on must be true or false")
        return self.call({"type": "stand", "on": on})

    def message(self, args: Any, **_: Any) -> str:
        a = args if isinstance(args, dict) else {}
        worker_id, text = a.get("worker_id"), a.get("text")
        if not isinstance(worker_id, str) or not worker_id.strip():
            return self._bad("worker_id must be a non-empty string")
        if not isinstance(text, str) or not text.strip():
            return self._bad("text must be a non-empty string")
        if len(text) > TEXT_MAX:
            return self._bad(f"text is over {TEXT_MAX} characters")
        return self.call({"type": "message", "worker_id": worker_id.strip(), "text": text})

    def _bad(self, error: str) -> str:
        return self._out({"ok": False, "error": error})


_default: FoundryTools | None = None


def default_tools() -> FoundryTools:
    global _default
    if _default is None:
        _default = FoundryTools()
    return _default


def reset() -> None:
    """Forget the default tools' source and any cached failure (tests, and an operator fixing the cause)."""
    default_tools().reset()


def register_tools(ctx: Any, tools: FoundryTools | None = None) -> list[str]:
    """Register the three tools on a Hermes PluginContext. Returns the names the registry accepted.

    ``register_tool`` returns None when the name clashes with another toolset; that tool is skipped and logged.
    """
    tools = tools or default_tools()
    specs = (
        ("foundry_assign", ASSIGN_DESCRIPTION, ASSIGN_PARAMETERS, tools.assign, "\U0001f9ed"),
        ("foundry_stand", STAND_DESCRIPTION, STAND_PARAMETERS, tools.stand, "⏸"),
        ("foundry_message", MESSAGE_DESCRIPTION, MESSAGE_PARAMETERS, tools.message, "\U0001f4ac"),
    )
    accepted: list[str] = []
    for name, description, parameters, handler, emoji in specs:
        try:
            handle = ctx.register_tool(
                name=name, toolset="foundry", schema={"name": name, "description": description,
                                                      "parameters": parameters},
                handler=handler, check_fn=tools.available, description=description, emoji=emoji)
        except Exception as exc:  # health: allow BLE001 -- one bad registration must not stop the plugin loading
            log.warning("foundry: could not register %s: %s", name, exc)
            continue
        if handle is None:
            log.warning("foundry: %s was not registered (name clash)", name)
            continue
        accepted.append(name)
    return accepted
