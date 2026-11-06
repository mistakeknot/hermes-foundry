#!/usr/bin/env bash
# Remove (or reset) exactly one rehearsal scratch home. Refuses anything that is not a direct child of
# $RH_ROOT named foundry-rh.*, or that is a symlink.
#   cleanup_home.sh HOME          remove the whole home
#   cleanup_home.sh --reset HOME  remove only the Hermes package/gateway state (the new-home crash workaround)
set -euo pipefail
mode=remove
if [ "${1:-}" = "--reset" ]; then mode=reset; shift; fi
home="${1:?usage: cleanup_home.sh [--reset] HOME}"
root="${RH_ROOT:?RH_ROOT must name the rehearsal root}"
root="$(cd "$root" && pwd -P)"
case "$(basename "$home")" in foundry-rh.*) ;; *) echo "refusing: not a foundry-rh.* home: $home" >&2; exit 2;; esac
[ -L "$home" ] && { echo "refusing: symlink: $home" >&2; exit 2; }
[ -d "$home" ] || { echo "already gone: $home"; exit 0; }
real="$(cd "$home" && pwd -P)"
[ "$(dirname "$real")" = "$root" ] || { echo "refusing: $real is not directly under $root" >&2; exit 2; }
if [ "$mode" = reset ]; then
  rm -rf -- "$real/installs" "$real/tools"
  rm -f -- "$real"/gateway.pid "$real"/gateway.lock "$real"/gateway.sock "$real"/gateway_state.json
  echo "reset: $real"
else
  rm -rf -- "$real"
  echo "removed: $real"
fi
