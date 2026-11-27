#!/usr/bin/env bash
#
# scripts/dev-chain.sh — one command that boots a LOCAL dev chain with the money contracts on it, then reports what it
# deployed.
#
#   just dev-chain         boot + deploy (idempotent — safe to re-run)
#   just dev-chain-status  what is deployed at which address (reads contracts/pot/deployments/*.json, probes the live chain)
#   just dev-chain-down    stop the anvil this script started
#   just dev-chain --dry-run   print the plan, touch nothing
#
# What it does, in order:
#   1. anvil (chain id 31337, background, logged, pid file)
#   2. contracts/pot, with its own deploy script (`script/DeployPot.s.sol`): the play dollar, the part implementations and the
#      Launcher. It writes `contracts/pot/deployments/pot-<chainid>.json`. The settings the deploy script reads (UNIT and
#      the rest) can be passed in the environment; by default the time unit is the real 7 days.
#   3. the funded dev accounts, printed as a table (the keys are DEV ONLY, labeled)
#
# ════════════════════════════════════════════════════════════════════════════
# ⚠️  DEV-ONLY. LOCAL ANVIL ONLY. NEVER MAINNET. ⚠️
#
# This script refuses any non-loopback RPC URL and only ever boots its own anvil on loopback.
# ════════════════════════════════════════════════════════════════════════════
#
# Idempotency: the deploy is guarded by "the manifest exists AND the Launcher it names still has code", so re-running against
# a live chain skips it, and re-running after a chain restart (fresh state, stale manifest) deploys again instead of
# trusting the stale file. A caught failure never reports success: each step exits non-zero with the step named.
#
# Environment overrides:
#   RPC_URL     default http://127.0.0.1:8545
#   RPC_HOST    default 127.0.0.1 (also used when booting anvil)
#   RPC_PORT    default 8545
#   STATE_DIR   default <repo>/target/dev-chain (pid file, logs)
#   ANVIL_KEY   default anvil dev key 0 (the deployer, platform and admin)
#   DEV_CHAIN_ID default 31337 (the chain anvil is booted with)


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
# Foundry's HTTP client panics on this host (macOS `system-configuration` returns
# NULL while building its proxy matcher) before the request reaches the node, so
# every `cast` call goes over the node's WebSocket transport — the same endpoint,
# same JSON-RPC. `RPC_URL` stays http for the app and for curl.
CAST_RPC_URL="${RPC_URL/http:/ws:}"

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

ANVIL_KEY="${ANVIL_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
BUYER1_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
BUYER2_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"

POT_DIR="$REPO_ROOT/contracts/pot"
DEPLOYMENTS_DIR="$POT_DIR/deployments"

MODE="${1:-up}"

