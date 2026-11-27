# Founder-set prices

Status: **built, 17 November 2026** (contracts only), branch `v4-governance-rework`, after the owner's go: section "Contract
changes" and the contract rows of "Tests to add", with the recommended answers to questions 3 to 6. Not built: the "earlier
backers" step (the owner said earlier backers use Give Shares), the app and the server. What was built, measured and gated:
`docs/archive/PLANV2-M4-REPORT.md`, section "Founder-set prices: built". One change after the review: project zero
is named by its key (`nameProjectZero`), not by a zero stake address, so no other project can launch without the stake
(see "Contract changes" and "App changes" below for the review's notes). The design as first written follows. It
answers the owner's "Creaton did raise at a 6m valuation, so we would need to have founders be able to set it, as Creaton
will be project zero", and the earlier ask for "a smooth way to up the valuation every time there are a lot of
improvements". It is the judge's merge of three designs (economist, attacker, project zero). Plan of record:
`docs/PLAN-V2.md`; this would be its decision 7.

Labels: **(measured)** names a report; **(simulated)** names a script in `docs/archive/econ/`; **(judgement)** is a
choice. `founder_price_judge.py` is this note's own script; `founder_price.py`, `founder_price_zero.py` and the attacker's
`founder_price_attacks.py` (scratchpad, not in the repo) are the designers'. "Price" below always means the price for the
whole project: dollars for all 1,000,000,000 Shares.

## What changes

1. **The founder sets each backing round's price**, between 333,333 and 50,000,000. The box is pre-filled (333,333 for a
   first round, then the last round's price), so a founder who does not care presses and types nothing new.
2. **Raising the price is one tap**: chips for +25%, +50% and x2 on Open backing, with the one that matches the last
   round's demand marked "suggested". A "what's new" note is built from the weekly updates since the last round.
3. **The price is fixed when a round opens** and cannot change during its 24 hours.
4. **Stage caps stay in dollars** (10,000 alone, 50,000 with a second person), at any price.
5. **The auction always offers all 250M Shares; the runner picks its starting price** (at least today's 0.0004 a Share).
   Its minimum is what all 250M raise at that price, so today's "every Share sold at the starting price or above" holds
   at any price. A default project gets exactly today's numbers.
6. **Creaton opens its rounds at 6,000,000**, and its earlier backers get Shares at the price they paid, held on the same
   365-day clock as everyone (section "Creaton as project zero").

Everything else stays: 3 / 15 / 82 over 26 weeks, the refund less 5, the 3 / 22 / 15 / 60 auction split, the 4x bid cap,
reserve sales from the last end price, the 365-day hold, the 3% fee and 2% stake.

## The rules

| Rule | Number | Basis |
|---|---|---|
| Lowest round price | 333,333 (3,000 Shares a dollar; 50,000 buys exactly the 150M backing Shares) | simulated (`founder_price_judge.py` 1). Below it a low price is a cheap way to the founder's own accounts: 150M Shares for 1,500 dollars at a 10,000 price (simulated, attacker A1). At this floor the exposure is exactly what plan section 4 already accepts, and the Team cap always runs out before the 150M |
| Highest price, rounds and auction start | 50,000,000 (20 Shares a dollar, 0.05 a Share) | judgement: gives Creaton's 6M eight times headroom, keeps a 1-dollar ask at 20 Shares, refuses typos such as 600M. The dollar caps are the real brake |
| Pre-fill | 333,333 for a first round; then the last round's price | judgement; keeps "Open backing 1 press, 0 fields" |
| Fixed per round | set in `open`, no setter, no cancel; an ask goes to one round id | simulated (attacker A4): doubling the price at hour 13, after asks can no longer be lowered, costs a backer 221 of each 1,000 |
| Later rounds | any price in the range, up or down; no per-round multiple, no automatic step | simulated: rounds need no wait and 1 dollar fills one, so a 2x-per-round limit reaches 6M in 5 days for cents and only slows honest founders (economist). Faking "asked 4x" costs a founder 382 on a 10,000 round (`founder_price_judge.py` 7) |
| Suggested raise (app only) | +25% if filled, +50% if asked 2x, x2 if asked 4x, same if not filled | judgement; a suggestion is never applied by itself because demand is cheap to fake |
| Lower price than before | allowed; the Back box says "below the X earlier backers paid"; the server tells those backers | simulated (`founder_price_judge.py` 6): a down round gives the founder side no more than any default founder can take today (150M at 3,000 a dollar). Earlier backers can take back 77.90 of each 100 on day 0 (measured, PLANV2-M4-REPORT) |
| Stage caps | 10,000 Solo, 50,000 Team, in dollars at every price | judgement: caps limit money in one or two people's hands. Caps in Shares would let a 6M solo founder raise 180,000 alone (simulated, `founder_price_zero.py` 2) |
| Auction offers | all 250M Shares, always | simulated (attacker A5): with a 6M start and today's fixed 100,000 minimum only 16.7M sell, and 30 days of held release sold drops the price 97% |
| Auction start | chosen by the runner (a Pair: both sign), at least 0.0004, at most 0.05; app pre-fills 1.2 x the last round's price | judgement. 1.2 x 1/3,000 is exactly today's 0.0004 (`founder_price.py`). Not tied to rounds on chain: a tie can be anchored by a 1-dollar round and can trap a project with no lower way to a market. A failed auction may retry lower (built: `Finisher.canOpen`) |
| Auction minimum | 250M x the start (rounded down to a raw unit) | simulated (`founder_price_judge.py` 2): 0.0004 gives 100,000.000000, today's number; 6M gives 1,500,000; 7.2M gives 1,800,000; 2.4M gives 600,000 |
| Bid cap | 4 x the start (built, `MinBid` reads the auction's floor) | measured rule (PLANV2-M4-REPORT) |
| Unchanged by price | refund per 100: 77.90 day 0, 58.64 day 45, 0 week 26; founder side at most 21.8 of each 100 by day 15; day-one floor 49.2% of the sale price; pool 22 of each 100 with 55M Shares | measured (PLANV2-M4-REPORT, M3-REPORT); simulated for other prices (`founder_price_judge.py` 3) |

**Where the three designs disagreed, and the ruling.**
- *Down rounds.* The attacker would forbid any round below the highest price that took money; the economist would allow
  them with a warning. **Allowed.** The ban traps a solo founder who priced high once and took 10 dollars (plan review
  rule 6), and what a down round gives the founder side is capped by the same 150M at 3,000 a dollar the plan accepts.
- *Auction start.* The economist ties it on chain to 1.2 x the higher of the last and average round price; the project-zero
  design to the earlier price; the attacker leaves it free. **Free on chain, pre-filled in the app.** With the minimum at
  250M x start, a low start sells everything at a low price, which hurts nobody's pool ratios; self-bidding to fill it loses
  45 to 62 of each 100 at once (measured, PLANV2-M4-REPORT).
- *Auction minimum.* The economist proposes the larger of 100,000 and 100M x start (720,000 for Creaton, partial sales come
  back); the attacker 250M x start. **250M x start.** It is today's rule in general form, needs no partial-sale path, keeps
  every M3/M4 pool ratio, and is not a trap because the runner picks the start. Creaton can start at 2.4M if it cannot
  find 1.5M.
- *Ceiling.* 10M (economist) or 50M (attacker). **50M**: 10M leaves Creaton one +66% step.
- *Demand step and 2x hand raise* (the lead's starting point). **Dropped on chain** (all three agree), kept as app chips.
- *Earlier raise.* The project-zero design adds a new on-chain "earlier backers" list from the backing Shares. **Use the
  work pot gift that is already built** (no contract change); the new list stays an owner option (questions 2).
  **Superseded (18 November 2026):** the owner chose the on-chain list for project zero; see `docs/archive/EARLIER-BACKERS.md`
  section 11.

## Creaton as project zero and earlier raises

- Creaton launches through the same Launcher. Its founder opens the first round at **6,000,000** (raw 166,666,666,666,666
  Shares per raw dollar): 10,000 alone buys 1.67M Shares (0.17%), 50,000 with a second person 8.33M (0.83%); the other
  141.7M backing Shares join the reserve when the market opens (built: `returnUnsold`) (simulated, `founder_price_judge.py` 1).
  **Superseded for project zero (18 November 2026):** those 141.67M go to the earlier backers' claim at launch; Creaton
  keeps 8,333,333.33 backing Shares for its rounds (`docs/archive/EARLIER-BACKERS.md` section 11).
- Later Creaton rounds pre-fill 6,000,000; a raise is one chip.
- **Earlier backers** (money raised before the platform; **superseded for project zero** by the claim contract of
  `docs/archive/EARLIER-BACKERS.md` section 11, still the path for any other founder): the runner gives each one Shares from the work
  pot with the built Give Shares (`Treasury.giveShares`). Before a market these go to the Vester on the same 365-day clock, cannot be
  refunded, and only free when the market opens. Shares = dollars x 1,000,000,000 / the price they paid; the app works it
  out. No fee: the money never passed through the platform. The server keeps a signed "raised before Creaton: X at Y,
  from N backers (the founder's statement, not checked)" record, and each earlier backer may confirm with one press.
- Sizes at 6M (simulated, `founder_price_judge.py` 4): 100,000 is 16.67M Shares (8% of the work pot); 300,000 is 50M (25%);
  500,000 is 83.33M (42%); 600,000 is 100M (50%). Whether 6M was before or after the money changes the count (500,000:
  83.33M post-money against 76.92M pre-money, simulated `founder_price_zero.py` 3).
- Ordinary founders get the same: they can already give work-pot Shares before a market with no limit, so recording an
  earlier raise adds a label, not a power.
- Creaton's market: the app pre-fills a 7.2M start (minimum 1,800,000); 6M needs 1,500,000; 2.4M needs 600,000. At any of
  them all 250M sell, the pool holds 55M Shares and 22 of each 100, and the held Shares are 3.8 times the pool's dollars
  with no earlier backers, 5.3 times with 500,000 of them, against 6.7 times for a default project (simulated,
  `founder_price_judge.py` 3). One day of held release sold moves the price 2% to 3% (default 4%).
- Unchanged promise (plan section 5): Creaton takes no money on a real network until 25 outside projects raised there and
  kept it 90 days, 2,500 dollars of fees arrived in 90 days, and the audit is done. On Sepolia it runs now at 6M.
- Creaton's runner never declares "no market": that would start the earlier backers' release but close its auction for good.

## What it costs an attacker

| Attack | Without a guard | With this design | Guard |
|---|---|---|---|
| Low price to own accounts | 150M Shares for 1,500 dollars and a 45 fee at a 10,000 price (simulated, attacker A1) | 150M for 50,000 and a 1,500 fee, as today (simulated, attacker A1) | lowest price 333,333 |
| Price raised mid-round | a backer loses 221 of each 1,000 (simulated, attacker A4) | impossible | price fixed in `open` |
| Fake "asked 4x" to justify a raise | founder side loses 382 on 10,000, 1,528 on 40,000 (simulated, `founder_price_judge.py` 7); an outsider faking demand loses 22.1 of each 100 (measured, PLANV2-M4-REPORT) | same cost; it only moves a suggestion | suggestion only; page shows accounts and "accounts are free" |
| High start with today's 100,000 minimum | 16.7M Shares sold, 30 days of release sold drops the price 97% (simulated, attacker A5) | all 250M sold, 30 days drops it 42% for Creaton, 58% for a default project (simulated, `founder_price_judge.py` 3) | minimum 250M x start |
| Low start to buy cheap | — | loses 45 to 62 of each 100 at once (measured, PLANV2-M4-REPORT self-bid table) | none needed |
| Down round to friends after a high round | 10,000 at 6M, then 120M Shares for 40,000 (fee 1,200) (simulated, `founder_price_judge.py` 6) | the same, no more than a default founder gets | accepted; warning, notice, refund 77.90 of each 100 on day 0 (measured) |
| Absurd price to catch naive backers | — | at most 10,000 / 50,000 per project at risk; refund 77.90 of each 100 on day 0 | ceiling 50M; Shares a dollar shown |
| Own accounts listed as earlier backers | same as work-pot gifts today | held 365 days from the market; addresses shown | label, no new power |

## Contract changes

For after the other engineer's fix lands and the owner says go. Sizes (estimate) about 40 lines.

`contracts/next/src/Rounds.sol`
- Remove `SHARES_PER_RAW_DOLLAR`. Add `MAX_SHARES_PER_RAW_DOLLAR = 3e15` (lowest price, 333,333) and
  `MIN_SHARES_PER_RAW_DOLLAR = 2e13` (highest price, 50,000,000).
- `struct Round` gains `uint256 sharesPerRawDollar`.
- `open(uint256 size)` becomes `open(uint256 size, uint256 sharesPerRawDollar)`: `CannotOpen` when the price is outside
  the two constants, or `size * sharesPerRawDollar > unsold()`; store it in the round.
- `close`: `reserved += accepted * r.sharesPerRawDollar`. `_settle`: `bought = acc * r.sharesPerRawDollar`.
- Event `RoundOpened(uint256 indexed round, uint256 size, uint256 sharesPerRawDollar, uint256 opensAt, uint256 closesAt)`.
- NatSpec: lines 13-14 ("The same for every project; nobody types it") and line 24 (dust at 3e15).

`contracts/next/src/Launcher.sol`
- `openRound(bytes32 key)` becomes `openRound(bytes32 key, uint256 sharesPerRawDollar)`, passed to `Rounds.open`.
  Event `RoundOpened` gains `uint256 sharesPerRawDollar` (last, not indexed). A Pair passes it through `propose` /
  `confirm` unchanged, so both signers sign the price.
- `openAuction(bytes32 key)` becomes `openAuction(bytes32 key, uint256 startQ96)`: revert `BadStart()` (new error) when
  `startQ96` is below `salePrices()`'s floor or above `MAX_START_Q96 = (uint256(50_000) << 96) / 1e18` (0.05 a Share);
  `(floorQ96, tickQ96) = _floorAndTick(startQ96)`; `minimum = floorQ96 * SaleParams.SALE_SHARES >> 96`; pass `minimum`
  to `_auctionParams` and to `SaleOpened` (fields unchanged).
- `AUCTION_MINIMUM` stays as the least minimum; `salePrices()` stays as the base start. NatSpec lines 52-53, 506-534.
- Only if the owner says yes to question 6: `_set` accepts `stake == address(0)`, and `launch` passes
  `stakeAmount: s.stake == address(0) ? 0 : STAKE` (`Treasury.initialize` already accepts a zero stake with zero amount).
  **As built after the review:** a zero stake address was one platform setting, so any founder who launched while it was
  zero also took no stake (measured: 20,000,000 Shares lost per such project). Instead the stake address must always be
  named, and the admin names project zero once by its key: `nameProjectZero(keyOf(founder, projectId))`. Only that launch
  takes no stake; it uses the name up and sets `projectZeroLaunched`, after which no second project zero can be named.
  The name may be changed or taken back (zero) before that launch. Deployment step: the admin calls `nameProjectZero`,
  then Creaton's founder launches; a stranger launching in between takes the stake as usual.

**Unchanged:** MinBid, Finisher, Pinned, SaleParams, LiquidityHolder, Vester, Treasury, Pair, the reserve sale.

**Events the server must index:** `Rounds.RoundOpened` and `Launcher.RoundOpened` (new price field); `Launcher.SaleOpened`
(its `minimum` and `floorPriceQ96` now vary); `Rounds.RoundClosed` and `Settled` (already, for the average price paid);
`Treasury.SharesGiven` (earlier backers, joined to the signed earlier-raise record).

## App changes

- **Open backing** (budget 1 press, 0 fields, unchanged): one row "Price for the whole project: 333,333 dollars (3,000
  Shares a dollar)", pre-filled. Tapping it shows a number box and the chips Same / +25% / +50% / x2, the suggested one
  marked. Raising shows the "what's new" note pre-filled from the weekly updates since the last round (editable, nothing
  to type). Lowering shows "Earlier backers paid X; they will be told and can take back their unreleased money". Changing
  the price is an optional path: one tap or one field. The press test pins the default path at 1 and 0.
- **Start** (3 and 3, unchanged): no price at Start; the price belongs to the round.
- **Back box:** the price, Shares a dollar, what 100 dollars buys as a percent, each earlier round's price with its money
  and accounts, "below the price earlier backers paid" when true, and the "what's new" note.
- **Auction proposal** (milestone 7, Pair): start pre-filled 1.2 x the last round's price, showing the minimum (250M x
  start), the most at 4x, and the average price backers paid; 0 fields typed by default. *After the review:* pre-fill
  `min(1.2 x the money-weighted average round price, 0.05 a Share)`, not 1.2 x the last price: above 41,666,666 the
  last-price pre-fill is over the 0.05 ceiling and the chain refuses it after both signers signed (measured: a 1-dollar
  round at 50,000,000 makes it 0.06), and a 1-dollar round could set it. Check the range before proposing. The proposal
  shows each round's price next to the chosen start and says when the start is below what backers paid.
- **Lowest price:** "333,333" is 333,333.33 for the whole project. The app sends exactly 3e15 raw Shares a raw dollar
  for it; working it out from 333,333 gives 3,000,003,000,003,000, which the chain refuses (measured). Other prices:
  `min(3e15, floor(1e27 / (price x 1e6)))`. The default Open backing press needs an app test on this path.
- **Pending price proposals** (Pair): a proposal never expires, so an old round price can still be confirmed weeks later
  (measured: 21 days). When a signer proposes a new `openRound` or `openAuction`, the app cancels that signer's earlier
  pending one for the same call, and lists a project's pending proposals with their price and age, with Cancel.
- **Project page:** "Raised before Creaton" record with "confirmed by k of N".
- **Server:** compute the average price paid; notify a project's backers when a lower-priced round opens, and when the
  auction opens with a start below the price they paid (after the review: the refund is their only protection, it falls
  to 0 at week 26, and a start of 0.0004 after a round at 50,000,000 makes 50,000 of backing worth 400 at the sale price,
  measured); store the "what's
  new" note and the earlier-raise statement (signed by the founder; browser copies refused as today).
- Copy: "price for the whole project", never protocol words (CLAUDE.md copy rules).

## Tests to add

Each must fail when its guard is removed.

| Test | Guard it pins |
|---|---|
| `open` at 3e15 + 1 reverts, at 3e15 succeeds | lowest price |
| `open` at 2e13 - 1 reverts, at 2e13 succeeds | ceiling |
| Round 1 at 6M closes, round 2 opens at 333,333, then round 1's backer settles: `bought == accepted * 166666666666666` | price stored per round (fails if settle reads a project-wide or latest price) |
| After `close`, `reserved` grows by `accepted * round price` | close uses the round's price |
| Pair: a confirm whose price differs from the proposal does not run | both signers agree the price (existing callId; re-pinned with the new argument) |
| `openAuction` below `salePrices()`'s floor and above `MAX_START_Q96` revert | auction start range |
| Start 0.006: `SaleOpened.minimum == 1_500_000e6`; bids 1 dollar short fail the auction; enough bids sell all 250M and open a pool of about 55M Shares | minimum = 250M x start (fails if it stays 100,000) |
| Start = base: floor, tick and minimum equal today's exactly (100,000e6); re-run `test_minimumIsTheWholeSale_*` and `test_selfBidThenSellIntoThePool_measured` at start 0.006 | default unchanged; ratios at a high price |
| A bid above 4 x a 0.006 start reverts | bid cap follows the chosen start |
| Failed auction at 0.006, retry at 0.0024 opens | no trap |
| Worked example: Creaton, 10,000 at 6M gives 1.67M Shares; later `returnUnsold` returns the rest | Creaton numbers |
| Only with question 6: launch with zero stake; pool open grants nothing and the reserve keeps 20M | zero stake (as built: project zero named by key; any other launch, in the same block too, takes the stake) |
| App: Open backing default 1 press 0 fields; price path 1 field; auction proposal 0 fields typed | press budgets |

Re-pin: the 3,000-Shares price test becomes the range tests above; guard-list entry N19 and the price NatSpec.

## Owner questions

1. **Creaton's earlier raise.** *Answered 18 November 2026:* 1,229,957 dollars from 21 entries under SAFTs with an older
   company, at 2.2M (seed) and 5.06M (private) for the whole project, 4.26M blended; not at 6M. The "raised at 6M" above
   is wrong. See `docs/archive/EARLIER-BACKERS.md`.
2. **Over 300,000, so the work pot cannot hold it.** *Answered 18 November 2026:* keeping their percent is 288.68M Shares
   (simulated), more than the whole work pot. Recommended now: a claim contract funded at project zero's launch from
   unused backing first, then the founder's grant, with a signed SAFT replacement per backer. Design and the remaining
   owner questions: `docs/archive/EARLIER-BACKERS.md`.
3. **Price range 333,333 to 50,000,000?** *Recommended:* yes.
4. **Down rounds allowed with a warning and a notice to earlier backers?** *Recommended:* yes; the ban traps solo founders.
5. **Auction start chosen by the runner, minimum = all 250M at that start** (Creaton 1,500,000 at 6M, or 600,000 at 2.4M)?
   *Recommended:* yes; Creaton picks its start when the gate is met.
6. **Project zero takes no 2% stake in itself** (zero stake address for that one launch)? *Recommended:* yes, and keep
   the 3% fee.
7. **Counsel:** add "founder-set price" to plan section 10's list (a founder-chosen price with a refund reads more like a
   priced offer than one platform price). *Recommended:* yes.
8. **Plan text after a yes:** section 3 table (Council "100,000 to 400,000" becomes "all 250M at the chosen start, up to 4
   times"), section 4 backing-round row and auction paragraph, section 5 "same price", section 10 "one price for every
   project". *Recommended:* yes.
