# Pledges to the next milestone: the state machine (N9, specified 2026-10-26 as D123)

Status: **specified, not built.** Pledges price Shares by the funding curve ([JOIN-CURVE.md](JOIN-CURVE.md)), which is
not built, and they belong after the audited raise (stage 3). This is the precise version of N9 so the contract can be
written and reviewed the moment the curve exists. Decided overnight with your go-ahead; the calls to check are marked.

## In one paragraph

A pledge **buys future Shares**: a backer puts USDC behind a project's next milestone, held in escrow. If the milestone
is accepted by its deadline, each pledge is released at the curve's price at that moment (never below the treasury
floor) and the backer receives Shares, unless that price is above the most the backer said they would pay, in which case
the pledge is refunded. If the milestone is not accepted in time, everyone is refunded. Anyone can trigger release or
refund. No new Shares are made (D76): pledged Shares come out of the curve's own allocation, reserved at the backer's
worst case so nothing is sold twice.

## Where the Shares come from (open question 5, decided)

**Only DAOs with a funding curve take pledges.** The curve's allocation is the only supply that can be sold without
minting (D76), and its price rule is what prices a release. A contributor project, which has no curve, gets money for
work through bounties (N1, N2) instead; a contributor project that wants to sell Shares becomes a raise.
*(Check: if you want pledges in contributor projects, they would need a new issuance rule, against D76.)*

## Constants

| Name | Value | Meaning |
|---|---|---|
| `MIN_PLEDGE` | 10 USDC | Below this a pledge costs more in gas than it is worth |
| `WITHDRAW_UNTIL` | evidence submitted | A backer can take a pledge back until the team submits the milestone's evidence |
| `RELEASE_GRACE` | 14 days | After acceptance, how long a release can run before refunds open anyway |

## What is stored, per milestone round

`milestone` (which of the lock's milestones), `deadline` (the milestone's own), `pledged` (total USDC),
`reservedShares` (the worst-case Shares held back from the curve), `evidenceAt` (0 until submitted), `state`.
Per pledge: `backer`, `amount`, `maxPrice` (USDC per Share), `reserved` (Shares held back for it), `settled`.

## The states

| State | When | What can happen |
|---|---|---|
| **Open** | before the milestone's evidence is submitted, before its deadline | Pledge; withdraw your pledge |
| **Locked** | evidence submitted, outcome not final | Nothing moves; backers wait for the review and any objection |
| **Releasing** | the milestone accepted (finally, after any objection) by its deadline | Anyone releases each pledge, until `acceptedAt + RELEASE_GRACE` |
| **Refunding** | the deadline passed without acceptance, the milestone rejected, or the release time over | Each backer's refund, of whatever was not released |

## The actions

| Action | Who | Allowed only when | What it does |
|---|---|---|---|
| `pledge(round, amount, maxPrice)` | anyone | Open; `amount ≥ MIN_PLEDGE`; the curve can still reserve `amount ÷ max(floor, its lowest price)` more Shares | Takes `amount`; reserves the Shares it could buy at its worst case (`amount ÷ max(floor, curve price now)`), so curve sales and other pledges cannot sell them |
| `withdraw(round, id)` | the backer | Open | Returns the money, frees the reservation |
| `release(round, id)` | anyone | Releasing | Price `p = max(curve price now, treasury floor)`; if `p > maxPrice`, refund instead; else Shares `= amount ÷ p` from the reservation to the backer, the money to the treasury, the rest of the reservation freed |
| `refund(round, id)` | anyone, for the backer | Refunding | The money back to the backer alone, the reservation freed |

## Every boundary

| Boundary | Before | At and after |
|---|---|---|
| The evidence is submitted | pledge, withdraw | neither; wait |
| The deadline, without acceptance | waiting | refunds open |
| Final acceptance (after any objection window) | waiting | releases open |
| `acceptedAt + RELEASE_GRACE` | releases | refunds of whatever was not released |
| A release's price reaches `maxPrice` | at or below: Shares | above: refund |

## Why price at release, not at pledging

With 5,000 USDC over 1,000 Shares, a pledge priced in advance at 1 USDC could buy 10 Shares for 10 and leave at once
for 49.60. Pricing at release under the curve's rule (never below the floor) makes that impossible.

## What it needs that does not exist

1. **The funding curve** (JOIN-CURVE.md, eight open questions) with a reservation interface.
2. **The milestone lock recording when evidence was submitted** (NEXT-GEN-DAO.md, open question 3), so Open ends at a
   moment the contract can read.
3. **An audit**, with the raise path.

## Tests that would decide it

A release never prices below the floor; reserved Shares are never sold twice by the curve or another pledge; a release
above the backer's maximum refunds; every boundary above on both sides; `pledged = released + refunded + still held` at
every step; one backer who cannot receive USDC never blocks another.
