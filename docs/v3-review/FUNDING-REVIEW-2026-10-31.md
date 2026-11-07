# Funding review: a pre-check before the outside tokenomics review (2026-10-31)

Run with the `funding-review` skill (`.claude/skills/funding-review/SKILL.md`) by four reviewers in parallel:
settings and market conditions (A), ownership and money paths (B), attacks on funding terms and rounds (C), founders,
reviewers, governance and page copy (D). Every defect below was re-read against the code before it went in here. The
numbers come from the scripts in [funding-review-2026-10-31/](funding-review-2026-10-31/) (`node <script>`, no
dependencies); C's contract behaviour was also confirmed by a temporary forge test (six scenarios, all as described),
deleted afterwards. No contract or app file was changed: the contracts are frozen until the pilots (D137).

## Summary

**What holds.** Money is conserved; leaving cannot be switched off; new Shares only come from awards and the yearly cap
can only fall; a funding sale re-checks the floor when it settles and creates the units in the same transaction; nobody
can choose among settle prices; payouts to units waiting in a round add up exactly; the vote-control note on the
Contributions tab says plainly when the founder decides alone. The brief's worked example reproduces to the dollar.

**What matters most**, in the order to act on it:

1. **For the contributor pilot (no raise)**, four things touch it directly: the founder can take the first budget
   through wallets they control (D1), one vote can freeze a DAO's decisions for good (D2), the founder decides alone far
   longer than our docs say (D4), and reviewers risk nothing and cannot be replaced (D5). Voting no can also make
   a decision pass (D3). All have setting or app fixes.
2. **Before any raise**, funding rounds can be voided by anyone for almost nothing (R1, R2), cannot settle at their
   lowest price on many floors at or above $1 (R3), and price on a one-cent grid that is far too coarse for units worth
   fractions of a cent (R4). The first three need contract changes; the fourth is partly a deploy setting.
3. **Also before any raise**: Loot buyers have no way to leave in the app although the page says they can (R5); awards
   stay uncapped after money comes in (R6); a limit raise opens a fee-free window, even over a round already selling (R7);
   and money waiting in the payouts module or an expired budget is outside the price check (R8).

Raises are behind build flags today, so nothing in group 2 or 3 is exposed in the contributor pilot.

## Findings for the contributor pilot

### D1. The founder limits apply to one wallet, so the founder can take the first budget through other wallets — design question that defeats D79

The kit only stops the founder's own address from reviewing (`ContributorKit.sol:128-130`). The founder names the
reviewers, the start form allows one reviewer deciding alone (`contributor-project.ts:180-183, 401-405`), and the founder
manages every first project, deciding which claims count (`TreasuryMandate.sol:249-258`). Sequence: a second wallet
claims, the founder binds it, a reviewer the founder named approves, the 7-day wait passes, and a bounded award vote
passes on the founder's votes alone. The first such award can run about **9 days** after launch, before anyone else
holds Shares. With §8c's numbers (1M founder, 3M budget) the page then shows the founder at 25% while they hold 100%,
and nothing is left for later joiners. Script: `d/founder-control.mjs`.

- **Fix now (setting):** the start form requires at least three reviewers, two of whom decide. *Done 2026-10-31.*
- **Fix now (copy):** Start, the Contributions tab and "Before you buy" say the founder chose the reviewers and manages
  the first projects (today only the founder sees the latter, `FirstProjectsField.tsx:64`). *Done 2026-10-31 on the
  Contributions tab; a contributor project has no "Before you buy".*
- **After the pilots:** awards from the first budget also need a yes from a holder other than the founder.
- **Expert:** yes — what is a sound minimum for an honest start?

### D2. One vote can end all later decisions — defect

`setMinYesVotesAbsolute`, `setQuorumAbsolute` and `setProposalThreshold` take any value, and `setQuorumBps` up to 100%
(`MolochPatched.sol:1209-1220, 1252`). `openProposal` uses the higher of the lane's bar and these
(`AllocationVoting.sol:263-264`), and a minimum above `uint96` makes every new proposal revert. One vote setting it
leaves only leaving: no awards, no spending, no unlock of transfers, ever. At month 24 of §8c the founder passes it
unless 18.4% of the other Shares vote no within about 3 days. `setLane` has bounds for exactly this reason; these four
get round them. Script: `d/governance-moves.mjs`.

