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
# Usage:   RPC_URL=... MARKET=0x... KEEPER_KEYSTORE=... KEEPER_PASSWORD_FILE=... scripts/secondary-keeper.sh [--once]
# Exit:    with --once: 0 when nothing was wrong, 1 when a transaction was refused for a real reason and the round may
#          still need it (a lost race, a round already settled or an early openRound is not a failure), 2 when the
#          market could not be read or the setup is wrong. Wire cron's alerting to a non-zero exit.
# Env:     RPC_URL          JSON-RPC endpoint (required)
#          MARKET           the SecondaryMarket address (required)
#          KEEPER_KEYSTORE  path to the encrypted keystore (JSON) of the key that pays the network fee, with
#          KEEPER_PASSWORD_FILE  the path of a file holding its password (both required unless KEEPER_DRY_RUN=1).
#                           The key holds only gas money: use a throwaway key, never a key that owns Shares or a DAO.
#                           Make the keystore once with `cast wallet import --interactive --keystore-dir <dir> keeper`
#                           (the prompts keep the key off every command line). The keeper hands `cast` only the two
#                           paths, so the key is never visible in `ps` or /proc.
#          KEEPER_PRIVATE_KEY  the legacy way: a raw key. `cast` can only take it on its command line, where any user
#                           of the machine can read it, so the keeper warns; prefer the keystore.
#          KEEPER_OPEN      1 to also open each week's round (default 0: settle only)
#          KEEPER_INTERVAL  seconds between passes when looping (default 300)
#          KEEPER_DRY_RUN   1 to print what would be sent and send nothing
#          KEEPER_MAX_ATTEMPTS  failed sends of one action before the keeper changes how it retries (default 24).
#                           Between failures it waits twice as long each time (the interval, 2x, 4x ... at most an hour).
#                           A settle then gives up for good (its round is void at the deadline, so there is nothing left to
#                           do). An openRound never gives up: it is retried once an hour until it goes out, because the
#                           week is still open for it and a refilled wallet or a recovered node should just work.
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
# The arguments that make `cast` sign: a keystore and its password file (paths only, no secret on the command line), or
# the legacy raw key (which `ps` shows).
SIGN_ARGS=()
KEEPER_ADDRESS=""
if [[ "$DRY" != "1" ]]; then
  if [[ -n "${KEEPER_KEYSTORE:-}" ]]; then
    [[ -n "${KEEPER_PASSWORD_FILE:-}" && -r "$KEEPER_PASSWORD_FILE" ]] || {
      echo "secondary-keeper: set KEEPER_PASSWORD_FILE to a readable file holding the keystore password" >&2
      exit 2
    }
    [[ -r "$KEEPER_KEYSTORE" ]] || { echo "secondary-keeper: KEEPER_KEYSTORE is not a readable file" >&2; exit 2; }
    SIGN_ARGS=(--keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE")
  elif [[ -n "${KEEPER_PRIVATE_KEY:-}" ]]; then
    echo "secondary-keeper: WARNING: KEEPER_PRIVATE_KEY is passed to cast on its command line, where every user of this machine can read it. Use KEEPER_KEYSTORE and KEEPER_PASSWORD_FILE instead." >&2
    SIGN_ARGS=(--private-key "$KEEPER_PRIVATE_KEY")
  else
    echo "secondary-keeper: set KEEPER_KEYSTORE and KEEPER_PASSWORD_FILE (or KEEPER_DRY_RUN=1)" >&2
    exit 2
  fi
  KEEPER_ADDRESS="$(cast wallet address "${SIGN_ARGS[@]}" 2>/dev/null)" || {
    echo "secondary-keeper: the keeper key could not be read (wrong keystore, password or key)" >&2
    exit 2
  }
fi

# The contract's own cadence between openings. Reading it from the market would be better, but it is a constant.
EVERY=604800
# The per-transaction gas cap some chains enforce (2**24, EIP-7825). Settle is built to sit far below it.
TX_GAS_CAP=16777216
# Set when a send failed for a real reason during this pass; `--once` turns it into its exit status.
SEND_FAILED=0

# Bounded retry state, per action key (for example "settle_3" or "open_<the week's opening time>"), in plain variables
# FAILS_<key> (failed sends so far) and NEXT_<key> (earliest next try, epoch seconds; -1 once given up) so it also runs
# on bash 3.2. Each round and each week has its own key, so one stuck action never carries into the next.

# Errors the chain returns when the action is simply no longer (or not yet) needed, matched by name or by selector (cast
# prints an unknown custom error as its 4-byte selector). Empty when `cast sig` is unavailable: then nothing is benign
# and every failure is reported, which is the safe direction.
SEL_SETTLED="$(cast sig 'AlreadySettled(uint256)' 2>/dev/null || true)"
SEL_OVER="$(cast sig 'SettleOver(uint256)' 2>/dev/null || true)"
SEL_SOON="$(cast sig 'TooSoon(uint256)' 2>/dev/null || true)"
SEL_NOTENABLED="$(cast sig 'ListingNotEnabled()' 2>/dev/null || true)"

say() { printf '%s secondary-keeper: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# The Nth line of a `cast call` answer, without cast's "[1.6e3]" annotation, first word only.
nth() { awk -v n="$1" 'NR == n { sub(/ \[.*/, ""); print $1 }'; }

# The last line of an error, cut to a readable length.
reason() { printf '%s' "$1" | tail -1 | cut -c1-240; }

# Count one failed send of `key`, loudly, and schedule the next try: the wait doubles each failure up to an hour. After
# MAX_ATTEMPTS failures a settle is given up on (its round is then void at its deadline), with a message saying so; an
# openRound is not, it keeps being tried once an hour (the failures keep being reported) until it goes out.
failed() { # failed <key> <label> <why>
  local key="$1" label="$2" why="$3" n wait cur="FAILS_$1"
  SEND_FAILED=1
  n=$(( ${!cur:-0} + 1 ))
  printf -v "FAILS_$key" '%s' "$n"
  if ((n >= MAX_ATTEMPTS)) && [[ "$key" == settle_* ]]; then
    printf -v "NEXT_$key" '%s' -1
    say "ERROR: giving up on $label after $n failed attempts. Last reason: $why. Nothing more will be sent for it, and the round is void at its deadline."
    return 0
  fi
  wait=$(( INTERVAL << (n - 1 < 8 ? n - 1 : 8) ))
  ((wait > 3600)) && wait=3600
  printf -v "NEXT_$key" '%s' "$(( $(date +%s) + wait ))"
  if ((n >= MAX_ATTEMPTS)); then
    say "ERROR: $label failed (attempt $n): $why. It is never given up on; trying again in ${wait}s."
  else
    say "ERROR: $label failed (attempt $n of $MAX_ATTEMPTS): $why. Trying again in ${wait}s."
  fi
}

# True when the chain's answer `text` says the action `key` is not needed (any more) or not yet allowed: a settle that
# someone else got in first (AlreadySettled) or whose window has closed (SettleOver), or an openRound inside its week
# (TooSoon), or one the DAO switched off between the read and the send (ListingNotEnabled; the next pass reads the
# listing as off and does nothing). Nothing is wrong then, so it is not a failure.
benign() { # benign <key> <text>
  local sel
  case "$1" in
    settle_*) for sel in AlreadySettled "$SEL_SETTLED" SettleOver "$SEL_OVER"; do [[ -n "$sel" && "$2" == *"$sel"* ]] && return 0; done ;;
    open_*) for sel in TooSoon "$SEL_SOON" ListingNotEnabled "$SEL_NOTENABLED"; do [[ -n "$sel" && "$2" == *"$sel"* ]] && return 0; done ;;
  esac
  return 1
}

