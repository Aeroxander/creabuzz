# Raise with the auction, then a join curve (proposal, 2026-10-25)

Status: **a proposal for you to decide on. Nothing here is accepted, built or deployed.** It changes no decision in
[DECISIONS.md](DECISIONS.md) until you accept it, and then it would need its own decision rows, contract work and audit
scope.

## In one paragraph

A project raises with the auction (CCA) as today: everyone pays one price, Shares are released gradually so sniping
does not pay, and the raise sells out or refunds (D74). When the auction ends, a **join curve** opens: anyone can buy
Shares from a fixed allocation set aside at launch, at a price that rises with each Share sold, and every payment goes
straight into the DAO's treasury. There is no market and no pool: Shares stay non-transferable (D77) and the only way
out is leaving with your part of the treasury, which cannot be switched off (D73). It takes what is good about
pump.fun (instant buys, a price anyone can compute, a progress bar, a live feed of who joined, small amounts) and keeps
what Creaton promises (money funds the project, leaving is an honest floor, team Shares stay locked to milestones).

## Where this fits

What is decided today:

- **D77:** the first raises have no market. Shares cannot be transferred; leaving is the way out.
- **D12 and D14** (both on hold): when a project does want a market, it opens by a DAO vote (D14), on LBAMM with
  Shares as an apptoken (D12).

So today a raise ends at the auction. This proposal adds one step after it, and leaves the market question where D14
put it: a later vote. It is not "auction, then curve, then pool": a pool is itself a curve, and pump.fun needs a
separate curve stage only because a new token starts with no money and no price. After an auction there are both. If a
project later votes for a market, the pool comes then, under D12 and D14.

## How it works

1. **At launch** the kit sets aside a join allocation (say 15% of all Shares) and gives it to a new `JoinCurve`
   contract made for this DAO. These are launch-time Shares, like the auction's: nothing is minted later.
2. **At the auction's claim block** (when buyers can collect and governance opens, D43) the curve opens.
3. **Joining:** a person names how many Shares they want and the most they will pay. The contract computes the price
   along the curve, takes exactly that in the sale's currency (USDC), sends it to the DAO's treasury in the same
   transaction, and sends the Shares to the person. It holds no money at any time.
4. **The price** starts at the auction's final price and rises as Shares are sold (see the price rule below), never
   below what a Share takes when leaving (rule 3).
5. **Leaving** is unchanged: anyone can give up Shares for their part of the treasury. Unsold join Shares count
   neither in votes nor in the exit total, so they dilute no one.
6. **When the allocation is sold out** joining stops. A project that wants more money later uses the existing tools
   (a vote, a new raise) or a market (D14).

## A worked example

