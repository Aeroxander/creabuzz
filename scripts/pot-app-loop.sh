#!/usr/bin/env bash
# The app's own money calls against the real contracts on a local chain: start a throwaway anvil (chain 31337, a free
# port), then run the app's chain harness (app/tests/anvil) with vitest in Node. The harness deploys the pot contracts from
# contracts/pot/out (no compile) and drives them only through the app's own call builders, quote readers and senders:
#   pot-loop.test.ts      faucet, launch, Back in one signature and in two, the quote equals what landed, a second backer, Take out
#                         with its minimum-cash guard, the weekly check-in with a record hash, the door, the allowance (a draw,
#                         a raise that must wait), a Team grant claimed after the cliff (the chain's clock is moved), a
#                         member's own exit, outside money, and each refusal read in the app's own words;
#   pot-screens.test.ts   what the money screens read and send: the Back sheet, the Take out sheet, the allowance, a grant;
#   pot-allowance.test.ts an announced raise: the date the app reads is the date the Treasury's own RateProposed log announces
#                         (announced at + one time unit), applying before it is refused and after it works;
#   pot-team.test.ts      launching through the launch sheet's own reader, terms and call (the defaults, other numbers, the ceiling, a platform
#                         setting that changed between the sheet and the signature, the same project twice); a wind-down by anyone after a
#                         long quiet;
#   pot-task-reads.test.ts the seven task calls and the task reads (the shared library's S1): plan, withdraw, take early and in time,
#                         a take out that writes a note, pay in part, a claim a stranger sends for someone else, send back,
#                         run out and return, a plan nobody takes; with S1_CAPTURE_OUT=<file> it writes the raw answers;
#   pot-tasks.test.ts     what a holder's screens read of a task, through the app's own readers: a plan the team made and a worker took, a Take
#                         out that writes a note and the note finder, the Claim sheet's read and figure, a part payment and a claim that pays
#                         the holder and nobody else, and a task nobody settled that runs out and is returned by a stranger (the holder who
#                         left claims the whole);
#   pot-settled.test.ts   the settled money the browser specs' record builder (tests/e2e/helpers/live-settled.ts) works out, against what
#                         the Treasury itself stores after a settle at seven times: two settles inside an arriving stream at times
#                         where a formula that follows the last settle and the contract's give different roundings, a merged stream, after
#                         it ended, a task taken and not due, and the settle that puts the money of a task that ran out back;
#   pot-states.test.ts    Take out with the door shut, after the team stopped checking in, with outside money arriving, after a
#                         wind-down by anyone and by the runner;
#   held-since.test.ts    how long an account has held a project's Shares (the line under "You hold"), from its own Transfer logs: a
#                         Back starts it, more Shares coming in do not move it, a take-out to nothing and a send-out of everything
#                         reset it, an account that never held reads null;
#   passkey-back.test.ts  a Back from a passkey account: one operation, one passkey prompt, the Shares equal the quote.
# It prints one line with the count of tests passed, failed and skipped. Cleans up after itself (anvil stopped, its state removed).
#
# Needs: anvil on PATH (or ANVIL=/path/to/anvil), node and pnpm, and contracts/pot/out built (`forge build` there).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANVIL="${ANVIL:-anvil}"
OUT="$ROOT/contracts/pot/out"

fail() { echo "pot-app-loop: $*" >&2; exit 1; }
command -v "$ANVIL" >/dev/null 2>&1 || fail "anvil not found (set ANVIL)"
[[ -f "$OUT/Treasury.sol/Treasury.json" ]] || fail "contracts/pot/out is not built (run forge build in contracts/pot)"

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
# No history is kept and nothing is written outside $STATE (anvil's default writes every block's state under
# ~/.foundry/anvil/tmp and leaves it there when it is stopped).
"$ANVIL" --port "$PORT" --chain-id 31337 --gas-limit 100000000 --prune-history --cache-path "$STATE/anvil-cache" \
  --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

cd "$ROOT/app"
REPORT="$STATE/vitest.json"
status=0
M7_ANVIL_RPC="$RPC" pnpm exec vitest run --config vitest.anvil.config.ts \
  tests/anvil/pot-loop.test.ts tests/anvil/pot-screens.test.ts tests/anvil/pot-team.test.ts tests/anvil/pot-states.test.ts tests/anvil/pot-allowance.test.ts tests/anvil/pot-task-reads.test.ts tests/anvil/pot-tasks.test.ts tests/anvil/pot-settled.test.ts tests/anvil/held-since.test.ts tests/anvil/passkey-back.test.ts \
  --reporter=default --reporter=json --outputFile.json="$REPORT" "$@" || status=$?
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(`pot-app-loop: ${r.numPassedTests} tests passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped, in ${r.numTotalTestSuites > 0 ? r.testResults.length : 0} files`);
' "$REPORT" || true
exit "$status"
