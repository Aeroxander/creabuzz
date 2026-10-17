#!/usr/bin/env bash
#
# scripts/test-mvp-gate.sh — proves the journey runner only touches what it started.
#
# The runner stops each journey's process group and nothing else, never kills by name or port, reports a port someone else
# holds as blocked instead of freeing it, and removes only the anvil scratch state this run made (none while another anvil
# is running). This runs it against stand-in journeys that leak a child, hold a port, and make scratch state, beside
# bystanders that must survive: a process, a server on :4173 and a state directory that were there before.
#
# No chain, browser or database needed. Usage: scripts/test-mvp-gate.sh

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
GATE="$REPO_ROOT/scripts/mvp-gate.sh"
failures=0
BYSTANDERS=()
cleanup() {
  for pid in "${BYSTANDERS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { # check "what" <exit status of the assertion>
  if [[ $2 -eq 0 ]]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); fi
}
alive() { kill -0 "$1" 2>/dev/null; }

mkdir -p "$WORK/journeys" "$WORK/anvil-tmp" "$WORK/logs"
# Stand-in journeys.
cat >"$WORK/journeys/leaky.sh" <<'JOURNEY'
#!/usr/bin/env bash
# Starts a chain-like child that outlives it, and makes scratch state.
sleep 3000 &
echo $! >"$LEAKED_PID_FILE"
mkdir -p "$ANVIL_TMP/anvil-state-made-by-this-run"
exit 0
JOURNEY
cat >"$WORK/journeys/failing.sh" <<'JOURNEY'
#!/usr/bin/env bash
echo "Error: stand-in failure"
exit 1
JOURNEY
chmod +x "$WORK/journeys/"*.sh

export JOURNEY_DIR="$WORK/journeys" ANVIL_TMP="$WORK/anvil-tmp" LOG_DIR="$WORK/logs" LEAKED_PID_FILE="$WORK/leaked.pid"

# Bystanders that were there first: a process, and scratch state of someone else's.
sleep 3000 & BYSTANDER=$!; BYSTANDERS+=("$BYSTANDER")
mkdir -p "$ANVIL_TMP/anvil-state-someone-elses"

echo "--- a journey that leaks a child and makes scratch state"
"$GATE" leaky >"$WORK/run1.out" 2>&1; status=$?
check "the run passes" $([[ $status -eq 0 ]] && echo 0 || echo 1)
check "the child the journey leaked is stopped" $(alive "$(cat "$LEAKED_PID_FILE")" && echo 1 || echo 0)
check "an unrelated process is left running" $(alive "$BYSTANDER" && echo 0 || echo 1)
check "scratch state made during the run is removed" $([[ ! -d "$ANVIL_TMP/anvil-state-made-by-this-run" ]] && echo 0 || echo 1)
check "scratch state that was already there is kept" $([[ -d "$ANVIL_TMP/anvil-state-someone-elses" ]] && echo 0 || echo 1)

echo "--- a server already on :4173 is reported, never stopped"
python3 -m http.server 4173 --bind 127.0.0.1 >/dev/null 2>&1 & BYSTANDERS+=("$!")
for _ in $(seq 1 20); do lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
SERVER="$(lsof -ti tcp:4173 -sTCP:LISTEN | head -1)"
BYSTANDERS+=("$SERVER")
"$GATE" leaky >"$WORK/run2.out" 2>&1; status=$?
check "the journey is reported blocked and the run does not pass" $([[ $status -ne 0 ]] && grep -q "BLOCKED" "$WORK/run2.out" && echo 0 || echo 1)
check "the message says who holds the port" $(grep -q "port 4173 is held by $SERVER" "$WORK/run2.out" && echo 0 || echo 1)
check "the server on :4173 is still running" $(alive "$SERVER" && echo 0 || echo 1)
kill "$SERVER" 2>/dev/null; sleep 1
for _ in $(seq 1 20); do lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done

echo "--- scratch state is left alone while an anvil this run did not start is running"
if command -v anvil >/dev/null 2>&1; then
  anvil --port 18997 --silent >/dev/null 2>&1 & ANVIL=$!; BYSTANDERS+=("$ANVIL")
  sleep 2
  "$GATE" leaky >"$WORK/run3.out" 2>&1
  check "state made during the run is kept, and the run says why" $([[ -d "$ANVIL_TMP/anvil-state-made-by-this-run" ]] && grep -q "left anvil scratch state in place" "$WORK/run3.out" && echo 0 || echo 1)
  check "the other anvil is still running" $(alive "$ANVIL" && echo 0 || echo 1)
else
  echo "skip anvil not installed"
fi

echo "--- a failing journey fails the run"
"$GATE" failing >"$WORK/run4.out" 2>&1; status=$?
check "a failing journey makes the run fail" $([[ $status -ne 0 ]] && grep -q "FAILED:  failing" "$WORK/run4.out" && echo 0 || echo 1)

echo
if [[ $failures -eq 0 ]]; then echo "all checks passed"; else echo "$failures check(s) failed"; fi
[[ $failures -eq 0 ]]
