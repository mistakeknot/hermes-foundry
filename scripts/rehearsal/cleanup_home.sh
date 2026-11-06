#!/usr/bin/env bash
# Remove (or reset) exactly one rehearsal scratch home. Refuses anything that is not a direct child of
# $RH_ROOT named foundry-rh.*, that is a symlink, or that does not carry this run's ownership marker:
# the regular file <home>/.foundry-rh-owner must contain exactly $FOUNDRY_RH_TOKEN.
#   cleanup_home.sh HOME          remove the whole home
#   cleanup_home.sh --reset HOME  remove only the Hermes package/gateway state (the new-home crash workaround)
# Exit status is non-zero on any refusal or failure; the harness treats that as a failed run.
set -euo pipefail
mode=remove
if [ "${1:-}" = "--reset" ]; then mode=reset; shift; fi
home="${1:?usage: cleanup_home.sh [--reset] HOME}"
root="${RH_ROOT:?RH_ROOT must name the rehearsal root}"
token="${FOUNDRY_RH_TOKEN:?FOUNDRY_RH_TOKEN must hold the token of the run}"
root="$(cd "$root" && pwd -P)"
case "$(basename "$home")" in foundry-rh.*) ;; *) echo "refusing: not a foundry-rh.* home: $home" >&2; exit 2;; esac
[ -L "$home" ] && { echo "refusing: symlink: $home" >&2; exit 2; }
[ -d "$home" ] || { echo "already gone: $home"; exit 0; }
real="$(cd "$home" && pwd -P)"
[ "$(dirname "$real")" = "$root" ] || { echo "refusing: $real is not directly under $root" >&2; exit 2; }
marker="$real/.foundry-rh-owner"
{ [ -f "$marker" ] && [ ! -L "$marker" ]; } || { echo "refusing: no ownership marker in $real" >&2; exit 2; }
[ "$(cat -- "$marker")" = "$token" ] || { echo "refusing: ownership marker in $real is not this run's" >&2; exit 2; }
if [ "$mode" = reset ]; then
  rm -rf -- "$real/installs" "$real/tools"
  rm -f -- "$real"/gateway.pid "$real"/gateway.lock "$real"/gateway.sock "$real"/gateway_state.json
  echo "reset: $real"
else
  rm -rf -- "$real"
  echo "removed: $real"
fi
