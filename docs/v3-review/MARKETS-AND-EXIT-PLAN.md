# Milestone forecasts, choosing contributors by market, and leaving while you back a spend (plan for feedback, 2026-10-25)

Status: **a plan to collect feedback on. Nothing here is decided or built.** It follows the funding curve proposal
([JOIN-CURVE.md](JOIN-CURVE.md); its asset rule is decided as D112) and the conversation after it. Each part would
need its own decision rows, contract work where noted, audit scope and, for real money, a legal read.

**Updated 2026-10-25 after an outside review:** superseded in part by [NEXT-GEN-DAO.md](NEXT-GEN-DAO.md). Money
forecasts now settle on a $CREATE court's final ruling (N1, N2); the market-size cap and the higher objection bar are
dropped; the backer-exit rule in Part 4 is dropped, because leaving already removes a backer's support and the vote is
checked again before a spend runs.

## What we are trying to do

1. **Let skeptics act on doubt with money**, a way to bet against a project's execution, without borrowing Shares or
   their votes (we recommend no shorting of Shares: borrowed Shares vote, and with transfers locked there is nothing to
   borrow; see JOIN-CURVE.md).
2. **Use market signals to pick the best team or contributor** for a piece of work.
3. **Close a gap in leaving**: someone who backs a spend can leave just before it runs and let the others pay for it.

## What exists today