- **Fix now (app):** the decision composer refuses these settings outside the same bounds `setLane` has. *Done
  2026-10-31, differently:* the composer never wrote these calls, so the risk is a decision written elsewhere. The
  decision card now names each one and marks it "Could stop every later decision" above 60% (of the Shares, or of the
  Shares that could vote when it opened), including inside a set of actions (`votingRules.ts`).
- **After the pilots:** the bounds in the contract.

### D3. Voting no can make a decision pass — design question

Turnout counts yes, no and abstain (`AllocationVoting.sol:467`). In the full lane, 14% yes alone fails turnout, but
14% yes plus 6.00% to 7.21% no passes; in the bounded lane, 7% yes plus 3.00% to 5.73% no passes. The decision card
says "Passes when at least X Shares take part and 66% of them back it" (`DecisionCard.tsx:156-157`), with no warning.
Script: `d/governance-moves.mjs`.

- **Fix now (copy):** say it beside the vote buttons when turnout is short. *Done 2026-10-31.*
- **After the pilots:** count only yes and abstain toward turnout.

### D4. The founder decides alone for much longer than the docs say, and leaving protects nothing while the treasury is empty — design question (D79, §6 option 3)

[TOKENOMICS-PROPOSAL.md §8c](TOKENOMICS-PROPOSAL.md) says the founder "decides alone until about month 6". With nobody
else voting, 26.3% at month 24 still clears the 20% turnout bar; the founder carries every full-lane decision until
supply passes 7.5M. Share of other holders who must vote no to block a founder-only yes: month 6, 56.7% (full) and 90%
(bounded); month 12, 30.9% and 49.1%; month 24, 18.4% and 29.2%. A second budget at month 12 with reviewers the founder
picks (nothing stops the founder sitting on later panels) takes founder-side Shares to 67.7%, and a contributor who
leaves first takes $0. Script: `d/founder-control.mjs`.

- **Fix now (docs, copy):** correct §8c and the brief; say on the page "Leaving pays your part of the treasury now; it
  does not protect your share of the project." *Done 2026-10-31* (§8c, the leaving panel, the Contributions tab).
- **After the pilots:** §6 option 3, contributors must also agree to big changes.
- **Expert:** yes.

### D5. Reviewers risk nothing and cannot be replaced — design question (D44, D103)

Reviewers cannot approve their own claim (`VerifierSet.sol:147`), but two of three can approve a friend, for up to
100,000 Shares per project (3% of the project at month 12). The kit posts no bond (`ContributorKit.sol:143`), the award
vote sets the size, and an award is never taken back. A budget's reviewers cannot be changed after it is made; the only
remedy, `close()`, also blocks every approved claim still waiting for its award (`TreasuryMandate.sol:278`). Script:
`d/governance-moves.mjs`.

- **Fix now (setting and practice):** three reviewers, two of whom approve, chosen as identifiable people with conflicts
  disclosed (see D1). *Done 2026-10-31 in the start form:* the founder must say how they know each reviewer, published
  with the project. *Revised after outside feedback the same day:* a bond is not the first answer, since it needs
  provable misconduct and someone credible to judge it, and does not make a judgement of quality independent.
- **After the pilots:** replacing a reviewer; a `close()` that still lets approved claims be awarded.
- **Expert:** yes — what stops collusion cheaply?

## Findings before any raise

### R1. Anyone can void any funding round with 1 wei of ETH — defect (griefing, D134)

The DAO accepts ETH (`MolochPatched.sol:1448`) and the one-asset check refuses any ETH balance at all
(`FundingTerms.sol:276`), at the tranche's opening and at settlement. Sending 1 wei costs about 15k gas; leaving cannot
clear it (it rounds to zero); there is no `accept` for ETH, so only a full vote sending it out works, at least 3.5 days,
and a new funding round waits 7 days. Resent before each settlement, it is an indefinite veto. Confirmed by forge.

- **Pilot:** none exposed (raises off); note it in the runbook.
- **After the pilots:** a dust threshold, or accepting ETH up to an amount.

### R2. A holder of the smallest unit can block every tranche with a made-up token — defect (griefing, D136)

`flag` needs only a non-zero balance of Shares or Loot (`FundingTerms.sol:173`) and a token that reports a balance for
the DAO (`:178`); a token the attacker writes can report anything. In the forge test a buyer of 1 wei of Loot deployed a
new token each week and flagged it at settlement; every round went void; each `accept` needed a new full vote; the
16-slot list never fills, since accepting frees a slot. Script: `c/actors.mjs`; confirmed by forge.

