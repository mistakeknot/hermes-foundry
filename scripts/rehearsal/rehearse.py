#!/usr/bin/env python3
"""Repeatable rehearsal harness for the Foundry pane (stdlib only).

Subcommands (each creates its own scratch HERMES_HOME and removes it on exit unless --keep):
  install   clean-home install rehearsal on the fixture: install the plugin, enable it, start the Webapp,
            opt in to the desktop half, open the pane in headless Chromium, check it rendered. PASS/FAIL.
  checklist timed interaction checklist: open a card, change its status, assign a profile, in the pane and in
            the 2D kanban board of the same Webapp, same browser, same kanban database (live mode).
  perf      frame pacing at 30 and N (default 110) cards in the pane, with the host load recorded.
  shots     screenshots of the pane for the art audit (SHOTS_MODES=fixture,live).
  up/down   start or stop a scratch home by hand (state in <home>/rehearsal.json).

Environment (defaults in brackets):
  HERMES_SRC  Hermes checkout used as PYTHONPATH and for the prebuilt Webapp renderer [required]
  HERMES_PY   python of the Hermes venv [the interpreter named in the `hermes` shebang]
  SRC_URL     where `hermes plugins install` reads the plugin [file://<this repo>] (committed HEAD only)
  BB_HOST     host id for `bb browser-automation` [from `bb status --json`]
  RH_ROOT     parent of scratch homes [$BB_THREAD_STORAGE/rh]; homes are removed only by cleanup_home.sh
  OUT         directory for results and screenshots [./rehearsal-out]
"""
import argparse, json, os, re, shutil, socket, subprocess, sys, tempfile, time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.environ.get("HERMES_SRC") or sys.exit("set HERMES_SRC to a Hermes checkout")
OUT = os.path.abspath(os.environ.get("OUT", "rehearsal-out"))
SRC_URL = os.environ.get("SRC_URL", "file://" + REPO)
JSDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "js")


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


RH_ROOT = os.path.abspath(os.environ.get("RH_ROOT") or os.path.join(os.environ.get("BB_THREAD_STORAGE") or tempfile.gettempdir(), "rh"))
CLEANUP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cleanup_home.sh")


def free_port():
    fp = shutil.which("free-port")          # the fleet's allocator; never a remembered or default port
    if fp:
        out = subprocess.run([fp], capture_output=True, text=True).stdout.strip()
        if out.isdigit(): return int(out)
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def henv(hh, live=False, extra=None):
    e = dict(os.environ, HERMES_HOME=hh, PYTHONPATH=SRC)
    for k in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"):
        e.pop(k, None)
    e.pop("FOUNDRY_MODE", None); e.pop("FOUNDRY_REPLAY", None)
    if live:
        e["FOUNDRY_MODE"] = "live"
    # Hermes spawns its gateway/webapp helpers by name: keep the venv python first on PATH.
    e["PATH"] = os.path.dirname(hermes_py()) + os.pathsep + e.get("PATH", "")
    e.update(extra or {})
    return e


def hermes(hh, args, live=False, timeout=120, wrap=()):
    return subprocess.run(list(wrap) + ["nice", "-n", "19", hermes_py(), "-m", "hermes_cli.main"] + args, env=henv(hh, live),
                          capture_output=True, text=True, timeout=timeout)


def listener_pid(port):
    out = subprocess.run(["ss", "-ltnp", f"sport = :{port}"], capture_output=True, text=True).stdout
    m = re.search(r"pid=(\d+)", out)
    return int(m.group(1)) if m else None


def mint(hh, port, live):
    """Start (or reuse) the Webapp for this home and return a one-use sign-in URL (valid 60 s)."""
    r = hermes(hh, ["webapp", "--no-open", "--skip-build"], live, timeout=60, wrap=["timeout", "45"])
    m = re.search(r"(http://127\.0\.0\.1:(\d+)/webapp/launch#ticket=[A-Za-z0-9_-]+)", r.stdout + r.stderr)
    if not m:
        raise RuntimeError("no sign-in link: " + (r.stdout + r.stderr)[-400:])
    return m.group(1)


def up(live=False, boards=None):
    """Create a scratch home and start the Webapp; on any failure stop it and remove the home before re-raising."""
    st = {}
    try:
        return _up(st, live, boards)
    except BaseException:
        if st.get("home"):
            down(st)
        raise


