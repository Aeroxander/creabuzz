#!/usr/bin/env bash
# deploy/compose/run.sh `build` refuses a .env whose app settings (VITE_*) still hold a CHANGE_ME, before compose is
# called, and builds when only the server's secrets do (the owner key is made with the built image). The server's commands
# refuse the example's host name left in. The app's own settings (chain, Launcher, passkey account) are checked by
# deploy/compose/test-app-settings.sh. No Docker or network needed: `docker` is a stand-in that records what it was asked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creaton-build-settings.XXXXXX")"
trap 'rm -rf "${TEST_DIR}"' EXIT

# The copy of the compose folder sits two levels under TEST_DIR, as it does in the checkout.
COMPOSE_DIR="${TEST_DIR}/deploy/compose"
mkdir -p "${COMPOSE_DIR}" "${TEST_DIR}/bin"
cp "${REPO_ROOT}/deploy/compose/run.sh" "${REPO_ROOT}/deploy/compose/compose-env.sh" "${COMPOSE_DIR}/"
cat >"${TEST_DIR}/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"${DOCKER_LOG}"
STUB
chmod +x "${TEST_DIR}/bin/docker"
export DOCKER_LOG="${TEST_DIR}/docker.log"
export PATH="${TEST_DIR}/bin:${PATH}"

build() {
  : >"${DOCKER_LOG}"
  (cd "${COMPOSE_DIR}" && ./run.sh build) >"${TEST_DIR}/out" 2>&1
}

fail() {
  echo "FAIL: $1" >&2
  cat "${TEST_DIR}/out" >&2 || true
  exit 1
}

# A page setting left as the deploy script printed it.
cat >"${COMPOSE_DIR}/.env" <<'ENV'
BUZZ_COMPOSE_CREATON=true
BUZZ_RELAY_PRIVATE_KEY=CHANGE_ME_generate_once
VITE_CREATON_RPC_URL=https://sepolia.example/v2/read-only
VITE_CREATON_BUNDLER_URL=CHANGE_ME_its_bundler_URL
  VITE_CREATON_DOLLAR=CHANGE_ME_the_dollar
ENV
if build; then fail "build went ahead with CHANGE_ME in VITE_CREATON_BUNDLER_URL"; fi
[[ ! -s "${DOCKER_LOG}" ]] || fail "compose was called before the refusal"
grep -q "VITE_CREATON_BUNDLER_URL" "${TEST_DIR}/out" || fail "the refusal does not name VITE_CREATON_BUNDLER_URL"
grep -q "VITE_CREATON_DOLLAR" "${TEST_DIR}/out" || fail "the refusal does not name an indented VITE_CREATON_DOLLAR"
if grep -q "BUZZ_RELAY_PRIVATE_KEY" "${TEST_DIR}/out"; then fail "the refusal names a server secret"; fi

# Only the server's secrets are left: the image builds (start and restart refuse those, as before).
sed -i.bak -E '/^[[:space:]]*VITE_CREATON_(BUNDLER_URL|DOLLAR)=/d' "${COMPOSE_DIR}/.env"
build || fail "build refused a .env whose page settings are all filled in"
grep -q "compose .* build relay" "${DOCKER_LOG}" || fail "build did not call compose build relay"

# The server's commands refuse the example's host name left in, whether as CHANGE_ME_HOST or an older example's host.
server() {
  : >"${DOCKER_LOG}"
  (cd "${COMPOSE_DIR}" && ./run.sh config) >"${TEST_DIR}/out" 2>&1
}
for host in CHANGE_ME_HOST buzz.example.com; do
  cat >"${COMPOSE_DIR}/.env" <<ENV
BUZZ_DOMAIN=${host}
RELAY_URL=wss://${host}
BUZZ_RELAY_PRIVATE_KEY=0123
ENV
  if server; then fail "config went ahead with ${host} as the host name"; fi
  [[ ! -s "${DOCKER_LOG}" ]] || fail "compose was called with ${host} as the host name"
  grep -q "RELAY_URL" "${TEST_DIR}/out" || fail "the refusal for ${host} does not name RELAY_URL"
done
sed -i.bak 's/buzz\.example\.com/pilot.example.org/' "${COMPOSE_DIR}/.env"
server || fail "config refused a .env with a real host name"
grep -q "compose .* config" "${DOCKER_LOG}" || fail "config did not call compose config"

echo "PASS: run.sh build refuses CHANGE_ME in the app's settings and only there;"
echo "      the server's commands refuse the example's host name"
