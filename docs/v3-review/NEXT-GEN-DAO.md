# A next-gen DAO: from an idea to paid work, ownership and staged funding (proposal, 2026-10-25)

Status: **a proposal.** Stage 1 is built for test networks: N1 and N2 (D113, D114, 2026-10-25), N3 and N4 (D115, D116,
2026-10-26). Nothing in stages 2 and 3 is decided or built. Twelve pieces in three stages, each with its own proposed
decision row (N1 to N12), its own contract work, audit scope and, where money moves, a legal read. Each piece can be
released on its own; accepting one does not accept the others. It follows the funding curve proposal
([JOIN-CURVE.md](JOIN-CURVE.md), asset rule decided as D112), the forecasts plan
([MARKETS-AND-EXIT-PLAN.md](MARKETS-AND-EXIT-PLAN.md)), three outside reviews and the poidh articles, all on
2026-10-25 (see [What changed](#what-changed)).

## In one paragraph

The route: **an idea gets money behind it, someone does the work and is paid, the work grows into a project its
contributors own, and the project raises again on what it delivered.** Most of it is built (Home, boards, work areas,
reviewed submissions, contributor projects). **Stage 1** adds money behind work: bounties on work areas, then open
bounties on posts, forecasts without money and a clear runway card. **Stage 2** adds matched exits, decides what
$CREATE is, then builds a $CREATE court and tries money forecasts. **Stage 3**, after the audited raise, adds pledges
to the next milestone, payouts and remixes.

## How it compares (products as documented on 2026-10-25; Creaton's column is planned unless marked built)

| | poidh | MetaDAO | Umia | Creaton |
|---|---|---|---|---|
| Where it starts | A bounty anyone can fund | A raise | A raise | A post or a work area (built), then bounties (planned), a project (built), a raise |
| Who decides | Funders, weighted by money, on a claim the bounty's creator picks | Markets on the token's price | Markets on the token's price over a three-day average, against doing nothing | Reviewers (built) or funders; the $CREATE court on appeal (planned) |
| Fraud window | None described: paid 48 hours after the vote | | | A 7-day wait before payment (built for submissions; planned for bounties) |
| Insiders paid | | Performance packages unlocking as the price rises | Vesting over time or at price milestones | Milestone locks checked against written words (built) |
| Getting money out | Refund if nothing is done | Sell on the market; holders can vote to return capital | Sell on the market; markets decide liquidation | Leave with your part of the treasury (built); bounty refunds and matched sales (planned) |
| Legal entity | Not stated | IP assigned to an entity the market controls | Cayman entity on MetaLex BORG | An IP record only (D38): **a gap to close before raises** |

Sources are at the end. A blank cell means the docs we read do not describe it, not that the product lacks it.

## Rules every piece keeps

1. **Leaving stays as it is** (D73): anyone can give up the Shares they hold free of a lock for their part of the
   treasury, at any time. Locked team Shares (and, in N12, a parent's locked share) are not free until unlocked, and in
   a DAO with a funding curve leaving pays only the sale's currency (D112). No queue, payout, bonus or market can block
   it.
2. **Earned money survives everything social.** A refund, a payout, a bounty prize or a court deposit stays
   withdrawable after a ban, a removal or leaving the community, and moderation never decides who gets money.
3. **Every step has a deadline and a way to finish without us.** Releases, refunds, rulings and payouts can be
   triggered by anyone once their time has come.
4. **Each piece keeps its own books.** At every moment `funded = paid + refunded + still held`, with fees and deposits
   counted separately. People withdraw what they are owed themselves, so one recipient who cannot receive USDC never
   blocks anyone else.
5. **No power over money in escrow or over open cases.** Contracts we write have no admin and no pause. The court's
   settings (stage 2) change only by platform vote with notice and never for a case already open. Nobody can shut down
   a DAO or take anyone's tokens.
6. **Collateral matches what is at stake** (stage 2 on): see the court.
7. **Testnet first, the "unaudited" notice on every flow that moves money, mainnet off** until audits of our own code
   and counsel. An upstream audit does not cover a fork.
8. **A stage opens only after the one before passes its evidence gate** (below), not just its tests.

# Stage 1: money behind work (with contributor projects, testnet)

What it proves: people put money behind written work, someone delivers it, and refunds work when nobody does.

## 1. Bounties on work areas (N1)

The simplest first release: no vote, no new way of deciding. Outsiders add USDC to a contributor project's work area,
and the project's own review decides, as it already does for Shares.

- **Funding:** anyone adds USDC to a work area until the bounty's deadline (at most the work area's own "open until"
  date). Each funder's amount is recorded. Money stays in until the bounty pays or refunds, and the page says so first.
- **Pays:** once a submission for that work area (`claimProject`, recorded by the mandate) was released by the
  deadline and its 7-day challenge window has ended while it is still approved or paid, anyone can settle the bounty.
  The whole pot is credited to that submission's contributor, who withdraws it. One payout per bounty: the first
  submission to settle.
- **Refunds:** if nothing has settled by the deadline plus the challenge window plus a fixed waiting limit for frozen
  submissions, anyone can switch the bounty to refunds, and each funder withdraws their own amount. A submission frozen
  at that point never pays this bounty.
- **Trust:** funders rely on the project's reviewers, under D39's independence rules. The bounty records the work
  area's mandate and checks it against the mandate factory, so a made-up mandate cannot be funded.
- **Why it is separate:** `ClaimStake.fund` takes money only from the treasury and returns it there; a bounty needs its
  own record of each funder.

## 2. Open bounties on posts, one winner (N2)

Any post on Home or a board can become a bounty: written "done looks like" words, a deadline and a USDC pot. **Only
the one-winner mode** at first; contests, rewards for past work and payment in steps come once this one has run.

### The rules

- **Creating:** the creator writes the words and sets the deadline. The words are fixed by fingerprint when the first
  money arrives.
- **Funding:** anyone adds USDC. A funder's weight is the amount they put in.
- **Claims:** anyone files a claim on chain (evidence fingerprint and text), one open claim per wallet, until the
  deadline. No deposit. Moderators can hide a claim in the app; the contract treats every claim the same, and a hidden
  claim's page still shows its money state.
- **Backing, not nomination:** each funder backs at most one claim at a time and can move or withdraw that backing
  until a payment. A wallet with an open claim has no weight at all while its claim is open.
- **Qualifying:** a claim qualifies while its backing is **more than half of the counting money** (what funders with no
  open claim put in). With one count for everyone and one claim per funder, at most one claim can qualify at a time.
  Funders who do nothing count as not backing.
- **48 hours, then 7 days:** a claim must qualify for 48 hours without a break (a dip restarts the clock), then keep
  qualifying through a 7-day hold. Then anyone can trigger payment and the claimant withdraws the pot. New evidence
  during the hold can make funders move their backing, which stops the payment, as poidh's failed Gaza bounty needed.
- **No money in during a run:** while a claim is qualifying or on hold, funding pauses, so nobody can buy or block an
  outcome others were weighing.
- **Deadline:** a claim qualifying or on hold at the deadline runs to its end (at most 48 hours plus 7 days after the
  deadline). Otherwise refunds open at the deadline, and each funder withdraws their own amount.

### The states

`Open` (funding and claims) → `Qualifying(claim)` ⇄ `Open` → `Held(claim)` → `Payable(claim)` → `Paid`; from `Open`
after the deadline, or when a run ends after it, → `Refunding`. Each transition has one condition and anyone can call
it. **Specified in [OPEN-BOUNTY-STATES.md](OPEN-BOUNTY-STATES.md)** and built as D114: every action, every boundary
and the invariants. Writing it out changed five rules: a claimant has no weight at all (otherwise two claims
can both have a majority), money pauses during a run (instead of late money without weight), the two waits are one
nine-day run, backing after the deadline can only be withdrawn, and refunds open once the deadline has passed with no
run on, or at a fixed date.

### Keep going as a project

After a bounty pays, its creator or the person who delivered can start a contributor project prefilled from it, **with
each person's consent**: nobody is added to a DAO, credited as finder or shown as owning Shares without saying yes.
Funders paid for an outcome and are not owed Shares.

### Limits we state

Funder-weighted approval is a chosen trust model: a funder with more than half the pot decides alone, and a
claimant's second wallet can still fund their own claim. These are shown on the bounty page.

## 3. "Will it get done?" forecasts without money (N3)

- **On every bounty and work area:** each person gives a percentage and a short reason, as a signed post. They can
  revise it until a cutoff (when a claim first qualifies, or a day before the deadline); every version is kept.
- **Settles on the recorded end state:** the bounty paid or refunded; the work area's submission settled or not.
- **Shown:** the middle forecast and how many people gave one; on a profile, accuracy beside the number of resolved
  questions, computed by the browser from public posts and outcomes, so anyone can check it. No ranking unless the
  person opts in. Visibility is stated before anyone signs.
- **People involved** (creator, claimants, reviewers) can forecast and are marked as involved.
- **No money, no extra votes, no say in who is chosen.**

## 4. The runway card (N4)

On the DAO's front page, kept apart so nothing is counted twice:

| Line | What it is |
|---|---|
| Money that came in | The D82 card, split by source |
| Free to use | What the DAO itself holds: what leaving draws on |
| Set aside, not yet spent | Budgets moved into mandates, less what they have paid out |
| Spent | Money actually paid to contributors and others; moving money into a mandate is not spending |
| Outside money waiting | Bounty pots on the project's work areas |
| Months left (estimate) | Free to use plus set aside, divided by the last three months' spending; "not enough history yet" before three months, never "unlimited" |

**Set aside means moved**: an approved budget leaves the DAO when its mandate is created
([TreasuryMandate.sol](../../contracts/src/TreasuryMandate.sol), `safeTransferFrom` into the mandate), so leaving cannot
take it. A label or a pending proposal protects nothing.

## Evidence gate before stage 2

Testnet money proves the workflow, not that people will spend real money. Before stage 2: bounties funded by several
unrelated people, some delivered and some refunded, funders disagreeing about a claim, a ban where the person could
still withdraw what they were owed, and people coming back for a second bounty. Then a small real-money pilot, after
counsel.

# Stage 2: cash without draining, and a court

What it proves: holders can get cash without the treasury paying, and disputes can be settled by a panel drawn from
outside the project.

## 5. Matched exits (N5)

Needs neither $CREATE nor the court, so it comes first. Leaving is the only way to cash while transfers are locked
(D77), so holders who believe in a project still leave when they need money. Leaving does not lower anyone else's part
(100,000 USDC over 1,000 Shares is 100 each before and after someone leaves with 100 Shares); it lowers the project's
cash. A matched sale keeps the cash in.

- **Signed offers; the seller keeps the Shares** until a fill. The seller signs an amount, a minimum price, an expiry
  and a number used once. A buyer fills it by sending USDC; one transaction moves the USDC to the seller and the Shares
  to the buyer. Until then the Shares, their votes and any payout stay with the seller.
- **Cancel without us:** offers expire, and the seller can cancel all open offers on chain in one call.
- **The lock still applies:** the exit contract's exemption moves Shares only through the same check that keeps
  locked team Shares in place (`_requireUnlocked`).
- **Votes:** the seller's placed support is trimmed as on any change of ownership (`ownershipChanged`); the buyer starts
  with none and cannot vote on proposals opened before the purchase.
- **Price floor:** enforced only where leaving pays one currency (D112 DAOs), so "what leaving pays" is a single
  number. Elsewhere the offer shows what leaving would pay beside the price.
- **Kept apart from buying from the project:** the curve and matched sales are separate contracts with separate
  authority and separate books, shown on one screen where the buyer chooses; the page says which one funds the
  project. A matched sale is never reported as money raised.
- **What it changes:** a narrow transfer exemption, a change to D77; today `Shares` has one two-way exemption slot (the
  auction), and the curve would add a one-way one. For contributor projects it opens a controlled market for their
  Shares, so it has to meet the bar in [CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md).

## 6. What $CREATE is, decided first (N6)

Decided before any court code, because transfer rules, economic rights and collateral follow from it. **Recommended:
a separate token, not the Shares of a Creaton DAO.**

- A court stake has to move freely into staking and have a market price for sizing bonds in dollars.
- Shares carry a claim on a treasury through leaving, locked transfers and votes. As collateral, a stake that can also
  be cashed out of a treasury tangles the court with that DAO's exits.
- A token whose value is a claim on a treasury also carries more legal weight than one used to stake for paid work.

Still open there: supply, how it is first held (sold through Creaton's own auction and curve later, earned through
work, or both), how platform fees reach it, and the launch date, which waits for counsel and a legal entity. A test
token on testnet is enough to build the court. The example project
([CREATON-EXAMPLE-PROJECT.md](CREATON-EXAMPLE-PROJECT.md)) is a testnet project with no sale; its records will not
carry over.

## 7. The $CREATE court (N7)

### What it decides, in order

1. **Bounty appeals:** a claimant who reached the hold and lost backing, or whose claim never qualified, against the
   funders' decision.
2. **Second opinions on contributor submissions**, when someone disputes a reviewer's verdict. The DAO's freeze vote
   stays (`TreasuryMandate.freezeClaim`).
3. **Team milestones, for new projects that choose it at launch.** Today a holder objects with a deposit and holders
   vote ([MilestoneChallenge.sol](../../contracts/src/MilestoneChallenge.sol)); a new project can choose the court to
   rule instead. **Existing projects keep their holder objections.**

Every case is judged against words fixed in advance: the bounty's "done looks like", a submission's acceptance check
(`checkHash`), a milestone's check. Each case pins its court, its rules and its fees when it opens.

### Built on Kleros v2, from a pinned commit

[Kleros v2](https://github.com/kleros/kleros-v2) (its repository identifies an MIT license; the chosen revision and its
dependencies still need review) has draws weighted by stake, sealed votes, appeals to larger panels, deadlines,
redraws and a random number fallback. Before adapting it:

- **Pin one upstream commit** and keep the diff published.
- **List every power** it has (its governor, guardian and pause controls, mutable settings) as kept, removed or
  replaced, so rule 5 holds: none over money in escrow or open cases; settings by platform vote with notice.
- **Map the accepted audit findings** in [Certora's report](https://www.certora.com/reports/kleros-v2) (revisions
  `592243f` and `2ae2b6a`: juror selection, reused locked stake, transfer failures whose recovery assumed governance)
  to the fork, and have the fork itself audited.

### Fees, deposits and outcomes

- **The service fee** (USDC or $CREATE) pays the jurors and is never refunded.
- **The deposit** is returned to the side that wins. A losing opener's deposit goes to the other side; when that side is
  a bounty's funders as a group, it goes into the bounty's refunds or pot.
- **Jurors who vote against the final ruling** lose part of their stake to those who voted with it. Not revealing loses
  more and triggers a redraw.
- **Effect on the underlying:** for the claimant, the claim becomes payable (or the submission stands); against, it
  stops. A tie, a refusal to rule or the final timeout leaves the underlying as it was before the appeal, returns the
  deposits and keeps the service fee for the jurors who served.

### Collateral

$CREATE is the stake that makes someone eligible to judge and the first thing slashed. A stake covers a capped total of
open cases, not each in full; cases that move large sums also need sale-currency collateral; bonds are sized in
dollars from a price source with rules for stale or missing prices (refuse new cases, never abandon assigned ones).
Reviewer and contributor bonds can be posted in $CREATE when a work budget asks for them (USDC still accepted, D39).

### Limits we accept and show

- **Stake buys influence.** With three seats drawn by stake with replacement, someone holding 30% of the stake holds
  at least two seats 21.6% of the time. Larger panels and appeals reduce this; nothing removes it.
- **Jurors may have interests.** Drawing from outside a project does not mean jurors own none of it or bet nothing on
  it; the market rule below skips jurors with a position, and second wallets remain.
- **Losing on appeal is not proof of lying.** Jurors are paid for agreeing with the final ruling, which rewards
  guessing what others will think; Kleros's research covers this.
- **Someone can still deliver late on purpose.** The court judges what was delivered, not why.

## 8. Money forecasts, a separate experiment (N8)

Two-sided pools of the forecasters' own USDC; winners split the losing pool. No market maker, no selling of
positions, no DAO or platform money, and **no accuracy rewards paid in money**: a fixed reward per point of score pays
0.75 of the reward to anyone who says 50%, so many accounts could farm it, and paying only for improving the standing
forecast needs collateral that can be lost, which is a market again. Free forecasts (N3) stay open to everyone.

### Questions

Each question names its evidence cutoff, its betting cutoff, its resolution deadline, what voids it and when it pays:

| Question | Yes when |
|---|---|
| "Will a claim filed by D be paid by this bounty?" | A claim filed by D is finally paid (after any appeal), by the resolution deadline |
| "Will this submission, released by D, still stand when its 7-day window ends?" | Released by D and approved or paid at the window's end; if disputed, the final ruling |
| "Will tranche 2's evidence be submitted by D and accepted?" | Evidence submitted by D and finally accepted |

Betting closes at the evidence cutoff or when a claim first qualifies. No final outcome by the resolution deadline voids
the question and refunds everyone. Two contract gaps come first: a submission records `releasedAt` but not when it was
frozen, and the milestone lock must record when evidence was submitted.

### Who is barred, and what caps do not prove

Barred: a bounty's creator from the No side, a submission's team and reviewers, and drawn jurors (the court skips
anyone with a position). Caps apply per wallet and per question. **Neither proves manipulation resistance:** wallets
are not people, a coalition that wins the final ruling keeps its stake, and project payments or unlocks can be worth
more than a pot. Each question type needs its own estimate of what could be gained by corrupting it. This stays an
experiment and does not gate the audited raise.

## Evidence gate before stage 3

Matched sales filled and cancelled without our server; court cases where a wrong verdict was appealed, a juror did not
reveal and a case timed out; appeal costs people could afford; a stress test where $CREATE's price drops with cases
open. Mainnet gets its own scope and audit.

# Stage 3: after the audited raise

What it proves: a successful project can fund delivery in stages, share what it earns, and be built on.

## 9. Pledges to the next milestone (N9)

A pledge **buys future Shares**; it is not a donation. Backers pledge USDC toward the next milestone, held in escrow.

- **Price at release, not at pledging:** on release the backer gets `pledge ÷ max(curve price, the treasury floor)` at
  that moment, the funding curve's own rule. The backer sets a maximum price (or a minimum number of Shares) when
  pledging; if release would exceed it, the pledge is refunded. A price fixed in advance could let a pledger buy below
  the floor: with 5,000 USDC over 1,000 Shares, 10 USDC buying 10 Shares exits at once for 49.60.
- **Reserved Shares:** each pledge reserves Shares from the curve's allocation at its maximum-price quantity, so curve
  sales and other pledges cannot sell them twice; a refund releases the reservation.
- **Released** when the milestone before it is accepted by its deadline; **refunded** if not; **withdrawable** until the
  milestone's evidence is submitted, then it waits for the outcome. Anyone can trigger release or refund.
- No new Shares are made (D76). A follow-on raise works the same way: the curve opens a new part of its allocation
  only after a verified milestone.

## 10. Payouts (N10)

A $10,000 payout lowers the treasury exactly as a $10,000 exit does. What it adds: the DAO controls when and how much,
and holders get cash without giving up Shares. This revises **D78** (no automatic payouts) and **D82** (the revenue
pledge is a statement the contracts do not enforce). **This piece needs counsel more than any other.**

- **Revenue** is only money arriving at a revenue address the project publishes. Raise proceeds, refunds, returned
  budgets, recovered bonds and transfers between the project's own accounts never count; offchain income still depends
  on the team sending it (D78, in the D38 documents).
- **The split** is set at launch and changeable by vote with notice; one-off payouts can be declared by vote.
- **Who counts:** every Share **and Loot** that leaving would pay, less the DAO's own, less locked team Shares (D72),
  less what the funding curve may still sell or has reserved.
- **Checkpoints, not just transfers:** the payout contract keeps a running total per counting unit and must be told of
  **every** change in who counts: transfers, mints and burns (through `ownershipChanged`, which today serves voting
  only), unlocks and forfeits (`MilestoneLock.unlock`, `MilestoneChallenge` standing a milestone, `forfeit`), curve
  sales and any future vesting. A unit that starts counting at an unlock starts at that moment's total, so the team is
  never paid for payouts made while its Shares were locked.
- **Never paid twice:** a declared payout moves into the payout contract when declared, so leaving cannot pay it again.
- **Edges:** amounts round down and the remainder rolls into the next payout; a payout with nobody counting is
  refused; credited amounts survive leaving, bans and moderation, and unclaimed amounts return to the treasury after a
  period (open question).
- **Kept separate from work:** making people forecast to receive a payout does not change what it is.

## 11. Remixes, step one: where a project comes from (N11)

No money moves in this step.

- **"Built on X"**: a remix's launch record names its parent, shown on both pages and on Discover.
- **Remix terms** sit in the parent's launch record beside its IP record (D38): whether remixes are invited, what the
  parent asks in return (step two) and what a remix gets (use of the name and assets, an announcement to the parent's
  community, invitations to its contributors).
- **Licences checked for fit:** the remix's licence must allow what the parent's licence requires. Remix terms are an
  optional network, brand or IP arrangement; they never claim to take back rights an open licence already granted.

## 12. Remixes, step two: the parent's share (N12)

A larger financial piece, after payouts exist:

- **A share of the remix's starting supply**, declared in its genesis allocation (a new kit decision, since our DAOs
  start with empty Loot and cannot mint it later). Proposed: Shares held under **a variant of the milestone lock**,
  which already keeps Shares in the holder's wallet and out of what leaving pays and out of payouts; today it unlocks
  only on the holder's own accepted claim, so the variant unlocks on the remix's own first accepted milestone or after
  a set time. Ownership limits at launch are checked against the full allocation.
- **Optional:** a revenue share through the remix's payout split (N10) and a fee on its raise.
- **Only the direct parent is paid;** the grandparent is paid through the parent's own share.
- **On supported trading venues,** once Shares trade, an apptoken can carry the parent's cut, fixed at birth for its
  term and changeable only with the parent's consent. It covers ordinary trades on those venues, not wrapped tokens or
  arrangements made off them.
- **A remix bond** in $CREATE (plus USDC for large remixes), posted at launch. If the court rules the remix broke its
  terms, the bond goes to the parent and the page says "broke its remix terms with X". Any further remedy, such as
  unlocking the parent's share early, is capped and named in the terms. Nobody's tokens are taken and leaving stays
  open.

Prior art: Story Protocol's on-chain licences with royalties for derivatives (not used,
[project-ip.md](../project-ip.md)). Recording a licence does not stop copying elsewhere; the button has to be worth more
than its terms.

