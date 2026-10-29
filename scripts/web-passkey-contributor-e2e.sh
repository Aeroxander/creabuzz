#!/usr/bin/env bash
#
# scripts/web-passkey-contributor-e2e.sh — a contributor project done from PASSKEY ACCOUNTS, with no browser wallet and no
# test ETH (D139), on a local fork of Sepolia.
#
# Forks Sepolia (so the passkey account contracts are Sepolia's own: EntryPoint v0.7, the Kernel 0.3.3 factory, its passkey
# validator, the P-256 verifier), deploys the kits with the Sepolia deploy's own Forge script, and puts an accept-all
# paymaster on the fork in place of the hosted one. Builds the web app the way the hosted image is built: only the
# settings its Dockerfile takes (the chain, its node, the contributor kit, where history starts, ZeroDev). Then runs
# web/tests/e2e/passkey-contributor.spec.ts: a founder and a contributor sign up with virtual passkeys, start a project,
# submit work, mark it finished and award it from their passkey accounts; two reviewers keep browser wallets. A stand-in
# bundler in the page sends each operation to the fork's entry point (web/tests/helpers/stand-in-bundler.ts).
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local fork, nothing public.
#
# Usage:  scripts/web-passkey-contributor-e2e.sh [playwright args]
# Env:    ANVIL_PORT, SKIP_BUILD=1 (reuse web/dist built by this script), SEPOLIA_RPC_URL (the node to fork)

WORLD_NAME=web-passkey-contributor
WORLD_NO_CLI=1
# shellcheck source=lib/no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/no-raise-world.sh"
# shellcheck source=lib/sepolia-fork.sh
. "$REPO_ROOT/scripts/lib/sepolia-fork.sh"

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi

ENTRY_POINT=0x0000000071727De22E5E9d8BAf0edAc6f37da032
# Sends each handleOps, as a bundler does: anvil's ninth dev account.
SUBMITTER=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
KEY_SUBMITTER=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6

SEPOLIA_BACKUP="$(mktemp -d)"
[[ -f "$SEPOLIA_MANIFEST" ]] && cp -p "$SEPOLIA_MANIFEST" "$SEPOLIA_BACKUP/manifest.json"
trap 'sepolia_restore_artifacts "$SEPOLIA_BACKUP"; rm -rf "$SEPOLIA_BACKUP"; cleanup' EXIT
step "forking Sepolia into a local anvil on ${RPC}"
sepolia_fork_up "${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}" "$PORT" "$STATE/anvil.log"
echo "$FORK_PID" >"$STATE/anvil.pid"
[[ "$FORK_RPC" == "$RPC" ]] || fail "the fork is not where the world expects it ($FORK_RPC, not $RPC)"
for code in "$ENTRY_POINT" 0x2577507b78c2008Ff367261CB6285d44ba5eF2E9 0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69 \
  0xc2b78104907F722DABAc4C69f826a522B2754De4; do
  [[ "$(cast code "$code" --rpc-url "$RPC")" != "0x" ]] || fail "Sepolia has no code at $code: the passkey account stack moved"
done

step "deploying the summoner and both kits with the Sepolia deploy's own script"
# The deploy key is anvil's last dev account; on the real Sepolia strangers point dev accounts at contracts of their own
# (EIP-7702), so every account used here is made plain first.
for who in "$SUBMITTER" "$REVIEWER1" "$REVIEWER2"; do
  cast rpc --rpc-url "$RPC" anvil_setCode "$who" 0x >/dev/null
done
cast rpc --rpc-url "$RPC" anvil_setBalance "$SUBMITTER" "$(cast to-hex "$(cast to-wei 1000)")" >/dev/null
for who in "$REVIEWER1" "$REVIEWER2"; do
  cast rpc --rpc-url "$RPC" anvil_setBalance "$who" "$(cast to-hex "$(cast to-wei 0.1)")" >/dev/null
done
sepolia_deploy_kits "$RPC" "$KEY_SUBMITTER" "$STATE/deploy.out"
CONTRIBUTOR_KIT="$(sepolia_role contributor-kit)"
[[ "$CONTRIBUTOR_KIT" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no contributor kit was deployed"
FROM_BLOCK="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).block??"")' "$SEPOLIA_MANIFEST")"
[[ "$FROM_BLOCK" =~ ^[0-9]+$ ]] || fail "the manifest names no deploy block"

step "putting an accept-all paymaster on the fork, with 100 ETH behind it"
# (--constructor-args takes every value after it, so it goes last.)
PAYMASTER="$(cd "$REPO_ROOT/contracts" && forge create test/helpers/AcceptAllPaymaster.sol:AcceptAllPaymaster \
  --private-key "$KEY_SUBMITTER" --rpc-url "$RPC" --broadcast --constructor-args "$ENTRY_POINT" 2>&1 \
  | tee "$STATE/paymaster.out" | awk '/Deployed to:/ {print $3}')"
[[ "$PAYMASTER" =~ ^0x[0-9a-fA-F]{40}$ ]] || { tail -5 "$STATE/paymaster.out"; fail "the paymaster was not deployed"; }
cast send "$PAYMASTER" "deposit()" --value 100ether --private-key "$KEY_SUBMITTER" --rpc-url "$RPC" >/dev/null \
  || fail "could not fund the paymaster"
step "chain ${SEPOLIA_CHAIN_ID}  contributor kit ${CONTRIBUTOR_KIT}  paymaster ${PAYMASTER}"

cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app with only the settings the hosted image takes"
  env VITE_LAUNCHPAD_CHAIN_ID="$SEPOLIA_CHAIN_ID" VITE_CHAIN_RPC_URL="$RPC" \
    VITE_CONTRIBUTOR_KITS="{\"${SEPOLIA_CHAIN_ID}\":\"${CONTRIBUTOR_KIT}\"}" \
    VITE_HISTORY_FROM_BLOCKS="{\"${SEPOLIA_CHAIN_ID}\":${FROM_BLOCK}}" \
    VITE_ZERODEV_PROJECT_ID=fork-stand-in VITE_ZERODEV_CHAIN_ID="$SEPOLIA_CHAIN_ID" VITE_CONTRIBUTOR_ONLY=1 \
    node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_KIT="$CONTRIBUTOR_KIT" E2E_PAYMASTER="$PAYMASTER" E2E_SUBMITTER="$SUBMITTER" \
  E2E_REVIEWER1="$REVIEWER1" E2E_REVIEWER2="$REVIEWER2" \
  node_modules/.bin/playwright test tests/e2e/passkey-contributor.spec.ts --project=passkey-contributor --reporter=list "$@"
