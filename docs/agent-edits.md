# Thread edit operations

The Foundry pane gives its thread component an optional `tools: AgentEditSurface`
and `history: readonly EditEntry[]` through `ThreadProps`. A caller sends
`await tools.dispatch({ name, arguments })`. The panel supplies one dispatcher
over the exact `InspectorEdits` instance used by its forms. There is no
provider session or chat transport in this change; a future transport calls
this hook rather than writing to a backend or maintaining an optimistic copy.

The exported `operations` list includes JSON Schema argument descriptions.
Every call and argument object is strict: extra fields, missing fields and
wrong types are rejected. The dispatcher validates again at runtime.

| Operation | Arguments |
| --- | --- |
| `rename_section` | `projectId, sectionId, name` |
| `move_thread` | `projectId, threadId, sectionId` (null means Unsorted) |
| `pick_lineage` | `projectId, name` (catalogue name or ID) |
| `reroll_lineage` | `projectId` |
| `undo_edit` | `editId` (positive integer from a successful edit) |

IDs must belong to the current sidebar scope. Sections must belong to the
project and threads must be present in that project, including moves to
Unsorted. Section names use the forms' section-name validator; lineage choices
use the forms' preference validator. Unknown projects, threads, sections and
undo IDs return `not_found`. Validation finishes before the write; none of
these operations combines a rename with a membership replacement.

Results are a discriminated union:

```ts
{ ok: true, status: 'committed' | 'committed_refresh_failed', editId: number, summary: string, state: ProjectEdits }
{ ok: false, error: { code: string, message: string } }
```

Section failures retain the forms' codes, including `duplicate_name`,
`invalid_name`, `invalid_id`, `not_found`, `unsafe_path` and `corrupt`.
Malformed operations and unknown lineages return `invalid_input`.
Rejected backend writes return `write_failed`; internal exception details
are not exposed. Undo of a field that has since changed returns `conflict`.
The queue stays usable after any failed call.

## History and undo

Successful writes enter one bounded, in-memory history in the shared edit
service. Form saves and agent calls appear together as short thread entries;
rejected writes add no success entry. As soon as a write commits, its returned
value (or the acknowledged membership move) updates the shared state and its
history and inverse are recorded, before refresh. A failed read-back returns
`ok: true, status: 'committed_refresh_failed'`, preserving the edit ID, summary,
committed state and undo. Callers must not retry that write as if it were
rejected; they can refresh or undo it. Normal success returns
`status: 'committed'`. Forms receive `CommittedRefreshError` with the committed
edit ID and show “Saved, but could not refresh inspector” while retaining the
history entry. The service publishes committed state and
history to React subscribers, so the picker, inspector and scene observe the
same state. The scene redraws on its next snapshot poll.

Every agent edit has an Undo button in the default thread surface. Undo
restores the previous committed field value using the same backend, rather
than trying to invert the requested text. A lineage undo preserves later
display-name changes; a section rename undo preserves membership. A move undo
restores its previous section or Unsorted. Undo first reads the backend and
checks both its current value and a per-field revision. Any later write through
the shared service supersedes an earlier undo for that field, even if it writes
the same value or changes away and back. Form membership saves supersede undo
for every included or removed thread. It records an “Undid”
entry after success and consumes the original undo ID. A rejected undo write keeps
its ID available for retry. A committed undo consumes its original ID and records
its entry before refresh too. If that refresh fails it returns `committed_refresh_failed`;
retrying the consumed ID returns `not_found`. Undo itself has no redo operation.

Design choice: keep the last 200 entries for this panel session. Closing the
panel discards history and undo tokens. Full form saves (display name plus
lineage, or section name plus membership) appear in history without an Undo
button; lineage-only form changes use the same undo support as agent calls.
The backend still has no cross-client compare-and-swap: the preflight read and
a remote write can race. Existing form membership replacements retain the
partial-write limitation documented in `inspector-edits.md`.

Tests use a fake thread component and real memory edit stores, without a
provider, to check dispatch, validation, shared state, form history and undo.
