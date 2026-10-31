# Creaton project economics: a brief for an outside reviewer (2026-10-31)

Thank you for looking at this. The main part takes about half an hour to read; the reference sections and appendices
are there when you want the detail. Every number was read from the contracts or computed by a script in
[funding-review-2026-10-31/](funding-review-2026-10-31/), not estimated.

## What Creaton is for

Creaton helps people turn ideas into businesses together: something like an open, onchain Y Combinator for small,
fast-moving teams, many of them building with AI. Anyone can be a founder, contributor, advisor or investor. Founders
find contributors, advisors, customers and investors through a shared social network. Projects organise their work,
recognise contributions, manage ownership and raise money inside the platform, each at its own pace, with a demo day and
a launch when it is ready. There is no cohort and no central selection.

The advantage we are after is continuity: an investor can find a founder through a useful discussion, see what their
team has delivered, meet its contributors, watch its demo and read its funding terms, all in one project's history.

## The question

**What investment and governance structure gives a small team enough freedom and dependable money to move quickly,
while giving backers a credible share of the value it creates, and contributors a fair share of what they built?**

Our current design answers it with one strong rule, that any holder can leave at any time with their share of the
treasury, and that rule is now the centre of the tension. We would like:

1. Your view on the **five decisions** below, including "this is the wrong decision to be making".
2. Your **top risks**, each with the scenario that worries you.
3. **Settings** you would change, as values, and anything you would cut.
4. A **one-hour call** to walk through a project on a test chain, after your first read.

We can run any scenario you name and send you the numbers.

**Where things stand.** Test networks only, test money, unaudited contracts, frozen until the first pilots have run.
The first launch is **contributor projects with no money**: people earn ownership through reviewed work. Raising money
comes after an external audit and a legal read, so settings, copy and the shape of the funded model can all still change.
**Not in scope:** securities law (a lawyer, separately), the contract audit, and the platform's own $CREATE token and court.

## One project's journey

| Stage | What happens | What exists today | Where it is weak |
|---|---|---|---|
| 1. Find an opportunity | Someone posts an idea, a problem or a prototype; others discuss and vote | Home timeline, boards, ideas | — |
| 2. Form the team | The founder starts a project; contributors claim work from budgets of Shares; reviewers approve; the holders award Shares | Contributor projects (D65, D66, D79) | The founder can control the reviewers and every vote for a long time (decision 1) |
| 3. Build a track record | Contributions, reviews and releases accumulate on the project and on each person | Contribution stories, track record, "who holds the IP" record (D38) | Reputation is not yet specific to roles (reviewer, advisor) |
| 4. Attract support | Advisors and investors find projects with evidence they care about | Social discovery only | **No terms for advisors** at all |
| 5. Demo day and raise | The holders publish funding terms; investors buy a tranche of units in a weekly round | Funding terms and weekly rounds (D131 to D136), test networks only | Buyers' rights, dilution and runway (decisions 2 to 4) |
| 6. Operate | Spending by vote or work budgets; revenue and payouts; holders trade in rounds; more tranches | Work budgets, payouts (D122), rounds, sales between members (D117) | Revenue capture (decision 5); **no way to wind a project down** |

There is a second, older path: a **fundraising kit** that opens a project with an auction selling at least 60% of all
Shares, the team's Shares locked behind milestones ([TOKENOMICS-PROPOSAL.md](TOKENOMICS-PROPOSAL.md), D72 to D79). It
fits a token launch better than a startup, where investors usually take a minority. We now expect stage 5 above, a
limited tranche sold under funding terms, to be the main funded path, and would like your view on whether the kit has a
place at all.

## What a holder owns today, precisely

- **Shares** vote. **Loot** does not. Both can leave and both receive payouts.
- **Leaving** burns your units and pays you your share of **what is in the treasury now**: the treasury's balance divided
  by the units that can leave (team Shares still locked behind milestones are left out). We call that per-unit amount
  **the floor**. Leaving cannot be switched off (D73).
