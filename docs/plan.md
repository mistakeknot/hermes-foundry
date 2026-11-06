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

A second adapter that reads beads and Citadel is the GSV bonus. It ships only if day 3 is green.

## What you see and do
- **Valley view:** each project is a creature standing in one valley, sized by open work.
- **Creature anatomy:**
  - epics are limbs;
  - cards are scales on a limb, coloured by status (open, claimed, blocked glowing, done weathered to stone);
  - linked docs are carvings on the hide.
- **Workers are climbers.**
  - Where a climber is shows the card it holds.
  - How it moves shows its state: climbing is working, clinging is waiting on a human, slipping is looping.
  - A slip comes from a repeated-row check in pre_tool_call, the True Touch idea.
- **Operating from the scene:**
  - Click a scale and its card opens in a side panel, where you can comment and change status.
  - Drag a climber, or "+ new climber", onto a scale to claim or delegate that card.
  - Click a climber to see its live transcript and send it a message.
  - Ring "stand" (one key) to pause all workers at the next tool boundary.
- **The 2D board stays one keystroke away.** Every action must be at least as fast as the board, or the 3D view is a gimmick.

## Architecture
1. **Python plugin** (`register(ctx)`, plugin.yaml):
   - **Hooks:** kanban_task_claimed/completed/blocked, the session start/end/finalize hooks, pre_tool_call and post_tool_call.
   - **State:** the kanban stays the source of truth. The pane initializes from a board snapshot and follows the events cursor (or a bounded snapshot refresh); the hook log only adds worker and session signals. Stable IDs, ordering, dedup and resync on reconnect are defined once in a reducer that the fixture also uses.
   - **Tools:** `foundry_assign`, `foundry_stand` and `foundry_message`, which wrap the existing kanban, delegation and session actions.
   - **Feed:** prefer the existing authenticated desktop transport (socket invalidation plus cursor). Only if that is unusable, prove one own transport end to end on Nov 7. Live and fixture commands stay separate; a failed command is shown before any displayed state changes.
2. **Desktop JS pane:**
   - three.js scene.
   - Procedural creature builder: a deterministic seed from the project id, so the same project always looks the same.
   - Instanced scales, orbit and zoom only.
   - Side panel for cards, docs and transcripts.
3. **Fixture (revised):** a deterministic state machine, not a timed recording. It sits behind the same command and feed interface as live Hermes, has a reset and an explicit demo mode, and every storyboard action (answer a blocked card, assign a worker, stand) gets a scripted response with no model calls or credentials. Simulated execution is labelled as such. Seed data: a recorded factory session (3 projects, about 40 cards, 4 workers, one loop, one blocked card waiting on a human). It replays through the same feed, so the demo never depends on live model output.

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

## Demo storyboard (90s)
- **0-10s:** pull back over a valley of creatures. Caption: "your software factory".
- **10-25s:** zoom onto one creature. Scales glow; climbers are working.
- **25-40s:** one climber clings. Click its scale, answer the card, and it climbs again.
- **40-55s:** another climber slips (a loop); it catches a new hold and the task goes green.
- **55-70s:** drag a new climber onto a glowing weak point; the fix lands and the scale turns to stone.
- **70-80s:** "stand": every climber stops before a bad delete.
- **80-90s:** install line.

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
- **Delegation:** the desktop has a delegation API (`apps/desktop/src/api/delegation.ts`) for the "+ new climber" action.
- **Not yet checked:**
  - whether a plugin can read another plugin's REST namespace through `ctx.rest`, or must proxy it from Foundry's own Python router;
  - whether three.js runs inside a runtime `plugin.js` bundle without CSP issues.
  - These are the first checks on Nov 7.
- **Probe clone:** `/tmp/foundry-probe/hermes-agent`, outside scanned roots. It is disposable.

## Risks
- **Cross-plugin REST access and CSP for three.js are unverified.** Fallback: Foundry's own Python router proxies the kanban calls; serve the scene as a local web page opened from a slash command.
- **Legibility past about 100 cards.** Show scales only on zoom; group by epic.
- **Scope (proposed, not decided). Proposed cut order:** the beads adapter (cut now), sound, the slip check, "stand" (unless proven Nov 7), live message and delegation, then the drag gesture. Proposed floor, not to be cut: click-to-open, and assign and status via buttons. Dragging is polish.
- **"Stand" must not overclaim.** It pauses at the next tool boundary and never claims to cancel a tool call already running.
- **Acceptance:** a small timed checklist (open a card, change a status, assign a worker, each at least as fast as the 2D board) and a clean-install fixture rehearsal on Nov 9 and again on Nov 10. Live execution is optional.

## Gates (unchanged)
- The code goes in a new private repo first. Making it public, the catalog PR, the X post and the entry form are all mk's.
- Cross-lab review of this plan before executors start (the reviewer independence rule).

## Revision log
- Rev 1 (Nov 6, PST): applied the cross-lab plan review (Astra, REVISE, 9 findings): Day-1 integration gate, state-machine fixture, install spec on day 1, cut order, "stand" proof-or-remove, normalized schema, kanban as source of truth, transport choice, feature freeze on Nov 9.
