# Governance refinement: evidence and limits

> **Superseded 2026-10-08.** The voting rule this document describes (accruing conviction against bars set as a
> fraction of all Shares) was replaced after review: see [the current design](../token-voting-design.md), [the voting-rules
> study](voting-v2-study.md) and [the review](../v3-review/PLAN.md). Kept as the record of why.

Local development study, 2026-10-08. The goal is a DAO that can choose priorities,
authorize finite budgets, execute work and verify results with one voting design.
This is a tested candidate, without a production deployment or security audit.

## What the study changed

1. **Retired voting credits.** In the depleted-majority example, a minority holding
   300 unused credits defeats 700 active voters who recover only 200 credits in
   48 hours. Movable Shares allocations let those voters change priorities without
   a refill penalty. All-in support is a deliberate allocation choice.
2. **Current backing remains necessary.** Waiting cannot turn a 30% coalition into
   unrestricted treasury authority. Unrestricted actions need a current majority
   of the captured Shares supply. Loot has economics, without governance capacity.
3. **Removed historical opposition as a second veto.** An earlier candidate made
   matured FOR beat matured AGAINST. A late 50.1% majority facing older 49.9%
   opposition needed another 95 hours at a 12-hour half-life. Current opposition
   plus the FOR conviction floor needs 12 hours. The final candidate counts
   AGAINST immediately in current backing; accumulated opposition is context.
4. **Separated commitments from every invoice.** A majority can authorize and
   atomically fund a finite mandate. Projects inside that mandate can use lower
   captured floors; managers reserve milestones and reviewers control payouts.
   Returning money never refills lifetime authority. A majority can close a mandate
   and recover unreserved funds early.
5. **Fixed precision and deployment boundaries.** Conviction retains fractional
   Shares wei, including after supply falls to one wei. The governor originally
   exceeded the EVM code limit; removing disabled futarchy resolution/cash-out
   code brought it within the limit while preserving the additive upstream fork.

## Mechanism model

Run from the repository root:

```sh
. ./bin/activate-hermit
node scripts/simulate-dao-governance.mjs
```

[The mechanism study](governance-mechanism-study.md) and its
[JSON data](governance-mechanism-study.json) contain eleven asserted scenarios,
16,000 seeded participation trials, and a late-majority timing comparison.
The seed is 20261008. Trials assume fixed Shares supply of 1,000, fifteen wallets
with specified holdings, independent participation probabilities, and 80%
conditional support. Wallets are simulated actors, not verified distinct people.

For steady support, the 48-hour minimum review dominates tested half-lives of
6, 12, 24 and 48 hours. The model therefore does not establish 12 hours as optimal.
A shorter half-life matters after support arrives or changes. Low participation
still prevents a current majority: shorter decay cannot repair missing backing.
The 24-hour execution delay is additional to all reported approval times.

A 60% owner remains controlling under linear Shares capacity. Exclusive
allocations force choices across simultaneous proposals; ordinary reusable token
ballots would let that same capacity support every priority at once. These are
tradeoffs, not evidence that concentrated ownership has become decentralized.

## Actual contracts on a local EVM

Run from `contracts/`:

```sh
. /Volumes/ExternalSSD/Applications/creabuzz/bin/activate-hermit
forge test --match-path test/DaoGovernanceJourney.t.sol -vv
```

The journey deploys the actual patched Majeur, Shares, Loot, policy, treasury
mandate factory, mandate, verifier panel and claim escrow. Initial capital and
elapsed time are simulated. After bootstrap settings, all investment issuance,
mandate creation, project approval and contribution awards use the governor.
It is a local Foundry EVM execution, without a live network or public deployment.

The reproducible journey uses these actors:

| Actor | Initial Shares | Role |
| --- | --- | --- |
| Founder | 400 | Proposes and reviews |
| Team | 200 | Manages the approved project |
| Member | 100 | Participates and independently reviews |
| Hostile coalition | 300 | Tries unrestricted withdrawal and self-payment |
| Investor/contributor | 0 | Buys Loot, delivers work and earns Shares |

| Observed stage | Contract outcome |
| --- | --- |
| Treasury starts at 100,000 currency units | Local ERC-20 capital fixture |
| Investor pays 1,000 for 100 Loot | Treasury 101,000; investor has economics and zero voting capacity |
| Coalition allocates 300 Shares to a 90,000 withdrawal | Unrestricted approval fails |
| Other 700 Shares split evenly across two priorities | Neither unrestricted action passes |
| Members redirect 700 to a 10,000 mandate | After review and timelock, mandate receives exactly 10,000; factory approval cleared |
| 250 Shares approve a 2,000 project | Authenticated bounded operation passes after 24-hour review and 24-hour delay |
| Team reserves a 1,400 milestone | No new treasury ballot; check locked and project reservation enforced |
| Contributor tries self-attestation | Rejected even though contributor is an appointed reviewer |
| Two other reviewers approve | Payout waits through the three-day challenge window |
| Contributor claims payout | 1,400 payment plus return of 50 stake |
| Coalition gets a bounded 2,000 project, submits a self-payment | Two reviewers object; payment rejected and 10 stake slashed back to mandate |
| Refund arrives | Lifetime allocated authority remains 4,000 |
| DAO consumes the paid delivery proof | Converts 10 Loot to Shares once; future voting standing gained |
| Contributor exits 20 Loot | Proportional share of DAO-held currency returned; 10 Shares still confer standing |
| Mandate expires | Unreserved 8,610 returned, including slashed stake |

