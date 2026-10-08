#!/usr/bin/env bash
#
# scripts/cli-milestone-e2e.sh — the founders' milestone lock, from launch to unlock, against a REAL local chain.
#
# A project is launched into its own DAO through the kit. The founder holds the team's Shares (and votes with them) but
# cannot sell them or take them out of the DAO; a milestone claim approved by independent reviewers, in a work budget the
# DAO voted, lets anyone unlock that milestone's part, and the founder gets a soulbound badge.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/cli-milestone-e2e.sh
# Env:    ANVIL_PORT, BUZZ_BIN (default: build target/debug/buzz)

WORLD_NAME=cli-milestone
# shellcheck source=lib/milestone-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/milestone-world.sh"
world_up
world_launch_with_lock

# ── 1. launched: theirs, voting, and locked ─────────────────────────────────────
locks=$(as $KEY_FOUNDER work locks --dao "$DAO")
[[ "$(echo "$locks" | jget locked)" == "$TEAM_SHARES" ]] || fail "all of the team's Shares should start locked: $locks"
[[ "$(echo "$locks" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.milestones.map((m)=>m.amount+":"+m.state).join(" "))')" \
  == "$FIRST_TRANCHE:locked $SECOND_TRANCHE:locked" ]] || fail "two milestones, 40% and 60%, both locked: $locks"

step "locked Shares cannot be sold, and cannot be taken out of the DAO"
if cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$SHARES" "transfer(address,uint256)" "$REVIEWER1" 1 >/dev/null 2>&1; then
  fail "the founder transferred locked Shares"
fi
if cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$DAO" "ragequit(address[],uint256,uint256)" \
    "[0x0000000000000000000000000000000000000000]" "$TEAM_SHARES" 0 >/dev/null 2>&1; then
  fail "the founder left the DAO with locked Shares"
fi

# ── 2. the first milestone is earned ────────────────────────────────────────────
world_milestone_project
world_milestone_paid

step "a claim for the first milestone does not unlock the second"
if as $KEY_CONTRIBUTOR work unlock --dao "$DAO" --beneficiary "$FOUNDER" --index 1 --mandate "$MANDATE" --id alpha >/dev/null 2>&1; then
  fail "a claim worded for milestone 1 unlocked milestone 2"
fi

step "anyone can send the unlock, and the first milestone's part is freed"
as $KEY_CONTRIBUTOR work unlock --dao "$DAO" --beneficiary "$FOUNDER" --index 0 --mandate "$MANDATE" --id alpha >/dev/null
locks=$(as $KEY_FOUNDER work locks --dao "$DAO")
[[ "$(echo "$locks" | jget locked)" == "$SECOND_TRANCHE" ]] || fail "only the second milestone's part should stay locked: $locks"

step "the same claim cannot unlock anything twice"
if as $KEY_CONTRIBUTOR work unlock --dao "$DAO" --beneficiary "$FOUNDER" --index 0 --mandate "$MANDATE" --id alpha >/dev/null 2>&1; then
  fail "a milestone was unlocked twice"
fi

step "the freed part moves and can be taken out of the DAO, and not one Share more"
cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$SHARES" "transfer(address,uint256)" "$REVIEWER1" "$HALF_TRANCHE" >/dev/null \
  || fail "the founder could not move the Shares the milestone freed"
# The same call that was refused before the milestone now goes through, so the lock was what refused it.
cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$DAO" "ragequit(address[],uint256,uint256)" \
  "[0x0000000000000000000000000000000000000000]" "$HALF_TRANCHE" 0 >/dev/null \
  || fail "the founder could not take the freed Shares out of the DAO"
[[ "$(shares_of "$FOUNDER")" == "$SECOND_TRANCHE" ]] || fail "only the second milestone's Shares should be left, all locked"
if cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$SHARES" "transfer(address,uint256)" "$REVIEWER1" 1 >/dev/null 2>&1; then
  fail "the founder moved a Share that is still locked"
fi
if cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$DAO" "ragequit(address[],uint256,uint256)" \
    "[0x0000000000000000000000000000000000000000]" 1 0 >/dev/null 2>&1; then
  fail "the founder took a locked Share out of the DAO"
fi

step "the founder holds a badge that cannot be handed on"
[[ "$(cast call "$BADGE" "balanceOf(address)(uint256)" "$FOUNDER" --rpc-url "$RPC")" == "1" ]] || fail "the founder should hold one badge"
if cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$BADGE" "transferFrom(address,address,uint256)" "$FOUNDER" "$REVIEWER1" 1 >/dev/null 2>&1; then
  fail "a badge was transferred"
fi

step "PASS: the team's Shares were theirs to vote with, locked until a reviewed milestone freed exactly its part"
