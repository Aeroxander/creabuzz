#!/usr/bin/env bash
# `./run.sh build` and the Creaton app (compose.creaton.yml, target runtime-creaton). No Docker or network needed: `docker` and
# `curl` are stand-ins that record what they were asked.
#   - with no VITE_CREATON_* setting the build goes on and says the app shows no money screens (investing off by default);
#   - a Launcher without its chain, a malformed address, a key in an address, a phone-account switch without its bundler and a
#     CHANGE_ME are each refused before compose is called, and the refusal names the setting;
#   - CREATON_DEPLOYMENTS_FILE fills in the chain id, Launcher and dollar from the deploy script's file, and a value set by hand
#     wins; a file that is not a deployments file is refused;
#   - the page's node is asked for its network and the Launcher's code: another network, no code and no answer are each refused;
#   - the old web app (CREATON_IMAGE_TARGET=runtime) is left to its own checks and the app's settings are not read;
#   - the compose file names every setting the Dockerfile's app stage takes, and builds the target the Dockerfile has.
# Run it with: deploy/compose/test-app-settings.sh (just app-deploy-check does).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creaton-app-settings.XXXXXX")"
trap 'rm -rf "${TEST_DIR}"' EXIT

# The copy of the compose folder sits two levels under TEST_DIR, as it does in the checkout, so that run.sh finds the web
# app's settings check at ../../web.
COMPOSE_DIR="${TEST_DIR}/deploy/compose"
command -v node >/dev/null 2>&1 || { echo "FAIL: node is not on PATH; the settings check needs Node.js 22.6 or newer" >&2; exit 1; }
mkdir -p "${COMPOSE_DIR}" "${TEST_DIR}/bin"
ln -s "${REPO_ROOT}/web" "${TEST_DIR}/web"
cp "${SCRIPT_DIR}/run.sh" "${SCRIPT_DIR}/compose-env.sh" "${COMPOSE_DIR}/"
cat >"${TEST_DIR}/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"${DOCKER_LOG}"
# IMAGE_MISSING=1: the image was never built.
[[ "$1 $2" == "image inspect" && "${IMAGE_MISSING:-}" == "1" ]] && exit 1
exit 0
STUB
# The page's node: NODE_CHAIN is its network (hex), NODE_CODE the code it holds at the Launcher ("0x" is none), NODE_DOWN=1
# does not answer at all.
cat >"${TEST_DIR}/bin/curl" <<'STUB'
#!/usr/bin/env bash
data=""
while (($#)); do
  [[ "$1" == "--data" ]] && data="$2"
  shift
done
echo "$data" >>"${CURL_LOG}"
if [[ "${NODE_DOWN:-}" == "1" ]]; then
  echo "curl: (28) Operation timed out" >&2
  exit 28
fi
case "$data" in
  *eth_chainId*) echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"${NODE_CHAIN}\"}" ;;
  *eth_getCode*) echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"${NODE_CODE:-0x6080}\"}" ;;
esac
STUB
chmod +x "${TEST_DIR}/bin/docker" "${TEST_DIR}/bin/curl"
export DOCKER_LOG="${TEST_DIR}/docker.log"
export CURL_LOG="${TEST_DIR}/curl.log"
: >"${CURL_LOG}"
export PATH="${TEST_DIR}/bin:${PATH}"
export NODE_CHAIN=0x7a69

fail() {
  echo "FAIL: $1" >&2
  cat "${TEST_DIR}/out" >&2 || true
  exit 1
}
build() {
  : >"${DOCKER_LOG}"
  (cd "${COMPOSE_DIR}" && ./run.sh build) >"${TEST_DIR}/out" 2>&1
}
refused() {
  if build; then fail "$1"; fi
  [[ ! -s "${DOCKER_LOG}" ]] || fail "compose was called after: $1"
  grep -q "$2" "${TEST_DIR}/out" || fail "the refusal does not say: $2"
}
env_with() {
  printf '%s\n' "BUZZ_COMPOSE_CREATON=true" "BUZZ_RELAY_PRIVATE_KEY=CHANGE_ME_generate_once" "$@" >"${COMPOSE_DIR}/.env"
}

LAUNCHER="0x$(printf '9f%.0s' {1..20})"
DOLLAR="0x$(printf '5f%.0s' {1..20})"
OTHER="0x$(printf 'ab%.0s' {1..20})"

# 1. Nothing set: it builds, says there are no money screens, and asks nothing of the network.
env_with
build || fail "build refused a .env with no app settings"
grep -q "compose .* build relay" "${DOCKER_LOG}" || fail "build did not call compose build relay"
grep -q "no money screens" "${TEST_DIR}/out" || fail "build did not say the app shows no money screens"
[[ ! -s "${CURL_LOG}" ]] || fail "a node was asked with no network named"

