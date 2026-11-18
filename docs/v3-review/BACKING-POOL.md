# Backing pool: instant backing, tied to the record

**Status (2026-11-11, branch `v4-governance-rework`): built and tested, deployed nowhere.** Contracts:
`contracts/src/BackingPool.sol`, `BackingPoolFactory.sol`, `BackingClaim.sol`, `ContributorKitV3.sol`. One internal adversarial
review (2026-11-11) found three medium flaws; all are fixed here and its proofs are now regression tests. A
second review of the round (two skeptics per finding) confirmed seven more, fixed or written down below: the
vote could be corrupted by exchanging claim tokens, the vote wait could be skipped through claim tokens,
rounding leftovers of a round counted as a backer, a protocol fee above the raise bricked the settlement, the
round's blocks were counted on the wrong clock on Arbitrum, the launch was unbounded in reviewers and name
length, and three limits of the registry and the summoner (see "Not protected"). A third, narrow pass found
only low issues, all fixed or written down: a dust buy restarting the abandonment clock, an auction on another
clock than the factory leaving a pool waiting, a round whose sweep cannot be made blocking the project for ever,
and the corrections in "For the app" and "Not protected". A fourth change (2026-11-15) answers the owner's worry that a
project doing fine can still be run on: leaving at a milestone no longer sells (see "Runs on the curve"), and a founder
chooses how deep the curve is from a short list of tiers (see "Runs on the curve"). A review of those changes (2026-11-15) found that the
leaving fee outgrew the refund over time, and that units that had already left were charged again and burned later
weight; both are fixed (see "Why leaving has a fee" and "Units that already left"). A fifth change (2026-11-15) dropped the
shallowest tier, 5,000, after the arithmetic of what the first buyers hold was written down: six tiers, 10,000 the
shallowest, 25,000 still the default (see "What the first buyers hold"). No outside audit. The numbers below are defaults for a testnet trial, not production terms, and the questions
for counsel at the end are open.

## What it is

Each project can have one backing pool. Anyone buys the project's **backing units** from the pool with the
quote token, at a price that rises as more are bought, and can sell them back to the pool at any time. One
transaction, no rounds, no seats, nobody has to run anything.

Every buy is split three ways:

- **1% fee** to the project's treasury, at once. It never goes to an operator. Sales pay 1% too.
- **10% of the rest is the project's money.** It is held in the pool (the escrow) in your name. The project
  receives it a quarter at a time, at milestones.
- **The remainder (89.1% of what you paid) is the reserve.** It only ever pays people who sell.

## Two ways to open

- **Open with a fair round** (the default for new projects). For about a week (50,000 blocks) people bid in
  an auction, the same Uniswap auction (Continuous Clearing Auction) our raise path already uses, unchanged.
  The auction finds the price as bids come in, so nobody wins by being first. The founder chooses at most
  the minimum to raise (default 2,500: the whole round at the opening price).
  - **Minimum not reached:** every bidder takes all of their money back from the auction itself. The pool
    never opens, and the project may open another.
  - **Minimum reached:** anyone settles the round. The money raised is split exactly as a buy is (1% fee,
    10% of the rest held as project money, the rest to the reserve) and the curve goes live. Bidders collect
    claim tokens from the auction and exchange them here for units, one for one. Their held project money
    is shared by units.
  - **The curve opens at the average price the round paid, not at the auction's last price.** In this
    auction bidders pay different prices over the week, and the last price is the highest. A curve opened
    at the last price could owe sellers more than the round raised, so it opens at the price the money
    actually raised supports. A late bidder can therefore see the curve start below what they paid. The app
    shows both numbers (`clearingPriceX96` and `openingPrice`).
- **Open now.** The curve is live in the same transaction, starting at 0.000025, with the early cap.

## For a backer

- **Buy:** you pay, you get units. You set the fewest units you will accept and a deadline, so a price that
  moved against you cancels the buy.
- **Sell, any time:** the pool pays you from the reserve at the current price, less the 1% fee. The reserve
  can always pay every holder, in any order (see "Why sells always clear"). An ordinary sale leaves your held
  project money behind for the backers who stay: buy and sell straight back and you get about 88%.
- **At each milestone you can stay, or leave with your held money back.** When the project posts a
  milestone you have 7 days. If you stay, a quarter of your held money goes to the project. If you leave,
  you get all of your held money back (the part of the tranche included), less a fee (below), and nothing is
  taken for that milestone. **Leaving sells nothing.** You keep every unit, the curve does not move, and nobody
  else's price changes because you left. What you give up is your claim on every later milestone: your held
  money is gone from the pool, so the units you keep fund nothing from then on (money you put in later is held
  again, for the new money only). Nobody can stop a release, and nobody is made to fund a milestone they reject.
- **The leaving fee:** the ordinary 1% sale fee, charged on what your units would fetch on the curve now, as if you
  had sold them, but taken out of your refund and never more than your own part of the next tranche (what staying
  one more milestone would cost you). So leaving never costs more than staying, and at the default tranche you always
  get back at least three quarters of your held money, whatever the price has done. Selling the units later costs
  the ordinary 1% again. See "Why leaving has a fee".
- **Bought in the round?** Exchange your claim tokens for units first; until you do, your part counts as
  staying.
- **You can only leave if you held a weight before the milestone was posted** (you hold units with a part of the
  held money behind them) and have not bought since. Money you put in after a post is not touched by that
  milestone. Units with no held money behind them (you already left, or your buy was too small to count) cannot
  leave, and get no refund if the project is later abandoned; they sell like any other units, and a sale uses them
  before any unit that has held money behind it (see "Units that already left").
- **If the project is abandoned** (see below) you sell as usual, with no fee, and each sale also returns
  your held money. Nobody has to declare anything first.
- **Units are not Shares.** They carry no vote in the project and cannot be sent to another wallet.

## For a founder

- **Open with a round:** create the project, then one call, `BackingPoolFactory.openWithRound(dao, minimum, depth)`
  (zero for the default minimum, and zero or a tier for the depth). It is a second transaction because the two
  together do not fit in one (18.7 million gas against a cap of 16.8 million on some chains; that figure was
  measured before the depth was added and was not measured again).
- **Open now:** a new project gets its pool in the transaction that creates it
  (`ContributorKitV3.launchWithPool(params, depth)`, the same inputs as today's launch plus the depth, with at most
  8 reviewers, a name of at most 64 bytes and a symbol of at most 12; the V2 kit has no such caps), or an existing
  project made with `ContributorKitV2` opens one with a single call from the founder
  (`BackingPoolFactory.open(dao, depth)`). No vote either way. A project from the older kit has no founder on
  record, so its pool takes one passed decision.
- **You choose one thing: how deep the curve is.** The depth is one of six tiers (`BackingPoolFactory.depthTiers()`:
  10,000, 25,000, 50,000, 100,000, 250,000 and 500,000 whole quote units), or zero for the default (25,000).
  Every other term is fixed in the factory. A deeper curve moves the price less when people sell; the rule of thumb
  is the first tier that is at least twice the raise you hope for. See "Runs on the curve" and "What the first buyers
  hold" for the numbers.
