#!/usr/bin/env bash
#
# scripts/lib/lbamm-world.sh — a throwaway dev chain with the Limit Break AMM (LBAMM) deployed on it, next to our own
# contracts. Sourced by the LBAMM scripts, on top of `no-raise-world.sh`.
#
# ⚠️  DEV ONLY. A local chain, anvil's public keys, and LBAMM's evaluation-only source.
#
# LBAMM's licence allows local evaluation and proof-of-concept work and forbids deploying it to a live network, and
# it is not in this repository: point LBAMM_DIR at a clone of github.com/limitbreakinc/lbamm-examples made with
# `--recurse-submodules`, kept OUTSIDE this repo. Nothing from it is copied here; this script only runs it.
#
# Sets: LBAMM (the AMM), LBAMM_HOOK (the standard hook), LBAMM_REGISTRY (the hook settings registry),
#       LBAMM_DYNAMIC (the dynamic pool type), LBAMM_PERMIT (the permit transfer handler), LBAMM_VALIDATOR.

# shellcheck source=no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/no-raise-world.sh"

lbamm_up() {
  [[ -n "${LBAMM_DIR:-}" ]] || fail "set LBAMM_DIR to a --recurse-submodules clone of limitbreakinc/lbamm-examples (outside this repo)"
  local deploy="$LBAMM_DIR/environment/lbamm-deploy" infra="$LBAMM_DIR/environment/apptoken-dev/local-environment"
  [[ -f "$deploy/script/DeployAMM.s.sol" && -f "$infra/script/bootstrap.sh" && -f "$deploy/lib/lbamm-core/src/LimitBreakAMM.sol" ]] \
    || fail "LBAMM_DIR=$LBAMM_DIR is not a complete clone (missing submodules?)"
  case "$LBAMM_DIR" in "$REPO_ROOT"/*) fail "LBAMM_DIR must be outside this repository: its licence does not allow it in here" ;; esac

  # The deterministic deployment proxy that LBAMM's scripts create their contracts through. A fresh anvil has none.
  if [[ "$(cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url "$RPC")" == "0x" ]]; then
    step "placing the deterministic deployment proxy"
    cast rpc --rpc-url "$RPC" anvil_setCode 0x4e59b44847b379578588920cA78FbF26c0B4956C \
      0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3 >/dev/null
  fi

  step "bootstrapping the apptoken infrastructure LBAMM expects (anything already here is skipped)"
  RPC_URL="$RPC" bash "$infra/script/bootstrap.sh" >"$STATE/lbamm-bootstrap.out" 2>&1 \
    || { tail -20 "$STATE/lbamm-bootstrap.out"; fail "the apptoken bootstrap failed"; }

  step "building and deploying LBAMM"
  local out="$STATE/lbamm-deploy.out"
  ( cd "$deploy" \
    && DEPLOYER_PRIVATE_KEY="$KEY_FOUNDER" DEFAULT_OWNER_KEY="$KEY_FOUNDER" RPC_URL="$RPC" NO_COLOR=1 \
       forge script script/DeployAMM.s.sol:DeployScript --rpc-url "$RPC" --broadcast >"$out" 2>&1 ) \
    || { tail -30 "$out"; fail "the LBAMM deploy script failed"; }
  local addresses
  addresses=$(node "$REPO_ROOT/scripts/lib/lbamm-replay.mjs" "$RPC" <"$out" 2>"$STATE/lbamm-replay.err") \
    || { tail -20 "$STATE/lbamm-replay.err"; fail "replaying LBAMM's post-deploy steps failed"; }
  LBAMM=$(echo "$addresses" | jget LIMIT_BREAK_AMM)
  LBAMM_HOOK=$(echo "$addresses" | jget STANDARD_HOOK)
  LBAMM_REGISTRY=$(echo "$addresses" | jget SETTINGS_REGISTRY)
  LBAMM_DYNAMIC=$(echo "$addresses" | jget DYNAMIC_POOL_TYPE)
  LBAMM_PERMIT=$(echo "$addresses" | jget PERMIT_TRANSFER_HANDLER)
  LBAMM_VALIDATOR=$(echo "$addresses" | jget TRANSFER_VALIDATOR)
  [[ "$(cast code "$LBAMM" --rpc-url "$RPC")" != "0x" ]] || fail "no LBAMM code at $LBAMM"
  step "LBAMM ${LBAMM}  standard hook ${LBAMM_HOOK}  dynamic pools ${LBAMM_DYNAMIC}"
}
