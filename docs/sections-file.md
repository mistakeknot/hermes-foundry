# Sections: the interface and the Hermes sections file

Foundry groups a creature's cards into **sections**. Vocabulary: creature = project (a Hermes board), section = limb
(a bb sidebar section; the contract's "epic"), card = thread (a kanban task). **Unsorted** is the cards that are in no
section. Unsorted is computed from the card list and the sections, never stored, never listed, and never a section: the
name is reserved.

Hermes' kanban has no section concept, so the Hermes backend keeps sections in a Foundry file beside the kanban. The
kanban database is never written for this. Status: proposed design, implemented in `aleph/src/sections/` (interface,
backends, shared rules) and `foundry_core/sections.py` (the read side). Nothing under `desktop/src` uses it yet.

## The interface (`aleph/src/sections/types.ts`)

Every host implements `SectionsBackend`, per creature id:

| call | meaning |
| --- | --- |
| `list(creature)` | the sections in creation order, each `{id, name, cardIds}`; none for a creature with none |
| `create(creature, name)` | add a section (name trimmed); returns it |
| `rename(creature, sectionId, name)` | change the name; id, place and cards are kept |
| `remove(creature, sectionId)` | delete the section; its cards become Unsorted; no card is deleted |
| `moveCard(creature, cardId, sectionId \| null)` | put a card in a section (appended) and out of any other; `null` means Unsorted |

Rules every backend shares (they live once, in `aleph/src/sections/model.ts`):

- A name is trimmed, 1 to 80 characters (UTF-16 units), has no control characters, and is not `Unsorted` in any case.
  Names are unique per creature, compared case-insensitively. Renaming a section to its own name or another case of it is fine.
- A card is in at most one section. Moving a card to a section it is already in moves it to the end of that section.
- Errors are `SectionsError` with a `code`: `invalid_id`, `invalid_name`, `duplicate_name`, `not_found`, `corrupt`.
  A failed call changes nothing.
- Returned sections are copies. Section ids are made by the backend, as `s_` and 8 lowercase hex digits.
- Card ids are opaque (1 to 200 characters, no control characters). A card id stored in a section but no longer listed
  by the host is ignored when computing Unsorted (`unsortedCards`).

Backends: `MemorySectionsBackend` (tests, previews), `FileSectionsBackend` (Hermes). The bb/Aleph backend is a later
bead. **Any backend must pass the contract suite**: `aleph/test/sections/contract.ts` exports
`runSectionsContract(name, factory)`, the factory returning `{backend, creatures: [a, b], cleanup?}`; call it from the
backend's own test file, as `memory-backend.test.ts` and `file-backend.test.ts` do. Behaviour of one backend alone
(a missing directory, a corrupt file) is tested in that backend's own file.

## The file

One file per board: `foundry-sections.json`, in the board directory next to `kanban.db`
(for example `<hermes home>/kanban/boards/<board>/foundry-sections.json`). The backend is given the board directory
by the host (`boardDir(slug)`); it forms no path from a creature id that is not a canonical board slug
(`^[a-z0-9][a-z0-9\-_]{0,63}$`).

```json
{
  "v": 1,
  "sections": [
    {"id": "s_0a1b2c3d", "name": "Docs", "cardIds": ["atlas:t_1", "atlas:t_2"]},
    {"id": "s_4e5f6a7b", "name": "Release prep", "cardIds": []}
  ]
}
```

- `v` is `1`. A reader rejects any other version. Unknown keys at either level are rejected, so a later format bumps `v`.
- `sections` is in creation order. Each has a unique `id`, a normalised and unique `name` (as above), and `cardIds`.
- A card id appears in at most one section's `cardIds`. Card ids are the contract's `"<board>:<task>"` form when written by
  Foundry, but the file does not require it.
- There is no Unsorted entry and no list of all cards: a card that is in no section is Unsorted.
- The writer indents with two spaces and ends with a newline. Readers must not depend on that.

### Reads and writes

- **A missing file or board directory means no sections.** A read creates nothing.
- **A write needs the board directory to exist** (it holds `kanban.db`). The backend never creates a board directory and
  answers `not_found` if it is missing. It only ever creates, replaces or removes its own file and its own temp file.
- **Atomic replace.** A write goes to a temp file in the same directory (`.foundry-sections.json.<pid>.<random>.tmp`),
  is flushed to disk, then renamed over the file, so a reader sees the old file or the new one, never half. If anything fails
  the temp file is removed and the old file is untouched.
- **A corrupt file is never overwritten.** If the file is not valid JSON or breaks the rules above, reads and writes fail with
  `corrupt` and the file is left as it is, for a person to look at.
- **Writers in one process are serialised.** Two processes writing the same board's file are not coordinated: each reads,
  changes and renames, so the later rename wins and may drop the other's change. Only the Aleph-side backend writes.
- **The kanban database is never opened or written by the sections code.**

### Python read side (`foundry_core/sections.py`)

`read_sections(board_dir)` returns the sections (or raises `SectionsFileError` for a corrupt file), `unsorted_cards`
computes Unsorted, and `contract_epics(board, sections)` / `epic_ids_by_card(board, sections)` give the contract's `epics`
(`{"id": "<board>:<section id>", "title": name}`) and each sorted card's `epic_id`. It is not yet called from
`foundry_core/live.py`, which still reports `epics: []`: wiring it changes what the Hermes pane shows and is left to a
later change.

### Checked by both languages

`tests/fixtures/sections/valid/*.json` must be accepted and `invalid/*.json` rejected, by `aleph/test/sections/model.test.ts`
and `tests/test_sections.py` alike. `valid/written-by-backend.json` is byte-for-byte what the TypeScript backend writes
for a fixed sequence of calls (checked in `file-backend.test.ts`), and the Python reader parses it too.
