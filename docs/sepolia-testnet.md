# Running a Sepolia testnet

Goal: a shared testnet invited users and advisors can open in a browser, join with an invite link, start a contributor
project on, claim and review work in, and earn Shares by vote. That is the first launch (the social MVP and contributor projects, no raise),
served by the Creaton image (`deploy/compose`). Test raises and the optional features need a build of their own (below).
Everything here is test money on Sepolia. Nothing in it is audited, and mainnet stays off.

**Shares earned on Sepolia are test records.** They will not move to a real network automatically: a real network gets its own
contracts and its own DAOs, and nothing carries a Sepolia balance over. The app says so on the Start page of a contributor
project and on every project's Contributions tab (D85).

## What runs where

| Piece | Where it comes from | Status |
|---|---|---|
| Sale factory, Permit2, Circle's USDC, Limit Break's validators, the TokenMaster router, the passkey-account factory | Already on Sepolia | Used as they are |
| Our summoner (with its work budget factory and voting policy), the `DaoLaunchKit` with its two lock factories, the `ContributorKit`, and the optional features' contracts | `scripts/sepolia-deploy.sh --broadcast` | One deploy: 17 transactions, about 47.6 million gas, measured before the old weekly rounds contract was dropped from it (one contract fewer now: measure again with a rehearsal) |
| The server (relay) with Postgres and Redis | You host it | Needed: communities, boards, records live here |
| The web app | The Creaton image (`deploy/compose`, built with the settings below), served by the relay | Needed |
| LBAMM (the exchange) | Not deployed by anyone on Sepolia | **Not on the testnet.** See below |

### The old weekly rounds contract is not deployed any more

`scripts/sepolia-deploy.sh` no longer deploys the old `WeeklyRounds` contract, checks it or prints a setting for it, and the
app no longer offers it (D185). A copy made by the 5 Nov 2026 deploy (`0xE684Bb57c31Faa4b8e854DAB9d141D06144899A2`, listed
in `contracts/deployments/dao-launch-kit-11155111.json`, which is history and stays as it was) is an unused test deployment:
leave it alone and point nothing at it. The contract's source stays in the repository, marked deprecated, with its audit
record.

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
`contracts/test/DeployLaunchKit.t.sol`), deploys the launch kit with its two lock factories, the contributor kit and the
optional features' contracts, checks that each names what it was given, and writes `contracts/deployments/dao-launch-kit-11155111.json`. Commit that file: it
is public addresses only, and it is the one manifest in that folder git does not ignore.

**What it costs.** The rehearsal now sends 17 transactions, about 47.6 million gas in all; the largest asks for about
13.3 million, under Sepolia's cap of 16,777,216 for one transaction (the rehearsal checks it). At 1 gwei that is about
0.05 ETH, at 20 gwei about 0.95 ETH; on a quiet day Sepolia's gas price is far below 1 gwei. The rehearsal prints the figure
for the day you run it: fund the deployer with that plus a margin from a Sepolia faucet. Test ETH has no price.

**Gas on the live network is several times what the rehearsal shows (found 5 Nov 2026).** The rehearsal runs on a local fork
with older gas rules. On live Sepolia the node priced creating the treasury-mandate factory at about 76.7 million gas, against
about 13 million on the fork. A first real deploy with the script's plain settings ran every transaction out of gas and cost
about 0.046 ETH for nothing. What worked, at a total cost of 0.00034 ETH (Sepolia's base fee is a few wei, so a 1 gwei tip
is the whole cost; a tip of 0.001 gwei was included without delay):

```bash
SEPOLIA_FORGE_ARGS='--skip-simulation --slow --with-gas-price 3000000 --priority-gas-price 1000000' \
  scripts/sepolia-deploy.sh --broadcast
```

`--skip-simulation` uses the node's own gas estimate, `--slow` sends each transaction after the one before it is confirmed
(the later contracts need the earlier ones to exist), and the two price flags cap what the tool reserves up front.
Budget for this before a mainnet deploy: contract creation may cost several times what the local tests measure, and a
transaction may now ask for more than the old 16,777,216 cap. The deployed addresses are in
`contracts/deployments/dao-launch-kit-11155111.json`.

## 2. Host the server

