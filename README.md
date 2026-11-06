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
