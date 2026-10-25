# Running a Sepolia testnet

Goal: a shared testnet users and advisors can open in a browser, create a community in, start a contributor project on, claim
and review work in, and earn Shares by vote. That is the first launch (the social MVP and contributor projects, no raise); test
raises can be switched on in the same build (below). Everything here is test money on Sepolia. Nothing in it is audited, and
mainnet stays off.

**Shares earned on Sepolia are test records.** They will not move to a real network automatically: a real network gets its own
contracts and its own DAOs, and nothing carries a Sepolia balance over. The app says so on the Start page of a contributor
project and on every project's Contributions tab (D85).

## What runs where

| Piece | Where it comes from | Status |
|---|---|---|
| Sale factory, Permit2, Circle's USDC, Limit Break's validators, the TokenMaster router, the passkey-account factory | Already on Sepolia | Used as they are |
| Our summoner (with its work budget factory and voting policy), the `DaoLaunchKit` with its two lock factories, and the `ContributorKit` | `scripts/sepolia-deploy.sh --broadcast` | One deploy: 7 transactions, about 30.2 million gas |
| The server (relay) with Postgres and Redis | You host it | Needed: communities, boards, records live here |
| The web app | `pnpm build` with the Sepolia settings below, served as static files | Needed |
| LBAMM (the exchange) | Not deployed by anyone on Sepolia | **Not on the testnet.** See below |

### The market is off on Sepolia, on purpose

Limit Break's own registry lists LBAMM as not deployed, and its README rules out use on a live network. So Sepolia launches have
the sale, the treasury, decisions, work and milestones, and no trading screen. The app only offers a market when the exchange
contracts at the configured addresses have code that matches pinned hashes (`web/src/features/launchpad/lib/exchange-verify.ts`),
so nothing on Sepolia can show a market by accident. The exchange stays on the local fork until Limit Break deploys and permits one.

## 1. Deploy the contracts

Put these in `.env` at the repo root (never on the command line, never in the repo; `.env` is ignored):

```
SEPOLIA_RPC_URL=<your node's URL>
DEPLOYER_PRIVATE_KEY=<a key used for nothing else, holding only test ETH>
```

Rehearse first, then deploy:

```bash
scripts/sepolia-deploy.sh
```

```bash
scripts/sepolia-deploy.sh --broadcast
```

The rehearsal needs no key: it forks Sepolia into a local anvil, deploys there, checks what came out, prints what the real deploy
will cost at today's gas price, and leaves the repo as it was. The real deploy checks the chain id and the deployer's balance,
deploys the summoner, works out the Shares implementation (a deterministic address, checked against a real DAO's clone in
`contracts/test/DeployLaunchKit.t.sol`), deploys the launch kit with its two lock factories and the contributor kit, checks that
each kit names the summoner it was given, and writes `contracts/deployments/dao-launch-kit-11155111.json`. Commit that file: it
is public addresses only, and it is the one manifest in that folder git does not ignore.

**What it costs.** Measured on a fork on 2026-10-21: 7 transactions, 30,133,132 gas in all; the largest (the summoner) asks for
12.3 million, under Sepolia's cap of 16,777,216 for one transaction (the rehearsal checks it). At Sepolia's gas price that day
(about 0.00000002 gwei) that is well under a millionth of a test ETH; at 1 gwei it is 0.03 ETH, at 20 gwei 0.6 ETH. The rehearsal
prints the figure for the day you run it: fund the deployer with that plus a margin from a Sepolia faucet. Test ETH has no price.

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

Every setting is read when the app is built (`pnpm build` in `web/`), ends up in the page, and is public. Serve `dist/` from any
static host, or from the relay itself (`BUZZ_WEB_DIR`).

| Setting | Value for Sepolia | Needed for |
|---|---|---|
| `VITE_LAUNCHPAD_CHAIN_ID` | `11155111` | Everything on chain: the network the app reads and asks wallets to be on |
| `VITE_CHAIN_RPC_URL` | A Sepolia node meant for the page: a read-only key with a request limit, not the deployer's | Everything on chain. Without it a hosted page has no node at all (it never falls back to the visitor's own computer) |
| `VITE_CONTRIBUTOR_KITS` | `{"11155111":"<contributor-kit from the manifest>"}` | Starting contributor projects. Without it Start says "Contributor projects cannot be started on Sepolia yet" |
| `VITE_WORK_BOUNTIES` | `{"11155111":"<work-bounty from the manifest>"}` | **Optional.** "Put money behind this work area" on contributor projects (N1). Without it the Work tab shows no bounties |
| `VITE_OPEN_BOUNTIES` | `{"11155111":"<open-bounty from the manifest>"}` | **Optional.** "Put money behind this" under a post (N2). Without it a post page shows no bounties |
| `VITE_HISTORY_FROM_BLOCKS` | `{"11155111":<the manifest's "block">}` | Reading awards, work and votes: a real node refuses an event read that starts at block 0 |
| `VITE_DAO_LAUNCH_KITS` | `{"11155111":"<launch-kit from the manifest>"}` | **Optional.** Test raises. Leave it out for the contributor-only first launch: the raise wizard then saves drafts but cannot launch one. With it set, the contributor Start page also checks that both kits name the same summoner |
| `VITE_RELAY_URL` | `wss://<your relay>` | Only when the page is not served by the relay itself (it otherwise talks to its own origin) |
| `VITE_COMMUNITY_API_ORIGIN` | `https://<your relay>` | Only when communities live on several hosts (see `docs/self-serve-communities.md`) |
| `VITE_ZERODEV_PROJECT_ID`, `VITE_ZERODEV_CHAIN_ID=11155111`, `VITE_BUNDLER_URL` (and `VITE_ZERODEV_API_KEY` if the project has one) | A ZeroDev project on Sepolia, with sponsorship turned on in its dashboard (a gas policy) | Passkey accounts, with gas paid by its paymaster: testers then need no test ETH at all. Without them people bring a wallet (a browser wallet or a key made in the app) and pay their own test gas |
| `VITE_ERROR_REPORT_URL`, `VITE_APP_RELEASE` | Your collector and the build's version | Optional error reports (`docs/error-reporting.md`) |

