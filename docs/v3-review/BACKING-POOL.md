# Backing pool: instant backing, tied to the record

**Status (2026-11-11, branch `v4-governance-rework`): built and tested, deployed nowhere.** Contracts:
`contracts/src/BackingPool.sol`, `BackingPoolFactory.sol`, `BackingClaim.sol`, `ContributorKitV3.sol`. One internal adversarial
review (2026-11-11) found three medium flaws; all are fixed here and its proofs are now regression tests. A
second review of the round (two skeptics per finding) confirmed seven more, fixed or written down below: the
vote could be corrupted by exchanging claim tokens, the vote wait could be skipped through claim tokens,
rounding leftovers of a round counted as a backer, a protocol fee above the raise bricked the settlement, the
round's blocks were counted on the wrong clock on Arbitrum, and the launch was unbounded in reviewers and name
length. No outside audit. The numbers below are defaults for a testnet trial, not production terms, and the questions
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
  all your units are sold at the ordinary 1% fee and you get all of your held money, with nothing taken
  for that milestone. Nobody can stop a release, and nobody is made to fund a milestone they reject.
- **Bought in the round?** Exchange your claim tokens for units first; until you do, your part counts as
  staying.
- **You can only leave if you held before the milestone was posted** and have not bought since. Money you
  put in after a post is not touched by that milestone.
- **If the project is abandoned** (see below) you sell as usual, with no fee, and each sale also returns
  your held money. Nobody has to declare anything first.
- **Units are not Shares.** They carry no vote in the project and cannot be sent to another wallet.

## For a founder

- **Open with a round:** create the project, then one call, `BackingPoolFactory.openWithRound(dao, minimum)`
  (zero for the default minimum). It is a second transaction because the two together do not fit in one
  (18.5 million gas against a cap of 16.8 million on some chains).
- **Open now:** a new project gets its pool in the transaction that creates it
  (`ContributorKitV3.launchWithPool`, same inputs as today's launch, with at most 8 reviewers, a name of at most
  64 bytes and a symbol of at most 12; the V2 kit has no such caps), or an existing project made with
  `ContributorKitV2` opens one with a single call from the founder (`BackingPoolFactory.open(dao)`). No vote
  either way. A project from the older kit has no founder on record, so its pool takes one passed decision.
- **You choose nothing.** Every term is fixed in the factory.
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
| Curve: paper reserve | 25,000 quote | Opening price 0.000025 a unit. Raising 50,000 in total moves the price about 7.7 times. |
| Curve: paper units | 1,000,000,000 | The supply approaches this and never reaches it, so there is no sell-out and no "graduation". |
| Project part | 10% of each buy after the fee | With 30% a round trip lost 31% and needed +46% to break even, which nobody would use next to other apps. At 10% a round trip returns about 88%. |
| Fee | 1% on buys and on sales, to the treasury | Makes churn and sandwiching pay the project. Leaving at a milestone pays it on the units sold; refunds after abandonment pay none. |
| Tranche | 25% of the escrow at the post | No milestone can empty the escrow; there is no last tranche and no cliff. |
| Window to leave | 7 days | One weekly update cycle. |
| Time to release after the window | 7 days | A milestone cannot be held open to wait for a better moment. |
| Time between posts | 28 days (also before the first) | At most a quarter of the escrow a month; nothing leaves in the first four weeks. |
| Abandoned by the clock | 180 days with no release | Six missed months is a dead project. |
| Abandoned by vote | more than half the weight, after 90 days with no release | Backers can end it sooner than the clock, but not a project that is releasing. |
| Wait before voting | 30 days after a wallet's last buy or claim-token exchange | A majority cannot be bought and used the same day, and claim tokens, which are transferable, cannot be bought, exchanged and voted with in one transaction. A bidder who exchanges late only waits 30 days from then. |
| Early cap | 1,000 quote per wallet for the first 24 hours | Blunts a sniper taking the opening price in one transaction. Only matters for "open now": a round lasts longer than the cap. |
| Round: length | 50,000 blocks (about a week at 12 s) | Long enough to be seen. The number must divide 10,000,000: the auction sells an equal part every block. |
| Round: supply | 100,000,000 claim tokens | A tenth of the curve's paper units, so most of the curve is left for after. |
| Round: floor price | 0.000025 (the "open now" starting price) | A round never sells below what opening now would have charged. |
| Round: minimum raise | 2,500 (the supply at the floor); the founder may set another | Under it, everyone is refunded and nothing opens. |

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
what it owes the treasury, to the unit, and every holder can leave or sell everything in either order.

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
   (`test_review_F1_*`).
