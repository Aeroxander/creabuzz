# Turning secondary trading on for a launch

For the operator of a project that was launched with the V2 kit: the person who
has to decide that this project's Shares may trade, make it happen, check it
happened, and turn it off or explain it if something goes wrong.

It assumes you know the product and not the contracts. Every call and read below
is named exactly as it exists in the source; the English next to it is what it
does. Nothing here is a guarantee the code does not make.

**Scope.** One project, on one chain, launched through `ContributorKitV2.launch`
so that a market was bound at birth. A DAO launched by the older kit has no
market (`marketOf(dao)` is zero) and cannot get one: a market is created once per
DAO, by the kit, and never again. This runbook does not apply to it.

**Status.** Trading is off by default (a listing starts disabled) and stays off until the DAO votes to
publish a listing, which is the one deliberate act and is described in §2. The founder's sale schedule is a
separate clock that limits only the founder's own sales. This document does not turn anything on; it
describes how to do it deliberately and how to prove what state you are in.

Related reading: the review packet ([SECONDARY-TRADING-REVIEW.md](SECONDARY-TRADING-REVIEW.md))
for what the code does and what it does not, and the candidate design
([SECONDARY-LISTING-SPEC.md](SECONDARY-LISTING-SPEC.md)) for the product intent.

---

## 1. Before anything: three gates

These are gates, not a checklist to skim. If one is not met, the answer is "not
yet", and the per-project facts in gate 3 stay as they are at birth.

### Gate 1 — the outside review sign-off exists

This is a release gate owned by people. Nothing in the software checks for a
sign-off. Trading is off by default only because a listing starts disabled and no
hosted build names a market factory; whoever turns it on must first confirm this
gate. The sign-off is the one described in §9 of the review packet: an outside
reviewer either found no high-severity defect, or found defects that are fixed
and re-tested, and stated a view on the seven open questions in §7 of that
packet.

No independent human audit has happened. An internal agent review pass has
happened and its three findings are fixed (§6 below). That is not an outside
review and not the review being finished: the gaps listed in §10 of the
packet, repeated in §7 here, are still open. Read them before you decide, and do
not describe the market to anyone as "audited".

### Gate 2 — the legal view on selling a claim on a treasury

The market sells existing Shares for a fixed quote token. A Share is a claim on
the project's treasury, so selling one is selling a claim on a treasury, not a
product feature. Counsel needs to have said, for the jurisdictions this project
will reach:

- whether that sale is a security, and whether the "ownership only, no dividends"
  framing holds (§7, question 5 of the packet);
- what the founder's sale schedule obliges the project to disclose (question 6);
- and what it means that **exit is always allowed**, even while the founder's
  schedule has not yet released them for sale, so a founder can leave with Shares
  not yet released for sale and take a pro-rata share of the treasury once one
  exists (question 7 — the packet answers this one "yes, in fact").

This is not a formality that can be done after the listing is on. If counsel's
answer is "not in this jurisdiction", the listing stays off there.

### Gate 3 — this project's facts are the birth facts

Three things must be true for this DAO specifically. The commands are in §3;
here is what you are looking for:

| Fact | What "not ready" looks like |
|---|---|
| The market exists and is bound to this DAO | `marketOf(dao)` is zero, or the address has no code |
| No listing exists yet | `listing()` is `(false, 0, 0, 0)` |
| The founder's schedule has released nothing yet | `saleCapacity(founder)` is `0` |

All three are the birth state. If any of them is already different, someone has
acted on this project before you — stop and find out who, before you add to it.

Two more facts are worth confirming at the same time, because neither can be
changed later: the quote token the market was born with (`quote()`), and the lot
size (`lotSize()`). Both were chosen at launch and are immutable. If the quote
token is one that takes a fee on transfer, or can blacklist or negatively rebase
an address, see §7 before going further — those are not settings you can correct
afterwards.

---

## 2. The listing vote, and the founder's clock

Turning trading on takes one deliberate act: the DAO votes to publish a listing.
It does not happen by default, it is not a platform switch, and no deployment
does it. Separately, the founder's own sales are limited by a schedule that runs
on the clock and needs no act at all. The schedule constrains the founder and
only the founder; every other holder can offer as soon as a listing exists.

### The listing vote — the DAO publishes a listing

**Who:** the DAO itself, and nobody else. `configureListing` reverts `NotDao` for
every other sender. In practice this means a proposal that passes, is queued, and
executes after the DAO's one-day timelock — the same path as any other DAO call.

**The call:**

```bash
cast calldata 'configureListing(bool,uint128,uint128,uint32)' true 1500 4500 8
```

