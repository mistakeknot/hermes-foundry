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
import threading
from typing import Any, Callable

from .service import make_source, run_command

log = logging.getLogger("foundry.tools")

TEXT_MAX = 2000  # same cut as a transcript line

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


class FoundryTools:
    """Holds the tool process's source and serialises calls (the sources are not thread-safe)."""

    def __init__(self, make: Callable[[], Any] = make_source) -> None:
        self._make = make
        self._lock = threading.RLock()
        self._source: Any = None

    def _get_source(self) -> Any:
        with self._lock:
            if self._source is None:
                self._source = self._make()  # RuntimeError when live was asked for and is unusable
            return self._source

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
                result["simulated"] = getattr(source, "mode", "") != "live"
        except Exception as exc:  # health: allow BLE001 -- a tool reports, it never raises into the agent loop
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "simulated": False}
        return json.dumps(result, sort_keys=True)

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

    @staticmethod
    def _bad(error: str) -> str:
        return json.dumps({"ok": False, "error": error, "simulated": False}, sort_keys=True)


def register_tools(ctx: Any, tools: FoundryTools | None = None) -> list[str]:
    """Register the three tools on a Hermes PluginContext. Returns the names the registry accepted.

    ``register_tool`` returns None when the name clashes with another toolset; that tool is skipped and logged.
    """
    tools = tools or FoundryTools()
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