4. **Stopping a project's money or killing its pool**: nobody can block a release (`test_review_F2_*`); a
   bought majority cannot vote the same day, and a project that keeps releasing cannot be voted out
   (`test_A4_*`).
5. **A founder draining the escrow** gets at most a quarter per 28 days, only from those who stayed, and
   never the reserve (`test_A5_*`, `test_review_F4_*`).

Not protected. Say these plainly in the app:

- **Leaving and buying straight back skips a tranche, at the price of two fees**
  (`test_limit_leaving_and_buying_back_*`). Leaving pays the ordinary 1% on the units sold and buying back
  pays 1% again: about 2% of the position. Staying costs a quarter of the held money: about 2.5% of the
  position at the first milestone and less after each release. So it is barely worth doing once and a loss
  afterwards, and the project gets the two fees either way.
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
  closes for good like a round under its minimum, and the project may open another. Bidders were filled in
  that case, so the auction refunds nothing: the money went to the protocol, and the couple of base units that
  reached the pool go to the DAO treasury. The app can tell the two failures apart: a round that closed with
  its raise at or above its minimum took this path.
- **Earlier sellers get a better curve price than later ones**, as on any curve, including after abandonment.
- **A rival with over half the weight, held for 30 days,** can end a pool that has released nothing for 90
  days. Backers get their money back (`test_A4_limit_*`).
- **A large buy sent with no price limit** can be sandwiched (`test_A1_limit_*`). The app must always send a
  limit.
- **The early cap is per wallet**; many wallets get around it.
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
- The round's length is counted in blocks, so its length in days depends on the chain. Blocks are counted on
  the auction's own clock: on Arbitrum and its Orbit chains that is the chain's own block number (ArbSys), not
  `block.number`, and the factory and the pool read it the same way (a test runs a round against a stand-in
  for ArbSys).
- No owner and no upgrade: a defect cannot be patched, only replaced by a new deployment.
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
  transaction (`forge test --match-path "test/{BackingRound*,ContributorKitV3*}" --match-test test_gas_ --isolate -vv`):

| Step | Gas |
|---|---|
| Create project with pool, open now (`launchWithPool`), 1 first project / 8 | 14,714,000 / 15,470,000 (the V2 launch alone is 10,754,000) |
| The heaviest launch the kit accepts (8 first projects, 8 reviewers, 64-byte name, 12-byte symbol) | 15,702,000 used; the least gas limit that succeeds is 15,792,000, which is 5.9% under the 16,777,216 per-transaction cap some chains enforce. Each reviewer adds about 31,000 and each name byte about 800, which is why the kit caps them (32 reviewers took 16,401,000, 2% under the cap, and a 300-byte name 16,627,000) |
| Open a pool for an existing project, open now (`open`) | 3,962,000 |
| Open a pool behind a round (`openWithRound`: pool, claim token, auction) | 7,801,000 |
| Bid in a round (the auction's own call) | 396,000 |
| Settle a round (`seedFromAuction`) | 604,000 |
| Exchange claim tokens for units (`redeem`, a wallet's first) | 117,000 |
| Buy (first time for a wallet / again) | 166,000 / 112,000 (289,000 for the pool's very first buy) |
| Sell | 94,000 |
| Claim milestone (`postMilestone`) | 185,000 |
| Leave at a milestone | 143,000 |
| Release (`resolveMilestone`, pays the treasury) | 122,000 |
| Refund (sell once abandoned) | 70,000 (120,000 for the first one, which records the abandonment) |

## Deploying (Sepolia)

`contracts/script/DeployBackingSepolia.s.sol` deploys a market factory, the pool factory and `ContributorKitV3`
beside the weekly-sale set, reusing its summoner and its free-mint test token, and the auction factory that
is already on Sepolia (the one in `dao-launch-kit-11155111.json`). It writes
`contracts/deployments/backing-sepolia-11155111.json`. It was rehearsed on a local node only
(`script/BackingLocalFixture.s.sol`, which also opens a pool behind a round on a real auction factory, then
the deploy script), never on a public network.

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
