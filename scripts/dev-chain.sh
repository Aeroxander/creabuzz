#!/usr/bin/env bash
#
# scripts/dev-chain.sh — one command that boots a fully-loaded LOCAL dev chain
# for the launchpad, then reports what it deployed.
#
#   just dev-chain         boot + load (idempotent — safe to re-run)
#   just dev-chain-status  what is deployed at which address (reads contracts/
#                          deployments/*.json, probes the live chain)
#   just dev-chain-down    stop the anvil this script started
#   just dev-chain --dry-run   print the plan, touch nothing
#
# What "fully-loaded" means, in dependency order:
#   1. anvil (chain id 31337, background, logged, pid file)
#   2. apptoken infrastructure — TokenMaster router, pools, transfer validator,
#      and the DEV-ONLY router allowlist patch: `scripts/apptoken-infra.sh`
#      (idempotent bootstrap + patch; see that script's header for the why).
#      It used to be the first half of scripts/dogfood-raise.sh, which also
#      minted an apptoken; that mint was removed in D150 (see tag
#      pre-deprecation-2026-10-31).
#   3. OrgBinding + Summoner + Moloch DAO for org formation
#      (`contracts/script/DeployOrgDao.s.sol`, which writes the
#      `deployments/org-dao-<chainid>.json` manifest)
#   4. a USDC-like currency mock for sales: MockPairedTokenERC20("Dev USDC",
#      "dUSDC", 6 decimals) + `deployments/dev-currency-<chainid>.json`
#      then the CCA factory + Permit2 placed at their canonical addresses, then
#      the DaoLaunchKit (one-transaction DAO launch) + `deployments/dao-launch-kit-<chainid>.json`, and the
#      ContributorKit (a contributor project, no sale, ready for work) + `deployments/contributor-kit-<chainid>.json`
#      and the WorkAreaBounty (outside money behind a work area) + `deployments/work-bounty-<chainid>.json`
#      and the OpenBounty (money behind a post) + `deployments/open-bounty-<chainid>.json`
#      then the optional test-network features, each with its own manifest: test CREATE and its faucet, the court,
#      money forecasts (contract only: removed from the app in D150), the payouts factory, remix bonds, matched exits and weekly rounds (the journeys use them)
#   5. funded dev accounts, printed as a table (keys are DEV ONLY, labeled)
#
# What it prints for the web app: first the settings for a build like the hosted pilot's (contributor projects only,
# VITE_CONTRIBUTOR_ONLY=1, no sale, no optional feature). The optional features' settings (a raise, bounties, matched
# exits, weekly rounds, CREATE, the court, forecasts, payouts, remix bonds) are printed only with DEV_CHAIN_ALL=1: they
# are deployed either way, and are for testing those features, not for the pilot (docs/v3-review/PILOT-RUNBOOK.md).
#
# ════════════════════════════════════════════════════════════════════════════
# ⚠️  DEV-ONLY. LOCAL ANVIL ONLY. NEVER MAINNET. ⚠️
#
# The steps above run the packaged apptoken bootstrap (unlocked dev accounts +
# multisig impersonation) and a dev-only router storage patch — exactly the
# two things `scripts/apptoken-infra.sh` documents as local-only. This script
# refuses any non-loopback RPC URL and only ever boots its own anvil on
# loopback, so those steps cannot reach a real chain from here.
# ════════════════════════════════════════════════════════════════════════════
#
# Idempotency: every deploy is guarded by "manifest exists AND the address it
# names still has code", so re-running against a live chain skips everything
# already done, and re-running after a chain restart (fresh state, stale
# manifest) redeploys instead of trusting the stale file. A caught failure
# never reports success: each step exits non-zero with the step named.
#
# Environment overrides:
#   RPC_URL     default http://127.0.0.1:8545
#   RPC_HOST    default 127.0.0.1 (also used when booting anvil)
#   RPC_PORT    default 8545
#   STATE_DIR   default <repo>/target/dev-chain (pid file, logs)
#   ANVIL_KEY   default anvil dev key 0 (deployer == treasury == DAO owner)
#   DEV_CHAIN_ID default 31337 (the chain anvil is booted with)
#   DEV_CHAIN_ALL=1  also print the optional features' web settings (see above)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Toolchain: prefer the hermit-pinned node/cast when available.
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
# A caller that put its own foundry directory first (the journey runner points `anvil` at its own state directory) keeps it first.
export PATH="${FOUNDRY_BIN:+${FOUNDRY_BIN}:}${HOME}/.foundry/bin:${PATH}"

RPC_HOST="${RPC_HOST:-127.0.0.1}"
RPC_PORT="${RPC_PORT:-8545}"
_RPC_URL_FROM_ENV="${RPC_URL:-}"
RPC_URL="${_RPC_URL_FROM_ENV:-http://$RPC_HOST:$RPC_PORT}"