- Leaving does **not** pay for anything outside the treasury: the software, the film, customer contracts, future
  receipts. A buyer who paid $1,000 at many times the floor may take out about $125 the next day; a contributor leaving
  an empty treasury gets nothing for what they helped build.
- Rights over that outside value come only from what the project commits to: a record of **who holds the IP** (D38), a
  **pledge** of a share of receipts (D78), and revenue the project sends to its **payouts** module (D122). None of these
  binds a legal entity on its own; that link needs a lawyer.

## The five decisions

### 1. Contributor control

**Today.** A founder's starting Shares are at most a third of the first work budget, and the founder may not review it
(D79). But the limit is per wallet, the founder names the reviewers and manages the first projects, and the start form
allows a single reviewer, so the first budget can reach wallets the founder controls. Votes need 20% of the voting supply
to take part and 66% of those voting to agree; with nobody else voting, a founder holding a quarter clears that alone until
the supply passes 7.5M Shares (later than month 24 in our example) and can pass a new budget with reviewers of their choice.

**Our starting position.** For the invited pilot: three reviewers, two of whom must approve, chosen as identifiable people
with conflicts disclosed. This is an operational safeguard, not protection against fake identities. We would not start
with reviewer bonds: a bond needs provable misconduct and someone credible to judge it, and does not make a judgement of
quality independent. Longer term, contributors need a collective say over changes that can erase their position (new
budgets, reviewers, unlocking transfers), for example a majority of the non-founder Shares that vote
([§6 option 3](TOKENOMICS-PROPOSAL.md)). *In the app since 2026-10-31:* a new contributor project must name three
reviewers, two of whom must agree, and the founder publishes how they know each one; the project page shows it.

**Question.** What is a sound minimum for an honest start, and when should contributors' collective approval apply?

### 2. Buyers' rights

**Today.** Investors receive **Loot** by default, so contributors keep control as money arrives (a project may sell
voting Shares instead). Buyers face a large premium over the floor, uncapped dilution (decision 3), limited liquidity
(Loot cannot yet be sold in a round, and the app does not yet let Loot leave), and dependence on the contributors'
decisions about revenue. "Before you buy" discloses most of this.

**Our starting position.** Disclosure is not enough. Funding terms should establish, before anyone pays:
- a bounded allowance of future awards (decision 3);
- the revenue commitment, including how receipts earned offchain reach the project (decision 5);
- protection against changes to those terms that hurt buyers;
- a working way to leave, and later to sell.

**Question.** For an investor paying for a future business rather than the treasury, which of these rights matter, and
what else would make the bargain credible?

### 3. Dilution

**Today.** New Shares come only from awards for reviewed work. Fundraising-kit projects cap them at 10% a year; contributor
projects have no cap, and publishing funding terms does not add one (a vote can add one, but the app does not offer it).
In our example, a large award budget passed by the founder's side alone would take Loot buyers from 9.1% to 0.9% of all
units, and their exit value from $4,677 to $464, against $29,700 paid.

**Our starting position.** Keep awards uncapped while no money is involved, to learn whether reviewed work produces
sensible allocations. Once a project sells units, model **10% of new award Shares over a rolling 12 months**, the same as
the kit, counting work already promised before the sale so protecting buyers does not break promises to contributors.
This is a comparison point, not a known optimum.

**Question.** What allowance, measured how, balances buyers against a team that must keep paying contributors in Shares?

### 4. Runway that stays

**Today.** Any holder can leave at any time, so money raised is never committed. In the example below buyers pay $29,700;
if the existing Shares then leave, this is what stays ([redemption-runway.mjs](funding-review-2026-10-31/redemption-runway.mjs)):

