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

## Wire details (additive; approved by the coordinator, Nov 6)
Design choice: these fix what the draft left open. No field above is removed or renamed.

**Cursor.** Opaque to clients. The Python side uses `"<epoch>.<seq>"`; `seq` only grows, including across `reset`. A client must treat any cursor it did not get from the server as invalid.

**Events response.** `GET /events?since=<cursor>` returns `{"v":1,"cursor":"<head>","events":[...],"resync":false}`. `resync:true` (with `events:[]`) means refetch the snapshot: the cursor is missing, malformed, from another epoch (server restart) or ahead of the head. A client that applies events and finds a seq gap, or an event that names an unknown card or worker, must also resync. Polling is the baseline; a socket, where one exists, is only an accelerator (it is a no-op on OAuth remotes).

**Event payloads** (the reducer ignores payload keys it does not know and event types it does not know, but still advances seq):
| type | payload |
|---|---|
| `card_created` | `{project_id, card:{...full card}}` (idempotent by card id) |
| `card_status` | `{card_id, status, blocked_on:"human"\|null, updated_at}` |
| `card_assigned` | `{card_id, worker_id\|null, updated_at}` |
| `card_commented` | `{card_id, author, text, updated_at}` (only moves `updated_at`; comments are fetched on demand) |
| `worker_state` | `{worker_id, name?, state?, card_id?}`: upserts a worker; a key that is present is applied, `state:null` removes the state (the source cannot give it) |
| `worker_moved` | `{worker_id, card_id\|null}` |
| `paused` | `{paused:bool}` |
| `reset` | `{snapshot:{...}}` replaces all state |

**Commands.** Always HTTP 200 with `{ok:bool,error?:string}`; an unknown type, unknown id, bad status, empty text or a refused action gives `ok:false` and emits no event. `reset` on live gives `ok:false`. Fixture rules: assigning a blocked or done card is refused; a done card has no assignee; a comment on a card blocked on a human unblocks it and the waiting worker resumes; `stand{on:true}` refuses new work until `stand{on:false}`.
