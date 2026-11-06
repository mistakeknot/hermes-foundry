# Rehearsal harness

Repeatable checks of the Foundry pane on a clean, scratch Hermes home. Each subcommand creates its own home,
starts the Hermes Webapp on a free loopback port, drives headless Chromium through `bb browser-automation`,
and removes the home on exit. Homes are removed only by `cleanup_home.sh`, which refuses any path that is not
a direct child of `RH_ROOT` named `foundry-rh.*`.

    export HERMES_SRC=/path/to/hermes-agent     # a Hermes checkout (renderer and Python path)
    export HERMES_PY=/path/to/hermes/venv/bin/python   # optional
    export RH_ROOT=/path/to/scratch/dir OUT=/path/to/results
    python3 scripts/rehearsal/rehearse.py install     # clean-home install rehearsal, PASS/FAIL
    python3 scripts/rehearsal/rehearse.py checklist   # open / status / assign, pane vs 2D board, 3 trials each
    python3 scripts/rehearsal/rehearse.py shots       # art-audit screenshots (SHOTS_MODES=fixture or fixture,live)
    python3 scripts/rehearsal/rehearse.py perf --cards 110   # frame pacing; check `uptime` first

The plugin is installed from the committed HEAD of this repository (`SRC_URL` overrides), so commit before a rehearsal.
Results are JSON plus JPEG screenshots in `OUT`. Rendering is software WebGL, so frame rates are a floor, not a GPU figure.