# Parked

| Idea | Why it waits |
|---|---|
| Bounty contests, rewards for past work, payment in steps | After the one-winner rules have run: contests need ranking, ties and leftover rules; steps need partial refunds |
| A remix licence for copies made outside Creaton ("source available", turning open after some years) | Needs the legal entity, and sits in tension with keeping code free |
| A stay bonus on payouts | Rewards holding but does not secure runway |
| An exit fee for new projects | Changes what leaving pays; matched exits meet the same need |
| Vouching for accounts with a $CREATE stake | Needs a precise rule for double claims that allows separate personal, work and agent accounts |
| Curation stakes, founder launch bonds | Useful once there are many projects and raises |
| Moderation appeals to the court | Easy once the court exists; not needed to prove it |
| A backstop pool repaying backers after fraud | An insurance system: reserves, exclusions, correlated losses |
| Early auction access for stakers | Fairness and onboarding cost |
| Markets that choose contributors | Advisory only until their own mechanism is designed and tested |

**Dropped:** money rewards for forecast accuracy and the $CREATE stake to qualify for them (they can be farmed); making
backers wait to leave while they support a spend (leaving already removes their support, and the vote is checked again
before a spend runs). **Never:** a platform power to shut down a DAO or take tokens.

# Proposed decision rows

| ID | Question | Proposal | Why | Risk |
|---|---|---|---|---|
| N1 | Outside money on work areas? | Bounties that pay the contributor of a submission released by the deadline and still standing after its window; refunds otherwise | Cash for contributor projects with no new way of deciding | Medium: a new contract holding outside money, decided by existing review |
| N2 | Open bounties on posts? | One winner; backing instead of nomination; more than half of counting weight for 48 hours then a 7-day hold; late money carries no weight on a running claim; refunds after the deadline; consent before "keep going as a project" | The first step of the route | High: outside money under a new voting rule |
| N3 | Forecasts without money? | Signed percentages with reasons, accuracy shown with the count | Visible and cheap; the base for money forecasts | Low |
| N4 | Show runway? | Free to use, set aside, spent and outside money kept apart; months left as an estimate | Holders see the project's cash plainly | Low |
| N5 | Cash without draining a project? | Signed offers, the seller keeps the Shares until an atomic fill; floor only where leaving pays one currency; separate from the curve | Turns cash needs into sales to newcomers | Medium: a narrow exemption to D77 |
| N6 | What is $CREATE? | A separate token; launch decided later with counsel and an entity | Collateral and transfers need it settled before the court | High |
| N7 | Who settles disputes? | A $CREATE court forked from a pinned Kleros v2 commit, powers listed, fees and outcomes defined; bounty appeals first; milestones only for new projects that choose it | Separates who decides from who funded or built | High: a new trust model and the largest contract surface |
| N8 | Money forecasts? | Two-sided USDC pools, no money accuracy rewards, questions settled on evidence cutoffs and final outcomes | Lets skeptics act on doubt with money | High: legal, manipulation; an experiment |
| N9 | Fund delivery in stages? | Pledges priced at release under the curve's rule with a backer's maximum, reserved Shares, refunds | Money follows delivery without buying below the floor | Medium |
| N10 | Payouts? | A revenue address and split; checkpoints for every change in who counts; moved out at declaration. Revises D78 and D82 | Cash without leaving, at a pace the DAO controls | High: legal weight, accounting |
| N11 | Where does a remix come from? | "Built on X", remix terms, licence fit, invitations; no money | Credit and community for building on a project | Low |
| N12 | Does a remix pay its parent? | A locked share in the genesis allocation, optional revenue share, an apptoken cut on supported venues, a remix bond with capped remedies | Building on a project pays the original | High: new allocation and lock rules |

