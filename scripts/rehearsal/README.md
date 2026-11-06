# Rehearsal harness

Repeatable checks of the Foundry pane on a clean, scratch Hermes home. Each subcommand creates its own home,
starts the Hermes Webapp on a free loopback port, drives headless Chromium through `bb browser-automation`,
and stops everything it started on exit (it removes the home's files too, unless `--keep`).

    export BB_THREAD_STORAGE=/path/to/your/thread/storage   # required; there is no /tmp fallback
    export HERMES_SRC=/path/to/hermes-agent                 # a Hermes checkout (renderer and Python path); see Prerequisites
    export HERMES_PY=/path/to/hermes/venv/bin/python        # optional
    python3 scripts/rehearsal/rehearse.py install     # clean-home install rehearsal, PASS/FAIL
    python3 scripts/rehearsal/rehearse.py checklist   # open / status / assign, pane vs 2D board, 3 trials each
    python3 scripts/rehearsal/rehearse.py shots       # art-audit screenshots (SHOTS_MODES: fixture, live or fixture,live; nothing else is accepted)
    python3 scripts/rehearsal/rehearse.py perf --cards 110   # frame pacing; check `uptime` first
    python3 scripts/rehearsal/rehearse.py verdict out/checklist.json   # re-judge a saved checklist (exit 0 only for a complete, passing run)
    python3 scripts/rehearsal/rehearse.py selftest    # offline checks: redaction, confinement, ownership, verdict, screenshot names (needs BB_THREAD_STORAGE)

The plugin is installed from the committed HEAD of this repository (`SRC_URL` overrides), so commit before a rehearsal.
Results are JSON plus JPEG screenshots in the run's `out/` directory. Rendering is software WebGL: frame rates are software-rendered observations under the recorded host load; no minimum or typical rate is established.

## Prerequisites

- **Hermes on Python 3.14.** The harness runs Hermes from `HERMES_SRC` (the root README says where to get it and which
  commit was rehearsed). Hermes' core dependencies are declared for Python 3.14 only; on an older Python every `hermes`
  command fails with `ModuleNotFoundError: No module named 'ruamel'`. Point `HERMES_PY` at that checkout's 3.14 virtualenv.
- **Your Hermes home is never used.** Every subcommand creates its own scratch `HERMES_HOME` under the run directory and sets it for each
  Hermes process it starts; the test suite likewise sets `HERMES_HOME` to a temp directory (`tests/test_live.py`).
- **A prebuilt Webapp renderer.** Run `"$HERMES" webapp --build-only` once (`$HERMES` is the Hermes venv's executable, defined in the root README's Install section; use a scratch `HERMES_HOME` for it as described there). The harness starts the Webapp with `--skip-build`,
  so without `apps/desktop/dist-webapp` in the checkout `install` stops with "--skip-build was passed but no Webapp renderer
  exists". The build **writes into the Hermes checkout** (that directory only); the harness itself writes nothing there.
- **Replay is not covered.** The harness clears `FOUNDRY_REPLAY` for every Hermes it starts, so replay mode
  (`FOUNDRY_REPLAY=1`) is covered by `tests/test_router.py` and not by these checks.
- **Frame rates are measured under host load.** `perf` reports software-rendered figures, and the host's load decides
  them; check `uptime` first, as the `perf` line above says.

## What the harness guarantees

- **Confinement.** `BB_THREAD_STORAGE` must be an absolute existing directory (not `/`, your home or the system temp dir).
  Each run creates a fresh `foundry-rh-run.*` directory under it (printed as `RUN`) and puts scratch homes, temporary
  scripts, temp files and evidence there. There are no `RH_ROOT` or `OUT` overrides, and every path is checked to resolve
  inside the run directory.
- **Cleanup.** Cleanup runs on success, failure, timeout, Ctrl-C, SIGTERM and SIGHUP (nested `finally`/`ExitStack`: the browser is
  closed, then the home's processes are stopped, then the home is removed; each step runs even if another fails).
  The browser close is registered before the browser is opened. `bb browser-automation open` accepts no caller-chosen
  identifier, so if it times out or its reply cannot be read, close() lists this thread's live sessions and closes the one
  that appeared during the call. If several new sessions appeared it closes none and fails, naming them. Limit: a session
  that another process of the same thread opens during that same call would be indistinguishable, so run one rehearsal at a
  time per thread. A failure of `bb` itself (for example the host being down) can also stop the close; that is reported as a
  failed run, never swallowed.
  Owned processes are always stopped. `--keep` only keeps files: the scratch home and run directory stay for inspection,
  but the Webapp and its helpers are stopped on success, failure and signals alike, so nothing is left running.
  A cleanup failure fails the run and is never swallowed. A run that is killed with SIGKILL, or a host crash, cannot clean up:
  look for leftover `foundry-rh-run.*` directories under thread storage.
- **No kill by port.** Every Hermes process is started with a per-run token in its environment. A process is signalled only if it
  belongs to this user, is not the harness, and its environment names both this run's scratch `HERMES_HOME` and the token.
  A process that merely listens on the port is reported and left alone. `cleanup_home.sh` removes a home only if it is a direct child of
  the homes directory named `foundry-rh.*`, is not a symlink, and holds the ownership marker with this run's token.
- **Secrets.** The one-use sign-in link is never written to disk outside the scratch home: the browser scripts that carry it live
  in the home's `scripts/` directory (mode 0700) and are deleted right after use, and the link is not persisted. Sign-in tickets,
  tokens and bearer values are redacted from every printed diagnostic and every evidence file.
- **No harness writes to the Hermes checkout.** `PYTHONDONTWRITEBYTECODE=1` is set for every Hermes subprocess and `TMPDIR`
  points inside the home. The one-off `"$HERMES" webapp --build-only` step (see Prerequisites) does write its renderer there.
- **Screenshot names.** `SHOTS_MODES` accepts only `fixture` and `live` (no duplicates, checked before anything is created).
  Every screenshot name must be a plain file name, and its destination must resolve directly inside `out/` and not be a symlink.
- **Exit codes.** `checklist` exits 0 only if every trial, UI check, scene check and database check passed (all three trials in the
  pane and on the board, `ok` and `scene_ok` true). Database evidence is one row per (UI, card) of those trials, the expected
  status and profile come from the fixed plan (never from the row), and the value read back from the Hermes database must
  equal them; duplicate, extra, wrong-card or mismatching rows fail. `shots` exits non-zero if any target card or image is
  missing; live mode seeds blocked and done cards so the targets exist. `install` and `perf` exit non-zero on any failed check.
- **`verdict` is strict.** It reads nothing into missing data: the saved result must hold the fixed three-trial plan, non-empty
  pane and board trials, exactly one matching database row per trial (six, each equal to the plan), the measured floor, `pass: true` and an empty `failures` list (a recorded
  harness or cleanup failure fails it), and then every trial, UI, scene and database check is re-judged.
- **`selftest` is confined too.** It needs `BB_THREAD_STORAGE`, makes its scratch directory inside its own run directory
  (not the system temp dir) and removes that run directory when it ends.