| Existing Shares that leave | Treasury left | Share of the raise left | Months at $3,000 a month |
|---|---|---|---|
| 0% | $41,700 | 140% | 13.9 |
| 10% | $37,985 | 128% | 12.7 |
| 30% | $30,555 | 103% | 10.2 |
| 100% | $4,549 | 15% | 1.5 |

A sale that succeeds does not show the project is funded. Paying contributors for past work can be fair, but buyers need
to see how much of their money may pay for it and how little may be left to deliver.

**Options we see.**
- **Keep leaving open, and show this table** on every sale, so buyers price it.
- **Separate committed money from money that can still be withdrawn**: a new instrument where invested money follows an
  operating budget and milestones, and holders can take out only what is not committed. It would apply only to projects
  that choose it from the start; existing promises stay. Our specified-but-unbuilt **pledges to the next milestone**
  (D123) are a step in this direction.
- **A monthly budget** for the team, as MetaDAO's launches use (a disclosed monthly amount; their documented ceiling is a
  sixth of the minimum raise, with more needing a vote). Predictable, disclosed spending can cut the number of votes
  without hiding spending, since holders know when the next withdrawal is due. We would simulate **5% of the raise a
  month, authorised three months at a time**, nothing owed for months not paid, and paused while a milestone is late or an
  objection stands. It works inside a different governance and ownership structure at MetaDAO, so the percentage does not
  transfer on its own.

**Question.** Under a permanent right to leave, how much usable funding does a raise actually secure, and which structure
would you choose for a small startup?

### 5. Revenue capture

**Today.** Revenue reaches holders only if someone sends it to the project's payouts module, which splits it between
holders and the treasury (D122, contributor projects only), or the team pledges a share of receipts in the project's
documents (D78). Onchain units say nothing about offchain software, customers or sale proceeds unless an entity holding
them is bound to the project.

**Our starting position.** Funding terms should name the revenue commitment and the entity that holds the IP, and the
project page should show money that came in against money promised.

**Question.** What commitment, and what enforcement, would make an investor believe they share in the business?

## To be fixed before any raise

Our own review found these defects ([FUNDING-REVIEW-2026-10-31.md](FUNDING-REVIEW-2026-10-31.md)). We will fix them;
please spend your time on the decisions above, and tell us only if you disagree with our reading.

- **Funding rounds can be stopped cheaply:** anyone can void one by sending a tiny amount of ETH to the treasury (R1),
  and a holder of the smallest unit can block every sale with a made-up token (R2).
- **A round cannot settle at its lowest price** on most floors of $1 or more, through rounding (R3).
- **The price grid is far too coarse** below a $1 floor: one step is a cent, so at a $0.002 floor the lowest sale price
  is ten times the floor (R4). We intend equal percentage steps with a stated starting price for an empty treasury.
- **Loot cannot leave in the app**, though the page says it can (R5).
- **Raising the funding limit waives the exit fee for 30 days**, even over a round already selling (R7).
- **Money waiting in the payouts module or an expired budget is outside the price check**, so buyers can buy at a price
  that ignores it (R8).
- **One vote can freeze all later decisions** (some voting settings have no upper limit), and **voting no can push a
  decision over its turnout bar** (D2, D3). Since 2026-10-31 the app flags any decision that sets these above the
  voting lanes' own 60% limit, and says by the vote buttons that votes against count toward turnout; the contract bounds
  and a turnout that counts only yes and neutral wait for after the pilots.

## A worked example: a contributor project takes money

We start at month 24 of [TOKENOMICS-PROPOSAL.md §8c](TOKENOMICS-PROPOSAL.md): **5,700,000 Shares**, **$12,000** in the
treasury, the largest contributor holding **450,000**. The holders publish terms (Loot, exit fee 2%), wait 30 days, and
vote a tranche of **570,000 Loot** at no less than **$0.05**
([brief-example.mjs](funding-review-2026-10-31/brief-example.mjs)):