# 2. Half-set and malformed settings are refused before compose is called.
env_with "VITE_CREATON_LAUNCHER=${LAUNCHER}"
refused "a Launcher without its chain was built" "VITE_CREATON_CHAIN_ID and VITE_CREATON_LAUNCHER go together"
env_with "VITE_CREATON_CHAIN_ID=31337"
refused "a chain without its Launcher was built" "VITE_CREATON_CHAIN_ID and VITE_CREATON_LAUNCHER go together"
env_with "VITE_CREATON_CHAIN_ID=sepolia" "VITE_CREATON_LAUNCHER=${LAUNCHER}"
refused "a chain that is not a number was built" "VITE_CREATON_CHAIN_ID=sepolia is not a network number"
env_with "VITE_CREATON_CHAIN_ID=31337" "VITE_CREATON_LAUNCHER=0x1234"
refused "a short Launcher was built" "VITE_CREATON_LAUNCHER is not a 0x address"
env_with "VITE_CREATON_CHAIN_ID=31337" "VITE_CREATON_LAUNCHER=${LAUNCHER}" "VITE_CREATON_DOLLAR=0xnope"
refused "a malformed dollar was built" "VITE_CREATON_DOLLAR is not a 0x address"
env_with "VITE_CREATON_BUNDLER_URL=https://bundler.example/v1?apikey=abc"
refused "a bundler address with a key in it was built" "VITE_CREATON_BUNDLER_URL carries a key in its address"
env_with "VITE_CREATON_RPC_URL=https://user:pass@node.example"
refused "a node address with a password was built" "VITE_CREATON_RPC_URL must be an http(s) address"
env_with "VITE_CREATON_CHAIN_ID=31337" "VITE_CREATON_LAUNCHER=${LAUNCHER}" "VITE_CREATON_PASSKEY_ACCOUNT=1" "VITE_CREATON_RPC_URL=https://node.example"
refused "the phone-account switch without a bundler was built" "VITE_CREATON_PASSKEY_ACCOUNT=1 needs"
env_with "VITE_CREATON_PASSKEY_ACCOUNT=yes"
refused "a phone-account switch that is not 1 was built" "VITE_CREATON_PASSKEY_ACCOUNT is 1 or left out"
env_with "VITE_CREATON_RPC_URL=CHANGE_ME_a_node"
refused "a CHANGE_ME node was built" "VITE_CREATON_RPC_URL"

# 3. The deploy script's file fills in the three values; a value set by hand wins; a file that is not one is refused.
mkdir -p "${COMPOSE_DIR}/deployments"
cat >"${COMPOSE_DIR}/deployments/pot-31337.json" <<JSON
{
  "admin": "${OTHER}",
  "chainId": 31337,
  "feeBps": 200,
  "launcher": "${LAUNCHER}",
  "parts": "${OTHER}",
  "platform": "${OTHER}",
  "quote": "${DOLLAR}",
  "unit": 604800
}
JSON
env_with "CREATON_DEPLOYMENTS_FILE=deployments/pot-31337.json" "VITE_CREATON_RPC_URL=https://node.example"
: >"${CURL_LOG}"
build || fail "build refused a .env that names the deployments file"
grep -q "Network: 31337, Launcher ${LAUNCHER}, dollar ${DOLLAR}" "${TEST_DIR}/out" || fail "the file's network is not the one the build reports"
grep -q "\"eth_getCode\",\"params\":\[\"${LAUNCHER}\"" "${CURL_LOG}" || fail "the node was not asked for the Launcher's code"
grep -q "The chain node answers on network 31337 and holds the Launcher" "${TEST_DIR}/out" || fail "the build did not say the node holds the Launcher"
env_with "CREATON_DEPLOYMENTS_FILE=deployments/pot-31337.json" "VITE_CREATON_LAUNCHER=${OTHER}"
build || fail "build refused a hand-set Launcher beside the file"
grep -q "Launcher ${OTHER}, dollar ${DOLLAR}" "${TEST_DIR}/out" || fail "a Launcher set by hand did not win over the file"
env_with "CREATON_DEPLOYMENTS_FILE=deployments/nowhere.json"
refused "a deployments file that is not there was built" "no such file"
echo '{"hello": "world"}' >"${COMPOSE_DIR}/deployments/other.json"
env_with "CREATON_DEPLOYMENTS_FILE=deployments/other.json"
refused "a file that is not a deployments file was built" "is not a deployments file"

