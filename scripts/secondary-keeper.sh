#!/usr/bin/env bash
#
# scripts/secondary-keeper.sh — keeps one DAO's secondary market moving when nobody has the page open.
#
# A round closes and times out by the clock. Anyone may settle it, but if no one does within the settle window
# (`settleDeadline`) the round goes void and everyone takes back what they put in, so a market that depends on
# someone happening to visit would void rounds that cleared. This is that someone: every pass it reads the market
# and sends at most two transactions, both of which the contract lets anyone send:
#   * `settle(id)`    when the latest round has closed, is not settled, and is inside its settle window;
#   * `openRound()`   only when KEEPER_OPEN=1, the DAO's listing is on, and a week has passed since the last opening.
# It never touches an order, a listing or a price, and cannot: the market has no operator. It never settles a void
# round (the chain would refuse) and never opens a round the listing does not allow.
#
# Usage:   RPC_URL=... MARKET=0x... KEEPER_PRIVATE_KEY=0x... scripts/secondary-keeper.sh [--once]
# Env:     RPC_URL          JSON-RPC endpoint (required)
#          MARKET           the SecondaryMarket address (required)
#          KEEPER_PRIVATE_KEY  the key that pays the network fee (required unless KEEPER_DRY_RUN=1). It holds only
#                           gas money: use a throwaway key, never a key that owns Shares or a DAO. `cast` takes it on
#                           its command line, so run this on a machine only you can read the process list of.
#          KEEPER_OPEN      1 to also open each week's round (default 0: settle only)
#          KEEPER_INTERVAL  seconds between passes when looping (default 300)
#          KEEPER_DRY_RUN   1 to print what would be sent and send nothing
#          KEEPER_MAX_ATTEMPTS  failed sends of one action before the keeper stops trying it and says so (default 24).
#                           Between failures it waits twice as long each time (the interval, 2x, 4x ... at most an hour).
# Needs foundry's `cast` on PATH or in ~/.foundry/bin.

set -euo pipefail

export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
command -v cast >/dev/null 2>&1 || { echo "secondary-keeper: missing tool: cast" >&2; exit 2; }

: "${RPC_URL:?secondary-keeper: set RPC_URL}"
: "${MARKET:?secondary-keeper: set MARKET}"
[[ "$MARKET" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "secondary-keeper: MARKET is not an address" >&2; exit 2; }
DRY="${KEEPER_DRY_RUN:-0}"
OPEN="${KEEPER_OPEN:-0}"
INTERVAL="${KEEPER_INTERVAL:-300}"
[[ "$INTERVAL" =~ ^[0-9]+$ && "$INTERVAL" -ge 30 ]] || { echo "secondary-keeper: KEEPER_INTERVAL must be at least 30 seconds" >&2; exit 2; }
MAX_ATTEMPTS="${KEEPER_MAX_ATTEMPTS:-24}"
[[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ && "$MAX_ATTEMPTS" -ge 1 ]] || { echo "secondary-keeper: KEEPER_MAX_ATTEMPTS must be a positive number" >&2; exit 2; }
if [[ "$DRY" != "1" && -z "${KEEPER_PRIVATE_KEY:-}" ]]; then
  echo "secondary-keeper: set KEEPER_PRIVATE_KEY (or KEEPER_DRY_RUN=1)" >&2
  exit 2
fi
KEEPER_ADDRESS=""
if [[ "$DRY" != "1" ]]; then
  KEEPER_ADDRESS="$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY" 2>/dev/null)" || {
    echo "secondary-keeper: KEEPER_PRIVATE_KEY is not a valid key" >&2
    exit 2
  }
fi

# The contract's own cadence between openings. Reading it from the market would be better, but it is a constant.
EVERY=604800
# The per-transaction gas cap some chains enforce (2**24, EIP-7825). Settle is built to sit far below it.
TX_GAS_CAP=16777216
# Bounded retry state, per action key (for example "settle_3"), in plain variables FAILS_<key> (failed sends so far) and
# NEXT_<key> (earliest next try, epoch seconds; -1 once given up) so it also runs on bash 3.2.