The server is the existing relay, run from the Creaton stack in `deploy/compose` (its README, "Creaton", has the steps;
`.env.creaton.example` has the settings). The first pilot is invited: the stack is invite-only server-wide
(`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` in the bundle's `.env.example`), so people join only with an invite link an owner or
admin makes, and self-serve communities stay off (no `BUZZ_SELF_SERVE_COMMUNITY_DOMAIN`).
`docs/self-serve-communities.md` says what changes when that is lifted later.

It also needs the chain it checks passkey accounts against. Without these it refuses to link a passkey account to a
person:

```
BUZZ_EVM_AUTH=1
BUZZ_EVM_CHAIN_ID=11155111
BUZZ_EVM_RPC_URL=<your Sepolia node>
```

Serve it over HTTPS: passkeys need it. The server never holds a user's money and never needs a private key for the
testnet.

## 3. Build and host the web app

Every setting is read when the app is built, ends up in the page, and is public. The hosted path is the Creaton image:
put the settings in `deploy/compose/.env`, then `./run.sh build` and `./run.sh restart`. The image takes only the chain id,
the page's node, the contributor kit, the history start, the ZeroDev settings, the error report and release, and
`VITE_RELAY_URL` and `VITE_COMMUNITY_API_ORIGIN`; `web/scripts/check-deploy-env.mjs` stops a build whose settings do not fit
together. The rows marked **Optional** are not in the image: they need a build of your own (`pnpm build` in `web/`, with
`dist/` served from a static host or by the relay with `BUZZ_WEB_DIR`), and none of them is for the first pilot.

| Setting | Value for Sepolia | Needed for |
|---|---|---|
| `VITE_LAUNCHPAD_CHAIN_ID` | `11155111` | Everything on chain: the network the app reads and asks wallets to be on |
| `VITE_CHAIN_RPC_URL` | A Sepolia node meant for the page: a read-only key with a request limit, not the deployer's | Everything on chain. Without it a hosted page has no node at all (it never falls back to the visitor's own computer) |
| `VITE_CONTRIBUTOR_KITS` | `{"11155111":"<contributor-kit from the manifest>"}` | Starting contributor projects. Without it Start says "Contributor projects cannot be started on Sepolia yet" |
| `VITE_WORK_BOUNTIES` | `{"11155111":"<work-bounty from the manifest>"}` | **Optional.** "Put money behind this work area" on contributor projects (N1). Without it the Work tab shows no bounties |
| `VITE_OPEN_BOUNTIES` | `{"11155111":"<open-bounty from the manifest>"}` | **Optional.** "Put money behind this" under a post (N2). Without it a post page shows no bounties |
| `VITE_CREATE_TOKENS`, `VITE_CREATE_FAUCETS` | `{"11155111":"<create-token>"}`, `{"11155111":"<create-faucet>"}` | **Optional.** Test CREATE and the faucet that gives 1,000 a day (N6): offered as a reviewer bond, and staked in the court |
| `VITE_COURTS` | `{"11155111":"<court from the manifest>"}` | **Optional.** The court (N7): a Court page reached from Portfolio, and appeals on bounties on posts. Needs `VITE_CREATE_TOKENS` |
| `VITE_PAYOUTS_FACTORIES` | `{"11155111":"<payouts-factory from the manifest>"}` | **Optional, test networks only.** Contributor projects vote to pay holders a share of revenue (N10) |
| `VITE_REMIX_BONDS` | `{"11155111":"<remix-bonds from the manifest>"}` | **Optional, test networks only.** A remix's bond to its parent, decided by the court (N12). Needs `VITE_COURTS` |
| `VITE_HISTORY_FROM_BLOCKS` | `{"11155111":<the manifest's "block">}` | Reading awards, work and votes: a real node refuses an event read that starts at block 0 |
| `VITE_DAO_LAUNCH_KITS` | `{"11155111":"<launch-kit from the manifest>"}` | **Optional.** Test raises. Leave it out for the contributor-only first launch. The Creaton image is contributor-only anyway: it sets `VITE_CONTRIBUTOR_ONLY=1` itself, which hides every way to start a sale (D140); a build of your own without it shows the raise wizard, which saves drafts but cannot launch one. With it set, the contributor Start page also checks that both kits name the same summoner |
| `VITE_RELAY_URL` | `wss://<your relay>` | Only when the page is not served by the relay itself (it otherwise talks to its own origin) |
| `VITE_COMMUNITY_API_ORIGIN` | `https://<your relay>` | Only when communities live on several hosts (see `docs/self-serve-communities.md`) |
| `VITE_ZERODEV_PROJECT_ID` (the project's UUID), `VITE_ZERODEV_CHAIN_ID=11155111` (and `VITE_ZERODEV_API_KEY` if the project has one) | A ZeroDev project on Sepolia, with a gas policy that sponsors every operation (each project's contracts are made when it starts, so a list of addresses cannot cover them) and a spending limit | Passkey accounts, with gas paid by its paymaster: testers then need no test ETH at all. **Required by the hosted image** when contributor projects are on (its people have no wallet to fall back on). In a build of your own, without them people bring a wallet and pay their own test gas. Passkey steps send through ZeroDev's own address for the project; `VITE_BUNDLER_URL` is not used by them |
| `VITE_ERROR_REPORT_URL`, `VITE_APP_RELEASE` | Your collector and the build's version | Error reports (`docs/error-reporting.md`); the pilot wants them. The image defaults the release to the source revision |

Leave these **unset** on Sepolia: `VITE_ENABLE_MAINNET` (it would offer real networks and hide the Testnet tag),
`VITE_LOCAL_USDC` (a local chain's test currency; Sepolia's Circle USDC is built in), `VITE_LBAMM_ADDRESSES` (no exchange there),
`VITE_PRICE_INDEXER_URL` (no market to price). (Both settings were removed in D150, see tag `pre-deprecation-2026-10-31`.)