# 4. The page's node must be on the build's network and hold the Launcher.
env_with "CREATON_DEPLOYMENTS_FILE=deployments/pot-31337.json" "VITE_CREATON_RPC_URL=https://node.example"
NODE_CHAIN=0xaa36a7 refused "a node on another network was built" "is on network 11155111, but the build is for network 31337"
NODE_CODE=0x refused "a node with nothing at the Launcher was built" "Nothing is deployed at the Launcher"
NODE_DOWN=1 refused "a node that does not answer was built" "no answer within 15 seconds"

# 5. A whole phone-account setting builds and is reported.
env_with "CREATON_DEPLOYMENTS_FILE=deployments/pot-31337.json" "VITE_CREATON_RPC_URL=https://node.example" \
  "VITE_CREATON_PASSKEY_ACCOUNT=1" "VITE_CREATON_BUNDLER_URL=https://bundler.example" "VITE_CREATON_SPONSOR_URL=https://sponsor.example/sponsor"
build || fail "build refused a whole phone-account setting"
grep -q "bundler https://bundler.example, fees asked at https://sponsor.example/sponsor" "${TEST_DIR}/out" ||
  fail "the build did not report the bundler and the sponsor"

# 6. The old web app as the image's target: the app's settings are not read (a half-set one does not stop it).
env_with "CREATON_IMAGE_TARGET=runtime" "VITE_CREATON_LAUNCHER=${LAUNCHER}"
build || fail "build refused the app's half-set setting while the old web app is the target"
grep -q "the VITE_CREATON_\* settings are not read" "${TEST_DIR}/out" || fail "build did not say the app's settings are not read"

# 7. The compose file names every setting the Dockerfile's app stage takes, builds a target the Dockerfile has, and the
#    app stage and the server's list agree (an argument missing from either is dropped silently).
for name in VITE_CREATON_CHAIN_ID VITE_CREATON_LAUNCHER VITE_CREATON_DOLLAR VITE_CREATON_RPC_URL \
            VITE_CREATON_PASSKEY_ACCOUNT VITE_CREATON_BUNDLER_URL VITE_CREATON_SPONSOR_URL; do
  grep -q "^        ${name}: \${${name}:-}\$" "${SCRIPT_DIR}/compose.creaton.yml" || fail "compose.creaton.yml has no build argument line for ${name}"
  grep -q "^ARG ${name}=\$" "${REPO_ROOT}/Dockerfile" || fail "the Dockerfile has no ARG ${name}="
  grep -q "[ ]${name}[ ;]" "${REPO_ROOT}/Dockerfile" || fail "the Dockerfile's unset-if-empty loop does not name ${name}"
done
target="$(sed -nE 's/^ *target: \$\{CREATON_IMAGE_TARGET:-([a-z-]+)\}$/\1/p' "${SCRIPT_DIR}/compose.creaton.yml")"
[[ -n "${target}" ]] || fail "compose.creaton.yml names no default target"
grep -q "^FROM .* AS ${target}\$" "${REPO_ROOT}/Dockerfile" || fail "the Dockerfile has no stage ${target}"
grep -q "^FROM .* AS runtime\$" "${REPO_ROOT}/Dockerfile" || fail "the Dockerfile has no stage runtime"
# `runtime` stays the Dockerfile's last stage: docker build with no --target (and the published image) get the old web app.
[[ "$(grep '^FROM ' "${REPO_ROOT}/Dockerfile" | tail -n 1)" == *" AS runtime" ]] || fail "runtime is no longer the Dockerfile's last stage"

# 8. A start with no built image is refused (compose would build it itself and skip the checks above) and does not call
#    compose up; with the image there it goes on to the usual checks.
env_with
: >"${DOCKER_LOG}"
if (cd "${COMPOSE_DIR}" && IMAGE_MISSING=1 ./run.sh start) >"${TEST_DIR}/out" 2>&1; then fail "start went on with no image built"; fi
grep -q "Build it first with ./run.sh build" "${TEST_DIR}/out" || fail "start does not say to build first"
if grep -q " up " "${DOCKER_LOG}"; then fail "compose up was called with no image built"; fi
: >"${DOCKER_LOG}"
(cd "${COMPOSE_DIR}" && ./run.sh start) >"${TEST_DIR}/out" 2>&1 || true
if grep -q "Build it first" "${TEST_DIR}/out"; then fail "start refused although the image is there"; fi

echo "PASS: run.sh build checks the Creaton app's settings before compose is called (none set: no money screens; half-set, malformed,"
echo "      keyed and CHANGE_ME settings refused), reads the deploy script's file, asks the page's node for its network and the Launcher,"
echo "      leaves the old web app to its own checks; a start with no built image is refused; compose.creaton.yml and the Dockerfile agree on the app's settings and target"
