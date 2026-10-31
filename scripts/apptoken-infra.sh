#!/usr/bin/env bash
#
# scripts/apptoken-infra.sh — the LOCAL dev chain's apptoken infrastructure: Limit Break's TokenMaster router, its pool
# factories and the canonical transfer validator (the validator a DAO's Shares can vote onto themselves, see
# scripts/shares-erc20c-e2e.sh). `scripts/dev-chain.sh` runs it as its step 2.
#
# This is the chain setup that used to open scripts/dogfood-raise.sh. That script also minted a token and deployed an
# auction by hand, the raise path from before the launch kit; both were removed in D150 (tag
# pre-deprecation-2026-10-31 has them). New launches make their Shares, DAO and auction in one transaction through the
# launch kit.
#
# ════════════════════════════════════════════════════════════════════════════
# ⚠️  DEV-ONLY. LOCAL ANVIL ONLY. NEVER MAINNET. ⚠️
#
# Both steps below exist ONLY for the packaged apptoken-dev environment and
# must never run against a real chain:
#   1. infra bootstrap — deploys the packaged TokenMaster/CTS/payment
#      infrastructure via apptoken-dev/local-environment/script/bootstrap.sh
#      (unlocked dev accounts + multisig impersonation).
#   2. ROUTER STORAGE PATCH — `allowedTokenFactory` (router slot 1) is written
#      directly with `anvil_setStorageAt` because the packaged environment
#      allowlists phantom factory addresses instead of the deployed ones
#      (contracts/README.md "Minting"; docs/dao-launchpad-plan.md §16). Real
#      chains use the governed admin — never storage surgery. Only minting
#      through the router (the hidden, dev-only `buzz launchpad mint-token`)
#      needs it; it stays so that command still works on a dev chain.
#
# The script refuses to run unless the RPC endpoint is loopback AND the chain
# id is an anvil dev chain (31337 / 1776411).
# ════════════════════════════════════════════════════════════════════════════
#
# Idempotent: re-running skips already-deployed infra and an already-patched
# allowlist. Every failure exits non-zero with the failing step named; the
# final summary lists every step with its address and an ok/skipped/FAILED
# status.
#
# Usage:
#   scripts/apptoken-infra.sh
# Environment overrides:
#   RPC_URL         default http://127.0.0.1:8545
#
# If nothing is listening on RPC_URL the script boots its own anvil and kills
# only that PID on exit; a pre-existing anvil is never killed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Toolchain: prefer the hermit-pinned node/cast when available.
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
# FOUNDRY_BIN (the gate's anvil wrapper, which keeps anvil's on-disk state in a directory the run owns) stays first.
export PATH="${FOUNDRY_BIN:+${FOUNDRY_BIN}:}${HOME}/.foundry/bin:${PATH}"

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"

# Deterministic infrastructure addresses (apptoken-dev bootstrap /
# DeployAppToken.s.sol defaults).
ROUTER="0x0E00009d00d1000069ed00A908e00081F5006008"
STANDARD_FACTORY="0x000000c5F2DF717F497BeAcCE161F8b042310d17"
STABLE_FACTORY="0x0000006a50a9c9Efae8875266ff222579fC2F449"
PROMO_POOL="0x00000014D04B7d1Cad1960eA8980A9af5De2104e"
CANONICAL_TV="0x721C008fdff27BF06E7E123956E2Fe03B63342e3"
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
  echo "════════════════════════ apptoken-infra summary ════════════════════════"
  printf '%-28s %-68s %s\n' "STEP" "ADDRESS" "STATUS"
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
# 0. Environment + safety guard (never mainnet)
# ---------------------------------------------------------------------------

command -v cast >/dev/null || { echo "cast not found (install foundry / activate hermit)" >&2; exit 1; }

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
  # --prune-history=500: the last 500 blocks' state stays in memory (about what anvil keeps there anyway) and none goes to
  # disk. Without it anvil spills older state to ~/.foundry/anvil/tmp (gigabytes on a long run) and leaves it there however
  # it is stopped, SIGINT included.
  anvil --port "${RPC_URL##*:}" --prune-history=500 >/dev/null 2>&1 &
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

echo "════════════════════════ apptoken-infra (LOCAL ANVIL ONLY) ════════════════════════"
echo "rpc:       $RPC_URL (chain-id $CHAIN_ID)"
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
probe_row "create2-proxy" "$ARACHNID_PROXY"
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

print_summary
echo "apptoken-infra: all steps ok/skipped."
