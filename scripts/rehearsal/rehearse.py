#!/usr/bin/env python3
"""Repeatable rehearsal harness for the Foundry pane (stdlib only).

Subcommands (each creates its own scratch HERMES_HOME; its processes are always stopped on exit, and its files are
removed too unless --keep, which retains files only):
  install   clean-home install rehearsal on the fixture: install the plugin, enable it, start the Webapp,
            opt in to the desktop half, open the pane in headless Chromium, check it rendered. PASS/FAIL.
  checklist timed interaction checklist: open a card, change its status, assign a profile, in the pane and in
            the 2D kanban board of the same Webapp, same browser, same kanban database (live mode).
            Exit 0 only if every trial, UI check, scene check and DB check passed.
  perf      frame pacing at 30 and N (default 110) cards in the pane, with the host load recorded.
  shots     screenshots of the pane for the art audit (SHOTS_MODES: a comma list of fixture and live, nothing else).
            The live run seeds blocked and done cards; a missing card or screenshot fails the run.
  verdict F re-judge a saved checklist.json (exit 0 only if it is a complete, passing run of the fixed three-trial
            plan: no missing section and no recorded harness or cleanup failure).
  selftest  offline unit checks; needs BB_THREAD_STORAGE, runs inside its own run directory and removes it afterwards.
  up/down   (not provided: every run owns its scratch home)

--keep: owned processes (the Webapp and its helpers) are ALWAYS stopped, on success, failure and signals. --keep only
retains the scratch home's files (and the run directory) for inspection; nothing is left running.
The browser session is closed on every exit path, including a failed or timed-out open (see README, Cleanup).

Confinement (no override, no fallback): BB_THREAD_STORAGE must name your thread storage directory. Each run makes a
fresh directory foundry-rh-run.* under it and keeps everything inside: scratch homes (homes/), temporary scripts and
temp files (inside the home), and evidence (out/). The path is printed as RUN. selftest is confined the same way.

Environment:
  BB_THREAD_STORAGE  thread storage directory [required]
  HERMES_SRC  Hermes checkout used as PYTHONPATH and for the prebuilt Webapp renderer [required]
  HERMES_PY   python of the Hermes venv [the interpreter named in the `hermes` shebang]
  SRC_URL     where `hermes plugins install` reads the plugin [file://<this repo>] (committed HEAD only)
  BB_HOST     host id for `bb browser-automation` [from `bb status --json`]
  SHOTS_MODES fixture,live   (only these two values are accepted; they become part of file names)
"""
import argparse, contextlib, json, os, re, secrets, shutil, signal, socket, subprocess, sys, tempfile, time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.environ.get("HERMES_SRC")
SRC_URL = os.environ.get("SRC_URL", "file://" + REPO)
JSDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "js")
CLEANUP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cleanup_home.sh")
TOKEN = secrets.token_hex(8)        # marks every process and home this run owns (never a credential)
LAUNCHED = []                       # pids of every Hermes process this run started directly
SECRETS = set()                     # sign-in tickets seen this run: redacted everywhere
STORAGE = RUN = RH_ROOT = OUT = None
MODES = ("fixture", "live")         # the only SHOTS_MODES values
CHECKLIST_PLAN = [["blocked", "coder"], ["blocked", "reviewer"], ["blocked", "coder"]]     # the fixed three-trial plan
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


# ---- redaction ----------------------------------------------------------------------------------------------
_TICKET = re.compile(r"(ticket=)[^\s\"'&<>)\]]+", re.I)
_KV = re.compile(r"(?i)\b(token|secret|password|authorization|api[_-]?key)([\"']?\s*[=:]\s*[\"']?)([^\s\"',}]+)")
_BEARER = re.compile(r"(?i)\b(bearer\s+)([A-Za-z0-9._~+/=-]+)")


def redact(s):
    """Remove sign-in tickets and tokens from any text that is printed or saved."""
    s = str(s)
    for v in SECRETS:
        s = s.replace(v, "<redacted>")
    s = _TICKET.sub(r"\1<redacted>", s)
    s = _BEARER.sub(r"\1<redacted>", s)          # before the key/value rule, which would eat the word "Bearer"
    return _KV.sub(r"\1\2<redacted>", s)


def write_evidence(path, obj):
    """Every evidence file goes through redact()."""
    text = redact(json.dumps(obj, indent=1))
    with open(path, "w") as f:
        f.write(text)


# ---- confinement --------------------------------------------------------------------------------------------
def inside(path, root):
    r = os.path.realpath(root)
    p = os.path.realpath(path)
    return p != r and p.startswith(r + os.sep)


def confine(storage_env):
    """Create the unique run directory under thread storage and return (storage, run, homes, out). No fallback."""
    if not storage_env or not os.path.isabs(storage_env) or not os.path.isdir(storage_env):
        sys.exit("BB_THREAD_STORAGE must be set to your absolute thread storage directory (there is no /tmp fallback)")
    storage = os.path.realpath(storage_env)
    if storage in ("/", os.path.realpath(os.path.expanduser("~")), os.path.realpath(tempfile.gettempdir())):
        sys.exit("refusing: BB_THREAD_STORAGE resolves to " + storage)
    run = tempfile.mkdtemp(prefix="foundry-rh-run.", dir=storage)
    os.chmod(run, 0o700)
    homes, out, tmp = (os.path.join(run, d) for d in ("homes", "out", "tmp"))
    for d in (homes, out, tmp):
        os.makedirs(d, mode=0o700)
        if not inside(d, run) or not inside(run, storage):
            sys.exit("refusing: " + d + " does not resolve inside the run directory")
    return storage, run, homes, out


def init_run(need_src=True):
    global STORAGE, RUN, RH_ROOT, OUT
    if need_src and (not SRC or not os.path.isdir(SRC)):
        sys.exit("set HERMES_SRC to a Hermes checkout")
    STORAGE, RUN, RH_ROOT, OUT = confine(os.environ.get("BB_THREAD_STORAGE"))
    tempfile.tempdir = os.path.join(RUN, "tmp")
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    print("RUN", RUN, flush=True)


# ---- hermes processes ---------------------------------------------------------------------------------------
def hermes_py():
    if os.environ.get("HERMES_PY"):
        return os.environ["HERMES_PY"]
    exe = shutil.which("hermes")
    if exe:
        with open(os.path.realpath(exe), "rb") as f:
            first = f.readline().decode().strip()
        if first.startswith("#!"):
            return first[2:].split()[0]
    sys.exit("set HERMES_PY (python of the Hermes venv)")


def bb_host():
    if os.environ.get("BB_HOST"):
        return os.environ["BB_HOST"]
    d = json.loads(subprocess.check_output(["bb", "status", "--json"], text=True))
    return d["thread"]["environment"]["hostId"]


def free_port():
    fp = shutil.which("free-port")          # the fleet's allocator; never a remembered or default port
    if fp:
        out = subprocess.run([fp], capture_output=True, text=True).stdout.strip()
        if out.isdigit(): return int(out)
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def henv(hh, live=False, extra=None):
    e = dict(os.environ, HERMES_HOME=hh, PYTHONPATH=SRC, PYTHONDONTWRITEBYTECODE="1", FOUNDRY_RH_TOKEN=TOKEN,
             TMPDIR=os.path.join(hh, "tmp"))
    for k in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"):
        e.pop(k, None)
    e.pop("FOUNDRY_MODE", None); e.pop("FOUNDRY_REPLAY", None)
    if live:
        e["FOUNDRY_MODE"] = "live"
    # Hermes spawns its gateway/webapp helpers by name: keep the venv python first on PATH.
    e["PATH"] = os.path.dirname(hermes_py()) + os.pathsep + e.get("PATH", "")
    e.update(extra or {})
    return e


