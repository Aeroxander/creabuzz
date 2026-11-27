#!/usr/bin/env bash
#
# scripts/test-mvp-gate.sh — proves the journey runner only touches what it started.
#
# The runner stops each journey's process group and nothing else, never kills by name or port, reports a port someone else
# holds as blocked instead of freeing it, and sends the anvil state of the journeys it runs to a directory of its own,
# which is all it deletes. This runs it against stand-in journeys that leak a child, hold a port, and make scratch state,
# beside bystanders that must survive: a process, a server on a port a journey names, and state that another actor creates
# while the run is in progress. It also checks the pilot and later sets, that a journey script in no set and with no reason
# is warned about (and that every journey script in scripts/ has a home).
#
# Everything here is a stand-in the test started itself, and only those PIDs are ever stopped. No chain, browser or
# database needed.
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
: >"$ANVIL_READY_FILE"
exec sleep 3000
FAKE
chmod +x "$WORK/fakebin/anvil"
cat >"$WORK/journeys/leaky.sh" <<'JOURNEY'
#!/usr/bin/env bash
# Starts a chain that outlives it, and, while it runs, another actor makes its own anvil state elsewhere.
rm -f "$ANVIL_READY_FILE"
anvil --port 1 &
chain_pid=$!
echo "$chain_pid" >"$LEAKED_PID_FILE"
for _ in $(seq 1 100); do
  [[ -f "$ANVIL_READY_FILE" ]] && break
  kill -0 "$chain_pid" 2>/dev/null || { echo 'Error: stand-in chain exited before readiness'; exit 1; }
  sleep 0.1
done
[[ -f "$ANVIL_READY_FILE" ]] || { echo 'Error: stand-in chain readiness timed out'; exit 1; }
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
  LEAKED_PID_FILE="$WORK/leaked.pid" ANVIL_CACHE_LOG="$WORK/cache-paths.txt" FOREIGN_STATE="$WORK/foreign-state" \
  ANVIL_READY_FILE="$WORK/anvil-ready"

# Bystanders that were there first: a process, and state that was already on disk.
sleep 3000 & BYSTANDER=$!; OWN_PIDS+=("$BYSTANDER")
mkdir -p "$FOREIGN_STATE/anvil-state-there-before"

echo "--- a journey that leaks a chain and the chain keeps state"
"$GATE" leaky >"$WORK/run1.out" 2>&1; status=$?
check "the run passes" $(yes_if [ $status -eq 0 ])
check "the stand-in chain actually reached readiness" $(yes_if [ -f "$ANVIL_READY_FILE" ])
# Stopped means not running: a killed process nobody has reaped yet (a zombie, as when this runs in a container whose first
# process does not reap its orphans) still answers `kill -0`, so its state is read too.
check "the chain the journey leaked is stopped" \
  $(yes_if bash -c 'pid="$(cat "$0")"; ! kill -0 "$pid" 2>/dev/null || [[ "$(ps -o stat= -p "$pid" 2>/dev/null)" == Z* ]]' "$LEAKED_PID_FILE")
check "an unrelated process is left running" $(yes_if alive "$BYSTANDER")
CACHE="$(head -1 "$ANVIL_CACHE_LOG" 2>/dev/null)"
check "the chain was told to keep its state in a directory of the run's own" $(yes_if [ -n "$CACHE" ])
check "that directory is not anvil's shared default" $(yes_if bash -c '[[ "$0" != "$HOME/.foundry/"* ]]' "$CACHE")
check "that directory is gone after the run" $(yes_if [ ! -e "$CACHE" ])
check "state another actor made during the run is untouched" $(yes_if [ -d "$FOREIGN_STATE/anvil-state-made-during-the-run" ])
check "state that was already there is untouched" $(yes_if [ -d "$FOREIGN_STATE/anvil-state-there-before" ])

# A free high loopback port for the blocked-journey checks.
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }

echo "--- a server already on a port a journey names is reported, never stopped"
# Only a server this test started is ever stopped. The port is one the kernel just said was free.
HELD_PORT="$(free_port)"
python3 -m http.server "$HELD_PORT" --bind 127.0.0.1 >/dev/null 2>&1 & SERVER=$!
OWN_PIDS+=("$SERVER")
for _ in $(seq 1 20); do lsof -ti "tcp:$HELD_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
HOLDER="$(lsof -ti "tcp:$HELD_PORT" -sTCP:LISTEN | head -1)"
if [[ "$HOLDER" != "$SERVER" ]]; then
  # The listener is not the process this test started (for example an interpreter wrapper): do not trust or stop it.
  echo "skip the listener on :$HELD_PORT is not the server this test started"
