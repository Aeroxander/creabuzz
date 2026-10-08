# Shares voting: relative bars, a hold time, free opposition, accountable budgets

Implemented and tested locally; **not audited, not deployed for production funds.** This is the second design
of the voting policy. It replaces the first one (accruing conviction against bars set as fractions of *all*
Shares), whose own simulation showed that treasury-scale proposals almost never passed at realistic turnout.
The reasoning and the numbers are in [the review](v3-review/PLAN.md) and
[the voting-rules study](simulations/voting-v2-study.md) (`node scripts/simulate-voting-rules.mjs`).

## One mechanism

Shares confer governance standing and economic ownership. Loot confers economic ownership and proportional
ragequit, without votes. The patched Majeur `castVote` records an allocation in `AllocationVoting`; native
checkpoint votes are not a second tally, and futarchy rewards, policy replacement, split delegation and proposal
delegatecall are disabled for this deployment family.

An owner with 100 Shares can back one proposal with 70 and another with 30, or all 100 behind one. A vote *sets*
the allocation: recasting changes it, zero withdraws it. Nothing is consumed and there is no refill or reward for
voting often. Expiry or execution releases the allocation.

## How a proposal is approved

Requirements are fixed when the proposal opens and cannot change afterwards. A proposal is approvable when:

1. **Quorum:** Shares that took part (for, against or abstain) are at least a share of **voting supply**;
2. **Approval:** Shares in favour are at least `approvalBps` of the Shares cast for or against, and more than
   those against;
3. **Hold:** quorum and approval have held **without a break** for the lane's hold time;
4. **Review:** the lane's minimum notice has passed;
5. then the governor's queue waits the execution delay, and **any loss of support restarts both the hold and the
   delay**. Voting stays open through the delay.

**Voting supply** is total Shares at the snapshot minus Shares that can never vote: the DAO's own balance, the
burn address, and any holder the DAO excludes (an unsold sale tranche, an AMM, a vesting vault). Treasury-held or
lost Shares must not raise every bar forever. The governor's own quorum settings can *raise* a bar; they never
lower the lane's.

| | Unrestricted lane (treasury-scale) | Bounded lane (approval inside a funded mandate) |
|---|---|---|
| Quorum, of voting supply | 20% | 10% |
| Approval, of votes cast for/against | 66% | 55% |
| Review | 48 hours | 24 hours |
| Hold | 12 hours | 6 hours |
| Backing | exclusive | reusable |

These are starting values, stored as parameters (`setLane`), applying only to proposals opened afterwards, and
kept inside ranges that leave governance able to repair itself (quorum 5–60%, approval 50.01–90%, review 1–14
days, hold at most the review and a week). A governor TTL too short for a lane is stretched, never turned into a
refusal to open anything.

**Why a hold time and not accruing conviction.** The first design accrued conviction with a 12-hour half-life.
Its own study showed the 48-hour review dominates every half-life for steady support; what conviction really
bought was protection against support that swings in at the last minute. A hold time gives the same protection in
two lines anyone can read. Accruing conviction is the right tool for competing funding requests against one pool
of money, which is a different contract (planned).

**Opposition is free; backing is exclusive only in the unrestricted lane.** In an exclusive lane the Shares you
back (FOR or ABSTAIN) are not available to back another proposal, so you choose priorities. AGAINST can sit on
every proposal at full weight: otherwise a majority busy backing its own priorities could not also oppose a
hostile one, and relative bars would let a minority through unopposed. The bounded lane is not exclusive because
the mandate's budget already caps what its approvals can spend, and the study showed that splitting Shares across
concurrent approvals roughly halves how many good ones pass.

This does **not** remove wealth concentration: a holder above the quorum can pass an action alone if nobody
opposes it in time, which is what the review, hold, delay and ragequit are for. Splitting wallets does not add
capacity.

## What the study says (assumptions are stated in the script)

At 15% public turnout with one holder at 8% (3 proposals open, large = outside a mandate):

| Rule | good large pass | harmful large pass | good small pass |
|---|---|---|---|
| v3 (more than half of all Shares) | 0% | 0% | 7% |
| plain token vote | 93% | 13% | 92% |
| **this design** | 58% | 1% | 88% |

It is slower than a plain vote where exclusivity bites and much safer than one against a concentrated holder; it
is far more live than v3. `scripts/simulate-voting-rules.test.mjs` pins the shape of these results.

## Budgets turn decisions into work

An unrestricted vote can approve a finite treasury mandate. Execute one `batchCalls` intent that approves its
currency budget to the factory, calls `TreasuryMandateFactory.create`, then clears the ERC-20 approval. Creation
pulls the exact budget into the new mandate atomically. Fee-taking deposits fail.

The mandate fixes its DAO, currency, lifetime budget, per-project cap, expiration and reviewer panel. It also fixes
a **share budget** and a per-project share cap: the most Shares it can ever cause to be awarded. Either budget may be
zero, but not both. A mandate with no currency moves no money and needs no approval: it is how a project with no
treasury (one that never raised) rewards contributors. The broad vote that creates it is the vote on how much
dilution the work may cost.

