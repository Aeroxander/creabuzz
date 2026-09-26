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
#      and the DEV-ONLY router allowlist patch. This REUSES the existing
#      `scripts/dogfood-raise.sh` machinery (its own idempotent bootstrap +
#      patch + apptoken mint) rather than duplicating it; see that script's
#      header for the why.
#   3. OrgBinding + Summoner + Moloch DAO for org formation
#      (`contracts/script/DeployOrgDao.s.sol`, which writes the
#      `deployments/org-dao-<chainid>.json` manifest)
#   4. a USDC-like currency mock for sales: MockPairedTokenERC20("Dev USDC",
#      "dUSDC", 6 decimals) + `deployments/dev-currency-<chainid>.json`
#   5. funded dev accounts, printed as a table (keys are DEV ONLY, labeled)
#
# ════════════════════════════════════════════════════════════════════════════
# ⚠️  DEV-ONLY. LOCAL ANVIL ONLY. NEVER MAINNET. ⚠️
#
# The steps above run the packaged apptoken bootstrap (unlocked dev accounts +
# multisig impersonation) and a dev-only router storage patch — exactly the
# two things `scripts/dogfood-raise.sh` documents as local-only. This script
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

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Toolchain: prefer the hermit-pinned node/cast when available.
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${HOME}/.foundry/bin:${PATH}"

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
  echo "  2. apptoken infra  scripts/dogfood-raise.sh  [idempotent: skips deployed router/pools/validator, the DEV-ONLY allowlist patch, and an already-minted apptoken]"
  echo "  3. org dao      forge script DeployOrgDao.s.sol  [skipped: deployments/org-dao-$DEV_CHAIN_ID.json names an OrgBinding that still has code]"
  echo "  4. currency     $CURRENCY_NAME ($CURRENCY_SYMBOL, ${CURRENCY_DECIMALS}dp)  [skipped: deployments/dev-currency-$DEV_CHAIN_ID.json names a token that still has code]"
  echo "  5. fund         mint $CURRENCY_SYMBOL to founder/buyer1/buyer2  [idempotent: tops up only when a balance is short]"
  echo "  6. accounts     print the DEV-ONLY key table to stdout"
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
  nohup anvil --host "$RPC_HOST" --port "$RPC_PORT" --chain-id "$DEV_CHAIN_ID" \
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

# `apptoken infra` — the whole dogfood-raise step chain, reused as-is. It is
# idempotent by construction and refuses non-loopback/non-anvil itself. Its
# output is tee'd so the confirmed token address (the `verify-token` row) can
# be reported from THIS run — `contracts/deployments/apptoken-latest.json` is
# written by `DeployAppToken.s.sol`, not by the mint, and can be stale.
load_apptoken_infra() {
  echo
  echo "── apptoken infra: scripts/dogfood-raise.sh (bootstrap + DEV-ONLY router allowlist patch + apptoken mint)"
  mkdir -p "$STATE_DIR"
  if (
    RPC_URL="$RPC_URL" bash "$REPO_ROOT/scripts/dogfood-raise.sh"
  ) 2>&1 | tee "$STATE_DIR/dogfood-raise.log"; then
    :
  else
    fail_step "apptoken-infra" "dogfood-raise.sh failed (its summary names the step)"
  fi
  APPTOKEN_ADDRESS=$(awk '/^verify-token[[:space:]]/ {print $2; exit}' \
    "$STATE_DIR/dogfood-raise.log")
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
  [[ "$(code_bytes "$factory")" != "0" ]]
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
  [[ "$(code_bytes "$address")" != "0" ]]
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

fund_accounts() {
  echo
  echo "── fund: minting $CURRENCY_SYMBOL up to 1,000,000 per dev account (6dp)"
  local token i balance mint_amount
  token=$(currency_address)
  [[ -n "$token" && "$(code_bytes "$token")" != "0" ]] \
    || fail_step "fund" "no currency token address to fund from"
  for i in "${!DEV_ROLES[@]}"; do
    balance=$(cast call "$token" "balanceOf(address)(uint256)" "${DEV_ADDRESSES[$i]}" \
      --rpc-url "$RPC_URL" | head -1 | tr -d ' ')
    balance=${balance%% *}
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

  load_apptoken_infra
  deploy_org_dao
  deploy_currency
  fund_accounts

  echo
  echo "════════════════════════ dev-chain summary ══════════════════════════════"
  echo "  chain:      $RPC_URL (chain id $CHAIN_ID)"
  [[ -f "$PID_FILE" ]] && echo "  anvil pid:  $(cat "$PID_FILE") (log $LOG_FILE)"
  echo "  apptoken:   ${APPTOKEN_ADDRESS:-<not minted>} (dogfood-raise, log $STATE_DIR/dogfood-raise.log)"
  echo "  org dao:    factory $(manifest_role "$(org_manifest_path)" factory) (org-dao-$CHAIN_ID.json)"
  echo "  summoner:   $(manifest_role "$(org_manifest_path)" summoner)"
  echo "  currency:   $(currency_address) ($CURRENCY_SYMBOL, ${CURRENCY_DECIMALS}dp)"
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
  # The apptoken THIS chain actually holds: dogfood-raise's confirmed
  # `verify-token` row. The manifest above is written by DeployAppToken.s.sol
  # and can point at an older chain's token (its code row says `none` when it
  # does), so report the live one next to it rather than overwriting it.
  if [[ -f "$STATE_DIR/dogfood-raise.log" ]]; then
    local live_token
    live_token=$(awk '/^verify-token[[:space:]]/ {print $2; exit}' "$STATE_DIR/dogfood-raise.log")
    if [[ -n "$live_token" ]]; then
      row "apptoken (minted here)" "$live_token" "dogfood-raise.log"
    fi
  fi

  for f in "$DEPLOYMENTS_DIR"/org-dao-*.json "$DEPLOYMENTS_DIR"/dev-currency-*.json; do
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
