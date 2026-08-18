#!/usr/bin/env bash
# E2E battery for pi-extensions (background-jobs).
# Uses ~7 pi model calls; run when touching extensions/background-jobs.ts.
# Each test drives the model through the REAL tool path and demands an
# exact-format answer, because -p-mode models can confabulate results
# without calling tools (observed during development).
set -uo pipefail
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0

run() { # run <name> <prompt> <expected-substring>
  local name="$1" prompt="$2" expect="$3"
  local out
  out=$(timeout 180 pi -e "$PKG_DIR" -p "$prompt" 2>&1)
  if grep -qF "$expect" <<<"$out"; then
    echo "PASS  $name"; PASS=$((PASS+1))
  else
    echo "FAIL  $name"; echo "------ got:"; tail -5 <<<"$out"; echo "------"; FAIL=$((FAIL+1))
  fi
}

run "start+wait, exit code + marker" \
  'MUST actually call bg_run: command "sleep 2; echo E2E-MARKER-A". Then bg_wait (30s). Reply exactly: EXIT=<exit code from the tool result> MARKER=E2E-MARKER-A' \
  "EXIT=0 MARKER=E2E-MARKER-A"

run "failing exit code preserved" \
  'MUST actually call bg_run: command "exit 7". Then bg_wait (30s). Reply exactly: EXIT=<exit code from the tool result>.' \
  "EXIT=7"

run "timeout is not an error" \
  'MUST actually call bg_run: command "sleep 120", name sleeper. bg_wait sleeper 5s. Reply exactly: STATE=<still running|done>, ERR=<was the bg_wait result an error? yes|no>. Then bg_kill sleeper.' \
  "ERR=no"

run "kill clears the tree" \
  'MUST actually call bg_run: command "sleep 300 & sleep 300 & wait", name tree. Wait 3s via bash. bg_kill tree. Wait 2s via bash, then pgrep -fc "sleep 300". Reply exactly: SURVIVORS=<count>.' \
  "SURVIVORS=0"

run "idle start does not crash" \
  'MUST actually call bg_run: command "sleep 12", name idleprobe. Immediately reply exactly: STARTED-AND-IDLE (do not wait).' \
  "STARTED-AND-IDLE"

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
