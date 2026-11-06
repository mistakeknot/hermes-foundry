# hermes-foundry

**Foundry is a 3D workspace for seeing and operating the software factory in Hermes.** Each kanban board is a
creature in a valley, each card is a scale coloured by its status, and each running worker is a climber sitting on the
card it holds. You fly around, click a scale to open its card, and change its status, assign a profile or comment on
it, from inside the Hermes desktop app. It is a hackathon entry. Private until mk publishes.

It ships as one Hermes plugin with three parts:

- a **desktop pane** (`/foundry`, three.js) that draws the valley and handles clicks;
- a **dashboard router** (`/api/plugins/foundry/`) that serves a snapshot, an event feed and commands;
- three **agent tools** (toolset `foundry`).

By default it runs against a built-in **fixture**: a scripted factory that needs no model, no API keys and no kanban
data, so you can try it on any Hermes. Live mode drives the real Hermes kanban (see [Modes](#modes) for what it needs).

## Install and run

Requirements: Hermes with the plugin system (`hermes plugins install`) and a dashboard (`hermes dashboard`), and `git`.
Node is not needed to use the plugin: the pane's build output, `desktop/plugin.js`, is committed.

    hermes plugins install <git-url> --no-enable
    hermes plugins enable foundry
    hermes dashboard

`<git-url>` is any URL `git` can clone (while the repo is private, a `file:///path/to/clone` of this repo works).
This is the sequence `scripts/install_gate.sh` runs and checks.

That serves the router in fixture mode. The desktop half is **opt-in** and stays hidden until you turn it on; see
[Enabling the pane](#enabling-the-pane-desktop-half-is-opt-in). To see the router answer without the pane:

    scripts/install_gate.sh file://$PWD

This installs the plugin into a throwaway `HERMES_HOME`, starts a dashboard with no API keys, and checks the
snapshot, an authenticated command, the event feed and the plugin listing, then cleans up. It prints `ALL GREEN` only if
every check passed. It covers the router only and does not exercise the pane.

### Modes

| Mode | How to select | What you get |
| --- | --- | --- |
| Fixture (default) | nothing to set | 3 projects, 40 cards, 4 workers; one worker loops and one card is blocked on a human. A state machine, no model, no credentials. Every command works. The pane shows a `simulated` badge. |
| Replay | `FOUNDRY_REPLAY=1` (or a path to a recording); optional `FOUNDRY_REPLAY_STEP_SECONDS`, default 2 | The bundled recorded session (`foundry_core/session.json`) plays on the wall clock, one step per interval. Only `reset` is accepted; everything else is refused. Still badged `simulated`. Regenerate with `scripts/record_session.py` (`--check` verifies it is current). |
| Live | `FOUNDRY_MODE=live`; optional `FOUNDRY_BOARDS` (board slugs, live only) | Reads the real Hermes kanban. Needs a Hermes that has `hermes_cli.kanban_db_boards` and `kanban_db_connect`. Without them the router answers 503 "kanban source unavailable". `FOUNDRY_MODE=live` together with a nonempty `FOUNDRY_REPLAY` is an error. |

If the pane cannot reach Foundry's router it falls back to an in-pane fixture (also `simulated`).

### Simulated and real

| | Fixture / replay | Live |
| --- | --- | --- |
| Status change on a card | simulated | real (`set_status` on the kanban) |
| Assign a profile | simulated | real (`assign` only; see below) |
| Comment | simulated | real |
| Claim, message a worker, stand (pause all), new climber, transcript | simulated | not available: the live router refuses these commands, the pane shows their controls only in a simulated session, and the agent tools answer `ok: false` ("fixture only") |
| Climber slipping down its scale (`looping` worker) | simulated | never shown: the kanban has no loop state |

Assigning a profile only assigns. Foundry never claims or starts a card, and Hermes may start it once it is assigned
(which can spend model tokens through the normal dispatcher). Nothing in Foundry calls a model itself.

## Desktop pane

The `/foundry` pane lives in `desktop/`. `desktop/plugin.js` is the committed build and is
built from `desktop/src/plugin.ts` only:

    cd desktop && npm ci && node scripts/build.mjs src/plugin.ts plugin.js

`desktop/src/probe.ts` is a development-only integration probe. It is not imported by
`plugin.ts` and is not in the product bundle.

Dragging a climber onto a scale only opens that card's profile selector, the same one the profile buttons use.
It never claims the card and never infers a profile from the worker; you still pick a profile (one click on its button),
which sends `assign` only. A drop on anything else (empty space, a carving, a creature body, another climber) does
nothing, and leaving the canvas mid-drag cancels it. Fixture and live behave the same.

A climber whose worker reports `looping` visibly slips down its scale and catches a new hold, on a loop. This is motion
only: it needs no command and infers nothing from re-runs. Live Hermes never reports `looping`, so the slip appears
only in the fixture, which is badged simulated.

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

## Agent tools

The plugin registers three Hermes agent tools (toolset `foundry`). Each result is JSON `{ok, error?, simulated}`.

- `foundry_assign{card_id, profile}`: **live**. Assigns a profile to a kanban card (`'<board>:<task>'`) through Hermes'
  `assign_task`. It assigns only: Foundry does not claim or start the card, and Hermes may start it once assigned.
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

## Develop and test

    cd desktop && npm ci && npx tsc --noEmit && npx vitest run     # pane: typecheck and unit tests (jsdom)
    python -m pytest -q                                            # router, sources, tools, install gate

The Python tests that exercise live mode need a Hermes that has the kanban modules (point `FOUNDRY_HERMES_SRC`, a
test-only variable, at a Hermes checkout); without one they skip. Design notes are in `docs/contract.md` (the API
contract, still a draft) and `docs/plan.md`.

## Performance

Measured in headless Chromium with software WebGL (SwiftShader), the pane ran at about 29 to 48 frames per second
(48 at 108 cards on an idle host, 29 at 5 cards on a busy one). It has not been measured on a real GPU, and Hermes
itself turns GPU acceleration off for a remote Browser-hosted Desktop.

## Known limits

- **Real WebGL and GPU are untested.** The pane has only run on software WebGL in headless Chromium.
- **Live mode needs a newer Hermes.** Hermes 0.16.0 (2026.6.5) lacks the kanban modules, so live mode answers 503 there.
  The live code is covered by tests against Hermes main at 90d6b98f (2026-11-05); it has not been run end to end through
  a real dispatcher with a worker picking up an assigned card.
- **The pane inside a real Hermes Desktop is not exercised by the install gate.** Pane behaviour is tested in jsdom and
  headless Chromium. The desktop half is opt-in and, on some builds, only reachable through the browser-storage setting above.
- **No per-worker transcript, message or pause in live mode.** Stock Hermes has no kanban hook for them, so they are
  fixture-only and labelled `simulated`.
- **No `looping` state in live mode**, so the slip animation is fixture-only.
- **Polling, not push.** The pane polls the router (every 1 s on the fixture, 2 s live), so a change made by another client
  shows up on the next poll.