The deploy script prints these with the real addresses, the pilot's first, ready to paste into `deploy/compose/.env`.
Where a value is yours to fill in it prints `CHANGE_ME_...`: `run.sh build` refuses one left in a `VITE_*` line (so does
the image's own check), and `run.sh start` refuses one anywhere. It adds the server's `BUZZ_EVM_*` lines from section 2. The contributor pilot, what the hosted image takes:

```
VITE_LAUNCHPAD_CHAIN_ID=11155111
VITE_CHAIN_RPC_URL=<a read-only Sepolia node for the page>
VITE_CONTRIBUTOR_KITS={"11155111":"<contributor-kit>"}
VITE_HISTORY_FROM_BLOCKS={"11155111":<block>}
VITE_ZERODEV_PROJECT_ID=<your ZeroDev project>
VITE_ZERODEV_CHAIN_ID=11155111
VITE_ERROR_REPORT_URL=<your collector>
VITE_APP_RELEASE=<the build's version; the image defaults to the source revision>
```

Not for the first pilot, and not in the hosted image (a build of your own). The deploy prints these only when run with
`--broadcast --optional`; otherwise the addresses are in the manifest's roles:

```
VITE_DAO_LAUNCH_KITS={"11155111":"<launch-kit>"}
VITE_WORK_BOUNTIES={"11155111":"<work-bounty>"}
VITE_OPEN_BOUNTIES={"11155111":"<open-bounty>"}
VITE_CREATE_TOKENS={"11155111":"<create-token>"}
VITE_CREATE_FAUCETS={"11155111":"<create-faucet>"}
VITE_COURTS={"11155111":"<court>"}
VITE_PAYOUTS_FACTORIES={"11155111":"<payouts-factory>"}
VITE_REMIX_BONDS={"11155111":"<remix-bonds>"}
```

`VITE_HISTORY_FROM_BLOCKS` matters. Every event read starts at the block the kits were deployed (every contract the app reads
was made after that), from its first request. A real node refuses a read that covers too many blocks ("exceed maximum block
range", usually over 10,000 to 50,000 blocks), and then the app reads in pages from that block. Without it a read on Sepolia
would start at block 0 and need thousands of pages; the app stops after a bounded number, and the hosted build refuses to
build without it. The fork journey found this: before the fix, the My bids tab on a Sepolia fork said "Could not read
bids: exceed maximum block range: 50000".

The page's node still has to allow a wide range. A read takes at most 120 requests, each as wide as the node allows (10,000
blocks when it names no limit), from the history start to the head. Sepolia makes about 7,200 blocks a day, so at 10,000
blocks a request reads keep working for about five months after the deploy, at 1,000 for about 17 days, and then fail.
Check a node before choosing it, with the request the app sends first (from the deploy block in the manifest to the head):

```bash
cast logs --from-block <the manifest's "block"> --to-block latest --address <contributor-kit> --rpc-url "$NODE"
```

An answer (even an empty one) within a few seconds is fine. An error about the block range means the app will read in pages:
then check one page as wide as the node allows (`--from-block $(( $(cast block-number --rpc-url "$NODE") - 10000 ))`), and
work out from the paragraph above how long that lasts. A timeout means the node is too slow for the page.

The node's request limit matters as much as its range. A project page sends a dozen or more reads when it opens; a node that
answers "rate limit exceeded" or HTTP 429 is asked again twice, after a short pause, and then the page says "The chain node is
busy. Try again in a minute" (a busy node is never read in smaller pages, which would only ask it more often). Pick a limit that
covers every participant opening pages at once, and watch the error reports for `chain-busy` notes during the run.

The command line (`buzz`) and the desktop app read their own event history and have not been given the same page-splitting;
testers should use the web app on Sepolia.

## 4. What testers need

**Contributor projects need no test USDC.** A claim asks for no money and an award is paid in Shares. Every contributor
step works from a passkey account whose fees the ZeroDev paymaster covers (D139), so on a sponsored project nobody needs
test ETH or a browser wallet. Someone who acts from a browser wallet instead pays their own test gas. Measured on a
Sepolia fork for one whole project (start it, one claim, two approvals, one award vote), which is also what the gas
policy has to cover:

| Who | Transactions | Gas | At 20 gwei |
|---|---|---|---|
| Founder (starts it, takes the claim on, finishes it, opens, backs, starts and runs the award vote) | 7 | 6,780,006 | 0.14 ETH |
| Contributor (files the claim, states its check, takes it once approved) | 3 | 217,909 | 0.004 ETH |
| Each reviewer (one approval) | 1 | about 100,000 | 0.002 ETH |

At Sepolia's gas price on 2026-10-21 all of it cost practically nothing, so for someone on a browser wallet one faucet
visit covers a founder unless gas rises to several gwei.

For test raises, if the build offers them:

- **Sepolia ETH** for gas, from any faucet: raise steps keep the browser wallet, which pays its own gas (D139).
- **Circle test USDC** from Circle's faucet (faucet.circle.com, pick Ethereum Sepolia). Circle's USDC has no open mint, which is
  why the local tests write balances into a fork instead.

And a short note saying what to try: join with your invite link, start a contributor project from Start (name two or more reviewers other
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
scripts/web-contributor-e2e.sh --sepolia-fork      # a contributor project in pages on a fork (its build also turns on the optional features)
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
