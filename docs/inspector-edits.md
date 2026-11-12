# Inspector edits

The Aleph pane stacks the thread above the inspector. A creature edits a display
name and lineage; a limb edits its section name and members. Unsorted is computed
and has no rename control. Successful form writes add one short line to the
thread. Failed writes show an error and add no success line.

Drafts belong to the selected project/section. Sidebar and backend refreshes
update untouched fields while preserving edited name, lineage, and member
fields, along with validation errors. Changing selection starts a new draft.
A successful Save clears that item's dirty fields and adopts its committed
values; Seeded and Re-roll reset only the lineage field, preserving a draft name.

## Shared write interface

`aleph/src/inspector-edits.ts` exports `FoundryEdits`, implemented by
`InspectorEdits(sections: SectionsBackend, lineages: LineageStore)`:

```ts
await edits.refresh(projectId)
await edits.saveCreature(projectId, { name: 'Moss' })
await edits.saveCreature(projectId, { lineage: { name: 'Phoenix' } })
await edits.saveCreature(projectId, { lineage: {} }) // seeded default
await edits.reroll(projectId)
await edits.saveSection(projectId, sectionId, 'Plans', ['thread-a', 'thread-b'])
await edits.moveCard(projectId, threadId, null) // Unsorted
```

Thread tools should receive the panel's existing `edits` instance, use these
methods, and record success only after the promise resolves. Calls are serialized.
`project(id)` returns a defensive copy of committed preferences and sections;
`has(id)` distinguishes loaded state from defaults. `subscribe` and `version`
support React's `useSyncExternalStore`. `sidebar(input)` projects committed names
and membership into both the picker and live scene. Sidebar changes trigger a
fresh read, so edits made outside the pane are read back too.

`saveSection` renames first, then replaces membership: removed cards move to
Unsorted and added cards move into the section. Duplicate names therefore fail
before any membership change. The bb backend maps HTTP 409 to `duplicate_name`;
the inspector displays “Name already exists”. Multi-card updates are **not a
transaction** in bb. If a later move fails, the service reads back the partial
result, publishes it, and rejects the call. Retry from that displayed state.
As with the sections backend, separate clients can race a membership replacement.

## Lineage storage

Design choice: Aleph keeps `lineages.json` in its own plugin data directory,
beside the sections modules' storage boundary rather than in any Hermes kanban
database. Its versioned format is:

```json
{"v":1,"projects":{"project-a":{"name":"Moss","lineage":{"name":"Phoenix"}}}}
```

The key is the project ID. Name is a Foundry display override, not a bb project
rename. Omitted name uses the host's current project name; omitted/empty lineage
uses the generator's seeded default. A re-roll chooses the next lineage after
the current pick and persists its name. A missing file or project is recoverable:
reads return defaults and the next write recreates it. Invalid JSON, invalid
preferences, or an unreadable file fail visibly and are never overwritten.
The plugin server owns one `FileLineageStore`, serializes read/merge/write, and
replaces the JSON file atomically. It is not a multi-process file-lock protocol;
external writers should use `lineage.get` and `lineage.set` RPC instead.

`RpcLineageStore` adapts those validated RPC methods to `LineageStore`.
`MemoryLineageStore` provides the same interface for tests/previews.
Different open panels read preferences again on their next sidebar update;
there is no cross-window push subscription for this file yet.

`InspectorLiveApi` adds committed lineage to snapshots and changes the epoch on
each published edit. The scene's next poll resyncs from that snapshot; its
creature cache key includes lineage, so choosing or re-rolling rebuilds geometry
without waiting for the host sidebar to change. The Hermes bundle is unchanged.