- **Getting the money:** fees arrive as people trade. For the rest, post "milestone reached" with the id of
  the public record event. That fixes the tranche: a quarter of what is held at that moment. Seven days
  later anyone can release it to the project treasury, less the part of those who left. Release it within
  the next seven days; after that the milestone can only be cancelled and you post again. The first post is
  possible 28 days after opening (after the round is settled, if there was one), then one every 28 days.
- **You stay the one who can post for the life of the pool** (the DAO can too). Posting is your only power:
  fees and released money go to the DAO treasury and nowhere else, and spending them is the DAO's decision.
- **Your own Shares** stay locked on their sale schedule exactly as today. The pool mints no Shares.

## Abandonment

A project is abandoned when backers hold money in the pool and **180 days pass without a release that paid
something**. It needs no vote and no call: from that second buying and milestones stop for good, and the
next sale is a refund. Backers holding more than half the held money can also vote it abandoned once 90 days
have passed without a release (a wallet can vote 30 days after its last buy or its last exchange of claim
tokens; buying or exchanging again withdraws its vote). Since nobody can block a
release, only a founder who stops posting, or that vote, gets a project there. A pool nobody is backing is
never abandoned; the clock starts again with the next backer.

## Every setting and its default

| Setting | Default | Why |
|---|---|---|
| Curve: paper reserve (the depth) | 25,000 quote, or a tier: 10,000, 25,000, 50,000, 100,000, 250,000, 500,000 | The founder picks the tier when the pool is opened. At the default the opening price is 0.000025 a unit and raising 50,000 in total moves the price about 7.7 times. Deeper is flatter and gentler on sellers; see "Runs on the curve". There is no 5,000: see "What the first buyers hold". |
| Curve: paper units | 1,000,000,000 | The supply approaches this and never reaches it, so there is no sell-out and no "graduation". |
| Project part | 10% of each buy after the fee | With 30% a round trip lost 31% and needed +46% to break even, which nobody would use next to other apps. At 10% a round trip returns about 88%. |
| Fee | 1% on buys and on sales, to the treasury | Makes churn and sandwiching pay the project. Leaving at a milestone pays it on what the units that carry held money would fetch, without selling them, out of the refund and never more than the leaver's own part of the next tranche; refunds after abandonment pay none. |
| Tranche | 25% of the escrow at the post | No milestone can empty the escrow; there is no last tranche and no cliff. |
| Window to leave | 7 days | One weekly update cycle. |
| Time to release after the window | 7 days | A milestone cannot be held open to wait for a better moment. |
| Time between posts | 28 days (also before the first) | At most a quarter of the escrow a month; nothing leaves in the first four weeks. |
| Abandoned by the clock | 180 days with no release | Six missed months is a dead project. |
| Abandoned by vote | more than half the weight, after 90 days with no release | Backers can end it sooner than the clock, but not a project that is releasing. |
| Wait before voting | 30 days after a wallet's last buy or claim-token exchange | A majority cannot be bought and used the same day, and claim tokens, which are transferable, cannot be bought, exchanged and voted with in one transaction. A bidder who exchanges late only waits 30 days from then. |
| Early cap | A twenty-fifth of the depth per wallet (1,000 quote at the default) for the first 24 hours | Blunts a sniper taking the opening price in one transaction. Scales with the chosen depth. Only matters for "open now": a round lasts longer than the cap. |
| Round: length | 50,000 blocks (about a week at 12 s) | Long enough to be seen. The number must divide 10,000,000: the auction sells an equal part every block. |
| Round: supply | 100,000,000 claim tokens | A tenth of the curve's paper units, so most of the curve is left for after. |
| Round: floor price | The "open now" starting price at the chosen depth: 0.000025 at the default, 0.00001 to 0.0005 across the tiers | A round never sells below what opening now would have charged. |
| Round: minimum raise | The supply at the floor (2,500 at the default depth, a tenth of the depth); the founder may set another | Under it, everyone is refunded and nothing opens. |

"Weight" is a backer's part of the held project money. A new backer's weight is worth exactly what they
just added.

## Why units and not Shares

The DAO's Shares can only be created by a reviewed award. That rule is sealed when the project is born and
no vote can lift it, so no pool can mint Shares, on old projects or new. We would not want it to: a pool that
mints votes lets anyone buy a majority of a project in one transaction. This is also why opening a pool
needs no vote: the pool has no power over the DAO.

## Why sells always clear

The price curve runs on the reserve alone. A buy adds to the reserve and takes units out of the curve; a sale
does the reverse; both round against the trader. Because of that rounding, the product "reserve side times
units left" never falls below its starting value, so when every unit has been sold back the reserve has paid
out no more than it took in. The project money is counted separately and is never used to pay a sale. The
tests check this after long random sequences of every action: the pool's balance equals reserve + escrow +
what it owes the treasury, to the unit, and every holder can leave and then sell everything, or sell part, leave
and sell the rest, in any order. Leaving touches neither the reserve nor the supply, so it cannot affect the proof.

## Why leaving has a fee

Before 2026-11-15 leaving sold all of the leaver's units, which made a milestone the moment a project doing fine was
most exposed: every backer who left at the post also dumped units on the curve, and the people who stayed watched
the price fall. Leaving now sells nothing, which removes that shock (see "Runs on the curve"). But a leave that
sells nothing and costs nothing is better than staying for every holder who is only there for the price: staying
funds the project (2.5%, 1.9%, 1.4% ... of the position at each milestone) and leaving funds nothing and keeps all
the exposure. So leaving pays the ordinary 1% sale fee on what the units would fetch on the curve now, as if sold:
`fee = min(1% of (curve value of the units that carry held money), your own part of the next tranche)`, taken out of
your refund. The units are not sold and nothing is paid from the reserve. The fee goes to the treasury and is shown in
`quoteLeave` and in the `Left` event.

**Why the cap is your part of the tranche.** The first version capped the fee at the whole refund. A review of it
(2026-11-15) measured what that does over time: the held money shrinks by a quarter at every released tranche, and
the fee does not, so at the default terms and a flat price a backer with 1,000 in got back 90.09 of 98.999 at the
first milestone, 22.4 of 31.3 at the fifth, 1.0 at the ninth, and from the tenth on nothing: the whole held part went
to the treasury. A price eleven times higher did the same at the first milestone. That broke the rule "at each
milestone you may leave and get your held money back". The cap is now the leaver's own part of the tranche, which is
exactly what staying one more milestone would cost them (the treasury gets the fee instead of the tranche, never
more). Leaving therefore never costs more than staying, and returns at least `(10000 - trancheBps) / 10000` of the
held part: three quarters at the default. The rate is unchanged: at a flat price the fee is 1% of the units' worth,
8.91 for 1,000 put in.

