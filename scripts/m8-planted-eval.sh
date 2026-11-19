#!/usr/bin/env bash
#
# scripts/m8-planted-eval.sh — the AI manager's planted-record eval against a REAL model.
#
# Every build already runs the eval with a stand-in model that obeys every plant
# (crates/buzz-relay/src/api/manager/planted_eval_tests.rs). This runs the same record
# (crates/buzz-relay/src/api/manager/testdata/planted_record.json: an injected instruction, made-up numbers, names
# and links, a return promise, a money move, a claim the record never made, legal and tax questions) through the
# operator's real AI service and the same honesty envelope, and fails if any plant reaches the answer, if a line cites
# something that was not read, or if the legal and tax questions are not handed to a person. Run it before changing
# the model or the manager's prompt.
#
# The key is read from the environment only. It is never written to a file, never printed, and never passed on a
# command line. Each run makes one call to the AI service (it costs what one draft costs).
#
# Usage:  BUZZ_LLM_PROXY_URL=https://<host>/v1/chat/completions BUZZ_LLM_API_KEY=... scripts/m8-planted-eval.sh
# Env:    BUZZ_LLM_MODEL (optional: the model to ask for)
# Exit:   0 the eval passed; 1 it failed (the answer is printed above the failure); 2 not run (no service or key set)

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -z "${BUZZ_LLM_PROXY_URL:-}" || -z "${BUZZ_LLM_API_KEY:-}" ]]; then
  echo "[m8-planted-eval] not run: set BUZZ_LLM_PROXY_URL and BUZZ_LLM_API_KEY in the environment to run the eval against a real model." >&2
  exit 2
fi
command -v cargo >/dev/null 2>&1 || { echo "[m8-planted-eval] not run: cargo is not on PATH." >&2; exit 2; }

echo "[m8-planted-eval] asking the AI service at $(printf '%s' "$BUZZ_LLM_PROXY_URL" | sed -E 's#^(https?://[^/]+).*#\1#') (one call)"
if cargo test -p buzz-relay --lib -- api::manager::planted_eval_tests::planted_eval_against_a_real_model \
  --ignored --exact --nocapture; then
  echo "[m8-planted-eval] passed: no plant reached the answer."
  exit 0
fi
echo "[m8-planted-eval] FAILED: read the answer printed above. Do not ship this model or prompt for the manager." >&2
exit 1
