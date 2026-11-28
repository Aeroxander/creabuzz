#!/usr/bin/env bash
# The phone path on a local chain, with no outside service: start a throwaway anvil (chain 31337, a free port), then run
# app/tests/anvil/passkey-*.test.ts with vitest in Node. EntryPoint v0.7 is deployed at its canonical address, the deployed
# Kernel 0.3.3 stack is set at its own addresses from fixtures (public Sepolia runtime code, read once), a paymaster pays the
# fees, and a stand-in bundler and sponsor sit in front of the chain. A software passkey signs each operation in the
# production way. Prints one PASS line per claim proven, then a count. Cleans up after itself whatever happens.
#
# Claims by file: passkey-sender (the sender and the stand-in bundler and sponsor), passkey-back (a real Back from a passkey account),
# passkey-team (the founder's and the team's presses on the real contracts: launch, check in, draw, grant
# Team Shares, each one operation and one prompt), passkey-address (the account address worked out
# on the phone equals the real factory's, and a node that lies about it is refused), sender-contract (wallet
# and passkey senders meet one set of expectations).
#
# What this cannot prove (it needs an operator's real bundler and sponsor, and real devices): see
# docs/next-version/PHONE-PATH-REPORT.md, "What is not proven".
#
# Needs: anvil on PATH (or ANVIL=/path/to/anvil), node and pnpm, contracts/pot/out built (the test dollar the sender tests send,
# and the pot contracts the Back test runs on).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANVIL="${ANVIL:-anvil}"

fail() { echo "phone-loop: $*" >&2; exit 1; }
command -v "$ANVIL" >/dev/null 2>&1 || fail "anvil not found (set ANVIL)"
[[ -f "$ROOT/contracts/pot/out/QuoteToken.sol/QuoteToken.json" ]] || fail "contracts/pot/out is not built"
[[ -f "$ROOT/contracts/pot/out/Launcher.sol/Launcher.json" ]] || fail "contracts/pot/out is not built"

free_port() { node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})'; }

STATE="$(mktemp -d)"
ANVIL_PID=""
cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$STATE"
}
trap cleanup EXIT

PORT="$(free_port)"
RPC="http://127.0.0.1:$PORT"
# No history kept and nothing written outside $STATE.
"$ANVIL" --port "$PORT" --chain-id 31337 --gas-limit 100000000 --prune-history --cache-path "$STATE/anvil-cache" \
  --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

export PHONE_LOOP_REPORT="$STATE/pass.txt"
: >"$PHONE_LOOP_REPORT"
cd "$ROOT/app"
status=0
M7_ANVIL_RPC="$RPC" pnpm exec vitest run --config vitest.anvil.config.ts tests/anvil/passkey-sender.test.ts tests/anvil/passkey-back.test.ts tests/anvil/passkey-team.test.ts tests/anvil/passkey-address.test.ts tests/anvil/sender-contract.test.ts "$@" || status=$?
echo
cat "$PHONE_LOOP_REPORT"
echo "phone-loop: $(grep -c '^PASS' "$PHONE_LOOP_REPORT") claims proven"
exit "$status"
