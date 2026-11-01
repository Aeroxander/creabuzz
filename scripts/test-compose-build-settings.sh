#!/usr/bin/env bash
# deploy/compose/run.sh `build` refuses a .env whose web app settings (VITE_*) still hold a CHANGE_ME, before compose is
# called, and builds when only the server's secrets do (the owner key is made with the built image). With contributor
# projects on, it first asks the page's chain node for its network and the kit's history, and refuses a node that is on
# another network, does not answer, or refuses the history. No Docker or network needed: `docker` and `curl` are
# stand-ins that record what they were asked.
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
# The page's chain node: NODE_CHAIN is its network (hex); NODE_LOGS says how it answers a history request ("whole": any
# range, "paged": only a small one, "tiny": only 10 blocks or fewer, "none": refuses); NODE_DOWN=1 does not answer at all.
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
refused='{"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"block range too large"}}'
case "$data" in
  *eth_chainId*) echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"${NODE_CHAIN}\"}" ;;
  *'"toBlock":"latest"'*) if [[ "${NODE_LOGS}" == "whole" ]]; then echo '{"jsonrpc":"2.0","id":2,"result":[]}'; else echo "$refused"; fi ;;
  *eth_getLogs*)
    span=0
    if [[ "$data" =~ \"fromBlock\":\"(0x[0-9a-f]+)\" ]]; then from=$((BASH_REMATCH[1])); fi
    if [[ "$data" =~ \"toBlock\":\"(0x[0-9a-f]+)\" ]]; then span=$((BASH_REMATCH[1] - from + 1)); fi
    if [[ "${NODE_LOGS}" == "none" || ("${NODE_LOGS}" == "tiny" && span -gt 10) ]]; then
      echo "$refused"
    else
      echo '{"jsonrpc":"2.0","id":2,"result":[]}'
    fi
    ;;
esac
STUB
chmod +x "${TEST_DIR}/bin/docker" "${TEST_DIR}/bin/curl"
export DOCKER_LOG="${TEST_DIR}/docker.log"
export CURL_LOG="${TEST_DIR}/curl.log"
: >"${CURL_LOG}"
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
# Contributor projects are off: the node is not asked anything, and the build says so.
[[ ! -s "${CURL_LOG}" ]] || fail "the chain node was asked with contributor projects off"
grep -q "the chain node is not checked" "${TEST_DIR}/out" || fail "build did not say the node was not checked"

# Contributor projects on: the node must be on the build's network and read the kit's history from its block.
KIT="0x$(printf 'ab%.0s' {1..20})"
cat >>"${TEST_DIR}/compose/.env" <<ENV
VITE_LAUNCHPAD_CHAIN_ID=11155111
VITE_CONTRIBUTOR_KITS={"11155111":"${KIT}"}
VITE_HISTORY_FROM_BLOCKS={"11155111":7654321}
ENV
export NODE_CHAIN=0xaa36a7 NODE_LOGS=whole
build || fail "build refused a node on Sepolia that reads the kit's history"
grep -q "compose .* build relay" "${DOCKER_LOG}" || fail "build did not go on after the node answered"
grep -q "\"address\":\"${KIT}\",\"fromBlock\":\"0x74cbb1\",\"toBlock\":\"latest\"" "${CURL_LOG}" ||
  fail "the history request is not the kit's from block 7654321"

refused() {
  if build; then fail "$1"; fi
  [[ ! -s "${DOCKER_LOG}" ]] || fail "compose was called after: $1"
  grep -q "$2" "${TEST_DIR}/out" || fail "the refusal does not say: $2"
}
NODE_CHAIN=0x1 refused "build went ahead with a node on another network" "is on network 1, but the build is for network 11155111"
NODE_DOWN=1 refused "build went ahead with a node that does not answer" "no answer within 15 seconds"
NODE_LOGS=none refused "build went ahead with a node that refuses the kit's history" "refused the kit's history from block 7654321"

# A node that takes only a small range: the page reads in pages, so the build goes on and says to check it lasts.
NODE_LOGS=paged build || fail "build refused a node that answers a small history range"
grep -q "the page will read it in pages" "${TEST_DIR}/out" || fail "build did not say the history is read in pages"
# The page narrows its pages down to 10 blocks, so a node that takes only that still lets the build go on.
NODE_LOGS=tiny build || fail "build refused a node that answers 10 blocks at a time, which the page can read"
grep -q "the page will read it in pages" "${TEST_DIR}/out" || fail "build did not say the history is read in pages (10 blocks)"

# The server's commands refuse the example's host name left in, whether as CHANGE_ME_HOST or an older example's host.
server() {
  : >"${DOCKER_LOG}"
  (cd "${TEST_DIR}/compose" && ./run.sh config) >"${TEST_DIR}/out" 2>&1
}
for host in CHANGE_ME_HOST buzz.example.com; do
  cat >"${TEST_DIR}/compose/.env" <<ENV
BUZZ_DOMAIN=${host}
RELAY_URL=wss://${host}
BUZZ_RELAY_PRIVATE_KEY=0123
ENV
  if server; then fail "config went ahead with ${host} as the host name"; fi
  [[ ! -s "${DOCKER_LOG}" ]] || fail "compose was called with ${host} as the host name"
  grep -q "RELAY_URL" "${TEST_DIR}/out" || fail "the refusal for ${host} does not name RELAY_URL"
done
sed -i.bak 's/buzz\.example\.com/pilot.example.org/' "${TEST_DIR}/compose/.env"
server || fail "config refused a .env with a real host name"
grep -q "compose .* config" "${DOCKER_LOG}" || fail "config did not call compose config"

echo "PASS: run.sh build refuses CHANGE_ME in the web app's settings and only there, and checks the page's chain node;"
echo "      the server's commands refuse the example's host name"
