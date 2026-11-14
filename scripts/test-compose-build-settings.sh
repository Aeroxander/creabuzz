#!/usr/bin/env bash
# deploy/compose/run.sh `build` refuses a .env whose web app settings (VITE_*) still hold a CHANGE_ME, before compose is
# called, and builds when only the server's secrets do (the owner key is made with the built image). With contributor
# projects on, it first asks the page's chain node for its network and the kit's history, and refuses a node that is on
# another network, does not answer, or refuses the history. It also runs the web app's own settings check
# (web/scripts/check-deploy-env.mjs, the one the image runs) before compose is called, so a half-set weekly-sale trial block
# (a market factory without VITE_TRADING_TRIAL, or the reverse) is refused at build, a whole one passes, and the default
# settings build without any trading setting. No Docker or network needed: `docker` and `curl` are stand-ins that record
# what they were asked; Node.js 22.6 or newer runs the real settings check.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/creaton-build-settings.XXXXXX")"
trap 'rm -rf "${TEST_DIR}"' EXIT

# The copy of the compose folder sits two levels under TEST_DIR, as it does in the checkout, so that run.sh finds the web
# app's settings check (web/scripts/check-deploy-env.mjs) at ../../web: TEST_DIR/web is the checkout's own web folder.
COMPOSE_DIR="${TEST_DIR}/deploy/compose"
command -v node >/dev/null 2>&1 || { echo "FAIL: node is not on PATH; the settings check needs Node.js 22.6 or newer" >&2; exit 1; }
mkdir -p "${COMPOSE_DIR}" "${TEST_DIR}/bin"
ln -s "${REPO_ROOT}/web" "${TEST_DIR}/web"
cp "${REPO_ROOT}/deploy/compose/run.sh" "${REPO_ROOT}/deploy/compose/compose-env.sh" "${COMPOSE_DIR}/"
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
sed -i.bak -E '/^[[:space:]]*VITE_(ZERODEV_PROJECT_ID|BUNDLER_URL)=/d' "${COMPOSE_DIR}/.env"
printf '%s\n' "VITE_ZERODEV_PROJECT_ID=b5486fa4-e3d9-450b-8428-646e757c10f6" "VITE_ZERODEV_CHAIN_ID=11155111" >>"${COMPOSE_DIR}/.env"
build || fail "build refused a .env whose page settings are all filled in"
grep -q "compose .* build relay" "${DOCKER_LOG}" || fail "build did not call compose build relay"
# Contributor projects are off: the node is not asked anything, and the build says so.
[[ ! -s "${CURL_LOG}" ]] || fail "the chain node was asked with contributor projects off"
grep -q "the chain node is not checked" "${TEST_DIR}/out" || fail "build did not say the node was not checked"

# Contributor projects on: the node must be on the build's network and read the kit's history from its block.
KIT="0x$(printf 'ab%.0s' {1..20})"
cat >>"${COMPOSE_DIR}/.env" <<ENV
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

# The weekly-sale trial block (docs/sepolia-testnet.md, "Trading"): the settings check the image runs is run here first.
# The default settings above build without any trading setting, and the check says trading is off.
grep -q "Trading: off" "${TEST_DIR}/out" || fail "the default build did not say trading is off"
cat >"${COMPOSE_DIR}/.env" <<ENV
BUZZ_COMPOSE_CREATON=true
VITE_LAUNCHPAD_CHAIN_ID=11155111
VITE_CHAIN_RPC_URL=https://sepolia.example/v2/read-only
VITE_CONTRIBUTOR_KITS={"11155111":"${KIT}"}
VITE_HISTORY_FROM_BLOCKS={"11155111":7654321}
VITE_ZERODEV_PROJECT_ID=b5486fa4-e3d9-450b-8428-646e757c10f6
VITE_ZERODEV_CHAIN_ID=11155111
ENV
NODE_CHAIN=0xaa36a7 NODE_LOGS=whole build || fail "build refused the contributor settings with no trading setting"
grep -q "Trading: off" "${TEST_DIR}/out" || fail "a build with no trading setting did not say trading is off"

MARKET_FACTORY="0x$(printf 'cd%.0s' {1..20})"
TEST_TOKEN="0x$(printf 'ef%.0s' {1..20})"
OTHER="0x$(printf '12%.0s' {1..20})"
cp "${COMPOSE_DIR}/.env" "${TEST_DIR}/contributor.env"