usage() {
  cat <<'USAGE'
usage: scripts/dev-chain.sh [up|down|status|--dry-run]

  up          boot (or reuse) the local dev chain and deploy contracts/pot — default
  down        stop the anvil this script started (pid file at STATE_DIR)
  status      what is deployed at which address (reads contracts/pot/deployments)
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

# JSON field reader — `json_get <file> <key>` ("" when absent).
json_get() {
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (value !== undefined && value !== null) console.log(String(value));
  ' "$1" "$2" 2>/dev/null || true
}

code_bytes() { # <address> -> decimal code size (0 = nothing deployed)
  local code
  code=$(cast code "$1" --rpc-url "$CAST_RPC_URL" 2>/dev/null || echo "0x")
  if [[ "$code" == "0x" || -z "$code" ]]; then echo 0; return; fi
  echo $(( (${#code} - 2) / 2 ))
}


rpc_chain_id() {
  cast chain-id --rpc-url "$CAST_RPC_URL" 2>/dev/null || true
}

rpc_client() {
  cast rpc web3_clientVersion --rpc-url "$CAST_RPC_URL" 2>/dev/null | tr -d '"' || true
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
  echo "This script boots anvil and deploys with a public dev key — local dev chain only, NEVER a real network." >&2
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
    echo "something is already listening — the dev-chain didn't start; the app can still use it if it's an anvil with the contracts loaded — run the status recipe to check:"
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
  echo "  founder  deployer, platform and admin (anvil key 0)"
  echo "  buyer1   a second account (anvil key 1)"
  echo "  buyer2   a third account (anvil key 2)"
  echo "═══════════════════════════════════════════════════════════════════════"
}

# ---------------------------------------------------------------------------
# The plan (shared by --dry-run and the real run's narration)
# ---------------------------------------------------------------------------

pot_manifest_path() { echo "$DEPLOYMENTS_DIR/pot-$DEV_CHAIN_ID.json"; }

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
  echo "  2. pot          forge script DeployPot.s.sol in contracts/pot  [skipped: deployments/pot-$DEV_CHAIN_ID.json names a Launcher that still has code]"
  echo "  3. accounts     print the DEV-ONLY key table to stdout"
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
  # `nohup` cannot detach where there is no controlling terminal: it prints
  # "nohup: can't detach from console: Inappropriate ioctl for device" and anvil
  # never starts, which killed every journey with "no JSON-RPC after 10s". What
  # nohup actually needs is stdin off the terminal, so that is redirected here
  # and the process is backgrounded directly (setsid where it exists, which keeps
  # it alive past the parent without a terminal).
  if command -v setsid >/dev/null 2>&1; then
    setsid anvil --host "$RPC_HOST" --port "$RPC_PORT" --chain-id "$DEV_CHAIN_ID" --prune-history=500 \
      </dev/null >"$LOG_FILE" 2>&1 &
  else
    anvil --host "$RPC_HOST" --port "$RPC_PORT" --chain-id "$DEV_CHAIN_ID" --prune-history=500 \
      </dev/null >"$LOG_FILE" 2>&1 &
    disown 2>/dev/null || true
  fi
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

# ---------------------------------------------------------------------------
# pot
# ---------------------------------------------------------------------------

pot_deployed() { # the manifest exists and the Launcher it names still has code
  local manifest launcher
  manifest="$(pot_manifest_path)"
  [[ -f "$manifest" ]] || return 1
  launcher="$(json_get "$manifest" launcher)"
  [[ -n "$launcher" ]] && [[ "$(code_bytes "$launcher")" != "0" ]]
}

deploy_pot() {
  if pot_deployed; then
    echo "── pot: already deployed ($(basename "$(pot_manifest_path)")) — skipping"
    return 0
  fi
  echo "── pot: deploying contracts/pot (log $STATE_DIR/pot-deploy.log)"
  mkdir -p "$STATE_DIR"
  "$REPO_ROOT/scripts/ensure-solc.sh" || fail_step "pot" "the pinned solc is not available"
  (cd "$POT_DIR" && forge script script/DeployPot.s.sol --rpc-url "$CAST_RPC_URL" --broadcast --private-key "$ANVIL_KEY") \
    >"$STATE_DIR/pot-deploy.log" 2>&1 \
    || { tail -30 "$STATE_DIR/pot-deploy.log" >&2; fail_step "pot" "the deploy script failed"; }
  pot_deployed || fail_step "pot" "no code at the Launcher the manifest names"
  echo "   ✓ pot deployed"
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

  # A chain with no blocks has nothing deployed, so a manifest for its id is left over from another chain.
  if [[ "$(cast block-number --rpc-url "$CAST_RPC_URL" 2>/dev/null || echo "?")" == "0" && -f "$(pot_manifest_path)" ]]; then
    echo "── fresh chain: dropping $(basename "$(pot_manifest_path)"), left over from an earlier chain"
    rm -f "$(pot_manifest_path)"
  fi

  deploy_pot

  local manifest
  manifest="$(pot_manifest_path)"
  echo
  echo "════════════════════════ dev-chain summary ══════════════════════════════"
  echo "  chain:      $RPC_URL (chain id $CHAIN_ID)"
  [[ -f "$PID_FILE" ]] && echo "  anvil pid:  $(cat "$PID_FILE") (log $LOG_FILE)"
  echo "  dollar:     $(json_get "$manifest" quote)"
  echo "  launcher:   $(json_get "$manifest" launcher) (pot-$CHAIN_ID.json)"
  echo "  time unit:  $(json_get "$manifest" unit) seconds"
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
    block=$(cast block-number --rpc-url "$CAST_RPC_URL" 2>/dev/null || echo "?")
  fi

  echo "════════════════════════ dev-chain status ═══════════════════════════════"
  echo "rpc:     $RPC_URL"
  echo "records: $DEPLOYMENTS_DIR"
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

  local f key address bytes code
  for f in "$DEPLOYMENTS_DIR"/pot-*.json; do
    [[ -f "$f" ]] || continue
    for key in quote parts launcher holderPause earlierGrants; do
      address=$(json_get "$f" "$key")
      [[ -n "$address" ]] || continue
      code="chain down"
      if [[ "$running" == "yes" ]]; then
        bytes=$(code_bytes "$address")
        if [[ "$bytes" == "0" ]]; then code="none"; else code="$bytes bytes"; fi
      fi
      printf '%-32s %-44s %11s  %s\n' "$key ($(basename "$f" .json))" "$address" "$code" "$(basename "$f")"
    done
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