# Tests that would decide it

- **Work-area bounties:** funded equals paid plus refunded plus still held at every step; only a submission of that
  work area released by the deadline and standing after its window can be paid; one payout per bounty; refunds open
  after the waiting limit with no operator; a made-up mandate is refused.
- **Open bounties:** at most one claim qualifies at a time; a dip restarts the 48 hours; a claim pays only after a
  7-day hold that keeps its majority; late money carries no weight on a running claim; a claimant's own funding never
  counts for them; every boundary behaves as the state machine says; one recipient who cannot receive USDC does not
  stop anyone else's withdrawal.
- **Forecasts without money:** a forecast revised after the cutoff never counts; accuracy in the browser matches the
  published outcomes.
- **Matched exits:** fills are atomic; an offer fills once; cancelling needs no operator; locked Shares cannot be sold;
  votes and payouts stay with the seller until the fill; the treasury is unchanged by a fill.
- **Court:** every case reaches a ruling or the timeout outcome by its deadline; a juror's stake cannot leave while
  assigned; open exposure never exceeds a juror's cap; the service fee and deposits always add up; a tie, a refusal and
  a timeout each leave the underlying as specified.
- **Money forecasts:** payouts never exceed the pools; a dispute's length never changes a result; voided questions
  refund everyone.
- **Pledges:** a release never prices below the floor; reserved Shares are never sold twice; a release above the
  backer's maximum refunds instead.
