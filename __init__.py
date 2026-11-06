"""Foundry plugin entry point. The backend routes live in dashboard/plugin_api.py; the agent tools
(foundry_assign, foundry_stand, foundry_message) are registered here."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

_ROOT = str(Path(__file__).resolve().parent)
log = logging.getLogger("foundry")


def register(ctx) -> None:
    if _ROOT not in sys.path:
        sys.path.insert(0, _ROOT)
    try:
        from foundry_core.tools import register_tools
        register_tools(ctx)
    except Exception as exc:  # health: allow BLE001 -- the dashboard routes must still load without the tools
        log.warning("foundry: agent tools not registered: %s", exc)
