# Creaton project economics: a brief for an outside reviewer (2026-10-31)

Thank you for looking at this. This brief is meant to be enough on its own for a first read (about an hour); the linked
documents and code are there when you want the detail. Every number below was read from the contracts or computed by a
script, not estimated.

## What we are asking

**Is the way a project raises money, pays contributors, and lets people leave fair to each group, and hard to game?**
We would like:

1. Your **top risks**, most important first, each with the scenario that worries you.
2. Answers to the **questions** in the last section where you have a view, including "this question is the wrong one".
3. **Settings** you would change (values, not only directions), and anything you would cut.
4. A **one-hour call** to walk through a raise on a test chain, ideally after your first read.

We can run any scenario you name on a local chain and send you the numbers.

**Where things stand.** Everything here runs on test networks only, with test money. The contracts are unaudited, and
they are frozen until the first pilots have run (D137). The first launch is **contributor projects with no raise**: people
earn ownership of a project through reviewed work. Raising money comes later, after an external audit and a legal read.
So your review shapes the design before any real money is involved, and settings and copy can still change freely.

**Not in scope:** whether any of this is a security under any law (we will ask a lawyer separately); the smart-contract
audit; the platform's own $CREATE token and its court.

## The product in one paragraph

Creaton is a social app for building projects together (films, apps, open-source software). Each project is a small
on-chain organisation (a DAO, built on Moloch-style "Majeur" contracts) with a **treasury** and **units** of ownership.
People earn units by delivering work that reviewers approve, or buy them when the project raises money. Any holder can
**leave** at any time and take their share of the treasury with them. That right to leave is the main protection we
offer, and it cannot be switched off.

## Words used below

| Word | Meaning |
|---|---|
| **Shares** | Units that vote and can leave with their part of the treasury |
| **Loot** | Units that can leave and receive payouts, but do not vote |
| **Leaving** | Burning units for their share of the treasury, pro rata ("ragequit") |
| **The floor** | What one unit takes out by leaving now: the treasury's balance ÷ the units that can leave (all Shares and Loot, less the DAO's own and team Shares still locked behind milestones) |
| **Work budget** | Shares (and sometimes money) set aside by vote for a work area; contributors claim from it |
| **Award** | Shares paid for a piece of work, after a review panel (e.g. two of three reviewers) approves it |
| **Funding terms** | Published by vote before any sale: what investors get, how many units may be sold, the exit fee |
| **Tranche** | One sale under the terms: a quantity, a least price, an end date, each its own vote |
| **Weekly round** | A once-a-week batch auction at a single price, for tranches and for holders selling to buyers |

## Two ways a project starts

### A. Contributor project (what launches first)

1. A founder starts a project with no money. Their starting Shares are **at most a third of the first work budget**, and
   they are **not on its review panel** (D79).
2. People claim work from budgets; reviewers approve; the DAO **awards** Shares. New Shares only ever come from awards,
   and for contributor projects **there is no yearly cap** (D76, D79).
3. Shares cannot be transferred at first. Holders can open trading between members later, by vote, with 30 days'
   notice (D117, D131).
4. Optionally, the holders **publish funding terms** and **sell tranches** in weekly rounds (D133 to D136). Investors
   receive Loot by default.

Worked example over two years: [TOKENOMICS-PROPOSAL.md §8c](TOKENOMICS-PROPOSAL.md) (the founder's share goes from 100%
to 26% as 5.7 million Shares are awarded to contributors).

### B. Fundraising kit (later, after the audit)

