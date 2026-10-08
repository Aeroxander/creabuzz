# Shares allocations, short conviction, and accountable budgets

Candidate implementation for fresh DAOs, refined 2026-10-08. This replaces the
experimental rechargeable voting allowance. It has been exercised locally; it
has not been audited or deployed for production funds. See the
[simulation report](simulations/governance-validation.md) for evidence and limits.

## One governance mechanism

Shares confer governance standing and economic ownership. Loot confers economic
ownership and proportional ragequit rights, without votes. The patched Majeur
`castVote` path records an allocation in `ConvictionVoting`; native token vote
checkpoints do not provide a second executable tally. `tallies` reads matured
support from that same policy. Futarchy rewards, policy replacement, split
delegation and proposal delegatecall are disabled for this deployment family.

An owner with 100 Shares can allocate 70 to one proposal and 30 to another, or
all 100 to one priority. Those Shares remain owned and transferable. A cast sets
the desired allocation, rather than spending a consumable balance. Recasting
changes it; zero withdraws it. Expiry or execution releases the allocation for
other proposals. There is no recharge timer, weekly reset, or reward for voting
frequency. Holding Shares preserves eligibility even after months of inactivity.

This improves prioritization and allows conviction to reflect sustained support.
It does **not** eliminate wealth concentration: a holder of 60% of Shares can
still authorize an unrestricted action alone. Wallet splitting does not increase
linear allocation capacity. Nonlinear voting would require a separate defensible
identity or membership model to avoid rewarding wallet splitting.

## How conviction works

Current support and conviction are different measurements of the **same**
allocation. With a twelve-hour half-life and constant allocation A:

```text
C(next) = C(previous) × decay + A × (1 - decay)
decay   = 2 ^ (-elapsed / 12 hours)
```

Conviction approaches A: 50% after 12 hours, 75% after 24, 93.75% after 48.
Newly added Shares start at zero conviction. Reducing an allocation removes its
proportional conviction immediately. Changing sides clears conviction. Moving
Shares to another proposal cannot carry the previous proposal's conviction.
Repeatedly casting an unchanged position preserves its conviction. Conviction
retains fractional Shares wei internally, so even a one-wei supply can approve.
Client reads use 18 decimals for current Shares and 36 for accumulated support.

A proposal needs both current FOR and matured FOR floors, current FOR > current
AGAINST, and current turnout including ABSTAIN. Opposition counts immediately; its
accumulated history is not a separate veto over a new current majority.
Waiting cannot make withdrawn or insufficient current support executable.

| Captured requirement | Unrestricted action | Authenticated project approval |
| --- | --- | --- |
| Current FOR | Strictly more than 50% of opening Shares supply | At least 20% |
| Matured FOR | At least 25% of opening supply | At least 10% |
| Current turnout | At least 50% | At least 20% |
| Minimum review | 48 hours | 24 hours |
| Execution delay | Positive DAO-configured delay; default 24 hours | Same |
| Expiry | DAO-configured TTL; default 14 days | Same |

Native quorum and absolute requirements can raise these floors. Supply is
captured at the previous block; Loot is excluded. Rules freeze when opened.
Notice and timelock are separate: the candidate permits an unrestricted action
in 72 hours and a sufficiently supported project in 48 hours, including the
24-hour delay. These are minimums, not promises about actual turnout.

Voting remains open until execution or expiry, including during the timelock.
Lost approval clears the queued timestamp. Recovering approval requires queueing
again and waiting a full new delay. Against votes and Shares transfers/burns can
cause this reset. Queued proposals expire too. TTL must exceed the unrestricted
review period plus execution delay; setters reject configurations violating it.

## Budgets turn decisions into work

An unrestricted vote can approve a finite treasury mandate. Execute one
`batchCalls` intent that approves its currency budget to the factory, calls
`TreasuryMandateFactory.create`, then clears the ERC-20 approval. Creation pulls
the exact budget into the new mandate atomically. Fee-taking deposits fail.

The mandate fixes its DAO, currency, lifetime budget, per-project cap, expiration
and reviewer panel. Factory provenance is required for lower-support voting:
only `approveProject` on a mandate created for this DAO, with zero ETH and
normal CALL, receives project requirements. A UI's proposal kind or an arbitrary
contract claiming to be a mandate cannot lower requirements. Open these intents
with `openProposalWithAction`; arbitrary-ID opening conservatively uses
unrestricted requirements.