say() { printf '%s secondary-keeper: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# The Nth line of a `cast call` answer, without cast's "[1.6e3]" annotation, first word only.
nth() { awk -v n="$1" 'NR == n { sub(/ \[.*/, ""); print $1 }'; }

# The last line of an error, cut to a readable length.
reason() { printf '%s' "$1" | tail -1 | cut -c1-240; }

# Count one failed send of `key`, loudly, and schedule the next try: the wait doubles each failure up to an hour, and after
# MAX_ATTEMPTS failures the action is given up on (the round is then void at its deadline) with a message saying so.
failed() { # failed <key> <label> <why>
  local key="$1" label="$2" why="$3" n wait cur="FAILS_$1"
  n=$(( ${!cur:-0} + 1 ))
  printf -v "FAILS_$key" '%s' "$n"
  if ((n >= MAX_ATTEMPTS)); then
    printf -v "NEXT_$key" '%s' -1
    say "ERROR: giving up on $label after $n failed attempts. Last reason: $why. Nothing more will be sent for it."
    return 0
  fi
  wait=$(( INTERVAL << (n - 1 < 8 ? n - 1 : 8) ))
  ((wait > 3600)) && wait=3600
  printf -v "NEXT_$key" '%s' "$(( $(date +%s) + wait ))"
  say "ERROR: $label failed (attempt $n of $MAX_ATTEMPTS): $why. Trying again in ${wait}s."
}

# True when `key` may be tried now: not given up on, and its wait is over.
due() { # due <key>
  local cur="NEXT_$1" at
  at="${!cur:-0}"
  ((at == -1)) && return 1
  ((at <= $(date +%s)))
}

send() { # send <key> <label> <signature> [args...]
  local key="$1" label="$2"
  shift 2
  if [[ "$DRY" == "1" ]]; then
    say "dry run: would send $label"
    return 0
  fi
  due "$key" || return 0
  # Ask the node first: a settle that would run out of gas or revert is reported with the reason instead of being sent
  # (and paid for) blind. The estimate also shows how close the call is to the per-transaction cap.
  local gas err
  if ! gas="$(cast estimate "$MARKET" "$@" --from "$KEEPER_ADDRESS" --rpc-url "$RPC_URL" 2>&1)"; then
    # Someone else settled first, or the window closed between the read and the send: both are fine and show here as the
    # chain's own reason. Anything else (no gas, an unreachable node, a settle too heavy to mine) shows too.
    failed "$key" "$label (gas estimate)" "$(reason "$gas")"
    return 0
  fi
  if [[ "$gas" =~ ^[0-9]+$ ]] && ((gas >= TX_GAS_CAP)); then
    say "WARNING: $label needs about $gas gas, at or over the $TX_GAS_CAP per-transaction cap some chains enforce; it may not be minable there."
  fi
  if err="$(cast send "$MARKET" "$@" --private-key "$KEEPER_PRIVATE_KEY" --rpc-url "$RPC_URL" 2>&1 >/dev/null)"; then
    say "sent $label (estimated gas ${gas})"
    printf -v "FAILS_$key" '%s' 0
    printf -v "NEXT_$key" '%s' 0
  else
    failed "$key" "$label (send)" "$(reason "$err")"
  fi
}

pass() {
  local now count
  now="$(cast block latest --field timestamp --rpc-url "$RPC_URL")"
  count="$(cast call "$MARKET" "roundCount()(uint256)" --rpc-url "$RPC_URL" | nth 1)"
  [[ "$now" =~ ^[0-9]+$ && "$count" =~ ^[0-9]+$ ]] || { say "could not read the market; trying again next pass"; return 0; }

  if ((count > 0)); then
    local round closes deadline settled
    round="$(cast call "$MARKET" \
      "rounds(uint256)(uint128,uint128,uint32,uint64,uint64,uint64,uint256,uint256,uint16,bool,bool)" "$count" \
      --rpc-url "$RPC_URL")"
    closes="$(printf '%s\n' "$round" | nth 5)"
    deadline="$(printf '%s\n' "$round" | nth 6)"
    settled="$(printf '%s\n' "$round" | nth 10)"
    if [[ ! "$closes" =~ ^[0-9]+$ || ! "$deadline" =~ ^[0-9]+$ || ! "$settled" =~ ^(true|false)$ ]]; then
      say "round $count was not readable; trying again next pass"
      return 0
    fi
    if [[ "$settled" == "false" ]] && ((now >= closes && now < deadline)); then
      send "settle_$count" "settle(round $count)" "settle(uint256)" "$count"
    fi
  fi

  if [[ "$OPEN" == "1" ]]; then
    local enabled last
    enabled="$(cast call "$MARKET" "listing()(bool,uint128,uint128,uint32)" --rpc-url "$RPC_URL" | nth 1)"
    last="$(cast call "$MARKET" "lastOpenAt()(uint256)" --rpc-url "$RPC_URL" | nth 1)"
    if [[ "$enabled" == "true" && "$last" =~ ^[0-9]+$ ]] && ((last == 0 || now >= last + EVERY)); then
      send "open" "openRound()" "openRound()"
    fi
  fi
}

if [[ "${1:-}" == "--once" ]]; then
  pass
  exit 0
fi
say "watching $MARKET every ${INTERVAL}s (opening rounds: $([[ "$OPEN" == "1" ]] && echo yes || echo no))"
while true; do
  pass || say "pass failed; trying again next pass"
  sleep "$INTERVAL"
done
