#!/usr/bin/env bash
# Launchpad Sepolia fork: local Anvil + full contract suite.
#
# Boots Anvil forked from Sepolia (unless one is already on RPC_PORT), then
# runs unit, pin-proof, and fork tests. Needs SEPOLIA_RPC_URL in the
# environment (see .env — never commit it).
#
# Usage:
#   scripts/launchpad-anvil-fork.sh
#   RPC_PORT=18545 scripts/launchpad-anvil-fork.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"
RPC_HOST="${RPC_HOST:-127.0.0.1}"
RPC_PORT="${RPC_PORT:-8545}"
RPC_URL="${RPC_URL:-http://$RPC_HOST:$RPC_PORT}"
FORK_BLOCK="${SEPOLIA_FORK_BLOCK:-latest}"

if [[ -z "${SEPOLIA_RPC_URL:-}" && -f "$ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$ROOT/.env"; set +a
fi
if [[ -z "${SEPOLIA_RPC_URL:-}" ]]; then
  echo "SEPOLIA_RPC_URL is not set (see .env)" >&2
  exit 1
fi

rpc_alive() {
  curl -sf -X POST -H 'content-type: application/json' "$RPC_URL" \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' >/dev/null 2>&1
}

if ! rpc_alive; then
  echo "-- starting anvil fork on $RPC_URL (block $FORK_BLOCK)"
  if [[ "$FORK_BLOCK" == "latest" ]]; then
    anvil --host "$RPC_HOST" --port "$RPC_PORT" --chain-id 31337 \
      --fork-url "$SEPOLIA_RPC_URL" \
      >"$(mktemp -t launchpad-anvil-fork.XXXXXX.log)" 2>&1 &
  else
    anvil --host "$RPC_HOST" --port "$RPC_PORT" --chain-id 31337 \
      --fork-url "$SEPOLIA_RPC_URL" --fork-block-number "$FORK_BLOCK" \
      >"$(mktemp -t launchpad-anvil-fork.XXXXXX.log)" 2>&1 &
  fi
  ANVIL_PID=$!
  trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do rpc_alive && break; sleep 1; done
  rpc_alive || { echo "anvil fork failed to start" >&2; exit 1; }
else
  echo "-- reusing anvil already on $RPC_URL"
fi

cd "$CONTRACTS"
echo "-- forge build"
forge build
echo "-- unit + pin tests (no network)"
forge test --match-contract 'LaunchpadTest|PinnedInterfacesTest'
echo "-- fork tests (Sepolia state)"
forge test --match-contract LaunchpadForkTest --fork-url "$RPC_URL"
echo
echo "OK -- launchpad contracts pass against the Sepolia fork."
