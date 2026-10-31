# LBAMM and apptokens: what was read, what it means for Creaton

> **Removed in D150** (2026-10-31): the LBAMM market and price stack (Markets page, market decisions, trade card, price chart and indexer, `VITE_LBAMM_ADDRESSES`, `VITE_PRICE_INDEXER_URL`, the market scripts and specs) is gone from the tree; see tag `pre-deprecation-2026-10-31`.

> **History (noted 2026-10-23).** Background reading for a market venue. No market is planned for contributor projects or the first raises (D77, [CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md)); LBAMM stays evaluation-only.

Read on 2026-10-08 from two repositories cloned into a scratch directory outside this repo (never copied in):

| Repo | Commit | What it is |
|---|---|---|
| `limitbreakinc/lbamm-core` | `05e8973` ("Audit Release") | the AMM, its modules and its hook interfaces |
| `limitbreakinc/lbamm-examples` | `c5557f6` ("Initial Examples") | three example launches on a local Anvil devnet |

Every statement below was checked against that source. Where a statement is a design choice of ours, it says so.

## Constraints that shape everything

- **Production uses Limit Break's live protocol (you, 2026-10-13).** We never deploy LBAMM ourselves, so the licence below only
  limits dev testing and keeping its source out of this repository. I have not verified that it is live or on which
  chains, or Limit Break's terms for using their deployment commercially: check both before launch.
- **Evaluation only (the code we run locally).** The core README says: "You must not deploy this code to mainnet or production systems", and that
  building proof-of-concept integrations in local environments is permitted while launching public markets is not.
  Eighteen source files carry `LicenseRef-PolyForm-Strict-1.0.0` and seven carry MIT. So: a local PoC is fine, and
  nothing from LBAMM goes into this (public) repository or onto a live network. We are not going live yet, so this
  costs us nothing today; it does mean "LBAMM is the venue" is a bet on its release.
- **It stays outside this repository.** The scripts that run it (`scripts/lib/lbamm-world.sh`) take `LBAMM_DIR`, a clone
  of `limitbreakinc/lbamm-examples` made with `--recurse-submodules` (the pool types, hooks, secure-proxy and
  apptoken-dev come with it), and refuse a directory inside this repo. What this repo holds are our own calls into its
  deployed contracts: ABI encoding written by hand and pinned to `cast`, and the event signatures the indexer reads.

## Running it locally

```bash
git clone --recurse-submodules https://github.com/limitbreakinc/lbamm-examples.git /somewhere/outside/this/repo
export LBAMM_DIR=/somewhere/outside/this/repo/lbamm-examples

scripts/cli-market-e2e.sh        # the DAO votes a market; a buyer trades; a locked founder cannot; the fee reaches the treasury
scripts/market-index-e2e.sh      # the price indexer turns those trades into candles
scripts/web-market-e2e.sh        # the app's chart and $TICKER chip show them
```

Each script boots its own throwaway chain with our contracts and LBAMM on it, and cleans up after itself.

## How a token plugs into LBAMM (verified)

- **Token settings are global per token**, not per pool: `setTokenSettings(token, tokenHook, packedSettings)` stores one
  hook address and a bit-packed word for that token (`ModuleAdmin.sol`). Bits 0-9 are hook flags: before swap, after
  swap, add liquidity, remove liquidity, collect fees, pool creation, hook manages fees, flash loans, flash-loan fee
  validation, handler-order validation. Bit 10 is "require executor pays". The hook declares which flags it
  requires and supports (`hookFlags()`), and `setTokenSettings` reverts if they do not match.
- **Who may set them:** the token itself, the token's `owner()`, a holder of the token's `DEFAULT_ADMIN_ROLE`, or a holder
  of LBAMM's token-setting manager role (`LibOwnership.requireCallerIsTokenOrContractOwnerOrAdminOrRole`). The same
  check guards `collectHookFeesByToken`, which lets the token's side collect the fees its hook charged.
- **Our Shares already satisfy this:** `Shares.owner()` is the DAO (the ERC-20C work), so only a DAO vote can set the
  hook, change it, or collect its fees. Nothing else needs to be built for that part.
- **The token hook interface** (`ILimitBreakAMMTokenHook`) has `validatePoolCreation`, `beforeSwap`, `afterSwap`,
  `validateHandlerOrder`, `validateCollectFees`, `validateAddLiquidity`, `validateRemoveLiquidity`, flash-loan hooks and a
  manifest URI. A swap's hook context names the caller (the executor), which is what an access rule (such as "needs a
  badge") would read.

