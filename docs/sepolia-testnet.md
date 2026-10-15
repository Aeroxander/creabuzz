# Running a Sepolia testnet

Goal: a shared testnet users and advisors can open in a browser, create a community in, launch a project on, and back with test
money. Everything here is test money on Sepolia. Nothing in it is audited, and mainnet stays off.

## What runs where

| Piece | Where it comes from | Status |
|---|---|---|
| Sale factory, Permit2, Circle's USDC, Limit Break's validators, the TokenMaster router, the passkey-account factory | Already on Sepolia | Used as they are |
| Our summoner (Shares with the milestone lock guard) and the `DaoLaunchKit` | `scripts/sepolia-deploy.sh --broadcast` | One deploy, about 3 transactions |
| The server (relay) with Postgres and Redis | You host it | Needed: communities, boards, records live here |
| The web app | `pnpm build` with the Sepolia settings below, served as static files | Needed |
| LBAMM (the exchange) | Not deployed by anyone on Sepolia | **Not on the testnet.** See below |

### The market is off on Sepolia, on purpose

Limit Break's own registry lists LBAMM as not deployed, and its README rules out use on a live network. So Sepolia launches have
the sale, the treasury, decisions, work and milestones, and no trading screen. The app only offers a market when the exchange
contracts at the configured addresses have code that matches pinned hashes (`web/src/features/launchpad/lib/exchange-verify.ts`),
so nothing on Sepolia can show a market by accident. The exchange stays on the local fork until Limit Break deploys and permits one.

## 1. Deploy the contracts

Put these in `.env` (never on the command line, never in the repo):

```
SEPOLIA_RPC_URL=<your node's URL>
DEPLOYER_PRIVATE_KEY=<a key used for nothing else, holding only test ETH>
```

Fund the deployer from a Sepolia faucet (a few hundredths of an ETH is plenty), then:

```bash
scripts/sepolia-deploy.sh                 # rehearse on a local fork first: nothing public changes
scripts/sepolia-deploy.sh --broadcast     # the real deploy
```

The rehearsal needs no key and leaves the repo as it was. The real deploy checks the chain id and the balance, deploys the
summoner, works out the Shares implementation (a deterministic address, checked against a real DAO's clone in
`contracts/test/DeployLaunchKit.t.sol`), deploys the kit and writes `contracts/deployments/dao-launch-kit-11155111.json`.
Commit that file: it is public addresses only.

## 2. Host the server

The server is the existing relay. For a testnet it needs the same things as any deployment (see
`docs/self-serve-communities.md` and `docs/deployment-identity.md`), plus the chain it reads wallets from:

```
BUZZ_EVM_AUTH=1
BUZZ_EVM_CHAIN_ID=11155111
BUZZ_EVM_RPC_URL=<your Sepolia node>
```

Self-serve communities should be on so anyone can start one. The server never holds a user's money and never needs a private key
for the testnet.

## 3. Build and host the web app

```
VITE_LAUNCHPAD_CHAIN_ID=11155111
VITE_CHAIN_RPC_URL=<your Sepolia node>
VITE_DAO_LAUNCH_KITS={"11155111":"<kit address from the manifest>"}
VITE_HISTORY_FROM_BLOCKS={"11155111":<the manifest's "block">}
VITE_ZERODEV_PROJECT_ID=<a ZeroDev project on Sepolia>
VITE_ZERODEV_CHAIN_ID=11155111
VITE_BUNDLER_URL=<the project's Sepolia bundler>
```

Then `pnpm build` in `web/` and serve `dist/` from any static host. The RPC URL ends up in the page, so use a key meant for that
(a read-only key with a request limit), not the deployer's. The deploy script prints the chain id, kit and history-start settings.

`VITE_HISTORY_FROM_BLOCKS` matters. A real node refuses an event read that starts at block 0 ("exceed maximum block range",
usually over 10,000 to 50,000 blocks), so the app reads in pages and starts at the block the kit was deployed (every contract it
reads was made after that). Without it a read on Sepolia would need thousands of pages, and the app stops after a bounded number
and tells you to set it. The fork journey found this: before the fix, the My bids tab on a Sepolia fork said "Could not read
bids: exceed maximum block range: 50000".

The command line (`buzz`) and the desktop app read their own event history and have not been given the same page-splitting;
testers should use the web app on Sepolia.

Passkey accounts need a ZeroDev project on Sepolia (its bundler and paymaster). Without one, people can still use a wallet they
bring (a browser wallet or a key made in the app); passkey accounts will not send transactions.

## 4. What testers need

- **Sepolia ETH** for gas, from any faucet, unless a paymaster covers gas for passkey accounts.
- **Circle test USDC** from Circle's faucet (faucet.circle.com, pick Ethereum Sepolia). Circle's USDC has no open mint, which is
  why the local tests write balances into a fork instead.
- A short note saying what to try: start a community, launch a project from a template (name the people who judge its
  milestones: the launch will not go without them), back one, hold a vote, claim a task, review a claim. `docs/v3-review/TEST-STEPS.md` has the steps.

### One thing to check with passkey accounts: the launch is one big transaction

The launch (DAO, sale, milestone lock and panel) uses about 12.6 million gas, under Ethereum's cap of 16.8 million for one
transaction (a test checks it). A bundler may set a lower limit on what one account operation can spend, so a launch sent
from a passkey account could be refused where a launch sent from an ordinary wallet is not. Try one launch from a passkey
account on your ZeroDev project before inviting testers, and tell me if it is refused.

## 5. Check it before inviting anyone

```bash
cd contracts && forge test --match-contract SepoliaLaunchForkTest --fork-url "$SEPOLIA_RPC_URL" -vv   # a launch, a sale, a claim, a bonded review, on a fork of the real chain
scripts/sepolia-deploy.sh                                                                          # rehearsal
scripts/web-sepolia-fork-e2e.sh                                                                    # the whole story in three browsers on a fork
```

The first two run against a fork, so they say nothing about your hosted server and web app. After the deploy, walk the story once
yourself on the hosted site.

## What to say to testers

- It is a testnet: the money is not real and nothing here is audited.
- Nothing on the page is legal advice. The IP card and the entity wording are the project's own statements.
- The exchange is not there yet.
- Expect resets: a testnet can be thrown away and redeployed.

## Asking Limit Break

To put the exchange on a testnet or a mainnet someone has to deploy it, and its terms say not to use the current code on a live
network. Ask Limit Break for: a deployment on Sepolia (or a statement that none is coming), the production address and code hash
per chain, the audit reports, and the terms for a public market of project tokens. Until then the market stays off here.
