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

Dragging a climber onto a scale only opens that card's profile selector, the same one the Assign button uses.
It never claims the card and never infers a profile from the worker; you still pick a profile and press Assign,
which sends `assign` only. A drop on anything else (empty space, a carving, a creature body, another climber) does
nothing, and leaving the canvas mid-drag cancels it. Fixture and live behave the same.

### Enabling the pane (desktop half is opt-in)

`hermes plugins enable foundry` turns on the agent half (the router). The desktop half is opt-in:
Hermes marks the copy in `desktop-plugins/foundry` as not enabled by default, so the Foundry nav item stays
hidden until the user turns it on. Where the build exposes it, turn it on under Capabilities > Plugins. Some
builds (checked on Hermes b524c8a4) list only the catalog there, with the backend marked "needs setup", and show no
Foundry entry. The fallback, verified on a fresh install, is the same browser setting the toggle writes: in the
Webapp's browser storage, set the `foundry` key to `true` in `hermes.desktop.pluginDecisions.v2` and reload. That key
holds every plugin's decision, so merge into it; do not replace it. In the browser console:

    k = "hermes.desktop.pluginDecisions.v2";
    localStorage.setItem(k, JSON.stringify({...JSON.parse(localStorage.getItem(k) || "{}"), foundry: true}));

The host copies the desktop half to `desktop-plugins/foundry` on the first Webapp request after the agent half is enabled.
Nothing in this repo can change that default.
Hermes copies the whole `desktop/` directory into `desktop-plugins/foundry`; only `plugin.js` is used at runtime.
`scripts/install_gate.sh` checks the router only and does not exercise the pane.

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

When Hermes tool search defers the plugin's tools (many tools loaded), a model does not see `foundry_assign`
directly and may reach it through the `tool_call` bridge, naming `foundry_assign` and passing the arguments. The
result is the same `{ok, error?, simulated}` JSON.

## Performance

Measured in headless Chromium with software WebGL (SwiftShader), the pane ran at about 29 to 48 frames per second
(48 at 108 cards on an idle host, 29 at 5 cards on a busy one). It has not been measured on a real GPU, and Hermes
itself turns GPU acceleration off for a remote Browser-hosted Desktop.
