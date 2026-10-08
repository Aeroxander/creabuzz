# Governance refinement and DAO simulation

> **Superseded 2026-10-08.** The voting rule this document describes (accruing conviction against bars set as a
> fraction of all Shares) was replaced after review: see [the current design](token-voting-design.md), [the voting-rules
> study](simulations/voting-v2-study.md) and [the review](v3-review/PLAN.md). Kept as the record of why.

Status: local implementation and validation complete, 2026-10-08. Evidence and
remaining limits are recorded in [the validation report](simulations/governance-validation.md).
This replaces the rechargeable
Shares + Loot policy. Neither the old allowance nor the replacement is approved
for production funds solely because its tests pass.

## Product requirements

- One governor and one authoritative ballot path for every executable proposal.
- Shares confer governance standing; Loot retains economic rights without votes.
- Owners choose how much of their Shares to allocate across competing proposals.
  Allocations can be changed or withdrawn before execution, including during the
  timelock. Voting never consumes ownership or creates a refill balance.
- Support acquires conviction; opposition is explicit. A proposal needs both
  current support and accumulated support. Withdrawn support cannot execute an
  old proposal, and conviction cannot be carried into a new allocation.
- Holding alone preserves eligibility. Contribution awards and 1:1 Loot-to-Shares
  conversion use the same governor. No reward for voting frequency.
- Delegates use the owner's allocations. Transfers and economic exits reduce
  allocations atomically, preserve treasury ownership accounting, and cannot
  produce two active claims on the same voting stake.
- A team can execute a bounded, approved project mandate without a new ballot
  for each invoice. Payments use the existing milestone reservation, independent
  attestation, claimant recusal and challenge-window contracts.
- Budgets and delegation limits advertised to users must be enforced onchain.
  Public votes, ownership and attestations remain observable; verified delivery
  depends on the DAO-appointed reviewers, who can collude.
- Web, desktop and CLI must expose allocation, withdrawal, current support,
  conviction, captured approval requirements, expiry and execution delay.

## Candidate rules to validate

The initial simulation compares short-conviction allocations against the retired
allowance and ordinary reusable token ballots. The candidate uses a 12-hour
conviction half-life. Changing allocation settles elapsed support, removes the
withdrawn fraction's conviction immediately, and starts newly added support at
zero. Changing sides resets that position's conviction.

Unrestricted actions (treasury withdrawals, settings, issuance, membership and
new mandates) require a majority of the opening Shares supply in current FOR
allocations, a minimum conviction floor, a 48-hour review period and the captured
timelock. An inactive majority cannot be replaced by an exhausted-credit minority.

A factory-authenticated, pre-funded treasury mandate exposes one narrowly typed
project-approval operation. That operation can use lower support requirements
and a 24-hour review period because a previously approved mandate bounds its
total lifetime exposure and each project's allocation. Other calls to the same
contract retain unrestricted-action requirements. A project cannot receive more
than its approved budget; returned funds do not silently replenish authority.

All proposal requirements are captured at opening. New Shares are excluded from
existing proposal snapshots. An allocation or ownership change that invalidates
approval clears the queued execution time. A later recovery must queue again and
wait a complete delay. Expired and executed proposals release allocations.
Per-owner live allocations are bounded to keep transfers, burns and views usable.

These are candidate parameters, not claims of universally optimal governance.
The simulations must report minority capture, low-turnout failure and proposal
competition as well as successful projects. A governing majority can still
authorize self-dealing; the mechanism does not cryptographically prove good work.

## Evidence required before completion

1. A reproducible parameter study with ordinary participation, all-in choices,
   competing proposals, delegation concentration, withdrawal, opposition and
   treasury exposure. Preserve failures and explain any resulting refinement.
2. An actual local-EVM DAO journey using the patched Majeur governor, its real
   Shares/Loot, a treasury currency, bounded mandates and the existing verifier
   and claim contracts: investment, project approval, delivery, challenge,
   payment, contribution conversion, reallocation and proportional exit.
3. Production-path regression tests and fuzz/stateful invariants for allocation
   conservation, authentic callbacks, delegation, snapshot eligibility,
   conviction accounting, terminal release and full timelock restart.
4. Contract compilation, deployment-size limits, and the additive Majeur fork
   checker. Remove the retired allowance path and misleading credit copy.
5. Updated web/desktop/CLI controls, meaningful helper tests, typechecks and
   browser exercise of allocation, withdrawal, delegation and execution recovery.
6. A report stating simulated assumptions, observed decision and delivery times,
   participation/concentration limits, treasury exposure, unresolved trust
   assumptions and how to repeat the experiments. Simulation is not an audit.

No production deployment, PR readiness claim or human-test attestation is part
of this local implementation request.