| | Before | After the tranche sells at its lowest allowed price |
|---|---|---|
| The floor | $0.0021 | $0.0067 (before the 2% fee) |
| Price per Loot | | $0.0521, the least price rounded up to the next one-cent step: **25 times the floor** |
| Raised | | $29,700 |
| Treasury | $12,000 | $41,700 |
| Largest contributor: share of units | 7.9% | 7.2% |
| Largest contributor: leaving pays | $947 | $2,933 (after the fee) |
| A buyer who leaves at once gets back | | 12.5% of what they paid |

The premium over the floor goes to existing holders' exit value at once; the buyer is paying for the future business,
which only decisions 2 to 5 can make credible.

## How it works (reference)

**Money in and out.**

| Action | Who is paid | Units | Effect on the floor |
|---|---|---|---|
| Fund the project (a tranche) | The treasury | Created, within the terms | Rises: two price steps and 2% above it, or more |
| Buy from a holder (a round, or a sale between members) | The seller; in a round a fifth of the gain above the floor goes to the treasury | Change hands | Unchanged, or up by the cut |
| Leave | The holder, less the exit fee if terms exist | Burned | Unchanged, or up by the fee |
| Spend by vote (a work budget, a bounty, a payment) | The budget or payee | — | Falls |
| A budget closes, a bounty refunds, a reviewer is slashed | The treasury | — | Rises, for whoever holds then |
| Award Shares for work | Nobody | Created | Falls (more units) |
| A team milestone unlocks (fundraising kit) | Nobody | Join what leaving divides by | Falls |
| Revenue to the payouts module, once someone splits it | Holders' share, the rest to the treasury | — | Rises by the treasury's part |
| A payout voted from the treasury | Every holder, per unit | — | Falls, evenly |

**Exit fee** (D135, D136): set once when terms are published, 0% to 5%, lower only; waived for 30 days after terms are
published or their limit raised, and for the last units out; none without terms. A buyer at the floor overcomes a 2% fee
once the floor rises by about 2.04%, small beside the inflows and unlocks above, and fees left in the treasury go to
whoever leaves last (with 2%, a 1% holder leaving last takes 2.98× their share). **We would use 0% as the baseline** and
ask any fee to show it helps under adversarial scenarios.

**Weekly rounds** ([WEEKLY-ROUNDS.md](WEEKLY-ROUNDS.md)): one a week per project; 3 days of bidding, up to 2 days for
anyone to settle, void otherwise. One price, chosen to trade the most; the longer side at it shares in proportion.
Prices sit on a grid from the floor at opening: 1,023 steps above it, each 1% of the floor or one cent, whichever is
larger. Holders' rounds price against the treasury's cash only, while leaving pays a share of every asset.

**Voting** ([`AllocationVoting.sol`](../../contracts/src/AllocationVoting.sol)): only Shares vote. Full lane (anything at
treasury scale): 20% of voting supply takes part, 66% of yes and no agree, 48 hours of review, support held 12 hours.
Bounded lane (inside a work budget): 10%, 55%, 24 hours, 6 hours. A passed decision then waits a day, so about 3 days in
all. Funding terms, raising their limit, unlocking transfers, naming an exchange and changing the payout split need 30
days' notice.

**Contributor projects** ([CONTRIBUTOR-KIT.md](CONTRIBUTOR-KIT.md)): founder at most a third of the first budget and not
its reviewer; a claim waits 7 days after approval before it can be awarded; transfers locked until a vote opens them.

**Fundraising kit**: auction sells all or refunds (D74); sale at least 60%, team at most 35%, reserve at most 20%, team
Shares behind 2 to 8 milestones (D75); locked team Shares left out of what leaving pays (D72); awards at most 10% a year
(D76); no trading at first (D77). Worked examples: [§8a and §8b](TOKENOMICS-PROPOSAL.md).

## What we have checked, and what the pilots will tell us