def _up(st, live, boards):
    os.makedirs(RH_ROOT, exist_ok=True)
    hh = tempfile.mkdtemp(prefix="foundry-rh.", dir=RH_ROOT)
    port = free_port()
    with open(os.path.join(hh, "config.yaml"), "w") as f:
        f.write(f"webapp:\n  enabled: true\n  host: 127.0.0.1\n  port: {port}\n")
    st.update({"home": hh, "port": port, "live": live})
    json.dump(st, open(os.path.join(hh, "rehearsal.json"), "w"))
    r = hermes(hh, ["plugins", "install", SRC_URL, "--no-enable"])
    if r.returncode: raise RuntimeError("plugin install failed: " + (r.stdout + r.stderr)[-500:])
    r = hermes(hh, ["plugins", "enable", "foundry"])
    if r.returncode: raise RuntimeError("plugin enable failed: " + (r.stdout + r.stderr)[-500:])
    if live and boards:
        seed(hh, boards)
    url = None
    for attempt in (1, 2):
        try:
            url = mint(hh, port, live)
            break
        except RuntimeError:
            # Known Hermes quirk on a brand-new home (pydantic ArgsKwargs): stop what we started, reset that home's state.
            stop_home(st)
            subprocess.run(["bash", CLEANUP, "--reset", hh], env=dict(os.environ, RH_ROOT=RH_ROOT), check=True)
            if attempt == 2: raise
    for _ in range(60):
        if listener_pid(port): break
        time.sleep(0.5)
    st["url"] = url
    json.dump(st, open(os.path.join(hh, "rehearsal.json"), "w"))
    return st


def stop_home(st):
    """Stop every process this harness started for the home: the Webapp listener and its gateway."""
    hh = st["home"]
    pids = set()
    pid = listener_pid(st["port"]) if st.get("port") else None
    if pid: pids.add(pid)
    for d in os.listdir("/proc"):
        if d.isdigit() and int(d) != os.getpid():
            try:
                env = open(f"/proc/{d}/environ", "rb").read().split(b"\0")
            except OSError:
                continue
            if ("HERMES_HOME=" + hh).encode() in env: pids.add(int(d))
    for sig in (15, 9):
        for p in list(pids):
            try: os.kill(p, sig)
            except ProcessLookupError: pids.discard(p)
        for _ in range(25):
            if not any(os.path.exists(f"/proc/{p}") for p in pids): break
            time.sleep(0.2)


def down(st):
    stop_home(st)
    subprocess.run(["bash", CLEANUP, st["home"]], env=dict(os.environ, RH_ROOT=RH_ROOT))


SEED = r'''
import os, sys, json
sys.path.insert(0, os.environ["PYTHONPATH"].split(os.pathsep)[0])
from hermes_cli import kanban_db as kb, kanban_db_boards as boards, kanban_db_connect as kc
spec = json.loads(sys.argv[1])           # {"atlas": 40, "harbor": 40, ...}
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
        # a few claimed (running) and some blocked, so every colour appears
        for t in ids[slug][: max(1, n // 12)]:
            kb.claim_task(c, t, claimer="coder")
    finally:
        c.close()
print(json.dumps(ids))
'''


def seed(hh, spec):
    r = subprocess.run([hermes_py(), "-c", SEED, json.dumps(spec)], env=henv(hh, True), capture_output=True, text=True, timeout=300)
    if r.returncode: raise RuntimeError("seed failed: " + r.stderr[-600:])
    json.dump(json.loads(r.stdout.strip().splitlines()[-1]), open(os.path.join(hh, "seeded.json"), "w"))


