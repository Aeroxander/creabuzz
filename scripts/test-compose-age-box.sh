#!/usr/bin/env bash
# A Creaton compose server shows the "I am 18 years of age or older" box at sign-up without the operator doing anything:
# the relay reads BUZZ_AGE_ATTESTATION_REQUIRED (crates/buzz-relay/src/config.rs), so the Creaton part of the env
# (deploy/compose/.env.creaton.example) turns it on, and compose.creaton.yml passes it to the relay container, on by
# default and off only when .env says false. The check of the example needs no Docker; the check of what the relay
# container receives uses `docker compose config`, which renders text and needs no running Docker, and is skipped
# (and says so) when Compose is not installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$(cd "${SCRIPT_DIR}/../deploy/compose" && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creaton-age-box.XXXXXX")"
trap 'rm -rf "${TEST_DIR}"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# The value the stack would read: the last uncommented line that sets it, as compose-env.sh's env_value reads .env.
effective() {
  grep -E "^BUZZ_AGE_ATTESTATION_REQUIRED=" "$1" | tail -n 1 | cut -d= -f2- || true
}

[[ "$(effective "${COMPOSE_DIR}/.env.creaton.example")" == "true" ]] ||
  fail ".env.creaton.example does not set BUZZ_AGE_ATTESTATION_REQUIRED=true, so a Creaton server shows no age box"
cat "${COMPOSE_DIR}/.env.example" "${COMPOSE_DIR}/.env.creaton.example" >"${TEST_DIR}/bundle.env"
[[ "$(effective "${TEST_DIR}/bundle.env")" == "true" ]] ||
  fail "the bundle's .env.example followed by .env.creaton.example does not end with the age box on"

if ! docker compose version >/dev/null 2>&1; then
  echo "SKIP: docker compose is not installed; the rendered relay settings were not checked"
  echo "PASS: .env.creaton.example turns the age box on"
  exit 0
fi

# What the relay container is given, rendered from the real compose files and a scratch .env (the relay reads .env as its
# env_file, and compose reads it for ${...} values).
mkdir -p "${TEST_DIR}/compose"
cp "${COMPOSE_DIR}"/compose*.yml "${TEST_DIR}/compose/"
rendered_value() {
  cp "$1" "${TEST_DIR}/compose/.env"
  (cd "${TEST_DIR}/compose" && docker compose -f compose.yml -f compose.creaton.yml config relay 2>&1) |
    sed -nE 's/^ +BUZZ_AGE_ATTESTATION_REQUIRED: *"?([^"]*)"?$/\1/p'
}

[[ "$(rendered_value "${TEST_DIR}/bundle.env")" == "true" ]] ||
  fail "the relay container does not get BUZZ_AGE_ATTESTATION_REQUIRED=true from the Creaton env"

# An .env made before this setting existed still gets the box: compose.creaton.yml defaults it on.
grep -v "^BUZZ_AGE_ATTESTATION_REQUIRED=" "${TEST_DIR}/bundle.env" >"${TEST_DIR}/older.env"
[[ "$(rendered_value "${TEST_DIR}/older.env")" == "true" ]] ||
  fail "an .env without the setting does not get the age box (compose.creaton.yml has no default of true)"

# An operator can still turn it off.
{ cat "${TEST_DIR}/bundle.env"; echo "BUZZ_AGE_ATTESTATION_REQUIRED=false"; } >"${TEST_DIR}/off.env"
[[ "$(rendered_value "${TEST_DIR}/off.env")" == "false" ]] ||
  fail "BUZZ_AGE_ATTESTATION_REQUIRED=false in .env does not turn the age box off"

echo "PASS: a Creaton compose server turns the age box on by default, and .env can turn it off"
