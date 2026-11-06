# Plan: "Foundry" — a 3D workspace to see and run the software factory in Hermes

Bead: mk-ps6ow. Card: GSVP-10 (closed). mk's answer on the card: "3D workspace to visualize and operate the software factory in hermes".
Deadline: Nov 11, 2026, 2 PM PST. Build window: Nov 7 to Nov 10; Nov 11 morning is for the video and submission.
Name "Foundry" is a placeholder (design choice).

**Status of this document: proposed.** The only decision mk made is the idea, on card GSVP-10 ("3D workspace to visualize and operate the software factory in hermes"). Everything else here is a design choice, proposed and not decided: the scope, the day plan, the cut order and every "must", "never" and "required" below. No line in this document records an mk ruling other than the idea. If a cut would change what mk sees in the entry, it goes to mk as one question through the vizier.

## What "the software factory" means here (design choice)
Judges run stock Hermes, so the factory must be Hermes's own:
- **Projects** are Hermes kanban boards.
- **Tasks** are kanban cards.
- **Docs** are files that cards link to.
- **Workers** are Hermes sessions and delegated subagents.

A second adapter that reads beads and Citadel is the GSV bonus. Proposed: cut now (see the cut order under Risks); it comes back only if everything above the floor is done and green.

## What you see and do
- **Valley view:** each project is a creature standing in one valley, sized by open work.
- **Creature anatomy:**
  - epics are limbs;
  - cards are scales on a limb, coloured by status (open, claimed, blocked glowing, done weathered to stone);
  - linked docs are carvings on the hide.
- **Workers are climbers.**
  - Where a climber is shows the card it holds.
  - How it moves shows its state: climbing is working, clinging is waiting on a human, slipping is looping.
  - Optional: a slip comes from a repeated-row check in pre_tool_call, the True Touch idea. Without it, "looping" is shown only where the source reports it (or in the fixture, labelled simulated).
- **Operating from the scene (floor, proposed):**
  - Click a scale and its card opens in a side panel, where you can comment and change status.
  - Assign a card to a profile with a button. This is a profile assignment (`assign_task`), not a claim: the card's claimant (the worker that holds it) is shown separately and is never inferred from the profile.
- **Operating from the scene (optional, in cut order):**
  - Drag a climber onto a scale (a gesture for the assign button).
  - Click a climber to see its name, state and held card; a bounded transcript and "send a message" only if the live source supports them (see docs/contract.md, Transcripts). Fixture mode simulates them, labelled.
  - "+ new climber" (launch a worker) and "stand" (pause at the next tool boundary) are fixture-simulated unless proven on stock Hermes; no launch call has been found yet.
- **The 2D board stays one keystroke away.** Every action must be at least as fast as the board, or the 3D view is a gimmick.

## Architecture
1. **Python plugin** (`register(ctx)`, plugin.yaml):
   - **Hooks:** kanban_task_claimed/completed/blocked, the session start/end/finalize hooks, pre_tool_call and post_tool_call.
   - **State:** the kanban stays the source of truth. The pane initializes from a board snapshot and follows the events cursor (or a bounded snapshot refresh); the hook log only adds worker and session signals. Stable IDs, ordering, dedup and resync on reconnect are defined once in a reducer that the fixture also uses.
   - **Tools:** `foundry_assign`, `foundry_stand` and `foundry_message`, which wrap the existing kanban, delegation and session actions.
   - **Feed:** Foundry's own router under `/api/plugins/foundry` with an events cursor, polled by the pane. The desktop socket is a no-op on OAuth remotes and one plugin's REST cannot reach another's, so push is at most a poll accelerator. Authentication is whatever the Hermes plugin router already enforces; the local-page fallback must not weaken it and is only used if it keeps the same authenticated origin. Live and fixture commands stay separate; a failed command is shown before any displayed state changes.