The sequential governance/delivery fixture takes 384 simulated hours (16 days).
It includes three unrestricted review/delay cycles, two project cycles, and one
three-day claim challenge. It assumes delivery itself takes zero time. These
figures measure rules and sequencing, not real workforce productivity.

The test writes `contracts/deployments/governance-dao-journey.json`; a copy of
its [observed output](governance-dao-journey.json) is retained beside this report.
The mock currency uses 18 decimals. Its nominal units are not market quotes or
proof of compatibility with every stablecoin or native sale price convention.

## Validation

The contract suite exercises real casting, cancellation, transfer/burn hooks,
delegation, historical snapshots, contribution conversion, native ragequit,
authenticated bounded classification, reservations, recusal, challenge, queue
invalidation, terminal release, and constructor/runtime code limits. Stateful
invariants cover 256 runs of 500 generated actions each per invariant: 256,000
actions across allocation, transfer, delegation, time and queueing. Caught or
skipped expected actions are counted; the reported invariant runs have zero
reverting handler calls. Fuzz tests include fractional conviction after tiny supply
and proportional withdrawal.

Web and desktop helper tests pin ABI selectors and exact units. Browser exercises
use the actual React proposal flows with mocked wallet/RPC or Tauri boundaries:
chosen allocation, reallocation, withdrawal despite invalid amount input,
delegation, read recovery, queued voting, and execution after delay. Contract
journeys provide separate implementation evidence; browser mocks do not prove
network, wallet hardware, gas pricing or production RPC reliability.

Final focused checks:

| Check | Result |
| --- | --- |
| Complete Foundry contract suite | 270 passed, zero failed, one RPC-dependent fork check skipped |
| Stateful invariants | Two invariants, 256,000 generated actions, zero reverting handler calls |
| Mechanism simulation | Eleven asserted scenarios and 16,000 seeded participation trials |
| Native governance script | Local simulation opened, voted, queued and executed the actual settings proposal |
| Majeur fork preservation | 55 marked regions; stripping them reproduces the vendored source exactly |
| Governor deployment | 24,263-byte runtime; constructor and runtime size limits exercised |
| Web helper tests | 26 passed |
| Desktop helper tests | 31 passed |
| CLI governance tests | Six passed |
| Web browser workflows | Four passed |
| Desktop browser workflow | One passed, with the E2E Tauri bridge |
| Client compilation | Web production build and desktop E2E build/typecheck passed |
| Formatting and patch checks | Focused Biome checks had no errors; desktop file-size and Git whitespace checks passed |

Repeat the contract and CLI checks from the repository root after activating
Hermit:

```sh
forge test --root contracts
forge script --root contracts contracts/script/JourneyGov.s.sol:JourneyGov
node scripts/check-majeur-fork.mjs
cargo test -p buzz-cli launchpad_gov
```

From `web/`, run the focused helpers and real React browser flow:

```sh
node --experimental-strip-types --test src/features/launchpad/lib/governance-send.test.mjs src/features/launchpad/lib/governance-view.test.mjs src/features/launchpad/lib/voting-allocation.test.mjs
pnpm test:e2e:smoke tests/e2e/voting-allocation.spec.ts
```

From `desktop/`, use the project's TypeScript loader and E2E build runner:

```sh
node --import ./test-loader.mjs --experimental-strip-types --test src/features/launchpad/lib/decisionRouting.test.mjs src/features/launchpad/lib/voteTx.test.mjs src/features/launchpad/lib/voting-allocation.test.mjs
pnpm test:e2e:smoke tests/e2e/launchpad.spec.ts --grep 'queued governance'
```

The repository's web file-size ratchet flags the existing unrelated
`web/src/features/wiki/ui/WikiView.tsx` at 1,040 lines against a 1,000-line limit.
That file is unchanged by this governance patch. No PR-readiness marker or human
runtime-test attestation has been added.

## Remaining boundaries

- A controlling Shares holder or governing coalition can authorize self-dealing,
  arbitrary ownership issuance or other execution permissions. Voting rules do
  not prove an action beneficial.
- Reviewer addresses can be controlled by the same person. Delivery remains a
  trust judgment; evidence hashes and recusal do not prove independence or truth.
- A lower-support coalition can waste a finite mandate's project authority. A
  majority can oppose pending projects or close the mandate; honest reviewers
  still determine whether reserved payments release.
- Native delegation conveys full source allocation authority. Relay grant scope,
  per-proposal cap and expiry are not enforced by the ballot contract.
- Ragequit covers DAO-held assets. Already committed mandate/claim currency is
  outside that liquid treasury, which is why notice and execution delay matter.
- Initialization trusts the chosen policy implementation. New constructor/ABI
  deployment requirements do not migrate existing DAOs. The contracts remain
  fixed at creation; project caps, reviewers and currency are immutable.
- Currency transfer behavior, issuer freezes/upgrades, public onchain data and
  RPC/indexer/frontend access remain dependencies. Claim escrow expects an
  ordinary exact-transfer ERC-20. Nothing runs automatically when time passes.

The product direction is consistent with community-owned authority, budgets and
receipts in `VISION_ORG.md`, and accountable work in `VISION_PROJECTS.md`.
The intentional constraint is at the opt-in capital boundary: Shares choose
resource commitments, while ordinary community discussion remains unmetered.
Independent security review and a limited-value pilot are still needed before
using the design for consequential treasury funds.
