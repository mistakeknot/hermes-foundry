# Plan: "Foundry" — a 3D workspace to see and run the software factory in Hermes

Bead: mk-ps6ow. Card: GSVP-10 (closed). mk's answer on the card: "3D workspace to visualize and operate the software factory in hermes".
Deadline: Nov 11, 2026, 2 PM PST. Build window: Nov 7 to Nov 10; Nov 11 morning is for the video and submission.
Name "Foundry" is a placeholder (design choice).

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
   - **Event store:** the hooks write a factory event log to plugin_db.
   - **Tools:** `foundry_assign`, `foundry_stand` and `foundry_message`, which wrap the existing kanban, delegation and session actions.
   - **Feed:** a small local event feed (SSE or websocket) for the pane.
2. **Desktop JS pane:**
   - three.js scene.
   - Procedural creature builder: a deterministic seed from the project id, so the same project always looks the same.
   - Instanced scales, orbit and zoom only.
   - Side panel for cards, docs and transcripts.
3. **Fixture:** a recorded factory session (3 projects, about 40 cards, 4 workers, one loop, one blocked card waiting on a human). It replays through the same feed, so the demo never depends on live model output.

## Day plan
- **Nov 7:**
  - Confirm the Hermes desktop pane API and the kanban hooks against the real Hermes source (unverified today).
  - Plugin skeleton, event log, fixture recorder.
  - Static creature from one board.
- **Nov 8:** valley view, statuses, climbers driven by fixture events, and click-to-open card and doc.
- **Nov 9:** drag-to-assign and delegate, message a climber, "stand", the loop-slip check.
- **Nov 10:**
  - Polish: art direction (original look, e.g. stone, lichen and coral; no recreation of an existing game).
  - Sound cue on slip and stand, performance pass, README, catalog PR draft.
- **Nov 11 AM:** 90s video from the fixture, plus one live take.

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
- **Scope.** Cut in this order: the beads adapter, then "stand", then the slip check. Never cut click-to-open or drag-to-assign.

## Gates (unchanged)
- The code goes in a new private repo first. Making it public, the catalog PR, the X post and the entry form are all mk's.
- Cross-lab review of this plan before executors start (the reviewer independence rule).