# ---- browser ----------------------------------------------------------------------------------------------
class Browser:
    def __init__(self):
        self.host = bb_host()
        r = subprocess.run(["bb", "browser-automation", "open", "--backend", "local", "--headless", "--machine", self.host, "--json"],
                           capture_output=True, text=True, timeout=180)
        d = json.loads(r.stdout)
        self.sid = d.get("id") or d.get("sessionId") or d["session"]["id"]
        self.directive = d.get("previewDirective")

    def run(self, js, timeout=90):
        fd, path = tempfile.mkstemp(suffix=".js", prefix="foundry-rh-js."); os.write(fd, js.encode()); os.close(fd)
        try:
            r = subprocess.run(["bb", "browser-automation", "run", self.sid, "--script-file", path, "--script-host", self.host,
                                "--timeout", f"{timeout}s", "--json"], capture_output=True, text=True, timeout=timeout + 30)
        finally:
            os.unlink(path)
        try:
            d = json.loads(r.stdout)
        except Exception:
            raise RuntimeError("browser run failed: " + (r.stdout + r.stderr)[-500:])
        if d.get("ok") is False or d.get("exitCode"): raise RuntimeError("browser script error: " + str(d)[-500:])
        self.raw = d; self.images = d.get("images", [])
        txt = d.get("text")
        try: return json.loads(txt)
        except Exception: return txt

    def keep_shot(self, name):
        """Copy the newest screenshot of the last run into OUT/<name>.jpg."""
        os.makedirs(OUT, exist_ok=True)
        if not self.images: return None
        dest = os.path.join(OUT, name + ".jpg")
        shutil.copy(self.images[-1]["path"], dest)
        return dest

    def close(self):
        subprocess.run(["bb", "browser-automation", "close", self.sid, "--json"], capture_output=True, text=True, timeout=60)


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


# ---- subcommands ----------------------------------------------------------------------------------------
def cmd_install(a):
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time(); checks = []

    def check(name, ok, detail=""):
        checks.append({"check": name, "ok": bool(ok), "detail": detail}); print(("PASS " if ok else "FAIL ") + name + (" - " + str(detail) if detail else ""))
    st = None; b = None
    try:
        st = up(live=False)
        check("plugin installed and enabled; Webapp listening", listener_pid(st["port"]), f"port {st['port']}")
        d = os.path.join(st["home"], "plugins", "foundry")
        check("agent half present", os.path.isfile(os.path.join(d, "plugin.yaml")), d)
        b = Browser()
        print(b.directive or "")
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
    except Exception as e:
        check("harness ran to completion", False, repr(e)[:300])
    finally:
        if b: b.close()
        if st and not a.keep: down(st)
    ok = all(c["ok"] for c in checks)
    json.dump({"ok": ok, "seconds": round(time.time() - t0, 1), "checks": checks, "repo_head": subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()},
              open(os.path.join(OUT, "install-rehearsal.json"), "w"), indent=1)
    print("REHEARSAL " + ("PASS" if ok else "FAIL")); return 0 if ok else 1


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
    r = subprocess.run([hermes_py(), "-c", VERIFY], env=henv(st["home"], True), capture_output=True, text=True, timeout=60)
    return json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 else {}


