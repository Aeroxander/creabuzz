#!/usr/bin/env bash
#
# scripts/test-mvp-gate.sh — proves the journey runner only touches what it started.
#
# The runner stops each journey's process group and nothing else, never kills by name or port, reports a port someone else
# holds as blocked instead of freeing it, and sends the anvil state of the journeys it runs to a directory of its own,
# which is all it deletes. This runs it against stand-in journeys that leak a child, hold a port, and make scratch state,
# beside bystanders that must survive: a process, a server on :4173, and state that another actor creates while the run is
# in progress.
#
# Everything here is a stand-in the test started itself, and only those PIDs are ever stopped: if :4173 is already held by
# something else, that part is skipped rather than risked. No chain, browser or database needed.
# Usage: scripts/test-mvp-gate.sh

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
GATE="$REPO_ROOT/scripts/mvp-gate.sh"
failures=0
OWN_PIDS=() # only processes this test started itself
cleanup() {
  for pid in "${OWN_PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { # check "what" <0 when it held>
  if [[ $2 -eq 0 ]]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); fi
}
alive() { kill -0 "$1" 2>/dev/null; }
yes_if() { if "$@"; then echo 0; else echo 1; fi; }

mkdir -p "$WORK/journeys" "$WORK/fakebin" "$WORK/foreign-state" "$WORK/logs"
# A stand-in anvil: records where it was told to keep its state, and keeps some there.
cat >"$WORK/fakebin/anvil" <<'FAKE'
#!/usr/bin/env bash
cache=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--cache-path" ]]; then cache="$2"; shift; fi
  shift
done
echo "$cache" >>"$ANVIL_CACHE_LOG"
[[ -n "$cache" ]] && mkdir -p "$cache/anvil-state-fake" && echo x >"$cache/anvil-state-fake/0x1.json"
exec sleep 3000
FAKE
chmod +x "$WORK/fakebin/anvil"
cat >"$WORK/journeys/leaky.sh" <<'JOURNEY'
#!/usr/bin/env bash
# Starts a chain that outlives it, and, while it runs, another actor makes its own anvil state elsewhere.
anvil --port 1 &
echo $! >"$LEAKED_PID_FILE"
sleep 1
mkdir -p "$FOREIGN_STATE/anvil-state-made-during-the-run"
exit 0
JOURNEY
cat >"$WORK/journeys/failing.sh" <<'JOURNEY'
#!/usr/bin/env bash
echo "Error: stand-in failure"
exit 1
JOURNEY
chmod +x "$WORK/journeys/"*.sh

export JOURNEY_DIR="$WORK/journeys" LOG_DIR="$WORK/logs" FOUNDRY_BIN="$WORK/fakebin" \
  LEAKED_PID_FILE="$WORK/leaked.pid" ANVIL_CACHE_LOG="$WORK/cache-paths.txt" FOREIGN_STATE="$WORK/foreign-state"

# Bystanders that were there first: a process, and state that was already on disk.
sleep 3000 & BYSTANDER=$!; OWN_PIDS+=("$BYSTANDER")
mkdir -p "$FOREIGN_STATE/anvil-state-there-before"

echo "--- a journey that leaks a chain and the chain keeps state"
"$GATE" leaky >"$WORK/run1.out" 2>&1; status=$?
check "the run passes" $(yes_if [ $status -eq 0 ])
check "the chain the journey leaked is stopped" $(yes_if bash -c '! kill -0 "$(cat "$0")" 2>/dev/null' "$LEAKED_PID_FILE")
check "an unrelated process is left running" $(yes_if alive "$BYSTANDER")
CACHE="$(head -1 "$ANVIL_CACHE_LOG" 2>/dev/null)"
check "the chain was told to keep its state in a directory of the run's own" $(yes_if [ -n "$CACHE" ])
check "that directory is not anvil's shared default" $(yes_if bash -c '[[ "$0" != "$HOME/.foundry/"* ]]' "$CACHE")
check "that directory is gone after the run" $(yes_if [ ! -e "$CACHE" ])
check "state another actor made during the run is untouched" $(yes_if [ -d "$FOREIGN_STATE/anvil-state-made-during-the-run" ])
check "state that was already there is untouched" $(yes_if [ -d "$FOREIGN_STATE/anvil-state-there-before" ])

echo "--- a server already on :4173 is reported, never stopped"
# Only a server this test started is ever stopped. If something else holds the port, skip rather than risk it.
if lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "skip port 4173 is already in use by something this test did not start"
else
  python3 -m http.server 4173 --bind 127.0.0.1 >/dev/null 2>&1 & SERVER=$!
  OWN_PIDS+=("$SERVER")
  for _ in $(seq 1 20); do lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
  HOLDER="$(lsof -ti tcp:4173 -sTCP:LISTEN | head -1)"
  if [[ "$HOLDER" != "$SERVER" ]]; then
    # The listener is not the process this test started (for example an interpreter wrapper): do not trust or stop it.
    echo "skip the listener on :4173 is not the server this test started"
  else
    "$GATE" leaky >"$WORK/run2.out" 2>&1; status=$?
    check "the journey is reported blocked and the run does not pass" $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -q BLOCKED "$1"' "$status" "$WORK/run2.out")
    check "the message says who holds the port" $(yes_if grep -q "port 4173 is held by $SERVER" "$WORK/run2.out")
    check "the server on :4173 is still running" $(yes_if alive "$SERVER")
  fi
  kill "$SERVER" 2>/dev/null
  for _ in $(seq 1 20); do lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
fi

echo "--- a failing journey fails the run"
"$GATE" failing >"$WORK/run3.out" 2>&1; status=$?
check "a failing journey makes the run fail" $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -q "FAILED:  failing" "$1"' "$status" "$WORK/run3.out")

echo
if [[ $failures -eq 0 ]]; then echo "all checks passed"; else echo "$failures check(s) failed"; fi
[[ $failures -eq 0 ]]
