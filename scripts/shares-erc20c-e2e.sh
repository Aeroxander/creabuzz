#!/usr/bin/env bash
#
# scripts/shares-erc20c-e2e.sh — are a DAO's Shares an apptoken (ERC-20C)? Against Limit Break's REAL transfer validator
# (the canonical one the dev chain bootstraps) on a REAL local chain, with the DAO choosing every setting by vote.
#
#   1. the DAO votes to make the validator its Shares' validator, then sets the Soulbound ruleset;
#   2. a plain transfer is refused, and RAGEQUIT STILL WORKS (a validator never sees a burn);
#   3. the DAO votes the Vanilla ruleset back and transfers work;
#   4. the DAO votes a lock guard: locked Shares still vote but can be neither sold nor ragequit, and unlocking
#      (the guard changes its answer) frees exactly that much.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/shares-erc20c-e2e.sh
# Env:    ANVIL_PORT (default random high port), BUZZ_BIN (default: build target/debug/buzz)

WORLD_NAME=shares-erc20c
# shellcheck source=lib/no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/no-raise-world.sh"
world_up

TV=0x721C008fdff27BF06E7E123956E2Fe03B63342e3
[[ "$(cast code "$TV" --rpc-url "$CAST_RPC")" != "0x" ]] || fail "the canonical transfer validator is not on this dev chain"
step "the DAO's Shares: $SHARES  validator: $TV"

# One DAO decision from a call: `dao_call <target> <calldata>`.
dao_call() {
  local nonce
  nonce="0x$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  decide "{\"to\":\"$1\",\"data\":\"$2\",\"nonce\":\"$nonce\"}" 175000
}
# `expect_revert <description> <cast send args…>`: a transaction the chain must refuse.
expect_revert() {
  local what="$1"; shift
  if cast send --rpc-url "$CAST_RPC" "$@" >/dev/null 2>&1; then fail "$what went through, and should have been refused"; fi
}
transfer() { cast send --rpc-url "$CAST_RPC" --private-key "$1" "$SHARES" "transfer(address,uint256)" "$2" "$3" >/dev/null; }
ragequit() { cast send --rpc-url "$CAST_RPC" --private-key "$1" "$DAO" "ragequit(address[],uint256,uint256)" "[0x0000000000000000000000000000000000000000]" "$2" 0 >/dev/null; }
set_ruleset() { dao_call "$TV" "$(cast calldata "setRulesetOfCollection(address,uint8,address,uint8,uint16)" "$SHARES" "$1" 0x0000000000000000000000000000000000000000 0 0)"; }

# ── 1. the DAO makes it an apptoken ─────────────────────────────────────────────
step "the DAO votes the transfer validator and the Soulbound ruleset onto its Shares"
cast call "$SHARES" "supportsInterface(bytes4)(bool)" 0xad0d7f6c --rpc-url "$CAST_RPC" | grep -q true || fail "Shares do not present the creator-token interface"
[[ "$(cast call "$SHARES" "owner()(address)" --rpc-url "$CAST_RPC")" == "$DAO" ]] || fail "the DAO is not the collection owner"
dao_call "$SHARES" "$(cast calldata "setTransferValidator(address)" "$TV")"
[[ "$(cast call "$SHARES" "getTransferValidator()(address)" --rpc-url "$CAST_RPC")" == "$TV" ]] || fail "the validator was not set"
set_ruleset 2

# ── 2. transfers are refused; the exit is not ───────────────────────────────────
step "under Soulbound a plain transfer is refused, and ragequit still works"
expect_revert "a transfer under the Soulbound ruleset" --private-key $KEY_FOUNDER "$SHARES" "transfer(address,uint256)" "$REVIEWER1" 1000
before=$(shares_of "$FOUNDER")
ragequit $KEY_FOUNDER 100000000000000000
[[ "$(shares_of "$FOUNDER")" == "$((before - 100000000000000000))" ]] || fail "ragequit did not burn the Shares under a restrictive validator"

# ── 3. the DAO opens trading again ──────────────────────────────────────────────
step "the DAO votes the Vanilla ruleset, and transfers work"
set_ruleset 1
transfer $KEY_FOUNDER "$REVIEWER1" 1000
[[ "$(shares_of "$REVIEWER1")" == "1000000000000001000" ]] || fail "the transfer did not land under Vanilla"

# ── 4. the lock ─────────────────────────────────────────────────────────────────
step "a lock guard: the founder's Shares vote, but only the unlocked part can leave"
LOCKS=$(cast send --json --rpc-url "$CAST_RPC" --private-key $KEY_FOUNDER --create "0x$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).bytecode.object.replace(/^0x/,""))' "$REPO_ROOT/contracts/out/SharesCreatorToken.t.sol/FixedLocks.json")" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).contractAddress))')
[[ "$LOCKS" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "could not deploy the lock guard"
dao_call "$SHARES" "$(cast calldata "setLockGuard(address)" "$LOCKS")"
now=$(shares_of "$FOUNDER")
locked=$((now - 300000000000000000))   # 0.3 Shares are free; the rest is locked
cast send --rpc-url "$CAST_RPC" --private-key $KEY_FOUNDER "$LOCKS" "set(address,uint256)" "$FOUNDER" "$locked" >/dev/null
expect_revert "a transfer of locked Shares" --private-key $KEY_FOUNDER "$SHARES" "transfer(address,uint256)" "$REVIEWER1" 300000000000000001
expect_revert "a ragequit of locked Shares" --private-key $KEY_FOUNDER "$DAO" "ragequit(address[],uint256,uint256)" "[0x0000000000000000000000000000000000000000]" 300000000000000001 0
transfer $KEY_FOUNDER "$REVIEWER1" 300000000000000000
[[ "$(shares_of "$FOUNDER")" == "$locked" ]] || fail "the free part did not leave"
votes=$(cast call "$SHARES" "getVotes(address)(uint256)" "$FOUNDER" --rpc-url "$CAST_RPC" | awk '{print $1}')
[[ "$votes" == "$locked" ]] || fail "locked Shares should still carry their votes (has $votes of $locked)"
step "a milestone is reached: the lock drops, and exactly that much is freed"
cast send --rpc-url "$CAST_RPC" --private-key $KEY_FOUNDER "$LOCKS" "set(address,uint256)" "$FOUNDER" 0 >/dev/null
ragequit $KEY_FOUNDER 100000000000000000

step "PASS: Shares are an apptoken under Limit Break's real validator: transfers follow its rules, ragequit never does, and locked Shares vote but cannot leave"