- **After the pilots:** a bond or a minimum holding to flag; or take the list as it stood when the round opened; a dust
  threshold.
- **Expert:** the trade between "anyone can stop an underpriced sale" and "anyone can stop every sale".

### R3. A funding round cannot settle at its lowest step when the floor is $1 or more and not a round number — defect (D133, D134)

At a floor of $1 or more the step is 1% of the floor, rounded down (`WeeklyRounds.sol:248`). The lowest step a tranche
is offered at is two steps up, `F + 2·⌊F/100⌋`, but settlement requires `1.02 · floorNow` (`:362`), which is a few
millionths of a dollar higher whenever the floor is not a multiple of 100 micro-USDC. Every undersubscribed tranche
clears at that step, so it goes void. 99% of floors between $1.00 and $1.10 fail. Example: $250,123.45 over 120,000 units
gives 2,126,048 against 2,126,050 needed. The existing tests use a floor of exactly $1. Confirmed by forge.

- **Pilot workaround (app):** set the least price so the lowest step is at least three.
- **After the pilots:** round the step up, or compare against `⌈1.02 · F⌉`.

### R4. The one-cent price step is far too coarse for units worth fractions of a cent — defect against the docs (D131, D133)

The step is the larger of 1% of the floor and `minStep`, deployed as one cent per whole unit
(`WeeklyRounds.sol:248-249`, `scripts/sepolia-deploy.sh:149`). So 1% steps apply only when a unit's floor is at least
$1, not "while the treasury is empty" as the contract comment and [WEEKLY-ROUNDS.md](WEEKLY-ROUNDS.md) say. Script:
`a/p1-grid.mjs`.

| Units / treasury | Floor | One step as % of floor | Lowest tranche price |
|---|---|---|---|
| 1M / $5k | $0.005 | 200% | 5× floor |
| 1M / $50k | $0.05 | 20% | 1.4× floor |
| 5.7M / $12k (the brief's example) | $0.0021 | 475% | 10.5× floor |
| 10M / $50k | $0.005 | 200% | 5× floor |
| 1B / $250k | $0.00025 | 4,000% | 81× floor |

Steps exceed 5% whenever the floor is under $0.20. With an empty treasury the lowest bid is one cent, a $57k valuation
at 5.7M units. No single `minStep` fixes it: the grid is linear with 1,023 steps above the floor, so a smaller step
lowers the highest price a round can reach (11.23× the floor at 1% steps; the brief's example tranche at 24.8× the floor
would be refused). And a price is a whole number of micro-USDC per unit, so at 1B units true 1% steps need a $100k
treasury whatever the setting. Scripts: `a/p1-grid.mjs`, `a/p5-rounds.mjs`.

- **Deploy setting (now possible):** two or three rounds contracts (`minStep` of one cent, 0.01 cent, 1 micro-USDC),
  with the app choosing one from the project's floor. Funding terms name their rounds contract for good
  (`FundingTerms.sol:122`), so the choice must be made before terms are published.
- **Fix now (copy):** show one step as a percentage and the lowest tranche price as a multiple of the floor before terms
  are voted. Today the page says "plus 2%" (`FundingCard.tsx:129-130`, `FundingDecisionForm.tsx:294`).
- **After the pilots:** a grid of equal percentage steps (1% over 1,023 steps spans 26,000× the floor), or a grid
  anchored at the tranche's least price.
- **Expert:** yes — what grid suits small creative projects; and whether units should be fewer (a million rather than a
  billion) so prices are readable.

### R5. Loot buyers have no way to leave in the app — defect (app)

"Before you buy" says "For now you can leave with it at any time" (`funding-copy.ts:73`), but the exit screen never
burns Loot (`RagequitPanel.tsx:422, 546, 691` all pass `lootToBurn: 0n`), lists it as "Non-voting shares (kept)", and
tells a holder with only Loot "This account holds no shares, so there is nothing to leave with" (`:360`). The only way
out is leaving at the moment of collecting from a round. Loot also cannot be offered in a holders' round (rounds trade
Shares).

- **Fix (app, before any raise):** Loot in the exit screen.

### R6. Awards stay uncapped after money comes in — design question (D79, D133)

