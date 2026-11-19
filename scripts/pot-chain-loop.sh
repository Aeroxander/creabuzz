#!/usr/bin/env bash
# pot-chain-loop.sh: proves the whole join-and-leave loop against the real bytecode of contracts/pot on a local chain.
#
# It starts anvil, deploys PlayDollar, the part implementations and the Launcher with the deploy script (N = 7 days, the real
# value), then walks one project through everything a person does, with `cast` only, printing a numbered PASS line per check
# and exiting non-zero on the first failure:
#   a founder launches a project; a stranger takes play dollars from the faucet and backs the project in ONE transaction
#   (transferAndCall) for exactly the Shares the quote promised; the founder checks in; time passes and the allowance is
#   drawn, never more than the box; outside money is added and arrives over one time unit; a Team Share grant vests after
#   the 13-unit cliff and is claimed; the project goes quiet (door shuts, allowance stops); a vested Team Share takes out and
#   is paid only from the surplus above what backers paid in; the stranger takes out and is paid exactly what quoteTakeOut said.
# Step 2 (the task queue) is walked between the vesting and the quiet steps: a founder announces a 1% task for a worker, an early
#   take is refused, the notice runs out, the worker takes it (the money is set aside), a backer takes out and is written an exit
#   note exactly as quoteTakeOut said, the task is paid in part (the rest comes back at one ratio to the stayers and to the note),
#   the note is claimed by a stranger and pays its share; a second task is taken, nobody accepts it, anyone returns it after its
#   deadline, and the note against it is paid in full.
#
# Needs: anvil, cast, forge (FOUNDRY_BIN or PATH), jq, python3. Uses the well-known anvil development mnemonic only (the keys
# are derived at run time; none is written in this file). Writes nothing outside contracts/pot/deployments (git-ignored) and
# a temporary directory. Stops anvil when it ends.
#
# Env: FOUNDRY_BIN (a folder with anvil, cast, forge), PORT (default: a free port), KEEP_ANVIL=1 (leave anvil running and
#      print its port). The time unit is always the real one, 7 days: the steps below move the chain clock by days and weeks.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POT="$REPO_ROOT/contracts/pot"
[[ -n "${FOUNDRY_BIN:-}" ]] && PATH="$FOUNDRY_BIN:$PATH"
for tool in anvil cast forge jq python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "pot-chain-loop: $tool is not on PATH" >&2; exit 2; }
done

N=0
pass() { N=$((N + 1)); printf 'PASS %02d  %s\n' "$N" "$*"; }
fail() { printf 'FAIL %02d  %s\n' "$((N + 1))" "$*" >&2; exit 1; }