## What the two examples show

- **Trading tax token** (`examples/trading-tax-token`): an ERC-20C token whose Transfer Validator V5 ruleset is
  Whitelist with only LBAMM whitelisted and OTC disabled, so the token can move only through LBAMM swaps; a 10% fee on
  the paired token on both buys and sells through LBAMM's standard hook; a dynamic-price pool with single-sided
  liquidity seeded from the starting price upward. This is the enforced-royalty shape.
- **NFT-gated trading** (`examples/nft-gated-trading`): an ERC-20C token with a custom token hook that requires traders,
  pool creators and liquidity providers to hold an NFT from a given collection. This is the closest thing to "you can
  sell only if you hold the milestone NFT".

## What this means for the milestone lock (our design)

The user's goal: founders hold and vote with their Shares from the first block, cannot sell them, and cannot ragequit
them, until a milestone unlocks a given part.

- **The lock is enforced in the Shares contract itself**, not in an AMM hook. A hook only sees trades that go through
  one venue; a lock in `Shares` also stops a wallet-to-wallet transfer and a ragequit, which no venue sees. This is why
  the milestone lock does not depend on LBAMM at all (and is verified on a plain local chain).
- **The badge is the receipt, not the key.** Unlocking is decided by the lock reading a reviewed claim; the
  `MilestoneBadge` is minted when it happens. A hook that reads `badge.balanceOf(trader)` (the NFT-gated example's
  shape) is therefore available later for *other* perks (priority access, fee tiers) without being load-bearing for safety.
- **Why not "the NFT is the key":** a transferable or loseable NFT as the thing that releases Shares can be sold or
  lost; a lock that reads the claim cannot.

## What is built on top of it

- **A DAO votes its Shares onto the AMM** (`buzz launchpad market seed`): one batch that keeps the AMM's Shares out of
  the voting supply, names the standard hook as the Shares' hook, sets the hook's fee on the paired currency (default
  1% on every buy and sell), approves the AMM, creates a dynamic-price pool and seeds it **with Shares only**, from the
  starting price upward. The DAO needs no currency to start a market; it sells into demand as the price rises.
- **The lock still binds inside the pool.** A founder whose Shares the milestone lock holds cannot sell them into the
  pool (the Shares refuse the transfer); a holder with free Shares can, with the same command.
- **The hook's fee reaches the treasury by a second vote** (`market collect-fees`): the token's side is the DAO, so only a
  DAO vote can collect it.
- **`market swap`** trades in a pool from the command line (agents included).
- **A price indexer** (`services/price-indexer`, Ponder) turns the AMM's `PoolCreated` and `Swap` events into candles,
  and the app charts them and shows the last trade next to a `$TICKER` (see `services/price-indexer/README.md`).

## Open design points

1. **Graduation does not seed the market by itself.** After a raise graduates, the DAO votes the market in (above). That
   keeps LBAMM-specific code out of the contracts we would one day ship, and keeps the decision (how many Shares, what
   price, what fee) with the DAO; the cost is one more vote. An automatic step would have to be a separate contract
   that knows the AMM, and should wait until the AMM is releasable.
2. **Whitelist-only trading is not exercised yet.** With the Whitelist ruleset the token cannot move between wallets at
   all, so the CCA auction contract, the graduation executor and the DAO would each need to be whitelisted, and the
   list's id is only known after it is created: that is a two-vote sequence. Today the Shares have no validator
   (transfers are free) and the milestone lock is the only restriction. `Shares.setTransferValidator` is DAO-only, and
   the validator itself is verified against our Shares in `scripts/shares-erc20c-e2e.sh`.
3. **The starting price is an input.** It is not read from the sale's clearing price; the DAO states it (rounded to the
   nearest price step, 1% at the default step). Reading the clearing price into the vote is a small follow-up.
4. **No web composer for the market vote.** Like the other DAO votes it is a command-line step for now.
5. **Prices include fees.** The indexer records the price a swap actually got, which includes the pool's fee and the hook's
   fee on the paired currency. A pool-price feed would need the pool's state, which the swap event does not carry.

## Verified locally in this repo (without LBAMM)

