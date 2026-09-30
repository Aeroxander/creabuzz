#!/usr/bin/env bash
# The live dogfood loop — wiki → drafts → dedupe → instrument, end to end.
#
# Prereqs: postgres + redis up, `cargo run -p buzz-admin -- migrate` done,
# `./scripts/seed-local-community.sh` seeded, and the relay running
# (`source .env && cargo run -p buzz-relay`). Exercises the persona drafting
# loop (docs/persona-drafting-loop.md) exactly as production would:
#
#   1. publish a wiki page carrying decision blocks (the agent's worldview),
#   2. `buzz agwiki draft --publish` materializes them as agent-drafts
#      (the verbatim-evidence rule skips the invented one, visibly),
#   3. re-run proves D7 dedupe (re-runs draft nothing new),
#   4. `buzz diag` reads the coordination plane back (Phase 4 instrument).
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; source .env; set +a
export BUZZ_RELAY_URL="${BUZZ_RELAY_URL:-ws://localhost:3000}"
# The fleet-worker identity is already a community member (the poster role in
# the e2e helpers) — reuse it as the dogfood persona. The `buzz` CLI reads
# BUZZ_PRIVATE_KEY (or --private-key); the example reads BUZZ_E2E_KEY.
export BUZZ_PRIVATE_KEY="${BUZZ_FLEET_WORKER_KEY:?BUZZ_FLEET_WORKER_KEY in .env}"
export BUZZ_E2E_KEY="${BUZZ_PRIVATE_KEY}"
LAUNCH_COORD="37001:$(printf '%064d' 0 | tr '0' 'b'):dogfood"

echo "== 1. publish the wiki page with decision blocks"
cargo run -q -p buzz-agwiki --example publish_page -- default

echo "== 2. the loop: wiki -> agent-drafts (dry run first)"
./target/debug/buzz agwiki draft --launch "$LAUNCH_COORD"

echo "== 3. land them"
./target/debug/buzz agwiki draft --launch "$LAUNCH_COORD" --publish

echo "== 4. idempotence: re-run must draft nothing new (D7)"
./target/debug/buzz agwiki draft --launch "$LAUNCH_COORD"

echo "== 5. the instrument reads the coordination plane back"
./target/debug/buzz diag --limit 500 | head -40

echo "== 6. trustgraph: compose the score root (local) and publish it"
mkdir -p /tmp/tg
printf '[{"member":"0x000000000000000000000000000000000000dEaD","score":5},{"member":"0x0000000000000000000000000000000000000001","score":7}]' > /tmp/tg/scores.json
./target/debug/buzz trustgraph compose-root --epoch dogfood-1 --scores /tmp/tg/scores.json --proofs-out /tmp/tg/proofs.json > /tmp/tg/bundle.json
head -c 260 /tmp/tg/bundle.json; echo
./target/debug/buzz trustgraph publish-root --from-bundle /tmp/tg/bundle.json

echo "== dogfood loop complete"
