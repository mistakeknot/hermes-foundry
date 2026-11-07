# Plan: "Foundry" — a 3D workspace to see and run the software factory in Hermes

Bead: mk-ps6ow. The idea, from the project brief: a 3D workspace to visualize and operate the software factory in Hermes.
Deadline: Nov 11, 2026, 2 PM PST. Build window: Nov 7 to Nov 10; Nov 11 morning is for the video and submission.
Name "Foundry" is a placeholder (design choice).

**Status of this document: proposed.** The project brief is the idea: a 3D workspace to visualize and operate the software factory in Hermes. Everything else here is a design choice, proposed and not decided: the scope, the day plan, the cut order and every "must", "never" and "required" below. No line in this document records a decision other than the idea and the recorded cut of the beads adapter (bead mk-ps6ow.7). If a cut would change what the entry shows, it goes to the maintainer as one question.

## What "the software factory" means here (design choice)
Judges run stock Hermes, so the factory must be Hermes's own:
- **Projects** are Hermes kanban boards.
- **Tasks** are kanban cards.
- **Docs** are files that cards link to.
- **Workers** are Hermes sessions and delegated subagents.

A second adapter that reads beads and an estate tracker was a bonus. It is cut (bead mk-ps6ow.7): a feasibility note judged it not worth the risk to the boot path before the deadline, and no code was written for it.

## What you see and do
- **Valley view:** each project is a creature standing in one valley, sized by open work.
- **Creature anatomy:**
  - epics are limbs;
  - cards are scales on a limb, coloured by display status (open, running, blocked glowing, review, done weathered to stone, unknown grey);
  - linked docs are carvings on the hide.
- **Workers are climbers.**
  - Where a climber is shows the card it holds.
  - How it moves shows its state: climbing is working, clinging is waiting on a human, slipping is looping.
  - Optional: a slip comes from a repeated-row check in pre_tool_call, the True Touch idea. Without it, "looping" is shown only where the source reports it (or in the fixture, labelled simulated).
- **Operating from the scene (floor, proposed):**
  - Click a scale and its card opens in a side panel, where you can comment and change status.
  - Assign a card to a profile with a button. This is a profile assignment (`assign_task`), not a claim (Foundry does not claim or start the card, and Hermes may start it once assigned): the card's claimant (the worker that holds it) is shown separately and is never inferred from the profile.
- **Operating from the scene (optional, in cut order):**
  - Drag a climber onto a scale. This only opens the same profile selector as the assign button (a worker exposes no profile, so the profile is never inferred from the worker); it does not claim the card.
  - Click a climber to see its name, state and held card; a bounded transcript and "send a message" only if the live source supports them (see docs/contract.md, Transcripts). Fixture mode simulates them, labelled.
  - "+ new climber" (launch a worker) and "stand" (pause at the next tool boundary) are fixture-simulated unless proven on stock Hermes; no launch call has been found yet.
- **The 2D board stays one keystroke away.** Every action must be at least as fast as the board, or the 3D view is a gimmick.

## Architecture
1. **Python plugin** (`register(ctx)`, plugin.yaml):
   - **Hooks:** kanban_task_claimed/completed/blocked, the session start/end/finalize hooks, pre_tool_call and post_tool_call.
   - **State:** the kanban stays the source of truth. The pane initializes from a board snapshot and follows the events cursor (or a bounded snapshot refresh); the hook log only adds worker and session signals. Stable IDs, ordering, dedup and resync on reconnect are defined once in a reducer that the fixture also uses.
   - **Tools (proposed):** `foundry_assign` wraps profile assignment and is part of the floor. `foundry_stand` and `foundry_message` are conditional: they exist only if a matching Hermes action is found and proven on stock Hermes; otherwise they are fixture-only and labelled simulated.
   - **Feed:** Foundry's own router under `/api/plugins/foundry` with an events cursor, polled by the pane. Exec A's reading of the Hermes SDK source (not yet proven at runtime, see "Source-read" below) is that the desktop socket does nothing on OAuth remotes and that the pane cannot reach another plugin's REST through `ctx.rest`; so Foundry's Python router, which runs server-side and may reuse the kanban code directly, serves the pane, and push is at most a poll accelerator. Authentication is whatever the Hermes plugin router already enforces; the local-page fallback must not weaken it and is only used if it keeps the same authenticated origin. Live and fixture commands stay separate; a failed command is shown before any displayed state changes.
