#!/usr/bin/env bash
#
# scripts/test-v5-local-fixture.sh — proves scripts/v5-local-fixture.sh runs and exits cleanly on any host.
#
# The fixture is the only runtime proof that the creation version fits the real EVM size limits, so it has to run
# anywhere, leave nothing behind, and stop when it is told to. This runs the real script (a verbatim copy placed in a
# scratch tree, so the stand-in CLI, web server, relay and node it needs for demo mode can sit beside it) against a
# real local anvil and checks that it:
#   - has no machine-specific path in any script under scripts/;
#   - runs to PASS with TMPDIR pointing at an empty directory it does not own, and leaves that directory empty;
#   - rejects a fixture summary that lacks an address, naming the missing key, and still cleans up;
#   - refuses a demo relay that is not on this machine, before anything is started or published;
#   - in demo mode, exits (130 for Ctrl-C, 143 for SIGTERM) instead of resuming its wait, and takes its chain AND its
#     web server down with it (the web server's own process, not just the subshell that started it).
#
# Needs anvil, cast, forge (with the pinned compiler already installed), jq, python3 and curl on PATH. Everything it
# starts is on 127.0.0.1 with anvil's public dev keys, and only processes this test started are ever stopped.
# Takes a few minutes: each full run compiles and deploys the contracts.
# Usage: scripts/test-v5-local-fixture.sh [section ...]   (sections: path remote addr full term int; none named: all)

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/v5-local-fixture.sh"
WORK="$(mktemp -d)"
failures=0
OWN_PIDS=() # only processes this test started itself
cleanup() {
  for pid in "${OWN_PIDS[@]:-}"; do
    [[ -n "$pid" ]] && { kill -9 "$pid"; wait "$pid"; } 2>/dev/null || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

SECTIONS=("$@")
want() { [[ ${#SECTIONS[@]} -eq 0 || " ${SECTIONS[*]} " == *" $1 "* ]]; }

check() { # check "what" <0 when it held>
  if [[ $2 -eq 0 ]]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); fi
}
# A zombie (exited, not yet reaped by a parent that is gone) is not running.
running() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
  [[ -n "$state" && "$state" != Z* ]]
}
gone() { [[ -n "${1:-}" ]] && ! running "$1"; }
tmp_has_files() { [[ -n "$(ls -A "$WORK/tmp")" ]]; }
yes_if() { if "$@"; then echo 0; else echo 1; fi; }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }
# wait_for <seconds> <command...>: poll until the command succeeds.
wait_for() {
  local limit=$(($1 * 10)); shift
  local _
  for _ in $(seq 1 "$limit"); do "$@" && return 0; sleep 0.1; done
  return 1
}
# Does the file hold the text (fixed string)?
has() { grep -qF -- "$2" "$1" 2>/dev/null; }

for tool in anvil cast forge jq python3 curl; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done

if want path; then
  echo "--- no machine-specific path in any script"
  HITS="$(grep -rnE '/private/var|/Users/' "$REPO_ROOT/scripts" --exclude="$(basename "${BASH_SOURCE[0]}")" || true)"
  [[ -n "$HITS" ]] && echo "$HITS"
  check "no /private/var or /Users/ path under scripts/" $(yes_if test -z "$HITS")
fi

# --- the scratch tree: the real script beside stand-ins for what only demo mode touches ------------------------------
FAKE="$WORK/root"
mkdir -p "$FAKE/scripts" "$FAKE/web/node_modules/.bin" "$FAKE/target/debug" "$WORK/bin" "$WORK/relay" "$WORK/shimbin"
cp "$SCRIPT" "$FAKE/scripts/v5-local-fixture.sh"
ln -s "$REPO_ROOT/contracts" "$FAKE/contracts"
: >"$FAKE/scripts/v5-demo-token-plan.mjs"
# The CLI: records that it was called and does nothing else.
cat >"$FAKE/target/debug/buzz" <<FAKE
#!/usr/bin/env bash
echo "\$*" >>"$WORK/buzz.calls"
FAKE
# node: only ever asked for the founder's public key (`-e`); the token-plan script is a no-op.
cat >"$WORK/bin/node" <<'FAKE'
#!/usr/bin/env bash
if [[ "$1" == "-e" ]]; then printf '%064d\n' 1; fi
exit 0
FAKE
# The web server: one process (like vite, which is a single node process) that holds the port it is given and writes its pid.
cat >"$FAKE/web/node_modules/.bin/vite" <<FAKE
#!/usr/bin/env bash
port=""
while [[ \$# -gt 0 ]]; do
  if [[ "\$1" == "--port" ]]; then port="\$2"; shift; fi
  shift
done
echo \$\$ >"$WORK/vite.pid"
exec python3 -m http.server "\$port" --bind 127.0.0.1 --directory "$WORK/relay"
FAKE
chmod +x "$FAKE/target/debug/buzz" "$WORK/bin/node" "$FAKE/web/node_modules/.bin/vite"
# The relay: answers /health on a loopback port.
echo ok >"$WORK/relay/health"
RELAY_PORT="$(free_port)"
python3 -m http.server "$RELAY_PORT" --bind 127.0.0.1 --directory "$WORK/relay" >/dev/null 2>&1 &
OWN_PIDS+=("$!")
wait_for 10 curl -sf -m 1 "http://127.0.0.1:$RELAY_PORT/health" >/dev/null || { echo "stand-in relay did not start" >&2; exit 1; }

FIXTURE="$FAKE/scripts/v5-local-fixture.sh"
# Run the fixture with a TMPDIR of its own and, for signals, the default SIGINT disposition (a background job of a
# non-interactive shell would otherwise start with SIGINT ignored, which no trap can undo).
launch() { # launch <log> [VAR=value ...]
  local log=$1; shift
  env TMPDIR="$WORK/tmp" PATH="$WORK/bin:$PATH" "$@" \
    python3 -c 'import os, signal, sys; signal.signal(signal.SIGINT, signal.SIG_DFL); os.execv(sys.argv[1], sys.argv[1:])' \
    "$FIXTURE" >"$log" 2>&1 &
  LAUNCHED=$!
  OWN_PIDS+=("$LAUNCHED")
}
fresh_tmp() { rm -rf "$WORK/tmp"; mkdir -p "$WORK/tmp"; }
tmp_empty() { ! tmp_has_files; }
up_or_dead() { has "$1" "Demo world is up" || ! running "$2"; }
anvil_pid_of() { sed -n 's/^anvil pid \([0-9]*\) on .*/\1/p' "$1" | head -1; }

if want remote; then
echo "--- a demo relay that is not on this machine is refused before anything starts"
for REMOTE in "http://relay.example.com:3030" "http://127.0.0.1@relay.example.com:3030" "http://127.0.0.1.relay.example.com:3030" "https://example.com"; do
  fresh_tmp; rm -f "$WORK/buzz.calls"
  env TMPDIR="$WORK/tmp" PATH="$WORK/bin:$PATH" V5_DEMO=1 V5_DEMO_RELAY="$REMOTE" "$FIXTURE" >"$WORK/remote.out" 2>&1; status=$?
  check "$REMOTE is refused with a message about this machine" \
    $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -qi "this machine" "$1"' "$status" "$WORK/remote.out")
  check "$REMOTE: nothing was published and no directory is left behind" \
    $(yes_if bash -c '[[ ! -e "$0" ]] && [[ -z "$(ls -A "$1")" ]]' "$WORK/buzz.calls" "$WORK/tmp")
done

fi

if want addr; then
echo "--- a summary without an address stops the run, naming the key"
# A forge that prints a summary missing every address but one. The anvil, cast and script under test are the real ones.
cat >"$WORK/shimbin/forge" <<'FAKE'
#!/usr/bin/env bash
echo 'FIXTURE_JSON {"kit":"0x1111111111111111111111111111111111111111"}'
FAKE
chmod +x "$WORK/shimbin/forge"
fresh_tmp
env TMPDIR="$WORK/tmp" PATH="$WORK/shimbin:$PATH" "$FIXTURE" >"$WORK/addr.out" 2>&1; status=$?
check "the run fails" $(yes_if test "$status" -ne 0)
check "the failure names the missing key (marketFactory)" $(yes_if grep -q "marketFactory" "$WORK/addr.out")
check "it stopped before reading any receipts" $(yes_if bash -c '! grep -q "receipts" "$0"' "$WORK/addr.out")
check "its run directory is gone after the failure" $(yes_if tmp_empty)
ANVIL="$(anvil_pid_of "$WORK/addr.out")"
check "its anvil is gone after the failure" $(yes_if gone "$ANVIL")

fi

if want full; then
echo "--- a full run on a host with its own TMPDIR"
fresh_tmp
launch "$WORK/full.out"
wait "$LAUNCHED"; status=$?
check "it runs to PASS and exits 0" $(yes_if bash -c '[[ $0 -eq 0 ]] && grep -q "^PASS:" "$1"' "$status" "$WORK/full.out")
check "it leaves nothing in TMPDIR" $(yes_if tmp_empty)
ANVIL="$(anvil_pid_of "$WORK/full.out")"
check "its anvil is gone" $(yes_if gone "$ANVIL")

fi

# demo_signal <signal name> <expected exit status>
demo_signal() {
  local sig=$1 want=$2 vport out="$WORK/demo-$1.out" pid anvil vite
  vport="$(free_port)"
  fresh_tmp; rm -f "$WORK/buzz.calls" "$WORK/vite.pid"
  launch "$out" V5_DEMO=1 V5_DEMO_RELAY="http://127.0.0.1:$RELAY_PORT" V5_DEMO_WEB_PORT="$vport"
  pid=$LAUNCHED
  if ! wait_for 300 up_or_dead "$out" "$pid" || ! running "$pid"; then
    check "$sig: the demo world came up" 1
    tail -15 "$out"
    return
  fi
  check "$sig: the demo world came up" 0
  anvil="$(anvil_pid_of "$out")"; vite="$(cat "$WORK/vite.pid" 2>/dev/null)"
  OWN_PIDS+=("$anvil" "$vite")
  kill -s "$sig" "$pid"
  # The script must leave on the signal, not resume its wait.
  wait_for 15 gone "$pid"
  if running "$pid"; then
    check "$sig: the demo script exits" 1
  else
    wait "$pid"; local status=$?
    check "$sig: the demo script exits" 0
    check "$sig: it exits $want" $(yes_if test "$status" -eq "$want")
  fi
  check "$sig: the chain is down" $(yes_if gone "$anvil")
  check "$sig: the web server's own process is down (not just its subshell)" \
    $(yes_if gone "$vite")
  check "$sig: the web port is free again" $(yes_if bash -c '! curl -sf -m 1 "http://127.0.0.1:$0/" >/dev/null' "$vport")
  check "$sig: it leaves nothing in TMPDIR" $(yes_if tmp_empty)
  check "$sig: it had published the launch record before it was stopped" $(yes_if test -s "$WORK/buzz.calls")
}

if want term; then echo "--- demo mode stops on SIGTERM"; demo_signal TERM 143; fi
if want int; then echo "--- demo mode stops on Ctrl-C (SIGINT)"; demo_signal INT 130; fi

echo
if [[ $failures -eq 0 ]]; then echo "all checks passed"; else echo "$failures check(s) failed"; fi
[[ $failures -eq 0 ]]