def run_tracked(cmd, env, timeout):
    """Run a command in its own session, record its pid, and on timeout kill only the group this call created."""
    p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    LAUNCHED.append(p.pid)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(p.pid, signal.SIGKILL)      # pgid == pid: we made this session
        p.communicate()
        raise
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


def hermes(hh, args, live=False, timeout=120, wrap=()):
    return run_tracked(list(wrap) + ["nice", "-n", "19", hermes_py(), "-m", "hermes_cli.main"] + args, henv(hh, live), timeout)


def listener_pid(port):
    out = subprocess.run(["ss", "-ltnp", f"sport = :{port}"], capture_output=True, text=True).stdout
    m = re.search(r"pid=(\d+)", out)
    return int(m.group(1)) if m else None


def mint(hh, port, live):
    """Start (or reuse) the Webapp for this home and return a one-use sign-in URL (valid 60 s)."""
    r = hermes(hh, ["webapp", "--no-open", "--skip-build"], live, timeout=60, wrap=["timeout", "45"])
    text = r.stdout + r.stderr
    m = re.search(r"(http://127\.0\.0\.1:(\d+)/webapp/launch#ticket=([A-Za-z0-9_-]+))", text)
    if not m:
        raise RuntimeError("no sign-in link: " + redact(text)[-400:])
    SECRETS.add(m.group(3))
    return m.group(1)


# ---- scratch home lifecycle ---------------------------------------------------------------------------------
def owned(pid, home):
    """True only for a process of this user whose environment names this home AND this run's token."""
    if pid == os.getpid():
        return False
    try:
        if os.stat(f"/proc/{pid}").st_uid != os.getuid():
            return False
        env = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    except OSError:
        return False
    return ("HERMES_HOME=" + home).encode() in env and ("FOUNDRY_RH_TOKEN=" + TOKEN).encode() in env


def owned_pids(home):
    found = set()
    for d in os.listdir("/proc"):
        if d.isdigit() and owned(int(d), home):
            found.add(int(d))
    return found


def up(live=False, boards=None, states=None, keep=False):
    """Create a scratch home and start the Webapp; on any failure stop it (always) and remove the home (unless keep)."""
    st = {}
    try:
        return _up(st, live, boards, states)
    except BaseException:
        if st.get("home"):
            with contextlib.suppress(Exception):
                down(st, keep=keep)
        raise


def write_marker(st):
    path = os.path.join(st["home"], ".foundry-rh-owner")
    with open(path, "w") as f:
        f.write(TOKEN)
    os.chmod(path, 0o600)
    d = {k: st[k] for k in ("home", "port", "live")}      # no sign-in URL is ever persisted
    with open(os.path.join(st["home"], "rehearsal.json"), "w") as f:
        json.dump(d, f)


def _up(st, live, boards, states):
    hh = tempfile.mkdtemp(prefix="foundry-rh.", dir=RH_ROOT)
    st.update({"home": hh, "live": live})
    if not inside(hh, RUN):
        raise RuntimeError("scratch home escaped the run directory: " + hh)
    for d in ("tmp", "scripts"):
        os.makedirs(os.path.join(hh, d), mode=0o700)
    port = free_port()
    st["port"] = port
    write_marker(st)
    with open(os.path.join(hh, "config.yaml"), "w") as f:
        f.write(f"webapp:\n  enabled: true\n  host: 127.0.0.1\n  port: {port}\n")
    r = hermes(hh, ["plugins", "install", SRC_URL, "--no-enable"])
    if r.returncode: raise RuntimeError("plugin install failed: " + redact(r.stdout + r.stderr)[-500:])
    r = hermes(hh, ["plugins", "enable", "foundry"])
    if r.returncode: raise RuntimeError("plugin enable failed: " + redact(r.stdout + r.stderr)[-500:])
    if live and boards:
        seed(hh, boards, states)
    for attempt in (1, 2):
        try:
            mint(hh, port, live)
            break
        except RuntimeError:
            # Known Hermes quirk on a brand-new home (pydantic ArgsKwargs): stop what we started, reset that home's state.
            stop_home(st)
            cleanup_script(hh, reset=True)
            if attempt == 2: raise
    for _ in range(60):
        if listener_pid(port): break
        time.sleep(0.5)
    return st


def stop_home(st):
    """Stop the processes this run launched for the home. Ownership (home AND run token) is checked before every
    signal; a process that merely listens on the port is never signalled."""
    hh = st["home"]
    cand = {p for p in LAUNCHED if os.path.exists(f"/proc/{p}")} | owned_pids(hh)
    lp = listener_pid(st["port"]) if st.get("port") else None
    if lp and lp not in cand and not owned(lp, hh):
        print(f"note: pid {lp} listens on port {st['port']} but this run does not own it; left alone", flush=True)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        mine = {p for p in cand if owned(p, hh)}
        for p in mine:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                if owned(p, hh): os.kill(p, sig)
        for _ in range(100):
            if not any(owned(p, hh) for p in mine): break
            time.sleep(0.2)
    # Hermes' SIGTERM handler spawns a detached 5 s forensic helper (gateway/shutdown_forensics.py: `timeout 5 bash -c ... pstree`)
    # that inherits this environment and outlives its parent. It is not in `cand`, so re-scan and signal what appears until none is left.
    left = owned_pids(hh)
    for _ in range(100):
        if not left: break
        for p in left:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                if owned(p, hh): os.kill(p, signal.SIGKILL)
        time.sleep(0.2)
        left = owned_pids(hh)
    if left:
        raise RuntimeError(f"could not stop processes of {hh}: {sorted(left)}")


def cleanup_script(home, reset=False):
    subprocess.run(["bash", CLEANUP] + (["--reset"] if reset else []) + [home],
                   env=dict(os.environ, RH_ROOT=RH_ROOT, FOUNDRY_RH_TOKEN=TOKEN), check=True)