What a backer who put in 1,000 and never traded again gets back by leaving (flat price, default terms; measured by
`test_leaving_returns_the_held_share_less_a_bounded_fee_at_every_milestone`, which drives the pool's own `leave`):

| Milestone | Held money | Fee | Returned | Returned under the first version |
|---|---|---|---|---|
| 1 | 99.00 | 8.91 | 90.09 | 90.09 |
| 5 | 31.32 | 7.83 | 23.49 | 22.41 |
| 9 | 9.91 | 2.48 | 7.43 | 1.00 |
| 12 | 4.18 | 1.05 | 3.14 | 0 |

From about the fifth milestone the fee is the cap (a quarter of the held money), not the 1%. With a price eleven times
higher at the first milestone the fee is the cap too, and the leaver gets back three quarters
(`test_leaving_after_the_price_has_multiplied_still_returns_three_quarters`).

**The app must set `minQuoteOut` from `quoteLeave`, never to 0.** The fee follows the curve price at the moment the
transaction runs, so anyone who buys during the window raises every leaver's fee. With the cap that can cost a leaver
at most their part of the tranche (a quarter of the held money at the default), but a leave sent with a minimum of
zero takes whatever the fee has become. The app shows the quote, sets the minimum from it with a small tolerance, and
says that the held money comes back less a fee that is never more than staying would cost.

This is a price on leaving, not a reason to stay. **Leaving is cheaper than staying at the first milestone only.** At
the first milestone staying costs about 2.5% of the position and leaving about 0.9%. From about the fifth milestone at
a flat price the 1% would be the larger number, and the cap makes leaving cost exactly what staying one more milestone
would: never more, but no longer less. (The first version of this note said leaving was cheaper at every milestone;
that was true only while the fee was small against the held money.) The project then receives the fee and the fees
from trading, and the tranche only from the people who stay. If that is too little, the levers are a higher fee on the
notional value (a per-pool constant), or a fee floor tied to the size of the tranche. Neither is built; that is the
owner's decision.

Leaving then selling the same units costs the ordinary 1% twice (about 1.8% in all at a flat price at the first
milestone, against 0.9% when leaving sold the units itself). That is a pricing choice, and it is kept (MVP-READY decision
27, 2026-11-15): one step that left and sold would be the old exit again, the one that dumped every leaver's units on the
curve at the milestone. The app shows leave and sell as two steps with the cost of each, never presents Leave as a way to
sell, and tells the person before they press Leave: the last sentence of the leave form's plan, which is also read out
with the button, is "Selling them later is a separate step with its own fee, so leaving and then selling pays a fee
twice." It states no rate (the rates are the pool's) and nothing about price.

## Units that already left

A leave ends the weight and keeps the units, so a wallet can hold units with no held money behind them. A second review
(2026-11-15) found two ways those units cost a returning backer money, both reproduced:

1. The leave fee was charged on all the wallet's units, including the ones that had already left and paid. A backer
   who left, then put in 1,000 more, paid 1% of everything on the next leave: with old units worth ten times the new
   money, that was the whole refund of the new money.
2. A later sale burned weight in proportion to all the units, so selling the old units burned about 95% of the held
   money the new buy carried and passed it silently to the other backers.

The pool now keeps one number per wallet, `bareUnitsOf(wallet)`: the units that carry no held money. A leave sets it to
all the units the wallet holds then; a buy and a redeem leave it alone; a sale uses it first. So:

- **A sale uses the old units first.** Selling units that left burns no weight. A sale larger than them burns weight
  only for the units beyond them, in proportion to the units that carry it
  (`test_selling_the_units_that_left_burns_no_weight`, `test_a_sale_uses_the_units_that_left_first_and_burns_weight_for_the_rest`).
- **The leave fee is charged on the units that carry weight only.** A backer who left and put in 1,000 more pays the
  ordinary 1% on those 1,000 (8.91), not on everything they hold
  (`test_the_leave_fee_leaves_out_units_that_already_left`).
- Units cannot be moved between wallets, so the number cannot be dodged by splitting or transferring, and it is never
  more than the units the wallet holds (`testFuzz_the_units_that_left_are_always_part_of_the_units_held`).

Code size: the two fixes together cost 223 bytes of the pool's runtime and creation code. The deployer, which embeds the pool's whole
creation code, is the binding limit (see "Gas and size"): 23,548 of 24,576 bytes, 1,028 spare, so the next pool change
worth about a kilobyte will not fit unless the claim token is deployed from a second helper.

## Runs on the curve

The worry: a project doing fine can still be run on if some backers leave at a milestone and others sell on the
curve, because the curve is a constant product with a paper reserve, so a sale of half the units takes the price down
by a share that depends on how big the raise is next to the paper reserve (`d = depth / raised`).

What the model and the passing test (`contracts/test/BackingPoolRuns.t.sol`, which runs the contract's own buy, sell and
leave over twenty wallets) show, for a sale of **half the units**:

| Raised | Default depth (25,000) | Depth at about twice the raise | Tier |
|---|---|---|---|
| 10,000 | 28.0% | 28.0% | 25,000 |
| 50,000 | 72.0% | 33.1% | 100,000 |
| 250,000 | 96.6% | 33.1% | 500,000 |

By depth ratio (a sale of half the units): `d = 1` gives a 52% drop, 1.5 gives 41%, 2 gives 33%, 3 gives 24%, 4 gives 19%
and 8 gives 10%. Staying under a 35% drop needs `d >= 1.85`; under 40% needs `d >= 1.53`.

What leaving no longer selling does, at 50,000 raised (20% of units leave, 10% are sold by others; the test uses the
first four of twenty wallets, which hold a little over a fifth):

| | Old exit (the leavers' units were sold) | New exit (the leavers keep their units) |
|---|---|---|
| Default depth (25,000) | about 61% (model, for exactly 30% sold: 57.5%) | 28.0% |
| Depth 100,000 | about 22% | 8.3% |

With 35% of the units leaving and nobody selling, the price used to fall by about 62% at 50,000 raised and the
default depth (the model: 62.1%); now it does not move at all (an assertion on `price()`, and a handler assertion on
every leave of the invariant suite).

**The cascade.** Half the holders are panickers who sell all they hold once the price has fallen past their own line (3%
to 40%); three more leave at the milestone, and one wallet holding 3% of the units starts it. Final price drop:

| Raised | Default depth, old exit | Default depth, new exit | Twice the raise, old exit | Twice the raise, new exit |
|---|---|---|---|---|
| 10,000 | 27.6% | 2.1% | 27.6% | 2.1% |
| 50,000 | 81.2% | 76.2% | 39.7% | 2.6% |
| 250,000 | 98.6% | 98.2% | 39.7% | 2.6% |

(At 10,000 raised the default depth is already 2.5 times the raise.) Read it as two halves of one fix. Leaving that
sells nothing alone does not save a thin curve: at 50,000 raised and the default depth the 3% seller alone tips it
and three quarters of the price goes. A deeper curve alone leaves the leavers' dump to start it (about 40%). Together
the cascade dies at the seed (a 2.6% price drop is short of the first line). The depth rule of thumb is therefore:
the first tier at least twice the raise you hope for.

**What depth costs.** The price multiple from the opening to the end of the raise is about `(1 + raised / depth)^2`, so a
deeper curve is flatter: `d = 2` gives 2.1x, `d = 4` gives 1.5x, `d = 8` gives 1.24x. A deeper curve trades
excitement for stability. A founder who expects 10,000 and picks the 500,000 tier gets a price that barely moves
(about 1.04x); one who picks the 10,000 tier gets a fragile curve. The tiers limit the footguns; the number is the
founder's, because the factory cannot know the raise to come, and the app is where it is steered. A raise that
overshoots the plan by three times at `d = 2` has a drop of 64% for a sale of half the units, not 33%.

**Small raises.** At the old fixed depth of 25,000 a raise of 3,000 moved the price only 1.22 times, which is dull.
A founder expecting 5,000 picks the 10,000 tier (`d = 2`): the price moves 2.1 times and a sale of half the units
drops it by 33%. One expecting 3,000 picks it too (`d` of 3.3: a 1.6 times move, about a 22% drop), and one expecting
2,500 gets a 1.5 times move and a 19% drop. A raise under about 1,500 moves the price less than 1.3 times at any tier
now: that is the price of dropping the 5,000 tier, and it is paid only by the smallest raises (see "What the first
buyers hold").

| Hoped-for raise | Tier (first at or above twice the raise) |
|---|---|
| up to 5,000 | 10,000 |
| up to 12,500 | 25,000 |
| up to 25,000 | 50,000 |
| up to 50,000 | 100,000 |
| up to 125,000 | 250,000 |
| up to 250,000 | 500,000 |

**Depth and a round.** A pool opened behind a round (`openWithRound`) does not open at the depth: it opens at the
paper reserve the round's raise supports (the average price the round paid, see "Two ways to open"). The depth sets
the round's *floor price* (the opening price at that depth, the least a bidder pays) and the default minimum raise,
so the curve that opens is about `0.89 x depth x (1 - sold / paper units)` when the round clears at the floor
(0.85 of the depth when a twentieth of the paper units sold, 0.80 when the whole supply sells at the floor), and
deeper when demand is heavier. `BackingRound.t.sol` runs a round at each of the
six tiers (`BackingRoundDepthTest`): the paper reserve is exactly the formula, the product starts at or above its
floor, the books are exact, and every round buyer gets out.

## What the first buyers hold

The worry (MVP-READY decision 23): a shallow curve gives the first buyers a very large price multiple if the project
takes in much more than its depth, which rewards being first, not the project doing well. That is the shape this
product exists to avoid. The arithmetic first, then the decision.

**The curve.** With `x = depth + reserve` and `y = paper units - units sold`, the pool keeps `x * y` at `depth * paper
units` (`BackingPool._quoteBuy`, `_curveOut`), and the price is `x / y` (`price()`). So the price is `(depth + reserve)^2 /
(depth * paper units)`, and from the first unit to the last it multiplies by `(1 + reserve / depth)^2`. The reserve is
89.1% of what was paid in (1% fee, then 10% of the rest held for the project). **The multiple is `(1 + 0.891 * taken in /
depth)^2`: it depends on how much came in next to the depth and on nothing else. Every tier gives the same row.**

| Taken in, next to the depth | Price multiple, first unit to last | The first buyer of 1% of the raise holds, at the last price | The same, sold all at once (fee taken) | Price drop if half the units are then sold |
|---|---|---|---|---|
| half | 2.09 times | 1.85 times what they paid | 1.82 times | 33% |
| once | 3.58 times | 3.16 times | 3.08 times | 52% |
| twice | 7.74 times | 6.78 times | 6.40 times | 72% |
| 5 times | 29.8 times | 25.4 times | 20.4 times | 90% |
| 10 times | 98.2 times | 80.3 times | 43.9 times | 97% |

Measured on the pool itself, at all seven depths, by `contracts/test/BackingPoolDepthMultiple.t.sol` (the pool's own
`buy`, `price` and `quoteSell`; every cell of the first four columns is within one part in a hundred of the closed form at
every depth, for example 2,975 hundredths against 29.76 at 5 times). The last column is the float model of "Runs on the
curve". "Holds at the last price" is the units times `price()`; nobody can sell at that price, which is why the sold
column is lower, and by more the bigger the holding is next to the pool. The first buyer also has 9.9% of what they paid
held for the project, which an ordinary sale gives up. The rule of thumb (a depth of at least twice the hoped-for raise)
is the first row: a price that about doubles over the raise.

**What a tier decides is how much money that takes.** The same table in money, with what the first buyer of 1% paid and
what their units are worth at the last price:

| Depth | 2.09 times at | 3.58 times at | 7.74 times at | 29.8 times at (first 1%: paid, holds) | 98.2 times at (first 1%: paid, holds) |
|---|---|---|---|---|---|
| 5,000 (dropped) | 2,500 | 5,000 | 10,000 | 25,000 (250, 6,346) | 50,000 (500, 40,172) |
| 10,000 | 5,000 | 10,000 | 20,000 | 50,000 (500, 12,691) | 100,000 (1,000, 80,345) |
| 25,000 (the default) | 12,500 | 25,000 | 50,000 | 125,000 (1,250, 31,728) | 250,000 (2,500, 200,862) |
| 50,000 | 25,000 | 50,000 | 100,000 | 250,000 (2,500, 63,457) | 500,000 (5,000, 401,724) |
| 100,000 | 50,000 | 100,000 | 200,000 | 500,000 (5,000, 126,914) | 1,000,000 (10,000, 803,447) |
| 250,000 | 125,000 | 250,000 | 500,000 | 1,250,000 (12,500, 317,284) | 2,500,000 (25,000, 2,008,618) |
| 500,000 | 250,000 | 500,000 | 1,000,000 | 2,500,000 (25,000, 634,568) | 5,000,000 (50,000, 4,017,235) |

And the same money at each depth (`test_the_same_money_multiplies_the_price_most_at_the_shallowest_depth`):

| Paid in | 5,000 (dropped) | 10,000 | 25,000 | 50,000 | 100,000 | 250,000 | 500,000 |
|---|---|---|---|---|---|---|---|
| 2,500 | 2.09 | 1.50 | 1.19 | 1.09 | 1.05 | 1.02 | 1.01 |
| 5,000 | 3.58 | 2.09 | 1.39 | 1.19 | 1.09 | 1.04 | 1.02 |
| 10,000 | 7.74 | 3.58 | 1.84 | 1.39 | 1.19 | 1.07 | 1.04 |
| 25,000 | 29.8 | 10.4 | 3.58 | 2.09 | 1.50 | 1.19 | 1.09 |
| 50,000 | 98.2 | 29.8 | 7.74 | 3.58 | 2.09 | 1.39 | 1.19 |
| 100,000 | 354 | 98.2 | 20.8 | 7.74 | 3.58 | 1.84 | 1.39 |

Two limits on reading these as "what a first buyer gets". In a pool opened now, one wallet can put in at most a
twenty-fifth of the depth in the first 24 hours (the early cap), so a single wallet cannot be "the first 1%" of a raise of
five or ten times the depth; several wallets can. In a pool opened behind a round nobody is first: every bidder gets
units at the round's own price and the curve opens at the average the round paid, so the table starts from there.

**Decision (2026-11-15): the 5,000 tier is dropped.** Six tiers, 10,000 the shallowest, 25,000 still the default. A depth
of 5,000 is refused like any other number that is not a tier (`BadDepth`).

- **Why drop it.** The shape is the same at every tier, so the shallowest tier is simply where it is cheapest: 25,000
  paid in, an ordinary amount, moved the price 29.8 times at 5,000 and left the first 1% holding 25 times their money. At
  10,000 the same money moves it 10.4 times, at the default 3.58 times. Dropping the tier doubles the money every
  multiple takes at the shallow end.
- **What it costs.** The 5,000 tier fitted one case, a raise of up to 2,500. At 10,000 that raise still moves the price
  1.5 times (and a sale of half the units drops it 19%, not 33%), and a raise of 5,000 gets the 2.09 times the old tier
  gave at 2,500. Only raises under about 1,500 lose their movement (under 1.3 times). That is a small price in fun for
  cutting the worst row in half.
- **Why not keep seven tiers and only steer the picker.** The factory is open to any caller, and the worry is a founder
  who wants the steep curve, not one who picks it by mistake. A guard that lives only in the web app does not hold
  against intent; the list has to change where it is enforced.
- **What it does not do.** It moves the line; it does not remove the shape. A 10,000 pool that takes in 50,000 is
  exactly as lopsided as a 5,000 pool that took in 25,000, and the default depth reaches 29.8 times at 125,000. Two
  things bound it. One exists only as advice: a founder choosing the depth honestly (the picker's one sentence, "pick
  one about twice the amount you hope to raise"). The other is not built: a limit on how much a pool takes in next to
  its depth. A reserve capped at twice the depth would hold the multiple at 9 times at most, and at once the depth at 4
  times, for what should be a few dozen bytes of the pool (an estimate, not measured). It is not built because it
  changes what the pool is: a pool that can fill up sells out, which brings back the rush to be in before it closes,
  and a round pool sets its own depth from what the round raised. That is the owner's decision, with counsel's
  question 10.
- **The balance this leaves.** A founder who follows the rule of thumb, and whose raise comes in as hoped, gets a price
  that moves between about 1.4 and 2.1 times over the raise at any size from 5,000 up (1.5 times at 2,500): enough to
  be worth watching, with a sale of half the units costing a third of the price at worst. A raise that overshoots the
  plan four times moves it 7.7 times, and from there on the table above is a first-buyers' game at every tier.
- **What changed in the contracts.** `BackingPoolFactory._tiersOf` returns six depths (two fifths of the default, then 1,
  2, 4, 10 and 20 times), so the default must still divide by five and the deepest is still twenty times it. `open`,
  `openWithRound`, `launchWithPool`, `roundTerms` and `DepthChosen` are unchanged. `depthTiers()` keeps its name and
  selector and now returns six numbers, not seven: a reader that expects seven must be updated (the core adapter
  refuses a reply of any other length, so a factory deployed before this change is not read as if it were today's: the
  founder's form then says the choices could not be read and opens at the usual depth).
  Sizes and gas are in "Known limits".

## Considered and rejected

Two more ideas were measured on the same model and are **not built**.

- **A sell surcharge that falls with the holding time** (the proposal: 7% extra on top of 1% for the first day, falling
  to nothing at 14 days, kept in the reserve). It deters flippers and sandwiches, and that is all it does. A flipper
  who sells a 1,000 buy within a day gets back 82.0% instead of 88.2% (84.9% at a week), and a sandwich of 5,000
  loses 627 instead of 294. But a run by backers who have held for weeks is not touched by it: in the cascade
  model, with a quarter of the units young, the final price drop moves by under half a point (72.6% to 72.5% at
  50,000 raised and the default depth). It would also need a per-wallet age record (about 22,000 gas more on a
  wallet's first buy, and an age rule that overcharges steady buyers by up to twice and undercharges a top-up by
  about 7%), about 1.2 to 1.8 KB of contract size, and a question for counsel (is a fee that falls with holding time
  a restriction on transfer?). Rejected: it does not stop the thing the owner worried about.
- **A surcharge on net selling in a trailing window** (the proposal: an extra fee up to 15% on sales while the net sold
  in the last day is high, kept in the reserve). It improves the final price after a 30% run by 1.9 points, and it
  widens the gap between the first and the tenth seller (the first keeps 95.6% of the mark value, the tenth 47.9%,
  against 55.3% with no surcharge), so it pays the first to run. Rejected: it makes the thing it protects against
  more attractive.

## What is protected, and what is not

Protected, each with a test that runs the attack (`contracts/test/BackingPoolAdversary.t.sol`; the round's
are in `BackingRound.t.sol`, against the real auction: settling gives the same result whoever does it and
whatever was done first, only the pool can collect the raise, stray transfers change nothing, claim tokens
cannot be exchanged twice):

1. **Sandwiching a trade** loses money unless the victim's own trade moves the price by about 13%
   (`test_A1_*`, `testFuzz_A1_*`). A price limit stops that case too.
2. **Taking money that is not yours out of the escrow**: buying in late before a refund, or arriving after
   everyone left, returns only your own money; what nobody holds goes to the treasury (`test_A2_*`,
   `test_review_F3_*`).
3. **Abusing the way out**: buying in the window and leaving, leaving twice, or leaving with more than your
   part are all refused (`test_A3_*`, `testFuzz_A3_*`); money that arrives after a post is not taken
   (`test_review_F1_*`). A leave never moves the price, takes nothing from the reserve, and cannot cost more
   than the refund it pays out, or more than staying one more milestone would (`BackingPoolInvariant.t.sol`, the
   leave handler; `BackingPoolMilestones.t.sol`; `BackingPoolLeaveFee.t.sol`).
4. **Stopping a project's money or killing its pool**: nobody can block a release (`test_review_F2_*`); a
   bought majority cannot vote the same day, and a project that keeps releasing cannot be voted out
   (`test_A4_*`).
5. **A founder draining the escrow** gets at most a quarter per 28 days, only from those who stayed, and
   never the reserve (`test_A5_*`, `test_review_F4_*`).

Not protected. Say these plainly in the app:

- **Leaving skips every later tranche, for good, and keeps the units**
  (`test_limit_leaving_skips_every_later_tranche_for_the_units_that_stay`). A backer who leaves has no held money in
  the pool any more, so the units they keep fund no later milestone, now or ever; only money they put in after
  leaving is held again. Staying costs a quarter of the held money: about 2.5% of the position at the first
  milestone, 1.9% at the next, 1.4% at the third, and about 9.7% over a year of thirteen. Leaving costs the fee on the
  units' curve value: about 0.9% of the position while the price has not moved, and never more than staying one more
  milestone would cost. So leaving is cheaper than staying at the first milestone and from then on costs about the
  same (from about the fifth, at a flat price, the cap is the fee), and a pool full of people who all leave gives the
  project the fee, not the tranche. The fee keeps leaving from being free; it does not make staying the better deal.
  See "Why leaving has a fee".
- **A released tranche is gone.** Nothing checks that a milestone is true except backers leaving.
- **Released money goes to the DAO treasury**, which Share holders control. A founder who holds most Shares
  can take it out.
- **An ordinary sale gives up your held money** to those who stay (`test_limit_those_who_stay_gain_*`), and
  gives it up by units sold, not by what they cost (`test_limit_a_sale_gives_up_weight_by_units_*`). To get
  it back, leave at a milestone or wait for abandonment.
- **After a round the curve opens at the round's average price**, which can be below what the last
  bidders paid (see "Two ways to open").
- **If nobody settles a round that reached its minimum, nothing opens** and the raise waits in the auction.
  Anyone can settle it, at any time, and nobody else can take the money.
- **A round on a chain where the auction charges a protocol fee** opens the pool with what is left after it.
  If that fee takes the whole raise, or leaves two base units or fewer (nothing a curve can open on), the pool
  closes for good like a round under its minimum, and the project may open another. That is not a refund: the
  money the bids spent went to the protocol's fee recipient, and the couple of base units that reached the pool go
  to the DAO treasury. Bids that were outbid or only partly filled still get their unspent money back through
  the auction's own `exitBid` and `exitPartiallyFilledBid`. The claim tokens of that pool are worth nothing: they
  cannot be exchanged on it (it is closed) nor on a pool opened later (that pool has its own claim token). The
  app can tell this from a round that missed its minimum: it closed with its raise at or above the minimum.
- **A round can go live with very little.** The line between going live and closing is arithmetic, not a share
  of the minimum: the pool closes only when nothing is left for the reserve (what arrived is two base units or
  fewer). A live pool with a handful of base units is possible only if the auction's fee controller, which is
  fixed when the auction is made and which this system cannot change, takes about 99.99% of the raise. That is
  a policy edge of the auction's fee, not a flaw of the pool: it is not fixed by closing below half the
  minimum, which would hand bidders' remaining money to the treasury and leave them nothing, where going live
  at least gives them units for the claim tokens they hold.
- **A round whose raise cannot be swept** (the auction's fee recipient cannot be paid: it is unset, or the quote
  token refuses it) cannot be settled. `seedFromAuction` reverts with the auction's error and the pool keeps
  waiting, which would also stop the project from ever opening another. Thirty days after the pool opened
  (`ROUND_GRACE`) and once the round is over, anyone may call `abandonRound()`. If the sweep works by then it
  settles the round like `seedFromAuction` (so it cannot end a healthy round, and returns true). If the sweep
  still reverts it closes the pool for good (`Failed`, with `RoundFailed` carrying a raise at or above the
  minimum) and the project may open another. It moves no money: the pool holds none of the round's before a
  sweep, and a failed sweep delivers none. What the sweep could not deliver stays in the auction and is lost
  to the bidders: only the pool can sweep it, and it never will. Bids that were outbid or only partly filled still
  get their unspent money back through the auction's own `exitBid` / `exitPartiallyFilledBid`, and the claim
  tokens are worth nothing. The thirty days are a bet that a temporary fault clears: once the pool is closed,
  fixing the fee recipient delivers nothing. The call needs about 1.1 million gas available (it refuses with
  `NotEnoughGas` otherwise, so too little gas can never pass for a failed sweep).
  (`test_after_the_grace_a_stuck_round_is_closed_and_no_money_moves`, in `BackingRound.t.sol`.)
- **Earlier sellers get a better curve price than later ones**, as on any curve, including after abandonment.
- **A rival with over half the weight, held for 30 days,** can end a pool that has released nothing for 90
  days. Backers get their money back (`test_A4_limit_*`).
- **A large buy sent with no price limit** can be sandwiched (`test_A1_limit_*`). The app must always send a
  limit.
- **The early cap is per wallet**; many wallets get around it.
- **The list of pools is not a curated list.** `BackingPoolFactory` opens a pool for any DAO the pinned
  summoner made, and the summoner is open to anyone: a stranger can summon a DAO and register a pool for it in
  the same transaction (`open` is one of the calls a summon can run, with the DAO's predicted address).
  `pools(i)`, `poolCount()` and `poolOf` therefore list strangers' DAOs next to real ones, under any name. The
  app lists only the DAOs it learns from the kit's `ContributorProjectLaunchedV3` events (or its own records),
  never from `pools()`, and never shows a project by its name alone.
- **A launch can be made to fail by someone who guesses its inputs.** The address of a new DAO follows from
  the summoner's salt, and the summoner's own address calculation covers only the holders, their shares and
  that salt, not the name or the caller (the kit adds the caller to the salt it passes, which anyone who knows
  the founder and the salt can repeat). Someone who sees a launch before it is mined can summon another DAO at
  the predicted address first; the launch then reverts whole, with nothing taken but gas. The founder submits
  privately where the chain offers it, and uses a random salt, never a guessable one, and a new one after a
  failure.
- **Escrow behind claim tokens nobody ever exchanges stays in the pool for good**, after abandonment too: it is
  still those tokens' share, and nothing sweeps it to the treasury. The auction lets a bidder collect at any
  time, so no waiting time proves a bidder gone; a sweep after a long grace would be a bet against someone who
  is only late. The amount is the share of the round's project money behind tokens nobody holds an interest in.
- **If nobody releases a milestone within its 7 days it is cancelled**, and money that came in during it
  gains a small part of the tranche that was not taken.

## Known limits

- One pool per project per factory, with that factory's terms and quote token (a pool whose round failed
  does not count).
- Claim tokens from a round are ordinary transferable tokens until exchanged; units are not transferable.
  Units for claim tokens nobody collects or exchanges stay set aside for good. A few base units of every
  round (2 in the test, out of 100 million whole tokens) can never be claimed at all: the auction counts the
  units it sold rounded up and pays its bidders rounded down. Those units and the escrow weight behind them
  belong to nobody and are not a backer. **Weight in claim tokens nobody has exchanged does not count as a
  backer either**, for the abandonment clock only: with no wallet holding a weight the clock does not run, a
  newcomer's buy restarts it, and the first exchange after the clock has run out is refunded at once. (So a
  founder can restart the clock by buying while every round bidder is asleep; a bidder ends that by
  exchanging his claim tokens once.)
- **What a dust buy can and cannot do to that clock.** A buy restarts the clock only when it gives the buyer
  a weight. In a pool whose only weight is round leftovers and unexchanged claim tokens, a buy so small that
  its weight rounds to zero (it still mints units) does not restart it, so such buys cannot keep a dormant
  round pool alive (`test_a_dust_buy_that_gets_no_weight_does_not_restart_the_abandonment_clock`). A buy that
  carries even one base unit of weight does restart it, and that costs next to nothing (about the escrow
  divided by 1e12, in base units of project money). After it that wallet holds a weight, so it is a backer
  and no other buy restarts the clock while it does. To restart again the wallet has to sell all its units
  and buy again, paying the fee on both trades (rounded up) and the gas, and every such cycle only delays
  the refund of claim holders who have not exchanged, never touching the money of anyone who has. It ends
  the first time a bidder exchanges: his weight then counts as a wallet's.
- The round's length is counted in blocks, so its length in days depends on the chain. Blocks are counted on
  the auction's own clock: on Arbitrum and its Orbit chains that is the chain's own block number (ArbSys), not
  `block.number`, and the factory and the pool read it the same way (a test runs a round against a stand-in
  for ArbSys). If the auction the factory creates counts on another clock than the factory does, opening
  fails whole: `openWithRound` asks the new auction to checkpoint, and an auction whose clock is behind
  the round's start reverts with its own `AuctionNotStarted()` (not a factory error), so nothing is
  opened and the project can try again. A clock that is ahead is not refused: the round is shorter or already
  over, settles as a round nobody bid in, and the project may open another.
- No owner and no upgrade: a defect cannot be patched, only replaced by a new deployment.
- **Contract size.** The pool deploys from its factory's deployer, whose runtime code is the pool's whole creation code
  (the claim token's included). Measured with `forge build --sizes` on 2026-11-15, after the review fixes: pool 18,987 bytes, deployer
  23,548 of the 24,576 allowed (1,028 spare; 1,251 before the per-wallet record of units that left, 988 before the leave
  rewrite), factory 6,716 runtime and 32,935 initcode of 49,152, kit 16,375. After the 5,000 tier was dropped (measured
  the same day): pool 18,987 and deployer 23,548, both unchanged (the deployer holds the pool's code, not the factory's),
  factory 6,734 runtime (18 more, with 17,842 spare) and 33,045 initcode (33,046 just before the change), kit 16,375. The
  local fixture deploys all of them on a node that enforces the limits. There is little room left for new pool logic: a pool feature of more than about a
  kilobyte needs the factory to create the claim token first (pass its address to the deployer and have the claim token
  bind to the pool once) before it fits.
- The quote token must move exactly what is asked. A token that takes a cut is refused at the first buy;
  rebasing tokens are not supported. If the token refuses to pay the treasury, the money waits in the pool
  and anyone can retry (`payTreasury`); backers are not held up.
- Money sent to the pool by mistake stays there for good.
- After about 300 releases (over twenty years at one a month) a buy could overflow and fail. Sales, leaving
  and refunds cannot.
- Prices are returned as quote base units per whole unit, times 1e18, so a 6-decimal quote token still gives
  a smooth chart.
- `ContributorKitV3` repeats the `ContributorKitV2` launch code, because V2 is deployed and was left
  unchanged. A test launches through both and compares the result.
- Gas for a whole transaction, measured in the test VM on a real project with every call run as its own
  transaction. The command (the `BackingRoundDustTest` test in it only makes sure the auction's artifact is
  compiled: a filtered run that selects no `BackingRound` test does not build it, and the suite fails in `setUp`):
  `forge test --match-contract 'ContributorKitV3Test|BackingRoundDustTest' --match-test 'test_gas_|test_a_pool_without_a_round_still' --isolate -vv`
  (or drop `--match-test` and run both contracts whole).

| Step | Gas |
|---|---|
| Create project with pool, open now (`launchWithPool`), 1 first project / 8 | 14,761,000 / about 15,517,000 (the second is the one-project figure plus the 756,000 that eight projects added in an earlier measurement, not measured again; the V2 launch alone is 10,754,000) |
| The heaviest launch the kit accepts (8 first projects, 8 reviewers, 64-byte name, 12-byte symbol) | 15,708,000 used as the test measures it (15,748,000 run as its own transaction with `--isolate`). At the deepest curve depth: 15,710,000 and 15,750,000, which leaves 1,068,000 (1,028,000 isolated) under the 16,777,216 cap; any tier costs about 1,500 gas more than the default (the tier lookup, the early-cap scaling and one more event). With six tiers (2026-11-15) the default-depth launch is unchanged to the unit (15,708,127 used; 15,748,119 isolated) and the deepest tier is 95 gas lighter (15,709,441 used, 15,709,536 before; 15,749,529 isolated), one fewer tier to look through. The rest of this row was measured before the review fixes and moves by well under 0.1%. The transaction's gas limit has to be about 15.81 million: the least call gas that succeeds is 15,773,000, and this call data (with the depth argument) adds about 38,000 of intrinsic gas. That is 5.7% under the 16,777,216 per-transaction cap some chains enforce. On V2 (no caps) each reviewer costs about 31,000 and each name byte about 770, which is why the kit caps them. Estimated on top of this launch (V2 measured, plus what the pool and market add), with the gas limit about 130,000 above what is used: 32 reviewers, 16,498,000 used (limit 16.63 million, 0.9% under the cap); a 300-byte name with 8 reviewers, 15,934,000 (limit 16.06 million, 4.3% under); 32 reviewers and a 300-byte name together, 16,679,000 (limit 16.81 million, over the cap): each figure holds only for the shape it names, and these estimates were made before the depth argument and the lighter leave and move by about 0.4% |
| Open a pool for an existing project, open now (`open`) | 3,962,000 |
| Open a pool behind a round (`openWithRound`: pool, claim token, auction, and the auction's first checkpoint, about 114,000 of it) | 7,915,000 |
| Bid in a round (the auction's own call) | 296,000 |
| Settle a round (`seedFromAuction`) | 604,000 |
| Close a stuck round (`abandonRound`, the sweep failing) | 269,000 |
| Exchange claim tokens for units (`redeem`, a wallet's first) | 117,000 |
| Buy (first time for a wallet / again) | 166,000 / 112,000 (289,000 for the pool's very first buy) |
| Sell | 97,000 |
| Claim milestone (`postMilestone`) | 185,000 |
| Leave at a milestone (sells nothing; writes the record of units that left) | 159,000 |
| Release (`resolveMilestone`, pays the treasury) | 122,000 |
| Refund (sell once abandoned) | 72,000 (121,000 for the first one, which records the abandonment) |

## For the app

What the web needs that is not obvious from the contracts:

- **Leaving changed shape (2026-11-15).** `leave(minQuoteOut, deadline)` is unchanged but now sells nothing and burns
  nothing. `quoteLeave(holder)` returns `(quoteOut, fromEscrow, fee)` (it used to return five values with the curve
  legs and `priceAfter`), and the `Left` event is `Left(id, backer, unitsKept, quoteOut, fromEscrow, fee)` with the id and
  the backer indexed. `canLeave` needs a weight, not units: show "Leave" only while it is true, and never as a way
  to sell. After leaving, the holder still has units and `holderWeight` is zero: their `holderEscrow` reads zero, and a
  later refund after abandonment is zero for those units. Say so in plain words.
- **Leaving, as built after the review (2026-11-15).** The shapes above did not change; the fee did. `quoteLeave`
  returns the fee already capped at the leaver's part of the tranche, and `leave` pays exactly that. **Set `minQuoteOut`
  from `quoteLeave` (with a small tolerance), never to 0**: the fee follows the live curve price, so a buy that lands
  first raises it, and a leave sent with no minimum takes whatever it has become. Show the quote next to what staying
  costs (a quarter of the held money), say that leaving is cheaper than staying at the first milestone only, and never
  present staying as the better deal or leaving as a way to sell. A new public read, `bareUnitsOf(holder)`, is the
  units that carry no held money: a sale uses them first, so show "sell the units that left first" as the cheap order,
  and do not show a weight-burning warning for them. The snapshot struct is unchanged.
- **Depth.** `BackingPoolFactory.open(dao, depth)`, `openWithRound(dao, minimumRaise, depth)` and
  `ContributorKitV3.launchWithPool(params, depth)` take the depth in quote base units (zero for the default); anything
  that is not in `depthTiers()` reverts with `BadDepth()`. `roundTerms(depth)` returns the round's tick spacing, floor
  price and default minimum at a depth; `roundFloorPriceX96()`, `roundTickSpacingX96()` and `defaultMinimumRaise()` are
  now views at the default depth. A pool's own depth at birth is `virtualQuote()` (after a round it is the seeded one).
  The factory also emits `DepthChosen(pool indexed, depth)` right after `PoolOpened` (the tier, or the default when
  zero was passed): that is where a round pool's chosen depth stays readable once the round has set its own paper
  reserve. `PoolOpened` and `RoundOpened` did not change. A factory refuses at deployment a default depth whose
  deepest tier (twenty times the default) would not fit the pool's own limit (`type(uint112).max`), rounds or no rounds.
  **`depthTiers()` returns six depths since 2026-11-15** (it returned seven; the 5,000 one is gone and is refused with
  `BadDepth()` like any other number). Its name and selector are the same; the reply is six words long.

- **Hide or label the claim tokens of any pool that is not `Waiting` or `Live`.** A `Failed` pool's claim token
  cannot be exchanged (not on that pool, which is closed, and not on a pool the project opens afterwards, which
  has its own claim token): it is worth nothing, even when the auction handed it out. While the pool is
  `Waiting` the tokens are not collectable yet (the auction's claim block), and while it is `Live` they are
  exchanged with `redeem`. Show a holder's `roundInfo(holder).holderClaimTokens` only in those two states.
- **The launch caps are readable**: `ContributorKitV3.MAX_REVIEWERS()` (8), `MAX_NAME_BYTES()` (64) and
  `MAX_SYMBOL_BYTES()` (12). Every cap violation reverts with the same `InvalidTerms()`, so check before
  sending. The name cap counts UTF-8 bytes, not characters: measure the encoded length (`new TextEncoder().encode(name).length`),
  because an emoji or an accented letter costs several.
- **`seedFromAuction()` can return false with `RoundFailed` when the raise reached the minimum.** That is the
  protocol-fee path (the fee left two base units or fewer): the bids' money is not refunded, only outbid or
  partly filled bids get their unspent part back through the auction's `exitBid` / `exitPartiallyFilledBid`.
  Tell it apart from a missed minimum with `roundInfo().raised >= roundInfo().minimumRaise`.
- **`seedFromAuction()` and `abandonRound()` ask the auction to checkpoint first**, so the revert of a call that
  cannot settle can be the auction's own (`AuctionNotStarted()`, `TokensNotReceived()`) as well as the pool's
  `RoundNotOver(endBlock)`. Opening can revert with the auction's `AuctionNotStarted()` too (see "Known limits").
- **"Can settle" must be asked on the auction's clock, not `block.number`.** On Arbitrum and its Orbit chains
  they differ. The auction's own `lastCheckpointedBlock()` reaches `roundInfo().endBlock` only after someone
  has checkpointed past the end, so a round that is over can still read below it. The dependable test is to
  simulate `seedFromAuction()` (an `eth_call`): it reverts with `RoundNotOver` until the auction's clock has
  reached the end.
- **A round stuck on its sweep**: `seedFromAuction()` keeps reverting (with the auction's error). From
  `openedAt() + ROUND_GRACE()` (30 days), once the round is over, offer `abandonRound()`: it settles the round if
  it can and otherwise closes the pool (`Failed`); it needs about 1.1 million gas available (`NotEnoughGas()`
  otherwise). Show a closed pool whose raise was at or above its minimum as "the raise could not be collected".

What the web app does with the two changes above (the adapter is `packages/creaton-core/src/launchpad/backing.ts`; its
test binds it to these contracts' source):

- **Leaving.** The leave form shows what `quoteLeave` says: what the backer gets, the held money it comes from and the
  fee, and that the units stay. It never works out the fee: whatever rule the pool uses, the form shows the pool's number,
  and its words say only "a small fee, never more than staying one more step would cost". `leave`'s `minQuoteOut` is the
  quote less the allowed drop and is never zero (a quote of nothing is not offered as a leave at all). After leaving, the
  Backing block says no money is held behind the units, and Home's feed reads `Left` without a price (leaving moves
  none).
- **Depth.** A founder opening backing picks from `depthTiers()` (read from the factory, six choices from 10,000, default
  `defaultDepth()` preselected, with one sentence of help) and the choice goes as the last argument of `open`, `openWithRound` or `launchWithPool`. The
  Start page's launch sends zero, the default. A waiting round's price grid is `roundTerms(pool.virtualQuote())`, not the
  three default-depth getters, which stay for old readers and answer for the default depth only. The depth picker shows
  amounts of the quote token and words, never a price.

## Deploying (Sepolia)

`contracts/script/DeployBackingSepolia.s.sol` deploys a market factory, the pool factory and `ContributorKitV3`
beside the weekly-sale set, reusing its summoner and its free-mint test token, and the auction factory that
is already on Sepolia (the one in `dao-launch-kit-11155111.json`). It writes
`contracts/deployments/backing-sepolia-11155111.json`. It was rehearsed on a local node only
(`script/BackingLocalFixture.s.sol`, which also opens a pool behind a round on a real auction factory, then
the deploy script), never on a public network. The deploy script also checks that the factory's six depth tiers are the
documented ones (`BackingTerms.depthTiersWhole`) and that the default depth is 25,000 whole units; the local fixture
opens a pool at birth at the 100,000 tier, a pool later at the default, and a round pool at the 50,000 tier, and checks all three.
The fixture was run again on 2026-11-15 on a local node that enforces the real size limits (it passed, with the tiers
and the three depths checked), and once more the same day with the six-tier factory, as the first step of
`scripts/web-backing-e2e.sh` (5 of 5 browser steps passed against it); the Sepolia script itself only runs on Sepolia (it
checks the chain id) and was compiled after each change, not run.

## Questions for counsel

1. Is a backing unit a security or another regulated instrument where we launch? It is bought for money,
   its price depends on later buyers, and part of the money funds a team.
2. Does it help or hurt that units cannot be transferred and carry no vote or claim on the treasury?
3. The founder switches the pool on. Is the founder then an issuer or offeror, and what must they disclose?
4. Is the escrow, with release at milestones, the right to leave and refund on abandonment, a custody,
   escrow or collective-investment arrangement, given that only code holds the money?
5. Who is responsible for a milestone post that is false?
6. Do buyers need to be screened (age, residence, sanctions), and can a pool with no operator be offered
   through our app without that?
7. Does the 1% fee to the project, or our app showing a price chart, change the answer to any of the above?
8. What must the buy screen say about giving up held money on an ordinary sale?
9. A backer can leave at a milestone, get their held money back and keep their units, paying the ordinary sale fee on
   what the units are worth without selling them. Is a fee on a value that was never realised a fee on a sale, and does
   keeping units with no money held behind them change the answers to questions 1 and 4?
10. The founder picks the curve's depth from six tiers, which sets how fast the price moves for a given raise. Does
    choosing that, and the opening price that comes with it, make the founder more clearly the issuer or offeror
    (question 3), and what must the choice screen tell them and the backers?