# RPC_URL is the single source of truth for the endpoint: when the caller gave
# one, host and port follow it. Otherwise the probe could check one port while
# anvil boots on another, and the script would adopt (or refuse) the wrong
# chain. (See scripts/dev-chain.test.mjs — this split is a real bug it caught.)
if [[ -n "$_RPC_URL_FROM_ENV" ]]; then
  _rest="${RPC_URL#*://}"
  _rest="${_rest%%/*}"
  if [[ "$_rest" == \[* ]]; then
    # [::1]:8545 -> host "[::1]", port "8545"
    RPC_HOST="${_rest%%]*}]"
    _port="${_rest#*]}"
    RPC_PORT="${_port#:}"
  else
    # 127.0.0.1:8545 -> host "127.0.0.1", port "8545"
    RPC_HOST="${_rest%%:*}"
    if [[ "$_rest" == *:* ]]; then RPC_PORT="${_rest#*:}"; else RPC_PORT=""; fi
  fi
  [[ -n "$RPC_PORT" ]] || RPC_PORT=8545
  unset _rest _port
fi
unset _RPC_URL_FROM_ENV
STATE_DIR="${STATE_DIR:-$REPO_ROOT/target/dev-chain}"
DEV_CHAIN_ID="${DEV_CHAIN_ID:-31337}"
PID_FILE="$STATE_DIR/anvil.pid"
LOG_FILE="$STATE_DIR/anvil.log"
ORG_DAO_LOG="$STATE_DIR/org-dao.log"

ANVIL_KEY="${ANVIL_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
BUYER1_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
BUYER2_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"

# Currency mock: a plain ERC-20 from the vendored TokenMaster test mocks —
# name/symbol/decimals constructor + an open `mint`, which is exactly what a
# sales-currency fixture needs (6 decimals like USDC).
MOCK_ERC20_PATH="lib/tm-tokenmaster/test/mocks/MockPairedTokenERC20.sol"
CURRENCY_NAME="Dev USDC"
CURRENCY_SYMBOL="dUSDC"
CURRENCY_DECIMALS=6
# 1,000,000 whole units per dev account, in the token's smallest unit.
CURRENCY_PER_ACCOUNT=1000000000000

DEPLOYMENTS_DIR="$REPO_ROOT/contracts/deployments"

MODE="${1:-up}"

usage() {
  cat <<'USAGE'
usage: scripts/dev-chain.sh [up|down|status|--dry-run]

  up          boot (or reuse) the local dev chain and load it — default
  down        stop the anvil this script started (pid file at STATE_DIR)
  status      what is deployed at which address (reads contracts/deployments)
  --dry-run   print the plan and the dev-account table; change nothing
USAGE
}

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

fail_step() { # <step> <reason>
  echo "FAILED step '$1': $2" >&2
  exit 1
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# JSON field reader — `json_get <file> <dotted.path>` ("" when absent).
json_get() {
  node -e '
    const fs = require("fs");
    let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const key of process.argv[2].split(".")) {
      if (value == null) break;
      value = value[key];
    }
    if (value !== undefined && value !== null) console.log(String(value));
  ' "$1" "$2" 2>/dev/null || true
}

# First `roles[role=<name>].address` of a manifest ("" when absent).
manifest_role() { # <file> <role>
  node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = (manifest.roles ?? []).find((r) => r.role === process.argv[2]);
    if (entry) console.log(entry.address);
  ' "$1" "$2" 2>/dev/null || true
}

code_bytes() { # <address> -> decimal code size (0 = nothing deployed)
  local code
  code=$(cast code "$1" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")
  if [[ "$code" == "0x" || -z "$code" ]]; then echo 0; return; fi
  echo $(( (${#code} - 2) / 2 ))
}

rpc_chain_id() {
  cast chain-id --rpc-url "$RPC_URL" 2>/dev/null || true
}

rpc_client() {
  cast rpc web3_clientVersion --rpc-url "$RPC_URL" 2>/dev/null | tr -d '"' || true
}

rpc_alive() {
  curl -sf -m 2 -X POST -H 'content-type: application/json' "$RPC_URL" \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' >/dev/null 2>&1
}

# Is *something* accepting TCP connections on the RPC host:port? Node (already
# a required tool) instead of bash's `/dev/tcp`: an `exec` redirection failure
# can terminate a non-interactive shell before a `||` runs, which turned a
# "port is taken" probe into a silent non-zero exit (caught by
# scripts/dev-chain.test.mjs).
tcp_open() {
  node -e '
    const net = require("node:net");
    const socket = net.connect({
      host: process.argv[1],
      port: Number(process.argv[2]),
    });
    const finish = (ok) => {
      socket.destroy();
      process.exit(ok ? 0 : 1);
    };
    socket.setTimeout(1500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  ' "$RPC_HOST" "$RPC_PORT"
}

assert_loopback() {
  local host
  host="${RPC_URL#*://}"
  host="${host%%:*}"
  host="${host%%/*}"
  case "$host" in
    127.0.0.1|localhost|::1|"[::1]") return 0 ;;
  esac
  echo "REFUSING: RPC_URL $RPC_URL does not point at loopback (host '$host')." >&2
  echo "This script boots anvil, runs the packaged apptoken bootstrap and patches router storage — local dev chain only, NEVER a real network." >&2
  exit 1
}

# require_tools [tool ...] — defaults to everything this script can invoke.
require_tools() {
  local tools=("$@") tool
  if [[ ${#tools[@]} -eq 0 ]]; then
    tools=(cast forge anvil node curl)
  fi
  for tool in "${tools[@]}"; do
    command -v "$tool" >/dev/null || {
      echo "dev-chain: '$tool' not found (foundry + hermit; run '. ./bin/activate-hermit')" >&2
      exit 1
    }
  done
}

# The honest "port is taken by something that is not our dev chain" error.
occupied_error() { # <what answered>
  {
    echo "something is already listening — the dev-chain didn't start; the app can still use it if it's an anvil with the infra loaded — run the status recipe to check:"
    echo
    echo "    just dev-chain-status"
    echo
    echo "what answered on $RPC_URL: $1"
  } >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Dev accounts (anvil's well-known default keys — DEV ONLY, always labeled)
# ---------------------------------------------------------------------------

DEV_ROLES=(founder buyer1 buyer2)
DEV_KEYS=("$ANVIL_KEY" "$BUYER1_KEY" "$BUYER2_KEY")

dev_addresses() {
  local i
  DEV_ADDRESSES=()
  for i in "${!DEV_KEYS[@]}"; do
    DEV_ADDRESSES+=("$(cast wallet address --private-key "${DEV_KEYS[$i]}")")
  done
}

print_accounts() {
  echo
  echo "══════════════════════════ DEV-ONLY ACCOUNTS ══════════════════════════"
  echo "⚠  PRIVATE KEYS BELOW ARE ANVIL'S PUBLIC DEV KEYS — DEV ONLY."
  echo "   Use them on this local chain only; never anywhere else."
  printf '%-9s %-44s %s\n' "ROLE" "ACCOUNT" "PRIVATE KEY (DEV ONLY)"
  local i
  for i in "${!DEV_ROLES[@]}"; do
    printf '%-9s %-44s %s\n' "${DEV_ROLES[$i]}" "${DEV_ADDRESSES[$i]}" "${DEV_KEYS[$i]}"
  done
  echo "  founder  deployer, token treasury, DAO owner (anvil key 0)"
  echo "  buyer1   buyer + the DAO's second shareholder (anvil key 1)"
  echo "  buyer2   buyer (anvil key 2)"
  echo "═══════════════════════════════════════════════════════════════════════"
}

# ---------------------------------------------------------------------------
# The plan (shared by --dry-run and the real run's narration)
# ---------------------------------------------------------------------------

plan_lines() {
  local chain_state
  if rpc_alive; then
    chain_state="RUNNING — a dev anvil already answers (chain id $(rpc_chain_id)); step 1 skips"
  elif tcp_open; then
    chain_state="PORT OCCUPIED by something that is not a dev anvil — 'up' would refuse here, run the status recipe"
  else
    chain_state="NOT RUNNING — 'up' would boot anvil with chain id $DEV_CHAIN_ID"
  fi
  echo "  rpc:            $RPC_URL"
  echo "  chain:          $chain_state"
  echo "  state:          $STATE_DIR (anvil pid file + logs)"
  echo "  1. anvil        boot, log $LOG_FILE  [skipped: a dev anvil already answers]"
  echo "  2. apptoken infra  scripts/apptoken-infra.sh  [idempotent: skips deployed router/pools/validator and the DEV-ONLY allowlist patch]"
  echo "  3. org dao      forge script DeployOrgDao.s.sol  [skipped: deployments/org-dao-$DEV_CHAIN_ID.json names an OrgBinding that answers summoner()]"
  echo "  4. currency     $CURRENCY_NAME ($CURRENCY_SYMBOL, ${CURRENCY_DECIMALS}dp)  [skipped: deployments/dev-currency-$DEV_CHAIN_ID.json names a token that still says $CURRENCY_SYMBOL]"
  echo "  5. cca          place the CCA factory + Permit2 at their canonical addresses (anvil_setCode)  [skipped: the code there already matches the build output]"
  echo "  6. launch kit   deploy DaoLaunchKit (summoner + CCA factory + the Shares implementation)  [skipped: deployments/dao-launch-kit-$DEV_CHAIN_ID.json names a kit that still points at this summoner and factory]"
  echo "  6b. contributor kit  deploy ContributorKit (summoner)  [skipped: deployments/contributor-kit-$DEV_CHAIN_ID.json names a kit that still points at this summoner]"
  echo "  6c. work bounty  deploy WorkAreaBounty (currency + work budget factory)  [skipped: deployments/work-bounty-$DEV_CHAIN_ID.json names one that still points at both]"
  echo "  6d. open bounty  deploy OpenBounty (currency)  [skipped: deployments/open-bounty-$DEV_CHAIN_ID.json names one that still pays in it]"
  echo "  6e. optional features  test CREATE + faucet, court, forecasts, payouts factory, remix bonds, matched exit, weekly rounds  [skipped: each one's manifest names a contract that still has code]"
  echo "  7. fund         mint $CURRENCY_SYMBOL to founder/buyer1/buyer2  [idempotent: tops up only when a balance is short]"
  echo "  8. accounts     print the DEV-ONLY key table to stdout"
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------

boot_anvil() {
  if [[ -f "$PID_FILE" ]]; then
    local stale
    stale=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ -n "$stale" ]] && ! ps -p "$stale" >/dev/null 2>&1; then
      echo "── anvil: stale pid file (PID $stale is gone) — replacing"
      rm -f "$PID_FILE"
    fi
  fi
  mkdir -p "$STATE_DIR"
  echo "── anvil: booting on $RPC_HOST:$RPC_PORT (chain id $DEV_CHAIN_ID)"
  echo "   log: $LOG_FILE   pid: $PID_FILE"
  # --prune-history=500: the last 500 blocks' state stays in memory (about what anvil keeps there anyway) and none goes to
  # disk. Without it anvil spills older state to ~/.foundry/anvil/tmp (gigabytes on a long run) and leaves it there however
  # it is stopped, SIGINT included.
  nohup anvil --host "$RPC_HOST" --port "$RPC_PORT" --chain-id "$DEV_CHAIN_ID" --prune-history=500 \
    >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  local attempt
  for attempt in $(seq 1 50); do
    rpc_alive && break
    sleep 0.2
  done
  if ! rpc_alive; then
    echo "anvil did not answer on $RPC_URL — last 20 log lines:" >&2
    tail -20 "$LOG_FILE" >&2 || true
    # Never leave the process we started behind: a failed boot kills its own
    # anvil (a pid file with nothing under it is not a recovery path).
    kill "$pid" 2>/dev/null || true
    local attempt
    for attempt in $(seq 1 25); do
      ps -p "$pid" >/dev/null 2>&1 || break
      sleep 0.2
    done
    if ps -p "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    fail_step "anvil-boot" "no JSON-RPC on $RPC_URL after 10s"
  fi
  echo "   ✓ anvil up (PID $pid)"
}

# `apptoken infra` — scripts/apptoken-infra.sh, reused as-is. It is idempotent
# by construction and refuses non-loopback/non-anvil itself.
load_apptoken_infra() {
  echo
  echo "── apptoken infra: scripts/apptoken-infra.sh (bootstrap + DEV-ONLY router allowlist patch)"
  mkdir -p "$STATE_DIR"
  if (
    RPC_URL="$RPC_URL" bash "$REPO_ROOT/scripts/apptoken-infra.sh"
  ) 2>&1 | tee "$STATE_DIR/apptoken-infra.log"; then
    :
  else
    fail_step "apptoken-infra" "apptoken-infra.sh failed (its summary names the step)"
  fi
}

org_manifest_path() {
  echo "$DEPLOYMENTS_DIR/org-dao-${CHAIN_ID}.json"
}

# Guard: the manifest exists AND the OrgBinding it names still has code. A
# stale manifest over a restarted chain fails the code check, so the deploy
# re-runs instead of trusting the file.
org_dao_deployed() {
  local manifest factory
  manifest=$(org_manifest_path)
  [[ -f "$manifest" ]] || return 1
  factory=$(manifest_role "$manifest" "factory")
  [[ -n "$factory" ]] || return 1
  [[ "$(code_bytes "$factory")" != "0" ]] || return 1
  # Code is not identity: a fresh chain can hand a stale manifest's address to a
  # different contract (it did: the dev currency's old address became the
  # OrgBinding). An OrgBinding answers `summoner()` with an address that has code.
  local summoner
  summoner=$(cast call "$factory" "summoner()(address)" --rpc-url "$RPC_URL" 2>/dev/null || true)
  [[ -n "$summoner" && "$(code_bytes "$summoner")" != "0" ]]
}

deploy_org_dao() {
  echo
  if org_dao_deployed; then
    echo "── org dao: OrgBinding already at $(manifest_role "$(org_manifest_path)" factory) — skipped (idempotent)"
    return 0
  fi
  echo "── org dao: forge script DeployOrgDao.s.sol (OrgAllowance + OrgBinding + summon + bind + ownership handover)"
  mkdir -p "$STATE_DIR"
  if (
    cd "$REPO_ROOT/contracts"
    PRIVATE_KEY="$ANVIL_KEY" forge script script/DeployOrgDao.s.sol \
      --rpc-url "$RPC_URL" --broadcast -vv
  ) 2>&1 | tee "$ORG_DAO_LOG"; then
    :
  else
    fail_step "org-dao" "forge script DeployOrgDao.s.sol failed (output above)"
  fi
  local manifest factory
  manifest=$(org_manifest_path)
  [[ -f "$manifest" ]] || fail_step "org-dao" "no manifest written at $manifest"
  factory=$(manifest_role "$manifest" "factory")
  [[ -n "$factory" && "$(code_bytes "$factory")" != "0" ]] \
    || fail_step "org-dao" "manifest names no deployed OrgBinding (got '${factory:-<none>}')"
  echo "  ✓ OrgBinding at $factory (manifest $manifest)"
}

currency_manifest_path() {
  echo "$DEPLOYMENTS_DIR/dev-currency-${CHAIN_ID}.json"
}

currency_address() {
  manifest_role "$(currency_manifest_path)" "currency"
}

currency_deployed() {
  local manifest address
  manifest=$(currency_manifest_path)
  [[ -f "$manifest" ]] || return 1
  address=$(currency_address)
  [[ -n "$address" ]] || return 1
  [[ "$(code_bytes "$address")" != "0" ]] || return 1
  # Identity, not just code (see org_dao_deployed): the token must still say who it is.
  local symbol
  symbol=$(cast call "$address" "symbol()(string)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '"' || true)
  [[ "$symbol" == "$CURRENCY_SYMBOL" ]]
}

deploy_currency() {
  echo
  if currency_deployed; then
    echo "── currency: $CURRENCY_SYMBOL already at $(currency_address) — skipped (idempotent)"
    return 0
  fi
  echo "── currency: deploying $CURRENCY_NAME ($CURRENCY_SYMBOL, ${CURRENCY_DECIMALS}dp) — MockPairedTokenERC20"

  # Compile just the mock (incremental; `forge build` covers the rest of the
  # workspace for the org-dao step).
  if ! (cd "$REPO_ROOT/contracts" && forge build "$MOCK_ERC20_PATH") >/dev/null; then
    fail_step "currency" "forge build $MOCK_ERC20_PATH failed"
  fi
  local bytecode args data receipt status address block
  bytecode=$(node -e '
    const artifact = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!artifact.bytecode?.object) throw new Error("no creation bytecode in artifact");
    console.log(artifact.bytecode.object);
  ' "$REPO_ROOT/contracts/out/MockPairedTokenERC20.sol/MockPairedTokenERC20.json") \
    || fail_step "currency" "cannot read MockPairedTokenERC20 artifact"
  args=$(cast abi-encode "constructor(string,string,uint8)" \
    "$CURRENCY_NAME" "$CURRENCY_SYMBOL" "$CURRENCY_DECIMALS") \
    || fail_step "currency" "cast abi-encode constructor args failed"
  data="0x${bytecode#0x}${args#0x}"

  # `--create` goes immediately before the init code: with `cast send`, flags
  # that follow `--create` are parsed as call arguments and clap rejects them
  # ("unexpected argument '--private-key'").
  if ! receipt=$(cast send --json --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" \
      --create "$data" 2>&1); then
    echo "$receipt" >&2
    fail_step "currency" "cast send --create failed"
  fi
  status=$(node -e '
    const r = JSON.parse(process.argv[1]);
    console.log(r.status === "0x1" || r.status === 1 ? "success" : String(r.status ?? "?"));
  ' "$receipt")
  address=$(node -e '
    const r = JSON.parse(process.argv[1]);
    console.log(r.contractAddress ?? "");
  ' "$receipt")
  block=$(node -e '
    const r = JSON.parse(process.argv[1]);
    console.log(Number(BigInt(r.blockNumber ?? "0x0")));
  ' "$receipt")
  [[ "$status" == "success" && -n "$address" ]] \
    || fail_step "currency" "deploy tx mined as ${status:-unknown} (no address)"
  [[ "$(code_bytes "$address")" != "0" ]] \
    || fail_step "currency" "receipt reported $address but there is no code there"

  # Same envelope the org-dao manifest uses, so `dev-chain-status` (and any
  # other reader) treats all three manifests alike. `role: currency` is not
  # part of the kind:37018 grammar (`summoner|factory|implementation`), which
  # is deliberate: a dev currency mock is not an org deployment record.
  node -e '
    const fs = require("fs");
    const [file, chainId, tx, block, address] = process.argv.slice(1);
    const manifest = {
      chainId: Number(chainId),
      project: "buzz-dev-chain",
      note: "scripts/dev-chain.sh — forge build MockPairedTokenERC20(Dev USDC, dUSDC, 6)",
      tx,
      block: Number(block),
      roles: [{ role: "currency", address }],
    };
    fs.writeFileSync(file, JSON.stringify(manifest) + "\n");
  ' "$(currency_manifest_path)" "$CHAIN_ID" \
    "$(node -e 'console.log(JSON.parse(process.argv[1]).transactionHash ?? "")' "$receipt")" \
    "$block" "$address" \
    || fail_step "currency" "deployed at $address but could not write $(currency_manifest_path)"
  echo "  ✓ $CURRENCY_SYMBOL at $address (manifest $(currency_manifest_path))"
}

# The CCA factory and Permit2 exist only on forks of a public chain, so a raise could
# not run on a bare dev chain. Put their runtime code at the canonical addresses, the
# same way the removed scripts/web-auction-e2e.sh did (D150). "Already there" means the code MATCHES the
# build output, not merely that something has code at the address.
CCA_FACTORY_ADDRESS="0x000000001F26a0044BaA66024e7b6599c61963F8"
PERMIT2_ADDRESS="0x000000000022D473030F116dDEE9F6B43aC78BA3"

artifact_field() { # <artifact.json> <dotted.path> -> value
  node -e '
    const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(process.argv[2].split(".").reduce((o, k) => o[k], a));
  ' "$1" "$2"
}

lower_code() { cast code "$1" --rpc-url "$RPC_URL" 2>/dev/null | tr '[:upper:]' '[:lower:]'; }

deploy_artifact() { # <artifact.json> -> the address of a fresh deployment that takes no constructor arguments
  local bytecode receipt address
  bytecode=$(artifact_field "$1" bytecode.object) || return 1
  receipt=$(cast send --json --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" --create "0x${bytecode#0x}" 2>&1) \
    || { echo "$receipt" >&2; return 1; }
  address=$(node -e 'console.log(JSON.parse(process.argv[1]).contractAddress ?? "")' "$receipt")
  [[ -n "$address" && "$(code_bytes "$address")" != "0" ]] || return 1
  echo "$address"
}

place_cca() {
  echo
  local factory_json="$REPO_ROOT/contracts/out/ContinuousClearingAuctionFactory.sol/ContinuousClearingAuctionFactory.json"
  local permit2_json="$REPO_ROOT/contracts/out/Permit2.sol/Permit2.json"
  if [[ ! -f "$factory_json" || ! -f "$permit2_json" ]]; then
    echo "── cca: building contracts for the factory and Permit2 artifacts"
    (cd "$REPO_ROOT/contracts" && FOUNDRY_LINT_LINT_ON_BUILD=false forge build >/dev/null) \
      || fail_step "cca" "forge build failed"
  fi
  local want
  want=$(artifact_field "$factory_json" deployedBytecode.object | tr '[:upper:]' '[:lower:]')
  if [[ "$(lower_code "$CCA_FACTORY_ADDRESS")" == "$want" ]]; then
    echo "── cca: factory already at $CCA_FACTORY_ADDRESS — skipped (code matches the build)"
  else
    cast rpc --rpc-url "$RPC_URL" anvil_setCode "$CCA_FACTORY_ADDRESS" "$want" >/dev/null \
      || fail_step "cca" "anvil_setCode for the factory failed"
    [[ "$(lower_code "$CCA_FACTORY_ADDRESS")" == "$want" ]] \
      || fail_step "cca" "factory code at $CCA_FACTORY_ADDRESS does not match the build"
    echo "  ✓ CCA factory at $CCA_FACTORY_ADDRESS"
  fi
  # Permit2: deploy once, copy its runtime code (constructor-resolved values included).
  if [[ "$(code_bytes "$PERMIT2_ADDRESS")" != "0" ]]; then
    echo "── cca: Permit2 already at $PERMIT2_ADDRESS — skipped"
  else
    local bytecode receipt tmp code
    bytecode=$(artifact_field "$permit2_json" bytecode.object)
    receipt=$(cast send --json --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" --create "$bytecode") \
      || fail_step "cca" "deploying Permit2 failed"
    tmp=$(echo "$receipt" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).contractAddress))')
    code=$(cast code "$tmp" --rpc-url "$RPC_URL")
    cast rpc --rpc-url "$RPC_URL" anvil_setCode "$PERMIT2_ADDRESS" "$code" >/dev/null \
      || fail_step "cca" "anvil_setCode for Permit2 failed"
    [[ "$(code_bytes "$PERMIT2_ADDRESS")" != "0" ]] || fail_step "cca" "Permit2 has no code at $PERMIT2_ADDRESS"
    echo "  ✓ Permit2 at $PERMIT2_ADDRESS"
  fi
}

kit_manifest_path() {
  echo "$DEPLOYMENTS_DIR/dao-launch-kit-${CHAIN_ID}.json"
}

kit_address() {
  manifest_role "$(kit_manifest_path)" "launch-kit"
}

# The Shares implementation every DAO this summoner makes clones. A DAO's Shares is a minimal proxy: nine bytes of
# prefix, the implementation's address, then the tail, so read it off the newest DAO the summoner made. The kit needs
# it to predict where a new DAO's Shares will be (it sets the team's lock there before the DAO exists).
shares_implementation() { # <summoner> -> address
  local dao shares code
  dao=$(cast logs --json --rpc-url "$RPC_URL" --from-block 0 --address "$1" "NewDAO(address,address)" 2>/dev/null \
    | node -e '
      const logs = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (logs.length) console.log("0x" + logs[logs.length - 1].topics[2].slice(-40));
    ' 2>/dev/null || true)
  [[ -n "$dao" ]] || return 1
  shares=$(cast call "$dao" "shares()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}') || return 1
  [[ -n "$shares" ]] || return 1
  code=$(cast code "$shares" --rpc-url "$RPC_URL" 2>/dev/null) || return 1
  # "0x" + 9 bytes (18 hex characters) of prefix, then 20 bytes (40 characters).
  [[ ${#code} -ge 60 ]] || return 1
  echo "0x${code:20:40}"
}

# Guard: the manifest exists, its kit has code, and it still points at THIS chain's Summoner and CCA factory.
# A kit left over from a chain that was restarted (fresh state, stale manifest) names a summoner that is gone.
launch_kit_deployed() {
  local manifest address summoner want_summoner got_factory
  manifest=$(kit_manifest_path)
  [[ -f "$manifest" ]] || return 1
  address=$(kit_address)
  [[ -n "$address" ]] || return 1
  [[ "$(code_bytes "$address")" != "0" ]] || return 1
  want_summoner=$(lower "$(manifest_role "$(org_manifest_path)" summoner)")
  summoner=$(cast call "$address" "summoner()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  got_factory=$(cast call "$address" "factory()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  [[ -n "$want_summoner" && "$(lower "$summoner")" == "$want_summoner" ]] \
    && [[ "$(lower "$got_factory")" == "$(lower "$CCA_FACTORY_ADDRESS")" ]] \
    && [[ -n "$(cast call "$address" "sharesImplementation()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1)" ]] \
    && [[ -n "$(cast call "$address" "mandateFactory()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1)" ]]
}

deploy_launch_kit() {
  echo
  if launch_kit_deployed; then
    echo "── launch kit: already at $(kit_address) — skipped (idempotent)"
    return 0
  fi
  local summoner
  summoner=$(manifest_role "$(org_manifest_path)" summoner)
  [[ -n "$summoner" && "$(code_bytes "$summoner")" != "0" ]] \
    || fail_step "launch-kit" "no deployed Summoner to point the kit at (org dao step first)"
  echo "── launch kit: deploying DaoLaunchKit (summoner $summoner, CCA factory $CCA_FACTORY_ADDRESS)"
  if ! (cd "$REPO_ROOT/contracts" && FOUNDRY_LINT_LINT_ON_BUILD=false forge build src/DaoLaunchKit.sol \
      src/MilestoneLockFactory.sol src/MilestoneChallengeFactory.sol) >/dev/null; then
    fail_step "launch-kit" "forge build src/DaoLaunchKit.sol failed"
  fi
  # The two lock factories are deployed beside the kit, which names them (its creation code has no room for them).
  local lock_factory challenge_factory
  lock_factory=$(deploy_artifact "$REPO_ROOT/contracts/out/MilestoneLockFactory.sol/MilestoneLockFactory.json") \
    || fail_step "launch-kit" "deploying MilestoneLockFactory failed"
  challenge_factory=$(deploy_artifact "$REPO_ROOT/contracts/out/MilestoneChallengeFactory.sol/MilestoneChallengeFactory.json") \
    || fail_step "launch-kit" "deploying MilestoneChallengeFactory failed"
  local bytecode args data receipt status address block shares_impl
  shares_impl=$(shares_implementation "$summoner") \
    || fail_step "launch-kit" "cannot read the Shares implementation off a DAO this summoner made"
  [[ "$(code_bytes "$shares_impl")" != "0" ]] \
    || fail_step "launch-kit" "the Shares implementation $shares_impl has no code"
  bytecode=$(artifact_field "$REPO_ROOT/contracts/out/DaoLaunchKit.sol/DaoLaunchKit.json" bytecode.object) \
    || fail_step "launch-kit" "cannot read the DaoLaunchKit artifact"
  args=$(cast abi-encode "constructor(address,address,address,address,address)" "$summoner" "$CCA_FACTORY_ADDRESS" \
      "$shares_impl" "$lock_factory" "$challenge_factory") \
    || fail_step "launch-kit" "cast abi-encode constructor args failed"
  data="0x${bytecode#0x}${args#0x}"
  if ! receipt=$(cast send --json --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" \
      --create "$data" 2>&1); then
    echo "$receipt" >&2
    fail_step "launch-kit" "cast send --create failed"
  fi
  status=$(node -e '
    const r = JSON.parse(process.argv[1]);
    console.log(r.status === "0x1" || r.status === 1 ? "success" : String(r.status ?? "?"));
  ' "$receipt")
  address=$(node -e 'console.log(JSON.parse(process.argv[1]).contractAddress ?? "")' "$receipt")
  block=$(node -e 'console.log(Number(BigInt(JSON.parse(process.argv[1]).blockNumber ?? "0x0")))' "$receipt")
  [[ "$status" == "success" && -n "$address" ]] \
    || fail_step "launch-kit" "deploy tx mined as ${status:-unknown} (no address)"
  [[ "$(code_bytes "$address")" != "0" ]] \
    || fail_step "launch-kit" "receipt reported $address but there is no code there"
  [[ "$(lower "$(cast call "$address" "sharesImplementation()(address)" --rpc-url "$RPC_URL" | head -1 | awk '{print $1}')")" == "$(lower "$shares_impl")" ]] \
    || fail_step "launch-kit" "the deployed kit does not report the Shares implementation $shares_impl"
  node -e '
    const fs = require("fs");
    const [file, chainId, tx, block, address] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({
      chainId: Number(chainId),
      project: "buzz-dev-chain",
      note: "scripts/dev-chain.sh — DaoLaunchKit(summoner, CCA factory, Shares implementation, lock factories)",
      tx,
      block: Number(block),
      roles: [{ role: "launch-kit", address }],
    }) + "\n");
  ' "$(kit_manifest_path)" "$CHAIN_ID" \
    "$(node -e 'console.log(JSON.parse(process.argv[1]).transactionHash ?? "")' "$receipt")" \
    "$block" "$address" \
    || fail_step "launch-kit" "deployed at $address but could not write $(kit_manifest_path)"
  echo "  ✓ DaoLaunchKit at $address (manifest $(kit_manifest_path))"
}

contributor_kit_manifest_path() {
  echo "$DEPLOYMENTS_DIR/contributor-kit-${CHAIN_ID}.json"
}

contributor_kit_address() {
  manifest_role "$(contributor_kit_manifest_path)" "contributor-kit"
}

# Guard: the manifest exists, its kit has code, and it still points at THIS chain's Summoner.
contributor_kit_deployed() {
  local address summoner want_summoner
  [[ -f "$(contributor_kit_manifest_path)" ]] || return 1
  address=$(contributor_kit_address)
  [[ -n "$address" && "$(code_bytes "$address")" != "0" ]] || return 1
  want_summoner=$(lower "$(manifest_role "$(org_manifest_path)" summoner)")
  summoner=$(cast call "$address" "summoner()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  [[ -n "$want_summoner" && "$(lower "$summoner")" == "$want_summoner" ]]
}

deploy_contributor_kit() {
  echo
  if contributor_kit_deployed; then
    echo "── contributor kit: already at $(contributor_kit_address) — skipped (idempotent)"
    return 0
  fi
  local summoner bytecode args receipt status address block
  summoner=$(manifest_role "$(org_manifest_path)" summoner)
  [[ -n "$summoner" && "$(code_bytes "$summoner")" != "0" ]] \
    || fail_step "contributor-kit" "no deployed Summoner to point the kit at (org dao step first)"
  echo "── contributor kit: deploying ContributorKit (summoner $summoner)"
  if ! (cd "$REPO_ROOT/contracts" && FOUNDRY_LINT_LINT_ON_BUILD=false forge build src/ContributorKit.sol) >/dev/null; then
    fail_step "contributor-kit" "forge build src/ContributorKit.sol failed"
  fi
  bytecode=$(artifact_field "$REPO_ROOT/contracts/out/ContributorKit.sol/ContributorKit.json" bytecode.object) \
    || fail_step "contributor-kit" "cannot read the ContributorKit artifact"
  args=$(cast abi-encode "constructor(address)" "$summoner") \
    || fail_step "contributor-kit" "cast abi-encode constructor args failed"
  if ! receipt=$(cast send --json --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" \
      --create "0x${bytecode#0x}${args#0x}" 2>&1); then
    echo "$receipt" >&2
    fail_step "contributor-kit" "cast send --create failed"
  fi
  status=$(node -e '
    const r = JSON.parse(process.argv[1]);
    console.log(r.status === "0x1" || r.status === 1 ? "success" : String(r.status ?? "?"));
  ' "$receipt")
  address=$(node -e 'console.log(JSON.parse(process.argv[1]).contractAddress ?? "")' "$receipt")
  block=$(node -e 'console.log(Number(BigInt(JSON.parse(process.argv[1]).blockNumber ?? "0x0")))' "$receipt")
  [[ "$status" == "success" && -n "$address" && "$(code_bytes "$address")" != "0" ]] \
    || fail_step "contributor-kit" "deploy tx mined as ${status:-unknown} (no code at ${address:-<none>})"
  [[ "$(lower "$(cast call "$address" "summoner()(address)" --rpc-url "$RPC_URL" | head -1 | awk '{print $1}')")" == "$(lower "$summoner")" ]] \
    || fail_step "contributor-kit" "the deployed kit does not report the summoner $summoner"
  node -e '
    const fs = require("fs");
    const [file, chainId, tx, block, address] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({
      chainId: Number(chainId),
      project: "buzz-dev-chain",
      note: "scripts/dev-chain.sh — ContributorKit(summoner)",
      tx,
      block: Number(block),
      roles: [{ role: "contributor-kit", address }],
    }) + "\n");
  ' "$(contributor_kit_manifest_path)" "$CHAIN_ID" \
    "$(node -e 'console.log(JSON.parse(process.argv[1]).transactionHash ?? "")' "$receipt")" \
    "$block" "$address" \
    || fail_step "contributor-kit" "deployed at $address but could not write $(contributor_kit_manifest_path)"
  echo "  ✓ ContributorKit at $address (manifest $(contributor_kit_manifest_path))"
}

work_bounty_manifest_path() {
  echo "$DEPLOYMENTS_DIR/work-bounty-${CHAIN_ID}.json"
}

work_bounty_address() {
  manifest_role "$(work_bounty_manifest_path)" "work-bounty"
}

# Guard: the manifest exists, its contract has code, and it still names THIS chain's currency and work budget factory.
work_bounty_deployed() {
  local address want_factory factory currency
  [[ -f "$(work_bounty_manifest_path)" ]] || return 1
  address=$(work_bounty_address)
  [[ -n "$address" && "$(code_bytes "$address")" != "0" ]] || return 1
  want_factory=$(cast call "$(manifest_role "$(org_manifest_path)" summoner)" "mandateFactory()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  factory=$(cast call "$address" "factory()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  currency=$(cast call "$address" "currency()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  [[ -n "$want_factory" && "$(lower "$factory")" == "$(lower "$want_factory")" && "$(lower "$currency")" == "$(lower "$(currency_address)")" ]]
}

# The bounties on work areas (N1): outside money paid to a released submission, refunded otherwise.
deploy_work_bounty() {
  echo
  if work_bounty_deployed; then
    echo "── work bounty: already at $(work_bounty_address) — skipped (idempotent)"
    return 0
  fi
  local summoner factory currency bytecode args receipt status address block
  summoner=$(manifest_role "$(org_manifest_path)" summoner)
  [[ -n "$summoner" && "$(code_bytes "$summoner")" != "0" ]] \
    || fail_step "work-bounty" "no deployed Summoner to read the work budget factory from (org dao step first)"
  factory=$(cast call "$summoner" "mandateFactory()(address)" --rpc-url "$RPC_URL" | head -1 | awk '{print $1}')
  currency=$(currency_address)
  [[ -n "$currency" && "$(code_bytes "$currency")" != "0" ]] \
    || fail_step "work-bounty" "no currency token to pay bounties in (currency step first)"
  echo "── work bounty: deploying WorkAreaBounty (currency $currency, work budget factory $factory)"
  if ! (cd "$REPO_ROOT/contracts" && FOUNDRY_LINT_LINT_ON_BUILD=false forge build src/WorkAreaBounty.sol) >/dev/null; then
    fail_step "work-bounty" "forge build src/WorkAreaBounty.sol failed"
  fi
  bytecode=$(artifact_field "$REPO_ROOT/contracts/out/WorkAreaBounty.sol/WorkAreaBounty.json" bytecode.object) \
    || fail_step "work-bounty" "cannot read the WorkAreaBounty artifact"
  args=$(cast abi-encode "constructor(address,address)" "$currency" "$factory") \
    || fail_step "work-bounty" "cast abi-encode constructor args failed"
  if ! receipt=$(cast send --json --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" \
      --create "0x${bytecode#0x}${args#0x}" 2>&1); then
    echo "$receipt" >&2
    fail_step "work-bounty" "cast send --create failed"
  fi
  status=$(node -e '
    const r = JSON.parse(process.argv[1]);
    console.log(r.status === "0x1" || r.status === 1 ? "success" : String(r.status ?? "?"));
  ' "$receipt")
  address=$(node -e 'console.log(JSON.parse(process.argv[1]).contractAddress ?? "")' "$receipt")
  block=$(node -e 'console.log(Number(BigInt(JSON.parse(process.argv[1]).blockNumber ?? "0x0")))' "$receipt")
  [[ "$status" == "success" && -n "$address" && "$(code_bytes "$address")" != "0" ]] \
    || fail_step "work-bounty" "deploy tx mined as ${status:-unknown} (no code at ${address:-<none>})"
  node -e '
    const fs = require("fs");
    const [file, chainId, tx, block, address] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({
      chainId: Number(chainId),
      project: "buzz-dev-chain",
      note: "scripts/dev-chain.sh — WorkAreaBounty(currency, work budget factory)",
      tx,
      block: Number(block),
      roles: [{ role: "work-bounty", address }],
    }) + "\n");
  ' "$(work_bounty_manifest_path)" "$CHAIN_ID" \
    "$(node -e 'console.log(JSON.parse(process.argv[1]).transactionHash ?? "")' "$receipt")" \
    "$block" "$address" \
    || fail_step "work-bounty" "deployed at $address but could not write $(work_bounty_manifest_path)"
  work_bounty_deployed || fail_step "work-bounty" "the deployed bounty does not name this chain's currency and work budget factory"
  echo "  ✓ WorkAreaBounty at $address (manifest $(work_bounty_manifest_path))"
}

open_bounty_manifest_path() {
  echo "$DEPLOYMENTS_DIR/open-bounty-${CHAIN_ID}.json"
}

open_bounty_address() {
  manifest_role "$(open_bounty_manifest_path)" "open-bounty"
}

matched_exit_manifest_path() {
  echo "$DEPLOYMENTS_DIR/matched-exit-${CHAIN_ID}.json"
}

matched_exit_address() {
  manifest_role "$(matched_exit_manifest_path)" "matched-exit"
}

# Guard: the manifest at $1 names role $2, its contract has code, and it still pays in THIS chain's currency.
currency_contract_deployed() {
  local manifest=$1 role=$2 address currency
  [[ -f "$manifest" ]] || return 1
  address=$(manifest_role "$manifest" "$role")
  [[ -n "$address" && "$(code_bytes "$address")" != "0" ]] || return 1
  currency=$(cast call "$address" "currency()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  [[ "$(lower "$currency")" == "$(lower "$(currency_address)")" ]]
}

# The open bounty must also name this chain's court (N7), so its claimants can appeal.
open_bounty_deployed() {
  local named
  currency_contract_deployed "$(open_bounty_manifest_path)" open-bounty || return 1
  named=$(cast call "$(open_bounty_address)" "court()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  [[ "$(lower "$named")" == "$(lower "$(court_address)")" ]]
}

matched_exit_deployed() {
  currency_contract_deployed "$(matched_exit_manifest_path)" matched-exit
}

# Deploy a contract whose first constructor argument is this chain's currency: $1 the role, $2 the contract (its file is
# src/$2.sol), $3 the manifest path, $4 what it is for (said once in the log), $5 a second, uint256 argument if it takes one.
deploy_currency_contract() {
  local role=$1 contract=$2 manifest=$3 purpose=$4 extra=${5:-}
  echo
  if currency_contract_deployed "$manifest" "$role"; then
    echo "── $role: already at $(manifest_role "$manifest" "$role") — skipped (idempotent)"
    return 0
  fi
  local currency bytecode args receipt status address block
  currency=$(currency_address)
  [[ -n "$currency" && "$(code_bytes "$currency")" != "0" ]] \
    || fail_step "$role" "no currency token to pay in (currency step first)"
  echo "── $role: deploying $contract (currency $currency): $purpose"
  if ! (cd "$REPO_ROOT/contracts" && FOUNDRY_LINT_LINT_ON_BUILD=false forge build "src/$contract.sol") >/dev/null; then
    fail_step "$role" "forge build src/$contract.sol failed"
  fi
  bytecode=$(artifact_field "$REPO_ROOT/contracts/out/$contract.sol/$contract.json" bytecode.object) \
    || fail_step "$role" "cannot read the $contract artifact"
  if [[ -n "$extra" ]]; then
    args=$(cast abi-encode "constructor(address,uint256)" "$currency" "$extra")
  else
    args=$(cast abi-encode "constructor(address)" "$currency")
  fi || fail_step "$role" "cast abi-encode constructor args failed"
  if ! receipt=$(cast send --json --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" \
      --create "0x${bytecode#0x}${args#0x}" 2>&1); then
    echo "$receipt" >&2
    fail_step "$role" "cast send --create failed"
  fi
  status=$(node -e '
    const r = JSON.parse(process.argv[1]);
    console.log(r.status === "0x1" || r.status === 1 ? "success" : String(r.status ?? "?"));
  ' "$receipt")
  address=$(node -e 'console.log(JSON.parse(process.argv[1]).contractAddress ?? "")' "$receipt")
  block=$(node -e 'console.log(Number(BigInt(JSON.parse(process.argv[1]).blockNumber ?? "0x0")))' "$receipt")
  [[ "$status" == "success" && -n "$address" && "$(code_bytes "$address")" != "0" ]] \
    || fail_step "$role" "deploy tx mined as ${status:-unknown} (no code at ${address:-<none>})"
  node -e '
    const fs = require("fs");
    const [file, chainId, tx, block, address, role, contract] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({
      chainId: Number(chainId),
      project: "buzz-dev-chain",
      note: `scripts/dev-chain.sh — ${contract}(currency)`,
      tx,
      block: Number(block),
      roles: [{ role, address }],
    }) + "\n");
  ' "$manifest" "$CHAIN_ID" \
    "$(node -e 'console.log(JSON.parse(process.argv[1]).transactionHash ?? "")' "$receipt")" \
    "$block" "$address" "$role" "$contract" \
    || fail_step "$role" "deployed at $address but could not write $manifest"
  currency_contract_deployed "$manifest" "$role" || fail_step "$role" "the deployed $contract does not pay in this chain's currency"
  echo "  ✓ $contract at $address (manifest $manifest)"
}

# The bounties on posts (N2): money behind a post, paid to the claim that keeps a majority of it, refunded otherwise;
# a claimant can appeal to the court (N7).
deploy_open_bounty() {
  echo
  if open_bounty_deployed; then
    echo "── open-bounty: already at $(open_bounty_address) — skipped (idempotent)"
    return 0
  fi
  local currency court address
  currency=$(currency_address)
  court=$(court_address)
  [[ -n "$court" && "$(code_bytes "$court")" != "0" ]] || fail_step "open-bounty" "no court to appeal to (court step first)"
  echo "── open-bounty: deploying OpenBounty (currency $currency, court $court)"
  address=$(create_from_artifact open-bounty OpenBounty "$(cast abi-encode "constructor(address,address)" "$currency" "$court")")
  write_one_role_manifest "$(open_bounty_manifest_path)" open-bounty "$address" "OpenBounty(currency, court)"
  open_bounty_deployed || fail_step "open-bounty" "the deployed bounty does not pay in this chain's currency or name its court"
  echo "  ✓ OpenBounty at $address (manifest $(open_bounty_manifest_path))"
}

forecast_pool_manifest_path() {
  echo "$DEPLOYMENTS_DIR/forecast-pool-${CHAIN_ID}.json"
}

forecast_pool_address() {
  manifest_role "$(forecast_pool_manifest_path)" "forecast-pool"
}

# Guard: the pools have code and read this chain's bounties on posts.
forecast_pool_deployed() {
  local pools named
  [[ -f "$(forecast_pool_manifest_path)" ]] || return 1
  pools=$(forecast_pool_address)
  [[ -n "$pools" && "$(code_bytes "$pools")" != "0" ]] || return 1
  named=$(cast call "$pools" "bounties()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  [[ "$(lower "$named")" == "$(lower "$(open_bounty_address)")" ]]
}

# Money forecasts (N8): two pools of people's own money on whether a bounty on a post is paid. Test networks only.
# Contract only since D150: the app no longer shows them (tag pre-deprecation-2026-10-31); kept until the contracts clean-up.
deploy_forecast_pool() {
  echo
  if forecast_pool_deployed; then
    echo "── forecast-pool: already at $(forecast_pool_address) — skipped (idempotent)"
    return 0
  fi
  local address
  echo "── forecast-pool: deploying ForecastPool (currency $(currency_address), bounties $(open_bounty_address))"
  address=$(create_from_artifact forecast-pool ForecastPool "$(cast abi-encode "constructor(address,address)" \
    "$(currency_address)" "$(open_bounty_address)")")
  write_one_role_manifest "$(forecast_pool_manifest_path)" forecast-pool "$address" "ForecastPool(currency, open bounty)"
  forecast_pool_deployed || fail_step "forecast-pool" "the deployed pools do not read this chain's bounties on posts"
  echo "  ✓ ForecastPool at $address (manifest $(forecast_pool_manifest_path))"
}

payouts_factory_manifest_path() {
  echo "$DEPLOYMENTS_DIR/payouts-factory-${CHAIN_ID}.json"
}

payouts_factory_address() {
  manifest_role "$(payouts_factory_manifest_path)" "payouts-factory"
}

# Payouts to holders (N10): the factory DAOs vote to make their payout module with. Test networks only. It is not
# deployed here: the work budget factory made it, and the DAOs accept modules from it alone.
deploy_payouts_factory() {
  echo
  local summoner factory address
  summoner=$(manifest_role "$(org_manifest_path)" summoner)
  [[ -n "$summoner" && "$(code_bytes "$summoner")" != "0" ]] \
    || fail_step "payouts-factory" "no deployed Summoner to read the payouts factory from (org dao step first)"
  factory=$(cast call "$summoner" "mandateFactory()(address)" --rpc-url "$RPC_URL" | head -1 | awk '{print $1}')
  address=$(cast call "$factory" "payoutsFactory()(address)" --rpc-url "$RPC_URL" | head -1 | awk '{print $1}')
  [[ -n "$address" && "$(code_bytes "$address")" != "0" ]] \
    || fail_step "payouts-factory" "the work budget factory $factory names no payouts factory"
  write_one_role_manifest "$(payouts_factory_manifest_path)" payouts-factory "$address" "PayoutsFactory"
  echo "── payouts-factory: the work budget factory's, at $address (manifest $(payouts_factory_manifest_path))"
}

remix_bonds_manifest_path() {
  echo "$DEPLOYMENTS_DIR/remix-bonds-${CHAIN_ID}.json"
}

remix_bonds_address() {
  manifest_role "$(remix_bonds_manifest_path)" "remix-bonds"
}

# A remix's bond to its parent (N12): CREATE held for a term, cased in the court. Test networks only.
deploy_remix_bonds() {
  echo
  local address=""
  [[ -f "$(remix_bonds_manifest_path)" ]] && address=$(remix_bonds_address)
  if [[ -n "$address" && "$(code_bytes "$address")" != "0" ]]; then
    echo "── remix-bonds: already at $address — skipped (idempotent)"
    return 0
  fi
  echo "── remix-bonds: deploying RemixBond (CREATE $(create_token_address), court $(court_address))"
  address=$(create_from_artifact remix-bonds RemixBond "$(cast abi-encode "constructor(address,address)" \
    "$(create_token_address)" "$(court_address)")")
  write_one_role_manifest "$(remix_bonds_manifest_path)" remix-bonds "$address" "RemixBond(CREATE, court)"
  echo "  ✓ RemixBond at $address (manifest $(remix_bonds_manifest_path))"
}

court_manifest_path() {
  echo "$DEPLOYMENTS_DIR/court-${CHAIN_ID}.json"
}

court_address() {
  manifest_role "$(court_manifest_path)" "court"
}

# Guard: the court has code and stakes this chain's test CREATE and takes fees in its currency.
court_deployed() {
  local court stake fee
  [[ -f "$(court_manifest_path)" ]] || return 1
  court=$(court_address)
  [[ -n "$court" && "$(code_bytes "$court")" != "0" ]] || return 1
  stake=$(cast call "$court" "stakeToken()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  fee=$(cast call "$court" "feeToken()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  [[ "$(lower "$stake")" == "$(lower "$(create_token_address)")" && "$(lower "$fee")" == "$(lower "$(currency_address)")" ]]
}

# The court (N7): jurors stake test CREATE (100 a seat) and are paid in the currency (1 a seat per round).
deploy_court() {
  echo
  if court_deployed; then
    echo "── court: already at $(court_address) — skipped (idempotent)"
    return 0
  fi
  local address
  echo "── court: deploying CreateCourt (stake $(create_token_address), fees in $(currency_address))"
  address=$(create_from_artifact court CreateCourt "$(cast abi-encode "constructor(address,address,uint256,uint256)" \
    "$(create_token_address)" "$(currency_address)" 100000000000000000000 1000000)")
  write_one_role_manifest "$(court_manifest_path)" court "$address" "CreateCourt(test CREATE, currency, 100 a seat, 1 a seat)"
  court_deployed || fail_step "court" "the deployed court does not stake test CREATE or take this currency"
  echo "  ✓ CreateCourt at $address (manifest $(court_manifest_path))"
}

# $1 manifest, $2 role, $3 address, $4 note.
write_one_role_manifest() {
  node -e '
    const fs = require("fs");
    const [file, chainId, role, address, note] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({
      chainId: Number(chainId),
      project: "buzz-dev-chain",
      note: `scripts/dev-chain.sh — ${note}`,
      roles: [{ role, address }],
    }) + "\n");
  ' "$1" "$CHAIN_ID" "$2" "$3" "$4" || fail_step "$2" "deployed at $3 but could not write $1"
}

# Matched exits (N5): members sell Shares to people who want in, once their DAO names this exchange by vote.
deploy_matched_exit() {
  deploy_currency_contract matched-exit MatchedExit "$(matched_exit_manifest_path)" "sales between members"
}

weekly_rounds_manifest_path() {
  echo "$DEPLOYMENTS_DIR/weekly-rounds-${CHAIN_ID}.json"
}

weekly_rounds_address() {
  manifest_role "$(weekly_rounds_manifest_path)" "weekly-rounds"
}

# Weekly rounds between holders and new buyers: its smallest price step is one cent of the currency a whole unit.
deploy_weekly_rounds() {
  deploy_currency_contract weekly-rounds WeeklyRounds "$(weekly_rounds_manifest_path)" \
    "weekly rounds between holders and new buyers" "$((10 ** (CURRENCY_DECIMALS - 2)))"
}

create_manifest_path() {
  echo "$DEPLOYMENTS_DIR/create-${CHAIN_ID}.json"
}

create_token_address() {
  manifest_role "$(create_manifest_path)" "create-token"
}

create_faucet_address() {
  manifest_role "$(create_manifest_path)" "create-faucet"
}

# Guard: both have code, and the faucet hands out this token.
create_deployed() {
  local token faucet named
  [[ -f "$(create_manifest_path)" ]] || return 1
  token=$(create_token_address)
  faucet=$(create_faucet_address)
  [[ -n "$token" && "$(code_bytes "$token")" != "0" && -n "$faucet" && "$(code_bytes "$faucet")" != "0" ]] || return 1
  named=$(cast call "$faucet" "token()(address)" --rpc-url "$RPC_URL" 2>/dev/null | head -1 | awk '{print $1}' || true)
  [[ "$(lower "$named")" == "$(lower "$token")" ]]
}

# Deploy one contract from its artifact with ABI-encoded constructor args; prints the address. $1 role, $2 the source file's
# name (src/$2.sol), $3 args, $4 the contract in it when it is not named like the file.
create_from_artifact() {
  local role=$1 contract=$2 args=$3 name=${4:-$2} bytecode receipt address
  if ! (cd "$REPO_ROOT/contracts" && FOUNDRY_LINT_LINT_ON_BUILD=false forge build "src/$contract.sol") >/dev/null; then
    fail_step "$role" "forge build src/$contract.sol failed"
  fi
  bytecode=$(artifact_field "$REPO_ROOT/contracts/out/$contract.sol/$name.json" bytecode.object) \
    || fail_step "$role" "cannot read the $name artifact"
  if ! receipt=$(cast send --json --rpc-url "$RPC_URL" --private-key "$ANVIL_KEY" \
      --create "0x${bytecode#0x}${args#0x}" 2>&1); then
    echo "$receipt" >&2
    fail_step "$role" "cast send --create $name failed"
  fi
  address=$(node -e 'console.log(JSON.parse(process.argv[1]).contractAddress ?? "")' "$receipt")
  [[ -n "$address" && "$(code_bytes "$address")" != "0" ]] || fail_step "$role" "no code at ${address:-<none>}"
  echo "$address"
}

# Test $CREATE (N6): the whole supply goes into a faucet with no owner, which hands each wallet 1,000 a day.
deploy_test_create() {
  echo
  if create_deployed; then
    echo "── create: already at $(create_token_address), faucet $(create_faucet_address) — skipped (idempotent)"
    return 0
  fi
  local deployer token faucet
  deployer=$(cast wallet address --private-key "$ANVIL_KEY")
  echo "── create: deploying test CREATE and its faucet"
  token=$(create_from_artifact create-token CreateToken \
    "$(cast abi-encode "constructor(string,string,address)" "Test CREATE" tCREATE "$deployer")")
  faucet=$(create_from_artifact create-faucet CreateFaucet "$(cast abi-encode "constructor(address)" "$token")")
  cast send "$token" "transfer(address,uint256)" "$faucet" "$(cast call "$token" "totalSupply()(uint256)" --rpc-url "$RPC_URL" | awk '{print $1}')" \
    --private-key "$ANVIL_KEY" --rpc-url "$RPC_URL" >/dev/null || fail_step "create" "could not fill the faucet"
  node -e '
    const fs = require("fs");
    const [file, chainId, token, faucet] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({
      chainId: Number(chainId),
      project: "buzz-dev-chain",
      note: "scripts/dev-chain.sh — test CREATE (whole supply in the faucet)",
      roles: [{ role: "create-token", address: token }, { role: "create-faucet", address: faucet }],
    }) + "\n");
  ' "$(create_manifest_path)" "$CHAIN_ID" "$token" "$faucet" \
    || fail_step "create" "deployed but could not write $(create_manifest_path)"
  create_deployed || fail_step "create" "the faucet does not hand out the token it was given"
  echo "  ✓ test CREATE at $token, faucet $faucet (manifest $(create_manifest_path))"
}

fund_accounts() {
  echo
  echo "── fund: minting $CURRENCY_SYMBOL up to 1,000,000 per dev account (6dp)"
  local token i balance mint_amount
  token=$(currency_address)
  [[ -n "$token" && "$(code_bytes "$token")" != "0" ]] \
    || fail_step "fund" "no currency token address to fund from"
  for i in "${!DEV_ROLES[@]}"; do
    # cast appends a hint like "1000000000000 [1e12]" once the value is large; take the first
    # word BEFORE any space is stripped, or a second run reads "1000000000000[1e12]" and fails.
    balance=$(cast call "$token" "balanceOf(address)(uint256)" "${DEV_ADDRESSES[$i]}" \
      --rpc-url "$RPC_URL" | head -1 | awk '{print $1}')
    [[ "$balance" =~ ^[0-9]+$ ]] \
      || fail_step "fund" "balanceOf(${DEV_ADDRESSES[$i]}) returned '$balance'"
    if (( balance >= CURRENCY_PER_ACCOUNT )); then
      echo "  ✓ ${DEV_ROLES[$i]}: $balance already ≥ 1,000,000,000,000 (1e6 whole) — topped up"
      continue
    fi
    mint_amount=$(( CURRENCY_PER_ACCOUNT - balance ))
    if ! cast send "$token" "mint(address,uint256)" "${DEV_ADDRESSES[$i]}" "$mint_amount" \
        --private-key "$ANVIL_KEY" --rpc-url "$RPC_URL" --json >/dev/null; then
      fail_step "fund" "mint to ${DEV_ROLES[$i]} (${DEV_ADDRESSES[$i]}) failed"
    fi
    echo "  ✓ ${DEV_ROLES[$i]}: minted +$mint_amount to 1e12 base units (1,000,000 dUSDC)"
  done
}

up() {
  assert_loopback
  require_tools

  if rpc_alive; then
    local chain client
    chain=$(rpc_chain_id)
    client=$(rpc_client)
    case "$chain" in
      31337|1776411)
        case "$(lower "$client")" in
          *anvil*)
            echo "── anvil: reusing the dev chain already answering on $RPC_URL (chain id $chain, $client)"
            ;;
          *)
            occupied_error "a dev chain id ($chain) from a client that does not identify as anvil: ${client:-<no answer>}"
            ;;
        esac
        ;;
      "")
        occupied_error "something answered the port but not eth_chainId"
        ;;
      *)
        occupied_error "chain id $chain from $client — not a dev chain (expected 31337)"
        ;;
    esac
  elif tcp_open; then
    occupied_error "a non-RPC TCP service on $RPC_HOST:$RPC_PORT (no JSON-RPC answer)"
  else
    boot_anvil
  fi

  CHAIN_ID=$(rpc_chain_id)
  [[ -n "$CHAIN_ID" ]] || fail_step "probe" "chain went away after boot (no eth_chainId)"
  dev_addresses

  echo
  echo "════════════════════════ dev-chain (LOCAL ANVIL ONLY) ════════════════════"
  echo "rpc:      $RPC_URL (chain id $CHAIN_ID)"

  # A chain with no blocks has nothing deployed, so every manifest for its id is left over from another chain. Kept,
  # one can name an address this chain gives to a different contract that passes the "already deployed" check (a
  # matched exit skipped because a work bounty landed at its old address and pays in the same currency).
  if [[ "$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null || echo "?")" == "0" ]]; then
    local stale
    for stale in "$DEPLOYMENTS_DIR"/*-"$CHAIN_ID".json; do
      [[ -f "$stale" ]] || continue
      echo "── fresh chain: dropping $(basename "$stale"), left over from an earlier chain"
      rm -f "$stale"
    done
  fi

  load_apptoken_infra
  deploy_org_dao
  deploy_currency
  place_cca
  deploy_launch_kit
  deploy_contributor_kit
  deploy_work_bounty
  deploy_test_create
  deploy_court
  deploy_open_bounty
  deploy_forecast_pool
  deploy_payouts_factory
  deploy_remix_bonds
  deploy_matched_exit
  deploy_weekly_rounds
  fund_accounts

  echo
  echo "════════════════════════ dev-chain summary ══════════════════════════════"
  echo "  chain:      $RPC_URL (chain id $CHAIN_ID)"
  [[ -f "$PID_FILE" ]] && echo "  anvil pid:  $(cat "$PID_FILE") (log $LOG_FILE)"
  echo "  apptoken infra: router, pools and transfer validator (log $STATE_DIR/apptoken-infra.log)"
  echo "  org dao:    factory $(manifest_role "$(org_manifest_path)" factory) (org-dao-$CHAIN_ID.json)"
  echo "  summoner:   $(manifest_role "$(org_manifest_path)" summoner)"
  echo "  currency:   $(currency_address) ($CURRENCY_SYMBOL, ${CURRENCY_DECIMALS}dp)"
  echo "  cca:        factory $CCA_FACTORY_ADDRESS, Permit2 $PERMIT2_ADDRESS"
  echo "  contributor kit: $(contributor_kit_address) (contributor-kit-$CHAIN_ID.json)"
  if [[ "${DEV_CHAIN_ALL:-}" == "1" ]]; then
    echo "  launch kit: $(kit_address) (dao-launch-kit-$CHAIN_ID.json)"
    echo "  work bounty: $(work_bounty_address) (work-bounty-$CHAIN_ID.json)"
    echo "  open bounty: $(open_bounty_address) (open-bounty-$CHAIN_ID.json)"
    echo "  matched exit: $(matched_exit_address) (matched-exit-$CHAIN_ID.json)"
    echo "  weekly rounds: $(weekly_rounds_address) (weekly-rounds-$CHAIN_ID.json)"
    echo "  create:     $(create_token_address), faucet $(create_faucet_address) (create-$CHAIN_ID.json)"
    echo "  court:      $(court_address) (court-$CHAIN_ID.json)"
    echo "  forecasts:  $(forecast_pool_address) (forecast-pool-$CHAIN_ID.json; the app no longer shows them, D150)"
    echo "  payouts:    $(payouts_factory_address) (payouts-factory-$CHAIN_ID.json)"
    echo "  remix bonds: $(remix_bonds_address) (remix-bonds-$CHAIN_ID.json)"
  fi
  # The pilot's build first and alone: the hosted image is contributor-only and takes no optional feature.
  echo "  web env (as the hosted pilot is built: contributor projects only, no sale):"
  echo "              VITE_LAUNCHPAD_CHAIN_ID=$CHAIN_ID VITE_CHAIN_RPC_URL=$RPC_URL VITE_CONTRIBUTOR_ONLY=1"
  echo "              VITE_CONTRIBUTOR_KITS='{\"$CHAIN_ID\":\"$(contributor_kit_address)\"}'  (lets the app start a contributor project here)"
  if [[ "${DEV_CHAIN_ALL:-}" == "1" ]]; then
    echo "  web env, optional (not in the pilot; leave out VITE_CONTRIBUTOR_ONLY=1 for a raise):"
    echo "              VITE_DAO_LAUNCH_KITS='{\"$CHAIN_ID\":\"$(kit_address)\"}'  (lets the app launch a project into its own DAO here)"
    echo "              VITE_WORK_BOUNTIES='{\"$CHAIN_ID\":\"$(work_bounty_address)\"}'  (lets people put money behind a work area here)"
    echo "              VITE_OPEN_BOUNTIES='{\"$CHAIN_ID\":\"$(open_bounty_address)\"}'  (lets people put money behind a post here)"
    echo "              VITE_MATCHED_EXITS='{\"$CHAIN_ID\":\"$(matched_exit_address)\"}'  (lets members sell Shares to each other here, once their DAO votes for it)"
    echo "              VITE_WEEKLY_ROUNDS='{\"$CHAIN_ID\":\"$(weekly_rounds_address)\"}'  (weekly rounds between holders and new buyers, once their DAO votes them in)"
    echo "              VITE_CREATE_TOKENS='{\"$CHAIN_ID\":\"$(create_token_address)\"}' VITE_CREATE_FAUCETS='{\"$CHAIN_ID\":\"$(create_faucet_address)\"}'  (test CREATE: stakes and bonds)"
    echo "              VITE_COURTS='{\"$CHAIN_ID\":\"$(court_address)\"}'  (the court claimants appeal to)"
    echo "              VITE_PAYOUTS_FACTORIES='{\"$CHAIN_ID\":\"$(payouts_factory_address)\"}'  (DAOs vote to pay holders a share of revenue)"
    echo "              VITE_REMIX_BONDS='{\"$CHAIN_ID\":\"$(remix_bonds_address)\"}'  (a remix's bond to its parent)"
  else
    echo "  optional:   a raise and the optional features are deployed too; DEV_CHAIN_ALL=1 just dev-chain prints their settings"
  fi
  echo "  status:     just dev-chain-status"
  echo "  stop:       just dev-chain-down"
  echo "═══════════════════════════════════════════════════════════════════════"
  print_accounts
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

status() {
  require_tools cast node curl
  assert_loopback

  local running="no" chain="-" client="-" block="-"
  if rpc_alive; then
    running="yes"
    chain=$(rpc_chain_id)
    client=$(rpc_client)
    block=$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null || echo "?")
  fi

  echo "════════════════════════ dev-chain status ═══════════════════════════════"
  echo "rpc:     $RPC_URL"
  if [[ "$running" == "yes" ]]; then
    local pid="-"
    [[ -f "$PID_FILE" ]] && pid=$(cat "$PID_FILE" 2>/dev/null || echo "-")
    echo "chain:   RUNNING — chain id $chain, block $block, $client (pid $pid)"
  else
    echo "chain:   NOT RUNNING — showing the last recorded deployments (manifests below)"
  fi
  echo

  printf '%-32s %-44s %11s  %s\n' "WHAT" "ADDRESS" "CODE" "SOURCE"
  printf '%-32s %-44s %11s  %s\n' "---" "---" "---" "---"

  row() { # <label> <address> <source>
    local code="chain down"
    if [[ "$running" == "yes" ]]; then
      local bytes
      bytes=$(code_bytes "$2")
      if [[ "$bytes" == "0" ]]; then code="none"; else code="$bytes bytes"; fi
    fi
    printf '%-32s %-44s %11s  %s\n' "$1" "$2" "$code" "$3"
  }

  local f role address
  # Fixed dev-chain addresses (apptoken-dev bootstrap — deterministic).
  row "tokenmaster-router" "0x0E00009d00d1000069ed00A908e00081F5006008" "apptoken-dev bootstrap"
  row "standard-pool-factory" "0x000000c5F2DF717F497BeAcCE161F8b042310d17" "apptoken-dev bootstrap"
  row "stable-pool-factory" "0x0000006a50a9c9Efae8875266ff222579fC2F449" "apptoken-dev bootstrap"
  row "transfer-validator-v5" "0x721C008fdff27BF06E7E123956E2Fe03B63342e3" "apptoken-dev bootstrap"
  row "cca-factory" "0x000000001F26a0044BaA66024e7b6599c61963F8" "CCA factory pin (fork-only)"

  # Manifests — the deployments convention, one file per deployment.
  f="$DEPLOYMENTS_DIR/apptoken-latest.json"
  if [[ -f "$f" ]]; then
    address=$(json_get "$f" token)
    row "apptoken (recorded)" "${address:-?}" "$(basename "$f")"
  else
    row "apptoken (recorded)" "-" "no apptoken-latest.json yet"
  fi

  for f in "$DEPLOYMENTS_DIR"/org-dao-*.json "$DEPLOYMENTS_DIR"/dev-currency-*.json "$DEPLOYMENTS_DIR"/dao-launch-kit-*.json "$DEPLOYMENTS_DIR"/contributor-kit-*.json "$DEPLOYMENTS_DIR"/work-bounty-*.json "$DEPLOYMENTS_DIR"/open-bounty-*.json; do
    [[ -f "$f" ]] || continue
    while read -r role address; do
      [[ -n "$role" && -n "$address" ]] || continue
      row "$role ($(basename "$f" .json))" "$address" "$(basename "$f")"
    done < <(node -e '
      const fs = require("fs");
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const r of m.roles ?? []) console.log(`${r.role} ${r.address}`);
    ' "$f")
  done

  echo
  if [[ "$running" != "yes" ]]; then
    echo "start it with: just dev-chain"
  else
    echo "stop it with:  just dev-chain-down"
  fi
  echo "═══════════════════════════════════════════════════════════════════════"
}

# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------

down() {
  require_tools curl
  if [[ ! -f "$PID_FILE" ]]; then
    if rpc_alive; then
      echo "anvil is answering on $RPC_URL, but there is no dev-chain pid file ($PID_FILE):"
      echo "it was not started by this script, so nothing was stopped."
      echo "Stop it yourself (e.g. lsof -iTCP:$RPC_PORT -sTCP:LISTEN) or leave it — it is loopback-only."
    else
      echo "nothing to stop: no pid file at $PID_FILE and nothing answering on $RPC_URL"
    fi
    return 0
  fi

  local pid command
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -z "$pid" ]] || ! ps -p "$pid" >/dev/null 2>&1; then
    echo "stale pid file (PID ${pid:-<empty>} is not running) — removed; nothing to stop"
    rm -f "$PID_FILE"
    return 0
  fi
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  local lower_command
  lower_command=$(lower "$command")
  case "$lower_command" in
    *anvil*) ;;
    *)
      echo "PID $pid is not the anvil this script started — refusing to kill it:"
      echo "  $command"
      echo "Remove $PID_FILE yourself if it is stale."
      exit 1
      ;;
  esac
  case "$command" in
    *"$RPC_PORT"*) ;;
    *)
      echo "PID $pid is an anvil, but not the one on port $RPC_PORT — refusing to kill it:"
      echo "  $command"
      echo "Remove $PID_FILE yourself if it is stale."
      exit 1
      ;;
  esac
  kill "$pid" 2>/dev/null || true
  local attempt
  for attempt in $(seq 1 50); do
    ps -p "$pid" >/dev/null 2>&1 || break
    sleep 0.2
  done
  if ps -p "$pid" >/dev/null 2>&1; then
    echo "PID $pid did not exit after 10s — leaving it and its log ($LOG_FILE)" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
  echo "stopped dev-chain (anvil PID $pid); log kept at $LOG_FILE"
}

# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

case "$MODE" in
  up)
    up
    ;;
  down)
    down
    ;;
  status)
    status
    ;;
  --dry-run|dry-run)
    assert_loopback
    require_tools cast node curl
    echo "dev-chain plan (dry run — nothing started, nothing deployed)"
    plan_lines
    dev_addresses
    print_accounts
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