A project fixes a manager, budget, expiration and acceptance-check hash. The
manager reserves milestone claims within that budget without another treasury
vote. Funding locks the agreed check. Existing `ClaimStake` and `VerifierSet`
provide claimant recusal, distinct reviewer addresses, approval/objection quorum,
three-day challenge, payout, expiry and disputed-claim recovery. Returned money
does not replenish lifetime project authority. Lower-support voters may allocate
bad projects, but cannot increase the mandate's cap or bypass verification.

Unrestricted governance can `close` the mandate, stop new commitments and recover
unreserved funds early. Existing escrowed claims retain their settlement rules;
governance may freeze and unwind disputed claims. Closing, changing the DAO,
issuing ownership, direct treasury transfers and new mandates all use the higher
requirements. The aim is to vote on priorities and limited budgets, while teams
execute and reviewers verify delivery.

## Holding, earning standing, delegation and exit

Initial Shares holders can vote after a historical block exists. New Shares
issuance or transfers confer standing for future snapshots; they cannot rewrite
an existing proposal's eligibility. Loot holders may earn Shares through approved
contributions. `awardContribution` consumes a paid mandate claim once, then mints
a specified Shares award or converts Loot 1:1 into Shares. The conversion keeps
total economic units constant. Governance still approves the award size.
Existing direct issuance and conversion remain unrestricted governance actions;
the paid-claim helper does not prevent a governing majority colluding to issue
Shares without genuine work.

A single `Shares.delegate` authorizes a delegate to manage the source owner's
allocations; it creates no second capacity. Owners can override positions and
revoke delegation. This grants the owner's full allocation authority: relay
role scopes, expiry and per-proposal delegation caps are not enforced by this
contract. Do not advertise them as onchain limits.

Transfers and burns update cached owned Shares through authenticated token hooks.
If an owner has allocated more than their remaining Shares, live positions and
conviction are reduced proportionally. Transferring free Shares leaves positions
unchanged. Incoming Shares bring no conviction. No owner may have more than 16
live allocations; initial holder enumeration is capped at 256 and supply at
uint96. Expired/executed positions are pruned lazily without a keeper.

Ragequit remains available for Shares and Loot. It returns a proportional share
of the assets actually held by Majeur, excluding funds already committed into a
separate mandate or claim escrow. Members receive notice and timelock before
that commitment. Market price and treasury valuation do not enter the voting
algorithm: an investment buys a specified ownership quantity, not a permanent
right to direct a fixed dollar amount. Treasury growth, losses and dilution
change economic exposure while ownership proportions govern decisions.

## Trust and deployment boundaries

- The initial Shares distribution and trusted policy implementation are deployment
  choices. Existing DAOs do not acquire this policy automatically; this is a new
  constructor and deployment family, without an upgrade/migration promise.
- Reviewer addresses are not proof of independent people. Reviewers can collude,
  and a governing majority can authorize self-dealing. Public evidence and
  recusal help accountability without proving good work cryptographically.
- Low turnout can block unrestricted governance. Delegation concentrates authority
  as well as improving participation. Project approval can be opposed by moving
  Shares; otherwise a minority can waste a bounded mandate's allocation authority.
- Milestone escrow expects ordinary exact-transfer ERC-20 currency. Token upgrades,
  issuer freezes, malicious callbacks or transfer fees remain currency trust risks.
- Votes, ownership, proposals and attestations are public. RPC/indexer/frontend
  availability affects access and discovery; direct contract interaction and
  permissionless expiry recovery remain available. No transaction runs merely
  because time has passed: someone must queue, execute, settle or recover it.

The design adapts configurable conviction accumulation described by
[Gardens](https://docs.gardens.fund/conviction-voting/conviction-parameters) to
exclusive allocations and explicit current-support floors. Shares/Loot economics
follow [Majeur](https://github.com/z0r0z/majeur#token-system). The chosen thresholds
and half-life are candidates validated against specified scenarios, not evidence
of optimal voting or a claim that DAOs become decentralized automatically.
