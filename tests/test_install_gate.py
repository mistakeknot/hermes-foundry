"""scripts/install_gate.sh must exit non-zero, and never print ALL GREEN, when any one mandatory check fails.

A stub ``hermes`` (HERMES_BIN) and a stub dashboard server stand in for Hermes, so each failure mode is injected
on its own. The first test is the positive control: with no fault injected the same stubs make the gate pass, so
the negatives below fail for the injected reason and not because the harness is broken.
"""

import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

GATE = Path(__file__).resolve().parent.parent / "scripts" / "install_gate.sh"

STUB_SERVER = r'''
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

FAULT = os.environ.get("STUB_FAULT", "")
TOKEN = "stub-token"
state = {"paused": False}


def snapshot():
    cards = [{"id": "p%d:t%d" % (i, j), "title": "c"} for i in range(3) for j in range(2)]
    return {"v": 1, "mode": "fixture", "epoch": "e", "cursor": "e.0", "last_seq": 0, "paused": False,
            "projects": [{"id": "p%d" % i, "name": "P", "epics": [], "cards": cards[2 * i:2 * i + 2]} for i in range(3)],
            "workers": [{"id": "w%d" % i, "name": "w", "state": "idle", "card_id": None} for i in range(4)]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authed(self):
        return self.headers.get("X-Hermes-Session-Token") == TOKEN

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            return self.send(200, '<script>window.__HERMES_SESSION_TOKEN__ = "%s";</script>' % ("" if FAULT == "no_token" else TOKEN), "text/html")
        if path == "/api/plugins/foundry/snapshot":
            if not self.authed() and FAULT != "open_snapshot":
                return self.send(401, "{}")
            snap = snapshot()
            if FAULT == "bad_shape":
                snap["workers"] = snap["workers"][:3]
            return self.send(200, json.dumps(snap))
        if path == "/api/plugins/foundry/events":
            ev = [{"seq": 1, "type": "paused" if FAULT != "bad_events" else "card_upsert", "payload": {"paused": True}}]
            return self.send(200, json.dumps({"v": 1, "epoch": "e", "cursor": "e.1", "resync": False, "events": ev}))
        if path == "/api/dashboard/plugins":
            names = [] if FAULT == "no_plugin_listing" else [{"name": "foundry"}]
            return self.send(200, json.dumps(names))
        self.send(404, "{}")

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        if self.path.split("?")[0] == "/api/plugins/foundry/command" and self.authed():
            return self.send(200, json.dumps({"ok": FAULT != "command_refused"}))
        self.send(401, "{}")


HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
'''

STUB_HERMES = '''#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "plugins install") [ "${STUB_FAULT:-}" = install_fails ] && exit 1; exit 0 ;;
  "plugins enable") [ "${STUB_FAULT:-}" = enable_fails ] && exit 1; exit 0 ;;
esac
if [ "${1:-}" = dashboard ]; then
  [ "${STUB_FAULT:-}" = dashboard_dies ] && exit 3
  exec python3 "$STUB_SERVER" "$3"
fi
exit 0
'''


@pytest.fixture
def harness(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    hermes = bindir / "hermes"
    hermes.write_text(STUB_HERMES)
    hermes.chmod(hermes.stat().st_mode | stat.S_IXUSR)
    server = tmp_path / "stub_server.py"
    server.write_text(STUB_SERVER)
    tmpdir = tmp_path / "tmp"
    tmpdir.mkdir()

    def run(fault=""):
        env = {k: v for k, v in os.environ.items() if k not in ("HERMES_HOME",)}
        env.update(PATH=f"{bindir}:{os.environ['PATH']}", HERMES_BIN=str(hermes), STUB_SERVER=str(server),
                   STUB_FAULT=fault, TMPDIR=str(tmpdir))
        r = subprocess.run(["bash", str(GATE), "file:///nonexistent"], env=env, capture_output=True, text=True, timeout=120)
        return r, tmpdir

    return run


pytestmark = pytest.mark.skipif(shutil.which("curl") is None or sys.platform == "win32", reason="needs bash and curl")


def test_positive_control_passes_and_cleans_up(harness):
    r, tmpdir = harness("")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "ALL GREEN" in r.stdout and "GATE FAIL" not in r.stdout
    assert list(tmpdir.iterdir()) == []  # the temp HERMES_HOME is gone on success


@pytest.mark.parametrize("fault", [
    "install_fails", "enable_fails", "dashboard_dies", "no_token", "open_snapshot", "bad_shape",
    "command_refused", "bad_events", "no_plugin_listing",
])
def test_every_mandatory_check_fails_the_gate(harness, fault):
    r, tmpdir = harness(fault)
    assert r.returncode != 0, f"{fault}: gate exited 0\n{r.stdout}{r.stderr}"
    assert "ALL GREEN" not in r.stdout, f"{fault}: printed ALL GREEN"
    assert "GATE FAIL" in r.stdout or "FAIL" in r.stdout + r.stderr
    assert list(tmpdir.iterdir()) == []  # and the temp HERMES_HOME is removed on failure too


def test_mktemp_failure_is_not_masked(tmp_path):
    env = {**os.environ, "TMPDIR": str(tmp_path / "does-not-exist")}
    r = subprocess.run(["bash", str(GATE), "file:///x"], env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "ALL GREEN" not in r.stdout


def test_no_file_trips_the_hermes_install_scanner_socket_oneliner():
    """`hermes plugins install` refuses a repo with a critical scanner finding and --force does not override.
    A python one-liner that opens a socket via the interpreter's -c flag (scanner rule python_socket_oneliner)
    once made the repo uninstallable, so keep it out of every tracked file, this one included."""
    import re

    root = GATE.parent.parent
    files = subprocess.run(["git", "-C", str(root), "ls-files"], capture_output=True, text=True, check=True).stdout.split()
    rule = re.compile(r"""python[23]?\s+-c\s+["']import\s+socket""")
    hits = []
    for rel in files:
        p = root / rel
        try:
            text = p.read_text(errors="strict")
        except (UnicodeDecodeError, OSError):
            continue
        if rule.search(text):
            hits.append(rel)
    assert hits == [], f"scanner-critical socket one-liner in: {hits}"