Contributor projects award without a yearly cap, and publishing funding terms changes nothing. In §8c extended past a
tranche and a year of payouts (script `b/pass2a-contributor-funded.mjs`), the founder alone clears the turnout bar; a
57M-Share budget passes unless 13.6% vote no, and takes Loot buyers from 9.1% to 0.9% of units and payouts, their exit
from $4,677 to $464 against $29,700 paid. The fix exists in the contract: a vote can turn the cap on, `setIssuanceRule`
from no cap to any cap (`MolochPatched.sol:1817`); the app offers no such decision.

- **Fix (app, before any raise):** funding terms come with a yearly award cap in the same decision, or "Before you buy"
  states plainly that there is none.
- **Expert:** yes — the cap's size for a project that has taken money.

### R7. Raising the funding limit waives the exit fee for 30 days, even over a round already selling — gap between D133 and D135

`publish` restarts the notice on any raise of the limit, even by one unit (`FundingTerms.sol:117, 127`), and the fee is
waived under notice (`:270`). A round opened before the raise still settles. Forge (200 USDC, 200 units, 5% fee, 100
units sold at 1.50, the limit raised by 1 wei during bidding): a holder leaves with 116.67 instead of 110.83; at a $250k
treasury that is about $7,300 that should have stayed. The fee only stops timing trades on inflows smaller than
fee/(1−fee) of the floor: 5.26% at 5%, 2.04% at 2%. Script: `c/actors.mjs`.

- **Fix now (app):** no limit-raise proposal while a funding round is open.
- **After the pilots:** settlement checks the notice, or the waiver covers only units held before the raise.
- **Expert:** whether a fee waiver on every raise is right at all.

### R8. Money waiting outside the treasury is outside the price check — defect in the backstop (D122, D134)

The settle check reads only the treasury's own balance (`WeeklyRounds.sol:362`). Revenue waiting in the payouts module
is split only when someone calls `distribute` (`Payouts.sol:118-128`), and an expired budget's unspent money returns only
when someone calls for it. Example: 100k units, $200k treasury, $60k revenue waiting (20% to holders): buyers pay
$42,000 for 20k Loot at $2.10, call `distribute`, and can leave with $49,367 (+$7,367) taken from earlier holders; with
$30k in an expired budget instead, +$3,431. The same applies to holders' rounds and to leaving: whoever holds when
`distribute` runs gets the payout (`c/actors.mjs`: a buyer at the floor gains $675 on a $10k payout; the seller gives up
$1,000). At the brief's example size the one-cent step happens to block it. Scripts: `b/pass3-money-paths.mjs`,
`c/actors.mjs`.

- **Fix (app, before any raise):** settling and the exit screen first offer to split waiting revenue and return expired
  budgets, and the least-price form shows money waiting.
- **After the pilots:** settlement and leaving call `distribute`, or the floor counts the treasury's part of it.

### R9. Holders' rounds price against cash only while leaving pays every asset — design question (D131, D134)

Funding sales stop while the treasury holds other assets; holders' rounds do not. Treasury of $10k USDC and $40k of
ETH, 1M units: a seller at step 0 ("the floor", $0.01) sells for $1,000 what leaving would pay $4,900 for, and the
buyer leaves at once with the difference. The page says "Bid at least {floor}: what leaving pays"
(`rounds-copy.ts:152`), which counts only the round's currency. Script: `a/p5-assets.mjs`.

- **Fix now (copy):** show what leaving pays in every asset beside a seller's price.
- **After the pilots:** the one-asset rule for holders' rounds too.

### R10. Accepting a token accepts any amount of it later — design question (D136)

After dust of a token is flagged and accepted, 300 more arrive; a tranche at 1.02 still sells and the buyer leaves with
100 of the token, cutting old holders' part from 300 to 200 (forge). An outsider can push a DAO into accepting a token
with dust, then buy cheaply when a real inflow lands; an accepted token cannot be flagged again (`FundingTerms.sol:177`).

- **Fix now (copy):** the decision says what accepting means.
- **After the pilots:** accept up to the balance at the time of the vote.

### R11. Smaller items before any raise

- **Funding terms are open to fundraising-kit DAOs in the contract** (`FundingTerms.publish` accepts any DAO; only the
  app gates it, `DecisionComposer.tsx:230-235`). Voting Shares sold that way bypass the 10% cap, and a tranche sold while
  team Shares are locked loses Loot buyers 28% as milestones unlock. After the pilots: refuse kit DAOs, or count funding
  Shares against the cap. Script: `b/pass2b-kit.mjs`.
