#!/usr/bin/env bash
# Clean-HERMES_HOME install gate: install the plugin from a git URL, enable it, start the dashboard on a free port
# with no API keys, and hit the router with and without the session token. No developer checkout is on the path.
# Usage: scripts/install_gate.sh [git-url]   (default: this repo's origin, so the branch must be the default one;
#        pass file:///path/to/clone to test a branch)
set -euo pipefail
URL="${1:-mistakeknot/hermes-foundry}"
PORT="$(free-port)"
export HERMES_HOME="$(mktemp -d /tmp/foundry-gate-hh.XXXX)"
unset OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY
LOG="$HERMES_HOME/dash.log"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT
step() { printf 'GATE %s\n' "$*"; }

nice -n 19 timeout 120 hermes plugins install "$URL" --no-enable >/dev/null && step "install ok"
timeout 60 hermes plugins enable foundry >/dev/null && step "enable ok"
nohup nice -n 19 hermes dashboard --port "$PORT" --no-open --skip-build >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/" && break; timeout 1 tail -f /dev/null || true; done
B="http://127.0.0.1:$PORT"
TOK="$(curl -s -m 5 "$B/" | grep -a -o 'SESSION_TOKEN__ *= *"[^"]*"' | head -1 | sed 's/.*"\(.*\)"/\1/')"
[ -n "$TOK" ] || { step "FAIL no session token"; exit 1; }
code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$B/api/plugins/foundry/snapshot")"
[ "$code" = 401 ] && step "unauthenticated snapshot -> 401 ok" || { step "FAIL unauthenticated snapshot -> $code"; exit 1; }
H="X-Hermes-Session-Token: $TOK"
curl -s -m 5 -H "$H" "$B/api/plugins/foundry/snapshot" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["mode"] == "fixture" and d["epoch"] and d["last_seq"] == 0, d["mode"]
assert len(d["projects"]) == 3 and len(d["workers"]) == 4
print("GATE snapshot ok:", d["mode"], sum(len(p["cards"]) for p in d["projects"]), "cards")'
CUR="$(curl -s -m 5 -H "$H" "$B/api/plugins/foundry/snapshot" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cursor"])')"
curl -s -m 5 -H "$H" -H 'content-type: application/json' -d '{"type":"stand","on":true}' "$B/api/plugins/foundry/command" | grep -q '"ok":true' && step "command ok"
curl -s -m 5 -H "$H" "$B/api/plugins/foundry/events?since=$CUR" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["resync"] is False and [e["type"] for e in d["events"]] == ["paused"], d
print("GATE events ok: paused")'
curl -s -m 5 -H "$H" "$B/api/dashboard/plugins" | grep -q '"name": *"foundry"' && step "dashboard lists plugin"
step "ALL GREEN (python router; the pane is not exercised here)"
