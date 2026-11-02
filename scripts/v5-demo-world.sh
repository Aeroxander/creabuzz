#!/usr/bin/env bash
#
# scripts/v5-demo-world.sh — one local world you can click through by hand.
#
# Wraps `scripts/v5-local-fixture.sh` in demo mode: it deploys the creation
# version on a throwaway local anvil (real transactions, chain id 31337),
# publishes a launch record to a LOCAL relay, serves the web app on :5173
# against both, and stays up until you press Ctrl-C.
#
# Nothing here touches a public network, real funds or a deployed contract:
# anvil's public dev keys only.
#
# Needs a relay already running on :3030. Start one with:
#
#   DATABASE_URL=postgres://buzz:buzz_dev@127.0.0.1:5432/buzz \
#   REDIS_URL=redis://127.0.0.1:6379 \
#   BUZZ_BIND_ADDR=127.0.0.1:3030 BUZZ_HEALTH_PORT=8088 BUZZ_METRICS_PORT=9202 \
#   RELAY_URL=ws://127.0.0.1:3030 BUZZ_REQUIRE_AUTH_TOKEN=false \
#   BUZZ_GIT_CONFORMANCE_PROBE=false \
#   BUZZ_RELAY_PRIVATE_KEY=$(openssl rand -hex 32) \
#   target/debug/buzz-relay
#
# (or use `just relay`, which serves :3000 and needs its own community row).
#
# Usage: ./scripts/v5-demo-world.sh
# Env:   V5_DEMO_RELAY (default http://127.0.0.1:3030), V5_DEMO_WEB_PORT (default 5173)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -x "$ROOT/target/debug/buzz" ]] || { echo "build the CLI first: cargo build -p buzz-cli" >&2; exit 1; }

V5_DEMO=1 \
V5_DEMO_RELAY="${V5_DEMO_RELAY:-http://127.0.0.1:3030}" \
V5_DEMO_WEB_PORT="${V5_DEMO_WEB_PORT:-5173}" \
  exec "$ROOT/scripts/v5-local-fixture.sh"
