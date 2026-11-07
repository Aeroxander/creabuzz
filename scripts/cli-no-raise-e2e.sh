#!/usr/bin/env bash
#
# scripts/cli-no-raise-e2e.sh — a project that never raised pays its contributor in Shares, using only
# `buzz launchpad …` commands against a REAL local chain.
#
# Boots a throwaway dev chain (the same `scripts/dev-chain.sh` a developer runs), then walks the whole path:
#   1. the DAO votes a Shares-only mandate into existence (propose, vote, queue, process);
#   2. the DAO votes a project into it (the bounded lane);
#   3. a contributor files a claim that asks for no money, the manager binds it, two reviewers approve it,
#      anyone settles it, and the contributor takes it after the challenge window;
#   4. the DAO votes the award; the contributor ends up holding Shares, and the project's allowance shrinks.
# It also checks the refusals that matter: a claimant cannot approve their own work, a claim filed by someone else
# is not bound, and an award larger than the project has left is refused.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/cli-no-raise-e2e.sh
# Env:    ANVIL_PORT (default random high port), BUZZ_BIN (default: build target/debug/buzz)

WORLD_NAME=cli-no-raise
# shellcheck source=lib/no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/no-raise-world.sh"
world_up

world_mandate
world_project
world_claim_filed
state=$(as $KEY_CONTRIBUTOR work state --mandate "$MANDATE" --id write-docs)
[[ "$(echo "$state" | jget status)" == "Open" && "$(echo "$state" | jget asksForCurrency)" == "false" ]] \
  || fail "the claim should be open and ask for nothing: $state"
world_claim_bound

step "the claimant is on the reviewer panel, and still cannot approve their own work"
if as $KEY_CONTRIBUTOR work attest --mandate "$MANDATE" --id write-docs --verdict approve >/dev/null 2>&1; then
  fail "a claimant approved their own claim"
fi
as $KEY_REVIEWER1 work attest --mandate "$MANDATE" --id write-docs --verdict approve >/dev/null
as $KEY_REVIEWER2 work attest --mandate "$MANDATE" --id write-docs --verdict approve >/dev/null
as $KEY_CONTRIBUTOR work settle --mandate "$MANDATE" --id write-docs >/dev/null

step "nothing is paid inside the challenge window"
if as $KEY_CONTRIBUTOR work payout --mandate "$MANDATE" --id write-docs >/dev/null 2>&1; then
  fail "a payout went through inside the challenge window"
fi
warp 700000
as $KEY_CONTRIBUTOR work payout --mandate "$MANDATE" --id write-docs >/dev/null
state=$(as $KEY_CONTRIBUTOR work state --mandate "$MANDATE" --id write-docs)
[[ "$(echo "$state" | jget status)" == "Paid" ]] || fail "the claim should be paid out: $state"

# ── 4. recognition ──────────────────────────────────────────────────────────────
before=$(shares_of "$CONTRIBUTOR")
[[ "$before" == "0" ]] || fail "the contributor should start with no Shares (has $before)"
step "an award larger than the project has left is refused when the DAO executes it"
too_much=$(as $KEY_FOUNDER work award --dao "$DAO" --mandate "$MANDATE" --claim write-docs --shares 41)
to=$(echo "$too_much" | jget to); data=$(echo "$too_much" | jget data); nonce=$(echo "$too_much" | jget nonce)
id=$(as $KEY_FOUNDER propose --dao "$DAO" --to "$to" --data "$data" --nonce "$nonce" | jget id)
as $KEY_FOUNDER vote --dao "$DAO" --id "$id" --support for >/dev/null
warp 90000
as $KEY_FOUNDER queue --dao "$DAO" --id "$id" >/dev/null
warp 90000
if as $KEY_FOUNDER process --dao "$DAO" --to "$to" --data "$data" --nonce "$nonce" >/dev/null 2>&1; then
  fail "an award above the project's share allowance was executed"
fi

step "the DAO awards the Shares the work is worth"
intent=$(as $KEY_FOUNDER work award --dao "$DAO" --mandate "$MANDATE" --claim write-docs --shares 25)
[[ "$(echo "$intent" | jget lane)" == "bounded" ]] || fail "an award should take the bounded lane"
decide "$intent" 90000
after=$(shares_of "$CONTRIBUTOR")
[[ "$after" == "25000000000000000000" ]] || fail "the contributor should hold 25 Shares (has $after)"
state=$(as $KEY_CONTRIBUTOR work state --mandate "$MANDATE" --id write-docs)
[[ "$(echo "$state" | jget sharesAwarded)" == "true" ]] || fail "the claim should be marked awarded: $state"

step "PASS: work with no money in it earned 25 Shares through the CLI alone"
