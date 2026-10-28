# Weekly rounds (D131, 2026-10-27, test networks)

A holder who wants out is matched with someone who wants in, once a week at one price, so the treasury keeps the money
leaving would have taken. This is the first version, cut down after an outside review of the waitlist proposal; the
shared plan is the doc "Waitlist and weekly rounds". The contract is `contracts/src/WeeklyRounds.sol`, its tests
`contracts/test/WeeklyRounds.t.sol`.

## A round

| When | What happens |
|---|---|
| Opening | Anyone opens the DAO's next round, a week after its last one opened. The DAO must have named the round contract as its exit exchange (30 days' notice, as for matched exits) |
| Bidding, 3 days | Sellers put Shares in with a lowest price step; buyers put money in with a highest step. Either can take theirs back until bidding ends; a seller can instead leave the DAO straight from the round |
| Up to 2 days after | Anyone settles by naming the price step; the contract checks it |
| Nobody settles in time | The round is void and everyone takes back exactly what they put in |
| Any time after | Each person claims their own result, as Shares or by leaving with them |

## The rules

- **The floor** is what leaving pays per unit in the round's currency when the round opens: the treasury's balance
  divided by the units that can leave (all Shares and Loot, less the DAO's own and those a milestone lock holds back).
  It is a lower bound, since leaving can also pay out other assets. Price steps are 1% of the floor, or one cent a unit
  while the treasury is empty; there are 1,024 steps.
- **The price** is the highest step at which units bid at or above it are at least the units offered at or below it.
  If one step higher would trade more, that step. This maximises what trades (a fuzz test checks it against every step)
  and, among equal volumes, favours sellers and the treasury's cut; no buyer pays above their highest step and no seller
  sells below their lowest.
- **Partial fills.** Everyone past the price fills whole. The longer side at the price shares what is left in proportion,
  worked out from the running total of what that side has claimed, so the shares add up exactly and none exceeds its
  order, whoever claims first.
- **Minimums are round prices.** A seller's step is the price before the cut; the page shows what they receive after it.
- **The treasury's cut** is a fifth of each seller's gain above the floor, sent to the DAO when the seller claims.
- **DAO sales.** The DAO can put Shares it already holds into a round, by vote, at least two steps above the floor, and
  pays no cut. Nothing new is minted.
- **Units move as they are.** Buyers get Shares, with their vote.
- **Settling and claiming.** Settling checks the named step with a few lookups in two trees of running totals (as the
  court's juror draw does), so it costs the same however many orders there are. Each person's claim is separate: a
  payment that fails holds up nobody else.
- **Leaving is never taken away.** A seller can cancel during bidding, and anyone collecting units can collect them by
  leaving instead. That needs no transfer, so it still works if the DAO stops naming the round contract as its exchange.
  After bidding a seller waits at most two days for the round to settle or go void.

## What it costs (gas, from the tests)

| Call | Gas |
|---|---|
| Open a round | about 214,000 |
| Offer Shares | 280,000 to 700,000 (the Shares' own checks and the tree) |
| Bid | 120,000 to 320,000 |
| Settle | about 150,000, however many orders |
| Claim | 90,000 to 510,000 |

## Left out of the first version

The 90-day gain cap, monthly sell limits for the team, trading windows for insiders, a price speed limit, long waitlist
terms and standing orders, Loot for buyers, and minting for DAO sales. Each changes what ownership, leaving or payouts
mean, so each waits for evidence that it solves a real problem. Closing a project needs its own process (settling what
it owes before paying out what remains); the rounds do not provide it.

## Known limits

- Shares held in a round's escrow are not credited payouts (N10) while they wait, at most five days.
- A seller who also bids in the same round can trade with themselves; it costs them the cut and shows in the events.
- The floor is read once, at opening. If the treasury grows during bidding, a seller can take their Shares back and leave
  at the new value; if it shrinks, buyers pay the old floor at least.
- One exchange per DAO: a DAO that names the round contract no longer uses matched offers (D117), and the reverse.

## In the app (D132)

A contributor project's Funds tab has a **Weekly rounds** card when the build names the contract (`VITE_WEEKLY_ROUNDS`).
The DAO starts rounds with the **Weekly rounds** decision (the same 30-day route as sales by signed offers; a DAO uses one
or the other, and the offers card hides when rounds are chosen). Thirty days later anyone switches them on, and anyone
opens each week's round. The card shows:

- the round's floor, its deadline, and what would trade if bidding ended now;
- each price people chose, with what is offered at or below it and wanted at or above it;
- **Offer Shares** (a lowest price; it says what you keep a Share after the treasury's cut) and **Bid for Shares** (a
  highest price; it says what the bid holds until the round settles), each allowing the round first when needed;
- taking an offer or a bid back while bidding is open, or taking the Shares back and leaving at once;
- **Settle the round** once bidding is over, then **Collect**, or **Collect, and leave with the Shares**.

Checked by `scripts/web-rounds-e2e.sh` on a local chain and with `--sepolia-fork` on a fork of Sepolia with the Sepolia
deploy's contracts and Sepolia's USDC: the shared doc's example, from pages (the founder receives 62 USDC, the treasury 3
and pays nobody out, each buyer 25 Shares). On the fork the founder's nine transactions used 7.2M gas in all (the largest,
starting the project, 5.5M), the newcomer's six 1.3M, the second buyer's three 0.7M.

## Next

A pilot that measures two things: whether people put money into productive projects, and how much runway matching keeps.

## Funding rounds (D133)

Beside the holders' rounds, a DAO with funding terms sells its new units in funding rounds: the tranche is the only
offer, buyers bid as in any round, and at each buyer's claim their units are created and what they paid goes to the
treasury. See [FUNDING-TERMS.md](FUNDING-TERMS.md).