2. **Desktop JS pane:**
   - three.js scene.
   - Procedural creature builder: a deterministic seed from the project id, so the same project always looks the same.
   - Instanced scales, orbit and zoom only.
   - Side panel for cards and docs (transcripts only if the contract's optional endpoint is met).
3. **Fixture (revised):** a deterministic state machine, not a timed recording. It sits behind the same command and feed interface as live Hermes, has a reset and an explicit demo mode, and every floor action (answer a blocked card, change status, assign a profile) and every optional action that is kept (claim, message, stand, new climber) gets a scripted response with no model calls or credentials. Simulated execution is labelled as such. Seed data: a recorded factory session (3 projects, about 40 cards, 4 workers, one loop, one blocked card waiting on a human). It replays through the same feed, so the demo never depends on live model output.

## Day plan (revision 1, after cross-lab plan review)
- **Nov 7 (gate day):**
  - Morning: lock the minimal normalized schema (project, epic or "ungrouped" limb, card, status, doc link, worker, worker state) and map every field to a verified Hermes source. Report a worker state the source cannot give as `unknown`; never infer it silently.
  - Plugin skeleton, shared reducer, fixture state machine (see Architecture).
  - **Afternoon integration gate:** install the packaged plugin on a stock Hermes with a clean `HERMES_HOME`, no API keys, no developer checkout. Render bundled three.js on `/foundry`, read one card, change its status from the pane, and see the update come back. The gate also checks that every request is authenticated the way the Hermes plugin router enforces. If CSP or the REST assumption fails, pick the fallback (own Python router and/or local page, same authenticated origin) that same afternoon and re-run the gate.
  - Also settle by end of day: the supported Hermes version, and the exact install, restart and open-demo commands.
  - Also decide: can "stand" (cooperative pause at the next tool boundary, delegated sessions included) be proven? If not by end of Nov 7, it leaves the required demo.
- **Nov 8:** valley view, statuses, climbers driven by the fixture state machine, click a scale to open card and doc, assign and status buttons working on both fixture and live Hermes.
- **Nov 9 (feature freeze at end of day):** finish and harden the floor first. Then, only if time remains and each is proven on stock Hermes (otherwise fixture-simulated and labelled): message a climber, delegate ("+ new climber"), the drag gesture, in cut order. Clean-home install rehearsal on the fixture.
- **Nov 10 (verify and record):** timed interaction checklist against the 2D board, art direction (original look: stone, lichen, coral), performance pass, README, catalog PR draft, record the full 90s video and one live take. Nothing new ships after Nov 9.
- **Nov 11 AM:** only the maintainer's submission steps (catalog PR, X post, entry form) and a re-record if the Nov 10 take failed.

## Demo storyboard (90s, proposed)
Floor storyboard: it needs only click, comment, status and assign buttons, on fixture or live Hermes.
- **0-10s:** pull back over a valley of creatures. Caption: "your software factory".
- **10-25s:** zoom onto one creature. Scales are coloured by status; climbers sit on the cards they hold.
- **25-40s:** one climber clings (a card blocked on a human). Click its scale, comment and change the card's status; the scale's colour changes. (The climber moves on only if a claim or worker-state event is independently observed, or in the labelled fixture simulation.)
- **40-55s:** assign a glowing card to a profile with the button; the card's profile label updates. (A claim and a worker moving appear only from an observed claim event, or in the labelled fixture simulation. An assignment is not a claim.)
- **55-70s:** a scale turns to stone as its card goes to done; zoom out on the changed valley.
- **70-90s:** install line.

Optional beats, each replacing one floor beat only if it is kept (and shown as simulated unless proven live): 40-55s a climber slips on a loop and catches a new hold; 55-70s drag a new climber onto a glowing weak point; 70-80s "stand" pauses every climber (a simulated pause unless live pause is proven by end of Nov 7).

## Verified against Hermes source (NousResearch/hermes-agent at b524c8a4, Nov 5, 2026)
- **Desktop plugins:**
  - A plugin default-exports a `HermesPlugin` from `@hermes/plugin-sdk`.
  - It can add a route/page (ROUTES_AREA), a sidebar nav row, statusbar items, palette entries and keybinds.
  - User plugins load at runtime from `$HERMES_HOME/desktop-plugins/<name>/plugin.js`.
  - Example plugins live in `hermes-example-plugins`.
  - Foundry ships as a `/foundry` page; no core edits are needed.
- **Kanban:**
  - The bundled desktop kanban plugin (`apps/desktop/src/plugins/kanban`) reads a REST router at `/api/plugins/kanban` (`plugins/kanban/dashboard/plugin_api.py`). Updates are socket-invalidated, with an events cursor.
  - `hermes_cli/kanban_db.py` has create_task, assign_task, claim_task, add_comment and block_task.
  - The kanban lifecycle hooks are tested in `tests/hermes_cli/test_kanban_lifecycle_hooks.py`.
  - Foundry can reuse that router for board data and actions instead of building its own store.
- **Delegation:** `apps/desktop/src/api/delegation.ts` configures delegation routing (backends, model map, profile routes). It exposes no worker-launch action, so "+ new climber" has no verified live implementation; it stays fixture-simulated until a launch call is found and proven (a Nov 7 or Nov 8 check, not a promise).
- **Assignment:** `kanban_db.assign_task(conn, task_id, profile)` assigns a profile. Claiming (`claim_task`) and runs are separate, so Foundry shows profile assignment and claim ownership as separate facts.
- **Statuses:** the default workflow's native statuses are triage, todo, scheduled, ready, running, blocked, review and done (plus archived). The pane maps them for display and keeps the native value visible (docs/contract.md).
- **Source-read, not yet proven at runtime (assumptions until the Nov 7 gate):**
  - exec A's reading of the Hermes plugin SDK on Nov 6 is that `ctx.rest` cannot reach another plugin's REST namespace and `ctx.socket` does nothing on OAuth remotes. Foundry therefore assumes it must serve its own router and poll. This is a reading of source, not a runtime test;
  - whether three.js runs inside a runtime `plugin.js` bundle without CSP issues is unchecked.
  - Both are re-proved at the Nov 7 integration gate.
- **Probe clone:** a disposable source checkout of Hermes, outside scanned roots.

## Risks
- **The cross-plugin REST assumption and CSP for three.js are unproven.** Fallback: Foundry's own Python router proxies the kanban calls; the scene may be served as a local web page opened from a slash command only if it keeps the same authenticated origin as the Hermes plugin router (it must not weaken authentication; if it cannot, the fallback is not used).
- **Legibility past about 100 cards.** Show scales only on zoom; group by epic.
- **Scope (proposed, not decided). Proposed cut order:** the beads adapter (cut, bead mk-ps6ow.7), sound, the slip check, "stand" (unless proven Nov 7), transcripts, live message and delegation, then the drag gesture. Proposed floor, not to be cut: click-to-open, comment and status buttons, and profile assignment via a button. The floor storyboard above needs only the floor.
- **"Stand" must not overclaim.** It pauses at the next tool boundary and never claims to cancel a tool call already running.
- **Acceptance:** a small timed checklist (open a card, change a status, assign a profile, each at least as fast as the 2D board) and a clean-install fixture rehearsal on Nov 9 and again on Nov 10. Live execution is optional.

## Gates (unchanged)
- The code started in a private repo. Making it public, the catalog PR, the X post and the entry form are all the maintainer's.
- Cross-lab review of this plan before executors start (the reviewer independence rule).

## Revision log
- Rev 4 (Nov 6, PST): answered the third cross-lab review (3 findings): ownership cardinality and worker-removal rules with reducer vectors, drag opens a profile selector (no inferred profile), transport sentence in Architecture qualified as a source reading and pane-side vs server-side distinguished.
- Rev 3 (Nov 6, PST): answered the second cross-lab review (7 findings): storyboard no longer implies assignment is a claim or that comments resume a worker; contract made implementable (last_seq, upsert/remove events, ownership invariant, id and status rules); transport claims marked as source-read assumptions with the authenticated-origin condition repeated; stand/message tools and Nov 9 tasks made conditional.
- Rev 2 (Nov 6, PST): answered the cross-lab PR review of rev 1 (7 findings): delegation evidence corrected, profile assignment separated from claim ownership, contract made implementable (global ids, event payloads, cursor and epoch rules, native-status mapping, live vs fixture-only commands, transcript endpoint or cut), proposal banner on the contract, floor storyboard independent of optional cuts, beads adapter scope made consistent.
- Rev 1 (Nov 6, PST): applied the cross-lab plan review (Astra, REVISE, 9 findings): Day-1 integration gate, state-machine fixture, install spec on day 1, cut order, "stand" proof-or-remove, normalized schema, kanban as source of truth, transport choice, feature freeze on Nov 9.
