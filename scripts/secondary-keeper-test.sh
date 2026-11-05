#!/usr/bin/env bash
#
# scripts/secondary-keeper-test.sh — exercises the REAL scripts/secondary-keeper.sh against a stubbed node.
#
# No chain, no network. A fake `cast`, `date` and `sleep` stand in for the node and the clock, so the keeper's real
# retry, back-off and give-up code runs through days of passes in a second. (The real-chain life of a round is
# scripts/secondary-keeper-e2e.sh; this file covers the failure paths a healthy chain never shows.)
#   1. openRound keeps being retried after many failed sends, and goes out once the wallet is refilled;
#   2. settle still gives up at KEEPER_MAX_ATTEMPTS, and says the round is then void;
#   3. a settle that lost the race (AlreadySettled / SettleOver) and an early openRound (TooSoon) are a quiet skip,
#      not an ERROR and not a failed attempt;
#   4. any other estimate failure is still a loud ERROR.
# Usage:  scripts/secondary-keeper-test.sh        (foundry's `cast` on PATH or in ~/.foundry/bin, only for `cast sig`)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEPER="$REPO_ROOT/scripts/secondary-keeper.sh"
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
REAL_CAST="$(command -v cast)" || { echo "missing tool: cast (set FOUNDRY_BIN for foundry)"; exit 2; }
export REAL_CAST

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
STATE="$WORK/state"
mkdir -p "$BIN" "$STATE"
export STATE

# A fake node. Reads: the market is a given state (files in $STATE). Estimates and sends fail with the text in
# $STATE/est_<open|settle> and $STATE/send_<open|settle> while that file exists. A sent openRound moves lastOpenAt.
cat >"$BIN/cast" <<'STUB'
#!/usr/bin/env bash
cmd="$1"; shift
clock() { cat "$STATE/clock"; }
case "$cmd" in
  sig) exec "$REAL_CAST" sig "$@" ;;
  wallet) echo 0x976EA74026E726554dB657fA54763abd0C3a0aa9 ;;
  block) clock ;;
  call)
    case "$2" in
      "roundCount()(uint256)") cat "$STATE/roundCount" ;;
      rounds*) cat "$STATE/round" ;;
      "listing()(bool,uint128,uint128,uint32)") printf 'true\n0\n0\n0\n' ;;
      "lastOpenAt()(uint256)") cat "$STATE/lastOpenAt" ;;
    esac ;;
  estimate|send)
    sig="$2"; kind=settle; [[ "$sig" == "openRound()" ]] && kind=open
    if [[ -e "$STATE/${cmd/estimate/est}_$kind" ]]; then cat "$STATE/${cmd/estimate/est}_$kind" >&2; exit 1; fi
    if [[ "$cmd" == "send" ]]; then
      echo "$kind" >>"$STATE/sent.log"
      [[ "$kind" == "open" ]] && clock >"$STATE/lastOpenAt"
    else
      echo 100000
    fi ;;