One million Shares: **600,000** in the auction, **150,000** for joining, **250,000** for the team, locked behind
milestones. Prices are in USDC. The join price rises evenly from **$0.10** (the auction's final price) to **$0.20** at
sell-out. Auction buyers paid **$0.09** on average (earlier blocks clear lower).

| Moment | Money in from joining | Treasury | Shares that count when leaving | Leaving pays per Share | Price to join now |
|---|---|---|---|---|---|
| Auction ends | — | $54,000 | 600,000 | **$0.0900** | $0.10 |
| Half the join Shares sold (75,000) | $9,375 | $63,375 | 675,000 | **$0.0939** | $0.15 |
| All 150,000 sold | $22,500 | $76,500 | 750,000 | **$0.1020** | sold out |
| Then a milestone unlocks 50,000 team Shares (D72) | — | $76,500 | 800,000 | $0.0956 | — |
| Or, instead, the DAO spends $30,000 on work | — | $46,500 | 750,000 | $0.0620 | — |

Who gains and who pays:

- **Auction buyers** gain as people join: 10,000 Shares that cost $900 can leave with **$1,020** once the curve sells
  out (+13%), without anyone trading. The earliest supporters benefit most.
- **Early joiners** pay a little above what their Shares can leave with. 10,000 Shares bought at the very start of the
  curve cost **$1,033**; they can leave with $939 at the halfway point and **$1,020** at sell-out. You join to take
  part and to vote, not to flip.
- **Sniping does not pay.** The curve starts at the auction's final price, which is at or above what a Share takes
  when leaving, so buying early and leaving soon is a loss. There is no one to sell to.
- **Spending is visible.** Money spent on work is no longer in the treasury, so leaving pays less. The page says so.

### Why the floor matters: when the treasury earns money

Say the project earns **$60,000** (revenue, a grant) when half the join Shares are sold. A Share now takes **$0.1828**
when leaving, but the curve asks only **$0.15**. Without a floor, someone joins 47,000 Shares for **$7,786** and leaves
at once with **$8,538**: **$752** taken from the members' treasury, and the curve price pushed to $0.181 for everyone
after them. Rule 3 closes this: the join price is never below what a Share takes when leaving, so joining and leaving
straight away cannot pay.

## The rules that keep it honest

1. **It starts at the auction's final price.** No cheap opening for bots, and at or above the exit value from the start.
2. **Every payment goes to the treasury in the same transaction.** The curve holds no money, so there is nothing to
   lock, withdraw or lose.
3. **Never below what a Share takes when leaving.** The contract reads the DAO's balance of the sale's currency and the
   exit total, and charges at least that per Share. (See the open question on other assets the DAO holds.)
4. **A fixed allocation, set at launch.** No minting, so D76 holds: new Shares after launch come only from reviewed work.
5. **Limits.** At most, say, 1% of the allocation per transaction and per block, so one actor cannot take the curve in
   one go. The allocation itself is capped (say 15%, at most 20%), so joining can never buy control of the DAO.
6. **Every join names the most it will pay and a deadline**, so a price that moved in the meantime is refused, not
   charged.
7. **No owner.** No pause, no withdrawal, no setting changes after launch. The curve is fixed when the DAO is made.

## The price rule: Shares sold, or Shares still held

| | **Shares sold** (recommended for a first version) | **Shares still held** |
|---|---|---|
| What sets the price | How many join Shares have been sold | Join Shares sold, less Shares that have left since the curve opened |
| After 75,000 sold, then 30,000 Shares leave | Still **$0.15** | Falls to **$0.13** |
| What it says | "The price only goes up as people join" | "Leaving makes joining cheaper", like a market but without one |
| What the contract must know | Its own sales | How many Shares left by leaving, told apart from team forfeits (burns too) and from awards (mints) |
| Contract cost | Nothing beyond the curve | A counter of Shares burned by leaving, kept by `Shares` or the DAO, so more bytes and audit in contracts already near their size limits |
| Risk | The price can stall high if joining stops | Leaving and rejoining to move the price (the floor makes it unprofitable, but it is more to prove) |

In our conversation I leaned to "Shares still held". Working through the contracts changed my mind for a first
version: `Shares` cannot tell a holder leaving from a team forfeit or an award without a new counter in contracts near
their size limit, and the floor (rule 3) already does the most important job of "still held", stopping the price from
sitting below what a Share is worth on the way out. If joining stalls in practice, a time-based variant fits better
than "still held": a **VRGDA** (variable-rate gradual Dutch auction, Paradigm), where the price rises when Shares sell
faster than a published schedule and drifts down when they sell slower. It needs only the curve's own sales and the
clock.

## What changes in the contracts

| Where | Change |
|---|---|
| `JoinCurve` (new, one per DAO) | Holds the allocation; `join(shares, maxSpend, deadline)`; the price function, the floor and the limits; sends the payment to the DAO and the Shares to the buyer in one transaction; opens at the claim block; no owner. |
| `Shares` | **A second transfer exemption** (today exactly one, the auction, D77). And **one place that computes the exit total**: every Share, less the DAO's own, less what the milestone lock still holds (D72), less what the join curve still holds. D76's yearly base and `ragequit` both use it, so the two can never disagree. |
| `Moloch.ragequit` | Uses that total (today it subtracts the lock's `totalLocked` itself, D72). Moloch has room after D73/D76 removed seven functions; measure first. |
| Voting policy (`AllocationVoting`) | No code change: the curve is added to the existing list of holders that do not count toward a vote's supply (the auction is already on it, D69). |
| `DaoLaunchKit` | The join share and curve settings in its parameters, the curve's predicted address, the initialization calls (exemption, exclusion) and read-backs. **The kit's creation code was 2,626 bytes under the limit at D69**: measure first; the curve's deployment may need its own factory or a helper contract. |
| App and command line | A join screen (below); the curve and exit value on the project page; `buzz launchpad join` with machine-readable results; the simulation (`scripts/simulate-raise.sh`) extended with joining and leaving. |

## What it changes in the decisions

| Decision | Effect |
|---|---|
| **D77** (no market, transfers locked) | Stays: no market, no pool, holders cannot send Shares to each other. **One addition:** the join curve is a second exempt address, and the invariant becomes "while locked, Shares outside the DAO move only by collection from the auction, purchase from the join curve, mint and burn". The 30 days' notice to lift the lock is unchanged. |
| **D76** (new Shares only for reviewed work, at most 10% a year) | The rule itself is unchanged: join Shares are made at launch and none are minted later. Its yearly base ("Shares that count when leaving") must leave out unsold join Shares, so it grows as they sell. |
| **D72** (locked team Shares left out of the exit) | Extended: unsold join Shares are left out too. |
| **D69** (the auction does not count toward a vote's supply) | Extended to the join curve, through the same list. |
| **D75** (limits on the split) | Needs a choice: does the join allocation count toward the "at least 60% sold" rule? Proposal: auction plus join together at least 60%, the join at most 20%, the auction at least 50%. A Standard preset could be 60 / 15 / 25 (auction / join / team). |
| **D73, D74, D43** | Unchanged: leaving stays always on, the auction still sells out or refunds, governance still opens at the claim block. |
| **D12, D14** (market venue, market by vote) | Unchanged and still on hold. If a project later opens a market, the curve and the market coexist; nobody joins above the market price, and joining below it simply funds the treasury. |

## What people see

Plain words, following the copy standard (no protocol terms in the main text):

- **Project page:** "Join this project: $0.15 a Share now. Leaving pays $0.094 a Share today." A progress bar ("75,000
  of 150,000 Shares taken") and a live list of who joined, in the project's timeline.
- **Join:** one field for how many Shares, the total, and "Your money goes to the project's treasury. You can leave
  at any time with your part of it, which is less than you pay now."
- **After joining:** what you hold, what leaving would pay, and your average price, side by side.
- **Sold out:** "All join Shares are taken."

A read that fails says it could not be read and offers to try again; it never shows a price that could then be charged
differently, or a zero.

## Tests that would decide it

- Invariants: join allocation plus sold equals the starting allocation; every join sends exactly the price to the DAO
  and the contract's money balance stays zero; the price is never below the exit value; the exit total equals every
  Share less the DAO's own, the lock's and the curve's; no Shares are minted by joining.
- Hostile cases: join then leave in the same block (a loss, never a profit); join right after the treasury receives
  money (the floor holds); many small joins against one large one (rounding never favours the buyer); a join racing a
  milestone unlock or a large leave; a stale price in the browser (refused by the maximum); per-block limits; a buyer
  trying to join to control a vote (bounded by the allocation, and leaving stays open to everyone else).
- Every guard falsified: each test fails when its check is removed (Review-Proven Rule 3).
- The simulation with joining and leaving over many runs, in dollars per participant, not just totals.

## Open questions for you

1. **The join share.** 15% by default, at most 20%? And how it counts toward D75's 60%.
2. **The price rule.** "Shares sold" for a first version, VRGDA if joining stalls, or "Shares still held" despite its
   cost?
3. **The slope.** From the auction price to twice it over the allocation, or gentler? A steeper curve rewards auction
   buyers more and asks later joiners for more.
4. **Other assets in the treasury.** The floor counts only the sale's currency. If the DAO also holds ETH or another
   token, leaving pays a part of that too, so joining and leaving could still pay by that amount. Options: count only
   the sale's currency and accept the gap, refuse joining while the DAO holds more than a small amount of anything
   else, or a short wait before join Shares can leave (bought Shares delivered after, say, 7 days, like the claim wait).
5. **Unsold Shares at the end.** Leave them in the curve forever (they count for nothing), let anyone burn them after a
   set end date, or let the DAO vote to burn them?
6. **Contributor projects.** Should a contributor project be able to open a join curve? Today it sells nothing (D66);
   money reaches its DAO only when someone sends it (D111's Funds page). Selling Shares would be a new promise,
   and its Shares are earned only through reviewed work today.
7. **Legal.** Selling Shares continuously after the raise is a continuous offering, even without a market. A lawyer
   should read it before any public network.

## If you accept it

1. Decision rows for the choices above, and an update to [TOKENOMICS-CONTRACT-CHANGES.md](TOKENOMICS-CONTRACT-CHANGES.md).
2. Contract proof on a local chain: `JoinCurve`, the `Shares` and `ragequit` changes, the kit; size measurements first.
   Unit, invariant and mutation tests, each failing before its check exists.
3. The simulation and the command line, then the app's join screen and project page.
4. The audit scope ([AUDIT-SCOPE.md](AUDIT-SCOPE.md)) updated with the new contract and the changed ones.
5. A testnet run with real people joining and leaving, before any public network.
