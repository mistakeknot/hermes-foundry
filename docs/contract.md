# Foundry contract (draft 4, proposed)

**Status of this document: proposed.** The only decision mk made is the idea, on card GSVP-10 ("3D workspace to visualize and operate the software factory in hermes"). Everything here is a design choice, proposed and not decided: the model, the endpoints, the ownership of this file, the change procedure, the transport, the ordering rules and every "must", "never" and "only" below. Nothing in this file records an mk ruling other than the idea. Proposed ownership: the coordinator edits this file; a change goes in through a PR and the executors are told. Revision 4 answers the third cross-lab review (ownership cardinality: a worker holds at most one card in the display, and the transport wording for the pane's `ctx.rest`); revision 3 answered the second cross-lab review (last_seq, upsert/remove events, ownership invariant, id and status consistency, transcript paging); revision 2 answered the first (assignment vs. claim, board-qualified ids, event payloads, status mapping, transcripts, live vs. fixture commands).

Proposed purpose: one normalized model shared by the live plugin, the fixture state machine and the pane. In live mode the Hermes kanban stays the source of truth.

## Ids

A project is one Hermes board, and its id is the bare board slug (for example `"main"`). Every other id is global: `"<board>:<native_id>"` (for example `"main:t_91ab"`). A board slug never contains `:`. So a command names its target with one id and no separate board field. Worker ids are `"<board>:<session_or_run_id>"` in live mode and `"fx:<n>"` in fixture mode.

## Snapshot (GET /api/plugins/foundry/snapshot)

```json
{"v":1,"mode":"fixture|live","epoch":"<opaque>","cursor":"<opaque>","last_seq":int,
 "projects":[{"id":"main","name":"...","epics":[{"id":"main:e1","title":"..."}],
   "cards":[{"id":"main:t1","title":"...","epic_id":"main:e1|null",
             "status":"open|running|blocked|review|done|unknown",
             "status_native":"triage|todo|scheduled|ready|running|blocked|review|done|<anything else, passed through>",
             "assignee_profile":"profile-name|null",
             "claimed_by":"worker-id|null",
             "blocked_on":"human|null",
             "docs":[{"path":"...","title":"..."}],"updated_at":"RFC3339"}]}],
 "workers":[{"id":"main:s1","name":"...","state":"working|waiting_human|looping|idle|unknown",
             "card_id":"main:t1|null"}],
 "paused":false}
```

Rules (proposed):

- **Assignment and ownership are three different things.** `assignee_profile` is the Hermes profile the card is assigned to (what `assign_task(conn, task_id, profile)` writes). `claimed_by` is the worker (session or run) that actually holds the card; it is set only from a claim or run record, never inferred from the profile. A worker's `card_id` is the same fact seen from the other side and must agree with `claimed_by`.
- **Atomic snapshot.** The server reads the snapshot, its `cursor` and its `last_seq` (the `seq` of the last event already reflected in the snapshot; `0` for a fresh epoch) in one consistent read, so applying events with `seq > last_seq` on top of the snapshot neither skips nor repeats a change.
- **Ownership invariant.** `claimed_by` on a card is the single source. A worker's `card_id` is derived from it by the reducer after every event, deterministically: a worker holds at most one card in the display. If several cards name the same worker, the worker's `card_id` is the one with the latest `updated_at` (ties: the greatest card id); the others keep `claimed_by` and are drawn as claimed without a climber on them. A `claimed_by` that names a worker not in `workers` is treated as `null` for drawing (the raw id may be shown as text). On `worker_removed` the reducer clears `claimed_by` on every card that names it. The snapshot's worker `card_id` is informational and must match the derivation. The shared reducer test vectors must include: two cards for one worker, a claim naming a missing worker, and removing a worker that holds a card.
- **Unknown values are shown, not guessed.** A worker state the source cannot give is `"unknown"` and the pane draws a neutral climber. A native status outside the table below is passed through in `status_native`, `status` is `"unknown"`, and the pane draws a grey scale labelled with the native text.
- **Status mapping (display from native).** `triage`, `todo`, `scheduled`, `ready` map to `open`. `running` maps to `running`. `blocked` maps to `blocked`. `review` maps to `review`. `done` maps to `done`. `archived` cards are omitted. The fixture uses the same native names.

## Events (GET /api/plugins/foundry/events?since=<cursor>&epoch=<epoch>)

Reply: `{"v":1,"epoch":"<opaque>","cursor":"<opaque>","events":[Event...],"resync":false}`.

`Event = {"seq":int,"ts":"RFC3339","type":T,"payload":P}`. Events carry whole objects, so the reducer can always rebuild the snapshot shape:

| type | payload |
|---|---|
| `card_upsert` | `{card: <full card object>}` (create or any change to a card: status, profile, claim, blocked_on, docs, title) |
| `card_removed` | `{card_id}` (archived or deleted; the card disappears) |
| `comment_added` | `{card_id, author, text}` (comments are not part of the snapshot; the pane may show them as they arrive) |
| `worker_upsert` | `{worker: <full worker object>}` (create or any change: name, state; `card_id` here is informational and recomputed from cards) |
| `worker_removed` | `{worker_id}` |
| `paused` | `{paused}` |

A change the source cannot express in these events (for example a new epic or a project rename) is answered with `resync:true`, so the pane refetches the snapshot. The server never sends an event the reducer cannot apply.

Cursor and ordering rules (proposed):

- `seq` is strictly increasing within one `epoch` and need not be contiguous (live sources may skip numbers); there is no gap detection. Completeness is the server's job: if it cannot guarantee that the events after `since` are complete, it replies `resync:true`.
- The pane keeps a watermark, initialised from the snapshot's `last_seq` and reset on every epoch change. It applies events in `seq` order and ignores any event with `seq <= watermark` (duplicates and replays), then raises the watermark. The cursor is opaque to the pane: it stores the cursor from the latest reply and sends it back unchanged. The server advances the cursor to the last event it returned (or keeps it when `events` is empty).
- `resync:true` (a cursor the server no longer holds, an unrepresentable change, or an epoch mismatch) means: discard events, refetch the snapshot, and reset the watermark.
- **Epoch.** The epoch changes whenever the history is discarded: a fixture `reset`, a server restart that loses the fixture state, or live-mode cursor loss. A request with an old epoch gets `resync:true` and the new epoch. After `reset` returns, every client's next poll resyncs.
- **Reconnect.** The pane polls this endpoint at a fixed short interval (the proposed approach, because `ctx.socket` is reported to do nothing on OAuth remotes) and resyncs on any error or `resync:true`. A push channel may only shorten the poll delay; correctness never depends on it.

Proposed reducer: `applySnapshot` and `applyEvent`, pure, one shared definition (or the same logic in Python and TS with a shared test vector file), covering stable ids, ordering, duplicates and resync.

## Commands (POST /api/plugins/foundry/command)

Reply: HTTP 200 with `{"ok":bool,"error?":string}`; a failed command changes no displayed state, and the pane shows the error before it changes anything.

Live commands (proposed floor; each maps to a verified Hermes action):

| command | live action |
|---|---|
| `set_status{card_id, status_native}` | the kanban PATCH, limited to the native workflow's manual moves; a move the workflow refuses returns `ok:false` with the reason |
| `assign{card_id, profile}` | `assign_task(conn, task_id, profile)`: assigns the profile. Foundry does **not** claim or start the card; Hermes' dispatcher may start a ready card once it is assigned. |
| `comment{card_id, text}` | `add_comment` |

Proposed optional commands, **fixture only until each is proven against stock Hermes on the gate days, and drawn with a "simulated" badge when not live**: `claim{card_id, worker_id}` (a simulated claim), `message{worker_id, text}`, `stand{on}`, `new_worker{card_id}` (a simulated launch), and `reset{}`. The cited delegation API configures routing and has no worker-launch action, so `new_worker` has no live implementation until a launch call is found and shown to work on stock Hermes.

## Transcripts (proposed, optional)

`GET /api/plugins/foundry/transcript?worker_id=<id>&limit=<n>&before=<seq>` returns `{"lines":[{"seq":int,"role":"user|assistant|tool","text":"..."}],"truncated":bool,"next_before":int|null}`. `before` is an exclusive upper bound on `seq` (omit it for the newest lines). The reply holds at most `limit` lines (server cap 200), in ascending `seq`, each `text` cut to 2000 characters. `truncated` is true when older lines exist; then `next_before` is the smallest `seq` returned, to be passed as `before` for the next page, and otherwise it is `null`. Fixture mode serves scripted lines. If the live source does not give transcripts by the end of Nov 8, the worker panel shows only the worker's name, state and held card, and the transcript view leaves the required demo.

## Pane adapter

The pane talks only to `FoundryApi { snapshot(); subscribe(cb); command(c); transcript?(id) }`. The transport behind it is our own router, `/api/plugins/foundry`. That the pane's `ctx.rest` cannot reach another plugin's REST is exec A's reading of the Hermes source, an assumption until the Nov 7 integration gate proves it (this concerns the pane only: Foundry's own Python router runs server-side and may call the kanban code directly); the gate also decides whether polling alone is enough and checks that requests are authenticated the way the Hermes plugin router enforces. The pane code does not change with the transport.

## Fixture

Proposed: 3 projects (boards), about 40 cards, 4 workers, one loop (a worker `looping`), one card blocked on a human. A deterministic state machine: each fixture command has a scripted response and `reset` restores the start (new epoch). It runs with no model calls or credentials. The pane shows a "simulated" badge in fixture mode and on any simulated action.

The slip: a climber whose worker reports `looping` struggles on its hold, slips down the scale and catches a new hold, on a loop (read-only motion, no command, no event). It is drawn from the reported state alone. The live source never reports `looping` (the kanban records no loop state), so a live climber never slips; the slip is shown only in the fixture, where the pane is badged simulated.