@contextlib.contextmanager
def uninterruptible():
    """Cleanup must finish: ignore a second signal while it runs."""
    old = {s: signal.signal(s, signal.SIG_IGN) for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        yield
    finally:
        for s, h in old.items(): signal.signal(s, h)


def down(st, keep=False):
    """Always stop the home's processes; then remove the home's files unless keep. A failure in either step raises."""
    with uninterruptible():
        stopped = False
        try:
            stop_home(st)                  # raises if any owned process survives
            stopped = True
        finally:
            if keep:
                print(f"kept: scratch home files retained at {st['home']} ("
                      + ("processes stopped" if stopped else "processes NOT confirmed stopped") + ")", flush=True)
            else:
                cleanup_script(st["home"])


SEED = r'''
import os, sys, json
sys.path.insert(0, os.environ["PYTHONPATH"].split(os.pathsep)[0])
from hermes_cli import kanban_db as kb, kanban_db_boards as boards, kanban_db_connect as kc
spec = json.loads(sys.argv[1])           # {"atlas": 40, "harbor": 40, ...}
states = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}    # {"blocked": 2, "done": 2}, added to the default board
ids = {}
from hermes_cli import profiles as pr
for name in ("coder", "reviewer"):       # real profiles, so the 2D board's assignee menu lists them
    try: pr.create_profile(name, no_alias=True, no_skills=True)
    except Exception as e: print("profile", name, e, file=sys.stderr)
for slug, n in spec.items():
    if slug != "default": boards.create_board(slug, name=slug.title())   # "default" already exists
    c = kc.connect(board=slug)
    try:
        for i in range(n):
            t = kb.create_task(c, title=f"{slug} task {i:03d}", board=slug, assignee=("coder" if i % 7 == 0 else None))
            ids.setdefault(slug, []).append(t)
        # a few claimed (running), so that colour appears
        for t in ids[slug][: max(1, n // 12)]:
            kb.claim_task(c, t, claimer="coder")
    finally:
        c.close()
if states:
    c = kc.connect(board="default")
    try:
        for kind, n in states.items():
            for i in range(n):
                title = f"default {kind} {i:02d}"
                if kind == "blocked":
                    kb.create_task(c, title=title, board="default", initial_status="blocked")
                elif kind == "done":
                    t = kb.create_task(c, title=title, board="default")
                    if not kb.complete_task(c, t, result="rehearsal seed: evidence for a done card"):
                        raise SystemExit("could not complete " + title)
                else:
                    raise SystemExit("unknown state " + kind)
    finally:
        c.close()
print(json.dumps(ids))
'''


def seed(hh, spec, states=None):
    r = run_tracked([hermes_py(), "-c", SEED, json.dumps(spec), json.dumps(states or {})], henv(hh, True), 300)
    if r.returncode: raise RuntimeError("seed failed: " + redact(r.stderr)[-600:])
    with open(os.path.join(hh, "seeded.json"), "w") as f:
        json.dump(json.loads(r.stdout.strip().splitlines()[-1]), f)


# ---- browser ----------------------------------------------------------------------------------------------
DEAD_STATES = ("closed", "stopped", "expired")


def bb_cli(args, timeout):
    """Every `bb browser-automation` call goes through here (one place to fake in the selftest)."""
    return subprocess.run(["bb", "browser-automation"] + args, capture_output=True, text=True, timeout=timeout)


def live_sessions():
    """Ids of this thread's browser sessions that are not dead."""
    r = bb_cli(["list", "--json"], 60)
    if r.returncode: raise RuntimeError("cannot list browser sessions: " + redact(r.stdout + r.stderr)[-300:])
    return {x["id"] for x in json.loads(r.stdout) if isinstance(x, dict) and x.get("id") and x.get("state") not in DEAD_STATES}


class Browser:
    def __init__(self, scriptdir):
        """No browser exists yet: construction is local only, so close() can be registered before open() starts one.
        scriptdir is inside the scratch home: sign-in scripts hold a one-use ticket and live only there."""
        self.sdir = scriptdir
        os.makedirs(self.sdir, mode=0o700, exist_ok=True)
        self.host = None
        self.sid = None
        self.before = None          # live sessions before open(); set once an open is attempted
        self.directive = None
        self.images = []

    def open(self):
        """Open the headless session. `bb browser-automation open` takes no caller-chosen identifier, so the run-specific
        handle is the set difference of this thread's live sessions around the call: if the call times out or its
        answer cannot be read, close() finds the session that appeared and closes it."""
        self.host = bb_host()
        self.before = live_sessions()
        r = bb_cli(["open", "--backend", "local", "--headless", "--machine", self.host, "--json"], 180)
        d = json.loads(r.stdout)
        self.sid = d.get("id") or d.get("sessionId") or d["session"]["id"]
        self.directive = d.get("previewDirective")

    def _recover(self):
        """open() was attempted but no session id is known: close the one new live session, or refuse to guess."""
        new = live_sessions() - self.before
        if not new: return
        if len(new) > 1:
            raise RuntimeError("browser acquisition failed and several new sessions appeared; none closed, close these by hand: " + ", ".join(sorted(new)))
        self.sid = next(iter(new))

    def run(self, js, timeout=90):
        fd, path = tempfile.mkstemp(suffix=".js", prefix="js.", dir=self.sdir)      # mode 0600, inside the scratch home
        os.write(fd, js.encode()); os.close(fd)
        try:
            r = bb_cli(["run", self.sid, "--script-file", path, "--script-host", self.host, "--timeout", f"{timeout}s", "--json"], timeout + 30)
        finally:
            os.unlink(path)
        try:
            d = json.loads(r.stdout)
        except Exception:
            raise RuntimeError("browser run failed: " + redact(r.stdout + r.stderr)[-500:])
        if d.get("ok") is False or d.get("exitCode"): raise RuntimeError("browser script error: " + redact(str(d))[-500:])
        self.raw = d; self.images = d.get("images", [])
        txt = d.get("text")
        try: return json.loads(txt)
        except Exception: return txt

    def keep_shot(self, name):
        """Copy the newest screenshot of the last run into OUT/<name>.jpg; a missing or empty image raises."""
        if not isinstance(name, str) or not _SAFE_NAME.match(name):
            raise RuntimeError("unsafe screenshot name: " + repr(name))
        if not self.images:
            raise RuntimeError("no screenshot returned for " + name)
        src = self.images[-1]["path"]
        if not os.path.isfile(src) or os.path.getsize(src) == 0:
            raise RuntimeError("screenshot file missing or empty for " + name)
        dest = os.path.join(OUT, name + ".jpg")
        if os.path.realpath(os.path.dirname(dest)) != os.path.realpath(OUT) or os.path.islink(dest) or not inside(dest, OUT):
            raise RuntimeError("screenshot destination escapes the output directory: " + name)
        shutil.copy(src, dest)
        return dest

    def close(self):
        if self.before is None: return              # open() was never attempted
        with uninterruptible():
            if not self.sid: self._recover()
            if not self.sid: return
            r = bb_cli(["close", self.sid, "--json"], 60)
        if r.returncode and "session_unavailable" not in (r.stdout + r.stderr):
            raise RuntimeError("browser close failed: " + redact(r.stdout + r.stderr)[-300:])


def js(name, **kw):
    s = open(os.path.join(JSDIR, name)).read()
    for k, v in kw.items():
        s = s.replace("%%" + k + "%%", json.dumps(v))
    return s


def signin(b, st, enable=("foundry",)):
    """Sign in with a fresh one-use link (they last 60 s), merge the opt-in decisions, reload."""
    url = mint(st["home"], st["port"], st["live"])
    b.run(js("signin.js", STAGE="goto", URL=url, ENABLE=[]), 90)
    return b.run(js("signin.js", STAGE="optin", URL="", ENABLE=list(enable)), 90)


def open_pane(b, tries=30):
    """Open /foundry and wait (in short runs, the host kills long ones) until the scene has creatures."""
    b.run(js("openpane.js", STAGE="goto"), 90)
    for _ in range(tries):
        r = b.run(js("openpane.js", STAGE="probe"), 60)
        if r and r.get("creatures"): break
    return b.run(js("openpane.js", STAGE="shot"), 60)


@contextlib.contextmanager
def session(a, live, boards=None, states=None):
    """A scratch home plus a browser. Cleanup is nested so each step runs even if the other fails: the browser is
    closed first, then the home's processes are always stopped, then the files are removed unless --keep (which
    retains files only); failures propagate."""
    with contextlib.ExitStack() as stack:
        st = up(live=live, boards=boards, states=states, keep=a.keep)
        stack.callback(down, st, a.keep)                 # registered first, so it runs last; always stops processes
        b = Browser(os.path.join(st["home"], "scripts"))
        stack.callback(b.close)                          # registered before open(), so a failed open is still cleaned up
        b.open()
        print(b.directive or "", flush=True)
        yield st, b


def s_order_ok():
    """True if session() registers b.close ahead of b.open() (checked on the source, so a refactor cannot silently undo it)."""
    import inspect
    src = inspect.getsource(session)
    return 0 <= src.index("stack.callback(b.close)") < src.index("b.open()")


def head():
    return subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()


# ---- subcommands ----------------------------------------------------------------------------------------
def cmd_install(a):
    t0 = time.time(); checks = []

    def check(name, ok, detail=""):
        detail = redact(detail)
        checks.append({"check": name, "ok": bool(ok), "detail": detail}); print(("PASS " if ok else "FAIL ") + name + (" - " + detail if detail else ""))
    stop = None
    try:
        with session(a, live=False) as (st, b):
            check("plugin installed and enabled; Webapp listening", listener_pid(st["port"]), f"port {st['port']}")
            d = os.path.join(st["home"], "plugins", "foundry")
            check("agent half present", os.path.isfile(os.path.join(d, "plugin.yaml")), d)
            r = signin(b, st)
            check("opt-in recorded without losing other decisions", r and r.get("dec", {}).get("foundry") is True, r and r.get("dec"))
            check("desktop half copied to desktop-plugins (first Webapp request)", os.path.isfile(os.path.join(st["home"], "desktop-plugins", "foundry", "plugin.js")))
            r = open_pane(b)
            b.keep_shot("install-pane")
            check("Foundry nav item present after opt-in", r and r.get("nav"), r and r.get("nav"))
            check("pane rendered in fixture mode", r and r.get("has") and r.get("mode") == "fixture", r and {k: r.get(k) for k in ("mode", "creatures", "cards")})
            check("fixture is labelled simulated", r and r.get("simulated"))
            check("at least one creature and several cards", r and (r.get("creatures") or 0) >= 3 and (r.get("cards") or 0) >= 10, r and (r.get("creatures"), r.get("cards")))
            code = subprocess.run(["curl", "-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", f"http://127.0.0.1:{st['port']}/api/plugins/foundry/snapshot"], capture_output=True, text=True).stdout
            check("router refuses a request without the session token", code == "401", code)
    except BaseException as e:        # includes cleanup failures and SIGTERM (SystemExit): recorded, then re-raised if not an Exception
        check("harness ran to completion", False, repr(e)[:300])
        if not isinstance(e, Exception): stop = e
    ok = bool(checks) and all(c["ok"] for c in checks)
    write_evidence(os.path.join(OUT, "install-rehearsal.json"), {"ok": ok, "seconds": round(time.time() - t0, 1), "checks": checks, "repo_head": head()})
    print("REHEARSAL " + ("PASS" if ok else "FAIL"))
    if stop: raise stop
    return 0 if ok else 1


VERIFY = r"""
import os, sys, json, sqlite3
sys.path.insert(0, os.environ["PYTHONPATH"].split(os.pathsep)[0])
from hermes_cli import kanban_db as kb
c = sqlite3.connect("file:" + str(kb.kanban_db_path(board="default")) + "?mode=ro", uri=True)
ev = {}
for t, k in c.execute("select t.title, e.kind from task_events e join tasks t on t.id = e.task_id order by e.id"):
    ev.setdefault(t, []).append(k)
print(json.dumps({"tasks": {t: [s, a] for t, s, a in c.execute("select title, status, assignee from tasks")}, "events": ev}))
"""


def db_state(st):
    r = run_tracked([hermes_py(), "-c", VERIFY], henv(st["home"], True), 60)
    return json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 else {}


def med(xs):
    xs = sorted(xs); return xs[len(xs) // 2] if xs else None


STEP_ORDER = ["open", "status", "assign"]


def checklist_verdict(res, plan, floor, server):
    """Return the list of failures. Empty means every trial, UI check, scene check and DB check passed."""
    f = []
    n = len(plan)
    if not (isinstance(floor, dict) and all(isinstance(floor.get(k), (int, float)) for k in ("eval_ms", "click_ms"))):
        f.append("harness floor not measured")
    for ui in ("pane", "board"):
        trials = res.get(ui) or []
        if len(trials) != n: f.append(f"{ui}: {len(trials)} trials completed, expected {n}")
        for i, t in enumerate(trials):
            steps = t.get("steps") or []
            if [s.get("step") for s in steps] != STEP_ORDER:
                f.append(f"{ui} trial {i}: steps {[s.get('step') for s in steps]}, expected {STEP_ORDER}")
            for s in steps:
                if s.get("ok") is not True: f.append(f"{ui} trial {i} {s.get('step')}: UI check failed (ok={s.get('ok')})")
                if ui == "pane" and s.get("step") in ("status", "assign") and s.get("scene_ok") is not True:
                    f.append(f"pane trial {i} {s.get('step')}: scene did not redraw (scene_ok={s.get('scene_ok')})")
    # Database evidence: exactly one row per (UI, card) of the trials above, expected values taken from the plan (never
    # from the row), and the database values must equal them.
    expected, used = {}, set()
    for ui in ("pane", "board"):
        trials = res.get(ui) or []
        for i, (status, profile) in enumerate(plan):
            card = trials[i].get("card") if i < len(trials) and isinstance(trials[i], dict) else None
            if not isinstance(card, str) or not card:
                f.append(f"{ui} trial {i}: no card id")
            elif card in used:
                f.append(f"{ui} trial {i}: card {card} is used by more than one trial")
            else:
                used.add(card)
                expected[(ui, card)] = [status, profile]
    if len(server) != 2 * n: f.append(f"{len(server)} DB checks, expected {2 * n}")
    seen = {}
    for x in server:
        if not isinstance(x, dict):
            f.append(f"DB row is not an object: {x!r}"); continue
        key = (x.get("ui"), x.get("card"))
        seen[key] = seen.get(key, 0) + 1
        if key not in expected:
            f.append(f"DB row for {key[0]} {key[1]} matches no trial"); continue
        want = expected[key]
        if x.get("want") != want: f.append(f"DB row {key[0]} {key[1]}: want {x.get('want')}, plan says {want}")
        if x.get("db") != want: f.append(f"DB row {key[0]} {key[1]}: database has {x.get('db')}, plan says {want}")
        if x.get("ok") is not True: f.append(f"DB check {key[0]} {key[1]}: ok={x.get('ok')}")
    for key in expected:
        if seen.get(key, 0) != 1: f.append(f"DB rows for {key[0]} {key[1]}: {seen.get(key, 0)}, expected exactly 1")
    return f


def strict_verdict(d):
    """Judge a saved checklist.json. Nothing is inferred: the fixed three-trial plan, the harness floor, both trial lists
    and all six database rows must be present, and the run must record no failure (harness, cleanup or otherwise)."""
    if not isinstance(d, dict):
        return ["not a checklist result"]
    f = []
    plan = d.get("plan")
    if not isinstance(plan, list) or [list(x) if isinstance(x, (list, tuple)) else x for x in plan] != CHECKLIST_PLAN:
        f.append(f"plan is {plan!r}, expected the fixed plan {CHECKLIST_PLAN}")
    trials, server = d.get("trials"), d.get("server_state")
    if not isinstance(trials, dict) or not all(isinstance(trials.get(k), list) and trials.get(k) for k in ("pane", "board")):
        f.append("trials missing or empty for the pane or the board")
        trials = {}
    if not isinstance(server, list) or not server:
        f.append("server_state (database checks) missing or empty")
        server = []
    recorded = d.get("failures")
    if not isinstance(recorded, list):
        f.append("failures not recorded in the result")
    else:
        f += ["recorded: " + str(x) for x in recorded]
    if d.get("pass") is not True:
        f.append(f"result says pass={d.get('pass')!r}")
    return f + checklist_verdict(trials, [tuple(x) for x in CHECKLIST_PLAN], d.get("floor"), server)


def cmd_checklist(a):
    """Open a card, change its status, assign a profile: three trials each in the pane and on the 2D board."""
    plan = [tuple(x) for x in CHECKLIST_PLAN]
    res = {"pane": [], "board": []}; load = os.getloadavg(); floor = None; server = []; failures = []; stop = None
    try:
        with session(a, live=True, boards={"default": 30}) as (st, b):
            signin(b, st, enable=("foundry", "kanban"))
            r = open_pane(b); print("pane ready:", {k: r.get(k) for k in ("mode", "creatures", "cards")}, flush=True)
            floor = b.run(js("checklist.js", STAGE="floor", TRIAL=0, STATUS="", PROFILE=""), 60)
            try:
                for i, (status, profile) in enumerate(plan):
                    res["pane"].append(b.run(js("checklist.js", STAGE="pane", TRIAL=i, STATUS=status, PROFILE=profile), 80))
                    if i == len(plan) - 1: b.keep_shot("checklist-pane-after")
                    print("pane trial", i, [(s["step"], s["ms"]) for s in res["pane"][-1]["steps"]], flush=True)
                print("board:", b.run(js("navboard.js"), 60), flush=True)
                for i, (status, profile) in enumerate(plan):
                    res["board"].append(b.run(js("checklist.js", STAGE="board", TRIAL=i, STATUS=status, PROFILE=profile), 80))
                    if i == len(plan) - 1: b.keep_shot("checklist-board-after")
                    print("board trial", i, [(s["step"], s["ms"]) for s in res["board"][-1]["steps"]], flush=True)
            except Exception as e:
                failures.append("trial aborted: " + redact(repr(e))[:300])
            dbs = db_state(st); db = dbs.get("tasks", {}); events = dbs.get("events", {})
            if not db: failures.append("DB state unreadable")
            for ui in ("pane", "board"):
                for t, (status, profile) in zip(res[ui], plan):
                    got = db.get(t["card"], ["?", "?"])
                    server.append({"ui": ui, "card": t["card"], "want": [status, profile], "db": got, "events": events.get(t["card"], []), "ok": got == [status, profile]})
    except BaseException as e:
        failures.append("harness error: " + redact(repr(e))[:300])
        if not isinstance(e, Exception): stop = e
    failures += checklist_verdict(res, plan, floor, server)
    summ = {}
    for ui in ("pane", "board"):
        for step in STEP_ORDER:
            rows = [x for t in res[ui] for x in t.get("steps", []) if x["step"] == step]
            if not rows: continue
            summ[f"{ui}.{step}"] = {"clicks": rows[0]["clicks"], "keys": rows[0]["keys"], "ms_median": med([x["ms"] for x in rows]), "ms_all": [x["ms"] for x in rows],
                                    "ms_scene_median": med([x["ms_scene"] for x in rows if "ms_scene" in x]) if ui == "pane" else None,
                                    "all_ok": all(x["ok"] is True for x in rows)}
    out = {"pass": not failures, "failures": failures, "load_avg_at_start": load, "cpus": os.cpu_count(), "plan": plan, "floor": floor, "summary": summ,
           "server_state": server, "trials": res, "repo_head": head()}
    write_evidence(os.path.join(OUT, "checklist.json"), out)
    print(redact(json.dumps({"floor": floor, "summary": summ, "pass": not failures, "failures": failures}, indent=1)))
    print("CHECKLIST " + ("PASS" if not failures else "FAIL"))
    if stop: raise stop
    return 0 if not failures else 1


def cmd_verdict(a):
    """Re-judge a saved checklist.json with the same rules (exit 0 only if it passes)."""
    try:
        with open(a.path) as f:
            d = json.load(f)
    except (OSError, ValueError) as e:
        print("FAIL cannot read", a.path, "-", e)
        print("CHECKLIST FAIL")
        return 1
    fails = strict_verdict(d)
    for x in fails: print("FAIL", x)
    print("CHECKLIST " + ("PASS" if not fails else "FAIL"))
    return 0 if not fails else 1


SHOT_VIEWS = ("valley", "creature", "blocked", "done")


def shots_modes(raw):
    """Parse SHOTS_MODES: a nonempty comma list of fixture and live, no duplicates, nothing else (values become file names)."""
    modes = [m.strip() for m in raw.split(",")]
    if not modes or any(m not in MODES for m in modes) or len(set(modes)) != len(modes):
        sys.exit(f"SHOTS_MODES must be a comma list of {' and '.join(MODES)} (no other value, no duplicates); got {raw!r}")
    return modes


def cmd_shots(a):
    """Art-audit screenshots: valley, one creature, a blocked card and a done card up close, in fixture and live mode.
    Live mode seeds blocked and done cards. A missing target card or a missing image fails the run."""
    meta = {}; failures = []; stop = None
    modes = shots_modes(os.environ.get("SHOTS_MODES", "fixture,live"))
    try:
        for mode in modes:
            live = mode == "live"
            with session(a, live=live, boards={"default": 30} if live else None, states={"blocked": 2, "done": 2} if live else None) as (st, b):
                signin(b, st); open_pane(b)
                for view in SHOT_VIEWS:
                    name = f"art-{mode}-{view}"
                    try:
                        info = b.run(js("shots.js", VIEW=view), 60)
                        if not isinstance(info, dict) or info.get("missing"): raise RuntimeError(f"no {view} card: {info}")
                        b.keep_shot(name); meta[name] = info; print(name, redact(json.dumps(info))[:200], flush=True)
                    except Exception as e:
                        failures.append(f"{name}: {redact(repr(e))[:300]}"); print("FAIL", failures[-1], flush=True)
    except BaseException as e:
        failures.append("harness error: " + redact(repr(e))[:300])
        if not isinstance(e, Exception): stop = e
    for mode in modes:      # every required image must exist
        for view in SHOT_VIEWS:
            p = os.path.join(OUT, f"art-{mode}-{view}.jpg")
            if not (os.path.isfile(p) and os.path.getsize(p) > 0): failures.append(f"missing image art-{mode}-{view}.jpg")
    write_evidence(os.path.join(OUT, "art-shots.json"), {"pass": not failures, "failures": failures, "load_avg": os.getloadavg(), "shots": meta})
    print("SHOTS " + ("PASS" if not failures else "FAIL"))
    if stop: raise stop
    return 0 if not failures else 1


def cmd_perf(a):
    """Frame pacing at a baseline (30 cards) and at --cards (default 110) in live mode. Records host load before and after."""
    runs = {}; load0 = os.getloadavg(); failures = []; stop = None
    try:
        for n in (30, a.cards):
            spec = {"default": n} if n == 30 else {"default": n // 2, "alpha": n // 4, "beta": n - n // 2 - n // 4}
            with session(a, live=True, boards=spec) as (st, b):
                signin(b, st); open_pane(b)
                time.sleep(2)
                lo = os.getloadavg()
                r = b.run(js("perf.js", SECONDS=6), 60)
                if not isinstance(r, dict): raise RuntimeError(f"perf run returned {r!r}")
                r["load_before"] = lo; r["load_after"] = os.getloadavg()
                runs[f"cards_{n}"] = r; print(n, redact(json.dumps(r))[:400], flush=True)
    except BaseException as e:
        failures.append("harness error: " + redact(repr(e))[:300])
        if not isinstance(e, Exception): stop = e
    write_evidence(os.path.join(OUT, "perf.json"), {"pass": not failures, "failures": failures, "load_at_start": load0, "cpus": os.cpu_count(),
                   "note": "headless Chromium, software WebGL (SwiftShader), no GPU", "runs": runs, "repo_head": head()})
    print("PERF " + ("PASS" if not failures else "FAIL"))
    if stop: raise stop
    return 0 if not failures else 1


SOAK_COUNTS = ("geometries", "textures", "programs", "objects", "labels", "canvases")   # compared at the start, after restore and after unchanged updates


def soak_verdict(res):
    """Invariants of the soak. Only things that must hold: no resource left behind, touch does what the mouse does. Frame rate and heap
    are recorded but never judged (software rendering on a shared host; the JS heap is garbage-collected on its own schedule)."""
    bad = []
    c = res.get("churn")
    if not isinstance(c, dict): bad.append("churn did not run")
    else:
        isint = lambda v: isinstance(v, int) and not isinstance(v, bool)
        if not isint(c.get("updates")) or c["updates"] <= 0: bad.append(f"churn: updates run is {c.get('updates')!r}, not a positive count")
        if not isinstance(c.get("marks"), list) or not c["marks"]: bad.append("churn: no marks recorded")
        start = c.get("start") if isinstance(c.get("start"), dict) else {}
        for f in SOAK_COUNTS:
            if not isint(start.get(f)): bad.append(f"churn: start {f} is {start.get(f)!r}, not a count")
        for k in ("after_restore", "after_unchanged"):
            snap = c.get(k) if isinstance(c.get(k), dict) else {}
            for f in SOAK_COUNTS:
                if not isint(snap.get(f)): bad.append(f"churn: {k} {f} is {snap.get(f)!r}, not a count")
                elif isint(start.get(f)) and snap[f] != start[f]: bad.append(f"churn: {f} {snap[f]} after {k} vs {start[f]} at start")
        if any(not isinstance(m, dict) or m.get("canvases") != 1 for m in c.get("marks", []) if isinstance(c.get("marks"), list)): bad.append("churn: not exactly one canvas at every mark")
    t = res.get("touch")
    if not isinstance(t, dict): bad.append("touch did not run")
    else:
        if t.get("touch_action") != "none": bad.append(f"touch: canvas touch-action is {t.get('touch_action')!r}, not 'none'")
        if not t.get("tap_targets"): bad.append("touch: no card to tap")
        taps = t.get("taps") if isinstance(t.get("taps"), list) else []
        wants = [x.get("want") for x in taps if isinstance(x, dict)]
        if len(taps) != 3 or len(set(wants)) != 3 or any(not isinstance(w, str) or not w for w in wants): bad.append(f"touch: expected taps on exactly 3 distinct cards, got {wants!r}")
        for x in taps:
            if not isinstance(x, dict) or x.get("selected") != x.get("want") or x.get("panel") is not True: bad.append(f"touch: tap on {x.get('want') if isinstance(x, dict) else x!r} selected {x.get('selected') if isinstance(x, dict) else None} (panel shown: {x.get('panel') if isinstance(x, dict) else None})")
        for k in ("orbit_moved", "pinch_dist_changed", "selection_kept_after_pinch"):
            if t.get(k) is not True: bad.append(f"touch: {k} is {t.get(k)!r}" + (f" ({t.get(k.split('_')[0] + '_err')})" if t.get(k.split('_')[0] + '_err') else ""))
    m = res.get("remount")
    if not isinstance(m, list) or len(m) < 2: bad.append("remount did not run")
    else:
        geo = None
        for x in m[1:]:
            a, n = x.get("away") if isinstance(x.get("away"), dict) else {}, x.get("cycle")
            if a.get("old_disposed") is not True or a.get("old_context_lost") is not True: bad.append(f"remount {n}: old scene disposed={a.get('old_disposed')} context lost={a.get('old_context_lost')}")
            if a.get("labels") != 0: bad.append(f"remount {n}: {a.get('labels')} label(s) left in the page while away")
            if a.get("canvases") != 0: bad.append(f"remount {n}: {a.get('canvases')} canvas(es) left in the page while away")
            g = x.get("geometries")
            if not isinstance(g, int) or isinstance(g, bool): bad.append(f"remount {n}: geometries is {g!r}, not a count"); continue
            if not x.get("new_scene") or x.get("canvases") != 1: bad.append(f"remount {n}: new scene={x.get('new_scene')} canvases={x.get('canvases')}")
            geo = g if geo is None else geo
            if g != geo: bad.append(f"remount {n}: geometries {x.get('geometries')} vs {geo} after the first return")
    return bad


def cmd_soak(a):
    """Long-session checks in live mode: a status-churn soak (--updates), touch input, and --cycles remounts. Records numbers; judges invariants only."""
    res = {}; failures = []; stop = None; load0 = os.getloadavg()
    try:
        spec = {"default": a.cards} if a.cards <= 30 else {"default": a.cards // 2, "alpha": a.cards // 4, "beta": a.cards - a.cards // 2 - a.cards // 4}
        with session(a, live=True, boards=spec) as (st, b):
            signin(b, st); open_pane(b); time.sleep(2)
            res["churn"] = b.run(js("soak_churn.js", N=a.updates), 120); print("churn", redact(json.dumps(res["churn"]))[:600], flush=True)
            res["touch"] = b.run(js("soak_touch.js"), 90); print("touch", redact(json.dumps(res["touch"]))[:600], flush=True)
            res["remount"] = [dict(cycle=0, **b.run(js("soak_remount.js", STAGE="probe"), 30))]
            for i in range(1, a.cycles + 1):
                away = b.run(js("soak_remount.js", STAGE="away"), 30); time.sleep(1.5)
                mid = b.run(js("soak_remount.js", STAGE="mid"), 30)
                b.run(js("soak_remount.js", STAGE="back"), 30); time.sleep(3)
                r = b.run(js("soak_remount.js", STAGE="probe"), 30); r.update(cycle=i, away=dict(mid, **away))
                res["remount"].append(r); print("remount", i, redact(json.dumps(r))[:300], flush=True)
        failures = soak_verdict(res)
    except BaseException as e:
        failures.append("harness error: " + redact(repr(e))[:300])
        if not isinstance(e, Exception): stop = e
    write_evidence(os.path.join(OUT, "soak.json"), {"pass": not failures, "failures": failures, "load_at_start": load0, "cpus": os.cpu_count(), "cards": a.cards,
                   "note": "headless Chromium, software WebGL (SwiftShader), no GPU; counts are judged, frame rate and heap are not", "results": res, "repo_head": head()})
    for f in failures: print("FAIL " + f)
    print("SOAK " + ("PASS" if not failures else "FAIL"))
    if stop: raise stop
    return 0 if not failures else 1


def cmd_selftest(a):
    """Offline checks of the pure parts: redaction, confinement, process ownership, checklist verdict."""
    bad = []

    def t(name, ok):
        print(("PASS " if ok else "FAIL ") + name)
        if not ok: bad.append(name)
    SECRETS.add("s3cr3tvalue")
    t("redact ticket", "abc123" not in redact("http://x/webapp/launch#ticket=abc123 ok"))
    t("redact known secret", "s3cr3tvalue" not in redact("saw s3cr3tvalue here"))
    t("redact token kv", "xyz" not in redact('{"token": "xyz"}') and "xyz" not in redact("Authorization: Bearer xyz"))
    t("selftest runs inside the confined run directory", inside(tempfile.gettempdir(), RUN) and inside(RUN, STORAGE))
    with tempfile.TemporaryDirectory(prefix="rh-selftest.") as td:
        td = os.path.realpath(td)
        t("selftest scratch dir is inside the run directory", inside(td, RUN))
        s, run, homes, out = confine(td)
        t("confine makes unique run dir under storage", inside(run, s) and inside(homes, run) and inside(out, run))
        t("confine run dir is unique", confine(td)[1] != run)
        os.symlink("/tmp", os.path.join(run, "link"))
        t("symlink out of the run dir is not inside", not inside(os.path.join(run, "link", "x"), run))
        t("an unrelated path is not inside", not inside(td, run))
    for bad_env in (None, "", "relative/path", "/nonexistent-dir-xyz", "/"):
        try:
            confine(bad_env); t(f"confine refuses {bad_env!r}", False)
        except SystemExit:
            t(f"confine refuses {bad_env!r}", True)
    t("a process that is not ours is not owned", not owned(1, "/nonexistent/home"))
    t("this process is never owned", not owned(os.getpid(), "/x"))
    plan = [tuple(x) for x in CHECKLIST_PLAN]
    step = lambda n, **k: dict(step=n, ms=1, clicks=1, keys=0, ok=True, **k)
    pane = [{"card": f"c{i}", "steps": [step("open"), step("status", scene_ok=True), step("assign", scene_ok=True)]} for i in range(3)]
    board = [{"card": f"b{i}", "steps": [step("open"), step("status"), step("assign")]} for i in range(3)]
    server = [{"ui": u, "card": c["card"], "want": list(CHECKLIST_PLAN[i]), "db": list(CHECKLIST_PLAN[i]), "ok": True}
              for u, cs in (("pane", pane), ("board", board)) for i, c in enumerate(cs)]
    floor = {"eval_ms": 1, "click_ms": 2}
    good = lambda: ({"pane": json.loads(json.dumps(pane)), "board": json.loads(json.dumps(board))}, json.loads(json.dumps(server)))
    r, s2 = good(); t("verdict passes a clean run", checklist_verdict(r, plan, floor, s2) == [])
    r, s2 = good(); r["pane"][1]["steps"][1]["ok"] = False; t("verdict fails on ok:false", bool(checklist_verdict(r, plan, floor, s2)))
    r, s2 = good(); r["pane"][2]["steps"][2]["scene_ok"] = False; t("verdict fails on scene_ok:false", bool(checklist_verdict(r, plan, floor, s2)))
    r, s2 = good(); s2[4]["ok"] = False; t("verdict fails on a DB mismatch", bool(checklist_verdict(r, plan, floor, s2)))
    r, s2 = good(); r["board"].pop(); t("verdict fails on a missing trial", bool(checklist_verdict(r, plan, floor, s2)))
    r, s2 = good(); t("verdict fails without the floor", bool(checklist_verdict(r, plan, None, s2)))
    def sk():
        z = {"geometries": 74, "textures": 0, "programs": 4, "objects": 110, "labels": 11, "canvases": 1}
        rm = lambda n: {"cycle": n, "new_scene": True, "canvases": 1, "geometries": 72, "away": {"old_disposed": True, "old_context_lost": True, "labels": 0, "canvases": 0}}
        return {"churn": {"updates": 200, "start": dict(z), "after_restore": dict(z), "after_unchanged": dict(z), "marks": [{"canvases": 1}]},
                "touch": {"touch_action": "none", "tap_targets": 6, "taps": [{"want": w, "selected": w, "panel": True} for w in ("c1", "c2", "c3")], "orbit_moved": True, "pinch_dist_changed": True, "selection_kept_after_pinch": True},
                "remount": [{"cycle": 0}, rm(1), rm(2)]}
    t("soak verdict passes a clean run", soak_verdict(sk()) == [])
    r = sk(); r["churn"]["after_restore"]["geometries"] = 75; t("soak verdict fails a leaked geometry", bool(soak_verdict(r)))
    r = sk(); r["remount"][2]["away"]["old_context_lost"] = False; t("soak verdict fails a context left alive", bool(soak_verdict(r)))
    r = sk(); r["remount"][2]["geometries"] = 90; t("soak verdict fails geometry growth across remounts", bool(soak_verdict(r)))
    r = sk(); r["touch"]["taps"][0]["selected"] = None; t("soak verdict fails a tap that selects nothing", bool(soak_verdict(r)))
    r = sk(); r["touch"]["touch_action"] = "auto"; t("soak verdict fails a canvas that scrolls the page", bool(soak_verdict(r)))
    r = sk(); del r["touch"]; t("soak verdict fails a missing section", bool(soak_verdict(r)))
    r = sk(); r["churn"] = {}; t("soak verdict fails empty churn evidence", bool(soak_verdict(r)))
    r = sk(); r["churn"]["marks"] = []; t("soak verdict fails a churn with no marks", bool(soak_verdict(r)))
    r = sk(); r["churn"]["updates"] = 0; t("soak verdict fails zero updates run", bool(soak_verdict(r)))
    r = sk(); del r["churn"]["after_restore"]["programs"]; t("soak verdict fails a missing churn count", bool(soak_verdict(r)))
    r = sk(); r["churn"]["after_unchanged"]["programs"] = 9; t("soak verdict fails a leaked program", bool(soak_verdict(r)))
    r = sk(); del r["remount"][1]["geometries"]; t("soak verdict fails missing remount geometries", bool(soak_verdict(r)))
    r = sk(); r["remount"][2]["away"]["canvases"] = 1; t("soak verdict fails a canvas retained while away", bool(soak_verdict(r)))
    r = sk(); del r["remount"][2]["away"]["canvases"]; t("soak verdict fails an unrecorded away canvas count", bool(soak_verdict(r)))
    r = sk(); r["touch"]["taps"] = []; t("soak verdict fails zero taps", bool(soak_verdict(r)))
    r = sk(); r["touch"]["taps"] = r["touch"]["taps"][:1]; t("soak verdict fails one tap", bool(soak_verdict(r)))
    r = sk(); del r["touch"]["taps"]; t("soak verdict fails missing taps", bool(soak_verdict(r)))
    r = sk(); r["touch"]["taps"][1]["want"] = "c1"; r["touch"]["taps"][1]["selected"] = "c1"; t("soak verdict fails repeated tap targets", bool(soak_verdict(r)))
    r = sk(); r["touch"]["taps"][2]["want"] = ""; r["touch"]["taps"][2]["selected"] = ""; t("soak verdict fails an empty wanted id", bool(soak_verdict(r)))
    r = sk(); r["touch"]["taps"][2]["panel"] = False; t("soak verdict fails a tap without the panel", bool(soak_verdict(r)))
    # screenshot names and modes cannot reach outside OUT
    for m in ("../x", "/abs", "fixture,../x", "live,live", "", "fixture/", "Live"):
        try:
            shots_modes(m); t(f"shots_modes refuses {m!r}", False)
        except SystemExit:
            t(f"shots_modes refuses {m!r}", True)
    t("shots_modes accepts fixture,live", shots_modes("fixture,live") == ["fixture", "live"] and shots_modes("live") == ["live"])
    b = Browser.__new__(Browser)
    src = os.path.join(RUN, "tmp", "fake.jpg")
    with open(src, "wb") as f: f.write(b"\xff\xd8x")
    b.images = [{"path": src}]
    for nm in ("../x", "/abs/x", "a/b", "", "..", ".hidden", "a\x00b", None):
        try:
            b.keep_shot(nm); t(f"keep_shot refuses {nm!r}", False)
        except RuntimeError:
            t(f"keep_shot refuses {nm!r}", True)
    t("keep_shot copies a safe name inside OUT", inside(b.keep_shot("art-fixture-valley"), OUT))
    os.symlink("/", os.path.join(OUT, "art-live-valley.jpg"))
    try:
        b.keep_shot("art-live-valley"); t("keep_shot refuses a symlinked destination", False)
    except RuntimeError:
        t("keep_shot refuses a symlinked destination", True)
    # strict verdict: nothing inferred, nothing skipped
    ok_doc = {"pass": True, "failures": [], "plan": CHECKLIST_PLAN, "floor": floor, "trials": {"pane": pane, "board": board}, "server_state": server}
    cp = lambda: json.loads(json.dumps(ok_doc))
    t("strict verdict passes a complete clean run", strict_verdict(cp()) == [])
    d = cp(); d["plan"] = []; t("strict verdict fails an empty plan", bool(strict_verdict(d)))
    d = cp(); del d["plan"]; t("strict verdict fails a missing plan", bool(strict_verdict(d)))
    d = cp(); d["plan"] = d["plan"][:2]; t("strict verdict fails a shortened plan", bool(strict_verdict(d)))
    d = cp(); d["server_state"] = []; t("strict verdict fails empty server data", bool(strict_verdict(d)))
    d = cp(); del d["server_state"]; t("strict verdict fails missing server data", bool(strict_verdict(d)))
    d = cp(); d["trials"] = {}; d["server_state"] = []; d["plan"] = []; t("strict verdict fails all-empty evidence", bool(strict_verdict(d)))
    d = cp(); d["failures"] = ["harness error: cleanup failed"]; t("strict verdict fails a recorded harness failure", bool(strict_verdict(d)))
    d = cp(); d["pass"] = False; t("strict verdict fails pass:false", bool(strict_verdict(d)))
    d = cp(); del d["failures"]; t("strict verdict fails without the failures field", bool(strict_verdict(d)))
    d = cp(); del d["floor"]; t("strict verdict fails without the floor", bool(strict_verdict(d)))
    t("strict verdict fails a non-object", bool(strict_verdict([])))
    # database evidence must match each trial and the fixed plan
    dbd = lambda: dict(plan=[list(x) for x in CHECKLIST_PLAN], res={"pane": json.loads(json.dumps(pane)), "board": json.loads(json.dumps(board))}, srv=json.loads(json.dumps(server)))
    v = lambda d: checklist_verdict(d["res"], d["plan"], floor, d["srv"])
    d = dbd(); d["srv"] = [dict(d["srv"][0]) for _ in range(6)]; t("verdict fails six duplicated rows", bool(v(d)))
    d = dbd(); d["srv"][2]["card"] = "someone-else"; t("verdict fails a row for the wrong card", bool(v(d)))
    d = dbd(); d["srv"][3]["want"] = ["done", "reviewer"]; d["srv"][3]["db"] = ["done", "reviewer"]; t("verdict fails a row whose want differs from the plan", bool(v(d)))
    d = dbd(); d["srv"][1]["db"] = ["todo", "coder"]; t("verdict fails a row whose db differs while ok is true", bool(v(d)))
    d = dbd(); d["srv"][5]["ui"] = "pane"; t("verdict fails a row under the wrong UI", bool(v(d)))
    d = dbd(); d["srv"].append(dict(d["srv"][0])); t("verdict fails an extra row", bool(v(d)))
    d = dbd(); d["res"]["board"][0]["card"] = d["res"]["pane"][0]["card"]; t("verdict fails a card shared by two trials", bool(v(d)))
    d = dbd(); d["srv"][4] = "junk"; t("verdict fails a row that is not an object", bool(v(d)))
    d = dbd(); t("verdict passes matching rows", v(d) == [])
    # browser acquisition is recoverable: close() finds the session a failed open left behind
    import types
    sessions, closed, mode = {"old": "open"}, [], {}

    def fake(args, timeout):
        cmd = args[0]
        if cmd == "list":
            return types.SimpleNamespace(returncode=0, stdout=json.dumps([{"id": i, "state": s} for i, s in sessions.items()]), stderr="")
        if cmd == "open":
            for i in mode.get("new", ()): sessions[i] = "open"
            if mode.get("fail") == "timeout": raise subprocess.TimeoutExpired(args, timeout)
            return types.SimpleNamespace(returncode=0, stdout=mode.get("out", ""), stderr="")
        if cmd == "close":
            closed.append(args[1]); sessions[args[1]] = "closed"
            return types.SimpleNamespace(returncode=0, stdout="{}", stderr="")
        raise AssertionError(args)
    real_cli, real_host = bb_cli, bb_host
    globals()["bb_cli"], globals()["bb_host"] = fake, lambda: "h"
    try:
        def attempt(**m):
            mode.clear(); mode.update(m); closed.clear()
            sessions.clear(); sessions["old"] = "open"
            b = Browser(os.path.join(RUN, "tmp", "bscripts"))
            try: b.open()
            except Exception: pass
            return b
        b = Browser(os.path.join(RUN, "tmp", "bscripts")); b.close(); t("close before open() does nothing", closed == [])
        b = attempt(new=["n1"], fail="timeout"); b.close(); t("close recovers a session after an open() timeout", closed == ["n1"])
        b = attempt(new=["n2"], out="not json"); b.close(); t("close recovers a session after an unparseable open() reply", closed == ["n2"])
        b = attempt(new=["n3"], out="{}"); b.close(); t("close recovers a session after a reply with no id", closed == ["n3"])
        b = attempt(new=["n4"], out=json.dumps({"id": "n4"})); b.close(); t("close closes the id from a good reply", closed == ["n4"])
        b = attempt(fail="timeout"); b.close(); t("close does nothing when no session appeared", closed == [])
        b = attempt(new=["a", "b"], fail="timeout")
        try: b.close(); t("close refuses to guess among several new sessions", False)
        except RuntimeError: t("close refuses to guess among several new sessions", closed == [])
        t("an old session is never closed by recovery", "old" not in closed)
    finally:
        globals()["bb_cli"], globals()["bb_host"] = real_cli, real_host
    # session() registers the browser close before open(): a failing open still reaches it
    t("session registers the browser close before open()", s_order_ok())
    # the shutdown callback always stops owned processes, with or without --keep
    calls = []
    real_stop, real_clean = stop_home, cleanup_script
    try:
        globals()["stop_home"] = lambda st: calls.append("stop")
        globals()["cleanup_script"] = lambda home, reset=False: calls.append("clean")
        down({"home": "h", "port": None}, keep=True); t("down --keep stops processes and removes nothing", calls == ["stop"])
        calls.clear(); down({"home": "h", "port": None}); t("down stops processes then removes the home", calls == ["stop", "clean"])
    finally:
        globals()["stop_home"], globals()["cleanup_script"] = real_stop, real_clean
    print("SELFTEST " + ("FAIL" if bad else "PASS"))
    return 1 if bad else 0


def _term(sig, frame):
    raise SystemExit(128 + sig)      # unwinds through every finally / ExitStack, so scratch homes are always removed


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for n in ("install", "checklist", "perf", "shots", "soak"):
        p = sub.add_parser(n); p.add_argument("--keep", action="store_true"); p.add_argument("--cards", type=int, default=110)
        if n == "soak": p.add_argument("--updates", type=int, default=200); p.add_argument("--cycles", type=int, default=6)
    sub.add_parser("verdict").add_argument("path")
    sub.add_parser("selftest")
    a = ap.parse_args()
    for s in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, _term)
    if a.cmd == "shots":
        shots_modes(os.environ.get("SHOTS_MODES", "fixture,live"))      # refuse a bad value before any directory is made
    if a.cmd != "verdict":
        init_run(need_src=a.cmd != "selftest")
    try:
        code = globals()["cmd_" + a.cmd](a)
    finally:
        if a.cmd == "selftest" and RUN and inside(RUN, STORAGE) and os.path.basename(RUN).startswith("foundry-rh-run."):
            shutil.rmtree(RUN, ignore_errors=True)      # the selftest's own run directory, nothing else
    sys.exit(code)
