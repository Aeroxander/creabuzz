#!/usr/bin/env bash
# The float-mode launch journey in two timed phases against a local anvil.
#
# Phase 1 deploys the stack and releases a milestone tranche on attestation;
# the wrapper waits for the 1s settlement window to really close (the seconds
# a live chain gives for free), then phase 2 settles revenue, funds the
# buyback share, enforces the sell-rate gate, and prints the attestation-feed
# mirror payloads.
#
# Usage:
#   anvil &
#   scripts/journey-float.sh
set -euo pipefail

cd "$(dirname "$0")/../contracts"
RPC="${JOURNEY_RPC:-http://127.0.0.1:8545}"

forge script script/JourneyFloat.s.sol:JourneyFloatA \
  --rpc-url "$RPC" --broadcast --skip-simulation

echo "… waiting for the settlement window to close (5s)"
sleep 5

forge script script/JourneyFloat.s.sol:JourneyFloatB \
  --rpc-url "$RPC" --broadcast --skip-simulation

echo "… governance leg: summon -> propose -> vote -> execute"
forge script script/JourneyGov.s.sol:JourneyGov \
  --rpc-url "$RPC" --broadcast --skip-simulation