# True when `key` may be tried now: not given up on, and its wait is over.
due() { # due <key>
  local cur="NEXT_$1" at
  at="${!cur:-0}"
  ((at == -1)) && return 1
  ((at <= $(date +%s)))
}

# True when round `id` is now settled on the chain: after a refused settle this tells "someone else got there first" from
# "still unsettled, the window is closing". Anything unreadable counts as not settled (the failure stays reported).
round_settled() { # round_settled <id>
  local r
  r="$(cast call "$MARKET" \
    "rounds(uint256)(uint128,uint128,uint32,uint64,uint64,uint64,uint256,uint256,uint16,bool,bool)" "$1" \
    --rpc-url "$RPC_URL" 2>/dev/null | nth 10)" || return 1
  [[ "$r" == "true" ]]
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
    # chain's own reason. Anything else (no gas, an unreachable node, a settle too heavy to mine) is a failure.
    if benign "$key" "$gas"; then
      say "note: skipped $label, the chain says it is not needed: $(reason "$gas")"
      return 0
    fi
    if [[ "$key" == settle_* ]] && round_settled "${key#settle_}"; then
      say "note: skipped $label, the round is already settled"
      return 0
    fi
    failed "$key" "$label (gas estimate)" "$(reason "$gas")"
    return 0
  fi
  if [[ "$gas" =~ ^[0-9]+$ ]] && ((gas >= TX_GAS_CAP)); then
    say "WARNING: $label needs about $gas gas, at or over the $TX_GAS_CAP per-transaction cap some chains enforce; it may not be minable there."
  fi
  if err="$(cast send "$MARKET" "$@" "${SIGN_ARGS[@]}" --rpc-url "$RPC_URL" 2>&1 >/dev/null)"; then
    say "sent $label (estimated gas ${gas})"
    printf -v "FAILS_$key" '%s' 0
    printf -v "NEXT_$key" '%s' 0
  elif benign "$key" "$err"; then
    say "note: skipped $label, the chain says it is not needed: $(reason "$err")"
  elif [[ "$key" == settle_* ]] && round_settled "${key#settle_}"; then
    say "note: $label was refused, but the round is now settled"
  else
    failed "$key" "$label (send)" "$(reason "$err")"
  fi
}