- **The yearly cap is not "at most 9.1% a year" of exit value.** Its base is fixed when a cap year starts, so awarding
  10% at the end of one year and 10% at the start of the next cuts 17.36% in two days, and 16.67% if half the base has
  left. Copy now; after the pilots a rolling window. Script: `b/pass2b-kit.mjs`.
- **Holders' rounds and a funding round can settle in the same week**, so sellers at step 0 sell at the old floor, 16.67%
  below the new one after a large tranche. The cut is also measured against the opening floor (`WeeklyRounds.sol:494`).
  Copy now (show the parallel funding round); after the pilots, alternate weeks.
- **A late objection can be used up by an ally** (fundraising kit, D58): only one per milestone
  (`MilestoneChallenge.sol:367`); an ally objecting on day 0 for a $50 deposit, voted down in 5 days, makes the
  milestone safe from day 5 instead of day 30. A larger deposit, or a second objection with new evidence.

## Design questions for the expert, with numbers

- **The last units out pay no fee and collect everyone else's** (D136). With a 2% fee, if a 99% holder leaves first, a
  1% holder then takes 2.98× their share (5.95× at 5%); in a wind-down, one unit kept out of a million collects $1,000
  instead of $0.05. It discourages running, but a dust holder can capture it. Script: `a/p5-exits.mjs`.
- **With no buyers, spending drives a first-mover advantage.** Leaving itself does not lower the floor, but spending
  does: $50k, 1M units, $5k a month, a tenth of holders leaving each month — the first leaver gets $4,900, the sixth
  $1,298, and runway falls from 5 months to about one. A budget vote can fail to execute if 21% leave during its review.
  Script: `a/p5-exits.mjs`.
- **Leaving just before a milestone unlock pays** (D72). $250k, 750M sold, 250M team in four quarters: each unlock lowers
  the floor 6–8%, more than a 2% fee; leaving before the first unlock pays 8.3% more than just after. Script:
  `a/p5-exits.mjs`.
- **The fee is not waived for other votes that dilute** (an award budget, naming an exchange, a new payout split), though
  D135's reason for waiving it applies. Small sums ($95 for all Loot buyers in the example). Script:
  `b/pass2a-contributor-funded.mjs`.
- **Earned Shares can drain a fresh raise.** If every Shares holder leaves right after the example tranche, they take
  $37,716 and Loot buyers keep $3,984 of the $29,700 they paid. Script: `b/pass2a-contributor-funded.mjs`.
- **A "last trade" price is cheap to fake** (1 unit at 3× the floor costs a $0.20 cut), which matters for the price
  history in [ROUND-PRICE-HISTORY.md](ROUND-PRICE-HISTORY.md): show the volume beside it.

## Doc and copy mismatches

| Where | Says | The code |
|---|---|---|
| `WeeklyRounds.sol:51-52, 102`, WEEKLY-ROUNDS.md | `minStep` applies while the treasury is empty | whenever the floor is under $1 (R4) |
| FUNDING-TERMS.md, the brief, `FundingCard.tsx:129`, `FundingDecisionForm.tsx:294` | tranches sell "2% above the floor" | two steps above, often far more (R4); the settle check is 2% |
| `WeeklyRounds.sol:361` comment | "two steps above what leaving pays now" | the check is 2% |
| The brief, weekly rounds | the DAO may sell Shares it holds | impossible in any kit DAO (`MolochPatched.sol:1888`); D133 already corrected D131 |
| The brief, money table | payouts raise the floor | a declared payout lowers it; unlocks, returned budgets, refunds and slashes are missing |
| The brief | 1,024 steps above the floor | 1,023 above; step 0 is the floor |
| WEEKLY-ROUNDS.md | Shares waiting in a round earn no payouts | they do since D136 |
| WEEKLY-ROUNDS.md | funding units are created at each claim | at settlement (D134) |
| TOKENOMICS-PROPOSAL.md §8c | founder decides alone until about month 6 | until supply passes 7.5M (month 24+) if others do not vote (D4) |
| TOKENOMICS-PROPOSAL.md §8a, §8b | most new Shares allowed: 1.21M, 12.1M in all | 200,650 and 1,968,000 new in 24 months |
| TOKENOMICS-CONTRACT-CHANGES.md §4 | the cap's base is the exit's total | it leaves out Loot (`MolochPatched.sol:1828`) |
| D75, the brief | presets 80/20/0 and 65/35/0 | only 75/25/0 exists (`allocation.ts:82`) |
| `funding-copy.ts:73` | Loot can leave at any time | not in the app (R5) |
| `share-rules.ts:128-129` | new Shares only for accepted work | a vote picks the reviewers and sets each award's size |
| `matched-exit-copy.ts:46` | (silent) | Shares bought carry votes |
| FUNDING-TERMS.md | (silent) | anyone can send ETH; a raise during an open round waives the fee while its money lands |

