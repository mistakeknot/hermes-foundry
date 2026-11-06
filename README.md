# hermes-foundry

Foundry: a 3D workspace to see and operate the Hermes software factory (hackathon entry). Private until mk publishes.

## Modes

- Default: the interactive fixture (scripted state machine, no model, no credentials).
- `FOUNDRY_REPLAY=1` (or a path to a recording): play the bundled recorded session on the wall clock, one step per `FOUNDRY_REPLAY_STEP_SECONDS` (default 2). Commands other than `reset` are refused. Regenerate the recording with `scripts/record_session.py`.
- `FOUNDRY_MODE=live`: the Hermes kanban (needs a Hermes with `kanban_db_boards`).
