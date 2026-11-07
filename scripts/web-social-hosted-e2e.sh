#!/usr/bin/env bash
#
# scripts/web-social-hosted-e2e.sh — the social suite as the pilot server runs it: `scripts/web-social-e2e.sh` with
# HOSTED=1 (a contributor-only web build, every community invite-only, the request limits of
# deploy/compose/compose.creaton.yml). Its own name so `scripts/mvp-gate.sh` can run it as a journey.
#
# ⚠️  DEV ONLY. Needs Postgres and Redis running (see `just services`) and port 3199 free.
#
# Usage:  scripts/web-social-hosted-e2e.sh [playwright args]   (the Env of web-social-e2e.sh applies)

set -euo pipefail
HOSTED=1 exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/web-social-e2e.sh" "$@"
