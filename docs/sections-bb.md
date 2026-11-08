# Sections: the bb backend

The bb backend (`aleph/src/sections/bb-backend.ts`, bead mk-ps6ow.14.4) implements the same `SectionsBackend` interface as
the Hermes file backend (see [`sections-file.md`](sections-file.md)) over bb's own **thread sections**, reached through the
plugin SDK (`useSdk().threadSections` and `useSdk().threads`). The SDK object is injected: the backend takes anything shaped
like `BbSectionsSdk`, and the real `useSdk()` client satisfies it (the panel passes it in, so a build proves that).
Vocabulary is as in the other doc: creature = project, section = limb, card = thread; **Unsorted** is computed.

## What bb sections are

- **Global and name-only.** One flat list for the whole bb, ids like `sec_...`; a section has a name and nothing else. A
  project does not own a section.
- **Unique by exact name.** Creating or renaming to a name that exists is HTTP 409 (`section_name_conflict`). The comparison
  is exact and case-sensitive.
- A thread is in at most one section (`sectionId` on the thread). Moving it is `threads.update({threadId, sectionId})`;
  `null` clears it. Rename returns `updatedThreadCount`. Deleting a section clears its assignments and deletes no thread.
- The section list comes back ordered by name, with a creation time on each section.

## Scoping a section to a creature: the naming convention

Because bb sections are global, Foundry stores a creature's section under a **reserved prefix that encodes the project id**:

```
foundry/<creatureId>/<section name>        e.g.  foundry/proj_abc123/Docs
```

- `list` shows only bb sections that start with exactly `foundry/<creatureId>/`, with the prefix stripped. A section without
  the prefix, or with another project's prefix, is not shown. A remainder that is not a valid stored section name (empty,
  untrimmed, over 80 characters, or the reserved "Unsorted") is not shown either.
- `create`, `rename` and `remove` apply the prefix on the way in; callers never see it. The creature id must be 1 to 64
  characters of letters, digits, `_`, `.` or `-` (so a `/` in it cannot make two projects' prefixes overlap); anything else
  is `invalid_id`. A section's own name may contain `/`.
- The 80-character name limit applies to the name without the prefix, as in the other backends.

### Limits of the convention

1. **The prefix is a convention, not a boundary.** Anyone with access to bb's sections (the bb UI, the CLI, another plugin)
   can create, rename or delete a `foundry/...` section. Foundry cannot prevent it, only tolerate it.
2. **Name collisions.** A section named `foundry/<creatureId>/Docs` made outside Foundry looks exactly like one of Foundry's
   and shows up in that project's list. Creating "Docs" while one exists, in any letter case, is `duplicate_name`.
3. **Renaming a prefixed section outside Foundry.** Rename it to anything that no longer starts with the project's prefix
   and it silently leaves that project's list (it stays in bb, with its threads assigned). Rename it to another project's
   prefix and it moves to that project. Rename it to a prefixed name with an invalid remainder (for example an empty name)
   and it is hidden. Nothing is lost; the section is just not Foundry's any more. Restoring the name restores it.
4. **Case-insensitive uniqueness is enforced by Foundry, not by bb.** bb would accept `Docs` and `docs` side by side; the
   backend refuses the second (contract rule). The check and the write are serialised inside one backend object, but two
   backend objects (two plugin windows) or someone outside Foundry can still race it. Two sections that differ only in case
   can then both exist; both are listed, and neither breaks.
5. **Sections of other projects are never touched**, but they are in the same global list, so listing is one `threadSections.list`
   call for the whole bb plus one `threads.list` per Foundry section of the project.
6. **A project's id is not checked against bb's projects.** Any valid creature id is accepted; for an id with no threads
   `list` is `[]` and a move into a section is `not_found`.

## Cards and ordering

- `cardIds` of a section are the project's threads (`threads.list` filtered by project and section, paged) ordered by the
  thread's last-touched time, oldest first. **This approximates "in the order they were moved in"**: a move touches the
  thread, so moves order correctly, but any other change to the thread (a new message, a rename) also moves it later. When the
  time ties the thread id breaks it. bb has no per-section position, so there is nothing better to read.
- Moving a card to the section it is already in puts it last only if bb touches the thread for a no-op update; if it does not,
  the order is unchanged.
- `moveCard(creature, card, sectionId)` requires the card to be a thread **of that project** that bb lists (hidden threads are
  included); otherwise `not_found`. Moving a thread of another project would hide it from both projects' views.
- `moveCard(creature, card, null)` clears the assignment only if the thread is in one of this project's Foundry sections. A
  thread the user filed in a section of their own stays there (it is already "Unsorted" as far as Foundry is concerned), and an
  unknown thread is a no-op, as in the contract ("a card the host no longer lists is ignored").
- Deleting a section needs no extra work: bb clears the assignments, and the threads become Unsorted again.

## Errors

| bb | backend |
| --- | --- |
| HTTP 409 (`section_name_conflict`) on create or rename | `duplicate_name` |
| HTTP 404 on rename, delete or a thread update | `not_found` |
| anything else (network, 5xx, 403) | passed through unchanged; the write queue keeps working |

Errors are read structurally (`.status`, `.code`), so the SDK's `BbHttpError` and the test fake both work.

## Testing

- `aleph/test/sections/fake-bb.ts` is a fake SDK that behaves like bb where it matters: global sections, exact-name
  uniqueness with 409, a list ordered by name, `updatedThreadCount`, assignments cleared on delete (threads kept), 404 for
  unknown ids, thread paging capped at 200 per call, a monotonic `updatedAt` bumped by every thread update.
- `aleph/test/sections/bb-backend.test.ts` runs the unmodified `runSectionsContract` against it, then tests the scoping, the
  error mapping, ordering, paging and the thread rules above.
- The fake is only as good as this document's account of bb. The runtime check below is what proves the account.

## Runtime check against the real bb

`runBbSectionsCheck(sdk)` (`aleph/src/sections/bb-runtime-check.ts`) walks one throwaway section through the whole API on the
real SDK and reports every step. While the Foundry panel is mounted, `globalThis.__foundryBbSectionsCheck` runs it with the
panel's `useSdk()` client (from the loaded plugin's devtools console):

```js
await __foundryBbSectionsCheck()                      // uses the most recently touched thread bb lists
await __foundryBbSectionsCheck({ threadId: 'thr_x' })  // or a thread you choose; its project is the creature
```

It logs one line per step and resolves `{ok, steps, ...}`. The steps:

1. pick the thread to move (its project is the creature);
2. `list`, then `create` a section named `runtime-check <timestamp>` (stored as `foundry/<project>/runtime-check <timestamp>`);
3. create the same name in another case (the backend refuses) and the exact stored name through the raw SDK (expects bb's 409);
4. `list` shows it; `rename` it; move the thread in and check it is listed there; move it out and check it is not;
5. move it in again, `delete` the section, and check the section is gone and the thread still exists with no section;
6. put the thread back in the section it started in (or none) and check it.

Cleanup (delete, restore) runs even if a step fails; the report's `sectionName` names the throwaway section for finding it by
hand if cleanup itself failed. The check moves one real thread and restores it, so run it on a thread you do not mind
briefly seeing in another section; the only lasting effect is that the thread's last-touched time changes. It makes no UI
change, and the installer does nothing on a host whose SDK has no sections API.