**Checked:** money is conserved (invariant tests and an agent-based simulation on a real local chain,
[AUDIT-SCOPE.md](AUDIT-SCOPE.md), [simulate-raise.mjs](../../scripts/simulate-raise.mjs)); the tests catch deliberately
broken contracts (mutation testing); outside reviews of each major change, several by AI models, none by a tokenomics
specialist; and our own incentive pre-check, which found the defects above. That confirms the arithmetic, not whether
people will behave as we hope.

**The no-money pilot will measure:** review turnaround, reviewer disagreement and inactivity, disputed awards, awards
against delivered work, how often the founder steps in, whether participants understand what they own, whether someone
the founder did not know joins and contributes, whether an outside advisor arrives through visible work, and whether
people would contribute again. A test network can show whether teams form and deliver; it cannot show whether anyone
will invest real money.

## Appendix A: further questions

Answer any you have a view on.

**The funded model**
1. Is a pro-rata exit (no premium, no discount) the right backbone for small projects at all, or only for some?
2. Does the fundraising kit (an auction of 60% or more) have a place in an ecosystem of startups?
3. What should advisors receive, and on what terms?
4. How should a project wind down: who is paid first, and how is the remainder shared?

**Settings**
5. The 30 days' notice for terms: we keep it for now and will measure whether people notice it. Notice does little for
   someone whose exit value is far below their purchase price; what would you add?
6. The treasury's fifth of a seller's gain in a round: we will compare it against nothing. What service would earn it,
   given sales between members charge nothing?
7. Weekly rounds or continuous trading: we keep weekly rounds until recurring independent demand appears. What would
   you watch to decide?
8. Should projects have fewer units (a million rather than a billion) so prices read sensibly, alongside a better grid?
9. Should every raise of the funding limit waive the exit fee, and should other votes that dilute waive it too?
10. Fees left in the treasury go to whoever leaves last. Keep, cap, or drop with the fee?

**Contributors and reviewers**
11. What stops two of three reviewers approving a friend, cheaply, without bonds?
12. Is leaving with raised money a fair price for earned Shares, and should it be limited for a time after a raise?
13. What would you measure in the pilots beyond the list above?

**Selling**
14. Anyone can stop a sale while the treasury holds another asset, which today lets anyone stop every sale. How would you
    keep the first without the second?
15. Should a tranche have a minimum to raise (sell enough or sell nothing), as the first auction does?

## Appendix B: where to look

| Topic | Document | Code |
|---|---|---|
| Our incentive pre-check and its scripts | [FUNDING-REVIEW-2026-10-31.md](FUNDING-REVIEW-2026-10-31.md) | [funding-review-2026-10-31/](funding-review-2026-10-31/) |
| The journey and funding terms | [FUNDING-TERMS.md](FUNDING-TERMS.md) | `contracts/src/FundingTerms.sol` |
| Fundraising kit rules and worked examples | [TOKENOMICS-PROPOSAL.md](TOKENOMICS-PROPOSAL.md) (§0a has later corrections) | `DaoLaunchKit.sol`, `MilestoneChallenge.sol` |
| Weekly rounds | [WEEKLY-ROUNDS.md](WEEKLY-ROUNDS.md) | `WeeklyRounds.sol` |
| Sales between members | DECISIONS.md D117 | `MatchedExit.sol` |
| Payouts | [PAYOUTS.md](PAYOUTS.md) | `Payouts.sol` |
| Pledges to the next milestone (not built) | [PLEDGES-STATES.md](PLEDGES-STATES.md) | — |
| Contributor projects | [CONTRIBUTOR-KIT.md](CONTRIBUTOR-KIT.md) | `ContributorKit.sol` |
| Voting | — | `AllocationVoting.sol` |
| What is checked | [AUDIT-SCOPE.md](AUDIT-SCOPE.md) | `contracts/test/`, `scripts/simulate-raise.mjs` |
| Every decision and why | [DECISIONS.md](DECISIONS.md) | — |