def med(xs):
    xs = sorted(xs); return xs[len(xs) // 2] if xs else None


def cmd_checklist(a):
    """Open a card, change its status, assign a profile: three trials each in the pane and on the 2D board."""
    os.makedirs(OUT, exist_ok=True)
    plan = [("blocked", "coder"), ("blocked", "reviewer"), ("blocked", "coder")]
    st = None; b = None; res = {"pane": [], "board": []}; load = os.getloadavg()
    try:
        st = up(live=True, boards={"default": 30})
        b = Browser(); print(b.directive or "", flush=True)
        signin(b, st, enable=("foundry", "kanban"))
        r = open_pane(b); print("pane ready:", {k: r.get(k) for k in ("mode", "creatures", "cards")}, flush=True)
        floor = b.run(js("checklist.js", STAGE="floor", TRIAL=0, STATUS="", PROFILE=""), 60)
        for i, (status, profile) in enumerate(plan):
            res["pane"].append(b.run(js("checklist.js", STAGE="pane", TRIAL=i, STATUS=status, PROFILE=profile), 80))
            if i == len(plan) - 1: b.keep_shot("checklist-pane-after")
            print("pane trial", i, [(s["step"], s["ms"]) for s in res["pane"][-1]["steps"]], flush=True)
        print("board:", b.run(js("navboard.js"), 60), flush=True)
        for i, (status, profile) in enumerate(plan):
            res["board"].append(b.run(js("checklist.js", STAGE="board", TRIAL=i, STATUS=status, PROFILE=profile), 80))
            if i == len(plan) - 1: b.keep_shot("checklist-board-after")
            print("board trial", i, [(s["step"], s["ms"]) for s in res["board"][-1]["steps"]], flush=True)
        dbs = db_state(st); db = dbs.get("tasks", {}); events = dbs.get("events", {})
        server = []
        for ui in ("pane", "board"):
            for t, (status, profile) in zip(res[ui], plan):
                got = db.get(t["card"], ["?", "?"])
                server.append({"ui": ui, "card": t["card"], "want": [status, profile], "db": got, "events": events.get(t["card"], []), "ok": got == [status, profile]})
    finally:
        json.dump(res, open(os.path.join(OUT, "checklist-partial.json"), "w"), indent=1)
        if b: b.close()
        if st and not a.keep: down(st)
    summ = {}
    for ui in ("pane", "board"):
        for step in ("open", "status", "assign"):
            rows = [x for t in res[ui] for x in t["steps"] if x["step"] == step]
            summ[f"{ui}.{step}"] = {"clicks": rows[0]["clicks"], "keys": rows[0]["keys"], "ms_median": med([x["ms"] for x in rows]), "ms_all": [x["ms"] for x in rows],
                                    "ms_scene_median": med([x["ms_scene"] for x in rows if "ms_scene" in x]) if ui == "pane" else None, "all_ok": all(x["ok"] for x in rows)}
    out = {"load_avg_at_start": load, "cpus": os.cpu_count(), "floor": floor, "summary": summ, "server_state": server, "trials": res,
           "repo_head": subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()}
    json.dump(out, open(os.path.join(OUT, "checklist.json"), "w"), indent=1)
    print(json.dumps({"floor": floor, "summary": summ, "server_ok": all(x["ok"] for x in server)}, indent=1))
    return 0 if all(x["ok"] for x in server) else 1


def cmd_shots(a):
    """Art-audit screenshots: valley, one creature, a blocked card and a done card up close, in fixture and live mode."""
    os.makedirs(OUT, exist_ok=True)
    meta = {}
    for mode in os.environ.get("SHOTS_MODES", "fixture,live").split(","):
        st = None; b = None
        try:
            st = up(live=(mode == "live"), boards={"default": 30} if mode == "live" else None)
            b = Browser(); signin(b, st); open_pane(b)
            for view in ("valley", "creature", "blocked", "done"):
                info = b.run(js("shots.js", VIEW=view), 60)
                name = f"art-{mode}-{view}"; b.keep_shot(name); meta[name] = info; print(name, json.dumps(info)[:200], flush=True)
        finally:
            if b: b.close()
            if st and not a.keep: down(st)
    json.dump({"load_avg": os.getloadavg(), "shots": meta}, open(os.path.join(OUT, "art-shots.json"), "w"), indent=1)
    return 0


def cmd_perf(a):
    """Frame pacing at a baseline (30 cards) and at --cards (default 110) in live mode. Records host load before and after."""
    os.makedirs(OUT, exist_ok=True)
    runs = {}; load0 = os.getloadavg()
    for n in (30, a.cards):
        spec = {"default": n} if n == 30 else {"default": n // 2, "alpha": n // 4, "beta": n - n // 2 - n // 4}
        st = None; b = None
        try:
            st = up(live=True, boards=spec)
            b = Browser(); signin(b, st); open_pane(b)
            time.sleep(2)
            lo = os.getloadavg()
            r = b.run(js("perf.js", SECONDS=6), 60); r["load_before"] = lo; r["load_after"] = os.getloadavg()
            runs[f"cards_{n}"] = r; print(n, json.dumps(r)[:400], flush=True)
        finally:
            if b: b.close()
            if st and not a.keep: down(st)
    json.dump({"load_at_start": load0, "cpus": os.cpu_count(), "note": "headless Chromium, software WebGL (SwiftShader), no GPU", "runs": runs,
               "repo_head": subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()},
              open(os.path.join(OUT, "perf.json"), "w"), indent=1)
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for n in ("install", "checklist", "perf", "shots"):
        p = sub.add_parser(n); p.add_argument("--keep", action="store_true"); p.add_argument("--cards", type=int, default=110); p.add_argument("--home")
    a = ap.parse_args()
    sys.exit(globals()["cmd_" + a.cmd](a))
