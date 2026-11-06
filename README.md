# hermes-foundry

Foundry: a 3D workspace to see and operate the Hermes software factory (hackathon entry). Private until mk publishes.

## Modes

- Default: the interactive fixture (scripted state machine, no model, no credentials).
- `FOUNDRY_REPLAY=1` (or a path to a recording): a simulated fixture recording, with no live agents and no model calls. It plays the bundled recorded session on the wall clock, one step per `FOUNDRY_REPLAY_STEP_SECONDS` (default 2). Commands other than `reset` are refused. Regenerate the recording with `scripts/record_session.py`.
- `FOUNDRY_MODE=live`: the Hermes kanban (needs a Hermes with `kanban_db_boards`). Setting `FOUNDRY_MODE=live` together with a nonempty `FOUNDRY_REPLAY` is an error (neither wins). `FOUNDRY_BOARDS` (a list of board slugs) applies to live mode only.

## Desktop pane

The `/foundry` pane lives in `desktop/`. `desktop/plugin.js` is the committed build and is
built from `desktop/src/plugin.ts` only:

    cd desktop && node scripts/build.mjs src/plugin.ts plugin.js

`desktop/src/probe.ts` is a development-only integration probe. It is not imported by
`plugin.ts` and is not in the product bundle.

## Agent tools

The plugin registers three Hermes agent tools (toolset `foundry`). Each result is JSON `{ok, error?, simulated}`.

- `foundry_assign{card_id, profile}`: **live**. Assigns a profile to a kanban card (`'<board>:<task>'`) through Hermes'
  `assign_task`. It assigns only; it never claims or starts the card.
- `foundry_stand{on}`: **fixture only, simulated**. Pauses or resumes the fixture. Stock Hermes has no equivalent, so
  against the live kanban it answers `ok: false` ("fixture only").
- `foundry_message{worker_id, text}`: **fixture only, simulated**. Stock Hermes cannot address a kanban worker (a
  separate process with no session key), so against the live kanban it answers `ok: false` ("fixture only"). It is
  not wired to `inject_message`, which only reaches chat sessions.

`simulated` is `true` whenever the answer came from the fixture, not the live board. The tool process holds its own
source: in live mode that is the shared kanban database, so an assignment shows in the pane; in fixture mode the
state is private to the tool process and is not the pane's fixture.
