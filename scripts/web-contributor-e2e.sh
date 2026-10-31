#!/usr/bin/env bash
#
# scripts/web-contributor-e2e.sh — a contributor project, entirely from the WEB app, on a REAL chain.
#
# Boots a throwaway chain with the contributor kit on it: by default a local dev chain; with --sepolia-fork, a local fork
# of Sepolia with the contracts deployed by the Sepolia deploy's own Forge script and the web app built with the
# settings a hosted Sepolia build uses. Then it checks the contributor kit refuses the founder limits (D79) and runs
# web/tests/e2e/contributor-journey.spec.ts: the founder starts a contributor project from the Start page (the form
# refuses the same limits first; one transaction makes the DAO with no sale, its first work budget and first project,
# and locks its Shares; then it is published); right away, with no vote, a contributor files a claim that asks for no
# money, the founder takes it on, two reviewers approve it, it is finished and taken; the DAO votes the award; and the
# project's Contributions page, opened with no wallet, shows who earned how much for what. The relay is stubbed in the
# page, as in every mocked spec. On the fork it ends with the gas each person's transactions used.
# A second journey has several people earn (D84): two first projects at Start, a newcomer with no Shares suggests work
# for 5% of the project, the founder puts it to a vote filled in from the suggestion, both people's claims are reviewed,
# paid and awarded by vote, and the Contributions page shows both.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain or a local fork, nothing public.
#
# Usage:  scripts/web-contributor-e2e.sh [--sepolia-fork] [playwright args]
# Env:    ANVIL_PORT, SKIP_BUILD=1 (reuse web/dist: only if it was built by this script for the same chain),
#         SEPOLIA_RPC_URL (--sepolia-fork: the node to fork; default a public one)

CHAIN=local
if [[ "${1:-}" == "--sepolia-fork" ]]; then CHAIN=sepolia-fork; shift; fi
WORLD_NAME=web-contributor
[[ "$CHAIN" == "sepolia-fork" ]] && WORLD_NAME=web-contributor-sepolia-fork
WORLD_NO_CLI=1
# shellcheck source=lib/no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/no-raise-world.sh"
# shellcheck source=lib/sepolia-fork.sh
. "$REPO_ROOT/scripts/lib/sepolia-fork.sh"

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi

role() { # <manifest> <role>
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((m.roles??[]).find((r)=>r.role===process.argv[2])?.address??"")' "$1" "$2"
}

