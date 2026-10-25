# A next-gen DAO: from a post to a funded project, in three stages (proposal, 2026-10-25)

Status: **a proposal. Nothing here is decided or built.** Ten pieces in three stages, each with its own proposed
decision row (N1 to N10), its own contract work, audit scope and, where money moves, a legal read. Accepting one does
not accept the others. It follows the funding curve proposal ([JOIN-CURVE.md](JOIN-CURVE.md), asset rule decided as
D112), the forecasts plan ([MARKETS-AND-EXIT-PLAN.md](MARKETS-AND-EXIT-PLAN.md)), two outside reviews and the poidh
articles, all on 2026-10-25 (see [What changed](#what-changed)).

## In one paragraph

Creaton tells one story nobody else tells end to end: **a post becomes a funded bounty, the bounty becomes a project,
the project raises on delivery.** poidh stops at the bounty; MetaDAO and Umia start at the raise. Most of the route is
built (Home, boards, work areas, reviewed submissions, contributor projects). **Stage 1** adds the missing first step:
"Fund this" bounties, "Will it get done?" forecasts without money, and a runway card. **Stage 2** gives $CREATE its
first real job, a court that settles disputes, then money forecasts and matched exits. **Stage 3**, after the audited
raise, adds payouts, pledges to the next milestone and remixes.

## Where we stand against poidh, MetaDAO and Umia

| | poidh | MetaDAO | Umia | Creaton with these pieces |
|---|---|---|---|---|
| Where it starts | A bounty anyone can fund | A raise | A raise | A post, then a bounty, a project, a raise |
| Who decides | Funders, weighted by money, on a claim the bounty's creator picks | Markets on the token's price | Markets on the token's price over a three-day average, against doing nothing | Funders or reviewers first; the $CREATE court on appeal (stage 2) |
| Fraud window | None: paid 48 hours after the vote | Not applicable | Not applicable | A 7-day hold in which the decision must keep its majority |
| Insiders paid | Not applicable | Performance packages unlocking as the price rises | Vesting over time or at price milestones | Milestone locks, checked against written words |
| Getting money out | Refund if nothing is done | Sell on the market; holders can vote to return capital | Sell on the market; markets decide liquidation | Refund if nothing is done; leave at any time with your part; matched sales (stage 2) |
| Discussion | External channels | External channels | External channels | Built in: Home, boards, rooms, moderation |
| Legal entity | Not stated | IP assigned to an entity the market controls | Cayman entity on MetaLex BORG | An IP record only (D38): **a gap to close before raises** |

## Rules every piece keeps

1. **Leaving stays as it is** (D73): anyone can give up Shares for their part of the treasury at any time. No queue,
   payout, bonus or market can block it.
2. **Earned claims survive everything social.** A payout, a refund, a forecast win or a court fee stays claimable
   after a ban, a removal or leaving the community.
3. **Every step has a deadline and a way to finish without us.** Rulings, refunds, releases and payouts can be
   triggered by anyone once their time has come.
4. **No admin, no pause, no confiscation.** Contracts are fixed at deployment; penalties are agreed at birth and
   decided by the court.
5. **Collateral matches what is at stake** (stage 2 on). $CREATE is the stake that makes someone eligible for a paid
   job and the first thing slashed. A stake covers a capped total of open cases, not each in full. Cases that move
   large sums also need sale-currency collateral. Bonds are sized in dollars from a price source with rules for stale
   or missing prices (refuse new cases; never abandon assigned ones).
6. **Testnet first, the "unaudited" notice on every flow that moves money, mainnet off** until audits and counsel.

# Stage 1: with contributor projects (testnet)

What it proves: people will put money behind a written outcome, someone delivers it, and it can grow into a project.

## 1. "Fund this" bounties (N1)

### What it is

Any post on Home or a board, and any work area in a contributor project, can become a bounty: written words for what
"done" looks like, a deadline, and a pot of USDC that anyone can add to. If someone delivers, they are paid; if nobody
does by the deadline, every funder gets their money back. The bounty exists only for the task, then closes.

### Creating and funding

- **The creator** writes the "done looks like" words, sets the deadline and picks a mode (below). The words are fixed
  by fingerprint when the first money arrives, so nobody funds one thing and gets judged on another.
- **Anyone can add USDC.** Each funder's amount is recorded for their refund and their vote.
- **Money stays in until the bounty pays or refunds.** People who do the work can rely on the pot not vanishing
  halfway. The page says this before anyone funds.

### Modes

| Mode | Paid to |
|---|---|
| One winner | The first claim that is accepted |
| Contest | The top entries by funders' vote at the deadline, split as set at creation (for example 70/30) |
| Reward for something done | A claim proving something that already happened (evidence may predate the bounty) |
| In steps | Each step has its share of the pot and its own proof; nothing is ever paid on a plan |

### Claims and the decision

- **Anyone can file a claim** with evidence (an upload and text), behind a small spam deposit that is returned when
  the bounty ends unless the board's moderators removed the claim as spam (with the public log, D94).
- **The creator or any funder can put a claim to a vote,** not only the creator. One vote at a time.
- **Funders vote by the amount they put in.** A claim is **accepted** when more than half of the voting weight says
  yes for 48 hours, with a minimum turnout. A claimant's own funding does not count on their own claim.
- **Then a 7-day hold** (the D44 pattern): funders can still change their vote, and the claim pays only if it keeps
  its majority to the end. A claim that falls apart on new evidence, as poidh's failed Gaza bounty did, stops before
  any money moves.
- **Anyone can then trigger payment.** If a claim is still in its hold at the deadline, the bounty waits for it, up to
  a fixed limit.
- **After the deadline with nothing accepted,** anyone can trigger the refunds.

### Work-area bounties

In a contributor project, outside funders can put USDC on a work area. The condition is the project's own: the pot
pays the contributor whose submission for that work area is accepted and still stands when its 7-day challenge window
ends, by the deadline; otherwise it refunds. Funders rely on the project's reviewers (with D39's independence rules)
instead of voting themselves. Today `ClaimStake.fund` takes money only from the treasury and returns it there, so this
needs the bounty contract's own record of each funder.

### Keep going as a project

After a bounty pays, its creator or the person who delivered can start a contributor project prefilled from it: the
words, the people, the bounty shown as its first finished work, and the creator credited as finder (D37). No money
moves; funders paid for an outcome and are not owed Shares.

### What it builds on, and what is new

Built: posts, boards and moderation, Needs you notices, uploads, wallets and passkey accounts, test USDC, profiles.
New: **one escrow contract** holding every bounty (no admin, no fee in stage 1), event kinds for the bounty record and
its claims, and a bounty history on profiles (created, funded, claimed, accepted, refunded).

### Legal

Lighter than payouts or betting: funders pay for an outcome and are refunded if it does not happen, and nobody earns
a return on money. Holding funds and contest rules in some places are still questions for counsel.

## 2. "Will it get done?" forecasts without money (N2)

- **On every bounty and every work area:** each person gives a percentage and a short reason, as a signed post. They
  can revise it until a cutoff (when the first vote opens, or a day before the deadline); every version is kept.
- **It settles on the recorded outcome:** the bounty paid by its deadline, or the work area's submission still
  standing at the end of its window. The app publishes the outcome when it resolves.
- **Shown:** the middle forecast and how many people gave one. On a profile, accuracy beside the number of resolved
  questions, computed by the browser from public posts, so anyone can check it. No ranking unless the person opts in.
- **People involved** (creator, claimants, reviewers) can forecast and are marked as involved.
- **No money, no extra votes, no say in who is chosen.** It is where money forecasts plug in later (piece 5).

## 3. The runway card (N3)

On the DAO's front page: money that came in (the D82 card), money committed to work, spendable cash, spending over
the last three months, months left at that rate, and outside bounty money waiting on the project's work areas.
**Committed means moved**: an approved work budget leaves the DAO when its mandate is created
([TreasuryMandate.sol](../../contracts/src/TreasuryMandate.sol), `safeTransferFrom` into the mandate), so leaving cannot
take it. A label or a pending proposal protects nothing, and no vaguely named reserve is left out of what leaving pays.

# Stage 2: with $CREATE (before or with the raise)

What it proves: disputes can be settled by people with nothing riding on the project, which makes money on outcomes
safe enough to try, and holders can get cash without draining a treasury.

## 4. The $CREATE court (N4)

### What it decides, in order

1. **Bounty appeals:** a claimant whose claim was voted down, or a funder who disputes an acceptance during its hold.
2. **Second opinions on contributor submissions**, when someone disputes a reviewer's verdict. The DAO's freeze vote
   stays (`TreasuryMandate.freezeClaim`).
3. **Team milestones (raise path).** Today a holder objects with a deposit (10% of the team's bond, which is 1% of the
   raise target) and holders vote; an upheld objection pays the objector the deposit back plus half the bond
   ([MilestoneChallenge.sol](../../contracts/src/MilestoneChallenge.sol)). With the court, the objection and deposit
   stay and the **court rules** instead of a vote of holders, so holders who bet against a milestone cannot vote to
   uphold their own bet. Leaving before every unlock stays (D72). This changes an agreed backer protection.

Every case is judged against words fixed in advance: a bounty's "done looks like", a submission's acceptance check
(`checkHash`), a milestone's check.

### How it works

Built on [Kleros v2](https://github.com/kleros/kleros-v2) rather than designed from a feature list: draws weighted by
stake, sealed votes (commit, then reveal), appeals to larger panels, deadlines, redraws for jurors who do not reveal,
and a random number fallback. A verified Kleros v2 contract is marked MIT; **check the whole repository's license**
before adapting it. Certora has [audited Kleros v2](https://www.certora.com/reports/kleros-v2).

- **Stake:** $CREATE, locked while a juror is assigned and for a period after.
- **Pay:** whoever opens a case pays a fee (USDC or $CREATE), returned if they win; jurors who vote with the final
  ruling share the fee and part of the stake of those who did not.
- **Appeals:** each round draws a larger panel and costs more; the last round has a fixed deadline.
- **The standard arbitration interface,** so a project can name the Creaton court (default) or another one.

Today's [VerifierSet](../../contracts/src/VerifierSet.sol) is an owner-approved reviewer list with a quorum and slashing
the owner authorizes; the court is a new trust model, not an extension of it.

### Limits we accept and show

- **Stake buys influence.** With three seats drawn by stake with replacement, someone holding 30% of the stake holds
  at least two seats 21.6% of the time. Larger panels and appeals reduce this; nothing removes it.
- **Losing on appeal is not proof of lying.** Jurors are paid for agreeing with the final ruling, which rewards
  guessing what others will think; Kleros's research covers this.
- **A bribe can exceed a stake,** hence the exposure caps and the market caps in piece 5.
- **Someone can still deliver late on purpose.** The court judges what was delivered, not why.

## 5. Money forecasts (N5)

### Questions and settlement

| Question | Settles on |
|---|---|
| "Will this bounty be paid by date D?" | The bounty contract's own record; if appealed, the court's final ruling |
| "Will this submission be released by D and still stand when its 7-day window ends?" | `releasedAt` and its status at the end of the window; if disputed, the final ruling |
| "Will tranche 2 be accepted, with evidence submitted by D?" | When the evidence was submitted, and the final ruling |

Settling on **when evidence was submitted** and **the final ruling** means a dispute that takes weeks cannot flip a
result. Two contract gaps first: a submission records `releasedAt` but not when it was frozen, and the milestone lock
must record when evidence was submitted. No final ruling by a deadline means everyone is refunded.

### The market

- **Two-sided pools in USDC:** Yes and No pools, winners split the losing pool. No market maker, no selling of
  positions, no DAO money.
- **Betting closes when a vote opens or evidence is published.** The court skips jurors holding a position.
- **Barred:** a bounty's creator from the No side; a submission's team and reviewers; drawn jurors. The contract
  checks wallets; second wallets cannot be stopped, and the page says so. A funder who votes down a good claim to win
  a No bet loses on appeal.
- **Caps:** per wallet, and per question no more than the court stake that would decide it.

### Rewards for accuracy

Paid from platform fees, a **fixed amount per point of score**, `k × (1 − (forecast − outcome)²)`, never a share of a
pool: a share of a pool can reward shading a forecast (against a 60% rival, an honest 60% expects 50 of a 100 prize;
reporting 55% expects about 50.08). Each question has a capped budget. **An eligible account stakes a small amount of
$CREATE,** so a hundred accounts cost a hundred stakes.

## 6. Matched exits (N6)

Leaving is the only way to cash while transfers are locked (D77), so holders who believe in a project still leave when
they need money. Leaving does not lower anyone else's part (100,000 USDC over 1,000 Shares is 100 each before and
after someone leaves with 100 Shares); it lowers the project's cash. A matched exit keeps the cash in.

- A holder posts an offer; a buyer fills it. **Atomic:** USDC to the seller and Shares to the buyer in one
  transaction, from Shares held by the exit contract.
- **Price:** the seller's minimum, never below what leaving would pay at the moment of the fill.
- **Expiry and cancel;** no double fills; after cancelling, the seller can leave directly.
- **Votes:** the seller's placed support is trimmed as on any change of ownership (`ownershipChanged`); the buyer starts
  with none and cannot vote on proposals opened before the purchase.
- **One narrow exemption** in `Shares` for the exit contract; in a DAO with a funding curve, the same contract sells
  both kinds.
- **Buyers choose** between buying from the project (the curve, which funds it) and from a leaver (which pays the
  leaver), and the page says which funds the project. A matched sale is never reported as money raised.

For contributor projects this matters most: their treasuries are often small, so a matched sale is how earned Shares
become cash. It opens a controlled market for those Shares, so it has to meet the bar in
[CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md).

## 7. $CREATE: its first jobs and its launch (N7)

**Its jobs in stage 2,** each paid work with a stake at risk:

| Job | Paid by | Slashed for |
|---|---|---|
| Juror stake | Case fees | Voting against the final ruling; not revealing |
| Forecast reward eligibility | Accuracy rewards | Nothing; the stake makes farming expensive |
| Reviewer and contributor bonds, when a work budget asks for them (USDC still accepted, D39) | Review fees | As today |

Platform fees (a small cut of paid-out bounties, court and market fees) go to active stakers for their work, part to
buying back and burning $CREATE, part to the platform treasury. Newcomers can pay for any service in USDC without
holding $CREATE.

**The launch is its own decision,** after counsel and with a legal entity. To answer there:

- **What $CREATE is:** a separate token, or the Shares of a Creaton DAO (with that DAO's exit floor and trading opened
  by vote). Either way the court needs it to move into staking and needs a price for dollar sizing.
- **How it is first held:** sold through Creaton's own auction and funding curve, earned through work on Creaton, or
  both. The example project ([CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md)) is a testnet project with no
  sale, and its test records will not carry over.
- **Before it has a market,** court stakes use fixed amounts and cases stay small.

# Stage 3: after the audited raise

What it proves: a successful project can share what it earns, fund delivery in stages, and be built on.

## 8. Payouts (N8)

A $10,000 payout lowers the treasury exactly as a $10,000 exit does. What it adds: the DAO controls when and how much,
and holders get cash without giving up Shares. This revises **D78** (no automatic payouts) and **D82** (the revenue
pledge is a statement the contracts do not enforce).

- **Revenue** is only money arriving at a revenue address the project publishes for customers and payment services. A
  contract cannot make an offchain business send money, so remitting stays a written commitment (D78, in the D38
  documents). Raise proceeds, refunds, returned budgets, recovered bonds and transfers between the project's own
  accounts never count.
- **The split** is set at launch and changeable by vote with notice: a part to work budgets, a part to payouts, the
  rest to the treasury. One-off payouts can be declared by vote.
- **Who is paid:** the same base leaving uses: every Share **and Loot**, less the DAO's own, less locked team Shares
  (D72), less what the funding curve may still sell. **Locked team Shares earn nothing until their milestone unlocks.**
- **Never paid twice:** a declared payout moves into the payout contract when it is declared, so leaving cannot pay it
  again. A running total per Share, updated through the hook the DAO already calls for every Shares and Loot change
  (`ownershipChanged`), credits whoever held at each payout. Credited amounts survive leaving, bans and moderation.
- **Kept separate from work:** making people forecast to receive a payout does not change what it is, and would fill
  forecasts with low-effort entries. **This piece needs counsel more than any other.**

## 9. Pledges to the next milestone (N9)

Backers pledge USDC toward the next milestone. The pledge sits in escrow and:

- **is released to the treasury** when the milestone before it is accepted by its deadline, and the backer receives
  Shares **from the funding curve's allocation** at the price fixed in the pledge's terms; no new Shares are made
  (D76);
- **is refunded** if that milestone is not accepted by the deadline;
- **can be withdrawn** until the milestone's evidence is submitted, then waits for the ruling.

Anyone can trigger release or refund. A follow-on raise works the same way: the curve opens a new part of its
allocation only after a verified milestone.

## 10. Remixes (N10)

Someone who builds on a project pays the original back, and the original shares in the remix's success.

- **Remix terms** sit in the original's launch record beside its IP record (D38): whether remixes are allowed, what a
  remix gives back, and what it gets (use of the name, code and assets; an announcement to the original's community).
  The original's DAO can change them by vote; each remix keeps the terms it launched under.
- **"Build on this" is open by default:** anyone who accepts the terms can remix without asking. Bigger deals (the
  brand, a joint launch) go to the original's vote.
- **The launch kit enforces the terms at birth.** The parent gets a part of the remix's starting supply as **Loot**
  (an economic share with no vote), for example 5%, **locked** until the remix's first accepted milestone or a set
  time, so the parent cannot leave on day one with part of its raise. Optional: a revenue share through the remix's
  split (piece 8) and a fee on its raise. It comes from the starting supply because D76 allows new Shares later only
  as pay for reviewed work.
- **Only the direct parent is paid.** The grandparent is paid through the parent's own share, so remixes of remixes
  stay worth starting.
- **Once Shares trade,** an apptoken can carry the parent's cut on every trade in every pool. The remix's own DAO
  owns its token's rules today, so the parent's cut is fixed at birth for its term and changes only with the parent's
  consent.
- **A remix bond** in $CREATE (plus USDC for large remixes) is posted at launch. If the court rules the remix broke its
  terms, for example by stopping the revenue share, the bond goes to the parent and the parent's Loot unlocks at once.
  The page then says "broke its remix terms with X" and drops "Built on X". Nobody's tokens are taken and leaving stays
  open.
- **Why use the button instead of copying:** "Built on X" on the page and on Discover, the original's community told,
  its holders able to back the remix with pledges, its contributors invited across. A copy elsewhere costs nothing,
  so the button has to be worth more than its terms.

Prior art: Story Protocol's on-chain licences with royalties for derivatives (not used,
[project-ip.md](../project-ip.md)). The lesson is that recording a licence does not stop copying elsewhere; the value
has to come from the platform.

# Parked

Ideas from the same discussion, kept out until there is a reason to add them:

| Idea | Why it waits |
|---|---|
| A remix licence for copies made outside Creaton ("source available", turning open after some years like the Business Source License) | Enforced in court by whoever holds the IP, so it needs the legal entity first |
| A stay bonus on payouts | Rewards holding but does not secure runway; adds accounting to piece 8 |
| An exit fee for new projects | Changes what leaving pays; matched exits address the same need |
| Vouching for accounts with a $CREATE stake | Needs a precise rule for double claims and must allow separate personal, work and agent accounts |
| Curation stakes on Discover | Useful once there are many projects to sort |
| Founder launch bonds | Useful with raises; sizes must not shut out small founders |
| Moderation appeals to the court | Cheap once the court exists; not needed to prove it |
| Platform governance by $CREATE beyond fees and court rules | Grows with the platform |
| A backstop pool repaying backers after fraud | An insurance system: reserves, exclusions, correlated losses |
| Early auction access for stakers | Fairness and onboarding cost |
| Markets that choose contributors | Advisory only until their own mechanism is designed and tested |

**Never:** a platform power to shut down a DAO or confiscate tokens; making backers wait to leave while they support a
spend (dropped after review: leaving already removes their support, and the vote is checked again before a spend runs).

# Proposed decision rows

| ID | Question | Proposal | Why | Risk |
|---|---|---|---|---|
| N1 | Bounties? | One escrow contract: fixed words, open USDC pots, claims behind a spam deposit, any funder can open a vote, 48-hour majority then a 7-day hold, refunds after the deadline; four modes; work-area bounties; keep going as a project | The first step of the route; cash for contributor projects | Medium: a new contract holding outside money |
| N2 | Forecasts on delivery, first without money? | Signed percentages with reasons on bounties and work areas, accuracy shown with the count | Visible, cheap, the base for money forecasts | Low |
| N3 | Show runway? | A card on the DAO's front page; committed means moved | Holders see the project's cash, not just its treasury | Low |
| N4 | Who settles disputes? | A $CREATE court adapted from Kleros v2: bounty appeals, then submissions, then milestone objections | Separates who decides from who owns or bets | High: a new trust model and the largest contract surface |
| N5 | Money forecasts? | USDC two-sided pools settling on the final ruling; creator, team, reviewers and jurors barred where they control the outcome; caps tied to court stake | Lets skeptics act on doubt with money | High: legal, manipulation |
| N6 | Cash without draining a project? | Matched exits at no less than what leaving pays; buyers choose curve or leaver | Turns cash needs into sales to newcomers | Medium: a narrow exemption to D77 |
| N7 | What does $CREATE do first, and how does it launch? | Juror stakes, forecast eligibility, bonds; fees to active stakers and buyback; launch decided separately with counsel and an entity | A token with a real job from day one | High |
| N8 | Payouts? | A revenue address with a launch-set split; payouts moved out at declaration; Shares and Loot on the exit base; locked team Shares excluded. Revises D78 and D82 | Cash without leaving, at a pace the DAO controls | High: legal weight, accounting |
| N9 | Fund delivery in stages? | Pledges released on an accepted milestone by a deadline, refunded otherwise; Shares from the curve allocation | Money follows delivery | Medium |
| N10 | Remixes? | Remix terms, open by default; locked Loot for the parent; optional revenue share; direct parent only; apptoken cut fixed at birth; remix bond decided by the court | Building on a project pays the original | Medium |

# Tests that would decide it

- **Bounties:** what is paid plus what is refunded equals what was funded; money leaves only by payout or refund; a
  claim pays only after a 48-hour majority and a 7-day hold that keeps it; a claimant's own funding never counts on
  their claim; refunds work after the deadline with no operator; a contest's split always sums to the pot; the
  waiting limit for a claim in its hold cannot be exceeded.
- **Forecasts without money:** a forecast revised after the cutoff never counts; accuracy computed in the browser
  matches the published outcome.
- **Court:** every case reaches a final ruling or a refund by its deadline; a juror's stake cannot leave while
  assigned; open exposure never exceeds a juror's cap; a juror holding a position is never drawn.
- **Money forecasts:** payouts never exceed stakes plus the reward budget; a dispute's length never changes a result.
- **Matched exits:** fills are atomic; no offer fills twice; the price is never below what leaving pays; direct
  leaving works with no buyers; the treasury is unchanged by a fill.
- **Payouts:** declaring leaves the DAO's balance plus the payout contract's balance unchanged; leaving after a payout
  does not pay it again; locked team Shares accrue nothing; a claim survives leaving and a ban.
- **Pledges:** release only after acceptance by the deadline; refund after it, triggered by anyone.
- **Remixes:** a remix cannot launch without its parent's Loot; the parent's Loot cannot leave before its unlock; the
  remix's DAO cannot remove the parent's cut alone; a breach ruling pays the bond to the parent.

# Trust (CROPS)

- **Censorship resistance:** bounties, the court, appeals and every refund finish without the operator; moderation
  never touches earned claims, refunds or direct leaving.
- **Open:** contracts, event formats, scoring and ruling rules published with the source; forecasts are signed posts
  anyone can rescore; a project can name another court.
- **Free:** Kleros v2's license to be checked before adapting it; first-party contracts stay MIT.
- **Privacy:** bounties, forecasts and disputes can link accounts; participation is voluntary, visibility is stated,
  separate accounts are allowed.
- **Security:** stake concentration and the $CREATE price can weaken judging and collateral together; exposure caps,
  sale-currency collateral for large cases and deadlines are the limits. Accounting keeps payouts and leaving from
  paying the same money twice.

# Open questions

1. Bounties: the spam deposit's size, who removes spam on a bounty outside a board, the minimum turnout for a vote,
   and how long a claim in its hold may extend a deadline.
2. Does the court replace the holder vote on objections for every new project, or does a project choose at launch?
3. Which price source sizes $CREATE bonds, and above what amount does a case need sale-currency collateral?
4. Which contract records when evidence was submitted and when a submission was frozen?
5. How long do unclaimed payouts stay claimable?
6. Where do pledge Shares come from in a project without a funding curve?
7. Is $CREATE a separate token or the Shares of a Creaton DAO?
8. What share and lock should remix terms suggest by default?

# What changed

**Put in stages (2026-10-25):** the earlier seven pieces were reordered into three stages, bounties and remixes were
added after the poidh articles and the remix discussion, the pieces were renumbered N1 to N10, and ideas not needed
yet moved to [Parked](#parked).

**From the review of the forecasts plan:**

- Money markets are their own decision (N5), only once their settlement rules are fixed; forecasts start without
  money (N2).
- The cap on market size against the objection deposit is gone: an upheld objection is paid, so it set no cost.
- Raising the objection bar when a market exists is gone: a forecast cannot weaken a backer protection.
- The backer-exit wait is dropped: leaving trims support, a lost threshold resets the queue, and the vote is checked
  again before a spend runs.
- "Approved and not frozen by D" cannot be rebuilt from today's records; the gaps are listed in piece 5.

**From the review of the follow-up conversation:**

- A court improves separation; it does not make forecasts safe. Its limits are in piece 4.
- VerifierSet is not a court; the court builds on Kleros v2's prior work.
- $CREATE collateral is capped by exposure and backed by sale-currency collateral for large cases.
- Paying a share of a pool by score is not truth-telling; a fixed rate per point is.
- Leaving lowers the project's cash, not anyone's part; a payout lowers it just as much.
- Committed money is money moved into a mandate, not a label.
- A matched sale raises nothing for the project; buyers choose.
- Payouts include Loot, exclude locked team Shares and move out at declaration.
- Vouching (parked) would ban double claims, not separate accounts.
- No claim that competitors lack a community; the difference is the route from a post to verified ownership.
- Launching $CREATE is its own decision; the example project is a testnet project with no sale.

**From the poidh articles:** the bounty's creator no longer decides alone which claim is voted on; acceptance must hold
through a 7-day hold, so a claim like the failed Gaza one can be stopped; work is paid on proof, never on a plan; and
their wish list (notices, spam moderation, discussion, card payments, help writing) is mostly built here already.

# Sources

[poidh](https://poidh.xyz) and two articles by its founder (pasted 2026-10-25: "the marketplace of ideas needs a
marketplace for outcomes", "the ephemeral DAO machine"),
[MetaDAO docs](https://www.metadao.com/docs), [Variant on MetaDAO](https://variant.fund/articles/investing-in-metadao/),
[Lightspeed on MetaDAO launches](https://lightspeed-4bed7b.beehiiv.com/p/unruggable-icos),
[Umia docs](https://umia.finance/docs), [Umia decision markets](https://umia.finance/docs/decision-markets),
[Kleros whitepaper](https://kleros.io/whitepaper.pdf),
[Kleros research on juror incentives](https://blog.kleros.io/incentivizing-jurors-to-honestly-report-uncommon-answers-deposit-sizes-lazy-strategies-and-peer-prediction/),
[Kleros v2](https://github.com/kleros/kleros-v2), [Certora's Kleros v2 report](https://www.certora.com/reports/kleros-v2),
[Forecasting competition research](https://pubsonline.informs.org/doi/10.1287/mnsc.2022.4410), and the SEC
interpretation the second review cites ([March 2026](https://www.sec.gov/files/rules/interp/2026/33-11412.pdf)).
