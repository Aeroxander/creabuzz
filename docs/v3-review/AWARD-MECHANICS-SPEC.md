# Award mechanics — agreed contribution rewards

Status: development spec for `v5-governance-rework`. Not deployed, not audited,
not for real-value use. Contract work here continues under D174's development
lift; activation remains gated on pilots, an independent audit and an explicit
release decision. Written 2026-11-02 from the implementation handoff of
2026-11-01 and its review. Candidate parameters below are proposals for tests,
not production promises.

## Problem

Today a contributor submits work, reviewers verify it, and holders then vote an
amount (`HowItWorks.tsx`: "Holders vote to award you Shares"). The reward is
discretionary after the effort. D174 merged zero-money finishing into the award;
the remaining gap is the reward itself.

## Model

One agreement, one exact Share quantity (or an explicit split), reserved when the
agreement is accepted, released by a terms-bound settlement that anyone may
trigger. No fresh discretionary award vote for agreed work. The contributor knows
the quantity before substantial effort; its cash value and future ownership share
stay uncertain and are said so.

## State machine

| State | Entered by | Financial effect |
|---|---|---|
| DRAFT | project party proposes terms | none |
| AGREED | contributor accepts and an authorized project party approves; financially consequential fields recorded onchain | reserves the exact Shares |
| SUBMITTED | artifact and evidence packet bound to the agreement and its criteria version | none (reservation stands) |
| IN_REVIEW | reviewers act under the configured panel policy | none |
| CORRECTIONS | a reviewer requests changes (non-final route) | none; a revision is a new attempt record |
| ACCEPTED | panel quorum satisfied on the current submission version | none yet |
| CHALLENGE_WINDOW | mechanical, on ACCEPTED (duration parameter) | none |
| SETTLED | anyone calls the terms-bound settlement after the window with no blocking dispute and the agreement unconsumed | consumes the reservation, mints or finishes exactly once |
| DISPUTED | any party the policy allows | freezes settlement |
| CANCELLED | either party, pre-submission only | releases the reservation |
| EXPIRED | work deadline passes unsubmitted | releases the reservation |
| CLOSED (mandate) | mandate closure | earned entitlements survive; unearned reservations release per terms |

Rules:

- An approval binds to a submission version. Approvals never carry to a revision;
  history is preserved and a revision re-enters review. Ordinary correction
  requests are separate from irreversible rejection votes. Superseding an open
  attempt must retire it atomically and return its stake unslashed (or record a
  recoverable debt), rather than leaving it open to a later contradictory verdict.
- "Taking this on" stays social coordination: it reserves nothing and is never a
  financial signature or an exclusive assignment.
- Unsolicited work keeps the existing discretionary recognition path and is
  labelled as carrying no agreed reward.
- A user learns that a budget is exhausted at agreement time, never after
  delivery. Deadlines, cancellation and dispute terms are part of the agreement,
  not an afterthought.
- Once an agreement is accepted, its beneficiary can submit and bind their own
  criteria-matching work without another discretionary manager approval. A
  manager may assist; the independent panel still decides whether it passes.
- Corrections and disagreement have named resolution paths; a contributor is
  never left in an unexplained deadlock. Absence and escalation follow the
  configured panel policy.

## Financial rules

- Reserve atomically at AGREED against both the work-area allowance and the
  mandate's Share budget: `awarded + outstanding reservations + this` must stay
  within the authorized ceilings. Concurrent acceptances must not overcommit.
- Released reservations create no new lifetime mint authority; ceilings are
  cumulative and never replenished.
- Only an authorized project party creates agreements against a mandate; a
  beneficiary accepts only their own; no claimant chooses a reward or ties up the
  budget with fabricated assignments.
- A fixed quantity is Shares — not a cash price and not a promised percentage
  after future issuance. Copy says exactly that.
- Closing a mandate never quietly erases an already-earned entitlement.

## Authority

- Settlement is permissionless and terms-bound: it derives recipient and amount
  from the onchain agreement record, and requires ACCEPTED, an elapsed challenge
  window, no blocking dispute and an unconsumed agreement. Accounting, minting
  and consumption are one atomic step (exactly-once).
- `MolochPatched.awardContribution` keeps `onlyDAO` and its caller-chosen amount
  for the legacy and discretionary paths. Never remove `onlyDAO` from it: that
  would let one call award the entire remaining allowance. The agreed-reward path
  is the smallest explicit authority that settles an agreement's reserved amount
  only (an `awarding()`-style one-time mint gated to that amount).
