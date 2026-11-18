# Secondary weekly listing — candidate design

Status: development candidate on `v5-governance-rework`, written 2026-11-02 from the
implementation handoff of 2026-11-01 and its review. The user authorized implementation
of all phases; the initial specification-only restriction was an orchestration
mistake, not a user decision. Design review precedes implementation and tests, then
independent review precedes any real-value activation. Not for real-value use.
Activation requires the independent security
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
| new award, or the founder and creation-time holders | new award starts its own delay; founder and creation-time holders are fully mature from birth |
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

## Development implementation choices (proposed parameters, not production terms)

- A new per-DAO `SecondaryMarket` and its creation-bound factory, rather than
  presenting the D179-vulnerable `WeeklyRounds` as fixed. No funding, minting,
  DAO-inventory offer, or arbitrary-token `claimAndLeave` entrypoint exists in
  the candidate. A holder first collects Shares, then uses the actual DAO exit.
- The new kit is the factory's only creator/registrar. Actual pinned Summoner,
  policy, Shares clone identities and the shared mandate-factory binding are
  checked at creation. Mutually consistent untrusted getters are not provenance.
  `mandateFactory.daos` maps **mandates**, not DAOs; it is not a DAO registry.
- The market is the creation-bound transfer-exempt endpoint. Stopping new
  trading or clearing `exitExchange` must never stop claims, unsold returns,
  or refunds. Neither a replacement market nor a permissive general operator
  gets authority to move unrelated wallets' Shares.
- Candidate fee: **zero**. Round terms freeze explicit quote prices per lot,
  grid steps, lot size and timing before orders. Orders use integer lots and
  quote base units per lot, avoiding an implicit percentage price or treasury
  floor. Filled quantities and refunds are exact integers; partial-fill
  remainders use a disclosed deterministic order. Bounds and loops are capped.
- Voting activation candidate: seven days, rounded up to the next daily epoch
  (seven to eight days, disclosed). A bounded eight-bucket history replaces a
  per-wallet age test. Founder bootstrap can govern at creation; subsequent
  awards and acquisitions mature independently. Support tracks currently
  eligible amounts, not raw balance that new purchases could substitute.
- Proposal snapshot is an explicit pair: ownership at the previous block,
  maturity cutoff at the proposal's opening epoch. The cutoff is frozen and
  used for both the voter amount and quorum denominator. Public previews name
  their epoch; no current-clock read silently changes an existing snapshot.
- Market deposits remove live support. Only recorded unsold units returned to
  their original seller can restore their original history. Sold-unit age
  credit is consumed; buyers always start fresh. These hooks are restricted to
  the creation-bound market and must conserve escrow quantities.
- Founder candidate: a creation-installed, irreversible transfer-only sale
  schedule, initially tested with zero cliff and 180-day linear release. This
  is **not a withdrawal lock**: burns/exits remain allowed. Sold eligible units
  do not reduce the outstanding locked quantity again. A burn may reduce it
  only by the locked amount actually consumed; tests must exclude double
  counting and later re-growth. This is described as sale eligibility, not
  conventional financial vesting or evidence of product readiness.
- Legacy ContributorKit instances, deployed token/policy code and their zero
  guard remain unchanged. Unsupported reads stay unknown. No migration system
  or extra primary-funding path is part of this work.
- Unattributed direct token deposits do not become an order or someone else's
  claim. The market never grants arbitrary approvals or pays liabilities from
  another market's balances. Any surplus recovery requires a separately
  specified, liability-safe path; no generic admin drain is added.

## Out of scope

Primary fundraising paths, guaranteed liquidity, universal person scores,
automatic equity valuation, additional speculative instruments.