Leave these **unset** on Sepolia: `VITE_ENABLE_MAINNET` (it would offer real networks and hide the Testnet tag),
`VITE_LOCAL_USDC` (a local chain's test currency; Sepolia's Circle USDC is built in), `VITE_LBAMM_ADDRESSES` (no exchange there),
`VITE_PRICE_INDEXER_URL` (no market to price).

The deploy script prints the chain id, kit and history-start settings with the real addresses. A contributor-only build:

```
VITE_LAUNCHPAD_CHAIN_ID=11155111
VITE_CHAIN_RPC_URL=<a read-only Sepolia node for the page>
VITE_CONTRIBUTOR_KITS={"11155111":"<contributor-kit>"}
VITE_WORK_BOUNTIES={"11155111":"<work-bounty>"}
VITE_OPEN_BOUNTIES={"11155111":"<open-bounty>"}
VITE_HISTORY_FROM_BLOCKS={"11155111":<block>}
```

`VITE_HISTORY_FROM_BLOCKS` matters. A real node refuses an event read that starts at block 0 ("exceed maximum block range",
usually over 10,000 to 50,000 blocks), so the app reads in pages and starts at the block the kits were deployed (every contract it
reads was made after that). Without it a read on Sepolia would need thousands of pages, and the app stops after a bounded number
and tells you to set it. The fork journey found this: before the fix, the My bids tab on a Sepolia fork said "Could not read
bids: exceed maximum block range: 50000".

The command line (`buzz`) and the desktop app read their own event history and have not been given the same page-splitting;
testers should use the web app on Sepolia.

## 4. What testers need

**Contributor projects need no test USDC.** A claim asks for no money and an award is paid in Shares, so everyone needs only a
little Sepolia ETH for gas (or a passkey account whose gas the ZeroDev paymaster pays). Measured on a Sepolia fork for one whole
project (start it, one claim, two approvals, one award vote):

| Who | Transactions | Gas | At 20 gwei |
|---|---|---|---|
| Founder (starts it, takes the claim on, finishes it, opens, backs, starts and runs the award vote) | 7 | 6,780,006 | 0.14 ETH |
| Contributor (files the claim, states its check, takes it once approved) | 3 | 217,909 | 0.004 ETH |
| Each reviewer (one approval) | 1 | about 100,000 | 0.002 ETH |

At Sepolia's gas price on 2026-10-21 all of it cost practically nothing, so one faucet visit covers a founder unless gas rises
to several gwei. Passkey accounts on a sponsored ZeroDev project need no test ETH at all.

For test raises, if the build offers them:

- **Sepolia ETH** for gas, from any faucet, unless a paymaster covers gas for passkey accounts.
- **Circle test USDC** from Circle's faucet (faucet.circle.com, pick Ethereum Sepolia). Circle's USDC has no open mint, which is
  why the local tests write balances into a fork instead.

And a short note saying what to try: start a community, start a contributor project from Start (name two or more reviewers other
than yourself, and start with at most a third of the Shares the first budget can award: the form and the contract both refuse
more), claim a task from a second account, approve it as the reviewers, award it by vote, and look at the Contributions tab.
`docs/v3-review/TEST-STEPS.md` (4al) has the steps.

### One thing to check with passkey accounts: one big transaction

The contributor project starts in one transaction of about 5.5 million gas (about 6.2 million with the most first
projects, eight), and a raise's launch (DAO, sale, milestone lock and panel) uses about 12.6 million, both under Ethereum's
cap of 16.8 million for one transaction (a test checks the raise). A
bundler may set a lower limit on what one account operation can spend, so a launch sent from a passkey account could be refused
where the same launch from an ordinary wallet is not. Try one contributor project from a passkey account on your ZeroDev project
before inviting testers, and tell me if it is refused.

## 5. Check it before inviting anyone

```bash
scripts/sepolia-deploy.sh                          # rehearsal: deploy, checks, today's cost
scripts/web-contributor-e2e.sh --sepolia-fork      # a contributor project in pages on a fork, built like a hosted Sepolia build
cd contracts && forge test --match-contract SepoliaLaunchForkTest --fork-url "$SEPOLIA_RPC_URL" -vv   # a raise on a fork
scripts/web-sepolia-fork-e2e.sh                    # a raise: the whole story in three browsers on a fork
```

All of them run against a fork, so they say nothing about your hosted server and web app. After the deploy, walk the contributor
story once yourself on the hosted site.

## What to say to testers

- It is a testnet: the money is not real and nothing here is audited.
- Shares earned here are test records. They will not move to a real network automatically.
- Nothing on the page is legal advice. The IP card and the entity wording are the project's own statements.
- The exchange is not there yet.
- Expect resets: a testnet can be thrown away and redeployed.

## Asking Limit Break

To put the exchange on a testnet or a mainnet someone has to deploy it, and its terms say not to use the current code on a live
network. Ask Limit Break for: a deployment on Sepolia (or a statement that none is coming), the production address and code hash
per chain, the audit reports, and the terms for a public market of project tokens. Until then the market stays off here.
