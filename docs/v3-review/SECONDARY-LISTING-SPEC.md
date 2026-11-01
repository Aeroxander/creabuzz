# Secondary weekly listing — candidate design

Status: specification only on `v5-governance-rework`, written 2026-11-02 from the
implementation handoff of 2026-11-01 and its review. No implementation in this
phase beyond converting the D179 proofs into regression tests where the candidate
code exists. Not for real-value use. Activation requires the independent security
review of the actual scope and a jurisdiction-specific legal review of selling
Shares, plus an explicit human release decision that is never bundled with a
deployment. D179 remains the reason the current rounds stay off.

## Model

Build, earn or unlock ownership, then open a public secondary listing. Buyers pay
selling holders for existing units, apart from an explicitly chosen fee. No
primary funding or minting entrypoint is part of this mode, and no DAO inventory
sale is silently included. A secondary listing does not fund development and does
not guarantee a next buyer; the page says so.

## Scope rules

- Only existing eligible units are offered. Contributor awards and founder
  vested or unlocked sale eligibility are verified from supported contract state.
- The first public listing is a project decision with disclosed terms. The token
  exists before trading; sell eligibility and project readiness are separate
  questions (the two checks in the market-opening summary below).
- Buyers may acquire voting Shares and resell existing units in later rounds. Any
  restriction to weekly trading rather than unrestricted transfers is explained.
- The fee is simple, explicit and frozen for each round before orders are
  accepted. No mid-round fee changes against existing orders. The current 20%
  premium cut is not an approved default for this design.
- Show seller proceeds, where any fee goes, and the project's remaining
  resources. Explain weekly trading's limits honestly.

## D179 regression mapping (each proof becomes a regression before any real-value use)

| Finding | Regression |
|---|---|
| a fake DAO empties every round's escrow | round escrow isolated per DAO; counterfeit DAO rejected |
| fake funding terms hand out another DAO's escrowed Shares | terms bound to their DAO onchain |
| leaving with a booby-trapped token takes payouts owed to others | payout and callback accounting isolated per participant |
| an exchange switched off strands uncollected rounds | cancelled or replaced exchange recovery path |
| the lowest funding step cannot settle | settlement works at every step |
| 1 wei of ETH blocks funding settles | dust cannot wedge settlement |

Repair versus replacement of `WeeklyRounds` is decided by design review on
evidence, not by which is smaller. Removing the legitimate funding UI is not a
fix: the contract entrypoints and shared-escrow exposure remain. Cross-market
isolation, settlement and refunds, token and DAO identity, and callback tokens
are tested in the candidate code.

## Pricing and settlement

- Explicit minimum and maximum prices per round with honest clearing and refund
  rules.
- Empty-treasury pricing is fixed in this design; no guaranteed treasury floor is
  promised.

## Voting activation (per acquired amount)

Newly acquired amounts age independently. Wallet age, average holding age and
seller age never confer eligibility; delegation, repeated buying and selling, and
escrow handling cannot bypass the delay.

| Event | Treatment (candidate) |
|---|---|
| secondary purchase | starts its own activation delay |
| new award or founder bootstrap | starts its own delay from issuance |
| unsold escrow return | keeps its prior age when returned to its original holder |
| sale claim or partial transfer | each acquired amount keeps or starts age explicitly |
| cancellation | no eligibility created |

Voting eligibility and quorum supply stay consistent at proposal snapshots;
temporarily ineligible supply must not immobilize governance. Existing
ownership-bound live support, support-hold periods and execution delays remain:
leaving removes support before execution. A holding period delays capture; it
does not stop a patient majority. A post-vote ragequit lock is a separate
decision and does not enter through "voting delay". Financial exit and evidence
access rights stay intact.

## Founder eligibility

Founder vesting needs a supported kit version that installs its terms at
creation. Existing contributor DAOs with the finalized zero lock guard keep being
described honestly; no UI label simulates an onchain lock. Any migration is an
explicit proposal that preserves existing rights; no broad migration system
without an actual need.

## Market-opening summary (reuses the project story)

Delivered artifacts; actual review and check evidence; current user
observations; founder locks and seller concentration; future issuance; voting
activation; treasury, payout and exit rights; the continuation plan. Missing
facts show as "not recorded yet". Readiness is never inferred from elapsed
vesting, award counts, AI approval or token price. The summary communicates
readiness; it does not create it.

## Activation gates

1. This spec's open parameters resolved and recorded: fee rule, activation
   duration, sale-eligibility edge cases.
2. The D179 regressions pass against the candidate code.
3. Independent security review of the actual scope, and a jurisdiction-specific
   legal review of selling Shares. Classification is case by case on the token's
   rights and the transaction structure; "secondary" creates no exemption.
4. An explicit human release decision. Trading activation is never bundled with
   a deployment.

## Out of scope

Primary fundraising paths, guaranteed liquidity, universal person scores,
automatic equity valuation, additional speculative instruments.