# Variants of the contributor settings, each built through the same run.sh. A refusal must come before compose is called
# and must name the setting at fault.
trial_env() {
  cp "${TEST_DIR}/contributor.env" "${COMPOSE_DIR}/.env"
  printf '%s\n' "$@" >>"${COMPOSE_DIR}/.env"
}
trial_refused() { # trial_refused <message> <text the refusal must say> <env line>...
  local message="$1" says="$2"
  shift 2
  trial_env "$@"
  if NODE_CHAIN=0xaa36a7 NODE_LOGS=whole build; then fail "build went ahead: ${message}"; fi
  [[ ! -s "${DOCKER_LOG}" ]] || fail "compose was called after: ${message}"
  grep -q -- "${says}" "${TEST_DIR}/out" || fail "the refusal for '${message}' does not say: ${says}"
}

# A market factory without the trial switch is refused (it would show nothing), and so is the switch without a factory.
trial_refused "a market factory without VITE_TRADING_TRIAL" "VITE_TRADING_TRIAL is not set to 1" \
  "VITE_SECONDARY_MARKET_FACTORY={\"11155111\":\"${MARKET_FACTORY}\"}"
trial_refused "the trial switch without a market factory" "VITE_SECONDARY_MARKET_FACTORY is not" "VITE_TRADING_TRIAL=1"
trial_refused "the trial switch set to something other than 1" "VITE_TRADING_TRIAL must be 1" \
  "VITE_SECONDARY_MARKET_FACTORY={\"11155111\":\"${MARKET_FACTORY}\"}" "VITE_TRADING_TRIAL=yes"
trial_refused "a market factory that is not an address" "VITE_SECONDARY_MARKET_FACTORY names no valid address" \
  "VITE_SECONDARY_MARKET_FACTORY={\"11155111\":\"not-an-address\"}" "VITE_TRADING_TRIAL=1"
trial_refused "a free test token that is not an address" "VITE_TEST_QUOTE_TOKENS names no valid address" \
  "VITE_TEST_QUOTE_TOKENS={\"11155111\":\"nope\"}"
trial_refused "a remix bond without the court" "VITE_REMIX_BONDS is named but VITE_COURTS is not" \
  "VITE_REMIX_BONDS={\"11155111\":\"${OTHER}\"}"
# A half-set CHANGE_ME in the block never reaches the check: the setting-level refusal above it stops it first.
trial_refused "a CHANGE_ME in the trial block" "VITE_TEST_QUOTE_TOKENS" \
  "VITE_TEST_QUOTE_TOKENS=CHANGE_ME_test_token"

# A whole trial block builds, says trading is on, and reaches compose (the build arguments come from compose.creaton.yml).
trial_env \
  "VITE_SECONDARY_MARKET_FACTORY={\"11155111\":\"${MARKET_FACTORY}\"}" \
  "VITE_TRADING_TRIAL=1" \
  "VITE_TEST_QUOTE_TOKENS={\"11155111\":\"${TEST_TOKEN}\"}" \
  "VITE_WORK_BOUNTIES={\"11155111\":\"${OTHER}\"}" \
  "VITE_PAYOUTS_FACTORIES={\"11155111\":\"${OTHER}\"}" \
  "VITE_OPEN_BOUNTIES={\"11155111\":\"${OTHER}\"}" \
  "VITE_CREATE_TOKENS={\"11155111\":\"${OTHER}\"}" \
  "VITE_CREATE_FAUCETS={\"11155111\":\"${OTHER}\"}" \
  "VITE_COURTS={\"11155111\":\"${OTHER}\"}" \
  "VITE_REMIX_BONDS={\"11155111\":\"${OTHER}\"}"
NODE_CHAIN=0xaa36a7 NODE_LOGS=whole build || fail "build refused a whole trial block"
grep -q "Trading: on" "${TEST_DIR}/out" || fail "the trial build did not say trading is on"
grep -q "compose .* build relay" "${DOCKER_LOG}" || fail "the trial build did not reach compose build relay"

