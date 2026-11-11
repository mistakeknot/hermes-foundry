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
{ ok: true, editId: number, summary: string, state: ProjectEdits }
{ ok: false, error: { code: string, message: string } }
```

Section failures retain the forms' codes, including `duplicate_name`,
`invalid_name`, `invalid_id`, `not_found`, `unsafe_path` and `corrupt`.
Malformed operations and unknown lineages return `invalid_input`.
Other backend failures return `write_failed`; internal exception details
are not exposed. Undo of a field that has since changed returns `conflict`.
The queue stays usable after any failed call.

## History and undo

Successful writes enter one bounded, in-memory history in the shared edit
service. Form saves and agent calls appear together as short thread entries;
failed calls add no success entry. The service publishes committed state and
history to React subscribers, so the picker, inspector and scene observe the
same state. The scene redraws on its next snapshot poll.

Every agent edit has an Undo button in the default thread surface. Undo
restores the previous committed field value using the same backend, rather
than trying to invert the requested text. A lineage undo preserves later
display-name changes; a section rename undo preserves membership. A move undo
restores its previous section or Unsorted. Undo first reads the backend and
refuses to overwrite a later change to that field. It records an “Undid”
entry after success and consumes the original undo ID. A failed undo keeps
its ID available for retry. Undo itself has no redo operation.

Design choice: keep the last 200 entries for this panel session. Closing the
panel discards history and undo tokens. Full form saves (display name plus
lineage, or section name plus membership) appear in history without an Undo
button; lineage-only form changes use the same undo support as agent calls.
The backend still has no cross-client compare-and-swap: the preflight read and
a remote write can race. Existing form membership replacements retain the
partial-write limitation documented in `inspector-edits.md`.

Tests use a fake thread component and real memory edit stores, without a
provider, to check dispatch, validation, shared state, form history and undo.