if [[ "$CHAIN" == "local" ]]; then
  world_up
  CONTRIBUTOR_KIT="$(role "$DEPLOYMENTS/contributor-kit-31337.json" contributor-kit)"
  KIT="$(role "$DEPLOYMENTS/dao-launch-kit-31337.json" launch-kit)"
  BOUNTY="$(role "$DEPLOYMENTS/work-bounty-31337.json" work-bounty)"
  PAYOUTS_FACTORY="$(role "$DEPLOYMENTS/payouts-factory-31337.json" payouts-factory)"
  REMIX_BONDS="$(role "$DEPLOYMENTS/remix-bonds-31337.json" remix-bonds)"
  COURT="$(role "$DEPLOYMENTS/court-31337.json" court)"
  CREATE_TOKEN="$(role "$DEPLOYMENTS/create-31337.json" create-token)"
  CREATE_FAUCET="$(role "$DEPLOYMENTS/create-31337.json" create-faucet)"
  # The newcomer who buys Shares from a member (N5) brings 100 dev USDC.
  cast send "$CURRENCY" "mint(address,uint256)" "$MANAGER" 100000000 --private-key "$KEY_FOUNDER" --rpc-url "$RPC" >/dev/null \
    || fail "could not give the newcomer dev USDC"
  BUILD_ENV=(VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY")
else
  # The deploy writes chain 11155111's manifest and a broadcast record: both go back as they were.
  SEPOLIA_BACKUP="$(mktemp -d)"
  [[ -f "$SEPOLIA_MANIFEST" ]] && cp -p "$SEPOLIA_MANIFEST" "$SEPOLIA_BACKUP/manifest.json"
  trap 'sepolia_restore_artifacts "$SEPOLIA_BACKUP"; rm -rf "$SEPOLIA_BACKUP"; cleanup' EXIT
  step "forking Sepolia into a local anvil on ${RPC}"
  sepolia_fork_up "${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}" "$PORT" "$STATE/anvil.log"
  echo "$FORK_PID" >"$STATE/anvil.pid" # the world's cleanup stops it
  [[ "$FORK_RPC" == "$RPC" ]] || fail "the fork is not where the world expects it ($FORK_RPC, not $RPC)"
  # Deployed from a key of its own, as the real deploy is (anvil's last dev account), not from anyone in the story.
  step "deploying the summoner and both kits with the Sepolia deploy's own script"
  sepolia_deploy_kits "$RPC" 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 "$STATE/deploy.out"
  CONTRIBUTOR_KIT="$(sepolia_role contributor-kit)"
  KIT="$(sepolia_role launch-kit)"
  BOUNTY="$(sepolia_role work-bounty)"
  PAYOUTS_FACTORY="$(sepolia_role payouts-factory)"
  REMIX_BONDS="$(sepolia_role remix-bonds)"
  COURT="$(sepolia_role court)"
  CREATE_TOKEN="$(sepolia_role create-token)"
  CREATE_FAUCET="$(sepolia_role create-faucet)"
  FROM_BLOCK="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).block??"")' "$SEPOLIA_MANIFEST")"
  [[ "$FROM_BLOCK" =~ ^[0-9]+$ ]] || fail "the manifest names no deploy block"
  CURRENCY="$SEPOLIA_USDC"
  # Everyone in the story plays one of anvil's public dev accounts. On the real Sepolia strangers have pointed those at
  # contracts of their own (EIP-7702 delegations), so on the fork they would not be what a tester has: a plain account
  # with a faucet's worth of test ETH. Make them that. Every claim here asks for no money; only the founder needs test USDC,
  # to put money behind a work area (N1): 1,000 of it, written into Circle's balance slot (9) as a faucet would send it.
  for who in "$FOUNDER" "$REVIEWER1" "$REVIEWER2" "$CONTRIBUTOR" "$MANAGER"; do
    cast rpc --rpc-url "$RPC" anvil_setCode "$who" 0x >/dev/null
    cast rpc --rpc-url "$RPC" anvil_setBalance "$who" "$(cast to-hex "$(cast to-wei 0.1)")" >/dev/null
  done
  cast rpc --rpc-url "$RPC" anvil_setStorageAt "$SEPOLIA_USDC" "$(cast index address "$FOUNDER" 9)" \
    "$(cast to-uint256 1000000000)" >/dev/null
  # The newcomer who buys Shares from a member (N5) brings 100 test USDC.
  cast rpc --rpc-url "$RPC" anvil_setStorageAt "$SEPOLIA_USDC" "$(cast index address "$MANAGER" 9)" \
    "$(cast to-uint256 100000000)" >/dev/null
  # A real node refuses an event read from block 0, so a Sepolia build is told where this chain's history starts.
  BUILD_ENV=(VITE_LAUNCHPAD_CHAIN_ID="$SEPOLIA_CHAIN_ID" VITE_CHAIN_RPC_URL="$RPC"
    VITE_HISTORY_FROM_BLOCKS="{\"${SEPOLIA_CHAIN_ID}\":${FROM_BLOCK}}")
fi
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[[ "$CONTRIBUTOR_KIT" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no contributor kit was deployed"
[[ "$KIT" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no launch kit was deployed"
[[ "$BOUNTY" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no work bounty was deployed"
step "chain ${CHAIN_ID}  contributor kit ${CONTRIBUTOR_KIT}  launch kit ${KIT}  work bounty ${BOUNTY}  currency ${CURRENCY}"

# ── the kit refuses the founder limits (D79), whatever page sends it ─────────────────────────────────
# Three calls from the founder that differ only where D79 draws its lines: a third of the budget with other people on the
# panel goes through; one Share more, or the founder on the panel, is refused with InvalidTerms.
step "the contributor kit refuses a founder above a third of the first budget, or on its panel"
E18=000000000000000000
BUDGET_FACTORY="$(cast call "$CONTRIBUTOR_KIT" "budgetFactory()(address)" --rpc-url "$RPC")"
NEXT_BUDGET="$(cast compute-address "$BUDGET_FACTORY" --nonce "$(cast nonce "$BUDGET_FACTORY" --rpc-url "$RPC")" | awk '{print $NF}')"
EXPIRES=$(($(cast block latest --field timestamp --rpc-url "$RPC") + 90 * 86400))
# The first projects are a list (D84): here one, "docs", managed by the founder.
LAUNCH_SIG="launch((string,string,uint256,bytes32,address,uint128,uint128,uint64,address[],uint256,address,(bytes32,address,uint128,uint64,bytes32)[]))(address,address)"
probe() { # <founder Shares, whole> <reviewers, comma-separated>
  cast call "$CONTRIBUTOR_KIT" "$LAUNCH_SIG" \
    "(Probe,PRB,${1}${E18},$(cast keccak d79-probe),${CURRENCY},600${E18},40${E18},${EXPIRES},[${2}],1,${NEXT_BUDGET},[($(cast format-bytes32-string docs),${FOUNDER},40${E18},${EXPIRES},$(cast keccak "docs merged"))])" \
    --from "$FOUNDER" --rpc-url "$RPC" 2>&1
}
INVALID_TERMS="$(cast sig "InvalidTerms()")"
refused() { grep -q -e "$INVALID_TERMS" -e "InvalidTerms" <<<"$1"; }
ALLOWED="$(probe 200 "$REVIEWER1,$REVIEWER2")" || fail "the kit refused a founder with exactly a third: $ALLOWED"
[[ "$(head -1 <<<"$ALLOWED")" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the kit did not answer with a DAO: $ALLOWED"
OVER="$(probe 201 "$REVIEWER1,$REVIEWER2")" && fail "the kit accepted a founder above a third of the budget"
refused "$OVER" || fail "a founder above a third failed, but not with InvalidTerms: $OVER"
ON_PANEL="$(probe 200 "$REVIEWER1,$FOUNDER")" && fail "the kit accepted the founder on the first panel"
refused "$ON_PANEL" || fail "the founder on the panel failed, but not with InvalidTerms: $ON_PANEL"
echo "  ✓ 200 of 600 with two other reviewers: allowed; 201 of 600: InvalidTerms; the founder on the panel: InvalidTerms"

cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  env "${BUILD_ENV[@]}" VITE_CONTRIBUTOR_KITS="{\"${CHAIN_ID}\":\"${CONTRIBUTOR_KIT}\"}" \
    VITE_DAO_LAUNCH_KITS="{\"${CHAIN_ID}\":\"${KIT}\"}" VITE_WORK_BOUNTIES="{\"${CHAIN_ID}\":\"${BOUNTY}\"}" \
    VITE_PAYOUTS_FACTORIES="{\"${CHAIN_ID}\":\"${PAYOUTS_FACTORY}\"}" \
    VITE_REMIX_BONDS="{\"${CHAIN_ID}\":\"${REMIX_BONDS}\"}" VITE_COURTS="{\"${CHAIN_ID}\":\"${COURT}\"}" \
    VITE_CREATE_TOKENS="{\"${CHAIN_ID}\":\"${CREATE_TOKEN}\"}" VITE_CREATE_FAUCETS="{\"${CHAIN_ID}\":\"${CREATE_FAUCET}\"}" \
    node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
FIRST_BLOCK="$(cast block-number --rpc-url "$RPC")"
E2E_ANVIL_URL="$RPC" E2E_KIT="$CONTRIBUTOR_KIT" E2E_BOUNTY="$BOUNTY" E2E_PAYOUTS="$PAYOUTS_FACTORY" E2E_REMIX_BONDS="$REMIX_BONDS" E2E_CREATE_FAUCET="$CREATE_FAUCET" E2E_REVIEWER1="$REVIEWER1" E2E_REVIEWER2="$REVIEWER2" \
  E2E_CONTRIBUTOR="$CONTRIBUTOR" E2E_MANAGER="$MANAGER" E2E_FOUNDER="$FOUNDER" \
  node_modules/.bin/playwright test tests/e2e/contributor-journey.spec.ts --project=smoke --reporter=list "$@"

if [[ "$CHAIN" == "sepolia-fork" ]]; then
  # What each person's transactions cost, so testers know how much test ETH to ask a faucet for.
  step "gas each person used"
  node - "$RPC" "$FIRST_BLOCK" "$FOUNDER:founder" "$CONTRIBUTOR:contributor" "$MANAGER:newcomer" "$REVIEWER1:reviewer" "$REVIEWER2:reviewer 2" <<'NODE'
const [rpc, first, ...people] = process.argv.slice(2);
const call = async (method, params) => {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await res.json()).result;
};
const names = new Map(people.map((p) => { const [a, n] = p.split(":"); return [a.toLowerCase(), n]; }));
const used = new Map([...names.values()].map((n) => [n, { gas: 0n, txs: 0, largest: 0n }]));
const head = Number(BigInt(await call("eth_blockNumber", [])));
for (let b = Number(first) + 1; b <= head; b++) {
  for (const r of (await call("eth_getBlockReceipts", [`0x${b.toString(16)}`])) ?? []) {
    const who = names.get(r.from.toLowerCase());
    if (!who) continue;
    const mine = used.get(who);
    mine.gas += BigInt(r.gasUsed);
    mine.txs += 1;
    if (BigInt(r.gasUsed) > mine.largest) mine.largest = BigInt(r.gasUsed);
  }
}
for (const [who, { gas, txs, largest }] of used) {
  const at20 = Number(gas * 20_000_000_000n) / 1e18;
  console.log(`  ${who}: ${txs} transactions, ${gas} gas, the largest ${largest} (${at20.toFixed(4)} ETH at 20 gwei)`);
}
NODE
fi
