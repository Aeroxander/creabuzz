# Price history for weekly rounds (D147, 2026-10-30)

Status: **built as D147** on its own branch, to merge into `v4-governance-rework` after the mechanism freeze (D137).
Sections 1 to 3 are built as proposed, with your answers: eight rounds, the leaving line also on the Overview, and the
funding card's own history after the pilot shows funding rounds being used. It changes the app only: no contract, no new
event, no change to how a round prices. How to check it by hand: [TEST-STEPS.md §4cl](TEST-STEPS.md).

## The problem

Each weekly round (D131, [WEEKLY-ROUNDS.md](WEEKLY-ROUNDS.md)) prices only from that week's orders and keeps no memory of
earlier rounds. The card on the Funds tab reads only the DAO's latest round. So:

- a week with no trades shows nothing about the price people last paid, and reads like the price fell away;
- a week where a large seller meets a small buyer really does trade near the floor, and that is a real price.

These are different, and the page should never turn the first into the second.

## What was considered and dropped

**A price band** (each round may clear only within, say, ±10% of the last trade) was proposed on 2026-10-29 and is
dropped. An outside review showed why:

| | Price a Share |
|---|---|
| Last trade | $10 |
| What leaving pays | $1 |
| This week's buyer and seller agree on | $3 |
| Lowest the band allows | $9 |

The band blocks a trade both sides wanted. Nothing trades, so the reference stays $10 and the next week is blocked the
same way. The seller leaves for $1 instead, and that $1 comes out of the treasury, which a $3 sale between members would
have kept. A collar can make sense as a short safeguard, but only with a rule that reopens or widens it; that is not
needed before there is evidence of manipulation.

**A curve, a Uniswap pool or v4 hook, LBAMM, a reworked CCA** are not needed for this. A smooth chart costs nothing; a
price someone can actually sell at needs someone to put the money up. Notes for later (the last three are the review's,
not checked here):

- A buy-only funding curve can fund a project continuously, but its price is a ceiling for holders' Shares only when it
  sells the same thing (funding terms sell Loot by default, not voting Shares), to that buyer, with supply left.
- Uniswap v4 can trade restricted tokens through hooks; how it fits votes, the transfer lock and leaving is unsolved.
- CCA distributes a scheduled supply; an ongoing two-sided market would be a redesign.
- LBAMM's public code still forbids production use, and its registry lists no deployed contracts.

## What the card shows today

| Wanted | Today |
|---|---|
| Bids and offers, and how much could sell | Shown: each price people chose, offered at or below, wanted at or above, the clearing row in bold |
| A would-trade price, only when something would trade | Shown: "If bidding ended now: …" or "Nothing would trade yet" (`clearingLine` in `web/src/features/launchpad/lib/rounds-copy.ts`) |
| Last traded price, when, how much | **Missing**: only the latest round is read |
| What leaving pays now, after the fee | **Missing**: the "Floor" chip is the round's floor at opening, before the exit fee (D135, up to 5%). `readRounds` already reads `floorNow` and nothing shows it |

## The proposal

### 1. Last trade, and the last few rounds

Above the current round, one line:

- "Last trade: 40 Shares at 3.10 USDC each, round 6 (Oct 21)." when an earlier round traded;
- "No trades yet." before any round has traded.

When the latest round traded nothing, its own line keeps saying "Nothing traded" and the last-trade line keeps the
older trade **with its date**, so nobody reads it as today's price.

Under it, a short list of the last eight rounds, newest first: date, price, amount traded. A round that traded nothing
shows "Nothing traded" and no price; a void round shows "Not settled, everything returned". No round without trades is
ever given the floor as its price.

No chart in this step. If one comes later, rounds without trades are gaps, not points at the floor, and each point
shows its amount traded.

### 2. What leaving pays now

Beside the round's floor, a second figure: **Leaving now pays about X USDC a Share**, which is `floorNow` less the exit
fee. The fee is read the way the exit reads it (`readExitFee` in `ragequit-position.ts`), so it is zero without funding
terms and while they are under notice, and the line says when a fee applies ("after the 2% exit fee"). The round's own
chip is renamed **Floor at opening**, since it is fixed when the round opens and can differ from today's value.

### 3. The seller's comparison

The Offer Shares form already says what a seller keeps a Share after the treasury's cut. It adds the leaving figure from
(2) beside it, so a seller sees both ways out in the same place.

