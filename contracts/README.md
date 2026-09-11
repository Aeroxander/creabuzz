# Launchpad contracts

Phase-1 money-plane skeleton for the DAO launchpad. No testnet/mainnet
deploys yet — this workspace compiles and unit-tests the launch-owned
surface that wraps upstream primitives:

- `src/CCA.sol` — minimal interfaces mirrored from
  `Uniswap/continuous-clearing-auction` (factory v2.1.0): graduation handoff
  (`lbpInitializationParams`), bid-gating hook (`IValidationHook`).
- `src/AuctionLauncher.sol` — parameter gate + onchain params commitment
  (floor, tick spacing, threshold, blocks, steps) before the CCA deploy.
- `src/hooks/AllowlistHook.sol` — curated-track gate (allowlist + per-wallet
  caps, accumulating).
- `src/hooks/TrustGatedHook.sol` — community-track gate (trustgraph score-root
  Merkle proofs, treasury-rotated roots).
- `src/AppTokenLBPInitializer.sol` — graduation handoff: pulls final clearing
  price / tokens sold / net raised, splits reserve (TokenMaster floor) vs
  treasury, records pool addresses once the apptoken deployment lands.

Pinned: CCA (factory v2.1.0), majeur, TokenMaster v1.0.1,
Transfer Validator, creator-token-standards, OpenZeppelin.

## Minting (apptoken, local)

One command mints a Standard-pool apptoken (ERC-20C, native pairing, Vanilla
validator ruleset, initial supply to treasury):

```bash
./target/debug/buzz launchpad mint-token --name 'Nebula' --symbol NEB \
  --supply 1000000 --treasury 0x... --rpc-url http://127.0.0.1:8545 \
  --contracts-dir contracts
```

Needs the apptoken-dev environment on Anvil (`:8545`, chain 1776411) plus a
one-time dev-only allowlist patch — the packaged env allowlists phantom
factory addresses, so the real Standard/Stable/Promo factories must be
enabled via storage surgery on the router (`allowedTokenFactory`, slot 1;
see plan §16). Never on mainnet: real chains use the governed admin.

Next: majeur summon path for graduation, LBAMM secondary pool via
apptoken-skills generators observing `Graduated`.

```bash
forge build
forge test
```
