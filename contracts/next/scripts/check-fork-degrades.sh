#!/usr/bin/env bash
# Runs the Sepolia fork suites against nodes that cannot do what they ask and checks that they degrade: skip or move to a
# recent block with a message, never fail in setUp. Needs the public Sepolia node reachable (or set SEPOLIA_RPC_URL).
# Run from contracts/next after `forge build`. Prints one line per case and exits 1 if any case is wrong.
set -u
cd "$(dirname "$0")/.." || exit 2
GOOD_RPC=${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}
PIN=${SEPOLIA_PIN:-12146937}
bad=0
# run <name> <expect> <env assignments...>; expect: skipped (0 failed, 0 passed fork tests run), ran (0 failed, some passed)
run() {
  local name=$1 expect=$2; shift 2
  local out; out=$(env -u SEPOLIA_FORK_BLOCK -u SEPOLIA_FORK_TRUST_CACHE "$@" forge test --match-contract Fork --no-match-contract ForkPick ${FORGE_EXTRA:-} 2>&1)
  local line; line=$(echo "$out" | grep -E '^Ran [0-9]+ test suites' | tail -1)
  local failed; failed=$(echo "$line" | sed -E 's/.*: ([0-9]+) tests passed, ([0-9]+) failed, ([0-9]+) skipped.*/\2/')
  local passed; passed=$(echo "$line" | sed -E 's/.*: ([0-9]+) tests passed, ([0-9]+) failed, ([0-9]+) skipped.*/\1/')
  local skipped; skipped=$(echo "$line" | sed -E 's/.*: ([0-9]+) tests passed, ([0-9]+) failed, ([0-9]+) skipped.*/\3/')
  local ok=0
  [ "$failed" = 0 ] || ok=1
  if [ "$expect" = skipped ]; then [ "$skipped" -gt 0 ] || ok=1; else [ "$passed" -gt 0 ] || ok=1; fi
  [ $ok = 0 ] && echo "ok   $name: $passed passed, $failed failed, $skipped skipped" || { echo "FAIL $name (wanted $expect): $line"; bad=1; }
}
run "dead node"                    skipped SEPOLIA_RPC_URL=http://127.0.0.1:1
run "dead node, cache trusted"     skipped SEPOLIA_RPC_URL=http://127.0.0.1:1 SEPOLIA_FORK_TRUST_CACHE=true
run "named block too old"          skipped SEPOLIA_RPC_URL="$GOOD_RPC" SEPOLIA_FORK_BLOCK=12140000
run "pin unserved, none named"     ran     SEPOLIA_RPC_URL="$GOOD_RPC"
if [ -n "${CHECK_CACHED_PIN:-}" ]; then
  # The cache was filled before this test existed and the pin is no longer served, so its state reads at the pin
  # cannot be satisfied (measured: "Archive requests require a personal token"). Every other test repeats from the cache.
  FORGE_EXTRA="--no-match-test withoutAGuardAStrangersPlainPoolDoesNotFoolTheFinish" \
  run "pin from the local cache"   ran     SEPOLIA_RPC_URL="$GOOD_RPC" SEPOLIA_FORK_TRUST_CACHE=true SEPOLIA_FORK_BLOCK="$PIN"
fi
exit $bad
