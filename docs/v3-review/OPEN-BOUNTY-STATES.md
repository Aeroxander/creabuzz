# Open bounties on posts: the state machine (N2, 2026-10-25)

Status: **built for test networks as D114** ([OpenBounty.sol](../../contracts/src/OpenBounty.sol)), from this
specification with one change: the words and each claim's evidence are kept in the contract's own events (see
[Off chain](#off-chain)). It makes N2 of [NEXT-GEN-DAO.md](NEXT-GEN-DAO.md) exact
before any code, as the review of the staged proposal asked: every state, every action, every boundary written as a
strict or inclusive comparison, what each action can do to a decision in progress, and the invariants a test suite
would hold. The work-area bounty (N1, D113, [WorkAreaBounty.sol](../../contracts/src/WorkAreaBounty.sol)) is the
model for its clock and its books.

## In one paragraph

Anyone turns a post into a bounty: fixed words for what "done" looks like, a deadline, and USDC anyone can add.
Anyone files a claim with evidence. Each funder backs at most one claim with all the money they put in. A claim
whose backing is more than half of the money that counts starts a **run**; if it keeps that majority for nine days
without a break (shown as two days of agreeing and a seven-day hold), anyone can pay it the whole pot. A dip ends the
run. Money cannot be added while a run is on. After the deadline nothing new starts; once no run is on, every funder
can take their money back, and at a fixed date they can whatever happens.

## Five changes from N2 as written, and why

1. **A wallet with an open claim has no weight at all, not only for its own claim.** As written ("all funded weight,
   less the claimant's own"), each claim has its own count, and two claims can both have a majority. Example: 100
   USDC in; Ana put in 60, filed claim A and backs claim B. Claim B: backed by 60 of 100, a majority. Claim A: its count
   is 100 − 60 = 40, and 25 of the other 40 back it, a majority too. With one count for everyone (the money of funders
   with no open claim), two claims can never both exceed half, because a funder backs one claim.
2. **Money cannot be added while a run is on**, instead of "late money joins the pot but carries no weight". Giving
   late money its weight when the run ends means updating every late funder's backing at that moment: a loop over
   funders, or bookkeeping that can leave a claim's backing out of date. A pause is simpler and has the same effect,
   since nobody can buy or block an outcome others were weighing. The pot stops growing for at most nine days.
3. **"48 hours, then a 7-day hold" is one continuous nine-day run.** Both parts have the same rule (keep the majority;
   a dip ends it). The split is only how the page words it.
4. **After the deadline, backing can only be withdrawn**, and no new run can start. A run that started before the
   deadline continues to its end.
5. **Refunds open the moment the deadline has passed and no run is on**, and at a fixed date (`refundsFrom`) whatever
   happens. N2 as written said "at the deadline" and "when a run ends after it"; this is the same rule written so the
   contract can check it in one line.

## Constants

| Name | Value | Meaning |
|---|---|---|
| `RUN` | 9 days | How long a claim must keep its majority before it can be paid (2 days agreeing + 7 days on hold) |
| `AGREE` | 2 days | Only for the page: the first part of a run, worded "agreeing" |
| `PAY_GRACE` | 14 days | After the latest a run could become payable, how long it can still be paid before refunds open anyway |
| `MAX_LENGTH` | 365 days | The furthest a deadline can be from the bounty's opening |

`refundsFrom = deadline + RUN + PAY_GRACE`, fixed when the bounty opens. A run starts before the deadline, so it can be
paid by `deadline + RUN` at the latest, and has `PAY_GRACE` to be paid after that.

## What is stored

Per bounty: `creator`, `post` (the post's event id), `wordsHash`, `openedAt`, `deadline`, `refundsFrom`, `total`
(everything funded), `refunded`, `counting` (the money that counts), `claimCount`, `runClaim` (0 when no run),
`runSince`, `paidClaim` (0 until paid).

Per bounty and funder: `funded[f]` (what they put in and have not taken back), `backs[f]` (the claim they back, 0 for
none), `openClaim[f]` (their open claim, 0 for none).

Per bounty and claim (numbered from 1): `claimant[c]`, `evidenceHash[c]`, `open[c]`, `backing[c]`.

Derived:

- `counting` = the sum of `funded[f]` over funders with no open claim (kept up to date by every action, never summed).
- `qualifies(c)` ⇔ `open[c]` ∧ `2 × backing[c] > counting` (strictly more than half; exactly half does not qualify, and
  with `counting = 0` nothing qualifies).
- `running` ⇔ `runClaim ≠ 0`.
- `payableAt = runSince + RUN`.
- `refundsOpen(t)` ⇔ `paidClaim = 0` ∧ (`t ≥ refundsFrom` ∨ (`t ≥ deadline` ∧ ¬running)).

Every action is constant time: no loop, no list that grows with the number of funders or claims.

## The states

States are derived from what is stored, never stored themselves.

| State | When (at time `t`) | What can happen |
|---|---|---|
| **Open** | `t < deadline`, ¬running, unpaid | Fund, file or withdraw claims, back, move or withdraw backing, start a run |
| **Running: agreeing** | running, `t < runSince + AGREE`, `t < refundsFrom`, unpaid | File claims and back (before the deadline); withdraw a claim or backing; no money in |
| **Running: on hold** | running, `runSince + AGREE ≤ t < payableAt`, `t < refundsFrom`, unpaid | The same |
| **Payable** | running, `payableAt ≤ t < refundsFrom`, unpaid | Pay; withdrawing backing or the claim still ends the run until someone pays |
| **Paid** | `paidClaim ≠ 0` | Nothing; the bounty is over |
| **Refunding** | `refundsOpen(t)` | Each funder's refund; nothing else changes money |

Every run ends in exactly one of: **paid**, **dipped** (an action left it without a majority, or its claim was
withdrawn; back to Open, or to Refunding after the deadline), or **expired** (`t` reached `refundsFrom` unpaid, for
example because the currency refuses to pay the claimant; Refunding).

## The actions

"Then: the run check" means: if a run is on and its claim no longer qualifies, the run ends (`runClaim = 0`,
`runSince = 0`, event `RunEnded`). Only the actions marked so can start a run.

| Action | Who | Allowed only when | What it does |
|---|---|---|---|
| `open(post, wordsHash, deadline, amount)` | anyone | `openedAt < deadline ≤ openedAt + MAX_LENGTH`; `amount > 0`; `wordsHash ≠ 0` | Makes the bounty, fixes its words and both dates, then funds it with `amount` as below |
| `fund(id, amount)` | anyone | unpaid; `t < deadline`; ¬running; `amount > 0`; the currency delivers exactly `amount` | `funded[f] += amount`, `total += amount`; if `f` has no open claim, `counting += amount`; if `f` backs `b`, `backing[b] += amount`, **then try to start a run on `b`** |
| `fileClaim(id, evidenceHash)` | anyone with no open claim here | unpaid; `t < deadline`; `evidenceHash ≠ 0` | New claim `c`; `openClaim[f] = c`; if `f` funded: `counting −= funded[f]`, and if `f` backs `b`, `backing[b] −= funded[f]`, `backs[f] = 0`. Then: the run check |
| `withdrawClaim(id)` | the claimant | unpaid; the claim is open | `open[c] = false`, `openClaim[f] = 0`; if `c` is the run's claim the run ends; if `f` funded, `counting += funded[f]` (they back nothing). Then: the run check |
| `back(id, c)` | a funder with money in and no open claim | unpaid; `t < deadline`; `open[c]` | If they back another claim `b`, `backing[b] −= funded[f]`; `backs[f] = c`, `backing[c] += funded[f]`. Then: the run check, **then try to start a run on `c`** |
| `unback(id)` | a funder backing a claim | unpaid | `backing[backs[f]] −= funded[f]`, `backs[f] = 0`. Then: the run check |
| `start(id, c)` | anyone | unpaid; ¬running; `t < deadline`; `qualifies(c)` | `runClaim = c`, `runSince = t` |
| `pay(id)` | anyone | unpaid; running; `payableAt ≤ t < refundsFrom` | `paidClaim = runClaim`; sends `total` to the claimant. If the currency refuses, nothing changes |
| `refund(id, f)` | anyone, for funder `f` | `refundsOpen(t)`; `funded[f] > 0` | `refunded += funded[f]`; removes `funded[f]` from `counting` if `f` has no open claim, and from `backing[backs[f]]` if `f` backs one; `funded[f] = 0`, `backs[f] = 0`; sends it to `f` alone. Then: the run check (which keeps the books exact; no payment is possible once refunds open) |

"Try to start a run on `c`": if ¬running ∧ `t < deadline` ∧ `qualifies(c)`, then `runClaim = c`, `runSince = t`. The
backing or funding that gives a claim its majority starts its run in the same transaction. Any other change that can
give a claim a majority without touching it (a funder filing a claim lowers `counting`) is started by `start`, which
the page offers to anyone when a claim qualifies and no run is on.

### What each action can do to a run

| Action | Can end the run | Can start a run |
|---|---|---|
| `fund` | no (refused while running) | yes, on the claim the funder backs |
| `fileClaim` | yes, when the one filing backed the run's claim (their money leaves both its backing and `counting`; a filer who backed nothing only raises its share) | no (`start` does) |
| `withdrawClaim` | yes: it is the run's claim, or the claimant's money returns to `counting` | no |
| `back` | yes: moving backing away from the run's claim | yes, on the claim backed |
| `unback` | yes | no |
| `start` | no | yes |
| `pay` | (the bounty is over) | no |
| `refund` | yes, harmlessly: no payment is possible once refunds open | no |

## Appeals (N7, added 2026-10-26 with the court, D119)

A bounty contract may name a court (`court ≠ 0`; the test networks' deployment does). Nothing above changes, except
when refunds open and two new actions. One appeal per bounty, kept in `appeals[id]` beside the bounty's own record.

| Name | Value | Meaning |
|---|---|---|
| `APPEAL_WINDOW` | 3 days | After the deadline, or after a run that ended after it (`quiet`), how long a claimant can appeal before refunds open |

| State | When | What can happen |
|---|---|---|
| **Appeal window** | court, unpaid, `deadline ≤ t < quiet + APPEAL_WINDOW`, ¬running, no appeal, some claim filed | A claimant appeals; no refunds yet |
| **With the court** | appeal open | Nothing moves money: no refund, no payment; the appealed claim cannot be withdrawn |
| **Upheld** | ruling 1, `t < ruledAt + PAY_GRACE` | Anyone pays the appealed claimant the whole pot |
| **Refunding** | as before, or the appeal refused (any ruling but 1, including a court that times out), or upheld but not paid by `ruledAt + PAY_GRACE` | Each funder's refund |

| Action | Who | Allowed only when | What it does |
|---|---|---|---|
| `appeal(id)` | a claimant with an open claim | court; unpaid; no appeal yet; ¬running; `deadline ≤ t < quiet + APPEAL_WINDOW`; `t < refundsFrom`; nothing refunded | Takes the court's fee from the claimant, opens a case for (bounty, claim), records the appeal |
| `rule(dispute, ruling)` | the court only | the case is this bounty's open appeal | 1 upholds the claim; anything else refuses it |

`refundsOpen(t)` becomes: never while an appeal is open; for an upheld appeal only from `ruledAt + PAY_GRACE`; otherwise
at `refundsFrom`, or after the deadline with no run when there is no court, no claim, a refused appeal, or the window
has passed. The two endings still cannot overlap: an upheld claim is payable only before `ruledAt + PAY_GRACE`, which is
exactly when its refunds open.

## Every boundary

| Moment | Fund | File a claim | Back | Withdraw backing or claim | Start a run | Pay | Refund |
|---|---|---|---|---|---|---|---|
| `t < deadline`, no run | yes | yes | yes | yes | yes, if a claim qualifies | no | no |
| `t < deadline`, run on, `t < payableAt` | **no** | yes | yes | yes (may end it) | no (one run at a time) | no | no |
| `t < deadline`, run on, `t ≥ payableAt` | no | yes | yes | yes (may end it) | no | **yes** | no |
| `t = deadline`, no run | no | no | no | yes (changes nothing) | no | no | **yes** |
| `t = deadline`, run on | no | no | no | yes (may end it) | no | if `t ≥ payableAt` | no |
| `deadline < t < refundsFrom`, run on | no | no | no | yes (ending it opens refunds) | no | if `t ≥ payableAt` | no |
| `deadline < t < refundsFrom`, no run | no | no | no | yes (changes nothing) | no | no | yes |
| `t = refundsFrom`, unpaid | no | no | no | yes (changes nothing) | no | **no** | **yes** |

Two endings never overlap. `pay` needs a run and `t < refundsFrom`. `refund` needs `t ≥ refundsFrom`, or `t ≥ deadline`
with no run; after the deadline no run can start, so once a refund is possible, a payment never is again. Funding closes
at the deadline (`t < deadline`), and starting a run needs `t < deadline`, so `runSince < deadline` and `payableAt <
deadline + RUN < refundsFrom`: every run has at least `PAY_GRACE` to be paid.

## The books

- `balance(currency) = Σ (total − refunded)` over the unpaid bounties.
- A bounty pays its whole `total` once, or refunds each funder their own `funded[f]`; never both.
- `total = Σ funded[f] + refunded` while unpaid.
- `counting = Σ funded[f]` over funders with no open claim; `backing[c] = Σ funded[f]` over funders backing `c`.
- A currency that keeps a fee is refused when money comes in, as in N1. The payment and each refund go to one person
  each, so a funder the currency refuses never blocks another's refund, and a claimant it refuses cannot be paid: their
  run expires at `refundsFrom` and everyone is refunded.
- No admin, no pause, no fee, no deposit.

## Invariants a test suite holds (random orders of every action and of time)

1. The contract holds exactly what the unpaid bounties still owe (the first line of the books).
2. No bounty is both paid and refunded; a paid bounty paid exactly its `total`.
3. `counting` and every `backing[c]` equal the sums above (checked against a ghost ledger).
4. At most one open claim has `2 × backing > counting`.
5. `running` ⇒ the run's claim is open, qualifies, and `runSince < deadline` (every action that changes `counting`
   or a backing ends here with the run check, refunds included).
6. A payment goes to the run's claimant, at or after `runSince + RUN`, before `refundsFrom`, and the claim qualified at
   every action since `runSince` (a ghost records each action's state).
7. No money came in while a run was on.
8. After the first refund of a bounty, it is never paid.

Plus one test per row of the boundary table on both sides of each comparison, the example in change 1 (two claims
could qualify under the old rule; under this one only B does), and a mutation-check entry for each guard, as N1 has.

## Walked through

1. **The usual case.** Day 0: Ben turns his post into a bounty, 50 USDC, deadline day 30. Day 3: Cara adds 50 (100
   counting). Day 10: Dev files a claim. Day 11: Ben backs it (50 of 100: exactly half, not a majority). Day 12: Cara
   backs it (100 of 100): the run starts, money is paused. Day 21: anyone pays Dev 100.
2. **Stopped in time.** As above, but on day 17 someone posts that Dev's photos are copied. Cara withdraws her backing:
   50 of 100, the run ends, money can come in again. Nothing was paid.
3. **One big funder.** Ben 100, Cara 10. Ben backs Dev alone: 100 of 110, a run. Ben decides alone; the page says so.
4. **A run across the deadline.** A run starts on day 29 of a 30-day bounty. Day 30: nothing new, but the run goes on
   and is payable on day 38. If Cara withdraws her backing on day 33, the run ends and refunds open that moment.
5. **Nobody agrees.** Two claims, backing split 40 and 40 of 100. Day 30: refunds open; each funder takes back their
   own.
6. **Everyone is a claimant.** All funders file claims: `counting = 0`, nothing qualifies, refunds open at the deadline.
7. **The currency refuses the claimant.** The run is payable but every `pay` fails. On day 53 (`refundsFrom` = 30 + 9 +
   14) refunds open and funders take their money back.
8. **A funder files a claim to change the count.** Eve (30 of 100, backing nothing) files a claim: `counting` falls to
   70, and a claim backed by 40 now has a majority. Nothing starts by itself; anyone can press **Start the wait**. Eve
   could have backed that claim instead, so filing gives her no power she did not have. If she withdraws her claim, her
   30 counts again, and the run may end.

## Off chain

- **The words and the evidence (changed when built).** The spec had them in new server records. Built, they are in the
  contract's own `BountyOpened` and `ClaimFiled` events (at most 1,000 bytes each), with their keccak-256 hashes in
  storage; the page shows the words only when they hash to `wordsHash`. Nothing but the chain is needed to read a
  bounty, no new record kind was registered, and a claim's evidence cannot be changed after it is filed.
- **One unreachable check removed.** The helper that starts a run in the same step as a backing or a payment had its
  own deadline check, but every caller (`open`, `fund`, `back`) already refuses after the deadline, so a mutation of it
  could never be caught; the invariant `runSince < deadline` holds the rule instead. Likewise `withdrawClaim` relies on
  the run check (a withdrawn claim never qualifies) instead of ending the run itself.
- **Moderation.** A board's moderators can hide a claim or a post in the app (D94). The contract does not know: a hidden
  claim keeps its backing, can still be paid, and its page shows its money state. Moderation never decides who gets
  money.
- **Discovery.** `BountyOpened` indexes `post`, so a post's page finds its bounty with one log read.

## What the page says (draft, plain words)

| State | Line |
|---|---|
| Open | Takes money and work until {deadline}. The work most of the money backs for nine days is paid. |
| Running, agreeing | Most of the money backs {name}'s work. If it stays that way, it is paid on {payableAt}. No new money until then. |
| Running, on hold | Agreed. {name} is paid on {payableAt} unless the backing drops. |
| Payable | {name}'s work kept its backing. Anyone can pay it now. |
| Paid | Paid {total} to {name}. |
| Refunding | No work kept a majority in time. Everyone can take their money back. |
| Open, a claim qualifies with no run | {name}'s work has most of the money behind it. **Start the wait** |

Each claim shows the share of counting money that backs it, and the funder's own button: **Back this**, **Move my
backing here**, or **Withdraw my backing**.

## Events

`BountyOpened(id, post, creator, wordsHash, deadline, refundsFrom)`, `Funded(id, funder, amount, total)`,
`ClaimFiled(id, claim, claimant, evidenceHash)`, `ClaimWithdrawn(id, claim)`, `Backed(id, funder, claim, amount)`,
`Unbacked(id, funder, claim, amount)`, `RunStarted(id, claim, since)`, `RunEnded(id, claim)`,
`BountyPaid(id, claim, claimant, amount)`, `Refunded(id, funder, amount)`.

## Limits we state on the page

- A funder with more than half the counting money decides alone.
- Wallets are not people: a claimant's second wallet can fund and back their own claim.
- Funders who do nothing count as not backing, so a bounty whose funders stay away refunds.
- Claims cost only the network fee; there is no deposit, so a bounty can collect many claims. The page lists claims
  with backing first and the newest after them.

## Open questions for review

1. **Majority of all counting money, or of the money that backs any claim, with a minimum turnout?** This spec counts
   absent funders as not backing (simple, and a few people cannot decide for a pot others filled), at the cost of
   bounties whose funders never come back. poidh counts only those who vote.
2. **Pause money during a run, or the late-money rule with lazy bookkeeping?** The pause is chosen above for
   simplicity; the alternative keeps the pot growing during a run.
3. **The numbers:** nine days, fourteen days of grace, a 365-day ceiling.
4. **Should the creator be able to close the bounty early** (refunds at once) while no run is on? Not in this spec: it
   would let a creator cancel when a claim they dislike is gaining backing.
5. **Contests, rewards for past work and payment in steps** stay parked until this mode has run.