### Funding rounds stay apart

Funding rounds sell new units for the project (Loot by default), not existing Shares, so their trades never appear in
the holders' last-trade line or history. The funding card can get its own short history later, worded as "sold for the
project".

## How it is read

- The DAO's rounds: `RoundOpened` logs filtered by the DAO (its second topic), newest eight.
- For each: `rounds(id)` gives everything else: `funding`, `settled`, `closesAt`, the price step, `floor` and `step`
  (price = floor + step × price step) and `volume`. A settled round with volume zero is "Nothing traded"; an unsettled
  one past its settle window is void. Round ids are shared by every DAO, which is why the log is needed to find this
  DAO's.
- The date shown is the round's bidding close (`closesAt`), which is when its price was set by the orders; settling can
  be up to two days later.
- Leaving now: `floorNow` (already read) and `exitFeeOf` (already read for the leave panel).

Cost: one log query and up to eight `rounds(id)` reads per Funds tab view, cached with the round's query. When the newest
eight traded nothing, the last trade is looked for further back, eight at a time, up to 48 rounds (about a year); past
that the card says "No trades in recent rounds." rather than "No trades yet." The log read goes through the app's shared
history reads (D144): it starts at the deploy block when the build names one (`VITE_HISTORY_FROM_BLOCKS`), pages when a
node limits the range, and tells a busy node apart. If the history cannot be read, the card says so and still shows the
round.

The reader goes in `packages/creaton-core/src/launchpad/weeklyRounds.ts` (shared with desktop), the words in
`rounds-copy.ts`.

## Tests

- **Reader** (core, fake chain from real event encodings): picks the latest round **with volume above zero** over a newer
  round with volume zero, a void round and a funding round; dates by `closesAt`; returns none before any trade. Each
  case must fail if the filter it guards is removed.
- **Words** (`rounds-copy.test.mjs`): "Nothing traded" rounds never carry a price; the leaving line with and without a
  fee, and under notice; "Floor at opening".
- **Real chain**: extend `scripts/web-rounds-e2e.sh` with a second round that trades nothing, and check the card still
  shows round one's trade with its date, and the second as "Nothing traded".

## Answered (2026-10-30)

1. Eight rounds in the history (two months).
2. The leaving line also appears on the Overview.
3. The funding card's own history waits until the pilot shows funding rounds being used.

## Could rounds run continuously?

For you to decide later; nothing here is built.

**Standing orders.** Today an order belongs to one round: what did not fill is collected and has to be placed again
next week. An order could instead roll over until it fills or its owner cancels it. Two ways:

- *In the app:* after collecting, "Place it again at the same price" in one step. No contract change, but it still
  needs the person to come back each week, so it only removes typing.
- *In the contract:* orders kept per DAO rather than per round, carried into each new round's price ladder until filled
  or cancelled. People's Shares and money would stay in the contract between rounds, which is more to audit, and a
  rolled-over order must still be cancellable at any time so leaving is never taken away. A contract change, so after
  the freeze and with an audit.

**Shorter rounds.** The lengths are fixed in the contract as constants (`BIDDING` 3 days, `SETTLE_WINDOW` 2 days,
`EVERY` 7 days in `contracts/src/WeeklyRounds.sol`); nothing can change them on the deployed contract. Daily rounds
would need a second contract deployed with shorter constants, and each DAO would vote to name it as its exchange, with
the usual 30 days' notice. Shorter rounds split the same people across more rounds, so each has fewer orders and more
rounds trade nothing, and someone has to settle each one (anyone can, but it costs a transaction).

**A market open all the time needs someone to put up money.** A round works because buyers and sellers arrive in the
same window and are matched at one price. Between rounds, a seller who wants out now can be paid only by money already
waiting: either a **curve** (a contract that buys and sells at a formula price from a reserve; if the reserve is the
treasury, buying back is leaving at a different price, paid by everyone who stays) or a **pool** (people put in Shares
and USDC, earn fees, and lose when the price moves against them). Leaving is already the always-open way out, at the
floor and paid from the treasury. A pool would also hold Shares that vote and sit under the transfer lock, which no
pool design here handles yet (see the notes above).

Suggested order, if you want more than weekly: standing orders in the app first (cheap), then measure how many rounds
trade nothing; consider daily rounds only if weekly rounds fill but people wait too long; a pool only with someone
willing to fund it and a design for votes and the lock.