- **Payouts:** payouts before and after an unlock, then a transfer, a partial exit, a full exit and a later claim, each
  credit exactly what the rules say; declaring leaves the DAO's balance plus the payout contract's unchanged; leaving
  after a payout does not pay it again.
- **Remixes:** a remix cannot launch without its parent's declared share; that share cannot leave or count before its
  unlock; the remix's DAO cannot remove the parent's cut alone; a breach ruling pays the bond and no more than the
  named remedy.

# Trust (CROPS)

- **Censorship resistance:** bounties, refunds, offers, the court and payouts finish without the operator; moderation
  never touches money; evidence stays retrievable after a removal.
- **Open:** contracts, event formats, state machines, question templates, scoring and the pinned Kleros diff are
  published; forecasts are signed posts anyone can rescore; financial records can be exported and rebuilt from the
  chain, since a signed record proves who wrote it, not that a server gave you all of them.
- **Free:** Kleros's repository identifies an MIT license (revision and dependencies to review); existing open licences
  are never presented as revoked by remix terms; the parked source-available licence is a stated tension.
- **Privacy:** bounties, forecasts and disputes can link accounts; taking part is voluntary, visibility is stated
  before signing, separate accounts are allowed, and wallet bars are never presented as proof of separate people.
- **Security:** live-floor pricing, payout checkpoints, separate books per bounty and capped court exposure are
  required; payouts and leaving must never pay the same money twice.