Factory provenance is required for the bounded lane. Two actions receive the bounded bars, both with zero ETH and a
normal CALL: `approveProject` on a mandate created for this DAO, and `awardContribution` aimed at the DAO itself
for a mandate created for this DAO (a well-formed call only: exact length, no stray address bits). A UI's proposal
kind or an arbitrary contract claiming to be a mandate cannot lower the bars. Open these intents with
`openProposalWithAction`; opening by id alone conservatively uses the unrestricted lane.

A project fixes a manager, a currency budget and a share budget, an expiration and an acceptance-check hash. The
manager binds milestone claims, naming the contributor they mean (a claim id belongs to whoever filed it first),
reserving currency for those that ask for it, without another treasury vote. A claim may ask for no currency at
all: it asks to be recognised. Funding locks the agreed check. `ClaimStake` and
`VerifierSet` provide claimant recusal, distinct reviewer addresses, approval/objection quorum, a three-day
challenge, payout, expiry and disputed-claim recovery. Returned money does not replenish lifetime project authority.

Unrestricted governance can `close` the mandate, stop new commitments (including any further Shares from its
allowances) and recover unreserved funds early. Existing
escrowed claims retain their settlement rules; governance may freeze and unwind disputed claims.

## Holding, earning standing, delegation and exit

Initial Shares holders can vote once a historical block exists. New Shares confer standing for future snapshots,
never for a proposal already open. Loot holders can earn Shares through approved contributions:
`awardContribution` consumes an approved mandate claim once (paid, or approved with nothing to pay), counts the
award against its project's share budget, then mints Shares or converts Loot 1:1. The size of each award is a vote
in the bounded lane, and the mandate refuses one larger than the project has left, however the vote went. A
governing majority can still issue Shares without genuine work through the unrestricted lane; the bounded path is
the one that needs verified work.

A single `Shares.delegate` authorizes a delegate to manage the owner's allocations; it creates no second capacity.
The owner can override and revoke. This grants the owner's full allocation authority: relay role scopes, expiry
and per-proposal caps are **not** enforced by this contract and must not be advertised as onchain limits.

Transfers and burns update owned Shares through authenticated token hooks. If an owner has backed more than they
still hold, their exclusive backing is scaled down proportionally; every other position (opposition, and backing
in a reusable lane) is capped at the balance. Incoming Shares bring no allocation. No owner has more than 16 live
positions; initial holder enumeration is capped at 256 and supply at uint96. Expired and executed positions are
pruned lazily without a keeper.

Ragequit stays available for Shares and Loot. It returns a proportional share of the assets Majeur actually holds,
excluding funds already committed into a mandate or claim escrow, which is why the review, hold and delay give
members notice before a commitment. Market price and treasury valuation never enter the vote.

## Trust and deployment boundaries

- The initial Shares distribution and the policy implementation are deployment choices. Existing DAOs do not
  acquire this policy; it is a new constructor and deployment family with no upgrade or migration promise. Every
  DAO starts with a 14-day TTL and 1-day timelock (a DAO born without them could never open a proposal), and
  `initCalls` may replace both.
- Reviewer addresses are not proof of independent people and can collude; a governing majority can authorize
  self-dealing. Public evidence and recusal help accountability without proving good work.
- Low turnout can block governance only up to the quorum; above it, a holder can pass an unopposed action and the
  exit window is the remedy. Delegation concentrates authority as well as improving participation.
- Milestone escrow expects an ordinary exact-transfer ERC-20.
- Votes, ownership, proposals and attestations are public. Nothing runs merely because time has passed: someone
  must queue, execute, settle or recover.
- `Moloch` is at 24,380 of 24,576 bytes. New behaviour belongs in satellite contracts, not in the governor.

The bars and times are candidates validated against stated scenarios, not evidence of optimal voting or a claim that
a DAO becomes decentralized automatically.

## Shares as an apptoken (ERC-20C), and locked Shares

The DAO's Shares present Limit Break's creator-token interface (`ICreatorToken`, ERC-165 id `0xad0d7f6c`), so the
canonical transfer validator, and the tools built on it, treat them as an apptoken. The DAO is the collection owner
(`owner()`), so only a vote can choose the validator or its ruleset. The patch is in `Shares`, not in `Moloch`, and
costs the governor nothing: its size headroom is unchanged.

- **No default validator.** Stock ERC-20C falls back to a default validator that may not exist on a chain. Shares
  start with none; the DAO chooses one (`setTransferValidator`) and can remove it again.
- **A validator sees plain transfers only.** Mints and burns never reach it (as in the standard), so no ruleset,
  hostile or broken, can block ragequit or an award.
- **Lock guard.** The DAO may name a guard contract that says how many of a holder's Shares are locked
  (`lockedOf`). Locked Shares vote (they count in the holder's capacity and delegation) but cannot be transferred or
  burned, so they cannot be sold and cannot be ragequit; only the unlocked part can. The DAO's own Shares are never
  locked, and the DAO can remove the guard. A governance burn of locked Shares is held by the same wall.
- **Verified** with the real validator on a local chain (`scripts/shares-erc20c-e2e.sh`): the DAO votes the
  validator and the Soulbound ruleset, a transfer is refused and ragequit still works, Vanilla restores transfers, and a
  lock guard holds exactly the locked part.

What is not built yet: the guard that unlocks by milestone (a soulbound milestone NFT per tranche, minted when a
reviewed claim is paid), and the launch kit's use of it.