**In the app** this is the decision kind **"Publish a secondary market listing"**
(`secondary-listing`): the form reads the DAO's market and its lot size, asks for
the lowest price, the highest and the number of steps, and opens the vote. It
renders the terms back in words before you send — *"Open a market for 40 Shares
between 1.60 and 8.00 USDC, in 64 price steps"* — and refuses locally the four
things the market would refuse (`InvalidTerms`): a price of zero, a highest not
above the lowest, steps outside 1–64, and a range the steps do not divide.
Turning it off is the same kind with the switch cleared, and its words are
*"Stop new trading rounds (settlement and claims continue)"*.

The `cast calldata` below is the same call, for operators who prefer the
command line or need to check what the app built.

The output is the calldata the proposal carries; the market is its target and the
value is zero. `true` turns the listing on. The next three numbers are the terms,
and they are frozen into every round opened from them:

- `minPrice` and `maxPrice` are the price per lot in the quote token's smallest
  unit (so a six-decimal token's `1500` is 0.0015, not 1,500 — check the
  token's decimals before you write the proposal);
- `levels` is the number of steps in the price grid, at most 64;
- the grid must divide exactly: `(maxPrice - minPrice) % levels == 0`, or the call
  reverts `InvalidTerms`. The grid has `levels + 1` prices — level `0` is
  `minPrice` and level `levels` is `maxPrice` — and sellers and buyers name a
  level, not a price.

A mistake here is not fatal: the DAO can call `configureListing` again with
different terms at any time. Rounds already open keep the terms they froze.

**What it changes:** from that block, anyone may call `openRound()` (at most once
a week), and holders may offer and bid inside an open round. It does not create a
round, move a Share, or release anything from the founder's schedule.

**What it cannot do:** it cannot reach a round that is already open. A live round
keeps its own frozen grid, timing and lot size whatever the DAO decides
afterwards. Disabling the listing does stop new offers and bids — including in a
live round, because those two calls read the listing as it is at that moment —
but it never stops settlement, refunds, returns or claims (§5).

### The founder's clock — the schedule releases units

**Who:** nobody. There is no call for this, and that is the point. It is the
passage of time, not a DAO act.

The founder's sale schedule was frozen at launch by `configureSecondary`, in the
launch transaction: a start, a cliff, and a duration. What the founder may sell
is whatever the clock has released, and the market checks it on every offer:

```bash
cast call --rpc-url "$RPC" $POLICY 'saleCapacity(address)(uint256)' $FOUNDER
```

The market refuses an offer larger than that number (`NoCapacity`), and the
Shares refuse the transfer behind it (`LockedShares`). Before `start + cliff` it
is `0`, and it grows linearly to the founder's whole grant over `duration`.

**Read the real schedule, do not assume it.** The launch chose these numbers; a
number in a code comment is not the number a given project used:

```bash
cast call --rpc-url "$RPC" $POLICY 'secondaryConfiguration()(address,address,uint256,uint64,uint64,uint64)'
```

That returns the market, the founder, the grant, the start, the cliff and the
duration. The first moment anything is sellable is `start + cliff`.

**What it changes:** as the clock passes, `saleCapacity(founder)` rises and the
founder can offer more. Nothing else in the system moves. There is no way to
release units early, pause the clock, or re-cut the schedule — it is set once, in
the birth block, and a different schedule would be a different launch.

The founder still has to *offer* the units: `sell(id, lots, minStep)` moves
`lots * lotSize` Shares from the founder into the market's keeping for that
round. A released unit that is never offered is never sold.

### What a listing alone does, and what the clock adds

- **Listing, on a brand-new project.** `openRound()` works, the round opens,
  buyers can bid. At launch the founder is the only holder, and the founder's
  `sell` reverts `NoCapacity` until the schedule releases something. The round
  matches zero lots, settles at zero, and every buyer claims their money back in
  full. No trade, no loss.
- **The clock alone.** `saleCapacity(founder)` rises, but `openRound()` reverts
  `ListingNotEnabled` and so does `sell`. Nothing can happen at all.
- **Listing, once the founder's clock has released units.** The founder can
  offer what has been released, and a trade can happen.

One qualification, because it matters once the project is no longer brand new:
the schedule constrains the founder and only the founder. Any other holder — a
contributor who was awarded Shares, for example — may offer their own Shares as
soon as a listing exists, whatever the founder's schedule says. So "listing only
sells nothing" is true of a project whose only holder is the founder; on a
project with other holders, a listing alone can produce trades.

---

## 3. Checking the state

Every read below is a plain contract read; none of them changes anything. Set
these once. Do not copy an address out of a document, including this one — read
it from the project's launch record, and cross-check the market against the
factory.

```bash
export RPC="https://…"    # the chain this project is on
export DAO="0x…"          # the project's DAO
export FACTORY="0x…"      # the market factory the launch bound
export FOUNDER="0x…"      # the founder's address
export N=1                # the round number you are looking at
export WHO="0x…"          # the holder or buyer you are checking
export KEY="0x…"          # the key of the account sending a transaction (never a shared one)

export MARKET=$(cast call --rpc-url "$RPC" $FACTORY 'marketOf(address)(address)' $DAO)
export SHARES=$(cast call --rpc-url "$RPC" $DAO 'shares()(address)')
export POLICY=$(cast call --rpc-url "$RPC" $DAO 'votingWeight()(address)')
```

If `$MARKET` comes back as the zero address, this project has no market and
nothing below applies.

### The reads, and what each value means

| Read | "Off" | "On" | What it tells you |
|---|---|---|---|
| `marketOf(dao)` | `0x0000…0000` | the market address, with code | This DAO has its one market. Never changes once set. |
| `listing()` | `(false, 0, 0, 0)` | `(true, minPrice, maxPrice, levels)` | Whether a listing exists and its terms. This is the listing vote. |
| `roundCount()` | `0` | `>= 1` | Whether any round has ever been opened. |
| `rounds(n)` | the call reverts `UnknownRound` (no such round) | returns a round with `opensAt != 0` | One round's frozen terms, times and result. |
| `saleCapacity(founder)` | `0` | `> 0` | How much of the founder's grant the schedule has released. This is the founder's clock. |
| `saleEligibleOf(founder)` | `(0, 1)` | `(n > 0, 1)` | The same number as the Shares see it; version `1` means a sale policy is bound. |
| `transfersLocked()` | `true` | `true` | Not the trading switch, so the value is the same either way. `true` is the birth value and stays `true` when the market is open. |
| `transferExempt()` | anything other than `$MARKET` | `$MARKET` | The market is the one address Shares may move to and from while locked. If this is not the market, trading cannot work and cannot be fixed — it is set once. |

The reads in full:

```bash
cast call --rpc-url "$RPC" $MARKET 'listing()(bool,uint128,uint128,uint32)'
cast call --rpc-url "$RPC" $MARKET 'roundCount()(uint256)'
cast call --rpc-url "$RPC" $MARKET 'rounds(uint256)(uint128,uint128,uint32,uint64,uint64,uint64,uint256,uint256,uint16,bool,bool)' $N
cast call --rpc-url "$RPC" $POLICY 'saleCapacity(address)(uint256)' $FOUNDER
cast call --rpc-url "$RPC" $POLICY 'secondaryConfiguration()(address,address,uint256,uint64,uint64,uint64)'
cast call --rpc-url "$RPC" $SHARES 'saleEligibleOf(address)(uint256,uint8)' $FOUNDER
cast call --rpc-url "$RPC" $SHARES 'transfersLocked()(bool)'
cast call --rpc-url "$RPC" $SHARES 'transferExempt()(address)'
```

**One trap in `rounds(n)`.** The field called `price` is the winning grid
**level** — a small number like `3` — not a price. The money price per lot is
`priceAt(n, level)`. The `Settled` event reports the price, the struct reports
the level, and confusing the two produces a wrong explanation to users:

```bash
cast call --rpc-url "$RPC" $MARKET 'priceAt(uint256,uint256)(uint256)' $N 3
```

### Before the listing vote

```bash
cast call --rpc-url "$RPC" $MARKET 'listing()(bool,uint128,uint128,uint32)'
# (false, 0, 0, 0)
cast call --rpc-url "$RPC" $POLICY 'saleCapacity(address)(uint256)' $FOUNDER
# 0
cast call --rpc-url "$RPC" $SHARES 'transferExempt()(address)'
# $MARKET
```

That is the state the kit's read-back asserts at launch, and the state a local
fixture checks against live node state (`scripts/v5-local-fixture.sh`). If you see
it, nothing has been turned on.

### After the listing vote, before the founder's clock releases anything

```bash
cast call --rpc-url "$RPC" $MARKET 'listing()(bool,uint128,uint128,uint32)'
# (true, minPrice, maxPrice, levels)
cast call --rpc-url "$RPC" $POLICY 'saleCapacity(address)(uint256)' $FOUNDER
# still 0 — a listing releases nothing
```

`openRound()` now succeeds and `sell` from the founder still reverts
`NoCapacity`. This is the state in which a round can open and match nothing; it
is safe, but it is not trading.

### After the founder's clock has released units

```bash
cast call --rpc-url "$RPC" $POLICY 'saleCapacity(address)(uint256)' $FOUNDER
# > 0
```

Only now can the founder offer, and only up to that number. Confirm it before you
tell anyone trading is open.

### Before and after each round

```bash
cast call --rpc-url "$RPC" $MARKET 'rounds(uint256)(uint128,uint128,uint32,uint64,uint64,uint64,uint256,uint256,uint16,bool,bool)' $N
# minPrice, step, levels, opensAt, closesAt, settleDeadline, asked, wanted, price, settled, sellersShare
cast call --rpc-url "$RPC" $MARKET 'voided(uint256)(bool)' $N
cast call --rpc-url "$RPC" $MARKET 'clearingOf(uint256)(uint256,uint256,bool)' $N
# the price level, the lots it matches, and which side is oversubscribed — the same
# algorithm settle runs, so a preview cannot disagree with the outcome
cast call --rpc-url "$RPC" $MARKET 'quoteIn(uint256)(uint256)' $N
cast call --rpc-url "$RPC" $MARKET 'sharesIn(uint256)(uint256)' $N
# the market's own inventory ceiling, which must cover what the round is holding
cast call --rpc-url "$RPC" $POLICY 'saleCapacity(address)(uint256)' $MARKET
```

`quoteIn` and `sharesIn` are what that round is holding, in the quote token and
in Shares. They should only ever go down after settlement, as returns and claims
are paid. If either is not what the round's own orders say it should be, that is
an engineering escalation (§6), not something to fix by hand. The market's own
`saleCapacity` is the ceiling the policy holds it to; it must be at least
`sharesIn(n)` for the round's Shares to be returnable (§7).

To check one person's position in a round:

```bash
cast call --rpc-url "$RPC" $MARKET 'sells(uint256,address)(uint128,uint16,uint128,uint64,bool,bool)' $N $WHO
# lots, minStep, filled, orderId, escrowReturned, proceedsPaid
cast call --rpc-url "$RPC" $MARKET 'bids(uint256,address)(uint128,uint16,uint128,uint64,bool,bool,bool)' $N $WHO
# lots, maxStep, filled, orderId, cancelled, sharesPaid, refundDone
```

---

## 4. A round, from open to paid

A round is the unit of trading. One price clears per round; there is no order
book and no partial-price negotiation.

**Open.** Anyone may call `openRound()`. It needs a listing and it must be at
least seven days after the previous open, so at most one round a week; the very
first round on a project has no wait. The round freezes its price grid, its
times, the lot size and the fee (zero — `FEE_BPS` is a constant, not a setting)
before any order exists. Nothing the DAO does later reaches it.

```bash
cast send --rpc-url "$RPC" --private-key "$KEY" $MARKET 'openRound()'
```

**Bidding, for three days.** Sellers offer whole lots at the lowest grid level
they will accept; buyers bid whole lots at the highest level they will pay. Both
put their side of the deal into the market's keeping when they order: a seller
`lots * lotSize` Shares, a buyer `lots * priceAt(id, maxStep)` of the quote
token. Both are measured exactly, and an inexact transfer is refused.

A seller has to let the market move their Shares first — the usual ERC-20
approval, for at least the amount being offered (`lots * lotSize()`, and a lot
size is not always 1e18):

```bash
cast send --rpc-url "$RPC" --private-key "$KEY" $SHARES 'approve(address,uint256)' $MARKET 4000000000000000000
cast send --rpc-url "$RPC" --private-key "$KEY" $MARKET 'sell(uint256,uint128,uint16)' $N 4 0
cast send --rpc-url "$RPC" --private-key "$KEY" $MARKET 'bid(uint256,uint128,uint16)'  $N 4 8
```

Limits that matter to an operator explaining a refusal: 32 sellers and 32 buyers
per round, one order per side per address per round, and the DAO itself may never
sell (`DaoCannotSell`) — the DAO cannot dump inventory through the market.

**Cancel, only while bidding is open.** `cancelSell(id)` returns a seller's
Shares in the same transaction. `cancelBid(id)` records the refund; it is paid by
`claimQuote`, not pushed. Cancelling is free, which is a design limit, not a bug
(§7).

**Close, then settle, for two days.** From the close until two days later, anyone
may call `settle(id)`. Nobody is paid for settling and no role is required; if
nobody does it, the round does not settle. That makes settling the operator's job
in practice, because the alternative is a refund, not a trade.

```bash
cast send --rpc-url "$RPC" --private-key "$KEY" $MARKET 'settle(uint256)' $N
```

Settlement produces one price per lot: the lowest grid level whose uniform price
matches the most whole lots. Everyone who crosses that price fills whole on the
short side; the oversubscribed side shares the remainder in whole lots, pro rata,
with the leftover lots going to the lowest order id. `settle` moves no Shares: it
books each order's fill and nothing else. Sellers' unsold Shares go back to the
seller when `claimShares` is called for them (below), one seller per transaction.

**Void.** If the settle window passes with no settlement, the round is void:
`voided(id)` returns `true`, `settle` now reverts `SettleOver`, and the round is
treated as if nothing had sold. **Anyone** can then recover for anyone else —
there is no privileged rescuer and no deadline:

```bash
# seller's whole offer back
cast send --rpc-url "$RPC" --private-key "$KEY" $MARKET 'claimShares(uint256,address)' $N $WHO
# buyer's whole escrow back
cast send --rpc-url "$RPC" --private-key "$KEY" $MARKET 'claimQuote(uint256,address)' $N $WHO
```

**Getting paid is something a user does, or anyone does for them.** Only a
cancelled offer's Shares come back on their own, in the cancel transaction.
Everything else is a recorded right that has to be claimed:

- a seller's unsold Shares: `claimShares(id, seller)`, for `(lots - filled) * lotSize`;
- a seller's proceeds: `claimQuote(id, seller)`, for `filled * price`;
- a buyer's Shares: `claimShares(id, buyer)`, fresh, with no inherited age;
- a buyer's refund of everything above the clearing price, or the whole escrow if
  the bid did not cross, or the whole escrow of a cancelled bid: `claimQuote(id, buyer)`.

Both claim calls are permissionless and take the beneficiary as an argument, so
an operator can and should run them for users who do not. They never pay twice
and a repeat reverts `NothingToClaim`. A claim that the quote token refuses
leaves the right standing for a later call — nothing is lost, it is delayed.
Claims have no expiry and keep working after the listing is disabled.

Tell users this plainly: **money is not pushed to them.** A user who never claims
has not been paid, and it will look like a missing payment when it is an
unclaimed one.

The app's Trading card collects from the latest round and the last 8 earlier
rounds. If a wallet may be owed by an older round, the card names the round ids
not checked yet and offers "Check older rounds", which reads the next fixed block
of 8 ids and repeats down to round 1. The `cast` commands above still work for
any round.

### Keeping rounds moving without anyone watching

A round closes and times out by the clock. Anyone can settle it between the close and the settle deadline; after the
deadline it is void and everyone takes back what they put in. The app helps while someone has the page open: the
Trading card re-reads every 30 seconds while a round is live, so it flips to "Settle the round" the moment bidding ends,
and a wallet with an order in the round is told that anyone can settle it and by when. A browser cannot settle by
itself, because settling is a transaction the visitor's wallet must approve.

For the hours nobody is looking, run the keeper, which sends only what the contract lets anyone send:

```bash
RPC_URL=<node> MARKET=<market address> KEEPER_PRIVATE_KEY=<gas-only key> KEEPER_OPEN=1 scripts/secondary-keeper.sh
```

- It settles a closed, unsettled round inside its window, and does nothing for a round still taking orders or one that
  is already void (the chain would refuse both, so it does not pay gas to try).
- `KEEPER_OPEN=1` also opens the week's round when the listing is on and a week has passed since the last opening.
  Leave it unset to settle only; opening spends the operator's gas on a round that may get no orders.
- The key pays network fees and nothing else. Use a fresh key with a few dollars of gas, never a key that owns Shares or
  controls a DAO: `cast` takes it on its command line.
- `--once` runs one pass (for cron); without it the keeper loops every `KEEPER_INTERVAL` seconds (default 300, at least
  30). Run it at least every few hours: the settle window is two days.
- It cannot move anyone's money: it has no power over orders, prices or the listing, because the market has none.
  `scripts/secondary-keeper-e2e.sh` proves each of those claims on a real local chain.

---

## 5. Turning it off

The off-switch is the same call as the listing vote, with `false`:

```bash
cast calldata 'configureListing(bool,uint128,uint128,uint32)' false 0 0 0
```

The last three arguments are ignored when disabling; the listing is set to
`(false, 0, 0, 0)`. Like the listing vote, it is a DAO call: a proposal, a vote, and the
one-day timelock. **You cannot stop trading in the next block.** Plan for the
delay.

### What it does

- `openRound()` reverts `ListingNotEnabled`: no new rounds.
- `sell` and `bid` revert `ListingNotEnabled`: no new offers or bids, including
  in a round that is already open.
- That is the complete effect.

### What it does not do

- It does not stop settlement. `settle` never reads the listing.
- It does not stop cancellations. `cancelSell` and `cancelBid` never read the
  listing either, so a seller can still pull out of a live round while bidding is
  open.
- It does not stop claims, refunds or returns. Nothing in `claimShares` (which
  includes a seller's unsold return) or `claimQuote` reads the listing.
- It does not cancel, shorten or void an open round. There is no such function.
- It does not unlock or re-lock Shares. The transfer lock is a separate switch
  with a separate 30-day notice, and the market works with the lock still on
  because the market is the Shares' one exempt address.

### To actually stop trading, in order

1. Disable the listing, and say so publicly with the time it will take (the
   proposal plus the timelock).
2. Let the open round reach its close. New orders are already blocked; existing
   orders can still cancel, which is correct — a seller must always be able to
   get their Shares back.
3. Settle that round inside its two-day window, or let it go void. Either way
   everyone ends up with what is theirs: settled means the trade happened at the
   clearing price, void means everyone is refunded.
4. Run the claims for anyone who has not, and check `quoteIn(n)` and `sharesIn(n)`
   reach zero for every round.
5. Only then tell people trading is off.

Trading is "off" when no round can open and no round is still holding anything.
The listing flag alone is not the whole answer.

### What you must not do

- **Never try to move the money.** There is no admin function that can. The
  market has no owner, no pause, no sweep and no upgrade; its complete set of
  state-changing functions is `configureListing`, `openRound`, `sell`, `bid`,
  `cancelSell`, `cancelBid`, `settle`, `claimShares` and `claimQuote`. The DAO
  can call exactly one of them. Anyone proposing to "rescue" funds from the
  market is proposing something that does not exist.
- **Do not set a Shares transfer validator expecting it to stop trading.** It
  will not reach the market at all: the market is exempt from the validator as
  well as from the lock, deliberately, so that a validator can never freeze
  escrowed Shares (that was review finding F3). It affects ordinary
  holder-to-holder transfers only.
- **Do not try to change `transferExempt`.** It is set once, at the token's
  birth, and `lockTransfersWithNotice` reverts on a second call.
- **Do not un-exclude the market from voting supply.** The exclusion set is
  frozen at creation; there is no path to change it.
- **Do not burn, bridge or "park" Shares to make a round settle.** A round with
  no crossing price is not a failure; it is a round that matches nothing, and
  everyone claims back in full.

---

## 6. When something looks wrong

### Check these first

In this order. Most reports turn out to be one of the last three.

1. **Is it the right market?** `marketOf(dao)` — a project has exactly one, and a
   second address claiming to be the market is not one.
2. **Is the listing on?** `listing()` — `(false, …)` explains every
   `ListingNotEnabled` refusal.
3. **Is the round in the phase you think?** `rounds(n)`: `closesAt` and
   `settleDeadline`. A `BiddingOver`, `BiddingOpen`, `SettleOver` or
   `AlreadySettled` revert is a clock question, not a bug.
4. **Is the round void?** `voided(n)`. A void round pays everyone back and needs
   no settle; `settle` reverting `SettleOver` on it is correct.
5. **Is the money still there?** `quoteIn(n)`, `sharesIn(n)`, and the two claim
   flags on the order in question (`sells`, `bids`).
6. **Has the person claimed?** `proceedsPaid`, `refundDone`, `sharesPaid`. "I was
   not paid" is usually "nobody called `claimQuote`".
7. **Was the price misread?** `rounds(n).price` is a grid level, not a price
   (§3). This causes more bad explanations than any contract bug.

### The three findings from the first review

All three were real, all three are fixed, and each has a regression test that
fails if its fix is reverted. Know them, because a user may have read about them.

- **F1 — a seller's proceeds could be burned before settlement (medium).** A
  seller who also had a cancelled bid could have their proceeds marked paid at
  zero by anyone before the round settled; after settlement the money was
  unreachable. Fixed: a seller's proceeds are only paid when the round is
  settled or void. Pinned by
  `test_a_sellers_proceeds_survive_a_pre_settle_claimQuote`.
- **F2 — leftover lots did not follow order id (low).** Cancelling an early order
  moved a later one into its list slot, so the documented tie-break was false and
  could be gamed by transaction ordering. Fixed by shifting on removal instead of
  swapping. Pinned by `test_leftovers_follow_order_id_after_a_cancellation`.
- **F3 — the DAO could freeze escrowed Shares (medium–high).** The DAO can set a
  Shares transfer validator at any time, and the validator saw the market's own
  transfers, so a refusing validator froze `cancelSell`, the unsold-lot return in
  `settle`, and a void round's `claimShares`. Fixed by exempting the market, the
  Shares' named `transferExempt` address, from the validator. Pinned by
  `test_a_dao_validator_cannot_freeze_the_markets_escrow`.

If you see a report that matches F1, F2 or F3 on a live deployment, treat it as a
different defect — the old one cannot happen — and escalate with the round number
and the transaction hashes.

### Fix yourself, or escalate

| Symptom | Who |
|---|---|
| Nobody settled and the window closed; the round is void | You: run `claimShares` and `claimQuote` for each order. Everyone is refunded in full. |
| A user says they were not paid | You: check the three flags, then call the claim for them. |
| A quote transfer was refused (token paused or blocking) | You: retry later. The right stands; nothing expires. |
| `NoCapacity` on a founder's offer | You: the schedule has not released that much yet — check `saleCapacity` against the offer. Not a bug. |
| `TooManySellers` / `TooManyBuyers` | You: the round's 32 slots are full. Next round. |
| `LockedShares` on a holder-to-holder transfer, or on a founder's transfer | You: either the transfer lock is on (the birth state, a separate switch with a 30-day notice, not part of trading) or the founder is moving more than `saleCapacity` has released. Both are correct refusals, not faults. |
| `BadAmount` on an ordinary-looking quote token | **Engineering.** The exact-transfer check refused it. Fee-on-transfer tokens fail closed here by design; a token that started taking a fee after launch is a new situation. |
| The quote token blacklists or negatively rebases the market's own address | **Engineering.** Untested (§7). Stop the listing and escalate; do not attempt workarounds. |
| `LedgerShort`, or `quoteIn`/`sharesIn` that do not match the round's orders | **Engineering.** Stop the listing, do not touch the funds, preserve the round number and reads. |
| `MarketInventoryShort` from the policy | **Engineering.** The escrow books claim more than the market holds. |
| A settle at the maximum order count runs out of gas, or the keeper warns that a settle is at or over the 2^24 cap | **Engineering.** The measured worst case is about a fifth of the cap (§7), so this means something changed. Do not touch the funds; a round that cannot be settled goes void and refunds by claim. |
| A defect in the market's own logic | **Engineering and a product decision.** The market cannot be upgraded or patched; replacing it means a new deployment and a DAO decision. |

Never escalate by asking engineering to move funds. Nobody can, including them.

---

## 7. What is not covered, and what is a limit rather than a bug

### Still open after the first review

These come from §6 and §10 of the review packet. The first two bullets have
since been measured or covered and say so; the rest are still open. Do not
describe the market to users, or to counsel, as though the open ones were closed.

- **The heaviest settle is measured on the real policy, and it fits one
  transaction.** A full round of 32 sellers, 32 buyers and 64 levels, on a real
  `ContributorKitV2` launch with every touched contract cooled and three days of
  blocks after the offers (`SecondaryMarketRealGas`), re-measured after settle
  stopped returning unsold Shares. These are the review packet's F4 figures:

| Shape (32 sellers x 32 buyers x 64 levels) | Settle gas | Share of 2^24 (16,777,216) | Worst single seller claim |
|---|---|---|---|
| Typical: one fresh lineage per seller, mixed fills | 2.40M | 14% | 0.48M |
| Typical: one fresh lineage per seller, every seller part-filled | 2.97M | 18% | 0.48M |
| Five fresh lineages per seller, mixed fills | 2.88M | 17% | 0.72M |
| Five fresh lineages per seller, every seller part-filled | **3.58M** | 21% | 0.61M |
| Eight histogram slots populated, each seller sold one lot | 3.15M | 19% | 0.59M |

  `settle` now only books fills and moves no Shares; each seller's unsold return
  is that seller's own `claimShares`. Before settle stopped returning unsold
  Shares, a part-filled round near 32 sellers could not be mined on a chain that
  enforces the 2^24 per-transaction cap (EIP-7825): the part-filled shapes cost
  17.5M to 20.9M gas, the round went void, and the sellers and buyers took
  everything back by claim. Funds were safe throughout, because void rounds
  refund by claim. A full round is no longer a reason for caution; the
  suite fails any shape over half the cap, and the keeper warns if an estimate is
  at or over it.
- **The real market and the real `ActivationVoting` are tested together.** The
  adversarial, review and resolution suites run against a real `ContributorKitV2`
  launch as well as the mock policy (`SecondaryMarketAdversaryReal`,
  `SecondaryMarketReviewReal`, `SecondaryMarketFlowsResolutionReal`), and
  `ActivationVotingRealMarketFuzz` walks the real market and checks the escrow
  books at every step. This is the author's own coverage, not an outside attack
  on the composition.
- **Fee-on-transfer quote tokens fail closed.** The exact-balance check reverts
  the bid, so such a token is unusable rather than unsafe. That is the safer
  failure, but it is a failure: a project launched with a fee-on-transfer quote
  cannot trade, and cannot change the token.
- **A blacklist or a negative rebase on the market's own address is untested.**
  A quote token that can freeze or shrink the market's balance is the one
  scenario where the market's accounting could be left holding less than its
  orders claim. Nothing covers it.
- **`_migrateEscrow` in the policy was not read closely.** The market's own
  ledger was found conserved (`sharesIn` and `quoteIn` hold), but the policy's
  escrow-migration side is unreviewed.
- **No real-chain reorg testing** for the market, and no formal verification of
  the clearing algorithm. One internal agent review pass has read the market, the factory
  and the policy hooks; that is not an outside audit, and not an audit of the whole kit.
- **There is no upgrade path, by design.** That removes upgrade risk and also
  removes the ability to fix a defect: a replacement market is a new deployment
  and a DAO decision, with its own market address and its own history.

### Limits to state, not fix

These are choices in the design. They will be reported as bugs; they are not.

- **32 buyer slots, and cancellation is free until the close.** Someone can fill
  all 32 slots with throwaway bids, cancel them at the last moment, and keep
  honest bidders out for the whole three-day window. It costs the griefer nothing
  and nobody loses money: the cost is that the round's demand is not the demand
  that existed, and honest bidders wait a week.
- **Seller seats can be squatted the same way.** A holder with a lot to spare in
  each of 32 wallets can fill the 32 seller seats with offers at a price nobody
  will pay, cancel at the last moment, and keep honest sellers out of the round
  (`TooManySellers`). It costs nothing and no money is lost. Whether to bound it
  is an open product decision (packet §6).
- **Orders are visible and cancellable until the last second.** A bid can move
  the price and then be pulled. The clearing is honest about the orders that
  exist when it runs; it cannot make a late withdrawal honest.
- **A larger order takes a larger share when its side is oversubscribed.** The
  oversubscribed side is shared pro rata by stated size, and what is not filled
  comes back in full, so overstating an order's size costs only the time the
  money or Shares sit in the market. Honest sizes are not rewarded. Whether to
  change the rule is an open product decision (packet §6).
- **One price per round, one round a week, 32 sellers and 32 buyers.** A round is
  a weekly clearing, not a continuous market. Someone who wants to trade now may
  have to wait, and a round that does not cross simply does not trade.
- **The fee is zero.** `FEE_BPS` is a constant `0`, not a setting. The candidate
  design's fee discussion does not apply to this code: there is no way to charge
  one, and no way to add one without a new deployment.
- **The founder can exit while their sale schedule is locked.** The schedule
  restricts transfer and sale; a burn (a direct exit) never passes through it.
  Once the treasury holds something, a founder can leave with Shares not yet
  released for sale and take a pro-rata share. Exit is always allowed; the packet
  states this plainly (question 7); it is a product fact for counsel, not a
  defect to fix.
- **The DAO cannot sell inventory through the market, and the market cannot mint.**
  It only ever sells Shares a holder put into it.
- **A blocked quote token can delay payouts indefinitely.** The right to be paid
  survives and never expires, but nothing is pushed. "Delayed" and "lost" look
  identical to a user who is not told.

### Unclear — needs engineering

One thing this runbook cannot settle from the source, stated rather than guessed
(the first question it opened is now answered, and kept here with its answer so
the next reader does not reopen it):

1. ~~Whether `saleCapacity(founder)` and the founder's actual balance stay equal
   across a partial return.~~ **Answered.** They do: the ceiling is
   `balance - still locked grant`, escrowing lowers the balance so the ceiling
   falls with it, and a prepared return puts back exactly the returned amount —
   not the whole original escrow. Pinned by
   `test_the_founders_sale_ceiling_follows_a_partial_escrow_return` in
   `contracts/test/ActivationVoting.t.sol`, which escrows 10, returns 4, and
   checks the ceiling moved by 10 then back by 4. The operator check in §3 is
   therefore a confirmation, not a guess: if it ever diverges, that is a
   regression, and the test above is what should have caught it.
2. **The exact failure mode when the market's own capacity falls below its
   escrow.** The policy refuses any market move that would leave the escrow books
   claiming more than the market holds (`MarketInventoryShort`), and the market's
   own `saleCapacity` is that capacity. A check worth running before each round
   is that `saleCapacity(market) >= sharesIn(n)`; what should happen if it ever
   is not — which claim reverts, and in what order — cannot be stated from a
   reading of the source. Engineering should answer it before a real-value launch.
