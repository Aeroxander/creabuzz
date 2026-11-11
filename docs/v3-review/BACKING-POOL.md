# Backing pool: instant backing, tied to the record

**Status (2026-11-11, branch `v4-governance-rework`): built and tested, deployed nowhere.** Contracts:
`contracts/src/BackingPool.sol`, `BackingPoolFactory.sol`, `ContributorKitV3.sol`. No outside audit. The
numbers below are defaults for a testnet trial, not production terms, and the questions for counsel at the
end are open.

## What it is

Each project can have one backing pool. Anyone buys the project's **backing units** from the pool with the
quote token, at a price that rises as more are bought, and can sell them back to the pool at any time. One
transaction, no rounds, no seats, nobody has to run anything. It can be open from the minute the project
exists.

Every buy is split three ways:

- **1% fee** to the project's treasury, at once. It never goes to an operator.
- **30% of the rest is the project's money.** It waits in the pool (the escrow). The project gets a quarter of
  what is waiting each time it confirms a milestone and backers do not object.
- **The remainder (69.3% of what you paid) is the reserve.** It only ever pays people who sell.

## For a backer

- **Buy:** you pay, you get units. You set the fewest units you will accept and a deadline, so a price that
  moved against you cancels the buy.
- **Sell, any time:** the pool pays you from the reserve at the current price, less the 1% fee. The reserve
  can always pay every holder, in any order (see "Why sells always clear").
- **Selling leaves your project money behind.** Buy and sell straight back and you get about 68% of what you
  paid. That is on purpose: a unit is support for a project, and the price has to rise by about 46% before a
  flip breaks even.
- **Your say.** When the project posts a milestone you have 7 days to object. If backers holding 20% of the
  project money say no, nothing is released. If you bought during those 7 days you have no say on that
  milestone.
- **If the project is abandoned** you sell as usual, and each sale also returns your part of the project
  money that was never released. It is your own part: someone who buys in late cannot take it.
- **Units are not Shares.** They carry no vote in the project and cannot be sent to another wallet.

## For a founder

