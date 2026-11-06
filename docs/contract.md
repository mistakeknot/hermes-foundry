# Foundry contract (draft 1, owned by the coordinator; change it only by PR and tell the other executor)

Design choice: one normalized model shared by the live plugin, the fixture state machine and the pane. Kanban stays the source of truth in live mode.

## Snapshot (GET /api/plugins/foundry/snapshot)
```json
{"v":1,"mode":"fixture|live","cursor":"<opaque>",
 "projects":[{"id":"p1","name":"...","epics":[{"id":"e1","title":"..."}],
   "cards":[{"id":"c1","title":"...","epic_id":"e1|null (ungrouped limb)","status":"open|claimed|blocked|done",
             "assignee":"w1|null","blocked_on":"human|null","docs":[{"path":"...","title":"..."}],"updated_at":"RFC3339"}]}],
 "workers":[{"id":"w1","name":"...","state":"working|waiting_human|looping|idle","card_id":"c1|null"}],
 "paused":false}
```
A worker state the source cannot give is omitted (state absent), never guessed.

## Events (GET /api/plugins/foundry/events?since=<cursor>)
`{"seq":int,"ts":"RFC3339","type":"card_created|card_status|card_assigned|card_commented|worker_state|worker_moved|paused|reset","payload":{...}}`
One reducer (applySnapshot + applyEvent, pure, same logic in Python and TS or a single shared definition with tests) builds state from snapshot + events: stable ids, ordered by seq, duplicates ignored, resync = refetch snapshot.

## Commands (POST /api/plugins/foundry/command)
`assign{card_id,worker_id|"new"}`, `set_status{card_id,status}`, `comment{card_id,text}`, `message{worker_id,text}`, `stand{on}`, `reset{}` (fixture only).
Reply `{ok:bool,error?:string}`. A failed command changes no displayed state.

## Pane adapter
The pane talks only to `FoundryApi { snapshot(); subscribe(cb); command(c) }`. The transport behind it (ctx.rest to our router, or desktop socket) is decided by the Nov 7 integration gate; the pane code does not change.

## Fixture
3 projects, ~40 cards, 4 workers, one loop (worker looping), one card blocked on a human. A deterministic state machine: each command has a scripted response, `reset` restores the start. Runs with no model calls or credentials. The pane shows a "simulated" badge in fixture mode.
