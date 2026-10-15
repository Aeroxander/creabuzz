#!/usr/bin/env bash
#
# scripts/lib/milestone-world.sh — a throwaway dev chain with a project launched into its own DAO through the kit, its
# team's Shares locked behind two milestones, and the CLI steps that earn the first one. Sourced by
# `cli-milestone-e2e.sh` and `web-milestone-e2e.sh`, on top of `no-raise-world.sh` (which supplies the dev accounts,
# `as`, `decide`, `warp` and friends).
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# The founder (the first dev account) launches; the launch gives them the team's 20% of a 1B supply, 40% of it tied to
# "alpha shipped" and 60% to "mainnet live". The launch itself names the panel that judges them (two outside reviewers,
# both must agree). The DAO then votes a project in that panel whose acceptance check is "alpha shipped", and the founder
# files a claim for it. `world_milestone_paid` runs it to Paid.

# shellcheck source=no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/no-raise-world.sh"

TEAM_SHARES=200000000000000000000000000   # 200,000,000 Shares (20% of 1B)
FIRST_TRANCHE=80000000000000000000000000  # 40% of the team's allocation
SECOND_TRANCHE=120000000000000000000000000
HALF_TRANCHE=40000000000000000000000000   # half of the first (Bash cannot divide a number this big)

world_launch_with_lock() {
  step "the founder launches a project into its own DAO through the kit, the team's Shares locked behind two milestones"
  KIT=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(m.roles.find((r)=>r.role==="launch-kit").address)' \
    "$DEPLOYMENTS/dao-launch-kit-31337.json") || fail "no launch kit in the dev chain's manifest"
  local head plan receipt_file
  head=$(cast block-number --rpc-url "$RPC")
  plan=$(node --experimental-strip-types "$REPO_ROOT/scripts/lib/kit-launch.mjs" plan "$RPC" "$KIT" "$FOUNDER" "$CURRENCY" "$((head + 500))" "$REVIEWER1,$REVIEWER2" 2) \
    || fail "could not plan the launch"
  receipt_file="$STATE/launch-receipt.json"
  cast send --json --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$(echo "$plan" | jget to)" "$(echo "$plan" | jget data)" >"$receipt_file" \
    || fail "the launch transaction failed"
  local launched
  launched=$(node --experimental-strip-types "$REPO_ROOT/scripts/lib/kit-launch.mjs" decode "$KIT" "$receipt_file") \
    || fail "the launch receipt has no Launched event from the kit"
  # Checksummed, like every address `cast` prints, so they compare equal to what it reads back.
  DAO=$(cast to-check-sum-address "$(echo "$launched" | jget dao)")
  SHARES=$(cast to-check-sum-address "$(echo "$launched" | jget shares)")
  LOCK=$(echo "$launched" | jget lock)
  [[ "$LOCK" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the launch made no lock: $launched"
  LOCK=$(cast to-check-sum-address "$LOCK")
  POLICY=$(cast call "$DAO" "votingWeight()(address)" --rpc-url "$RPC")
  FACTORY=$(cast call "$POLICY" "mandateFactory()(address)" --rpc-url "$RPC")
  BADGE=$(cast call "$LOCK" "badge()(address)" --rpc-url "$RPC")
  [[ "$(cast call "$SHARES" "lockGuard()(address)" --rpc-url "$RPC")" == "$LOCK" ]] \
    || fail "the Shares do not name the lock as their guard"
  [[ "$(shares_of "$FOUNDER")" == "$TEAM_SHARES" ]] || fail "the founder should hold the whole team allocation"
  step "dao ${DAO}  lock ${LOCK}"
}

# The milestone panel the launch named (two outside reviewers, both must agree) and a project in it whose acceptance check
# is the first milestone's words. The project holds nothing; one vote approves it.
world_milestone_project() {
  MANDATE=$(cast call "$FACTORY" "milestoneMandate(address)(address)" "$DAO" --rpc-url "$RPC")
  [[ "$MANDATE" =~ ^0x[0-9a-fA-F]{40}$ && "$MANDATE" != "0x0000000000000000000000000000000000000000" ]] \
    || fail "the launch did not name a milestone panel"
  step "the launch named the milestone panel ${MANDATE}"
  step "the DAO votes a project whose acceptance check is the first milestone's words"
  local intent
  intent=$(as $KEY_FOUNDER work project --dao "$DAO" --mandate "$MANDATE" --id alpha --manager "$MANAGER" \
    --milestone --expires-in-days 30 --check-text "alpha shipped")
  [[ "$(echo "$intent" | jget lane)" == "bounded" ]] || fail "a project should take the bounded lane"
  decide "$intent" 90000
}

# The founder files a claim for the milestone, states its words, the manager takes it on, two reviewers approve it, and
# after the challenge window it is Paid.
world_milestone_paid() {
  step "the founder files a claim for the first milestone, worded exactly as the lock names it"
  echo "alpha, shipped" > "$STATE/alpha-evidence.txt"
  as $KEY_FOUNDER work claim --mandate "$MANDATE" --id alpha --evidence-file "$STATE/alpha-evidence.txt" >/dev/null
  as $KEY_FOUNDER work check --mandate "$MANDATE" --id alpha --check-text "alpha shipped" >/dev/null
  as $KEY_MANAGER work bind --mandate "$MANDATE" --project alpha --id alpha --contributor "$FOUNDER" >/dev/null
  as $KEY_REVIEWER1 work attest --mandate "$MANDATE" --id alpha --verdict approve >/dev/null
  as $KEY_REVIEWER2 work attest --mandate "$MANDATE" --id alpha --verdict approve >/dev/null
  as $KEY_REVIEWER1 work settle --mandate "$MANDATE" --id alpha >/dev/null
  warp 260000
  as $KEY_FOUNDER work payout --mandate "$MANDATE" --id alpha >/dev/null
  [[ "$(as $KEY_FOUNDER work state --mandate "$MANDATE" --id alpha | jget status)" == "Paid" ]] \
    || fail "the milestone claim should be Paid"
}
