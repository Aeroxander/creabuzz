#!/usr/bin/env bash
#
# scripts/lib/sepolia-fork.sh — a local anvil forked from Sepolia, and the launch path deployed on it by the same Forge
# script that deploys it to the real network. Sourced by `scripts/sepolia-deploy.sh` (its rehearsal) and
# `scripts/web-contributor-e2e.sh --sepolia-fork`.
#
# Provides (the caller has `fail`, `step` and foundry on PATH):
#   SEPOLIA_CHAIN_ID, SEPOLIA_USDC, SEPOLIA_MANIFEST (the manifest DeployLaunchKit writes for chain 11155111)
#   sepolia_fork_up <fork url> <port> <log file>    boots the fork; sets FORK_RPC and FORK_PID
#   sepolia_deploy_kits <rpc> <key> <log file>      deploys the summoner and both kits (contracts/script/DeployLaunchKit.s.sol)
#   sepolia_role <role>                             an address from that manifest ("launch-kit", "contributor-kit", ...)
#   sepolia_deploy_gas                              "<gas> <transactions> <largest gas limit>" of the last deploy, from Forge's
#                                                   broadcast record
#   sepolia_restore_artifacts <backup dir>          after a rehearsal: puts the manifest back as it was, drops the record

SEPOLIA_CHAIN_ID=11155111
# The most gas one transaction may ask for since Fusaka (EIP-7825, 2^24). Anvil does not enforce it on a fork, so the
# rehearsal checks the deploy's own transactions against it.
SEPOLIA_TX_GAS_CAP=16777216
# Circle's USDC on Sepolia. It has no open mint: a fork funds a wallet by writing its balance (slot 9 of `balanceOf`).
SEPOLIA_USDC=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
_SEPOLIA_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SEPOLIA_MANIFEST="$_SEPOLIA_REPO/contracts/deployments/dao-launch-kit-${SEPOLIA_CHAIN_ID}.json"
_SEPOLIA_BROADCASTS="$_SEPOLIA_REPO/contracts/broadcast/DeployLaunchKit.s.sol/${SEPOLIA_CHAIN_ID}"

sepolia_fork_up() { # <fork url> <port> <log file>
  local fork_url="$1" port="$2" log="$3" head
  FORK_RPC="http://127.0.0.1:${port}"
  # A few blocks behind the head: a public node answers from several backends, and the newest block is not on all of them
  # yet ("block not found" while the fork is being made).
  head="$(cast block-number --rpc-url "$fork_url" 2>/dev/null || true)"
  [[ "$head" =~ ^[0-9]+$ ]] || fail "could not read the head of $fork_url"
  # --prune-history=500: the last 500 blocks' state stays in memory (about what anvil keeps there anyway) and none goes to
  # disk. Without it anvil spills older state to ~/.foundry/anvil/tmp (gigabytes on a long run) and leaves it there however
  # it is stopped, SIGINT included.
  anvil --fork-url "$fork_url" --fork-block-number "$((head - 10))" --port "$port" --prune-history=500 --silent >"$log" 2>&1 &
  FORK_PID=$!
  for _ in $(seq 1 60); do
    if [[ "$(cast chain-id --rpc-url "$FORK_RPC" 2>/dev/null || true)" == "$SEPOLIA_CHAIN_ID" ]]; then
      # Forking ten blocks back leaves the fork's clock about two minutes behind; real Sepolia's head is within seconds of
      # now. Set it to now, or anything stamped by a clock (a forecast's time against a release's) looks out of order.
      cast rpc anvil_setTime "$(date +%s)" --rpc-url "$FORK_RPC" >/dev/null || fail "could not set the fork's clock"
      return 0
    fi
    kill -0 "$FORK_PID" 2>/dev/null || { tail -20 "$log"; fail "anvil exited"; }
    sleep 1
  done
  fail "the fork did not come up as Sepolia"
}

# SEPOLIA_FORGE_ARGS (optional) is added to the forge script call. A real deploy on Sepolia needs it: since the network's
# gas repricing the node asks several times what a local fork does for the same contract, so pass --skip-simulation (use
# the node's own estimate) and a small --priority-gas-price. Left unset, the call is the rehearsal's.
sepolia_deploy_kits() { # <rpc> <key> <log file>
  local rpc="$1" key="$2" log="$3"
  (cd "$_SEPOLIA_REPO/contracts" && FOUNDRY_LINT_LINT_ON_BUILD=false forge build >/dev/null) || fail "forge build failed"
  (cd "$_SEPOLIA_REPO/contracts" && PRIVATE_KEY="$key" forge script script/DeployLaunchKit.s.sol --rpc-url "$rpc" --broadcast ${SEPOLIA_FORGE_ARGS:-} >"$log" 2>&1) \
    || { tail -40 "$log"; fail "forge script failed"; }
  [[ -f "$SEPOLIA_MANIFEST" ]] || fail "the deploy wrote no manifest ($SEPOLIA_MANIFEST)"
}

sepolia_role() { # <role>
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log((m.roles ?? []).find((r) => r.role === process.argv[2])?.address ?? "");
  ' "$SEPOLIA_MANIFEST" "$1"
}

sepolia_deploy_gas() {
  node -e '
    const run = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const receipts = run.receipts ?? [];
    const gas = receipts.reduce((sum, r) => sum + BigInt(r.gasUsed), 0n);
    const largest = (run.transactions ?? []).reduce((max, t) => {
      const limit = BigInt(t.transaction.gas ?? 0);
      return limit > max ? limit : max;
    }, 0n);
    console.log(`${gas} ${receipts.length} ${largest}`);
  ' "$_SEPOLIA_BROADCASTS/run-latest.json"
}

sepolia_restore_artifacts() { # <backup dir holding manifest.json when there was one>
  rm -f "$SEPOLIA_MANIFEST"
  if [[ -f "$1/manifest.json" ]]; then cp -p "$1/manifest.json" "$SEPOLIA_MANIFEST"; fi
  rm -rf "$_SEPOLIA_BROADCASTS"
}