## Settings

| Setting | Value | Where | Who changes it |
|---|---|---|---|
| Split limits | sale ≥ 60%, team ≤ 35%, reserve ≤ 20% | `DaoLaunchKit.sol:460-462` | fixed |
| Milestones | 2 to 8, each ≤ 50% | `DaoLaunchKit.sol:467-471` | fixed |
| Objection window | 1–30 days (app 7), longer for larger tranches, up to 60; vote 1–30 (app 5); clawback ≤ 180 (app 30) | `MilestoneChallenge.sol:211-215, 283-290`; `daoLaunch.ts:86-99` | at launch |
| Yearly award cap | 10% fundraising; none for contributor projects | `DaoLaunchKit.sol:166`; `ContributorKit.sol:83, 165` | a vote can lower or turn it on, never raise |
| Founder's start | ≤ 1/3 of the first budget, not its reviewer (per wallet) | `ContributorKit.sol:127-130` | fixed |
| Proposal threshold | 1% of the founder's starting Shares (does not grow) | `ContributorKit.sol:111-114` | a vote, unbounded (D2) |
| Full lane | 20% turnout, 66% agreement, 48h review, 12h hold | `AllocationVoting.sol:160` | a vote, within 5–60%, 50.01–90%, 1–14 days |
| Bounded lane | 10%, 55%, 24h, 6h | `AllocationVoting.sol:161` | same |
| Queue, lifetime, DAO turnout | 1 day, 14 days, 5% | `MolochPatched.sol:444-445` | a vote; the queue can drop to 1 second, so about 2 days in all |
| Notices | terms and limit raises, unlocking transfers, naming an exchange, payout split: 30 days | `FundingTerms.sol:45`; `MolochPatched.sol:1603, 1652-1666`; `Payouts.sol:42` | fixed; lowering the fee or limit is immediate |
| Exit fee | 0–5% (app suggests 2%), set once | `FundingTerms.sol:49, 113-125` | lower only |
| Fee waived | under notice; the last units out | `FundingTerms.sol:268-271`; `MolochPatched.sol:1166` | any limit raise restarts it (R7) |
| Funding price | ≥ 2 steps and ≥ least price at opening; ≥ 1.02× floor at settling | `WeeklyRounds.sol:234-239, 361-364` | fixed |
| Rounds | 3 days bidding, 2 to settle, every 7 days; 1,024 steps of max(1%, `minStep`); a fifth of the gain above the floor to the treasury | `WeeklyRounds.sol:83-95` | fixed |
| `minStep` | one cent per whole unit | `scripts/sepolia-deploy.sh:149`, `dev-chain.sh:1100`, `DeployLaunchKit.s.sol:97` | deploy argument (R4) |
| Claim wait, lapse | 7 days, 30 days | `TreasuryMandate.sol:46, 161` | fixed |
| Reviewer bond | none in the contributor kit | `ContributorKit.sol:143` | per budget |

## Questions to add to the expert brief

1. A sound minimum for an honest start: how many reviewers, who picks them, and should the first budget's awards need a
   non-founder yes? (D1)
2. What price grid suits projects whose units are worth fractions of a cent, and should projects have fewer units? (R4)
3. "Anyone can stop an underpriced sale" against "anyone can stop every sale": how to keep the first without the second?
   (R1, R2)
4. Should money coming in bring a yearly award cap with it, and how large? (R6)
5. Should a fee waiver follow every limit raise, and should other dilutive votes waive it too? (R7)
6. The last leaver collecting the fees: keep, cap, or drop? (first design question)
7. What protects contributors' share of the project, not just their part of the treasury, while the founder holds a
   quarter? (D4)
8. Reviewers risk nothing today: what stops two of three approving a friend, cheaply? (D5)
