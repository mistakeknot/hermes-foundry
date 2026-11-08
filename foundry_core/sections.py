"""Read side of the Hermes sections file: one small JSON file per board, beside the kanban database.

Sections are Foundry's own grouping of a board's cards (a "limb" on the creature, an epic in the contract). Hermes'
kanban has no such concept, so they live in ``foundry-sections.json`` in the board directory, next to ``kanban.db``. The
file is written by the Aleph-side TypeScript backend (``aleph/src/sections``); this module only reads it, and never
creates, writes, locks or repairs anything. The format and its rules are in ``docs/sections-file.md``, and
``tests/fixtures/sections`` holds the files both languages are checked against.

``Unsorted`` (cards in no section) is computed by ``unsorted_cards`` and is never stored.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .live import BOARD_SLUG

SECTIONS_FILENAME = "foundry-sections.json"
NAME_MAX = 80
CARD_ID_MAX = 200
RESERVED_NAME = "unsorted"
_SECTION_ID = re.compile(r"s_[0-9a-f]{8}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# The characters trimmed from both ends of a name: the ECMAScript WhiteSpace and LineTerminator sets, spelled out so this
# is the same set as NAME_WHITESPACE in aleph/src/sections/model.ts. Python's str.strip() is not that set (it also trims
# U+0085 and U+001C-U+001F), so it is never used on a name. Part of the file format (docs/sections-file.md).
NAME_WHITESPACE = (
    "\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
# A UTF-16 surrogate code point on its own. json.loads keeps a lone "\ud800" escape as one; a valid pair becomes one astral character.
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


class SectionsFileError(ValueError):
    """The sections file exists but is not a valid v1 document."""


def trim_name(text: str) -> str:
    """``text`` without NAME_WHITESPACE at either end."""
    return text.strip(NAME_WHITESPACE)


def normalize_name(raw: Any) -> str:
    """A section name as the writer stores it: trimmed, 1..80 UTF-16 units, no control characters or lone surrogates, not
    "Unsorted" (compared by lowercase only). Raises ``SectionsFileError``. Mirrors ``normalizeName`` in the TypeScript writer."""
    if not isinstance(raw, str) or _LONE_SURROGATE.search(raw):
        raise _bad("bad section name")
    name = trim_name(raw)
    if not name or _utf16_len(name) > NAME_MAX or _CONTROL.search(name) or name.lower() == RESERVED_NAME:
        raise _bad("bad section name")
    return name


def check_card_id(raw: Any) -> str:
    """A card id as the writer accepts it: 1..200 UTF-16 units, no control characters or lone surrogates."""
    if (not isinstance(raw, str) or not raw or _LONE_SURROGATE.search(raw) or _utf16_len(raw) > CARD_ID_MAX
            or _CONTROL.search(raw)):
        raise _bad("bad card id")
    return raw


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2  # the TypeScript writer counts UTF-16 units; match it. Callers reject lone surrogates first.


def _bad(why: str) -> SectionsFileError:
    return SectionsFileError(f"sections file is not valid: {why}")


def parse_doc(raw: Any) -> list[dict[str, Any]]:
    """Validate a decoded document and return its sections as ``[{"id", "name", "cardIds"}]``, in file order."""
    if not isinstance(raw, dict):
        raise _bad("not an object")
    if set(raw) - {"v", "sections"}:
        raise _bad("unknown key")
    if type(raw.get("v")) is not int or raw["v"] != 1:
        raise _bad("unsupported version")
    items = raw.get("sections")
    if not isinstance(items, list):
        raise _bad("sections is not a list")
    ids: set[str] = set()
    names: set[str] = set()
    cards: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            raise _bad("a section is not an object")
        if set(item) - {"id", "name", "cardIds"}:
            raise _bad("unknown section key")
        sid, name, card_ids = item.get("id"), item.get("name"), item.get("cardIds")
        if not isinstance(sid, str) or not _SECTION_ID.fullmatch(sid):
            raise _bad("bad section id")
        if sid in ids:
            raise _bad("duplicate section id")
        ids.add(sid)
        if normalize_name(name) != name:  # stored names are already trimmed
            raise _bad("bad section name")
        if name.lower() in names:
            raise _bad("duplicate section name")
        names.add(name.lower())
        if not isinstance(card_ids, list):
            raise _bad("cardIds is not a list")
        for cid in card_ids:
            check_card_id(cid)
            if cid in cards:
                raise _bad("a card is in two sections")
            cards.add(cid)
        out.append({"id": sid, "name": name, "cardIds": list(card_ids)})
    return out


def sections_path(board_dir: str | Path) -> Path:
    """Where a board's sections file lives, given the board directory (the one holding ``kanban.db``)."""
    return Path(board_dir) / SECTIONS_FILENAME


def read_sections(board_dir: str | Path) -> list[dict[str, Any]]:
    """The board's sections in creation order. No file means no sections. A file that is not valid raises ``SectionsFileError``
    (it is never repaired or replaced); an unreadable one raises ``OSError``."""
    try:
        text = sections_path(board_dir).read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError):
        return []
    try:
        raw = json.loads(text)
    except ValueError as exc:
        raise _bad("not JSON") from exc
    return parse_doc(raw)


def unsorted_cards(sections: list[dict[str, Any]], all_card_ids: list[str]) -> list[str]:
    """The cards, in the given order, that are in none of the sections. Stored card ids no longer in the list are ignored."""
    sorted_ids = {c for s in sections for c in s["cardIds"]}
    return [c for c in all_card_ids if c not in sorted_ids]


def contract_epics(board: str, sections: list[dict[str, Any]]) -> list[dict[str, str]]:
    """The sections as the contract's ``epics`` for project ``board``: ids are ``"<board>:<section id>"``."""
    _check_board(board)
    return [{"id": f"{board}:{s['id']}", "title": s["name"]} for s in sections]


def epic_ids_by_card(board: str, sections: list[dict[str, Any]]) -> dict[str, str]:
    """``{card id: epic id}`` for the sorted cards; a card missing from the map has ``epic_id`` null (Unsorted)."""
    _check_board(board)
    return {c: f"{board}:{s['id']}" for s in sections for c in s["cardIds"]}


def _check_board(board: str) -> None:
    if not isinstance(board, str) or not BOARD_SLUG.fullmatch(board):
        raise ValueError(f"invalid board name {board!r}")