1. A founder launches with an **auction** (Uniswap's continuous clearing auction) that sells all of its tranche at no
   less than the floor price, or refunds everyone (D74).
2. Limits on the split (D75): the sale is **at least 60%** of all Shares, the team **at most 35%**, a DAO reserve **at most
   20%**. Every team Share is locked behind **2 to 8 milestones** of at most 50% each. Presets are 75/25/0, 80/20/0 and
   65/35/0.
3. Holders can object to a milestone; an objection upheld later burns what is still locked. Team Shares that are still
   locked **do not count** in what leaving pays, so a backer who leaves before any milestone takes their full part of the
   money not yet spent (D72).
4. New Shares only as awards, **at most 10% more a year**. That cap is fixed at launch, can be lowered, and can never be
   raised (D76).
5. No trading at first; transfers are locked at birth (D77). Later raises use the same funding terms as path A.

Worked examples with numbers by month: [TOKENOMICS-PROPOSAL.md §8a and §8b](TOKENOMICS-PROPOSAL.md), a $50,000 film and
a $250,000 app. They show what $1,000 of backing is worth at each step, and the team's share of votes.

## How money moves

| Action | Who is paid | What happens to units | Effect on the floor |
|---|---|---|---|
| Fund the project (a tranche) | The treasury | New units created, within the terms | Rises: tranches sell at least 2% above the floor |
| Buy from a holder (a round, or a matched exit) | The seller. In a round, a fifth of the seller's gain above the floor goes to the treasury; a matched exit has no fee | Existing units change hands | Unchanged, or up by the round's cut |
| Leave | The holder, from the treasury, less the exit fee if terms exist | Burned | Unchanged, or up by the fee |
| Spend by vote (into a work budget, or a payment) | The budget or payee | None | Falls |
| Award Shares for work | Nobody (no money moves) | New Shares | Falls (more units) |
| Revenue in, or payouts | Payouts: a chosen share goes to holders, the rest to the treasury (D122) | None | Rises with what reaches the treasury |

**Exit fee** (D135, D136): set when terms are first published, **at most 5%** (the form suggests 2%). It stays in the
treasury for those who remain. It can be lowered, never raised. It is **waived during the 30 days' notice** after terms
are published or their limit is raised, so a holder who will be diluted can still leave whole. The last units that can
leave pay none. A project without terms charges none.

**One asset while selling** (D134, D136): while the treasury holds anything besides the round's currency, nothing
sells; otherwise a price set in USDC would hand buyers part of the ETH for nothing. Any holder can add any token the
treasury holds to the watch list, which stops sales until a vote accepts it.

## Weekly rounds ([WEEKLY-ROUNDS.md](WEEKLY-ROUNDS.md), D131)

- One round a week per project: **3 days of bidding**, then up to **2 days** for anyone to settle it. A round nobody
  settles is void, and everyone takes back what they put in.
- Sellers name a lowest price, buyers a highest. The clearing price is the one that trades the most. Everyone past it
  fills whole; the side that is longer at the price shares in proportion.
- **Prices are on a grid:** 1,024 steps above the floor read when the round opens. Each step is 1% of the floor, or
  **one cent per unit**, whichever is larger.
- A funding tranche is offered at least **two steps above the floor** and at its own least price. The units are created
  and the treasury paid when the round settles.
- The DAO may also sell Shares it already holds, at two steps or more above the floor, with no cut.

## Voting ([`AllocationVoting.sol`](../../contracts/src/AllocationVoting.sol))

| Lane | Turnout | Agreement | Review; support must hold | Changeable within |
|---|---|---|---|---|
| Full (anything at treasury scale: terms, tranches, budgets) | 20% of voting supply | 66% of those voting yes or no | 48 hours; 12 hours | turnout 5% to 60%, agreement 50.01% to 90%, review 1 to 14 days |
| Bounded (approvals inside a work budget, whose cap and reviewers limit the loss) | 10% | 55% | 24 hours; 6 hours | same |

Only Shares vote; the DAO's own Shares and other units that can never vote are left out of the supply. Nothing passes
before its review ends, the bars must have held for the hold time, and a passed decision then waits in a queue (a day in
the kits). So the minimum is about 3 days from opening to running. The point of those days is that a holder can see a
decision coming and leave first. Changes that dilute or open trading get **30
days' notice**: funding terms, raising their limit, naming an exchange, changing the payout split.

## A worked example: a contributor project takes money

We start from §8c at month 24: **5,700,000 Shares**, **$12,000** in the treasury, and the largest contributor holding
**450,000**. The holders publish terms (Loot, exit fee 2%), wait the 30 days, and vote a tranche of **570,000 Loot** with
a least price of **$0.05**. Computed by script:

| | Before | After the tranche sells at its lowest allowed price |
|---|---|---|
| Floor (what one unit takes out by leaving) | $0.0021 | $0.0067 (before the 2% fee) |
| Price per Loot | | $0.0521: the least price rounded up to the next one-cent step, **25 times the floor** |
| Raised | | $29,700 |
| Treasury | $12,000 | $41,700 |
| Largest contributor: share of units | 7.9% | 7.2% |
| Largest contributor: leaving pays | $947 | $2,933 (after the fee) |
| A buyer who leaves at once gets back | | 12.5% of what they paid |

What it shows: the premium a buyer pays over the floor goes to the existing holders' exit value at once. A Loot buyer is
paying for future revenue and payouts, not for the exit. Note the one-cent step: with the floor at $0.002, the lowest
price a tranche can sell at is the floor plus two cents, more than ten times the floor, whatever the project asks. The
step size is a deployment setting, not a contract change.

## Decided, and why (the short version)

- **Leaving is always on** (D73). It is the backer's only real protection, so nothing can turn it off.
- **Earned and sold units are kept apart** (D133). Earned units need an award vote on reviewed work; sold units need
  terms published in advance. There is no single "minting on" switch.
- **Investors get Loot by default** (D133), so contributors keep control as money arrives. A project may choose voting
  Shares instead.
- **No continuous market yet** (D77, D137): weekly rounds collect demand once a week; a pool is not designed.
- **Payouts are a choice, not automatic.** Revenue sent to a payouts module is split between holders and the treasury,
  for contributor projects only (D122).
- **Left out of the first version on purpose** (D131, D137): price limits between rounds, sell limits for the team,
  trading windows for insiders, standing orders, a 90-day cap on gains, unlocks tied to volume or price, and any premium
  sale for the team.

The full log, with what reverting each decision costs: [DECISIONS.md](DECISIONS.md) (D72 to D79 and D131 to D137 are
the economic core).

## What we have checked, and what that does not cover

- **Money is conserved.** Invariant tests ([AUDIT-SCOPE.md](AUDIT-SCOPE.md), `contracts/test/invariant/`) and an
  agent-based simulation on a real local chain ([simulate-raise.mjs](../../scripts/simulate-raise.mjs): many accounts,
  thousands of random steps) check after every step: the treasury falls only by a leave or a vote that met its bars,
  locked Shares never leave, no bidder pays above their limit, a failed raise refunds in full.
- **The tests themselves are checked** by mutation testing (deliberately broken contracts must fail a test) and fuzzing
  of the exit screen against the contract.
- **AI reviews** of each change, the findings fixed (D80, D86, D105, D130, D134, D136).

None of this tells us whether the **incentives** are right: whether founders, contributors, reviewers, buyers and
traders, each acting in their own interest, produce good projects and fair outcomes. That is what we are asking you.

## Known tensions and open questions

1. **Contributor awards have no yearly cap.** Loot buyers in a contributor project can be diluted by any award budget
   the voting holders pass. The page says so ("Before you buy"), but is disclosure enough? Should funding terms bring a
   cap with them?
2. **Raised money can leave with earned Shares.** Once a tranche lands, every contributor can leave with part of it. Is
   that a fair price for their work, or a drain on a fresh raise?
3. **Loot or voting Shares for investors**, and whether contributor projects should be allowed to sell voting Shares at
   all.
4. **Sales between members sell Shares**, which carry votes; an earlier write-up recommended Loot
   ([CONTRIBUTOR-TOKEN-TRADING.md](CONTRIBUTOR-TOKEN-TRADING.md)). Loot holders cannot sell in rounds yet; leaving is
   their only way out.
5. **No minimum per tranche.** The first auction sells out or refunds; a tranche can sell any part.
6. **The values**: the 30 days' notice, 2% above the floor, the exit fee (2% suggested, 5% ceiling), the treasury's
   fifth of a seller's gain, the one-cent price step.
7. **Any holder can stop sales** by adding a token the treasury holds to the watch list. That is cheap, and it costs a
   vote to undo. Is it the right trade against the risk of underpricing?
8. **Founder control in contributor projects.** The limit of a third of the first budget holds at the start; the rule
   that contributors must also agree to big changes (option 3 in [§6](TOKENOMICS-PROPOSAL.md)) is not built.
9. **Not designed yet:** winding a project down, continuous trading (a pool), and the funding curve
   ([JOIN-CURVE.md](JOIN-CURVE.md), not accepted).

## Our questions for you

1. Is a pro-rata exit (no premium, no discount) the right backbone for small creative projects, or does it make raising
   above the floor too hard?
2. What should a Loot buyer reasonably expect for paying a premium of many times the floor, and how should we explain it?
3. For contributor projects that take money, should awards then get a yearly cap? If so, how large?
4. Is the exit fee doing its job (stopping people who buy just before money lands and leave just after) at 2%? Should it
   apply when a decision a holder dislikes passes?
5. Weekly batch rounds or a continuous market: at what activity level would you switch, and what would you watch to
   decide?
6. The treasury's fifth of a seller's gain above the floor: fair to sellers? Does it push trades to matched exits, which
   charge nothing?
7. Fundraising kit: are the split limits and milestone rules (60/35/20, 2 to 8 milestones) sensible for a $50k film and a
   $250k app?
8. Reviewer incentives: two of three reviewers approve awards. What would you add to stop them colluding (bonds, rotation,
   spot checks)?
9. Where would you expect the first real-world failure: a founder, a reviewer, a buyer, or nobody showing up?
10. What would you measure in the pilots? We plan to measure review turnaround, reviewer disagreement, and awards
    against delivered work.

## Where to look

| Topic | Document | Code |
|---|---|---|
| The journey and funding terms | [FUNDING-TERMS.md](FUNDING-TERMS.md) | `contracts/src/FundingTerms.sol` |
| Fundraising kit rules and worked examples | [TOKENOMICS-PROPOSAL.md](TOKENOMICS-PROPOSAL.md) (§0a has later corrections) | `DaoLaunchKit.sol`, `MilestoneChallenge.sol` |
| Weekly rounds | [WEEKLY-ROUNDS.md](WEEKLY-ROUNDS.md) | `WeeklyRounds.sol` |
| Sales between members | DECISIONS.md D117 | `MatchedExit.sol` |
| Payouts | [PAYOUTS.md](PAYOUTS.md) | `Payouts.sol` |
| Contributor projects | [CONTRIBUTOR-KIT.md](CONTRIBUTOR-KIT.md) | `ContributorKit.sol` |
| Voting | — | `AllocationVoting.sol` |
| What is checked | [AUDIT-SCOPE.md](AUDIT-SCOPE.md) | `contracts/test/`, `scripts/simulate-raise.mjs` |
| Every decision | [DECISIONS.md](DECISIONS.md) | — |