- Agreement records live in a minimal new module (or the smallest extension of
  existing claim accounting) that references the mandate and claim identity.
  Deployed budgets keep the legacy manual flow; the app shows which regime a
  project runs on, and a failed read never masquerades as "legacy".

## Identity and one-time consumption

- `agreementId` is stable and scoped by mandate, work area and deliverable slot.
  One single-reward slot cannot be assigned again merely by changing the
  beneficiary. Deliverables, attempts and revisions are explicit records;
  coauthor recipients and split are committed by the manager's proposal and
  confirmed by the beneficiary at acceptance. Split quantities sum to the exact
  agreed reward; a disclosed deterministic remainder goes to the beneficiary.
- Whether the deliverable has one reward, several independently rewarded slots,
  or split coauthor allocations is decided in the terms at AGREED — never argued
  after delivery.
- No semantic dedup. An identical artifact hash on another claim is flagged as a
  review question; semantic similarity only raises a question. Several agents
  doing one participant's work earn one reward.
- Every attempt linked to an agreement, including superseded attempts, stays
  outside the legacy caller-selected discretionary award path. A legacy vote
  must not consume an agreed claim at a different amount or award an old revision.

## Reviewer terms

- The panel policy is read from the configured panel; first-answer and
  split-unanimity behavior follow D145. Three keys are never claimed to be three
  independent people. Recusal, substitution, escalation and quorum are policy
  fields.
- Compensation is explicit and independent of the verdict. The development
  candidate uses voluntary reviewers with no payment, clearly disclosed before
  they accept the role. ContributorKit funds no currency budget. A later paid
  policy must specify a funded retainer or agreed allocation and reserve it;
  neither payment machinery nor cash funding is introduced implicitly. A bond
  is not compensation.
- Where currency fees exist they need an explicitly funded, reserved budget and
  never consume money promised to contributors. Close, refund, expiry and failed
  transfers are part of the terms. Reviewer Share awards need authorized terms and
  self-review protection. A voluntary-review pilot says so plainly.

## Parameters (candidate values; activation is separate)

| Parameter | Candidate | Note |
|---|---|---|
| challenge window | 7 days | matches existing challenge windows |
| work / review deadlines | per agreement | expiry releases only unearned reservations |
| quorum | actual configured panel | preserve D145 first-answer and split-unanimity semantics; no invented 2-of-3 default |
| reviewer compensation | none; voluntary review, explicitly disclosed | no implicit cash budget or promise of future payment |
| cancellation | either party, pre-submission | post-submission goes to dispute |
| voting activation | see [SECONDARY-LISTING-SPEC.md](SECONDARY-LISTING-SPEC.md) | treatment of new awards decided there |

The development correction proposes a seven-day review period measured from a
bound submission, enforced in its claim deadline, and a separate fourteen-day
revision grace after the work deadline. These are candidate terms, not approved
production promises. Reviewers cannot attest before binding has committed the
criteria and excluded every reward recipient. A request for changes consumes no
final-verdict vote. An unanswered review stays unknown; expiry or escalation is
explicit and does not invent acceptance. A frozen or approved claim is not
silently erased by expiry of the mandate.

## UI and reporting

- Agreements display their regime: agreed reward, discretionary recognition, or
  the legacy deployed flow. Budget exhaustion appears when the agreement is
  made. "Awarded" shows only on confirmed chain state.
- Missing facts read "not recorded yet". Nothing is labelled safe to invest. A
  matching evidence hash authenticates a packet; it does not prove its claims.
  Accepted work, final review, awarded Shares and customer outcomes stay distinct
  labels.

## Test seams (each test must fail if its guard is removed)

Agreement: unauthorized or racing reservation; exhausted area or mandate
allowance; altered recipient, reward or criteria after acceptance; expiry,
cancellation and closure interactions; revisions and alternate claim ids; split
and coauthor work; self-review; quorum disagreement; early settlement; dispute
and freeze; atomic mint failure; exactly-once award; legacy path unchanged for
deployed budgets. Reviewer fees (where implemented): reservation solvency; no
reward bias by verdict; no double payment; close and refund behavior; blocked
token recovery. Backward compatibility: existing deployments keep the true
manual and discretionary flow; failed reads never masquerade as a legacy version
or an empty account.

## Out of scope

Sponsor escrow, primary fundraising, per-verdict payment machinery, semantic
dedup, universal reputation scores, desktop and mobile parity (D9).
