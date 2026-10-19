#!/usr/bin/env bash
#
# scripts/lib/no-raise-world.sh — a throwaway dev chain with a DAO, and the CLI steps that take a project that never
# raised from "nothing" to "work in review". Sourced by `cli-no-raise-e2e.sh` and `web-work-e2e.sh`.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Set WORLD_NAME before sourcing to label the output (and WORLD_NO_CLI=1 when the journey never runs the CLI). Provides: the dev accounts (KEY_* / addresses), `world_up`,
# the helpers `as`, `jget`, `warp`, `decide`, `shares_of`, and one function per step of the journey.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
for tool in forge cast anvil node cargo; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }
done

PORT="${ANVIL_PORT:-$((18000 + RANDOM % 1000))}"
RPC="http://127.0.0.1:${PORT}"
STATE="$(mktemp -d)"
DEPLOYMENTS="$REPO_ROOT/contracts/deployments"
BACKUP="$(mktemp -d)"
step() { printf '\033[36m[%s]\033[0m %s\n' "${WORLD_NAME:-world}" "$*"; }
fail() { printf '\033[31m[%s] FAIL:\033[0m %s\n' "${WORLD_NAME:-world}" "$*" >&2; exit 1; }

cp -p "$DEPLOYMENTS"/*.json "$BACKUP"/ 2>/dev/null || true
cleanup() {
  RPC_URL="$RPC" STATE_DIR="$STATE" ./scripts/dev-chain.sh down >/dev/null 2>&1 || true
  # Stop only the Anvil this run recorded, never a process found merely by its port.
  local own_pid
  own_pid="$(cat "$STATE/anvil.pid" 2>/dev/null || true)"
  if [[ -n "$own_pid" ]] && ps -o command= -p "$own_pid" 2>/dev/null | grep -Eq "anvil.* --port[ =]${PORT}( |\$)"; then
    kill "$own_pid" 2>/dev/null || true
  fi
  for f in "$BACKUP"/*.json; do
    [[ -f "$f" ]] && cp -p "$f" "$DEPLOYMENTS/$(basename "$f")"
  done
  rm -rf "$STATE" "$BACKUP"
}
trap cleanup EXIT

# Anvil's public dev accounts.
KEY_FOUNDER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # holds half the DAO's Shares
KEY_REVIEWER1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d # the DAO's other holder
KEY_REVIEWER2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
KEY_CONTRIBUTOR=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
KEY_MANAGER=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
addr() { cast wallet address --private-key "$1"; }
FOUNDER=$(addr $KEY_FOUNDER); REVIEWER1=$(addr $KEY_REVIEWER1); REVIEWER2=$(addr $KEY_REVIEWER2)
CONTRIBUTOR=$(addr $KEY_CONTRIBUTOR); MANAGER=$(addr $KEY_MANAGER)

world_up() {
  step "booting a dev chain on ${RPC}"
  if ! RPC_URL="$RPC" STATE_DIR="$STATE" ./scripts/dev-chain.sh >"$STATE/dev-chain.out" 2>&1; then
    tail -60 "$STATE/dev-chain.out"; fail "dev-chain failed"
  fi
  DAO=$(awk '/^  DAO: / {print $2; exit}' "$STATE/org-dao.log")
  [[ "$DAO" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no DAO address in the dev chain's org-dao log"
  CURRENCY=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(m.roles[0].address)' "$DEPLOYMENTS/dev-currency-31337.json")
  POLICY=$(cast call "$DAO" "votingWeight()(address)" --rpc-url "$RPC")
  FACTORY=$(cast call "$POLICY" "mandateFactory()(address)" --rpc-url "$RPC")
  SHARES=$(cast call "$DAO" "shares()(address)" --rpc-url "$RPC")
  step "dao ${DAO}  mandate factory ${FACTORY}"

  # A journey that never runs the CLI (WORLD_NO_CLI=1) skips building it.
  if [[ "${WORLD_NO_CLI:-}" == "1" ]]; then BUZZ=""; elif [[ -n "${BUZZ_BIN:-}" ]]; then BUZZ="$BUZZ_BIN"; else
    step "building the CLI"
    cargo build -q -p buzz-cli || fail "cargo build failed"
    BUZZ="$REPO_ROOT/target/debug/buzz"
  fi
}

# `as <key> <buzz args…>` runs one command as one account; stdout is the command's JSON.
as() { local key="$1"; shift; BUZZ_EVM_RPC_URL="$RPC" BUZZ_SPENDER_KEY="$key" "$BUZZ" launchpad "$@"; }
jget() { node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=o[process.argv[1]];console.log(typeof v==="object"?JSON.stringify(v):v)' "$1"; }
warp() { cast rpc --rpc-url "$RPC" anvil_increaseTime "$1" >/dev/null; cast rpc --rpc-url "$RPC" anvil_mine 1 >/dev/null; }
shares_of() { cast call "$SHARES" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | awk '{print $1}'; }

# A DAO decision: open it, back it, wait out the review, queue it, wait out the delay, execute it.
decide() { # <intent json> <review seconds>
  local intent="$1" review="$2" to data nonce id
  to=$(echo "$intent" | jget to); data=$(echo "$intent" | jget data); nonce=$(echo "$intent" | jget nonce)
  id=$(as $KEY_FOUNDER propose --dao "$DAO" --to "$to" --data "$data" --nonce "$nonce" | jget id)
  as $KEY_FOUNDER vote --dao "$DAO" --id "$id" --support for >/dev/null
  warp "$review"
  as $KEY_FOUNDER queue --dao "$DAO" --id "$id" >/dev/null
  warp 90000
  as $KEY_FOUNDER process --dao "$DAO" --to "$to" --data "$data" --nonce "$nonce" >/dev/null
}


# ── the journey, one step at a time ──────────────────────────────────────────────
world_mandate() { # a Shares-only mandate with three reviewers (the contributor is on the panel, to test recusal)
  step "the DAO votes a mandate with a share budget and no money"
  local intent
  intent=$(as $KEY_FOUNDER work mandate --dao "$DAO" --factory "$FACTORY" --currency "$CURRENCY" \
    --share-budget 100 --share-cap 40 --expires-in-days 90 \
    --reviewer "$REVIEWER1" --reviewer "$REVIEWER2" --reviewer "$CONTRIBUTOR" --quorum 2 \
    ${REVIEWER_BOND:+--decimals 6 --reviewer-bond "$REVIEWER_BOND"})
  [[ "$(echo "$intent" | jget lane)" == "unrestricted" ]] || fail "a mandate should take the full vote"
  decide "$intent" 175000
  MANDATE=$(cast logs --json --rpc-url "$RPC" --from-block 0 --address "$FACTORY" \
    "MandateCreated(address,address,address,uint128,uint128,uint128,uint128)" \
    | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("0x"+l[l.length-1].topics[2].slice(-40))')
  [[ "$MANDATE" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no MandateCreated event from the factory"
  [[ "$(cast call "$FACTORY" "daos(address)(address)" "$MANDATE" --rpc-url "$RPC")" == "$DAO" ]] \
    || fail "the factory does not know mandate $MANDATE as this DAO's"
  step "mandate ${MANDATE}"
}

world_project() { # a project (id "docs") with a 40 Share allowance, managed by $MANAGER
  step "the DAO votes a project into the mandate (the lighter lane)"
  local intent
  intent=$(as $KEY_FOUNDER work project --dao "$DAO" --mandate "$MANDATE" --id docs --manager "$MANAGER" \
    --shares 40 --expires-in-days 30 --check-text "docs merged and reviewed")
  [[ "$(echo "$intent" | jget lane)" == "bounded" ]] || fail "a project should take the bounded lane"
  decide "$intent" 90000
}

world_claim_filed() { # the contributor files claim "write-docs" asking for no money, and states its check
  step "the contributor files a claim that asks for no money"
  echo "the docs, merged" > "$STATE/evidence.txt"
  as $KEY_CONTRIBUTOR work claim --mandate "$MANDATE" --id write-docs --evidence-file "$STATE/evidence.txt" >/dev/null
  as $KEY_CONTRIBUTOR work check --mandate "$MANDATE" --id write-docs --check-text "docs merged and reviewed" >/dev/null
}

world_claim_bound() { # a claim id is first come, first served: binding names the contributor it means
  if as $KEY_MANAGER work bind --mandate "$MANDATE" --project docs --id write-docs --contributor "$REVIEWER1" >/dev/null 2>&1; then
    fail "bound a claim that someone else filed"
  fi
  as $KEY_MANAGER work bind --mandate "$MANDATE" --project docs --id write-docs --contributor "$CONTRIBUTOR" >/dev/null
}
