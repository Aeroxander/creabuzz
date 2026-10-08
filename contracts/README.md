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
  caps, accumulating). Stateful, so `validate` is callable only by the auction
  the owner binds once with `setAuction`.
- `src/hooks/TrustGatedHook.sol` — community-track gate (trustgraph score-root
  Merkle proofs, treasury-rotated roots).
- `src/AppTokenLBPInitializer.sol` — graduation handoff: pulls final clearing
  price / tokens sold / net raised, splits reserve (TokenMaster floor) vs
  treasury, records pool addresses once the apptoken deployment lands.
- `src/GraduationExecutor.sol` — apptoken graduation that actually moves the
  money (sweep + split + escrow + release; supersedes the initializer). Bound to
  exactly ONE auction (`bindAuction`, treasury, one-shot; ERC-20 or native ETH
  currency — `receive()` takes ETH from the bound auction only, `_pay` sends it
  for the zero currency); the reserve leaves only to the recorded pool, or back
  to the treasury after `reserveLockSeconds` (constructor arg, 1 day..365 days).
- `src/VerifierSet.sol` + `src/ClaimStake.sol` — C5 attestation tier: verifier
  panels with quorum (>= 1) and slashing, contributor stakes-to-claim with escrow
  that releases only on quorum attestation (the paper's "expert panels"
  tier; unlock is attestation, never a price TWAP). The treasury reserves each
  claim's payout per claim (`fund(claimId, amount)`); an objection quorum sends
  the stake and the claim's reserve to the treasury; `resolveFrozen` unwinds a
  frozen claim.
- `src/AllocationVoting.sol` — the DAO's one ballot (the patched Majeur governor
  delegates to it): movable Shares allocations, two lanes (treasury-scale, and
  bounded inside a funded mandate), support that must hold for a set time,
  free opposition. The DAO's own Shares are outside voting supply and out of
  the ragequit denominator. See `docs/token-voting-design.md`.
- `src/TreasuryMandate.sol` — a finite, DAO-approved budget of currency, of
  Shares, or both. Projects get an allowance inside it; claims are verified
  by `ClaimStake` + `VerifierSet`; approved work is awarded Shares up to the
  project's share allowance. A mandate with no currency is how a project
  that never raised rewards contributors.
- `src/DaoLaunchKit.sol` — launches a project into a DAO in one atomic
  transaction: the team's Shares minted straight to the team and held back by
  a `MilestoneLock`, a `GraduationExecutor` it runs, the DAO (via the
  Summoner), the sale on the canonical CCA, and the raise's payee set to the
  DAO. Needs the Shares implementation address (every DAO the Summoner makes
  clones one) so it can name the lock before the DAO exists. Built with solc 0.8.26
  (the CCA's pin), so the tests that exercise it deploy its artifact; set
  `REQUIRE_CONTRACT_ARTIFACTS=1` to make a missing artifact fail instead of
  skip.
- `src/MilestoneLock.sol` + `src/MilestoneBadge.sol` — the team's Shares are
  theirs to hold and vote with from the first block, but a milestone-tied part
  cannot be transferred or burned (so not sold and not ragequit) until that
  milestone is reached. A milestone is a work claim approved by a mandate's
  independent reviewers; `unlock` is permissionless and mints the founder a
  soulbound badge. The DAO can `forfeit` a departed founder's remaining
  tranches. The Shares contract exposes the lock as its `lockGuard` and is
  ERC-20C compatible (see `docs/token-voting-design.md`).
- `src/ShareVesting.sol` — time vesting. The launch kit no longer uses it
  (milestones replaced time); it remains for DAOs that want a plain schedule.
- `src/OrgAllowance.sol` — agent spend allowances that enforce where money
  moves: `spendTo` debits the ledger and pays from the treasury in one call
  (`spend` is advisory accounting only); spends may not name a future epoch.
- `src/OrgBinding.sol` — DAO binding records; only the first binder or the
  recorded DAO may rebind a root.

## Trust assumptions

Sharp edges that are deliberate, not oversights:

- A treasury that cannot receive ETH makes an ETH graduation revert atomically
  — the raise stays in the auction until the treasury can receive. Payouts are
  push-and-atomic by design; nothing lands half-paid.
- Force-sent ETH or ERC-20 is unrecoverable. Payouts are amount-exact against
  the recorded accounting, so value shoved in outside a recorded flow has no
  exit path.
- `OrgAllowance.spendTo` emits `SpentTo` only. It used to emit both `Spent` and
  `SpentTo` per debit, which double-counted for consumers summing both events;
  `Spent` is now the advisory `spend` record and `SpentTo` the one authoritative
  `spendTo` record.

## Pins

The submodule gitlinks are the source of truth; `foundry.lock` mirrors them
(`node scripts/check-foundry-lock.mjs` fails CI when they drift). Several pins
are commits on a default branch, not release tags:

| Dependency | Pin |
| --- | --- |
| `lib/continuous-clearing-auction` (CCA, factory v2 line) | `6c9e559` on `main` (no tag) |
| `lib/tm-tokenmaster` (TokenMaster) | `1eb66e2` on `main` (no tag) |
| `lib/creator-token-transfer-validator` | `59adb8b` on `main` (no tag) |
| `lib/creator-token-standards` | tag `v5.0.0` (`980a63b`) |
| `lib/forge-std` | tag `v1.16.2` (`bf647bd`) |
| `lib/majeur` | `7d7a36b` on `main` (no tag) |
| `lib/openzeppelin-contracts` | `08efabd` (no tag; the CCA also vendors its own copy) |
| `lib/zerodev-kernel`, `lib/zerodev-kernel-7579-plugins` | `f2a84a3` (`dev`), `332deed` (`master`) |

To bump one: update the submodule, then `foundry.lock`, then re-run
`forge test` (the interface pins in `test/PinnedInterfaces.t.sol` compare our
mirrored `src/CCA.sol` to the upstream sources).

## The desktop's embedded bytecode

The desktop deploys `GraduationExecutor` and `AllowlistHook` from creation
bytecode embedded in `desktop/src/features/launchpad/lib/graduationArtifact.ts`.
`foundry.toml` pins their compiler (`compilation_restrictions`, solc 0.8.26) so
the artifact is reproducible. After ANY change to either contract (or their
imports):

```bash
cd contracts && forge build
node ../scripts/regen-graduation-artifact.mjs   # rewrites the two constants
```

`graduationArtifact.test.mjs` byte-matches the constants against
`contracts/out` (it fails, rather than skips, when `REQUIRE_CONTRACT_ARTIFACTS=1`,
which the contracts CI lane sets).

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
