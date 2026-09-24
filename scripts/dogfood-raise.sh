#!/usr/bin/env bash
#
# scripts/dogfood-raise.sh — scripted LOCAL-chain dogfood of the launchpad
# "raise": probe the chain, mint an apptoken the way
# desktop/src/features/launchpad/lib/mintFlow.ts does, verify it, and (when
# the CCA factory exists) deploy an auction per lib/auctionFlow.ts's call
# sequence (GraduationExecutor CREATE -> factory.create).
#
# The calldata is produced by the PRODUCTION TypeScript encoders (mintFlow /
# evmCalls / auctionFlow / graduationArtifact, imported through the desktop
# test loader) so this walks the exact calldata shapes the app composes; the
# transactions are broadcast with `cast send` and anvil's default key 0
# (the deployer is the token treasury, mirroring `treasuryGate`).
#
# ════════════════════════════════════════════════════════════════════════════
# ⚠️  DEV-ONLY. LOCAL ANVIL ONLY. NEVER MAINNET. ⚠️
#
# Two steps below exist ONLY for the packaged apptoken-dev environment and
# must never run against a real chain:
#   1. infra bootstrap — deploys the packaged TokenMaster/CTS/payment
#      infrastructure via apptoken-dev/local-environment/script/bootstrap.sh
#      (unlocked dev accounts + multisig impersonation).
#   2. ROUTER STORAGE PATCH — `allowedTokenFactory` (router slot 1) is written
#      directly with `anvil_setStorageAt` because the packaged environment
#      allowlists phantom factory addresses instead of the deployed ones
#      (contracts/README.md "Minting"; docs/dao-launchpad-plan.md §16). Real
#      chains use the governed admin — never storage surgery.
#
# The script refuses to run unless the RPC endpoint is loopback AND the chain
# id is an anvil dev chain (31337 / 1776411).
# ════════════════════════════════════════════════════════════════════════════
#
# Idempotent: re-running skips already-deployed infra, an already-patched
# allowlist, and an already-minted token (CREATE2 collision guard — the same
# resume semantics as mintHooks/mintFlow). Every failure exits non-zero with
# the failing step named; the final summary lists every step with its tx hash
# or address and an ok/skipped(+reason)/FAILED status.
#
# Usage:
#   scripts/dogfood-raise.sh
# Environment overrides:
#   RPC_URL         default http://127.0.0.1:8545
#   ANVIL_KEY       default anvil dev key 0 (deployer == treasury)
#   APPTOKEN_NAME   default Nebula
#   APPTOKEN_SYMBOL default NEB
#   APPTOKEN_SUPPLY default 1000000 (whole tokens, 18 decimals)
#
# If nothing is listening on RPC_URL the script boots its own anvil and kills
# only that PID on exit; a pre-existing anvil is never killed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Toolchain: prefer the hermit-pinned node/cast when available.
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${HOME}/.foundry/bin:${PATH}"

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
ANVIL_KEY="${ANVIL_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
TOKEN_NAME="${APPTOKEN_NAME:-Nebula}"
TOKEN_SYMBOL="${APPTOKEN_SYMBOL:-NEB}"
TOKEN_SUPPLY="${APPTOKEN_SUPPLY:-1000000}"

# Deterministic infrastructure addresses (apptoken-dev bootstrap /
# DeployAppToken.s.sol defaults / the CCA factory pin in
# contracts/test/LaunchpadFork.t.sol).
ROUTER="0x0E00009d00d1000069ed00A908e00081F5006008"
STANDARD_FACTORY="0x000000c5F2DF717F497BeAcCE161F8b042310d17"
STABLE_FACTORY="0x0000006a50a9c9Efae8875266ff222579fC2F449"
PROMO_POOL="0x00000014D04B7d1Cad1960eA8980A9af5De2104e"
CANONICAL_TV="0x721C008fdff27BF06E7E123956E2Fe03B63342e3"
CCA_FACTORY="0x000000001F26a0044BaA66024e7b6599c61963F8"
PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3"
ARACHNID_PROXY="0x4e59b44847b379578588920cA78FbF26c0B4956C"

# ---------------------------------------------------------------------------
# Step bookkeeping (summary table + named failures)
# ---------------------------------------------------------------------------

STEP_NAMES=()
STEP_ARTIFACTS=()
STEP_STATUS=()

