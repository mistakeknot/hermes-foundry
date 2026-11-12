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

Acknowledged single-field writes enter one bounded, in-memory history in the
shared service. Form saves and agent calls appear together as short thread
entries. A rejected single-field write adds no success entry. A form membership
replacement can partly commit: if its rename or earlier moves succeeded before
a later move is rejected, it adds a “partly saved” entry and reports the rejection.
Those entries have no Undo button; reload and retry from the displayed state.

The edit service accepts either a normal backend result or a typed
`SectionsCommittedError` that identifies the acknowledged rename or move.
The bb backend uses that error when its membership read fails after a rename
acknowledgement; the name remains committed. The edit service updates the known
field, advances its revision, and records history and an inverse before trying
its own refresh. A rename acknowledgement does not confirm membership: until a
successful refresh, membership comes from the last observed state. A move
acknowledgement confirms only that thread's assignment. The returned `state`
therefore combines last-observed and acknowledged values; it is not a
cross-client atomic snapshot.

If either backend or service post-write read-back fails, the dispatcher returns
`ok: true, status: 'committed_refresh_failed'`, preserving the edit ID, summary,
known field value and undo. This status also applies if a subsequent refresh in
that call recovers. Callers must not retry the write as though it were rejected;
they can refresh or undo it. Normal success returns `status: 'committed'`.
Forms receive `CommittedRefreshError` with the committed edit ID and show
“Saved, but could not refresh inspector” while retaining the history entry.
History and known values publish to React subscribers; the scene observes them
on its next snapshot poll.

Every agent edit has an Undo button in the default thread surface. Undo
restores the previous committed field value using the same backend, rather
than trying to invert the requested text. A lineage undo preserves later
display-name changes; a section rename undo preserves membership. A move undo
restores its previous section or Unsorted. Undo first reads the backend and
checks both its current value and a per-field revision. Any later write through
the shared service supersedes an earlier undo for that field, even if it writes
the same value or changes away and back. A successful refresh that observes a
different lineage, section name or thread assignment also advances that field revision;
observing an external change away and back therefore still supersedes undo.
Unchanged refreshes and changes to other fields preserve it. Form membership
saves supersede undo for every included or removed thread. It records an “Undid”
entry after success and consumes the original undo ID. A rejected undo write keeps
its ID available for retry. A committed undo consumes its original ID and records
its entry before refresh too. If that refresh fails it returns `committed_refresh_failed`;
retrying the consumed ID returns `not_found`. Undo itself has no redo operation.

Design choice: keep the last 200 entries for this panel session. Closing the
panel discards history and undo tokens. Full form saves (display name plus
lineage, or section name plus membership) appear in history without an Undo
button; lineage-only form changes use the same undo support as agent calls.
The backend still has no cross-client compare-and-swap: an external write can
land between the final preflight read and the undo write. External changes that
happen entirely between reads (including an unobserved away-and-back cycle)
cannot be detected. A failure while awaiting a write acknowledgement also leaves
the remote outcome unknown: refresh before retrying a `write_failed` call.
Existing form membership replacements retain the partial-write limitation documented in `inspector-edits.md`.

Tests use a fake thread component, memory stores, and the real bb sections
backend over a fake SDK. They cover post-acknowledgement read failures, observed
external changes, dispatch, validation, shared state, form history and undo.

## Provider chat bridge

A provider-backed chat thread reaches the dispatcher above through native bb
tools, never through the browser directly. The dispatcher lives in the open
Foundry pane, so the server half only relays calls to it.

- Tools: one per operation, named `foundry_rename_section`, `foundry_move_thread`,
  `foundry_pick_lineage`, `foundry_reroll_lineage` and `foundry_undo_edit`. Their
  parameter schemas are the ones in `src/edit-operations.ts` (a module with no
  imports, so the server bundle stays inside `aleph/`).
- Gate: tools attach only to threads whose plugin metadata has `chat: true`.
  Tools take effect at the next provider session start, so create the chat
  thread after the plugin is installed.
- Protocol: a tool call publishes `{callId, call}` on realtime channel
  `edit.call`. Every open pane hears it; the first to call RPC `edit.claim` runs
  it (so several windows never double-edit). That pane runs
  `AgentEdits.dispatch` and calls `edit.report` with the result. The tool then
  answers the model with "Done: <summary>. Undo with edit id N." or
  "Not done (code): message".
- Timeouts: 10 s for a claim, 30 s for a report. No claim gives
  `pane_unavailable` ("Open the Foundry pane and try again"). A claim with no
  report says to check the pane before retrying. An abort gives `cancelled`; an
  already-aborted call is never broadcast.
- Limit: a pane must be open. With no pane, edits fail cleanly and nothing is
  written. Edits made through the bridge are in the pane's history and can be
  undone there like any agent call.

Tests (`test/edit-bridge.test.ts`, `test/panel.test.ts`) cover the claim/report
rules, timeouts, abort, RPC validation and the panel receiving a call through
the real dispatcher. Not yet verified on a live bb: realtime delivery to the
pane and tool attachment to a spawned thread.
