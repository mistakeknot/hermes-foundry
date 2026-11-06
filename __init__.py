"""Foundry plugin entry point. The backend routes live in dashboard/plugin_api.py;
live-mode hooks are registered here once the live source is enabled."""

from __future__ import annotations


def register(ctx) -> None:  # noqa: ARG001 - hooks are added with the live source
    return None