Accepted compromises: funder-weighted bounty approval is a chosen trust model; a human panel cannot guarantee truth;
matched sales need willing buyers; offchain income needs the team to send it.

# Open questions

1. Open bounties: is "more than half of all counting weight" right, or more than half of the weight that has backed
   any claim with a minimum turnout? How long is the waiting limit for frozen submissions on work-area bounties?
2. Which price source sizes $CREATE bonds, and above what amount does a case need sale-currency collateral?
3. Which contract records when evidence was submitted and when a submission was frozen?
4. How long do unclaimed payouts stay claimable?
5. Where do pledge Shares come from in a project without a funding curve?
6. What share and lock should remix terms suggest by default, and does the parent's share vote once unlocked?

# What changed

**From the review of the staged proposal (2026-10-25):**

- Work-area bounties come first, decided by the project's existing review; open bounties start with one winner, use
  backing instead of nomination, give late money no weight on a running claim, and have a written state machine.
- No spam deposit decided by moderators: moderation never decides who gets money.
- The books rule is `funded = paid + refunded + still held`, with withdrawals by each person.
- The runway card separates money set aside from money spent and says "not enough history" instead of "unlimited".
- Matched exits use signed offers with the seller keeping the Shares, need neither $CREATE nor the court, and stay
  separate from the curve; the floor is enforced only where leaving pays one currency.
