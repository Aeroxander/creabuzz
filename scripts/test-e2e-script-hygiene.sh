#!/usr/bin/env bash
#
# scripts/test-e2e-script-hygiene.sh — proves the two trading journeys (scripts/web-trading-e2e.sh and
# scripts/secondary-keeper-e2e.sh) keep their own chain, their own build and nothing else.
#
# It runs the real scripts (verbatim copies in a scratch tree, with a stand-in web build tool and browser runner beside
# them, so no browser is needed) against real local anvil chains and checks that:
#   - a web build that fails shows its own error, and the build sees only the variables the script names (never the
#     caller's VITE_ settings);
#   - SKIP_BUILD=1 reuses a build only when it was made for this chain and market factory: a build with no record, or
#     one made for another factory, is refused before the browser spec runs;
#   - when another chain already holds the port a journey was told to use, the journey stops at once and the other chain
#     is left as it was (no deploy onto it, no clock warp on it).
#
#   - the local chain's port probe refuses a live listener, accepts a port with only a closed connection lingering
#     (TIME_WAIT), and names a non-numeric ANVIL_PORT as a bad number rather than a busy port.
#
# Needs anvil, cast, forge (with the pinned compiler already installed), node, python3, lsof and timeout (or gtimeout from
# coreutils) on PATH, or in $FOUNDRY_BIN.
# Everything it starts is on 127.0.0.1 with anvil's public dev keys, and only processes this test started are stopped.
# Takes a few minutes: each journey run deploys the contracts. Skips the parts that need :4173 when something holds it.
# Usage: scripts/test-e2e-script-hygiene.sh

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
for tool in anvil cast forge node python3 lsof; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool (set FOUNDRY_BIN for foundry)"; exit 2; }
done
# Stock macOS has no timeout: without one every journey run would exit 127 and the "fails" checks would pass vacuously.
BOUNDED="$(command -v timeout || command -v gtimeout || true)"
[[ -n "$BOUNDED" ]] || { echo "missing tool: timeout or gtimeout (install coreutils)"; exit 2; }
WORK="$(mktemp -d)"
failures=0
OWN_PIDS=() # only processes this test started itself
cleanup() {
  for pid in "${OWN_PIDS[@]:-}"; do
    [[ -n "$pid" ]] && { kill "$pid"; wait "$pid"; } 2>/dev/null || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check() { # check "what" <0 when it held>
  if [[ $2 -eq 0 ]]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); fi
}
yes_if() { if "$@"; then echo 0; else echo 1; fi; }
# A run that failed on its own terms: not a timeout (124) and not a missing command (127).
ran_and_failed() { [[ $1 -ne 0 && $1 -ne 124 && $1 -ne 127 ]]; }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }

if lsof -ti tcp:4173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "skip port 4173 is held by something this test did not start (web-trading-e2e.sh would refuse to run)"
  exit 0
fi

# ---- the scratch tree: the real scripts, the real contracts, a stand-in build tool and browser runner ----------------
TREE="$WORK/tree"
mkdir -p "$TREE/scripts" "$TREE/web/node_modules/.bin"
cp "$REPO_ROOT/scripts/web-trading-e2e.sh" "$REPO_ROOT/scripts/secondary-keeper-e2e.sh" \
  "$REPO_ROOT/scripts/secondary-keeper.sh" "$TREE/scripts/"
[[ -d "$REPO_ROOT/scripts/lib" ]] && cp -R "$REPO_ROOT/scripts/lib" "$TREE/scripts/lib"
ln -s "$REPO_ROOT/contracts" "$TREE/contracts"
VITE_MODE="$WORK/vite-mode"; VITE_ENV="$WORK/vite-env.txt"; PW_LOG="$WORK/playwright.log"
cat >"$TREE/web/node_modules/.bin/vite" <<VITE
#!/usr/bin/env bash
env >"$VITE_ENV"
if [[ "\$(cat "$VITE_MODE")" == "fail" ]]; then
  echo "BOOM-vite-error: cannot resolve the entry" >&2
  exit 1
fi
mkdir -p dist && echo built >dist/index.html
VITE
cat >"$TREE/web/node_modules/.bin/playwright" <<PW
#!/usr/bin/env bash
echo "playwright ran" >>"$PW_LOG"
PW
chmod +x "$TREE/web/node_modules/.bin/"*