- **Open it:** a new project gets its pool in the transaction that creates it
  (`ContributorKitV3.launchWithPool`, same inputs as today's launch). An existing project made with
  `ContributorKitV2` opens one with a single call from the founder (`BackingPoolFactory.open(dao)`), no vote.
  A project from the older kit has no founder on record, so its pool takes one passed decision.
- **You choose nothing.** Every term is fixed in the factory.
- **Getting the money:** fees arrive as people trade. For the rest, post "milestone reached" with the id of
  the public record event. Seven days later anyone can release a quarter of the escrow to the project
  treasury, unless backers objected. The first post is possible 28 days after opening, then one every 28
  days. The treasury is the DAO, so spending it is still the DAO's decision.
- **Your own Shares** stay locked on their sale schedule exactly as today. The pool mints no Shares.

## Every setting and its default

| Setting | Default | Why |
|---|---|---|
| Curve: paper reserve | 25,000 quote | Opening price 0.000025 a unit. Raising 50,000 in total moves the price about 5.7 times: a reward for being early, not a lottery. |
| Curve: paper units | 1,000,000,000 | The supply approaches this and never reaches it, so there is no sell-out and no "graduation". |
| Project part | 30% of each buy after the fee | Large enough that the project is funded by backing and that flipping loses; small enough that most of a backer's money stays theirs to take out. |
| Fee | 1% each way, to the treasury | Makes churn and sandwiching pay the project. |
| Tranche | 25% of the escrow per milestone | No milestone can empty the escrow; there is no last tranche and no cliff. |
| Objection threshold | 20% of the weight that may object | A clear minority can stop a release; a lone small holder cannot. |
| Objection window | 7 days | One weekly update cycle. |
| Time between posts | 28 days (also before the first) | At most a quarter of the escrow a month; nothing leaves in the first four weeks. |
| Abandoned by the clock | 180 days with no release | Six missed months is a dead project. |
| Abandoned by vote | more than half the weight, after 90 days with no release | Backers can end it sooner than the clock, but not a project that is delivering. |
| Wait before voting | 30 days after a wallet's last buy | A majority cannot be bought and used the same day. |
| Early cap | 1,000 quote per wallet for the first 24 hours | Blunts a sniper taking the opening price in one transaction. |

"Weight" is a backer's part of the project money in the pool. A new backer's weight is worth exactly what
they just added.

## Why units and not Shares

The DAO's Shares can only be created by a reviewed award. That rule is sealed when the project is born and
no vote can lift it, so no pool can mint Shares, on old projects or new. We would not want it to: a pool that
mints votes lets anyone buy a majority of a project in one transaction. Units have no vote; the only thing
they decide is what happens to this pool's project money. This is also why opening a pool needs no vote: the
pool has no power over the DAO.

## Why sells always clear

The price curve runs on the reserve alone. A buy adds to the reserve and takes units out of the curve; a sale
does the reverse; both round against the trader. Because of that rounding, the product "reserve side times
units left" never falls below its starting value, so when every unit has been sold back the reserve has paid
out no more than it took in. The project money is counted separately and is never used to pay a sale. The
tests check this after long random sequences of every action: the pool's balance equals reserve + escrow +
what it owes the treasury, to the unit, and every holder can sell everything in either order.

## What is protected, and what is not

Protected, each with a test that runs the attack (`contracts/test/BackingPoolAdversary.t.sol`):

1. **Sandwiching a trade** loses money unless the victim's own trade moves the price by about 46%
   (`test_A1_*`, `testFuzz_A1_*`). A price limit stops that case too.
2. **Buying in late to take the refund** takes nothing from those who stayed (`test_A2_*`, `testFuzz_A2_*`).
3. **Buying a block, or buying to drown objections,** after a milestone is posted does not count
   (`test_A3_*`).
4. **Buying a majority to kill a pool on the spot** is refused: 30 days' holding and 90 days without a
   release (`test_A4_*`).
5. **A founder draining the escrow** gets at most a quarter per 28 days and never the reserve (`test_A5_*`).

Not protected. Say these plainly in the app:

- **The project part is at risk.** A tranche that was released is gone. The 20% objection is the only check
  on whether a milestone is true.
- **Released money goes to the DAO treasury**, which Share holders control. A founder who holds most Shares
  can take it out.
- **Panic selling costs you your project money.** If you think a project is dead, objecting and waiting for
  abandonment returns more than selling.
- **Earlier sellers get a better curve price than later ones**, as on any curve, including after abandonment.
- **A rich founder can outweigh objectors** by buying before posting. It takes four times their money, a
  quarter of it is released like anyone's, and the rest goes to the other backers when he sells
  (`test_A5_outweighing_*`).
- **A rival with over half the weight, held for 30 days,** can end a pool that has released nothing for 90
  days. Backers get their money back; the project loses what was not released (`test_A4_a_seasoned_*`).
- **A very large buy sent with no price limit** can be sandwiched (`test_A1_limit_*`). The app must always
  send a limit.
- **The early cap is per wallet**; many wallets get around it.

## Known limits

- One pool per project per factory, with that factory's terms and quote token. Different terms mean a new
  factory, and a project that already has a pool keeps it.
- No owner and no upgrade: a defect cannot be patched, only replaced by a new deployment.
- The quote token must move exactly what is asked. A token that takes a cut is refused at the first buy;
  rebasing tokens are not supported. If the token refuses to pay the treasury, the money waits in the pool
  and anyone can retry (`payTreasury`); backers are not held up.
- Money sent to the pool by mistake stays there for good.
- `ContributorKitV3` repeats the `ContributorKitV2` launch code, because V2 is deployed and was left
  unchanged. A test launches through both and compares the result.
- Gas for a whole transaction, measured in the test VM on a real project with every call run as its own
  transaction (`forge test --match-test test_gas_for_every_step --isolate -vv`):

| Step | Gas |
|---|---|
| Create project with pool (`launchWithPool`) | 13,355,000 (the V2 launch alone is 10,754,000; the 2^24 per-transaction cap some chains enforce is 16,777,216) |
| Open a pool for an existing project (`open`) | 2,604,000 |
| Buy (first time for a wallet / again) | 154,000 / 100,000 (274,000 for the pool's very first buy) |
| Sell | 89,000 (104,000 during a milestone window by an objector) |
| Claim milestone (`postMilestone`) | 130,000 |
| Object | 77,000 |
| Release (`resolveMilestone`, pays the treasury) | 126,000 |
| Declare abandoned | 40,000 |
| Refund (sell after abandonment) | 85,000 |

## Deploying (Sepolia)

`contracts/script/DeployBackingSepolia.s.sol` deploys a market factory, the pool factory and `ContributorKitV3`
beside the weekly-sale set, reusing its summoner and its free-mint test token, and writes
`contracts/deployments/backing-sepolia-11155111.json`. It was rehearsed on a local node only
(`script/BackingLocalFixture.s.sol` then the deploy script), never on a public network.

## Questions for counsel

1. Is a backing unit a security or another regulated instrument where we launch? It is bought for money,
   its price depends on later buyers, part of the money funds a team, and the holder has a limited say.
2. Does it help or hurt that units cannot be transferred and carry no vote or claim on the treasury?
3. The founder switches the pool on. Is the founder then an issuer or offeror, and what must they disclose?
4. Is the escrow, with release on milestones and refund on abandonment, a custody, escrow or
   collective-investment arrangement, given that only code holds the money?
5. Who is responsible for a milestone post that is false?
6. Do buyers need to be screened (age, residence, sanctions), and can a pool with no operator be offered
   through our app without that?
7. Does the 1% fee to the project, or our app showing a price chart, change the answer to any of the above?
8. What must the buy screen say about losing the project part on sale?