| Piece | Today |
|---|---|
| Majeur's "futarchy" | Anyone could fund a pot on a proposal; voters received a receipt for their side; when the proposal resolved (YES if it ran, otherwise NO) the winning side's voters split the pot. That pays voters for picking the winning side while those same voters decide the outcome, in effect paying people to vote a certain way. **Switched off in our fork** (`fundFutarchy` reverts: "no alternate voting incentives or reward-minted power"); the plan's D8 dropped its proposal kind. |
| Milestone objections | A holder who is not on the team posts a deposit (10% of the team's bond, which is 1% of the raise target) and puts a milestone to a vote of holders. Upheld only if the votes against reach a small minimum and outnumber the votes for. If upheld before the unlock: the objector gets the deposit back and half the bond; the DAO gets the other half. ([milestone-challenge.md](../milestone-challenge.md)) |
| Challenging a work approval | Freezing or unwinding a submission and taking a reviewer's bond are DAO votes; the bond goes to the DAO, with no reward for whoever raised it. |
| Leaving | Pays a share of every asset the leaver lists (in a DAO with a funding curve, only the sale's currency: D112). Support for a decision stays movable until it runs, and leaving removes your support automatically. The voting policy has an unused hook, `mayExit(owner)`, that today always answers "yes". |

## Part 1: milestone forecasts

### 1.1 The project's money stays out of the bet

- Milestone hit: the team's tranche unlocks, or a contributor's award goes to its vote, as today.
- Milestone missed: everything stays in the treasury, as today.
- The forecast is a **separate pot of the forecasters' own money** (and, optionally, a small reward the DAO funds).
  Winners are paid by the other side and that reward, never out of the project's funds.

Paying the "No" side out of the project's funds would let doubters profit from a failure that some of them can cause:
holders can object to a milestone and vote to uphold the objection.

### 1.2 What is forecast, and how it settles

Only facts the chain records, read by the market contract itself, with no price feed and no vote on the market:

- **Team milestones:** "Did tranche 2 of the milestone lock unlock by date D?"
- **Contributor work:** "Did work area W get an approved submission that was not frozen by date D?" (a work area
  already has its "Finished looks like" words and an "open until" date).

### 1.3 Pay for accuracy, not for "No"

A reward only for "No" pulls people toward betting on failure, and toward causing it. Reward whoever predicted well, on
either side. Three ways to fund it:

| Mechanism | How it works | Cost to the DAO | Signal |
|---|---|---|---|
| Two-sided pool | YES and NO pools; winners split the losers' pool pro rata; the odds shown are the pool ratio | None | Weak when one side is thin |
| DAO-funded market maker (LMSR) | An automated market maker whose worst-case loss is fixed in advance gives a live price at any time | At most `b · ln 2` per yes/no market: about **$347** with $500 of depth | Strong and continuous |
| Free-entry prize contest | The DAO funds a prize; anyone forecasts for free; the most accurate (for example by Brier score) win | The prize | Good, and no one stakes money (see Part 3) |

The team's existing milestone bond is already its YES position. A team that posts a bigger bond is making a credible
statement, and anyone who disagrees can take the other side.

### 1.4 Manipulation, and the guards

The outcome is partly a vote, so the people who can move it can also bet on it:

- **Objection votes.** A holder who bets on NO can object and vote to uphold. The bar to uphold is deliberately low.
  Holders already gain a little when a milestone fails (still-locked team Shares stay out of what leaving pays, D72); a
  market adds money to that incentive.
- **Sandbagging.** A team could deliver late on purpose if a NO bet pays more than its tranche is worth.
- **Reviewers.** Reviewers decide whether contributor work is approved.

Guards:

- Settle only on recorded facts (1.2).
- **Close trading when the team publishes its evidence**, so nobody trades during the objection vote.
- **Cap each market's size** against the objection deposit, the bond and the tranche, so sabotage costs more than it can
  win.
- Betting against work you review is a stated reason for the DAO to take your reviewer bond.
- Possibly raise the bar for upholding an objection on a milestone that has a market.

None of this is airtight, because wallets are not people.

## Part 2: choosing the best team or contributor (where this becomes futarchy)

When two or more teams or contributors want the same work area, open one conditional market per candidate: "If A does
this work, will it be approved by June 1?", and the same for B. Bets in the markets for candidates who are not chosen
are refunded. Then pick the candidate the markets rate likeliest, or likeliest per Share or dollar asked.

That is futarchy's "vote on values, bet on beliefs", and it fits what Creaton already has: the work area's words are the
values (decided by vote), the deadline is its "open until" date, and the outcome is the reviewers' approval on chain.

Start with the markets **informing** the vote (shown beside each candidate). Let them decide only once there is enough
real trading for that to be trustworthy, and keep a vote able to overrule them while they are thin.

## Part 3: legal (not legal advice)

What generally matters, as we understand it, is whether people **pay to take a position whose payout depends on an
event**; that is the core of an event contract, which in the US falls to the CFTC and elsewhere often to gambling law.
Routes that tend to be viewed differently:

- reputation-only forecasts (no money);
- free-entry prize contests funded by the DAO, where accuracy wins;
- refundable deposits that act as dispute bonds, like today's objection deposit.

Real two-sided money markets are the strongest signal and the route that needs a lawyer before any real money. Test
money on a testnet is fine for building and trying them.

## Part 4: leaving while you back a spend

### 4.1 The gap

Someone backs a spend, then leaves just before it runs. They take their full part of the treasury, and the members who
stay pay for what that person voted for.

### 4.2 Why not reserve every pending spend for everyone

The first idea was to count every pending spend as already spent when anyone leaves. Two problems:

- **It removes the minority's protection.** Moloch's leaving exists so that people who disagree can get out with their
  part before a majority spends the treasury in a way they oppose. If a pending "send the treasury to us" proposal
  lowered everyone's exit at once, dissenters could only leave with what was left.
- **It invites spam.** Anyone able to open a proposal could push down everyone's exit with large proposals.

### 4.3 The narrower rule: it applies only to the people backing the spend

| | How it works | Cost |
|---|---|---|
| **a. Backers wait** (recommended) | You cannot leave while your support is on a pending money decision; withdraw it first, or wait until the decision runs or expires. MolochDAO v2 had the same rule: no ragequit until the last proposal you voted yes on had been processed. | A check in leaving, through the existing `mayExit` hook. Plus: support for a money decision can no longer be withdrawn once its waiting period has started, or a backer could withdraw, leave and still see it pass without them. |
| b. Backers pay their part | Leaving while you back a pending spend pays as if it had already run: your part of that spend stays behind. Dissenters keep their full exit, and other people's proposals cannot touch yours. | The DAO must know each pending spend's amount and your part of it; more code. |

Either keeps leaving always on (D73): a backer can withdraw support and leave up until a decision's waiting period
starts, and after that is held only until it runs or expires (about a day with the current execution delay).

Details to settle: support placed by a delegate counts as the owner's; opposing or neutral votes do not count as
backing; what counts as a "money decision" (paying from the treasury, setting aside a work budget with money).

### 4.4 Milestone unlocks stay as they are

Leaving before an unlock is a backer's verdict on that milestone (D72: "leave before each milestone with your full
part"). Nobody backs an unlock by voting, and holding exits during the objection window would remove the protection
against a bogus milestone.

## Suggested order

1. **Forecasts with reputation only**, shown beside each milestone and each candidate. No contract risk.
2. **The backer-exit rule** (option a). A contract change, so it goes into the audit scope; it protects members, so it
   could come early.
3. **A free-entry prize contest** funded by the DAO, scored on accuracy.
4. **Real two-sided money markets**, after a legal read.
5. **Conditional markets choosing candidates**, advisory first, binding later.

## Questions we want feedback on

1. Is a forecast pot separate from the project's money the right shape, or should outcomes move project money at all?
2. Which reward: two-sided pool, DAO-funded market maker, or free-entry prize contest? How much should a DAO spend on
   forecasts per milestone?
3. Are the manipulation guards enough, especially around objection votes? Should a market raise the bar for upholding an
   objection?
4. Should conditional markets ever **decide** who does the work, or only inform the vote?
5. For the backer-exit rule: option a or b? Is holding a backer until a decision runs acceptable under "leaving can't
   be switched off"?
6. Which legal route should we test first?
7. Anything here that would make a non-technical member less likely to take part?

## Decisions it would touch

| Decision | How |
|---|---|
| **D73** (leaving cannot be switched off) | Backers of a pending money decision wait until it runs or expires (option a); everyone else leaves as today. |
| Voting rules (support stays movable until a decision runs) | For money decisions, support could no longer be withdrawn once the waiting period starts. |
| **D72** (leave before each milestone with your full part) | Unchanged. |
| Majeur futarchy (switched off), plan D8 | Stays off; conditional markets would be a separate, new contract that pays forecasters, never voters. |
| **D12, D14, D77** (no market; a market only by vote) | Unchanged: forecasts trade outcomes, not Shares. |
