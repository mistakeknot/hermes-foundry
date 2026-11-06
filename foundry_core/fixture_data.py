"""Deterministic seed for the fixture: 3 projects, 40 cards, 4 workers.

Hand-written, no randomness, no clock. Card tuples: (id, title, epic_id|None, status, holder|None, doc|None),
written in a short form (``c03``, ``e1``, ``w1``, status open|claimed|blocked|done) and expanded by
``initial_snapshot`` into contract ids (``atlas:t03``, ``atlas:e1``, ``fx:1``) and native statuses.
"""

from __future__ import annotations

from typing import Any

BASE_TS = "2026-11-06T00:00:00Z"

# (project id, name, [(epic id, title)], [card tuples])
_PROJECTS = [
    ("atlas", "atlas-api", [("e1", "Auth"), ("e2", "Billing"), ("e3", "Search")], [
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
    ("harbor", "harbor-web", [("e4", "Checkout"), ("e5", "Onboarding"), ("e6", "Design system")], [
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
    ("lumen", "lumen-docs", [("e7", "Guides"), ("e8", "Reference")], [
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

# Scripted outcomes (fixture-only; not part of the snapshot). Ids are global contract ids.
FIX_ON_CLAIM = frozenset({"atlas:t07"})   # the "weak point": a worker taking it lands the fix
FIX_ON_MESSAGE = frozenset({"fx:3"})      # messaging the looping worker breaks the loop and lands its card
NEW_WORKER_NAMES = ("Esme", "Finn", "Gwen", "Hale")
MAX_WORKERS = 8
BLOCKED_CARD = "atlas:t08"
PROFILES = ("coder", "reviewer", "writer")  # Hermes profiles the fixture knows how to assign to
DEFAULT_PROFILE = "coder"
# Native statuses a human may set by hand (a claim, not a move, makes a card "running").
MANUAL_STATUSES = ("triage", "todo", "ready", "blocked", "review", "done")
# Draft 2 status mapping: display status from native status.
DISPLAY_STATUS = {"triage": "open", "todo": "open", "scheduled": "open", "ready": "open",
                  "running": "running", "blocked": "blocked", "review": "review", "done": "done"}

# Where the short-form data departs from the plain open->ready mapping, so every native name appears.
_NATIVE_OVERRIDE = {"c04": "todo", "c10": "triage", "c30": "review"}
_NATIVE = {"open": "ready", "claimed": "running", "blocked": "blocked", "done": "done"}


def display_status(native: str) -> str:
    return DISPLAY_STATUS.get(native, "unknown")


def _gid(board: str, short: str) -> str:
    """c03 -> atlas:t03 (cards); e1 -> atlas:e1 (epics keep their letter)."""
    return f"{board}:t{short[1:]}" if short.startswith("c") else f"{board}:{short}"


def _wid(short: str) -> str:
    return "fx:" + short[1:]  # w1 -> fx:1


def initial_snapshot() -> dict[str, Any]:
    """The start state, without epoch or cursor. A fresh dict on every call."""
    projects = []
    card_ids: dict[str, str] = {}
    for board, pname, epics, cards in _PROJECTS:
        for cid, *_ in cards:
            card_ids[cid] = _gid(board, cid)
    for board, pname, epics, cards in _PROJECTS:
        out = []
        for cid, title, epic, status, holder, doc in cards:
            native = _NATIVE_OVERRIDE.get(cid, _NATIVE[status])
            out.append({
                "id": card_ids[cid], "title": title,
                "epic_id": _gid(board, epic) if epic else None,
                "status": display_status(native), "status_native": native,
                "assignee_profile": DEFAULT_PROFILE if holder else None,
                "claimed_by": _wid(holder) if holder else None,
                "blocked_on": "human" if status == "blocked" else None,
                "docs": [{"path": doc, "title": doc.rsplit("/", 1)[-1]}] if doc else [],
                "updated_at": BASE_TS,
            })
        projects.append({"id": board, "name": pname,
                         "epics": [{"id": _gid(board, e), "title": t} for e, t in epics],
                         "cards": out})
    return {
        "v": 1, "mode": "fixture", "projects": projects,
        "workers": [{"id": _wid(i), "name": n, "state": st, "card_id": card_ids[c] if c else None}
                    for i, n, st, c in _WORKERS],
        "paused": False,
    }


# Scripted transcript seeds, per worker id: (role, text) pairs. No model output; all hand-written.
TRANSCRIPT_SEED = {
    "fx:1": [("user", "Revoke every session when the password changes."),
             ("assistant", "Reading the session store to find where tokens are issued."),
             ("tool", "grep -rn 'issue_token' src/ -> 4 matches"),
             ("assistant", "Adding a revoke-all call to the password-change handler.")],
    "fx:2": [("user", "Reconcile refunds against the ledger nightly."),
             ("assistant", "The ledger has two currencies for one refund. Which one is canonical?"),
             ("tool", "ask_human: waiting for an answer")],
    "fx:3": [("user", "Prorate on plan change."),
             ("assistant", "Running the proration test."), ("tool", "pytest tests/test_proration.py -> 1 failed"),
             ("assistant", "Running the proration test."), ("tool", "pytest tests/test_proration.py -> 1 failed"),
             ("assistant", "Running the proration test."), ("tool", "pytest tests/test_proration.py -> 1 failed")],
    "fx:4": [],
}