record_step() { # <step> <artifact|-> <status>
  STEP_NAMES+=("$1")
  STEP_ARTIFACTS+=("${2:--}")
  STEP_STATUS+=("$3")
}

print_summary() {
  echo
  echo "════════════════════════ dogfood-raise summary ════════════════════════"
  printf '%-28s %-68s %s\n' "STEP" "TX HASH / ADDRESS" "STATUS"
  printf '%-28s %-68s %s\n' "----" "-----------------" "------"
  local i
  for i in "${!STEP_NAMES[@]}"; do
    printf '%-28s %-68s %s\n' "${STEP_NAMES[$i]}" "${STEP_ARTIFACTS[$i]}" "${STEP_STATUS[$i]}"
  done
  echo "═══════════════════════════════════════════════════════════════════════"
}

fail_step() { # <step> <reason> [artifact]
  echo "FAILED step '$1': $2" >&2
  record_step "$1" "${3:--}" "FAILED — $2"
  print_summary
  exit 1
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

code_bytes() { # <address> -> decimal code size
  local code
  code=$(cast code "$1" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")
  if [[ "$code" == "0x" || -z "$code" ]]; then echo 0; return; fi
  echo $(( (${#code} - 2) / 2 ))
}

# ---------------------------------------------------------------------------
# Transaction broadcast helpers (cast send + receipt JSON)
# ---------------------------------------------------------------------------

RECEIPT_TX="-"
RECEIPT_STATUS="-"
RECEIPT_CONTRACT="-"

parse_receipt() { # <receipt json>
  local parsed
  parsed=$(node -e '
    const r = JSON.parse(process.argv[1]);
    const status =
      r.status === "0x1" || r.status === 1 ? "success" :
      r.status === "0x0" || r.status === 0 ? "reverted" : String(r.status);
    console.log([r.transactionHash ?? "-", status, r.contractAddress ?? "-"].join(" "));
  ' "$1")
  read -r RECEIPT_TX RECEIPT_STATUS RECEIPT_CONTRACT <<<"$parsed"
}

broadcast_call() { # <step> <to> <value-hex> <data>
  local step=$1 to=$2 value=$3 data=$4 out value_dec
  local -a args=(--json --private-key "$ANVIL_KEY" --rpc-url "$RPC_URL")
  # Skip --value for zero (the wire contract's "0x0" is "no native value");
  # pass decimal wei otherwise (cast's value parser is version-dependent on
  # 0x hex).
  if [[ "$value" != "0x0" && "$value" != "0x" ]]; then
    value_dec=$(node -e 'console.log(BigInt(process.argv[1]).toString())' "$value")
    args+=(--value "$value_dec")
  fi
  echo "→ $step: cast send $to (value $value, data ${#data} chars)"
  if ! out=$(cast send "${args[@]}" "$to" "$data" 2>&1); then
    echo "$out"
    fail_step "$step" "cast send failed" "-"
  fi
  parse_receipt "$out"
  if [[ "$RECEIPT_STATUS" != "success" ]]; then
    fail_step "$step" "transaction $RECEIPT_TX mined as $RECEIPT_STATUS" "$RECEIPT_TX"
  fi
  echo "  ✓ $step: tx $RECEIPT_TX (block receipt ok)"
  record_step "$step" "$RECEIPT_TX" "ok"
}

broadcast_create() { # <step> <initcode+args hex>
  local step=$1 data=$2 out
  echo "→ $step: contract creation (data ${#data} chars)"
  if ! out=$(cast send --json --create --private-key "$ANVIL_KEY" \
      --rpc-url "$RPC_URL" "$data" 2>&1); then
    echo "$out"
    fail_step "$step" "cast send --create failed" "-"
  fi
  parse_receipt "$out"
  if [[ "$RECEIPT_STATUS" != "success" ]]; then
    fail_step "$step" "transaction $RECEIPT_TX mined as $RECEIPT_STATUS" "$RECEIPT_TX"
  fi
  echo "  ✓ $step: created $RECEIPT_CONTRACT (tx $RECEIPT_TX)"
  record_step "$step" "$RECEIPT_CONTRACT" "ok — tx $RECEIPT_TX"
}

# ---------------------------------------------------------------------------
# Calldata helper — the PRODUCTION launchpad encoders, one line per call
# ---------------------------------------------------------------------------

run_helper() { # <mode> — prints `KIND payload...` lines (see cases below)
  DOGFOOD_MODE="$1" node \
    --import "$REPO_ROOT/desktop/test-loader.mjs" \
    --experimental-strip-types --input-type=module <<'HELPER_JS'
import {
  addressWordValue,
  buildFactoryCreateCall,
  buildFactoryGetAddressView,
  DEFAULT_AUCTION_SALT,
  DEFAULT_CCA_FACTORY,
  DEFAULT_RESERVE_BPS,
  deriveAuctionDeployParams,
  encodeAuctionConfigData,
} from "@/features/launchpad/lib/auctionFlow";
import { encodeGraduationExecutorDeploy } from "@/features/launchpad/lib/graduationArtifact";
import { prepareDeploy } from "@/features/launchpad/lib/mintFlow";

const RPC = process.env.RPC_URL;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  return body.result;
}

const callPort = (target) => rpc("eth_call", [{ to: target.to, data: target.data }, "latest"]);

const mode = process.env.DOGFOOD_MODE;
if (mode === "mint-prepare") {
  // The exact mintFlow preflight + call composition (mintHooks' deploy path).
  const prepared = await prepareDeploy(
    { call: callPort },
    {
      name: process.env.DOGFOOD_NAME,
      symbol: process.env.DOGFOOD_SYMBOL,
      supply: process.env.DOGFOOD_SUPPLY,
      treasury: process.env.DOGFOOD_TREASURY,
    },
  );
  console.log(`TOKEN_ADDRESS ${prepared.tokenAddress}`);
  console.log(`INFRA_FEE ${prepared.infrastructureFeeBps}`);
  for (const call of prepared.calls) {
    console.log(`CALL ${call.to} ${call.value ?? "0x0"} ${call.data}`);
  }
} else if (mode === "auction-executor") {
  // auctionFlow's sequence step 1: GraduationExecutor CREATE (no `to`).
  console.log(
    `CREATE_DATA ${encodeGraduationExecutorDeploy(process.env.DOGFOOD_TREASURY, DEFAULT_RESERVE_BPS)}`,
  );
} else if (mode === "auction-create") {
  // auctionFlow's sequence step 2: factory CREATE2 (community track: no hook,
  // executor as both recipients).
  const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
  const startBlock = latest + 10;
  const endBlock = startBlock + 100;
  const claimBlock = endBlock + 20;
  const params = deriveAuctionDeployParams({
    token: process.env.DOGFOOD_TOKEN,
    tokenSupply: process.env.DOGFOOD_SUPPLY,
    currency: null,
    floorPrice: String(2n ** 96n),
    tickSpacing: "2",
    requiredRaised: "1000000",
    startBlock,
    endBlock,
    claimBlock,
    treasury: process.env.DOGFOOD_TREASURY,
    admission: "community",
  });
  const configData = encodeAuctionConfigData({
    params,
    executor: process.env.DOGFOOD_EXECUTOR,
    hook: null,
  });
  const view = buildFactoryGetAddressView({
    factory: DEFAULT_CCA_FACTORY,
    params,
    configData,
    salt: DEFAULT_AUCTION_SALT,
    sender: process.env.DOGFOOD_TREASURY,
  });
  const auctionAddress = addressWordValue(await callPort(view));
  const createCall = buildFactoryCreateCall({
    factory: DEFAULT_CCA_FACTORY,
    params,
    configData,
    salt: DEFAULT_AUCTION_SALT,
  });
  console.log(`AUCTION_ADDRESS ${auctionAddress}`);
  console.log(`CALL ${createCall.to} ${createCall.value ?? "0x0"} ${createCall.data}`);
} else {
  throw new Error(`unknown DOGFOOD_MODE: ${mode}`);
}
HELPER_JS
}

# ---------------------------------------------------------------------------
# 0. Environment + safety guard (never mainnet)
# ---------------------------------------------------------------------------

command -v cast >/dev/null || { echo "cast not found (install foundry / activate hermit)" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found (activate hermit)" >&2; exit 1; }

OWN_ANVIL_PID=""
cleanup() {
  if [[ -n "$OWN_ANVIL_PID" ]]; then
    echo "(stopping the anvil this script booted: PID $OWN_ANVIL_PID)"
    kill "$OWN_ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if ! cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "no anvil at $RPC_URL — booting one (killed on exit; a pre-existing anvil is never touched)"
  anvil --port "${RPC_URL##*:}" >/dev/null 2>&1 &
  OWN_ANVIL_PID=$!
  for _ in $(seq 1 50); do
    cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
    sleep 0.2
  done
  cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 \
    || { echo "anvil did not start" >&2; exit 1; }
fi

CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
case "$RPC_URL" in
  http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*) ;;
  *)
    echo "REFUSING: RPC_URL $RPC_URL is not loopback. This script patches router storage and impersonates accounts — local anvil only, NEVER mainnet." >&2
    exit 1
    ;;
esac
case "$CHAIN_ID" in
  31337|1776411) ;;
  *)
    echo "REFUSING: chain id $CHAIN_ID is not an anvil dev chain (31337/1776411). NEVER run this against mainnet." >&2
    exit 1
    ;;
esac

SENDER=$(cast wallet address --private-key "$ANVIL_KEY")
TREASURY="$SENDER" # v1 contract: the deployer IS the treasury (treasuryGate)
export RPC_URL DOGFOOD_TREASURY="$TREASURY" DOGFOOD_NAME="$TOKEN_NAME" \
  DOGFOOD_SYMBOL="$TOKEN_SYMBOL" DOGFOOD_SUPPLY="$TOKEN_SUPPLY"

echo "════════════════════════ dogfood-raise (LOCAL ANVIL ONLY) ════════════════════════"
echo "rpc:       $RPC_URL (chain-id $CHAIN_ID)"
echo "deployer:  $SENDER (anvil key 0 — also the token treasury)"
echo "token:     $TOKEN_NAME / $TOKEN_SYMBOL / supply $TOKEN_SUPPLY (whole tokens)"
echo

# ---------------------------------------------------------------------------
# 1. Probe: what is already on this chain?
# ---------------------------------------------------------------------------

BLOCK=$(cast block-number --rpc-url "$RPC_URL")
echo "── probe: chain-id $CHAIN_ID at block $BLOCK"
probe_row() {
  printf '  %-22s %-46s %8s bytes\n' "$1" "$2" "$(code_bytes "$2")"
}
probe_row "tokenmaster-router" "$ROUTER"
probe_row "standard-pool-factory" "$STANDARD_FACTORY"
probe_row "stable-pool-factory" "$STABLE_FACTORY"
probe_row "promotional-pool" "$PROMO_POOL"
probe_row "transfer-validator-v5" "$CANONICAL_TV"
probe_row "cca-factory" "$CCA_FACTORY"
probe_row "permit2" "$PERMIT2"
probe_row "create2-proxy" "$ARACHNID_PROXY"
DEPLOYMENTS_JSON="$REPO_ROOT/contracts/deployments/apptoken-latest.json"
if [[ -f "$DEPLOYMENTS_JSON" ]]; then
  LAST_TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token)' "$DEPLOYMENTS_JSON")
  probe_row "deployments-latest" "$LAST_TOKEN"
else
  LAST_TOKEN=""
fi
record_step "probe" "block $BLOCK" "ok — chain-id $CHAIN_ID"

# ---------------------------------------------------------------------------
# 2. Infrastructure bootstrap (DEV-ONLY; idempotent)
# ---------------------------------------------------------------------------

if [[ "$(code_bytes "$ROUTER")" == "0" || "$(code_bytes "$STANDARD_FACTORY")" == "0" \
   || "$(code_bytes "$CANONICAL_TV")" == "0" ]]; then
  echo
  echo "── infra-bootstrap: apptoken infrastructure missing — running the packaged bootstrap"
  echo "   (DEV-ONLY: unlocked dev accounts + multisig impersonation on local anvil)"
  if [[ "$(code_bytes "$ARACHNID_PROXY")" == "0" ]]; then
    echo "   deploying the deterministic CREATE2 factory ($ARACHNID_PROXY)"
    cast rpc anvil_setBalance 0x3fab184622dc19b6109349b94811493bf2a45362 \
      0xDE0B6B3A7640000 --rpc-url "$RPC_URL" >/dev/null
    cast publish \
      0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378163000000016000396000f3005820a]a465a695823124c04e363795aaee141612864f091e65bdc3baa755e18a7b1233880e4f8400d6ca6c001ca077c024b8b3aff8810719baf804159088e4085a83b401e45a347f60abb7c340a02349d6066ea5a31910aabd5e589a2a1cc8c0a20ad81f78e2fd3eb09382d4e1 \
      --rpc-url "$RPC_URL" >/dev/null
  fi
  if ! bash "$REPO_ROOT/apptoken-dev/local-environment/script/bootstrap.sh"; then
    fail_step "infra-bootstrap" "bootstrap.sh failed (step named in its output above)"
  fi
  record_step "infra-bootstrap" "$ROUTER" "ok — apptoken-dev bootstrap (DEV-ONLY)"
else
  echo
  echo "── infra-bootstrap: already present (router/factory/validator have code) — skipped"
  record_step "infra-bootstrap" "$ROUTER" "skipped — already deployed"
fi

# ---------------------------------------------------------------------------
# 3. Router allowlist patch (DEV-ONLY storage surgery; never mainnet)
#    contracts/README.md "Minting" / docs/dao-launchpad-plan.md §16: the
#    packaged env allowlists phantom factories; enable the real three via
#    `allowedTokenFactory` (router slot 1) with anvil_setStorageAt.
# ---------------------------------------------------------------------------

echo
echo "┌────────────────────────────────────────────────────────────────────────────┐"
echo "│ DEV-ONLY STORAGE PATCH (LOCAL ANVIL) — router.allowedTokenFactory, slot 1 │"
echo "│ This exists because the packaged env allowlists phantom factory addresses. │"
echo "│ NEVER mainnet: real chains use the governed admin (setAllowedTokenFactory).│"
echo "└────────────────────────────────────────────────────────────────────────────┘"
# Layout sanity (non-fatal): uint16 infrastructureFeeBPS occupies slot 0, so
# storage slot 0 must read back the same fee `infrastructureFeeBPS()` reports.
FEE_VIEW=$(cast call "$ROUTER" "infrastructureFeeBPS()(uint16)" --rpc-url "$RPC_URL" | head -1 | tr -d ' ')
SLOT0=$(cast storage "$ROUTER" 0 --rpc-url "$RPC_URL")
echo "  layout sanity: infrastructureFeeBPS()=$FEE_VIEW, storage slot 0=$(lower "$SLOT0")"

patched=()
for factory in "$STANDARD_FACTORY" "$STABLE_FACTORY" "$PROMO_POOL"; do
  allowed=$(cast call "$ROUTER" "allowedTokenFactory(address)(bool)" "$factory" \
    --rpc-url "$RPC_URL" | head -1 | tr -d ' ')
  if [[ "$allowed" == "true" ]]; then
    echo "  ✓ $factory already allowlisted"
    continue
  fi
  slot=$(cast index address "$factory" 1)
  echo "  patching allowedTokenFactory[$factory] (slot $(lower "$slot")) -> true"
  cast rpc anvil_setStorageAt "$ROUTER" "$slot" \
    0x0000000000000000000000000000000000000000000000000000000000000001 \
    --rpc-url "$RPC_URL" >/dev/null
  readback=$(cast call "$ROUTER" "allowedTokenFactory(address)(bool)" "$factory" \
    --rpc-url "$RPC_URL" | head -1 | tr -d ' ')
  if [[ "$readback" != "true" ]]; then
    fail_step "router-allowlist-patch" "read-back for $factory is '$readback', expected true (slot-1 layout assumption wrong?)"
  fi
  patched+=("$(lower "$factory")")
done
if [[ ${#patched[@]} -eq 0 ]]; then
  record_step "router-allowlist-patch" "$ROUTER" "skipped — real factories already allowlisted"
else
  record_step "router-allowlist-patch" "$ROUTER" "ok (DEV-ONLY) — patched ${#patched[@]} factories"
fi

# ---------------------------------------------------------------------------
# 4. Mint: router.deployToken -> token.setTransferValidator ->
#    realTV.setRulesetOfCollection — mintFlow.ts's exact 3-call sequence
# ---------------------------------------------------------------------------

echo
echo "── mint: preparing via the production mintFlow encoder (prepareDeploy)"
PREPARE_OUT=$(run_helper mint-prepare) || fail_step "mint-prepare" "prepareDeploy failed (router fee / computeDeploymentAddress preflight)"
TOKEN="" CALL_TO=() CALL_VALUE=() CALL_DATA=()
while read -r kind a b c; do
  case "$kind" in
    TOKEN_ADDRESS) TOKEN="$a" ;;
    INFRA_FEE)     echo "  live infrastructureFeeBPS: $a" ;;
    CALL)          CALL_TO+=("$a"); CALL_VALUE+=("$b"); CALL_DATA+=("$c") ;;
  esac
done <<<"$PREPARE_OUT"
[[ -n "$TOKEN" && ${#CALL_DATA[@]} -eq 3 ]] \
  || fail_step "mint-prepare" "helper returned an unexpected plan (token=$TOKEN calls=${#CALL_DATA[@]})"
echo "  precomputed CREATE2 token address: $TOKEN"
if [[ -n "$LAST_TOKEN" && "$(lower "$LAST_TOKEN")" == "$(lower "$TOKEN")" ]]; then
  echo "  cross-check: matches contracts/deployments/apptoken-latest.json ✓"
else
  echo "  cross-check: deployments/apptoken-latest.json has ${LAST_TOKEN:-<none>} (a different plan/chain — informational)"
fi

MINT_STEPS=("mint-deployToken" "mint-setTransferValidator" "mint-setRulesetOfCollection")
real_tv="$CANONICAL_TV" # buildTokenDeployCalls resolves a zero TV to the canonical one

for i in 0 1 2; do
  step="${MINT_STEPS[$i]}"
  if [[ $i -eq 0 && "$(code_bytes "$TOKEN")" != "0" ]]; then
    # mintHooks/mintFlow resume semantics: an already-created token is never
    # re-sent (the CREATE2 address would collide and revert).
    echo "→ $step: token already deployed at $TOKEN — skipping (idempotent)"
    record_step "$step" "$TOKEN" "skipped — token already deployed"
    continue
  fi
  if [[ $i -eq 1 ]]; then
    wired=$(cast call "$TOKEN" "getTransferValidator()(address)" --rpc-url "$RPC_URL" | head -1 | tr -d ' ')
    if [[ "$(lower "$wired")" == "$(lower "$real_tv")" ]]; then
      echo "→ $step: validator already wired to $real_tv — skipping (idempotent)"
      record_step "$step" "$real_tv" "skipped — validator already wired"
      continue
    fi
  fi
  # Step 3 (setRulesetOfCollection) always re-runs: the TV exposes no
  # collection-ruleset getter, so re-applying the same Vanilla ruleset is the
  # only idempotent-in-effect recovery (exactly mintFlow's resume behavior).
  broadcast_call "$step" "${CALL_TO[$i]}" "${CALL_VALUE[$i]}" "${CALL_DATA[$i]}"
done

# ---------------------------------------------------------------------------
# 5. Verify the mint (view reads + balanceOf)
# ---------------------------------------------------------------------------

echo
echo "── verify: token $TOKEN"
token_code=$(code_bytes "$TOKEN")
[[ "$token_code" != "0" ]] || fail_step "verify-token" "no code at the computed CREATE2 address $TOKEN"
echo "  ✓ code at token: $token_code bytes"
validator=$(cast call "$TOKEN" "getTransferValidator()(address)" --rpc-url "$RPC_URL" | head -1 | tr -d ' ')
[[ "$(lower "$validator")" == "$(lower "$CANONICAL_TV")" ]] \
  || fail_step "verify-token" "getTransferValidator()=$validator, expected $CANONICAL_TV"
echo "  ✓ validator wired: $validator"
vanilla=$(cast call "$CANONICAL_TV" "boundRuleset(uint8)(address)" 1 --rpc-url "$RPC_URL" | head -1 | tr -d ' ')
if [[ "$(lower "$vanilla")" == "0x0000000000000000000000000000000000000000" ]]; then
  fail_step "verify-token" "ruleset id 1 (Vanilla) is not bound on the validator"
fi
echo "  ✓ Vanilla ruleset bound on the validator: $vanilla"
balance=$(cast call "$TOKEN" "balanceOf(address)(uint256)" "$TREASURY" --rpc-url "$RPC_URL" | head -1)
balance=${balance%% *} # strip cast's " [1eN]" hint
# StandardPool.sol:127-128 mints 1 wei to the TokenMaster router as a
# permanent lock and `initialSupplyAmount - 1` to the initial supply
# recipient; total supply is the full `initialSupplyAmount`.
expected_total=$(node -e 'console.log((BigInt(process.argv[1]) * 10n ** 18n).toString())' "$TOKEN_SUPPLY")
expected_treasury=$(node -e 'console.log((BigInt(process.argv[1]) * 10n ** 18n - 1n).toString())' "$TOKEN_SUPPLY")
total=$(cast call "$TOKEN" "totalSupply()(uint256)" --rpc-url "$RPC_URL" | head -1)
total=${total%% *}
[[ "$total" == "$expected_total" ]] \
  || fail_step "verify-token" "totalSupply $total != expected $expected_total (${TOKEN_SUPPLY} * 1e18)"
[[ "$balance" == "$expected_treasury" ]] \
  || fail_step "verify-token" "treasury balance $balance != expected $expected_treasury (supply minus StandardPool's 1-wei router lock — StandardPool.sol:127-128)"
router_lock=$(cast call "$TOKEN" "balanceOf(address)(uint256)" "$ROUTER" --rpc-url "$RPC_URL" | head -1)
router_lock=${router_lock%% *}
[[ "$router_lock" == "1" ]] \
  || fail_step "verify-token" "router lock balance $router_lock != 1 wei (StandardPool.sol:127-128)"
echo "  ✓ initial supply: totalSupply $total; treasury $balance (= supply − 1 wei); router lock $router_lock wei"
record_step "verify-token" "$TOKEN" "ok — code + validator + ruleset + supply"

# ---------------------------------------------------------------------------
# 6. Auction deploy (executor CREATE -> factory.create) — only when the CCA
#    factory exists on this chain (it is a mainnet-fork pin; bare anvil has it
#    only when someone deployed it)
# ---------------------------------------------------------------------------

echo
if [[ "$(code_bytes "$CCA_FACTORY")" == "0" ]]; then
  echo "auction deploy skipped — factory not on this chain (fork-only)"
  record_step "auction-deploy" "-" "skipped — factory not on this chain (fork-only)"
else
  echo "── auction: deploying per auctionFlow's sequence (executor CREATE -> factory.create)"
  EXEC_OUT=$(run_helper auction-executor) || fail_step "auction-executor" "encodeGraduationExecutorDeploy failed"
  CREATE_DATA=${EXEC_OUT#CREATE_DATA }
  [[ -n "$CREATE_DATA" && "$CREATE_DATA" == 0x* ]] \
    || fail_step "auction-executor" "helper returned no CREATE_DATA"
  broadcast_create "auction-executor-create" "$CREATE_DATA"
  EXECUTOR="$RECEIPT_CONTRACT"
  [[ "$EXECUTOR" != "-" && -n "$EXECUTOR" ]] \
    || fail_step "auction-executor-create" "receipt carried no contractAddress"

  CREATE_OUT=$(DOGFOOD_EXECUTOR="$EXECUTOR" DOGFOOD_TOKEN="$TOKEN" run_helper auction-create) \
    || fail_step "auction-factory-create" "auction plan derivation failed (see helper output)"
  AUCTION="" AUC_TO="" AUC_VALUE="" AUC_DATA=""
  while read -r kind a b c; do
    case "$kind" in
      AUCTION_ADDRESS) AUCTION="$a" ;;
      CALL)            AUC_TO="$a"; AUC_VALUE="$b"; AUC_DATA="$c" ;;
    esac
  done <<<"$CREATE_OUT"
  [[ -n "$AUCTION" && -n "$AUC_DATA" ]] \
    || fail_step "auction-factory-create" "helper returned an unexpected plan"
  echo "  precomputed CREATE2 auction address: $AUCTION"
  broadcast_call "auction-factory-create" "$AUC_TO" "$AUC_VALUE" "$AUC_DATA"
  [[ "$(code_bytes "$AUCTION")" != "0" ]] \
    || fail_step "verify-auction" "factory confirmed but there is no code at $AUCTION"
  echo "  ✓ auction live at $AUCTION"
  record_step "verify-auction" "$AUCTION" "ok — code present (executor $EXECUTOR)"
fi

print_summary
echo "dogfood-raise: all steps ok/skipped."