- Shares reports the ERC-20C creator-token interface and works with the real Limit Break validator V5 on a dev chain
  (`scripts/shares-erc20c-e2e.sh`).
- The milestone lock refuses transfers and ragequit of locked Shares, frees exactly a milestone's part when its reviewed
  claim exists, and mints a soulbound badge (`scripts/cli-milestone-e2e.sh`, `scripts/web-milestone-e2e.sh`).

## Checked against Limit Break's published docs (2026-10-15)

Read from [apptokens.com](https://apptokens.com/docs/integration-guide/overview): the overview, the
[LBAMM contract registry](https://apptokens.com/docs/integration-guide/limit-break-amm/reference/contract-registry), the
[LBAMM security model](https://apptokens.com/docs/integration-guide/limit-break-amm/security-model), the
[validator deployments](https://apptokens.com/docs/integration-guide/creator-token-standards/v2/contract-deployments) and both cookbooks.

**LBAMM has no production deployment to switch to yet.** The registry lists every LBAMM contract (core, the four pool
types, the transfer handlers, the hook registry and the standard hook) as `NOT_DEPLOYED`, with no chains. It says all
contracts "are deployed to the same address across supported chains", which is the plan and not yet a fact we can pin. The
docs call LBAMM pre-release and say to "verify the exact repository commit before building production integrations". The
security model says independent audits were done, but the audit entries are unfilled placeholders (no auditor, date or
scope), and it does not say who can upgrade or pause anything. Treat "audited, deployed, same hash everywhere" as something
to confirm with Limit Break, not something the docs show. These pages may be stale.

**The AppToken side is live.** The validator page lists one address on Ethereum, Base, Optimism, Arbitrum One, Polygon,
Polygon zkEVM, Avalanche C-Chain, BSC and Sepolia: `0x721C00182a990771244d7A71B9FA2ea789A3b433` (titled V2). The
overview lists a "v4" validator at `0x721C002B0059009a671D00aD1700c9748146cd1B` and a TokenMaster router at
`0x0E00009d00d1000069ed00A908e00081F5006008`, without naming chains. Our local tests use validator V5, so which version
the Shares target, and its address per chain, has to be pinned and checked.

**What this means for the plan**
- Build to a per-chain registry whose LBAMM entries stay empty until Limit Break publishes them. The app offers a market vote
  only when the address has code and its codehash matches the pinned one; otherwise it says "unverified".
- Until then a launch works without a market: the raise graduates into the treasury and ragequit is the exit. Nothing about the
  milestone lock, the claims or the treasury depends on LBAMM.
- Test against a fork of a chain where it is deployed once it is, not against a local clone; the source stays out of this repo.

**Cookbook ideas worth using later** (hook-level, so they need a hook and no new core contract): hold-time fee decay
(AMM recipe 2: 5% under a day, 2% under a week, 0.5% after), fee tiers by who the trader is (recipe 5), perks gated on
holding a badge, such as our `MilestoneBadge` (recipe 14), a DAO-curated list of who may create pools (recipe 23), and LP fee
sharing with the hook's builder (recipe 24: 0.4% to LPs, 0.1% to the developer in the example). The AppToken cookbook has
token-layer vesting (recipe 12), task-gated use (recipe 2) and backed tokens redeemable for ETH (recipe 20). Nothing in
either cookbook covers reviewer stakes or bonds, sell-rate caps, or a "pair token".

**What is on Sepolia (read-only check of the public node, 2026-10-15).** Present: Uniswap's CCA factory
(`0x000000001F26a0044BaA66024e7b6599c61963F8`), Permit2, the Majeur Summoner and SafeSummoner at their canonical addresses (not Tribute or
ShareSale), Circle's USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`), Limit Break's validator (both the address on the V2 page and the one
in the overview) and TokenMaster router, and our own passkey-account factory. Not there, and ours to deploy: our patched Majeur summoner and
Shares implementation (the lock guard is ours) and the launch kit. Not there and not ours to deploy: LBAMM, which the registry lists as
not deployed and whose README rules out live-network use. So a hosted Sepolia test can run a whole launch, sale, milestone and paid-work story without
a market, and LBAMM stays on a local fork (allowed) until Limit Break publishes or permits a deployment. Forge's fork test already reads
`SEPOLIA_RPC_URL` (`contracts/foundry.toml`): keep the URL in `.env`, never in the repo.