# The investing block (docs/v3-review/INVESTING-SWITCH.md): the switch with an address missing, an address without the
# switch, and a switch that is not 1 are refused before compose is called; a whole block builds and says investing is on.
POOL_FACTORY="0x$(printf 'b1%.0s' {1..20})"
KIT_V3="0x$(printf 'b2%.0s' {1..20})"
BACKING_TOKEN="0x$(printf 'b3%.0s' {1..20})"
investing_lines=(
  "VITE_INVESTING=1"
  "VITE_BACKING_POOL_FACTORY={\"11155111\":\"${POOL_FACTORY}\"}"
  "VITE_CONTRIBUTOR_KIT_V3={\"11155111\":\"${KIT_V3}\"}"
  "VITE_BACKING_QUOTE_TOKEN={\"11155111\":\"${BACKING_TOKEN}\"}"
)
trial_refused "the investing switch without any address" "VITE_INVESTING is 1 but VITE_BACKING_POOL_FACTORY is not set" "VITE_INVESTING=1"
trial_refused "the investing switch without the pool kit" "VITE_INVESTING is 1 but VITE_CONTRIBUTOR_KIT_V3 is not set" \
  "${investing_lines[0]}" "${investing_lines[1]}" "${investing_lines[3]}"
trial_refused "an investing address without the switch" "VITE_BACKING_POOL_FACTORY is named but VITE_INVESTING is not set to 1" \
  "${investing_lines[1]}"
trial_refused "the investing switch set to something other than 1" "VITE_INVESTING must be 1" \
  "VITE_INVESTING=yes" "${investing_lines[1]}" "${investing_lines[2]}" "${investing_lines[3]}"
trial_env "${investing_lines[@]}"
NODE_CHAIN=0xaa36a7 NODE_LOGS=whole build || fail "build refused a whole investing block"
grep -q "Investing: on" "${TEST_DIR}/out" || fail "the investing build did not say investing is on"
grep -q "compose .* build relay" "${DOCKER_LOG}" || fail "the investing build did not reach compose build relay"
trial_env
NODE_CHAIN=0xaa36a7 NODE_LOGS=whole build || fail "build refused the default settings again"
grep -q "Investing: off" "${TEST_DIR}/out" || fail "a build with no investing setting did not say investing is off"

# The compose file names every setting the check reads, as a build argument, and so does the Dockerfile (an argument missing
# from either would be dropped silently: the page would be built without the setting the check approved).
for name in VITE_SECONDARY_MARKET_FACTORY VITE_TRADING_TRIAL VITE_TEST_QUOTE_TOKENS VITE_INVESTING VITE_BACKING_POOL_FACTORY \
            VITE_CONTRIBUTOR_KIT_V3 VITE_BACKING_QUOTE_TOKEN VITE_WORK_BOUNTIES VITE_OPEN_BOUNTIES \
            VITE_CREATE_TOKENS VITE_CREATE_FAUCETS VITE_COURTS VITE_PAYOUTS_FACTORIES VITE_REMIX_BONDS; do
  grep -q "^        ${name}: \${${name}:-}\$" "${REPO_ROOT}/deploy/compose/compose.creaton.yml" || fail "compose.creaton.yml has no build argument line for ${name}"
  grep -q "^ARG ${name}=\$" "${REPO_ROOT}/Dockerfile" || fail "the Dockerfile has no ARG ${name}="
  grep -q "[ ]${name} " "${REPO_ROOT}/Dockerfile" || fail "the Dockerfile's unset-if-empty loop does not name ${name}"
done
# run.sh checks the same settings the image takes: its list is the Dockerfile's list of arguments, no more, no less.
dockerfile_names="$(sed -nE 's/^ARG (VITE_[A-Z0-9_]+)=.*/\1/p' "${REPO_ROOT}/Dockerfile" | sort)"
runsh_names="$(sed -n '/^WEB_SETTINGS=(/,/^)/p' "${REPO_ROOT}/deploy/compose/run.sh" | grep -oE 'VITE_[A-Z0-9_]+' | sort)"
[[ -n "${dockerfile_names}" && "${dockerfile_names}" == "${runsh_names}" ]] ||
  fail "run.sh's WEB_SETTINGS differ from the Dockerfile's VITE_ arguments"
grep -q "export VITE_CONTRIBUTOR_ONLY=1" "${REPO_ROOT}/Dockerfile" || fail "the Dockerfile no longer sets VITE_CONTRIBUTOR_ONLY=1"

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

echo "PASS: run.sh build refuses CHANGE_ME in the web app's settings and only there, and checks the page's chain node;"
echo "      the web app's settings check runs first: a half-set trial block is refused, a whole one and the default build pass;"
echo "      the server's commands refuse the example's host name"