- What $CREATE is gets decided before the court (recommended: a separate token).
- The court forks a pinned Kleros v2 commit with its powers listed and its audit findings mapped; fees, deposits and
  timeouts are defined; existing projects keep holder objections.
- Money accuracy rewards and the $CREATE eligibility stake are dropped; money forecast questions settle on evidence
  cutoffs; caps are not presented as manipulation resistance.
- Pledges are priced at release under the curve's rule, with a backer's maximum and reserved Shares.
- Payouts checkpoint every change in who counts, including unlocks and forfeits, which do not move tokens today.
- Remixes split into a step without money and a later financial step built on a lock variant, not new Loot.
- Copy: the lead no longer claims nobody else does this; planned features are marked; "leave at any time" names
  locked Shares; N2 and N12 are rated High.

**Put in stages (earlier the same day):** the first seven pieces were reordered into stages, bounties and remixes were
added after the poidh articles, and ideas not needed yet were parked.

**From the review of the forecasts plan:** the cap on market size against the objection deposit and the higher
objection bar when a market exists are gone; the backer-exit wait is dropped; "approved and not frozen by D" cannot be
rebuilt from today's records.

**From the review of the follow-up conversation:** a court improves separation but does not make forecasts safe;
VerifierSet is not a court; $CREATE collateral is capped by exposure; a share of a pool by score is not truth-telling;
leaving lowers the project's cash, not anyone's part, and a payout lowers it just as much; set aside means moved; a
matched sale raises nothing; payouts include Loot and exclude locked team Shares; launching $CREATE is its own
decision.

