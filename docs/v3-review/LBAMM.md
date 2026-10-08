# LBAMM and apptokens: what was read, what it means for Creaton

Read on 2026-10-08 from two repositories cloned into a scratch directory outside this repo (never copied in):

| Repo | Commit | What it is |
|---|---|---|
| `limitbreakinc/lbamm-core` | `05e8973` ("Audit Release") | the AMM, its modules and its hook interfaces |
| `limitbreakinc/lbamm-examples` | `c5557f6` ("Initial Examples") | three example launches on a local Anvil devnet |

Every statement below was checked against that source. Where a statement is a design choice of ours, it says so.

## Constraints that shape everything

- **Evaluation only.** The core README says: "You must not deploy this code to mainnet or production systems", and that
  building proof-of-concept integrations in local environments is permitted while launching public markets is not.
  Eighteen source files carry `LicenseRef-PolyForm-Strict-1.0.0` and seven carry MIT. So: a local PoC is fine, and
  nothing from LBAMM goes into this (public) repository or onto a live network. We are not going live yet, so this
  costs us nothing today; it does mean "LBAMM is the venue" is a bet on its release.
- **A local deployment needs more than the two clones.** `lbamm-core` pulls `creator-token-transfer-validator`,
  `tm-core-lib`, `tm-role-server`, `wrapped-native` and `forge-std` (only some are populated in the clone), and the
  examples' devnet script deploys the pool types, hooks and secure-proxy contracts from further repositories. Cloning
  those is a separate download that needs your yes.

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

## Open design points before any LBAMM pool exists

1. **Whitelist-only trading is a strong choice.** With the Whitelist ruleset the token cannot move between wallets at all,
   so the CCA auction contract, the graduation executor and the DAO would each need to be whitelisted or the sale cannot
   pay out. Plan: ship Vanilla first (transfers free, the milestone lock still binds), and let the DAO vote the stricter
   ruleset in later. Setting the validator is `Shares.setTransferValidator`, a DAO-only call.
2. **There is no graduation step into LBAMM yet.** Today the raise settles into the DAO and the sale tokens go out
   through the auction. Creating a dynamic pool at the clearing price, seeding it, and setting the token hook is new
   work and needs the local deployment above.
3. **No price indexer yet.** Cashtag charts show the honest bid price today. A real chart needs LBAMM swap events indexed
   (Ponder is the intended tool); that needs the same local deployment to have events to index.

## Verified locally in this repo (no LBAMM involved)

- Shares reports the ERC-20C creator-token interface and works with the real Limit Break validator V5 on a dev chain
  (`scripts/shares-erc20c-e2e.sh`).
- The milestone lock refuses transfers and ragequit of locked Shares, frees exactly a milestone's part when its reviewed
  claim exists, and mints a soulbound badge (`scripts/cli-milestone-e2e.sh`, `scripts/web-milestone-e2e.sh`).
