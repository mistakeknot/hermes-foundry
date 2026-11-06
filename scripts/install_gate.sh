#!/usr/bin/env bash
# Clean-HERMES_HOME install gate: install the plugin from a git URL, enable it, start the dashboard on a free port
# with no API keys, and hit the router with and without the session token. No developer checkout is on the path.
# Usage: scripts/install_gate.sh [git-url]   (default: this repo's origin, so the branch must be the default one;
#        pass file:///path/to/clone to test a branch)
# Every check is mandatory: the first one that fails prints "GATE FAIL ..." and the script exits non-zero.
# "ALL GREEN" is printed only when every check passed. The temp HERMES_HOME and the dashboard are always cleaned up.
# HERMES_BIN overrides the hermes executable (tests/test_install_gate.py uses a stub to prove the failure paths).
set -euo pipefail

URL="${1:-mistakeknot/hermes-foundry}"
HERMES="${HERMES_BIN:-hermes}"
HH=""
PID=""
LOG=""

step() { printf 'GATE %s\n' "$*"; }
fail() { step "FAIL $*"; exit 1; }

cleanup() {
  local rc=$?
  trap - EXIT
  if [ -n "$PID" ]; then
    pkill -P "$PID" 2>/dev/null || true
    kill "$PID" 2>/dev/null || true
    local i
    for i in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; timeout 0.1 tail -f /dev/null || true; done
    if kill -0 "$PID" 2>/dev/null; then kill -9 "$PID" 2>/dev/null || true; fi
    wait "$PID" 2>/dev/null || true
  fi
  if [ "$rc" -ne 0 ] && [ -n "$LOG" ] && [ -f "$LOG" ]; then
    printf 'GATE dashboard log (last 20 lines):\n' >&2
    tail -n 20 "$LOG" >&2 || true
  fi
  case "$HH" in
    */foundry-gate-hh.*) if [ -d "$HH" ] && [ ! -L "$HH" ]; then rm -rf -- "$HH"; fi ;;
  esac
  exit "$rc"
}
trap cleanup EXIT

HH="$(mktemp -d "${TMPDIR:-/tmp}/foundry-gate-hh.XXXX")" || fail "mktemp failed"
[ -d "$HH" ] || fail "temp HERMES_HOME was not created: $HH"
export HERMES_HOME="$HH"
unset OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY
LOG="$HH/dash.log"

PORT="$(free-port 2>/dev/null)" || PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
[ -n "$PORT" ] || fail "no free port"
B="http://127.0.0.1:$PORT"

nice -n 19 timeout 120 "$HERMES" plugins install "$URL" --no-enable >/dev/null || fail "plugin install from $URL"
step "install ok"
timeout 60 "$HERMES" plugins enable foundry >/dev/null || fail "plugin enable"
step "enable ok"

nohup nice -n 19 "$HERMES" dashboard --port "$PORT" --no-open --skip-build >"$LOG" 2>&1 &
PID=$!
ready=""
for _ in $(seq 1 60); do
  if curl -s -m 2 -o /dev/null "$B/"; then ready=1; break; fi
  kill -0 "$PID" 2>/dev/null || fail "dashboard exited before it was ready"
  timeout 1 tail -f /dev/null || true
done
[ -n "$ready" ] || fail "dashboard not ready on port $PORT"

PAGE="$(curl -s -m 5 "$B/")" || fail "dashboard page"
TOK="$(printf '%s' "$PAGE" | grep -a -o 'SESSION_TOKEN__ *= *"[^"]*"' | head -1 | sed 's/.*"\(.*\)"/\1/' || true)"
[ -n "$TOK" ] || fail "no session token in the dashboard page"

code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$B/api/plugins/foundry/snapshot")" || fail "unauthenticated snapshot request"
[ "$code" = 401 ] || fail "unauthenticated snapshot -> $code (want 401)"
step "unauthenticated snapshot -> 401 ok"

H="X-Hermes-Session-Token: $TOK"
SNAP="$(curl -s -m 5 -f -H "$H" "$B/api/plugins/foundry/snapshot")" || fail "authenticated snapshot request"
printf '%s' "$SNAP" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["mode"] == "fixture" and d["epoch"] and d["last_seq"] == 0, d["mode"]
assert len(d["projects"]) == 3 and len(d["workers"]) == 4
print("GATE snapshot ok:", d["mode"], sum(len(p["cards"]) for p in d["projects"]), "cards")' || fail "snapshot has the wrong shape"
CUR="$(printf '%s' "$SNAP" | python3 -c 'import json, sys; print(json.load(sys.stdin)["cursor"])')" || fail "snapshot has no cursor"
[ -n "$CUR" ] || fail "empty cursor"

RES="$(curl -s -m 5 -f -H "$H" -H 'content-type: application/json' -d '{"type":"stand","on":true}' "$B/api/plugins/foundry/command")" \
  || fail "command request"
printf '%s' "$RES" | python3 -c 'import json, sys; assert json.load(sys.stdin).get("ok") is True' || fail "command did not return ok:true: $RES"
step "command ok"

EV="$(curl -s -m 5 -f -H "$H" "$B/api/plugins/foundry/events?since=$CUR")" || fail "events request"
printf '%s' "$EV" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["resync"] is False and [e["type"] for e in d["events"]] == ["paused"], d
print("GATE events ok: paused")' || fail "events did not return the command's event: $EV"

LIST="$(curl -s -m 5 -f -H "$H" "$B/api/dashboard/plugins")" || fail "plugin listing request"
printf '%s' "$LIST" | grep -q '"name": *"foundry"' || fail "the dashboard does not list the foundry plugin"
step "dashboard lists plugin"

step "ALL GREEN (python router; the pane is not exercised here)"
