#!/usr/bin/env bash
#
# scripts/web-rounds-e2e.sh — weekly rounds (D131), entirely from the WEB app, on a REAL chain.
#
# Boots a throwaway chain with the contributor kit and the rounds contract on it: by default a local dev chain; with
# --sepolia-fork, a local fork of Sepolia with the contracts deployed by the Sepolia deploy's own Forge script and the web
# app built with the settings a hosted Sepolia build uses. Then it runs web/tests/e2e/rounds-journey.spec.ts: the founder
# starts a contributor project and puts 200 USDC in its treasury; the DAO votes weekly rounds in; 30 days later a
# newcomer switches them on and opens a round; the founder offers 50 Shares at 1 USDC or more, two buyers bid for 30 each
# at up to 1.30; the round settles at 1.30 and everyone collects: the founder 62 USDC, the treasury 3 more and nothing
# paid out, each buyer 25 Shares. On the fork it ends with the gas each person's transactions used.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain or a local fork, nothing public.
#
# Usage:  scripts/web-rounds-e2e.sh [--sepolia-fork] [playwright args]
# Env:    ANVIL_PORT, SKIP_BUILD=1 (reuse web/dist: only if it was built by this script for the same chain),
#         SEPOLIA_RPC_URL (--sepolia-fork: the node to fork; default a public one)

CHAIN=local
if [[ "${1:-}" == "--sepolia-fork" ]]; then CHAIN=sepolia-fork; shift; fi
WORLD_NAME=web-rounds
[[ "$CHAIN" == "sepolia-fork" ]] && WORLD_NAME=web-rounds-sepolia-fork
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

# The founder brings 1,000 USDC (200 of it for the treasury); each buyer 100.
if [[ "$CHAIN" == "local" ]]; then
  world_up
  CONTRIBUTOR_KIT="$(role "$DEPLOYMENTS/contributor-kit-31337.json" contributor-kit)"
  WEEKLY_ROUNDS="$(role "$DEPLOYMENTS/weekly-rounds-31337.json" weekly-rounds)"
  for pair in "$FOUNDER:1000000000" "$MANAGER:100000000" "$CONTRIBUTOR:100000000"; do
    cast send "$CURRENCY" "mint(address,uint256)" "${pair%%:*}" "${pair##*:}" --private-key "$KEY_FOUNDER" --rpc-url "$RPC" \
      >/dev/null || fail "could not give ${pair%%:*} dev USDC"
  done
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
  step "deploying the summoner, both kits and the rounds with the Sepolia deploy's own script"
  sepolia_deploy_kits "$RPC" 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 "$STATE/deploy.out"
  CONTRIBUTOR_KIT="$(sepolia_role contributor-kit)"
  WEEKLY_ROUNDS="$(sepolia_role weekly-rounds)"
  FROM_BLOCK="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).block??"")' "$SEPOLIA_MANIFEST")"
  [[ "$FROM_BLOCK" =~ ^[0-9]+$ ]] || fail "the manifest names no deploy block"
  CURRENCY="$SEPOLIA_USDC"
  # Everyone plays one of anvil's public dev accounts; on the real Sepolia strangers have pointed those at contracts of
  # their own (EIP-7702), so make them plain accounts with a faucet's worth of test ETH, and write their test USDC into
  # Circle's balance slot (9) as a faucet would send it.
  for who in "$FOUNDER" "$REVIEWER1" "$REVIEWER2" "$CONTRIBUTOR" "$MANAGER"; do
    cast rpc --rpc-url "$RPC" anvil_setCode "$who" 0x >/dev/null
    cast rpc --rpc-url "$RPC" anvil_setBalance "$who" "$(cast to-hex "$(cast to-wei 0.1)")" >/dev/null
  done
  for pair in "$FOUNDER:1000000000" "$MANAGER:100000000" "$CONTRIBUTOR:100000000"; do
    cast rpc --rpc-url "$RPC" anvil_setStorageAt "$SEPOLIA_USDC" "$(cast index address "${pair%%:*}" 9)" \
      "$(cast to-uint256 "${pair##*:}")" >/dev/null
  done
  # A real node refuses an event read from block 0, so a Sepolia build is told where this chain's history starts.
  BUILD_ENV=(VITE_LAUNCHPAD_CHAIN_ID="$SEPOLIA_CHAIN_ID" VITE_CHAIN_RPC_URL="$RPC"
    VITE_HISTORY_FROM_BLOCKS="{\"${SEPOLIA_CHAIN_ID}\":${FROM_BLOCK}}")
fi
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[[ "$CONTRIBUTOR_KIT" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no contributor kit was deployed"
[[ "$WEEKLY_ROUNDS" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no weekly rounds were deployed"
[[ "$(cast call "$WEEKLY_ROUNDS" "currency()(address)" --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')" == "$(tr '[:upper:]' '[:lower:]' <<<"$CURRENCY")" ]] \
  || fail "the rounds are not paid in this chain's USDC"
step "chain ${CHAIN_ID}  contributor kit ${CONTRIBUTOR_KIT}  weekly rounds ${WEEKLY_ROUNDS}  currency ${CURRENCY}"

cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  env "${BUILD_ENV[@]}" VITE_CONTRIBUTOR_KITS="{\"${CHAIN_ID}\":\"${CONTRIBUTOR_KIT}\"}" \
    VITE_WEEKLY_ROUNDS="{\"${CHAIN_ID}\":\"${WEEKLY_ROUNDS}\"}" \
    node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
FIRST_BLOCK="$(cast block-number --rpc-url "$RPC")"
E2E_ANVIL_URL="$RPC" E2E_KIT="$CONTRIBUTOR_KIT" E2E_WEEKLY_ROUNDS="$WEEKLY_ROUNDS" E2E_CURRENCY="$CURRENCY" \
  E2E_REVIEWER1="$REVIEWER1" E2E_REVIEWER2="$REVIEWER2" E2E_CONTRIBUTOR="$CONTRIBUTOR" E2E_MANAGER="$MANAGER" \
  E2E_FOUNDER="$FOUNDER" \
  node_modules/.bin/playwright test tests/e2e/rounds-journey.spec.ts --project=smoke --reporter=list "$@"

if [[ "$CHAIN" == "sepolia-fork" ]]; then
  # What each person's transactions cost, so testers know how much test ETH to ask a faucet for.
  step "gas each person used"
  node - "$RPC" "$FIRST_BLOCK" "$FOUNDER:founder" "$MANAGER:newcomer" "$CONTRIBUTOR:second buyer" <<'NODE'
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