else
  printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/journeys/needs-port.sh"
  chmod +x "$WORK/journeys/needs-port.sh"
  JOURNEY_PORTS="needs-port:$HELD_PORT" "$GATE" needs-port leaky >"$WORK/run2.out" 2>&1; status=$?
  check "the journey is reported blocked and the run does not pass" $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -q "BLOCKED.* needs-port" "$1"' "$status" "$WORK/run2.out")
  check "the message says who holds the port" $(yes_if grep -q "port $HELD_PORT is held by $SERVER" "$WORK/run2.out")
  check "a journey that names no port still runs" $(yes_if grep -q "PASS.* leaky" "$WORK/run2.out")
  check "the server is still running" $(yes_if alive "$SERVER")
  "$GATE" needs-port >"$WORK/run2b.out" 2>&1
  check "a journey is blocked only by a port it names" $(yes_if grep -q "PASS.* needs-port" "$WORK/run2b.out")
fi
kill "$SERVER" 2>/dev/null

echo "--- the pilot set is the product's core, and the full run is the pilot set and then the later set"
mkdir -p "$WORK/list-logs"
PILOT_LIST="$(LOG_DIR="$WORK/list-logs" "$GATE" --pilot --list)"
for journey in app-real-loop-e2e pot-full-loop; do
  check "the pilot set includes $journey" $(yes_if grep -qx "$journey" <<<"$PILOT_LIST")
done
ALL_LIST="$(LOG_DIR="$WORK/list-logs" "$GATE" --list)"
check "the full run is the pilot set and then the later set" \
  $(yes_if [ "$ALL_LIST" == "$(printf '%s\n%s' "$PILOT_LIST" "$(LOG_DIR="$WORK/list-logs" "$GATE" --later --list)")" ])
missing=""
for journey in $ALL_LIST; do [[ -x "$REPO_ROOT/scripts/$journey.sh" ]] || missing+=" $journey"; done
check "every journey in the full run is a script here${missing:+ (missing:$missing)}" $(yes_if [ -z "$missing" ])
check "--list runs nothing" $(yes_if bash -c '[[ -z "$(ls -A "$0")" ]]' "$WORK/list-logs")

echo "--- a journey script in no set, with no reason, is reported; one with a home is not"
mkdir -p "$WORK/homes" "$WORK/homes-logs"
for name in app-real-loop-e2e pot-app-phone-e2e brand-new-e2e; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/homes/$name.sh"
  chmod +x "$WORK/homes/$name.sh"
done
JOURNEY_DIR="$WORK/homes" LOG_DIR="$WORK/homes-logs" "$GATE" --list >"$WORK/homes.out" 2>"$WORK/homes.err"
check "an unlisted journey script is named in a warning" \
  $(yes_if grep -q "WARNING.*brand-new-e2e.sh is in no gate set" "$WORK/homes.err")
check "the warning goes to standard error, so --list stays a plain list" \
  $(yes_if bash -c '! grep -q WARNING "$0"' "$WORK/homes.out")
check "journeys in a set, or outside one with a reason, are not warned about" \
  $(yes_if bash -c '[[ "$(grep -c WARNING "$0")" == 1 ]]' "$WORK/homes.err")
JOURNEY_DIR="$WORK/homes" LOG_DIR="$WORK/homes-logs" "$GATE" brand-new-e2e >"$WORK/homes-run.out" 2>&1; status=$?
check "the warning is given on a real run too, which still runs what it is asked to" \
  $(yes_if bash -c '[[ $0 -eq 0 ]] && grep -q "WARNING.*brand-new-e2e" "$1" && grep -q "PASS.* brand-new-e2e" "$1"' "$status" "$WORK/homes-run.out")
UNHOMED="$(cd "$REPO_ROOT" && env -u JOURNEY_DIR LOG_DIR="$WORK/list-logs" "$GATE" --list 2>&1 >/dev/null | grep WARNING | sed 's/\x1b\[[0-9;]*m//g')"
check "every journey script in scripts/ is in a set or has a reason${UNHOMED:+ ($UNHOMED)}" $(yes_if [ -z "$UNHOMED" ])

echo "--- a failing journey fails the run"
"$GATE" failing >"$WORK/run3.out" 2>&1; status=$?
check "a failing journey makes the run fail" $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -q "FAILED:  failing" "$1"' "$status" "$WORK/run3.out")

echo
if [[ $failures -eq 0 ]]; then echo "all checks passed"; else echo "$failures check(s) failed"; fi
[[ $failures -eq 0 ]]