pass() {
  local now count
  now="$(cast block latest --field timestamp --rpc-url "$RPC_URL")"
  count="$(cast call "$MARKET" "roundCount()(uint256)" --rpc-url "$RPC_URL" | nth 1)"
  [[ "$now" =~ ^[0-9]+$ && "$count" =~ ^[0-9]+$ ]] || { say "ERROR: could not read the market; trying again next pass"; return 2; }

  if ((count > 0)); then
    local round closes deadline settled
    round="$(cast call "$MARKET" \
      "rounds(uint256)(uint128,uint128,uint32,uint64,uint64,uint64,uint256,uint256,uint16,bool,bool)" "$count" \
      --rpc-url "$RPC_URL")"
    closes="$(printf '%s\n' "$round" | nth 5)"
    deadline="$(printf '%s\n' "$round" | nth 6)"
    settled="$(printf '%s\n' "$round" | nth 10)"
    if [[ ! "$closes" =~ ^[0-9]+$ || ! "$deadline" =~ ^[0-9]+$ || ! "$settled" =~ ^(true|false)$ ]]; then
      say "ERROR: round $count was not readable; trying again next pass"
      return 2
    fi
    if [[ "$settled" == "false" ]] && ((now >= closes && now < deadline)); then
      send "settle_$count" "settle(round $count)" "settle(uint256)" "$count"
    fi
  fi

  if [[ "$OPEN" == "1" ]]; then
    local enabled last
    enabled="$(cast call "$MARKET" "listing()(bool,uint128,uint128,uint32)" --rpc-url "$RPC_URL" | nth 1)"
    last="$(cast call "$MARKET" "lastOpenAt()(uint256)" --rpc-url "$RPC_URL" | nth 1)"
    if [[ ! "$enabled" =~ ^(true|false)$ || ! "$last" =~ ^[0-9]+$ ]]; then
      say "ERROR: the listing was not readable; trying again next pass"
      return 2
    fi
    if [[ "$enabled" == "true" ]] && ((last == 0 || now >= last + EVERY)); then
      send "open_$((last + EVERY))" "openRound()" "openRound()"
    fi
  fi
}

if [[ "${1:-}" == "--once" ]]; then
  # Not under `set -e` here so a failed read gets its own exit status (2) after the pass has logged why.
  rc=0
  pass || rc=$?
  ((rc != 0)) && exit "$rc"
  exit "$SEND_FAILED"
fi
say "watching $MARKET every ${INTERVAL}s (opening rounds: $([[ "$OPEN" == "1" ]] && echo yes || echo no))"
while true; do
  pass || say "pass failed; trying again next pass"
  sleep "$INTERVAL"
done
