"""Deterministic seed for the fixture: 3 projects, 40 cards, 4 workers.

Hand-written, no randomness, no clock. Card tuples: (id, title, epic_id|None, status, assignee|None, doc|None).
"""

from __future__ import annotations

from typing import Any

BASE_TS = "2026-11-06T00:00:00Z"

# (project id, name, [(epic id, title)], [card tuples])
_PROJECTS = [
    ("p1", "atlas-api", [("e1", "Auth"), ("e2", "Billing"), ("e3", "Search")], [
        ("c01", "Token refresh endpoint", "e1", "done", None, "docs/atlas/auth.md"),
        ("c02", "Rotate signing keys", "e1", "done", None, None),
        ("c03", "Session revoke on password change", "e1", "claimed", "w1", "docs/atlas/sessions.md"),
        ("c04", "Rate limit login attempts", "e1", "open", None, None),
        ("c05", "Invoice PDF export", "e2", "done", None, None),
        ("c06", "Proration on plan change", "e2", "claimed", "w3", "docs/atlas/proration.md"),
        ("c07", "Webhook retry backoff", "e2", "open", None, "docs/atlas/webhooks.md"),
        ("c08", "Refund reconciliation job", "e2", "blocked", "w2", None),
        ("c09", "Tokenizer upgrade", "e3", "done", None, None),
        ("c10", "Faceted filters", "e3", "open", None, None),
        ("c11", "Index warmup on deploy", "e3", "open", None, None),
        ("c12", "Search relevance eval set", "e3", "open", None, "docs/atlas/eval.md"),
        ("c13", "Health endpoint cleanup", None, "open", None, None),
        ("c14", "Drop legacy v1 routes", None, "open", None, None),
    ]),
    ("p2", "harbor-web", [("e4", "Checkout"), ("e5", "Onboarding"), ("e6", "Design system")], [
        ("c15", "Address autocomplete", "e4", "done", None, None),
        ("c16", "Guest checkout", "e4", "open", None, None),
        ("c17", "Promo code field", "e4", "open", None, None),
        ("c18", "Apple Pay button", "e4", "open", None, "docs/harbor/pay.md"),
        ("c19", "Welcome tour", "e5", "done", None, None),
        ("c20", "Import from CSV", "e5", "open", None, None),
        ("c21", "Empty-state illustrations", "e5", "open", None, None),
        ("c22", "Dark mode tokens", "e6", "done", None, "docs/harbor/tokens.md"),
        ("c23", "Button focus ring", "e6", "open", None, None),
        ("c24", "Toast stacking", "e6", "open", None, None),
        ("c25", "Modal scroll lock", "e6", "open", None, None),
        ("c26", "Remove unused icons", None, "open", None, None),
        ("c27", "Bundle size budget", None, "open", None, "docs/harbor/budget.md"),
        ("c28", "Fix flaky checkout e2e", None, "done", None, None),
    ]),
    ("p3", "lumen-docs", [("e7", "Guides"), ("e8", "Reference")], [
        ("c29", "Quickstart rewrite", "e7", "done", None, "docs/lumen/quickstart.md"),
        ("c30", "Migration guide v2", "e7", "open", None, None),
        ("c31", "Troubleshooting page", "e7", "open", None, None),
        ("c32", "Glossary", "e7", "open", None, None),
        ("c33", "CLI reference generator", "e8", "open", None, "docs/lumen/cli.md"),
        ("c34", "API changelog automation", "e8", "open", None, None),
        ("c35", "Versioned URLs", "e8", "open", None, None),
        ("c36", "Broken link audit", "e8", "done", None, None),
        ("c37", "Search box styling", None, "open", None, None),
        ("c38", "Contributor guide", None, "open", None, None),
        ("c39", "Screenshot refresh", None, "open", None, None),
        ("c40", "Spelling pass", None, "done", None, None),
    ]),
]

# w2 waits on a human (blocked c08); w3 is looping on c06; w1 is working on c03; w4 is idle.
_WORKERS = [
    ("w1", "Ada", "working", "c03"),
    ("w2", "Bram", "waiting_human", "c08"),
    ("w3", "Cato", "looping", "c06"),
    ("w4", "Dee", "idle", None),
]

# Scripted outcomes (fixture-only; not part of the snapshot).
FIX_ON_ASSIGN = frozenset({"c07"})   # the "weak point": assigning a worker lands the fix
FIX_ON_MESSAGE = frozenset({"w3"})   # messaging the looping worker breaks the loop and lands c06
NEW_WORKER_NAMES = ("Esme", "Finn", "Gwen", "Hale")
MAX_WORKERS = 8
BLOCKED_CARD = "c08"


def initial_snapshot() -> dict[str, Any]:
    """The start state, without a cursor. A fresh dict on every call."""
    projects = []
    for pid, pname, epics, cards in _PROJECTS:
        projects.append({
            "id": pid, "name": pname,
            "epics": [{"id": eid, "title": t} for eid, t in epics],
            "cards": [{
                "id": cid, "title": title, "epic_id": epic, "status": status,
                "assignee": assignee,
                "blocked_on": "human" if status == "blocked" else None,
                "docs": [{"path": doc, "title": doc.rsplit("/", 1)[-1]}] if doc else [],
                "updated_at": BASE_TS,
            } for cid, title, epic, status, assignee, doc in cards],
        })
    return {
        "v": 1, "mode": "fixture", "projects": projects,
        "workers": [{"id": i, "name": n, "state": s, "card_id": c} for i, n, s, c in _WORKERS],
        "paused": False,
    }
