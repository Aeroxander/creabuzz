---
name: funding-review
description: >
  Review Creaton's project economics (who owns what, how money comes in and leaves, whether anyone can game it) before an
  outside tokenomics expert does. Use when asked to check the fundraising journey, funding terms, weekly rounds, exits,
  awards or dilution, to prepare or update the expert brief, or to answer an expert's question with numbers.
version: 1
---

# Funding review

A pre-check of the economics, so the expert's paid hours go on judgment, not on gaps we could find ourselves. It does
not replace them, the contract audit, or a lawyer.

## Ground rules

- **The code is the truth; the docs are claims about it.** Read every number you use from `contracts/src` (constants,
  constructor arguments, kit checks) or from the deploy scripts (`scripts/sepolia-deploy.sh` pins deployed values such as
  the rounds' `minStep`). When a doc disagrees with the code, that is a finding.
- **Contracts are frozen until the pilots have run (D137).** Propose fixes as settings, deploy parameters, app copy,
  simulation cases, or a contract change for after the pilots, labelled as such. Do not edit `contracts/`.
- **Compute, never estimate.** Every number in a finding comes from a script in the scratchpad (or a forge test, or
  `scripts/simulate-raise.sh`). Put the script's inputs next to the result.
- **Each finding is a scenario**: who does what, in what order, with what amounts, and who ends up with what. "Could be
  gamed" without a sequence is not a finding.
- **Separate defects from design choices.** A rule that works as decided but that you think is wrong is a question for
  the expert or the owner, linked to its decision row, not a bug.
- **Plain words** in anything the owner or the expert reads (see the project's copy standard): Shares, Loot, leaving,
  the treasury, the floor, a round, a tranche. No jargon without a line saying what it means.

## Sources

| What | Where |
|---|---|
| Expert brief (keep it in step with findings) | `docs/v3-review/TOKENOMICS-REVIEWER-BRIEF.md` |
| Journey, funding terms, exit fee | `docs/v3-review/FUNDING-TERMS.md` (D133 to D136) |
| Fundraising kit rules (split limits, locks, issuance, trading lock) | `docs/v3-review/TOKENOMICS-PROPOSAL.md`, `TOKENOMICS-CONTRACT-CHANGES.md` (D72 to D81) |
| Weekly rounds | `docs/v3-review/WEEKLY-ROUNDS.md`, `contracts/src/WeeklyRounds.sol` (D131, D132) |
| Payouts, bounties | `Payouts.sol` and `PAYOUTS.md` (D122), `WorkAreaBounty.sol`, `OpenBounty.sol` |
| Contributor projects | `CONTRIBUTOR-KIT.md`, `ContributorKit.sol` (D65, D66, D79, D84) |
| Every decision and why | `docs/v3-review/DECISIONS.md` |
| Invariants already checked | `docs/v3-review/AUDIT-SCOPE.md`, `contracts/test/invariant/`, `scripts/simulate-raise.mjs` |
| Not built or not accepted | `JOIN-CURVE.md` (funding curve, D112), `PLEDGES-STATES.md` (D123), `CONTRIBUTOR-TOKEN-TRADING.md` |

Out of scope unless asked: the $CREATE token, the court, forecast pools, remix bonds. They touch project money only
through bounties.

## The passes

Run them in order; each one's output feeds the next. Scale to the question: a single expert question may need one pass.

### 1. The settings table

List every number that shapes ownership or money, with its value, where it is set (contract constant, deploy argument,
kit check, DAO vote), who can change it, and in which direction. At least: split limits and presets, milestone counts
and sizes, the yearly award cap (fundraising) and its absence (contributor), vote turnout and agreement bars and their
minimum times, every notice period (terms, trading, exchange, payout split), the exit fee's range and when it is
waived, the funding premium over the floor, round timing, price steps and `minStep`, the round cut, the DAO's minimum
steps, the claim wait, reviewer bonds.

Then try each at its extremes with realistic project sizes (a $5k, $50k and $250k project; 1M and 1B units). Look for
values that stop making sense at one size: a fixed one-cent step against a floor of $0.002 is a 475% jump.

### 2. The ownership table

For each path, a table by stage of who holds what share of the units, of the votes, and of what leaving pays:

- **Contributor project → funded:** founder start, awards, funding terms published, a tranche sold, holders trading in
  rounds, payouts.
- **Fundraising kit:** auction, milestone unlocks, budgets spent, awards under the 10% cap, trading opened.

Start from the §8 examples in `TOKENOMICS-PROPOSAL.md` and extend them past funding terms. Show the worst case the rules
allow next to the expected case (e.g. contributor awards have no yearly cap: what is a Loot buyer's share after a
founder-majority vote awards a large budget?).

### 3. The money paths

Every way money enters or leaves the treasury, and for each: who triggers it, who it pays, what it does to the floor
(what one unit takes out by leaving). Funding, a holder's sale (and the treasury's cut), leaving (and the exit fee),
spending into a work budget, budgets closing, payouts, bounty money, revenue arriving, other assets arriving. The
invariants already prove conservation; this pass asks who gains and who loses from each path, and whether the person
losing can see it coming in time to leave.

### 4. The actors

For each actor, what is their best move, and does the design reward the behaviour we want? Write the sequence and the
numbers for any move that pays.

| Actor | Ask |
|---|---|
| Founder | Can they keep control past the point D79 intends, stall milestones, pay themselves through budgets or awards, or dilute contributors or Loot buyers? |
| Reviewers | Can two of three approve each other or a friend? What does collusion cost them (bond, reputation) against what it earns? |
| Early contributor | Is leaving with raised money (once terms exist) better than staying? Does that drain a fresh raise? |
| Loot buyer | What do they actually buy (no vote, exit at the floor, payouts)? When is buying above the floor rational? |
| Timing trader | Buy just before revenue or a raise lands, leave just after: what does the exit fee leave them, including when it is waived (notice periods, the last units)? |
| Large holder | Can one holder move a round's price, block sales (the watch list: any holder can add any token the treasury holds), or swing a vote at the turnout bar? |
| Round participant | Self-bidding, cancelling late, settling at a chosen moment, the floor read at opening against the floor at settling |
| Outsider | Sending a token to the treasury, dust orders, griefing that costs them little and the project a vote or a week |

### 5. Market conditions

Run the journey with no buyers, few buyers, and many. When buyers are scarce, leaving is the fallback and it costs
runway: what happens to the floor, the remaining holders and the project after a run of exits? With many buyers, does
the price grid (1,024 steps) cap what a round can express?

### 6. What people are told

Read the pages and copy a buyer, contributor and founder sees (`web/src`, the Funds tab, "Before you buy", decisions)
against what passes 2 to 5 found. A true rule that the page omits or blurs is a finding.

### 7. Check with the chain where you can

`scripts/simulate-raise.sh` covers the fundraising kit; funding terms and rounds have forge tests
(`FundingTerms.t.sol`, `WeeklyRounds.t.sol`) and `scripts/web-rounds-e2e.sh`. For a scenario none of them runs, write it
as a proposed simulation case or forge test (description, steps, the assertion) rather than trusting arithmetic alone.

## The report

Write `docs/v3-review/FUNDING-REVIEW-<date>.md`:

1. A short summary: what holds, the few things that matter most.
2. Findings, most important first. Each has: a title; **defect** or **design question**; the scenario with numbers and
   the script that made them; who is hurt and by how much; the decision row it touches; fix options (setting, deploy
   parameter, copy, after-pilot contract change); and whether it needs the expert.
3. The settings table from pass 1.
4. Questions for the expert, sharpened by what was found. Copy any new ones into the brief's question list.

Then update the brief where a finding changes a fact or a question in it.
