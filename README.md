# hermes-foundry

**Foundry is a 3D workspace for seeing and operating the software factory in Hermes.** Each kanban board is a
creature in a valley, each card is a scale coloured by its status, and each running worker is a climber sitting on the
card it holds. You fly around, click a scale to open its card, and change its status, assign a profile or comment on
it, from inside the Hermes desktop app. It is a hackathon entry. Private until mk publishes.

It ships as one Hermes plugin with three parts:

- a **desktop pane** (`/foundry`, three.js) that draws the valley and handles clicks;
- a **dashboard router** (`/api/plugins/foundry/`) that serves a snapshot, an event feed and commands;
- three **agent tools** (toolset `foundry`).

By default it runs against a built-in **fixture**: a scripted factory that makes no model call and needs no kanban
data, so you can try it on any Hermes. Live mode drives the real Hermes kanban (see [Modes](#modes) for what it needs).

## Install and run

Requirements: Hermes with the plugin system (`hermes plugins install`) and a dashboard (`hermes dashboard`), and `git`.
Node is not needed to use the plugin: the pane's build output, `desktop/plugin.js`, is committed.

Hermes is the open-source agent at <https://github.com/NousResearch/hermes-agent>. The clean-install rehearsal used commit
`5ec43faa` (2026-11-06); the plugin system, the dashboard and the Webapp pane need a recent checkout, so use that commit or
newer. Hermes needs **Python 3.14**. Its core dependencies (`ruamel.yaml` among them) are declared for
`python_version >= '3.14'` only, so on an older Python `pip install -e .` succeeds, installs none of them, and every
`hermes` command then fails with `ModuleNotFoundError: No module named 'ruamel'`. `uv venv` does not
activate the environment, so this guide never relies on a bare `hermes`: it names the venv's executable explicitly. Set
the two paths once, in this shell, and do the Hermes setup (a working recipe) in a subshell so you stay in your current directory:

    export HERMES_DIR=/path/to/hermes-agent        # where the checkout goes
    export HERMES=$HERMES_DIR/.venv/bin/hermes     # the executable every command below uses
    (git clone https://github.com/NousResearch/hermes-agent "$HERMES_DIR" && cd "$HERMES_DIR" \
      && git checkout 5ec43faa \
      && uv venv .venv --python 3.14 && uv pip install -p .venv/bin/python -e .)

The pane is served by the Hermes Webapp, which needs its renderer built once:

    "$HERMES" webapp --build-only

This takes about a minute and writes `apps/desktop/dist-webapp` **inside the Hermes checkout**.

Now install Foundry into Hermes. Run these from anywhere. `HERMES_HOME` selects the Hermes state directory that holds
the installed plugins; unset, Hermes uses your real one (`~/.hermes`). To try Foundry without touching it, point
`HERMES_HOME` at a scratch directory first (skip that line for a real install):

    export HERMES_HOME=$(mktemp -d)                # scratch; omit to use your real Hermes home
    "$HERMES" plugins install <git-url> --no-enable
    "$HERMES" plugins enable foundry
    "$HERMES" dashboard

`<git-url>` is any URL `git` can clone (while the repo is private, a `file:///path/to/clone` of this repo works).
This is the sequence `scripts/install_gate.sh` runs and checks.

That serves the router in fixture mode. The desktop half is **opt-in** and stays hidden until you turn it on; see
[Enabling the pane](#enabling-the-pane-desktop-half-is-opt-in). To see the router answer without the pane:

    cd /path/to/hermes-foundry                     # return to the Foundry checkout (not the Hermes one)
    HERMES_BIN="$HERMES" scripts/install_gate.sh "file://$PWD"

This installs the plugin into a throwaway `HERMES_HOME`, starts a dashboard with `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` unset (the rest of your environment is inherited; the fixture makes no
model call), and checks the snapshot, an authenticated command, the event feed and the plugin listing, then cleans up.
It prints `ALL GREEN` only if every check passed. It covers the router only and does not exercise the pane.

### Modes

| Mode | How to select | What you get |
| --- | --- | --- |
| Fixture (default) | nothing to set | 3 projects, 40 cards, 4 workers; one worker loops and one card is blocked on a human. A state machine: no model call, and it reads no credentials. Every command works. The pane shows a `simulated` badge. |
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

Pane (typecheck and unit tests, jsdom). The parentheses keep your shell at the repo root:

    (cd desktop && npm ci && npx tsc --noEmit && npx vitest run)

Python (router, sources, tools, install gate). The repo pins no Python dependencies (no requirements file or
`pyproject.toml`); the tests need `pytest`, `fastapi` and `httpx`. In a clean virtualenv at the repo root:

    python3 -m venv .venv && .venv/bin/pip install pytest fastapi httpx
    .venv/bin/python -m pytest -q

On a clean virtualenv with exactly those three packages this gave 262 passed, 31 skipped, with no Hermes installed
(2026-11-06). The skips are the live-mode tests, which need a Hermes
that has the kanban modules; point `FOUNDRY_HERMES_SRC` (a test-only variable) at such a Hermes checkout to run them.
That virtualenv cannot import Hermes (its dependencies are missing, see Python 3.14 above), and with
`FOUNDRY_HERMES_SRC` set the live tests fail rather than skip. Run them with the Hermes virtualenv's interpreter, with
`pytest` and `httpx` added to it:

    uv pip install -p "$HERMES_DIR/.venv/bin/python" pytest httpx
    FOUNDRY_HERMES_SRC="$HERMES_DIR" "$HERMES_DIR/.venv/bin/python" -m pytest -q    # from the Foundry checkout

This gave 293 passed, 0 skipped against Hermes `5ec43faa` (2026-11-06). Replay mode (`FOUNDRY_REPLAY=1`) is covered
by `tests/test_router.py`; the rehearsal harness in `scripts/rehearsal` does not exercise it.
The install-gate tests need `bash` and `curl`. Design notes are in `docs/contract.md` (the API contract, still a draft)
and `docs/plan.md`.

## Performance

These are observations, not guarantees. In maintainers' hand runs in November 2026, headless Chromium with software WebGL
(SwiftShader) ran the pane at roughly 29 to 48 frames per second, depending on card count and how busy the host was; those
runs left no recorded measurements. One run of the rehearsal harness (`scripts/rehearsal/rehearse.py perf`, 2026-11-06,
see `scripts/rehearsal/README.md`) measured 46 to 54 fps at 30 and 110 cards, software-rendered, with the host under load
(load average 10 to 16 on 32 cores, above the harness's own 0.2-per-core threshold). The harness is committed but its
results are not, and that is a single run, so this README makes no claim about a minimum or typical frame rate. Nothing has
been measured on a real GPU.

## Known limits

What the tests cover is stated apart from what was run by hand (hand runs were done in November 2026 and leave no
receipt in this repository).

- **Real WebGL and GPU are untested.** Nothing has been run on a real GPU; see Performance.
- **Live mode needs a newer Hermes.** By hand, Hermes 0.16.0 (2026.6.5) lacks the kanban modules, so live mode answers
  503 there. The live tests (skipped unless `FOUNDRY_HERMES_SRC` points at a Hermes with the kanban modules) were run
  by hand against Hermes main at commit 90d6b98f (2026-11-05) and passed. Live mode has not been run end to end
  through a real dispatcher with a worker picking up an assigned card.
- **The pane inside a real Hermes Desktop is not exercised by the install gate.** The unit tests cover the pane in
  jsdom; separate hand runs drove it in headless Chromium. The desktop half is opt-in and, on some builds, only
  reachable through the browser-storage setting above.
- **No per-worker transcript, message or pause in live mode.** Stock Hermes has no kanban hook for them, so they are
  fixture-only and labelled `simulated`.
- **No `looping` state in live mode**, so the slip animation is fixture-only.
- **Polling, not push.** The pane polls the router every 2 s (fixture and live alike), so a change made by another
  client shows up on the next poll. Only the pane's built-in fallback fixture, used when the router does not answer,
  polls every 1 s.

## License

MIT. See [LICENSE](LICENSE).
