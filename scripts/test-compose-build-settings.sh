#!/usr/bin/env bash
# deploy/compose/run.sh `build` refuses a .env whose web app settings (VITE_*) still hold a CHANGE_ME, before compose is
# called, and builds when only the server's secrets do (the owner key is made with the built image). No Docker needed:
# `docker` is a stand-in that records what it was asked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creaton-build-settings.XXXXXX")"
trap 'rm -rf "${TEST_DIR}"' EXIT

mkdir -p "${TEST_DIR}/compose" "${TEST_DIR}/bin"
cp "${REPO_ROOT}/deploy/compose/run.sh" "${REPO_ROOT}/deploy/compose/compose-env.sh" "${TEST_DIR}/compose/"
cat >"${TEST_DIR}/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"${DOCKER_LOG}"
STUB
chmod +x "${TEST_DIR}/bin/docker"
export DOCKER_LOG="${TEST_DIR}/docker.log"
export PATH="${TEST_DIR}/bin:${PATH}"

build() {
  : >"${DOCKER_LOG}"
  (cd "${TEST_DIR}/compose" && ./run.sh build) >"${TEST_DIR}/out" 2>&1
}

fail() {
  echo "FAIL: $1" >&2
  cat "${TEST_DIR}/out" >&2 || true
  exit 1
}

# A page setting left as the deploy script printed it.
cat >"${TEST_DIR}/compose/.env" <<'ENV'
BUZZ_COMPOSE_CREATON=true
BUZZ_RELAY_PRIVATE_KEY=CHANGE_ME_generate_once
VITE_CHAIN_RPC_URL=https://sepolia.example/v2/read-only
VITE_ZERODEV_PROJECT_ID=CHANGE_ME_your_ZeroDev_project_id
  VITE_BUNDLER_URL=CHANGE_ME_its_bundler_URL
ENV
if build; then fail "build went ahead with CHANGE_ME in VITE_ZERODEV_PROJECT_ID"; fi
[[ ! -s "${DOCKER_LOG}" ]] || fail "compose was called before the refusal"
grep -q "VITE_ZERODEV_PROJECT_ID" "${TEST_DIR}/out" || fail "the refusal does not name VITE_ZERODEV_PROJECT_ID"
grep -q "VITE_BUNDLER_URL" "${TEST_DIR}/out" || fail "the refusal does not name an indented VITE_BUNDLER_URL"
if grep -q "BUZZ_RELAY_PRIVATE_KEY" "${TEST_DIR}/out"; then fail "the refusal names a server secret"; fi

# Only the server's secrets are left: the image builds (start and restart refuse those, as before).
sed -i.bak -E '/^[[:space:]]*VITE_(ZERODEV_PROJECT_ID|BUNDLER_URL)=/d' "${TEST_DIR}/compose/.env"
echo "VITE_ZERODEV_PROJECT_ID=b5486fa4-e3d9-450b-8428-646e757c10f6" >>"${TEST_DIR}/compose/.env"
build || fail "build refused a .env whose page settings are all filled in"
grep -q "compose .* build relay" "${DOCKER_LOG}" || fail "build did not call compose build relay"

echo "PASS: run.sh build refuses CHANGE_ME in the web app's settings and only there"