esac
STUB
cat >"$BIN/date" <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == "+%s" ]]; then cat "$STATE/clock"; else echo 2030-01-01T00:00:00Z; fi
STUB
# A sleep that advances the fake clock, runs the scenario's refill at the right pass, and stops the keeper after N passes.
cat >"$BIN/sleep" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$STATE/sleeps" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$STATE/sleeps"
echo $(( $(cat "$STATE/clock") + STEP )) >"$STATE/clock"
[[ -n "${REFILL_AT:-}" && "$n" == "$REFILL_AT" ]] && rm -f "$STATE"/est_* "$STATE"/send_*
((n >= PASSES)) && exit 1
exit 0
STUB
chmod +x "$BIN"/*

# run <passes> <step seconds> [VAR=value ...]: loops the real keeper that many passes, output in $OUT.
run() {
  local passes="$1" step="$2"
  shift 2
  echo 1000000 >"$STATE/clock"
  rm -f "$STATE/sleeps" "$STATE/sent.log"
  OUT="$(env "$@" FOUNDRY_BIN="$BIN" STATE="$STATE" PASSES="$passes" STEP="$step" RPC_URL=stub \
    MARKET=0x00000000000000000000000000000000000000aa KEEPER_PRIVATE_KEY=0x01 KEEPER_INTERVAL=30 \
    bash "$KEEPER" 2>&1 || true)"
}
sent() { cat "$STATE/sent.log" 2>/dev/null || true; }
errors() { printf '%s\n' "$OUT" | grep -c 'ERROR' || true; }
fails=0
check() { # check <name> <condition exit status>
  if [[ "$2" == 0 ]]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}
reset() {
  rm -f "$STATE"/est_* "$STATE"/send_*
  echo 0 >"$STATE/roundCount"
  echo 0 >"$STATE/lastOpenAt"
  # rounds(): 11 words; closed (5th) at 1000000-10, settle deadline (6th) far ahead, not settled (10th)
  printf '0\n0\n0\n0\n999990\n9000000\n0\n0\n0\nfalse\nfalse\n' >"$STATE/round"
}
ALREADY=$("$REAL_CAST" sig 'AlreadySettled(uint256)')
OVER=$("$REAL_CAST" sig 'SettleOver(uint256)')
TOOSOON=$("$REAL_CAST" sig 'TooSoon(uint256)')
revert() { echo "Error: server returned an error response: error code 3: execution reverted: custom error $1: , data: \"$1\""; }

echo "-- openRound: failed sends never end the retries"
reset
echo "Error: insufficient funds for gas" >"$STATE/est_open"
run 14 3600 KEEPER_OPEN=1 KEEPER_MAX_ATTEMPTS=3 REFILL_AT=10
check "open: refilled wallet opens the round after more than KEEPER_MAX_ATTEMPTS failures" "$([[ "$(sent)" == open ]] && echo 0 || echo 1)"
check "open: no claim that the round goes void" "$(printf '%s' "$OUT" | grep -qi 'void' && echo 1 || echo 0)"
check "open: the failures were loud" "$([[ "$(errors)" -ge 3 ]] && echo 0 || echo 1)"

echo "-- settle: still bounded, and says why"
reset
echo 3 >"$STATE/roundCount"
echo "Error: insufficient funds for gas" >"$STATE/est_settle"
run 14 3600 KEEPER_MAX_ATTEMPTS=3 REFILL_AT=10
check "settle: gives up at the cap and says the round is void" "$(printf '%s' "$OUT" | grep -q 'giving up on settle(round 3).*void' && echo 0 || echo 1)"
check "settle: nothing is sent after giving up" "$([[ -z "$(sent)" ]] && echo 0 || echo 1)"

echo "-- benign skips are not failures"
reset
echo 3 >"$STATE/roundCount"
revert "$ALREADY" >"$STATE/est_settle"
run 6 3600 KEEPER_MAX_ATTEMPTS=3
check "settle: AlreadySettled is not an ERROR" "$([[ "$(errors)" == 0 ]] && echo 0 || echo 1)"
check "settle: AlreadySettled is not a give-up either" "$(printf '%s' "$OUT" | grep -q 'giving up' && echo 1 || echo 0)"
revert "$OVER" >"$STATE/est_settle"
run 6 3600 KEEPER_MAX_ATTEMPTS=3
check "settle: SettleOver is not an ERROR" "$([[ "$(errors)" == 0 ]] && echo 0 || echo 1)"
reset
revert "$TOOSOON" >"$STATE/est_open"
run 6 3600 KEEPER_OPEN=1 KEEPER_MAX_ATTEMPTS=3
check "open: TooSoon is not an ERROR" "$([[ "$(errors)" == 0 ]] && echo 0 || echo 1)"

echo "-- real failures stay loud"
reset
echo 3 >"$STATE/roundCount"
echo "Error: insufficient funds for gas" >"$STATE/est_settle"
run 3 3600 KEEPER_MAX_ATTEMPTS=24
check "settle: an out-of-gas estimate is an ERROR" "$([[ "$(errors)" -ge 1 ]] && echo 0 || echo 1)"
echo "Error: server returned an error response: error code 3: execution reverted: custom error 0xdeadbeef: " >"$STATE/est_settle"
run 3 3600 KEEPER_MAX_ATTEMPTS=24
check "settle: an unknown revert is an ERROR" "$([[ "$(errors)" -ge 1 ]] && echo 0 || echo 1)"
reset
revert "$ALREADY" >"$STATE/est_open"
run 3 3600 KEEPER_OPEN=1 KEEPER_MAX_ATTEMPTS=24
check "open: AlreadySettled is not a benign reason for openRound" "$([[ "$(errors)" -ge 1 ]] && echo 0 || echo 1)"

((fails == 0)) && echo "secondary-keeper-test: all passed" || { echo "secondary-keeper-test: $fails failed"; exit 1; }