2. **Desktop JS pane:**
   - three.js scene.
   - Procedural creature builder: a deterministic seed from the project id, so the same project always looks the same.
   - Instanced scales, orbit and zoom only.
   - Side panel for cards and docs (transcripts only if the contract's optional endpoint is met).
3. **Fixture (revised):** a deterministic state machine, not a timed recording. It sits behind the same command and feed interface as live Hermes, has a reset and an explicit demo mode, and every floor action (answer a blocked card, change status, assign a profile) and every optional action that is kept (claim, message, stand, new climber) gets a scripted response with no model calls or credentials. Simulated execution is labelled as such. Seed data: a recorded factory session (3 projects, about 40 cards, 4 workers, one loop, one blocked card waiting on a human). It replays through the same feed, so the demo never depends on live model output.

## Day plan (revision 1, after cross-lab plan review)
- **Nov 7 (gate day):**
  - Morning: lock the minimal normalized schema (project, epic or "ungrouped" limb, card, status, doc link, worker, worker state) and map every field to a verified Hermes source. Omit a worker state the source cannot give; never infer it silently.
  - Plugin skeleton, shared reducer, fixture state machine (see Architecture).
  - **Afternoon integration gate:** install the packaged plugin on a stock Hermes with a clean `HERMES_HOME`, no API keys, no developer checkout. Render bundled three.js on `/foundry`, read one card, change its status from the pane, and see the update come back. If cross-plugin REST or CSP fails, pick the fallback (own Python router and/or local page) that same afternoon and re-run the gate.
  - Also settle by end of day: the supported Hermes version, and the exact install, restart and open-demo commands.
  - Also decide: can "stand" (cooperative pause at the next tool boundary, delegated sessions included) be proven? If not by end of Nov 7, it leaves the required demo.
- **Nov 8:** valley view, statuses, climbers driven by the fixture state machine, click a scale to open card and doc, assign and status buttons working on both fixture and live Hermes.
- **Nov 9 (feature freeze at end of day):** message a climber, delegate ("+ new climber"), drag gesture (optional), then optional items in cut order. Clean-home install rehearsal on the fixture.
- **Nov 10 (verify and record):** timed interaction checklist against the 2D board, art direction (original look: stone, lichen, coral), performance pass, README, catalog PR draft, record the full 90s video and one live take. Nothing new ships after Nov 9.
- **Nov 11 AM:** only mk's submission steps (catalog PR, X post, entry form) and a re-record if the Nov 10 take failed.

## Demo storyboard (90s, proposed)
Floor storyboard: it needs only click, comment, status and assign buttons, on fixture or live Hermes.
- **0-10s:** pull back over a valley of creatures. Caption: "your software factory".
- **10-25s:** zoom onto one creature. Scales are coloured by status; climbers sit on the cards they hold.
- **25-40s:** one climber clings (waiting on a human). Click its scale, comment and change the card's status; it climbs again.
- **40-55s:** assign a glowing card to a profile with the button; the card's claim appears and the scale changes.
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
- **Not yet checked:**
  - whether a plugin can read another plugin's REST namespace through `ctx.rest`, or must proxy it from Foundry's own Python router;
  - whether three.js runs inside a runtime `plugin.js` bundle without CSP issues.
  - These are the first checks on Nov 7.
- **Probe clone:** `/tmp/foundry-probe/hermes-agent`, outside scanned roots. It is disposable.

## Risks
- **Cross-plugin REST access and CSP for three.js are unverified.** Fallback: Foundry's own Python router proxies the kanban calls; serve the scene as a local web page opened from a slash command.
- **Legibility past about 100 cards.** Show scales only on zoom; group by epic.
- **Scope (proposed, not decided). Proposed cut order:** the beads adapter (cut now), sound, the slip check, "stand" (unless proven Nov 7), transcripts, live message and delegation, then the drag gesture. Proposed floor, not to be cut: click-to-open, comment and status buttons, and profile assignment via a button. The floor storyboard above needs only the floor.
- **"Stand" must not overclaim.** It pauses at the next tool boundary and never claims to cancel a tool call already running.
- **Acceptance:** a small timed checklist (open a card, change a status, assign a profile, each at least as fast as the 2D board) and a clean-install fixture rehearsal on Nov 9 and again on Nov 10. Live execution is optional.

## Gates (unchanged)
- The code goes in a new private repo first. Making it public, the catalog PR, the X post and the entry form are all mk's.
- Cross-lab review of this plan before executors start (the reviewer independence rule).

## Revision log
- Rev 2 (Nov 6, PST): answered the cross-lab PR review of rev 1 (7 findings): delegation evidence corrected, profile assignment separated from claim ownership, contract made implementable (global ids, event payloads, cursor and epoch rules, native-status mapping, live vs fixture-only commands, transcript endpoint or cut), proposal banner on the contract, floor storyboard independent of optional cuts, beads adapter scope made consistent.
- Rev 1 (Nov 6, PST): applied the cross-lab plan review (Astra, REVISE, 9 findings): Day-1 integration gate, state-machine fixture, install spec on day 1, cut order, "stand" proof-or-remove, normalized schema, kanban as source of truth, transport choice, feature freeze on Nov 9.