**From the poidh articles:** the creator no longer decides alone which claim is considered; a payment must keep its
majority through a 7-day hold; work is paid on proof, never on a plan; much of poidh's wish list (notices, spam
moderation, discussion, card payments, help writing) is built here already.

# Sources

[poidh](https://poidh.xyz) and two articles by its founder (pasted 2026-10-25: "the marketplace of ideas needs a
marketplace for outcomes", "the ephemeral DAO machine"),
[MetaDAO docs](https://www.metadao.com/docs), [Variant on MetaDAO](https://variant.fund/articles/investing-in-metadao/),
[Lightspeed on MetaDAO launches](https://lightspeed-4bed7b.beehiiv.com/p/unruggable-icos),
[Umia docs](https://umia.finance/docs), [Umia decision markets](https://umia.finance/docs/decision-markets),
[Kleros whitepaper](https://kleros.io/whitepaper.pdf),
[Kleros research on juror incentives](https://blog.kleros.io/incentivizing-jurors-to-honestly-report-uncommon-answers-deposit-sizes-lazy-strategies-and-peer-prediction/),
[Kleros v2](https://github.com/kleros/kleros-v2),
[Kleros v2 emergency controls](https://github.com/kleros/kleros-v2/blob/dev/contracts/specifications/arbitrator.md#-emergency-controls),
[Certora's Kleros v2 report](https://www.certora.com/reports/kleros-v2),
[Forecasting competition research](https://pubsonline.informs.org/doi/10.1287/mnsc.2022.4410), and the SEC
interpretation the second review cites ([March 2026](https://www.sec.gov/files/rules/interp/2026/33-11412.pdf)).