MARKER="$TREE/web/dist/.web-trading-e2e-build"
TRADING="$TREE/scripts/web-trading-e2e.sh"
KEEPER="$TREE/scripts/secondary-keeper-e2e.sh"
# The caller's shell: settings that must never reach the build.
AMBIENT=(VITE_CONTRIBUTOR_ONLY=1 VITE_LOCAL_USDC=0x00000000000000000000000000000000000dEaD0 VITE_RELAY_URL=http://ambient.invalid)

echo "--- a web build that fails shows why, and it sees only what the script names"
echo fail >"$VITE_MODE"
rm -f "$VITE_ENV"
"$BOUNDED" 400 env "${AMBIENT[@]}" "$TRADING" >"$WORK/build-fail.out" 2>&1; status=$?
check "the run fails" $(yes_if ran_and_failed $status)
check "the build's own error is shown" $(yes_if grep -q "BOOM-vite-error" "$WORK/build-fail.out")
check "the run still says the web build failed" $(yes_if grep -q "web build failed" "$WORK/build-fail.out")
check "the build ran" $(yes_if [ -f "$VITE_ENV" ])
for name in VITE_CONTRIBUTOR_ONLY VITE_LOCAL_USDC VITE_RELAY_URL; do
  check "the build does not see the caller's $name" $(yes_if bash -c '! grep -q "^$0=" "$1"' "$name" "$VITE_ENV")
done
check "the build is told the chain" $(yes_if grep -qx "VITE_LAUNCHPAD_CHAIN_ID=31337" "$VITE_ENV")
check "the build is told the market factory" $(yes_if grep -q '^VITE_SECONDARY_MARKET_FACTORY={"31337":"0x[0-9a-fA-F]\{40\}"}$' "$VITE_ENV")

echo "--- a build that works is recorded, and SKIP_BUILD=1 reuses it only when the record matches"
echo ok >"$VITE_MODE"
rm -rf "$TREE/web/dist" "$PW_LOG"; rm -f "$VITE_ENV"
"$BOUNDED" 400 env "${AMBIENT[@]}" "$TRADING" >"$WORK/build-ok.out" 2>&1; status=$?
check "a working build passes through to the browser spec" $(yes_if bash -c '[[ $0 -eq 0 ]] && [[ -f "$1" ]]' "$status" "$PW_LOG")
check "the build is recorded with its chain and market factory" \
  $(yes_if bash -c 'grep -q 31337 "$0" && grep -q "0x[0-9a-fA-F]\{40\}" "$0"' "$MARKER")

rm -f "$VITE_ENV" "$PW_LOG"
SKIP_BUILD=1 "$BOUNDED" 400 "$TRADING" >"$WORK/skip-ok.out" 2>&1; status=$?
check "SKIP_BUILD=1 reuses a build made for this chain and factory" \
  $(yes_if bash -c '[[ $0 -eq 0 ]] && [[ -f "$1" ]] && [[ ! -e "$2" ]]' "$status" "$PW_LOG" "$VITE_ENV")

sed -i.bak 's/0x[0-9a-fA-F]\{40\}/0x0000000000000000000000000000000000000001/' "$MARKER"
rm -f "$VITE_ENV" "$PW_LOG"
SKIP_BUILD=1 "$BOUNDED" 400 "$TRADING" >"$WORK/skip-stale.out" 2>&1; status=$?
check "SKIP_BUILD=1 refuses a build made for another market factory" $(yes_if ran_and_failed $status)
check "and says which build is stale" $(yes_if grep -qi "stale\|does not match" "$WORK/skip-stale.out")
check "and does not run the browser spec" $(yes_if [ ! -e "$PW_LOG" ])

rm -f "$MARKER" "$PW_LOG"
SKIP_BUILD=1 "$BOUNDED" 400 "$TRADING" >"$WORK/skip-none.out" 2>&1; status=$?
check "SKIP_BUILD=1 refuses a build with no record" $(yes_if bash -c '[[ $0 -ne 0 && $0 -ne 124 && $0 -ne 127 ]] && [[ ! -e "$1" ]]' "$status" "$PW_LOG")

echo "--- a chain that already holds the port is left alone"
NEIGHBOUR_PORT="$(free_port)"
anvil --host 127.0.0.1 --port "$NEIGHBOUR_PORT" --chain-id 31337 --silent >"$WORK/neighbour.log" 2>&1 &
OWN_PIDS+=("$!")
NEIGHBOUR="ws://127.0.0.1:${NEIGHBOUR_PORT}"
for _ in $(seq 1 100); do cast chain-id --rpc-url "$NEIGHBOUR" >/dev/null 2>&1 && break; sleep 0.2; done
snapshot() { printf '%s %s' "$(cast block-number --rpc-url "$NEIGHBOUR")" "$(cast block latest --field timestamp --rpc-url "$NEIGHBOUR")"; }
BEFORE="$(snapshot)"
check "the neighbouring chain is up" $(yes_if [ -n "${BEFORE% *}" ])
for pair in "web-trading-e2e:$TRADING" "secondary-keeper-e2e:$KEEPER"; do
  name="${pair%%:*}"; script="${pair#*:}"
  rm -f "$PW_LOG"
  ANVIL_PORT="$NEIGHBOUR_PORT" SKIP_BUILD=1 "$BOUNDED" 400 "$script" >"$WORK/$name-neighbour.out" 2>&1; status=$?
  check "$name stops when its port is taken" $(yes_if ran_and_failed $status)
  check "$name says the port is in use" $(yes_if grep -qi "in use\|already" "$WORK/$name-neighbour.out")
  check "$name leaves the neighbouring chain's blocks and clock as they were" $(yes_if [ "$(snapshot)" == "$BEFORE" ])
done

echo "--- the local chain's port probe: a live listener refuses, a lingering closed connection does not, junk is named"
# Runs the real start_local_anvil from scripts/lib/local-anvil.sh in a subshell; prints its output, leaves the pid in $2.
probe_start() { # probe_start <port value> <pid file>
  (
    fail() { printf 'FAIL: %s\n' "$*"; exit 1; }
    # shellcheck source=scripts/lib/local-anvil.sh
    . "$REPO_ROOT/scripts/lib/local-anvil.sh"
    start_local_anvil "$1" "$WORK/probe-anvil.log" && echo "$ANVIL_PID" >"$2"
  )
}
PROBE_PID="$WORK/probe.pid"

LIVE_PORT="$(free_port)"
python3 -c 'import socket, sys, time; s=socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(); time.sleep(120)' "$LIVE_PORT" &
LIVE_PID=$!; OWN_PIDS+=("$LIVE_PID")
for _ in $(seq 1 50); do lsof -ti "tcp:${LIVE_PORT}" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.1; done
rm -f "$PROBE_PID"
probe_start "$LIVE_PORT" "$PROBE_PID" >"$WORK/probe-live.out" 2>&1; status=$?
check "a live listener on the port is refused" $(yes_if bash -c '[[ $0 -eq 1 ]] && [[ ! -e "$1" ]]' "$status" "$PROBE_PID")
check "and the refusal says the port is in use" $(yes_if grep -qi "in use" "$WORK/probe-live.out")

# The server side closes first, so the port is left in TIME_WAIT with no process behind it. anvil binds with
# SO_REUSEADDR and starts fine, so the probe must not call that port taken.
WAIT_PORT="$(free_port)"
python3 - "$WAIT_PORT" <<'PY'
import socket, sys
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", int(sys.argv[1])))
srv.listen()
cli = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
conn, _ = srv.accept()
conn.close()  # active close on the server side: TIME_WAIT lands on the server's local port
cli.recv(1)
cli.close()
srv.close()
PY
rm -f "$PROBE_PID"
probe_start "$WAIT_PORT" "$PROBE_PID" >"$WORK/probe-wait.out" 2>&1; status=$?
if [[ -s "$PROBE_PID" ]]; then OWN_PIDS+=("$(cat "$PROBE_PID")"); fi
check "a port that only has a closed connection lingering is not refused" $(yes_if bash -c '[[ $0 -eq 0 ]] && [[ -s "$1" ]]' "$status" "$PROBE_PID")
[[ -s "$PROBE_PID" ]] && { kill "$(cat "$PROBE_PID")"; wait "$(cat "$PROBE_PID")"; } 2>/dev/null

for junk in abc "" 0 65536 "18545x"; do
  rm -f "$PROBE_PID"
  probe_start "$junk" "$PROBE_PID" >"$WORK/probe-junk.out" 2>&1; status=$?
  check "ANVIL_PORT='${junk}' is refused before anything starts" $(yes_if bash -c '[[ $0 -eq 1 ]] && [[ ! -e "$1" ]]' "$status" "$PROBE_PID")
  check "and is named as a bad number, not as a port in use" \
    $(yes_if bash -c 'grep -q "must be a number from 1 to 65535" "$0" && ! grep -qi "in use" "$0"' "$WORK/probe-junk.out")
done

echo
if [[ $failures -eq 0 ]]; then echo "all checks passed"; else echo "$failures check(s) failed"; fi
[[ $failures -eq 0 ]]