TMP="$(mktemp -d)"
ANVIL_PID=""
cleanup() {
  trap - EXIT
  if [[ -n "$ANVIL_PID" && "${KEEP_ANVIL:-}" != "1" ]]; then kill "$ANVIL_PID" 2>/dev/null; wait "$ANVIL_PID" 2>/dev/null; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PORT="${PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')}"
RPC="http://127.0.0.1:$PORT"
UNIT=604800
export UNIT

# ---- chain and accounts (the public anvil mnemonic; indexes 0..4)
MNEMONIC="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
addr() { cast wallet address --private-key "$1"; }
K_DEPLOYER="$(key 0)"; K_FOUNDER="$(key 1)"; K_STRANGER="$(key 2)"; K_PAYER="$(key 3)"; K_MEMBER="$(key 4)"; K_WORKER="$(key 5)"
DEPLOYER="$(addr "$K_DEPLOYER")"; FOUNDER="$(addr "$K_FOUNDER")"; STRANGER="$(addr "$K_STRANGER")"
PAYER="$(addr "$K_PAYER")"; MEMBER="$(addr "$K_MEMBER")"; WORKER="$(addr "$K_WORKER")"

anvil --port "$PORT" --silent >"$TMP/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || fail "anvil did not start (see $TMP/anvil.log)"
[[ "${KEEP_ANVIL:-}" == "1" ]] && echo "anvil on $RPC (pid $ANVIL_PID)"

# ---- helpers
send() { # send <key> <to> <signature> [args...]
  local k="$1" to="$2"; shift 2
  cast send --rpc-url "$RPC" --private-key "$k" --json "$to" "$@" >"$TMP/last.json" 2>"$TMP/last.err" || {
    cat "$TMP/last.err" >&2; return 1; }
  [[ "$(jq -r .status "$TMP/last.json")" == "0x1" ]] || { echo "transaction reverted: $(jq -r .transactionHash "$TMP/last.json")" >&2; return 1; }
}
must() { send "$@" || fail "a transaction that must succeed failed: $*"; }
mustnot() { # a transaction that must be refused
  if cast send --rpc-url "$RPC" --private-key "$1" "$2" "${@:3}" >"$TMP/refused.out" 2>&1; then
    fail "this must have been refused but was accepted: ${*:2}"
  fi
}
call() { cast call --rpc-url "$RPC" "$@" | awk 'NR==1{print $1}'; }
callv() { cast call --rpc-url "$RPC" "$@" | awk '{print $1}'; } # every output line, first word
py() { python3 -c "print($1)"; }
warp() { cast rpc --rpc-url "$RPC" evm_increaseTime "$1" >/dev/null && cast rpc --rpc-url "$RPC" evm_mine >/dev/null; }
now() { cast block latest --rpc-url "$RPC" -f timestamp; }
gas() { jq -r .gasUsed "$TMP/last.json" | xargs printf '%d'; }
expect_eq() { [[ "$2" == "$3" ]] || fail "$1: got $2, expected $3"; }
expect_ge() { [[ "$(py "int($2) >= int($3)")" == "True" ]] || fail "$1: $2 is below $3"; }
expect_le() { [[ "$(py "int($2) <= int($3)")" == "True" ]] || fail "$1: $2 is above $3"; }
expect_gt() { [[ "$(py "int($2) > int($3)")" == "True" ]] || fail "$1: $2 is not above $3"; }
bal() { call "$1" "balanceOf(address)(uint256)" "$2"; }
# move the chain clock to at least <ts>, with a check-in at least every 5 days so the runner's window never closes on the way
alive_to() {
  local ts="$1" cur step
  cur="$(now)"
  while [[ "$(py "$cur < $ts")" == "True" ]]; do
    step="$(py "min(432000, $ts - $cur)")"
    warp "$step"
    cur="$(now)"
    if [[ "$(py "$cur < $ts")" == "True" ]]; then must "$K_FOUNDER" "$T" "checkIn(bytes32)" "$CHK"; fi
  done
}

# ---- deploy (the real deploy script, N = 7 days by default)
(cd "$POT" && forge script script/DeployPot.s.sol --rpc-url "$RPC" --broadcast --private-key "$K_DEPLOYER" >"$TMP/deploy.log" 2>&1) \
  || { cat "$TMP/deploy.log" >&2; fail "the deploy script failed"; }
DEPLOY_JSON="$POT/deployments/pot-31337.json"
PUSD="$(jq -r .quote "$DEPLOY_JSON")"; LAUNCHER="$(jq -r .launcher "$DEPLOY_JSON")"
[[ "$(cast code --rpc-url "$RPC" "$PUSD" | wc -c)" -gt 10 && "$(cast code --rpc-url "$RPC" "$LAUNCHER" | wc -c)" -gt 10 ]] \
  || fail "no code at the deployed addresses"
expect_eq "time unit" "$(jq -r .unit "$DEPLOY_JSON")" "$UNIT"
pass "deployed PlayDollar $PUSD and the Launcher $LAUNCHER (time unit $UNIT seconds, platform fee 2%)"

# ---- 1. launch a project
PID="$(cast format-bytes32-string loop)"
HASH="$(call "$LAUNCHER" "settingsHash()(bytes32)")"
POOL="10000000000000000000000000" # 10,000,000 Team Shares
must "$K_FOUNDER" "$LAUNCHER" "launch(bytes32,string,string,(uint32,uint256),bytes32)" "$PID" "Loop Project" "LOOP" "(1000,$POOL)" "$HASH"
PROJ="$(cast call --rpc-url "$RPC" "$LAUNCHER" "project(address,bytes32)((address,address,address,address,address,uint64))" "$FOUNDER" "$PID" | tr -d '()' | tr ',' '\n' | awk '{print $1}')"
FOUNDER_CHECK="$(sed -n 1p <<<"$PROJ")"; SHARES="$(sed -n 2p <<<"$PROJ")"; TEAM="$(sed -n 3p <<<"$PROJ")"
T="$(sed -n 4p <<<"$PROJ")"; VESTER="$(sed -n 5p <<<"$PROJ")"
expect_eq "founder in the record" "${FOUNDER_CHECK,,}" "${FOUNDER,,}"
expect_eq "runner" "$(call "$T" "runner()(address)" | tr 'A-F' 'a-f')" "${FOUNDER,,}"
expect_eq "Team pool in the Vester" "$(bal "$TEAM" "$VESTER")" "$POOL"
expect_eq "rate" "$(call "$T" "ratePpm()(uint32)")" "1000"
pass "launched a project: Treasury $T, Shares $SHARES, Team Shares $TEAM, Vester $VESTER, rate 0.10% a day, Team pool 10,000,000"

# ---- 2. a stranger takes play dollars from the faucet
must "$K_STRANGER" "$PUSD" "faucet()"
expect_eq "faucet" "$(bal "$PUSD" "$STRANGER")" "1000000000"
mustnot "$K_STRANGER" "$PUSD" "faucet()"
pass "the stranger took 1,000 play dollars from the faucet, and the faucet refused a second time"

# ---- 3. back in ONE transaction (transferAndCall); the quote matched
AMOUNT=100000000 # 100 dollars
Q_SHARES="$(callv "$T" "quoteBack(uint256)(uint256,uint256,uint256,uint256)" "$AMOUNT" | sed -n 1p)"
Q_OUT="$(callv "$T" "quoteBack(uint256)(uint256,uint256,uint256,uint256)" "$AMOUNT" | sed -n 2p)"
DATA="$(cast abi-encode "f(uint256,address)" 0 "$STRANGER")"
must "$K_STRANGER" "$PUSD" "transferAndCall(address,uint256,bytes)" "$T" "$AMOUNT" "$DATA"
JOIN_GAS="$(gas)"
GOT="$(bal "$SHARES" "$STRANGER")"
expect_eq "Shares for 100 dollars" "$GOT" "$Q_SHARES"
expect_eq "Shares at one cent" "$GOT" "9800000000000000000000"
expect_eq "the pot" "$(call "$T" "pot()(uint256)")" "98000000"
expect_eq "the platform fee owed" "$(call "$T" "feesOwed()(uint256)")" "2000000"
expect_eq "no leftover allowance of the transfer" "$(call "$T" "unaccounted()(uint256)")" "0"
expect_le "take-out at once is at most what was paid after the fee" "$Q_OUT" "98000000"
pass "backed with 100 play dollars in one transaction (transferAndCall, $JOIN_GAS gas): got $GOT wei of Shares = the quote; pot 98, fee 2"

# ---- 3b. a second backer takes the other path (approve, then join), so both are measured
AMOUNT2=50000000 # 50 dollars
must "$K_MEMBER" "$PUSD" "faucet()"
must "$K_MEMBER" "$PUSD" "approve(address,uint256)" "$T" "$AMOUNT2"
Q2="$(callv "$T" "quoteBack(uint256)(uint256,uint256,uint256,uint256)" "$AMOUNT2" | sed -n 1p)"
must "$K_MEMBER" "$T" "join(uint256,uint256,address)" "$AMOUNT2" "$(py "$Q2 * 999999 // 1000000")" "$MEMBER"
JOIN2_GAS="$(gas)"
GOT2="$(bal "$SHARES" "$MEMBER")"
# the allowance accrues a unit or so a second, so a quote and the join a block later may differ in the 8th digit
expect_ge "second backer's Shares are at least the quote less one part in a million" "$GOT2" "$(py "$Q2 * 999999 // 1000000")"
expect_le "and no more than the quote plus one part in a million" "$GOT2" "$(py "$Q2 * 1000001 // 1000000")"
pass "a second backer put in 50 with approve then join ($JOIN2_GAS gas) and got $GOT2 wei of Shares, the quote within a part in a million (the pot moves a unit a second)"

# ---- 4. check in
CHK="$(cast keccak "record 1")"
must "$K_FOUNDER" "$T" "checkIn(bytes32)" "$CHK"
expect_eq "last check-in is that block" "$(call "$T" "lastCheckIn()(uint64)")" "$(now)"
pass "the founder checked in with a record hash; the window is open (door open: $(call "$T" "doorOpenNow()(bool)"))"
expect_eq "door" "$(call "$T" "doorOpenNow()(bool)")" "true"

# ---- 5. time passes, the allowance is drawn, never more than the box
warp 432000 # 5 days
must "$K_PAYER" "$T" "settle()"
BOX="$(call "$T" "box()(uint256)")"
CAP="$(call "$T" "boxCap()(uint256)")"
POT_NOW="$(call "$T" "pot()(uint256)")"
EXP_BOX="$(py "$POT_NOW * 5 // 1000")" # 0.10% of the pot a day for 5 days
expect_gt "the box has filled" "$BOX" "$(py "$EXP_BOX * 97 // 100")"
expect_le "the box is about 5 days of 0.10% of the pot" "$BOX" "$(py "$EXP_BOX * 103 // 100")"
expect_le "the box is under its cap" "$BOX" "$CAP"
BEFORE="$(bal "$PUSD" "$FOUNDER")"
# the box grows by a unit or two a second, so "more than the box" is twice the box, not one unit more
mustnot "$K_FOUNDER" "$T" "draw(address,uint256)" "$FOUNDER" "$(py "$BOX * 2")"
pass "after 5 days the box holds $BOX (about 5 x 0.10% of $POT_NOW; cap $CAP); drawing twice the box is refused"
must "$K_FOUNDER" "$T" "draw(address,uint256)" "$FOUNDER" "$BOX"
expect_eq "drawn to the founder" "$(py "$(bal "$PUSD" "$FOUNDER") - $BEFORE")" "$BOX"
expect_le "the box holds only what accrued in the seconds since the draw" "$(call "$T" "box()(uint256)")" "1000"
pass "the founder drew exactly the box ($BOX units) from the allowance"

# ---- 6. outside money is added and arrives over one time unit
must "$K_PAYER" "$PUSD" "faucet()"
must "$K_PAYER" "$PUSD" "approve(address,uint256)" "$T" 500000000
must "$K_PAYER" "$T" "addRevenue(uint256)" 500000000
expect_eq "arriving" "$(call "$T" "arriving()(uint256)")" "500000000"
POT_BEFORE="$(call "$T" "pot()(uint256)")"
must "$K_FOUNDER" "$T" "checkIn(bytes32)" "$CHK"
warp "$(py "$UNIT // 2")"
must "$K_PAYER" "$T" "settle()"
HALF="$(call "$T" "arriving()(uint256)")"
expect_gt "about half has arrived" "$HALF" "240000000"
expect_le "about half has arrived" "$HALF" "260000000"
pass "500 dollars of outside money were added: it sits in 'arriving' and half ($(py "500000000 - $HALF") units) was in the pot after half a time unit"
must "$K_FOUNDER" "$T" "checkIn(bytes32)" "$CHK"
warp "$(py "$UNIT // 2 + 5")"
must "$K_PAYER" "$T" "settle()"
expect_eq "all arrived" "$(call "$T" "arriving()(uint256)")" "0"
expect_gt "the pot holds the outside money" "$(call "$T" "pot()(uint256)")" "580000000"
pass "after one time unit all 500 dollars have arrived: arriving 0, pot $(call "$T" "pot()(uint256)")"

# ---- 7. a grant vests after the cliff and is claimed
GRANT=1000000000000000000000000 # 1,000,000 Team Shares
must "$K_FOUNDER" "$T" "grantTeam(address,uint256)" "$MEMBER" "$GRANT"
GID="$(py "$(call "$VESTER" "grantCount()(uint256)") - 1")"
expect_eq "nothing vested at once" "$(call "$VESTER" "vestedOf(uint256)(uint256)" "$GID")" "0"
for i in $(seq 1 12); do warp "$UNIT"; must "$K_FOUNDER" "$T" "checkIn(bytes32)" "$CHK"; done
expect_eq "nothing before the cliff (12 of 13 time units)" "$(call "$VESTER" "vestedOf(uint256)(uint256)" "$GID")" "0"
mustnot "$K_PAYER" "$VESTER" "claim(uint256)" "$GID"
pass "a grant of 1,000,000 Team Shares has vested nothing after 12 time units of active time, and a claim is refused"
warp "$UNIT"; must "$K_FOUNDER" "$T" "checkIn(bytes32)" "$CHK"
VESTED="$(call "$VESTER" "vestedOf(uint256)(uint256)" "$GID")"
expect_gt "vesting has started after the cliff" "$VESTED" "120000000000000000000000"
expect_le "13 of 104 time units, about 12.5%" "$VESTED" "126000000000000000000000"
must "$K_PAYER" "$VESTER" "claim(uint256)" "$GID"
MEMBER_TEAM="$(bal "$TEAM" "$MEMBER")"
# vesting runs a hair every second: the claim, a block after the read, may hold a few seconds more (1.6e16 wei a second here)
expect_ge "claimed at least what was read" "$MEMBER_TEAM" "$VESTED"
expect_le "claimed no more than a hundred seconds of vesting beyond it" "$MEMBER_TEAM" "$(py "$VESTED + 100 * 16000000000000000")"
pass "after the 13-unit cliff $MEMBER_TEAM wei of the grant (12.5%) vested and was claimed to the member"

# ---- 7b. the task queue: announce, the notice, take, a backer takes out with a note, pay in part, claim (step 2)
BOOK="$(call "$T" "tasks()(address)")"
[[ "$(cast code --rpc-url "$RPC" "$BOOK" | wc -c)" -gt 10 ]] || fail "no code at the task book $BOOK"
WHAT1="$(cast keccak "task 1")"
POT_PRE="$(call "$T" "pot()(uint256)")"
must "$K_FOUNDER" "$T" "announceTask(bytes32,address,uint256,uint16)" "$WHAT1" "$WORKER" 50000000 100
ANNOUNCE_GAS="$(gas)"
T_ANN="$(now)"
read -r NOTICE WINDOW DUE <<<"$(callv "$T" "noticeFor(uint16)(uint256,uint256,uint256)" 100 | tr '\n' ' ')"
expect_eq "the notice of a 1% task is 14 days and 12 hours" "$NOTICE" "$(py "2 * $UNIT + -(-100 * $UNIT // 1400)")"
expect_eq "14 days 12 hours in seconds" "$NOTICE" "1252800"
expect_eq "the take window is one time unit" "$WINDOW" "$UNIT"
expect_eq "a taken task is due two time units after the take" "$DUE" "$(py "2 * $UNIT")"
expect_eq "the next serial" "$(call "$BOOK" "nextSerial()(uint64)")" "2"
expect_eq "announcing moves no money" "$(call "$T" "locked()(uint256)")" "0"
expect_ge "the pot is as it was (it only grows by the arrival and shrinks by the allowance)" "$(call "$T" "pot()(uint256)")" "$(py "$POT_PRE * 99 // 100")"
mustnot "$K_STRANGER" "$T" "announceTask(bytes32,address,uint256,uint16)" "$WHAT1" "$WORKER" 50000000 100
mustnot "$K_FOUNDER" "$T" "announceTask(bytes32,address,uint256,uint16)" "$WHAT1" "$FOUNDER" 50000000 100
mustnot "$K_FOUNDER" "$T" "announceTask(bytes32,address,uint256,uint16)" "$WHAT1" "$WORKER" 50000000 501
pass "the founder announced task 1 for the worker: 1% of the pot, at most 50 dollars ($ANNOUNCE_GAS gas); notice $NOTICE seconds = 14 days 12 hours; nothing moved; a stranger, the founder as payee and a share over 5% are refused"

mustnot "$K_WORKER" "$T" "takeTask(uint64,uint256)" 1 0
mustnot "$K_STRANGER" "$T" "takeTask(uint64,uint256)" 1 0
pass "a take before the notice is over is refused, and so is a take by someone who is not the named worker"

alive_to "$(py "$T_ANN + $NOTICE")"
must "$K_WORKER" "$T" "takeTask(uint64,uint256)" 1 1
TAKE_GAS="$(gas)"
SET_ASIDE="$(call "$T" "locked()(uint256)")"
POT_AFTER_TAKE="$(call "$T" "pot()(uint256)")"
expect_eq "set aside is the stated share of the settled pot, rounded down" "$SET_ASIDE" "$(py "($POT_AFTER_TAKE + $SET_ASIDE) * 100 // 10000")"
expect_le "and no more than the 50 dollars the task was announced for" "$SET_ASIDE" "50000000"
T_TAKE="$(now)"
expect_eq "the notes owed are still nothing" "$(call "$T" "notesOwed()(uint256)")" "0"
expect_eq "the window sum counts the take" "$(call "$BOOK" "windowSumBps()(uint256)")" "100"
pass "after the notice the worker took task 1 ($TAKE_GAS gas): $SET_ASIDE units were set aside out of the pot (1% of the settled pot), the take counts 100 of the 1,000 ten-thousandths of the 28-day cap"

# a backer takes out while the money is set aside: cash on the pot without it, and a note for the rest
N_M="$(py "$(bal "$SHARES" "$MEMBER") // 2")"
read -r QM_CASH QM_NOTE QM_BEHIND <<<"$(callv "$T" "quoteTakeOut(address,uint256)(uint256,uint256,uint256)" "$MEMBER" "$N_M" | tr '\n' ' ')"
expect_gt "the quote shows a note" "$QM_NOTE" "0"
MB3="$(bal "$PUSD" "$MEMBER")"
must "$K_MEMBER" "$T" "leave(uint256,uint256,address)" "$N_M" "$(py "$QM_CASH * 99999 // 100000")" "$MEMBER"
LEAVE_NOTE_GAS="$(gas)"
NOTE1="$(call "$BOOK" "noteOf(uint64,address)(uint256)" 1 "$MEMBER")"
CASH3="$(py "$(bal "$PUSD" "$MEMBER") - $MB3")"
# the allowance accrues a few units a second, so the quote and the action a block later differ by a part in a hundred thousand
expect_ge "the cash is the quote" "$CASH3" "$(py "$QM_CASH * 99999 // 100000")"
expect_le "the cash is the quote" "$CASH3" "$(py "$QM_CASH * 100001 // 100000")"
expect_ge "the note is the quote" "$NOTE1" "$(py "$QM_NOTE * 99999 // 100000")"
expect_le "the note is the quote" "$NOTE1" "$(py "$QM_NOTE * 100001 // 100000")"
expect_eq "the money held for the note" "$(call "$T" "notesOwed()(uint256)")" "$NOTE1"
expect_eq "the stayers' claim fell by the note" "$(call "$T" "locked()(uint256)")" "$(py "$SET_ASIDE - $NOTE1")"
pass "the second backer took out half their Shares while task 1 was set aside ($LEAVE_NOTE_GAS gas): cash $CASH3 (quote $QM_CASH) and an exit note of $NOTE1 units against task 1 (quote $QM_NOTE); the note is held apart, the stayers' claim fell by it"

# the task is paid in part: the worker first, then what is left at ONE ratio to the stayers and to the note
PAY1="$(py "$SET_ASIDE // 2")"
WB="$(bal "$PUSD" "$WORKER")"
POT_B4_ACCEPT="$(call "$T" "pot()(uint256)")"
mustnot "$K_WORKER" "$T" "acceptTask(uint64,uint256)" 1 "$PAY1"
mustnot "$K_STRANGER" "$T" "acceptTask(uint64,uint256)" 1 "$PAY1"
mustnot "$K_FOUNDER" "$T" "acceptTask(uint64,uint256)" 1 "$(py "$SET_ASIDE + 1")"
must "$K_FOUNDER" "$T" "acceptTask(uint64,uint256)" 1 "$PAY1"
ACCEPT_GAS="$(gas)"
expect_eq "the worker was paid exactly what the founder named" "$(py "$(bal "$PUSD" "$WORKER") - $WB")" "$PAY1"
REM1="$(py "$SET_ASIDE - $PAY1")"
POOL1="$(py "$NOTE1 * $REM1 // $SET_ASIDE")"
expect_eq "what is held for the note: its share of what came back" "$(call "$T" "notesOwed()(uint256)")" "$POOL1"
expect_ge "the pot got the rest, at the same ratio" "$(call "$T" "pot()(uint256)")" "$(py "$POT_B4_ACCEPT + $REM1 - $POOL1")"
expect_eq "nothing is set aside any more" "$(call "$T" "locked()(uint256)")" "0"
CLAIMABLE="$(call "$BOOK" "claimableNote(uint64,address)(uint256)" 1 "$MEMBER")"
expect_eq "the note's claim is floor(note x returned / set aside)" "$CLAIMABLE" "$POOL1"
mustnot "$K_STRANGER" "$T" "claimNote(uint64,address)" 1 "$STRANGER" # a holder with no note
pass "task 1 was paid in part: the worker got $PAY1 of $SET_ASIDE ($ACCEPT_GAS gas); the other $REM1 came back at one ratio: $POOL1 held for the note, the rest to the pot; the worker, a stranger and a payment over what was set aside are refused"

MB4="$(bal "$PUSD" "$MEMBER")"
must "$K_STRANGER" "$T" "claimNote(uint64,address)" 1 "$MEMBER"
CLAIM_GAS="$(gas)"
expect_eq "a stranger called it; the holder was paid" "$(py "$(bal "$PUSD" "$MEMBER") - $MB4")" "$CLAIMABLE"
expect_eq "nothing is held for notes" "$(call "$T" "notesOwed()(uint256)")" "0"
mustnot "$K_STRANGER" "$T" "claimNote(uint64,address)" 1 "$MEMBER"
pass "a stranger settled the note ($CLAIM_GAS gas): the second backer was paid $CLAIMABLE units; a second claim is refused; no money is held for notes"

# a second task is taken and nobody accepts it: after its deadline anyone returns it, and the note is paid in full
WHAT2="$(cast keccak "task 2")"
must "$K_FOUNDER" "$T" "checkIn(bytes32)" "$CHK"
must "$K_FOUNDER" "$T" "announceTask(bytes32,address,uint256,uint16)" "$WHAT2" "$WORKER" 50000000 100
T_ANN2="$(now)"
alive_to "$(py "$T_ANN2 + $NOTICE")"
W_PRE="$(call "$BOOK" "windowSumBps()(uint256)")"
must "$K_WORKER" "$T" "takeTask(uint64,uint256)" 2 1
T_TAKE2="$(now)"
W_BEFORE="$(call "$BOOK" "windowSumBps()(uint256)")"
TAKE2_BPS="$(py "$W_BEFORE - $W_PRE")"
expect_gt "the second take counts in the 28-day cap" "$TAKE2_BPS" "0"
SET2="$(call "$T" "locked()(uint256)")"
expect_gt "task 2 set money aside" "$SET2" "0"
N_M2="$(py "$(bal "$SHARES" "$MEMBER") // 2")"
MB5="$(bal "$PUSD" "$MEMBER")"
must "$K_MEMBER" "$T" "leave(uint256,uint256,address)" "$N_M2" 1 "$MEMBER"
CASH5="$(py "$(bal "$PUSD" "$MEMBER") - $MB5")"
NOTE2="$(call "$BOOK" "noteOf(uint64,address)(uint256)" 2 "$MEMBER")"
expect_gt "the second take-out of the second backer was written a note too" "$NOTE2" "0"
mustnot "$K_PAYER" "$T" "returnTask(uint64)" 2
mustnot "$K_MEMBER" "$T" "claimNote(uint64,address)" 2 "$MEMBER"
alive_to "$(py "$T_TAKE2 + $DUE + 1")"
must "$K_PAYER" "$T" "returnTask(uint64)" 2
RETURN_GAS="$(gas)"
expect_eq "nothing is set aside any more" "$(call "$T" "locked()(uint256)")" "0"
expect_le "a take that came back unpaid gives its share of the cap back" "$(py "$(call "$BOOK" "windowSumBps()(uint256)") + $TAKE2_BPS")" "$W_BEFORE"
expect_eq "the note keeps its whole face when nothing was paid" "$(call "$T" "notesOwed()(uint256)")" "$NOTE2"
MB6="$(bal "$PUSD" "$MEMBER")"
must "$K_STRANGER" "$T" "claimNote(uint64,address)" 2 "$MEMBER"
expect_eq "the note is paid in full" "$(py "$(bal "$PUSD" "$MEMBER") - $MB6")" "$NOTE2"
expect_eq "nothing is held for notes" "$(call "$T" "notesOwed()(uint256)")" "0"
expect_eq "the worker got nothing for task 2" "$(py "$(bal "$PUSD" "$WORKER") - $WB - $PAY1")" "0"
pass "task 2 was taken ($SET2 set aside) and nobody accepted it: the note of $NOTE2 against it could not be claimed early; two time units after the take anyone returned it ($RETURN_GAS gas) and the note was paid in full"

# ---- 8. going quiet shuts the door and stops the allowance
warp "$(py "2 * $UNIT + 100")" # past the 2-unit check-in window
expect_eq "door shut" "$(call "$T" "doorOpenNow()(bool)")" "false"
mustnot "$K_STRANGER" "$PUSD" "transferAndCall(address,uint256,bytes)" "$T" 1000000 "$DATA"
must "$K_PAYER" "$T" "settle()"
BOX1="$(call "$T" "box()(uint256)")"; ACT1="$(call "$T" "activeNow()(uint256)")"
warp 864000
must "$K_PAYER" "$T" "settle()"
expect_eq "the box stopped growing" "$(call "$T" "box()(uint256)")" "$BOX1"
expect_eq "active time stopped" "$(call "$T" "activeNow()(uint256)")" "$ACT1"
pass "two time units without a check-in: the door is shut (a join is refused) and 10 more days add nothing to the box ($BOX1) or to active time"

# ---- 9. a vested Team Share takes out with only the surplus
must "$K_PAYER" "$T" "settle()"
POT="$(call "$T" "pot()(uint256)")"; A="$(call "$T" "paidIn()(uint256)")"; B="$(call "$SHARES" "totalSupply()(uint256)")"; G="$(call "$TEAM" "totalSupply()(uint256)")"
NT="$(py "$MEMBER_TEAM // 2")"
EXPECT="$(py "$NT * ($POT - min($POT, $A)) // ($B + $G)")"
MB="$(bal "$PUSD" "$MEMBER")"
must "$K_MEMBER" "$T" "leaveTeam(uint256,uint256,address)" "$NT" 1 "$MEMBER"
CASH="$(py "$(bal "$PUSD" "$MEMBER") - $MB")"
expect_eq "Team take-out is the surplus share" "$CASH" "$EXPECT"
expect_gt "something was paid" "$CASH" "0"
expect_eq "paid-in untouched" "$(call "$T" "paidIn()(uint256)")" "$A"
expect_ge "the pot still covers paid-in" "$(call "$T" "pot()(uint256)")" "$A"
expect_eq "Team Shares burned" "$(bal "$TEAM" "$MEMBER")" "$(py "$MEMBER_TEAM - $NT")"
pass "the member took out half their vested Team Shares and got $CASH units = n x (pot - paid-in) / (B + G): only the surplus; paid-in is untouched"

# ---- 10. the stranger takes out and is paid what quoteTakeOut said
N_SH="$(bal "$SHARES" "$STRANGER")"
Q="$(callv "$T" "quoteTakeOut(address,uint256)(uint256,uint256,uint256)" "$STRANGER" "$N_SH" | sed -n 1p)"
SB="$(bal "$PUSD" "$STRANGER")"
must "$K_STRANGER" "$T" "leave(uint256,uint256,address)" "$N_SH" "$Q" "$STRANGER"
LEAVE_GAS="$(gas)"
PAID="$(py "$(bal "$PUSD" "$STRANGER") - $SB")"
expect_eq "paid what the quote said" "$PAID" "$Q"
expect_gt "more than the 98 paid in, with a slice of the outside money" "$PAID" "98000000"
expect_eq "Shares burned" "$(bal "$SHARES" "$STRANGER")" "0"
pass "the stranger took out ALL their Shares while the project is quiet ($LEAVE_GAS gas): paid $PAID units = quoteTakeOut ($Q), more than the 98 paid in"

# ---- 10b. the last backer takes out too
N_SH2="$(bal "$SHARES" "$MEMBER")"
Q3="$(callv "$T" "quoteTakeOut(address,uint256)(uint256,uint256,uint256)" "$MEMBER" "$N_SH2" | sed -n 1p)"
MB2="$(bal "$PUSD" "$MEMBER")"
must "$K_MEMBER" "$T" "leave(uint256,uint256,address)" "$N_SH2" "$Q3" "$MEMBER"
LEAVE2_GAS="$(gas)"
expect_eq "paid what the quote said" "$(py "$(bal "$PUSD" "$MEMBER") - $MB2")" "$Q3"
expect_eq "no Shares left" "$(call "$SHARES" "totalSupply()(uint256)")" "0"
expect_eq "no paid-in left" "$(call "$T" "paidIn()(uint256)")" "0"
pass "the last backer took out too ($LEAVE2_GAS gas): paid $Q3 = the quote; no Shares and no paid-in are left"

# ---- 11. nothing owed that is not held
OWED="$(py "$(call "$T" "pot()(uint256)") + $(call "$T" "box()(uint256)") + $(call "$T" "arriving()(uint256)") + $(call "$T" "feesOwed()(uint256)") + $(call "$T" "locked()(uint256)") + $(call "$T" "notesOwed()(uint256)")")"
HELD="$(bal "$PUSD" "$T")"
expect_eq "the buckets are exactly the balance" "$OWED" "$HELD"
must "$K_DEPLOYER" "$T" "collectFees()"
expect_eq "fees went to the platform" "$(bal "$PUSD" "$DEPLOYER")" "3000000"
pass "dollars are conserved: the Treasury holds $HELD units and owes exactly that; the platform collected its fees (3: 2% of 150 paid in)"

echo
echo "pot-chain-loop: $N checks passed."
echo "gas (real receipts): back by transferAndCall (first backer) $JOIN_GAS; back by approve + join (second backer) $JOIN2_GAS;"
echo "                     take out (others remain) $LEAVE_GAS; take out (last backer) $LEAVE2_GAS"
echo "                     tasks: announce $ANNOUNCE_GAS; take $TAKE_GAS; take out with a note $LEAVE_NOTE_GAS; accept in part $ACCEPT_GAS; claim a note $CLAIM_GAS; return $RETURN_GAS"
