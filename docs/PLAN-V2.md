# Creaton: plan, version 2

Status: a plan. **Nothing in it is built, and nothing will be built until the owner says go.** Written 17 November 2026
on branch `v4-governance-rework`. It replaces `docs/NEXT-VERSION-PLAN.md` as the plan of record and keeps everything
milestones 0 to 3 built. Everything is for Sepolia (the test network) first.

How to read the numbers. **(measured)** = run in milestones 1 to 3, report named. **(simulated)** = from a plain Python
model, assumptions stated; the files are listed at the end and nothing was run against contracts for this plan.
**(judgement)** = my choice, change it freely. **(estimate)** = a guess at size or time. "Outside knowledge" = what I
know of other products, not checked here.

## 1. What this is

1. A community-run accelerator for solo AI builders: start alone in minutes, ship in public every week.
2. Small money comes through a **backing round**: one fixed price, no auction, no market, and a refund of whatever
   has not yet been paid to the project.
3. Large money (100,000 dollars and up) comes through the **auction into a Uniswap pool** that milestones 1 to 3 built.
4. More money needs more shared control: Solo, Backed, Team, Council, Open.
5. The platform takes 3% of money raised and small fees on trades, hand-backs and paid tasks.
6. Creaton itself is project zero and CREATE is its Shares, on the same rules as everyone.

**What changed from the first plan**

- Raises under 100,000 no longer get an auction and a pool. They get the backing round. The Small, Standard and Large
  auction sizes go; one auction size stays.
- Five stages with raise caps (10,000 alone, 50,000 with a second person, the auction above that).
- Before a market, a backer leaves by a **personal refund**, not a shared floor.
- Backing money is paid over 26 weeks (82 of each 100), not 12 months (60 of each 100). **Changes an earlier yes.**
- Every Share handed out before a market is held and released over 12 months from the day the market opens. This now
  includes Shares bought in backing rounds. **Changes "never locked" for that one group.**
- The exit fee's 4 goes to the project instead of staying in the floor. The 4-times bid cap becomes absolute.
- The 3-day Stop vote goes. Before a market the refund is the stop; after it, parking a third of free Shares pauses
  payments. **Changes an earlier yes.**
- A new thin web app replaces the plan to cut the old one down.
- Creaton takes 2% of a project's Shares, only if that project opens a market.

## 2. The product in five sentences

**Founder.** Press Open backing and people can back you for 24 hours at the same price as every other project. Creaton
keeps 3%, you get 15% at once and the rest week by week over 26 weeks while you post your update. Backers can take
back whatever has not been paid to you yet, so keep shipping.

**Backer.** You pay dollars and get Shares in the project at a fixed price. Any day you can take back the part of your
money not yet paid to the project, less 5%.

## 3. One project's life

All numbers (judgement) unless marked. The page shows only the current stage and the single next step.

| | Solo | Backed | Team | Council | Open |
|---|---|---|---|---|---|
| Starts when | Press Start | First backing round closes with money in it. Automatic | A second person accepts as second signer. No wait | The auction passes its 100,000 minimum and the market opens | 365 days after the market opened. Automatic |
| Most outside money, in total | 0 | 10,000 | 50,000 | 100,000 to 400,000 (one auction) | no cap |
| How it raises | first round, one press | backing rounds, no wait between them | backing rounds; then may open the auction | the auction; later reserve sales | reserve sales |
| Who decides | founder | founder | one signer up to 500 a week (agents included); both above that, and for raises and goal changes | 5 seats, 3 of 5: budget, raises, goal. Team rule inside the budget | same, all 5 seats elected |
| Founder gives up | nothing | money arrives over 26 weeks; backers can take it back | sole signature | budget, raises and goal; keeps 1 seat and the daily work | the reserved seat; can be replaced; keeps released Shares |
| Holders can | nothing to decide | personal refund | personal refund | hand back at the floor, sell in the pool, elect 4 seats, park to pause | elect all 5, replace the runner, vote on reserve sales and winding down |
| Longest wait | none | 24 hours (the round) | 24 hours | 3 days (a vote) | 10 days (7 notice + 3 vote) |

Rules behind the table:

- **Caps are the brake, not the calendar.** The Launcher refuses a round that would pass the stage's cap. The page
  shows "Eligible for (next stage) since (date)".
- **Stage names prove no vetting.** A second signer or fifty backers can be one person with several accounts
  (accounts are free). The page says so. What cannot be faked cheaply: the caps, the refund, and auction money.
- **Team spending:** 500 dollars per rolling 7 days for any one signer, agents included; above that both people
  touch. It bounds a stolen passkey or a runaway agent. Reuses the built RollingCap.
- **Council:** the first election runs within 30 days **after** the market opens, among free Shares only. On that day
  the only free Shares are those bought in the auction, so real bidders choose the first 4 seats. Founder holds 1
  reserved seat until Open. Two seats come up every 6 months; a vote lasts 3 days; each parked Share backs one
  candidate. Default budget if the council never acts: 6% of money raised per 30 days.
- **Check-in:** every 14 days, by a person's touch (founder or second signer). An agent may write the update but not
  send the check-in. This changes what is built (one line).
- **Agents** act inside daily caps (25 dollars and 0.1% of Shares, built). They draft; a person signs goals, promises,
  raises and stage steps. An agent never confirms its own, its runner's or a sibling's work, never is the second
  signer, never holds a seat.

**Edge cases**

- **Never raises.** Stays Solo for ever. Everything works; costs the platform nothing; nags nobody.
- **Raises once and stalls.** Payments stop by themselves 14 days after the last check-in (measured, M2: no back pay
  for paused time). Backers take back what is unpaid. The page says "quiet since (date)". After 28 silent days at Team
  the second signer takes over.
- **Founder leaves.** One press, Hand over, names a successor. They keep the part of their 20% matching days served out
  of 365; the rest returns to the work pot.
- **Two co-founders disagree.** Each can still spend 500 a week and check in. Before a market backers simply refund;
  after it holders choose by the replace vote.
- **Wind down.** Below Council one press by the founder; at Council 3 of 5; at Open a holder vote. Payments stop for
  good, the hand-back fee drops to the platform's 1, backers take their unpaid money. Money in the pool cannot be
  split (measured, M3: the LiquidityHolder has no function that moves it).
- **Never opens a market.** From 12 months after its first round a project may declare "no market", for good. Held
  Shares then start their 12-month release and the auction is closed to that project for ever. Reuses the built
  abandoned state.

## 4. Money rules

**Shares at birth** (1,000,000,000, fixed): founder 20%, work pot 20%, backing rounds 15%, auction 25%, pool match
10%, reserve 10%. Unsold and returned Shares join the reserve. If a market opens, 2% (20,000,000) moves from the
reserve to Creaton (section 5). The old "sale 40" is now 15 + 25; founder, work pot and reserve are as agreed.

**One clock for held Shares.** Founder Shares, Shares given before a market and Shares bought in backing rounds sit in
the built Vester. They release evenly over 365 days from the day the market opens (or from a "no market" declaration).
Held Shares cannot be sent, parked or handed back at the floor. Shares bought in the auction or the pool, and Shares
given after the market opens, are free at once. The token itself stays plain and is never locked.

Why this changes "never locked": without it a founder who filled their own backing rounds through second accounts
(cost: the 3% fee, 1,500 dollars on 50,000) could sell into the new pool and hand back at the floor on day one, taking
about 45% of honest auction money (simulated by the attacker on a 50,000 auction; not re-run at this plan's size). With it: 162 dollars of a 22,000 pool on day 1, 3,996 by day
30 if every freed Share were sold (simulated). The hold spreads the selling over a year; it does not remove it.

### The backing round

| Rule | Number | Basis |
|---|---|---|
| Price, the same for every project, typed by nobody | 1 dollar buys 3,000 Shares (0.000333 a Share; 50,000 buys exactly the 150M backing budget) | judgement |
| Size | whatever is left under the stage cap; no menu, no minimum, smallest backing 1 dollar | judgement |
| Window | 24 hours. If more is asked than fits, everyone gets the same percent and the rest comes back | simulated: 60 real backers against one buyer with 20 accounts each get 25.5% |
| Asks | may be lowered or withdrawn only in the first 12 hours; the amount asked is shown after that | judgement |
| Each 100 | 3 platform, 15 to the project at once, 82 released evenly over 26 weeks while checked in | judgement |
| Refund | your own unreleased money less 5 (4 to the project, 1 to the platform); it cancels your held Shares | simulated: per 100 paid, 77.9 on day 0, 65.9 at week 4, 38.9 at week 13, 0 at week 26 |
| No per-account cap | accounts are free, so a cap protects nobody; the scale-back does the work | judgement |

The refund is personal and per round. Nobody else leaving changes your number, so a run cannot hurt those who stay,
leaving in pieces gains nothing, and Shares given for work have nothing to claim. A shared floor across rounds was
rejected: a second round moves money from new backers to old ones even at the same price (simulated: 820 dollars on a
10,000 round). After a market opens the refund continues for Shares still held for you; Shares you take out to sell
end that part of it.

The most a founder side can have by day 15 is 21.8 of each 100 (simulated): 2,180 at the Backed cap, 10,900 at Team.

### Graduation and the auction

**Bar:** the project is at Team, and the auction takes at least 100,000 in bids or refunds everyone in full by
itself. No holder count, no waiting period: both can be faked.

**The one auction** (built, sizes changed): 250,000,000 Shares, starting price 0.0004, minimum 100,000 (every Share
sold at the starting price or above), bids capped at 4 times the starting price (0.0016, so at most 400,000), no bids
in the last 720 blocks (built). Each 100: 3 platform, 22 locked pool, 15 at once, 60 floor over 12 months. **The
owner's split is unchanged.**

| Raised | Pool holds | 100-dollar buy moves price | 2,500-dollar buy | Floor per Share, day one |
|---|---|---|---|---|
| 100,000 | 22,000 dollars, 55M Shares | +0.9% | +23.8% | 49.2% of the sale price |
| 250,000 | 55,000 | +0.36% | +9.2% | 49.2% |
| 400,000 | 88,000 | +0.23% | +5.7% | 49.2% |

All simulated; the model reproduces the measured M3 pools (9.2% and 23.7% for a 100-dollar buy; 202.27 dollars and
minus 17.5% for 9M Shares sold). The 49.2% equals the M3 measurement. It falls as the floor is paid out and as held
Shares release.

**Fees.** Raise 3% on both paths. Pool trades 1% (dollar side: half platform, half project; Share side burned).
Hand-back 5%. Paid tasks 2.5% on top, paid by the payer. No rebates of any kind.

**The exit right after a market**, as built: any free Share can be handed back for its slice of the floor.

### Fixes for the measured weaknesses

| Weakness | Fix | Basis |
|---|---|---|
| Founder bids in their own sale (M3: a ladder reached 256 times) | Absolute cap: no bid above 4 times the starting price. A backer knows the worst price before bidding | measured problem; fix judgement, about 5 lines in MinBid plus one fill test |
| Self-bidding called "25 of each 100 gone for good" | Not true: bought Shares can be sold back into the pool. Real loss about 7 to 15 of each 100. **Accepted and restated**: a founder can buy past the minimum; what they buy is a real pool holding their own money | simulated (attacker); must be re-measured |
| Exit in pieces (M2: 80% holder got 4,670.84 instead of 4,560.00) | The fee's 4 goes to the project's spendable money: 400 pieces pay 4,560.00, the same as one | simulated to the cent |
| Gifts through fresh wallets (M2: 15.3% of a 100,000 revenue floor) | Before a market: zero, gifts are held. After: revenue in the floor is shared by all Shares that exist, and the 1% monthly gift cap is measured on Shares in people's hands. Other holders' claim per Share no longer falls | simulated |
| Bear run | Accepted; it is backers taking unspent money back. Half leaving on day 45: a backing round keeps 67.4% of what was raised; a 100,000 auction keeps 54.3% and its 22,000 pool | simulated |
| Thin pools (M3: 880 and 2,200 dollars) | No pool under 22,000 dollars; depth shown beside the price | simulated |
| Sealed reserve (M3) | The rewritten Launcher gets a reserve sale: plain auction, starting at the last sale's end price, 28 days apart, 3 / 15 / 82 into the floor, no pool step. Council approves; at Open holders vote | judgement |
| Stop vote backers cannot win | Before a market: the refund. After: when parked Shares reach a third of free Shares, payments pause 24 hours later for as long as they stay parked. Nobody votes no | simulated (ladder); threshold judgement |

### Worked examples (simulated)

- **2,500, Solo to Backed.** 7.5M Shares (0.75%). Platform 75. Project gets 375 at once and 79 a week: 690 after
  four weeks, 1,400 at week 13, 2,425 at week 26. A backer of 100 can take back 77.90 on day 0, 58.60 on day 45.
- **10,000, the Backed cap.** 30M Shares (3%). Platform 300. 1,500 at once, 315 a week: 2,762 after four weeks,
  9,700 at week 26.
- **50,000, Team.** 10,000 alone, then a second person, then a 40,000 round opened by both: 120M Shares, platform
  1,200, 6,000 at once (two touches), 1,262 a week. 150M Shares (15%) sold in all.
- **100,000, the auction at its minimum.** Platform 3,000. Pool 22,000 with 55M Shares, locked for good. 15,000 at
  once, 60,000 over 12 months (1,154 a week). Creaton receives 20M held Shares. The first election follows.

## 5. The platform and CREATE

**Founder's line:** "Creaton takes 3% of the money, and 2% of the Shares if you open a market."

**Income (simulated).** Assumptions, bear / good: backing rounds 200 at 3,000 / 1,800 at 5,000; auctions 1 at 100,000
/ 100 at 150,000; pool turnover 10 / 40 times pool dollars a year, half of trades are buys; 25% / 10% of refundable
money handed back; paid tasks 100,000 / 2,000,000; paying AI manager users 20 / 300 at 10 dollars a month.

| | Bear year | Good year |
|---|---|---|
| Money raised | 700,000 | 24,000,000 |
| Raise fee 3% | 21,000 | 720,000 |
| Pool trades | 550 | 330,000 |
| Hand-backs | 1,380 | 16,380 |
| Paid tasks | 2,500 | 50,000 |
| AI manager | 2,400 | 36,000 |
| **Total** | **27,830** | **1,152,380** |

With no auction at all the bear year is 24,130. The first plan's 50,000 was too high. Every volume figure is a guess;
no stranger has used the product.

**The accelerator stake.** 20,000,000 Shares (2%) from the reserve, granted the moment a market opens, held and
released like everyone's. A project that never opens a market gives nothing. Paper value at the auction's minimum:
8,000 dollars a project (judgement; it is not money until sold, and most will never be). Creaton promises in public
never to hand stake Shares back at a project's floor. The contract that sells stakes slowly is parked; nothing can
move for a year anyway. Outside knowledge: Y Combinator takes 7% and pays 125,000 dollars for it
(`docs/v3-review/CREATE-BILLION-REVIEW.md`); Creaton pays nothing, so it takes little and late.

**Where fees go.** As agreed: half into CREATE's permanent floor, half spendable. No splitter contract.

**CREATE** is project zero on the same price, caps and auction as everyone, with no special route. Holders get one
right (hand back against a floor made of fee dollars) and three decisions once holder votes exist: which projects
Creaton backs each season, defaults for new projects inside fixed limits (raise fee 0 to 5%, stake 0 to 3%, never
changed for existing projects), and pausing payments to Creaton itself. A published promise, not code: CREATE does not
open on a real network until 25 outside projects have raised there and kept the money 90 days, 2,500 dollars of fees
arrived in 90 days, and the audit is done.

**Seasons, demo day, matching.** A new six-week group starts every six weeks; open entry; demo day is a batch of
backing rounds opening the same day. Server and app only. There is **no matching pot contract**: a formula match can
be farmed with one's own money, and in a bear year the pot would be about 1,000 dollars a season (simulated). Instead
Creaton backs chosen projects on demo day as an ordinary backer from its spendable half: same price, same split, same
refund. The owner chooses at first, CREATE holders later.

**Does it pay for a team? No, not in a bear year.** About 14,000 dollars of spendable money against about 6,000 of
running costs (simulated), with no wage and no audit. One modest wage plus servers (72,000 a year) needs roughly 3 to
3.6 million raised a year; a team of four roughly 25 to 30 million (simulated). The audit must be paid from outside.

## 6. The app

**A new thin web app** in a new folder beside `web/`, same stack: React 19, TypeScript, Vite, TanStack Router and
Query, Tailwind 4, Radix, plus viem for contract calls generated from the contract build. Installable on a phone (home
screen icon, full-screen, works at phone width first). **Carried over:** the shared package `packages/creaton-core`,
the passkey and account code, record signing. The old `web/` stays as it is until the new one covers its journeys.

**Five screens.** Home (projects shipping now, open rounds on top, the season). Project (record, stage line, Back box,
then Updates, Tasks, People, Money). Start. This week (the founder's ten minutes). You (backing receipts, Shares held
and free, refunds).

**Press and field budgets, each held by a test.** Start 3 and 3. Open backing 1 and 0. Back 2 and 1. Take money back 2
and 0. Weekly update with check-in 2 and 1. Give Shares 4 and 0. Add a second person 2 and 0. Post a task 2 and 2.
Accept and pay 1. Join 4 and 1 for a new person (measured, milestone 0). Bid, Buy, Sell, Hand back 2 and 1.

**What the page must say.** The refund as a receipt ("paid 100, can still take back 53.90"), never as a property of a
Share. Before an auction: how many Shares are already held, by how many accounts, at what price, and when they
release. The pool's depth beside the price. The floor as a melting line. Home is never sorted by money raised.

**Design direction.** Keep the colour scheme. New type and buttons, chosen by the owner from an options page being
prepared separately.

**AI manager and project brain** (full text: `docs/MANAGEMENT-LAYER.md` sections 5 and 9).
1. The manager reads the project brief and the founder's answers, and drafts; a person signs.
2. It never moves money, touches Shares, confirms work, or talks about price or returns.
3. Each project gets a folder of plain files (facts, voice, decisions, playbooks) that agents read first.
4. Free while the founder posts the weekly update; the hosted allowance starts when the first round closes; heavy use
   needs the founder's own key.
5. Platform spend on it is capped on the server at 10% of the last 90 days' fees.

## 7. Contracts

Sizes are (estimate) lines of code. Built today: 2,289 lines in `contracts/next/src` (counted).

**Kept unchanged:** ShareToken, RollingCap, LiquidityHolder, PoolGuard, FixedFeeController, Pinned (the pool's 22
stays), HookSalt, and the Finisher's three-step finish and abandon path.

**Changed**

| Contract | Change | Size |
|---|---|---|
| Launcher (replaced again; it must be, for the sealed reserve) | open a backing round inside the stage cap; allow the auction only for a Team runner; the one auction size; Shares for sale released when a round or sale opens; the stake grant at pool open; "no market"; the reserve sale | +200 |
| Treasury | the fee's 4 to spendable; revenue floor shared by all Shares; gift cap on Shares in hands; check-in by the runner only; the runner can be handed over; a pause hook; wind down | +80 |
| Vester | grants for backers, cancelled on refund; trim a departing founder's grant | +40 |
| MinBid | the absolute cap | +5 |

**New**

| Contract | Job | Size |
|---|---|---|
| Rounds (one small copy per project) | take asks for 24 hours, scale back, deliver held Shares, hold each round's money, release it weekly inside the check-in window, personal refund | 300 |
| Pair | the Team runner: two signers, 500 a week alone | 100 |
| Tasks | money set aside per task, pay on accept, refund after the deadline | 200 |
| HolderVote | park free Shares; pause at a third; seat election; replace vote | 250 |
| Council | the Council runner: five seats, 3 of 5, the budget | 150 |

About 1,300 new lines (estimate), all joining the outside review. The Treasury gains one seam instead of five stages:
the **runner** is an address (founder, then Pair, then Council), and the Launcher checks which kind before a raise.

**Parked:** the stake-selling contract, any matching pot, any fee splitter, a second auction size, "Share revenue"
for ordinary projects (kept for project zero only, pending counsel).

**Must be re-run before anything real:** the M3 closing-window attack table and the whole-sale fuzz at the new size;
a sale where demand at the cap is ten times supply; self-bidding followed by selling into the pool; a minimum equal
to the full sale at the starting price.

## 8. Server and records

**Milestone 0 built:** open sign-up, the join link (ask to join, accept, decline, with its limits), public project
pages, and settings served by the server.

**The chain reader must index**, into tables that survive a chain rollback, then sign one "project numbers" record
per project:
- Launcher: project created, runner kind (the stage), round opened, sale opened, "no market", reserve sale.
- Rounds: asks, lowered asks, close with the scale-back percent, Shares delivered, weekly releases, refunds.
- Vester: grants, cancels, clock start, claims.
- Treasury: settled, released, check-in, exit, Shares given, spent, paused, handed over, wound down.
- Auction and pool: bids, `Finisher.PoolOpened` and `Settled` (always present; `PoolStep` may be missing, measured
  M3), abandon, pool trades, LiquidityHolder fees.
- Later: HolderVote and Council.

The server derives what the chain cannot: total raised against the cap, "eligible since", "quiet since", refund per
100 for each receipt, held and free Shares per account. Browser-posted copies of any of this are refused. The helper
job closes rounds, delivers Shares, finishes sales and collects fees; every call is one anyone may make.

## 9. Build order

**All NOT STARTED. Nothing is built until the owner says go.** Sizes are (estimate) for one experienced builder; each
runs on Sepolia.

| # | Milestone | Size | Proves | Tested by |
|---|---|---|---|---|
| 4 | Money-rule changes: Rounds, Launcher rewrite, Treasury, Vester and MinBid changes | 3 weeks | The backing round, the refund, the hold and the fixed rules behave as written | Unit and fuzz tests; attack tests: self-filled rounds, fake demand, refund after the market; the re-runs listed in section 7 |
| 5 | Server: chain reader, project numbers, helper job | 4 to 6 weeks | A visitor sees live numbers; Shares and refunds arrive with nobody pressing | Server tests, real-server loop on a local chain |
| 6 | New web app: shell, passkey, Start, Project, Back and refund, This week, installable | 4 to 5 weeks | The budgets in section 6 hold on a phone | Real journeys with press budgets; a human on a phone |
| 7 | Team and the auction in the app: Pair, hand over, wind down, bid, finish, trade, hand back | 3 weeks | 10,000 alone to 50,000 with a second person to a market | Fork tests, journeys |
| 8 | Tasks, agent caps, AI manager, project brain | 3 weeks | An agent runs a week unattended; a stranger is paid on accept | Unit tests, real-server loop, the planted-record check |
| 9 | HolderVote, Council, reserve sale | 3 weeks | Auction buyers elect seats; a third parked pauses payments | Unit tests; attack tests: a late large buyer, a founder with many accounts |
| 10 | Seasons, demo day, Creaton backing projects, CREATE as project zero | 2 to 3 weeks | Fees show as CREATE's floor; a season runs end to end | A week-long public test |

In parallel: 5 beside 4 once the events are agreed; 6 beside 5; 8 beside 7; the design options page any time. About
five to six months in all (estimate).

## 10. Off until an outside audit and counsel, and what could still go wrong

**Off until an outside review:** any real network; real dollars; CREATE as a real token; the auction on a real
network before the Council runner exists; reserve sales; the stake; sponsored fees without the global cap.

**For counsel before any real network**
- **The Uniswap licence is not cleared.** The strategy includes two BUSL-1.1 files (`Pool.sol`, `Position.sol`,
  change date 2027-06-15), found in the milestone 1 review.
- **The legal line** in the app reads: "Buyers acquire ownership only: governance and exit. No dividends or revenue
  share, ever, unless they contribute and earn one." This plan does not reword it. Four things here sit in tension
  with it: (a) a refundable fixed-price round with held Shares reads like a deposit; (b) CREATE's floor is fed by fees
  on other people's raises; (c) Creaton holding 2% of projects makes CREATE look like a fund; (d) a wind-down splits
  what is left among holders.

**What could still go wrong**
- Older Shares outweigh the pool. 350M held Shares release over a year into a pool holding 55M. The hold makes it
  slow and visible; it does not stop it.
- A founder can buy past the 100,000 minimum for a loss of about 7 to 15 of each 100 (simulated).
- Free accounts beat every head count. The plan relies on rules that cost real dollars.
- A backer whose project never opens a market holds Shares that cannot move for at least a year.
- Check-ins are self-reported. A junk update keeps money flowing; the answer is each backer's own refund.
- One price for every project is a convention. If 3,000 Shares a dollar is wrong, nobody backs or every round is
  scaled back. No demand has been measured.
- Nothing between 50,000 and 100,000 can be raised in one step.
- After a year the founder side's released Shares can outweigh auction buyers in a pause or a vote. By then the floor
  is nearly paid out.
- Which network is undecided. Starting a project and opening a sale is 5,262,795 gas (measured, M3); a backing
  round's gas is not measured.
- A freezable dollar token or fee address stops every project at once (measured, M3 fix round).
- The auction model in the simulations is simplified; the closing-window attack was not re-run.

## 11. Decisions for the owner

"Yes to all" is a valid answer.

1. **Hold Shares bought before a market** on the same 12-month release as the founder's, starting when the market
   opens. This changes "never locked" for backing-round Shares only. Recommended: yes. The other choice is to accept
   and show it, at a simulated cost of about 45% of honest auction money (attacker's 50,000 example) to a founder who filled their own rounds.
2. **The backing round:** one price (3,000 Shares a dollar), 3 / 15 / 82 over 26 weeks, personal refund at a 5% fee,
   caps of 10,000 alone and 50,000 with a second person. This changes "60 over 12 months" for small raises.
   Recommended: yes.
3. **One auction:** minimum 100,000, your 3 / 22 / 15 / 60 unchanged, bids capped at 4 times the starting price, no
   market below that size. Recommended: yes.
4. **Four rule changes as a bundle:** the exit fee's 4 goes to the project; revenue in the floor is shared by all
   Shares and the gift cap is measured on Shares in hands; the Stop vote becomes the refund before a market and "park
   a third" after it; a person sends the check-in. Recommended: yes.
5. **Platform:** 3% of the money plus 2% of the Shares only if a market opens; fees half floor, half spendable as
   agreed; no matching pot, Creaton backs projects as an ordinary backer; CREATE waits for the gate in section 5.
   Recommended: yes, with counsel reading section 10 before any real network.
6. **Build shape:** a new thin web app beside the old one; all five stages in the plan, with the Council contracts
   built at milestone 9 and required before any auction on a real network. Recommended: yes, then say go.
7. **Founder-set prices** (added 17 November 2026; full design: `docs/next-version/FOUNDER-PRICE.md`). The owner asked
   for founders to set the price, because Creaton raised at 6 million and will be project zero. Recommended: yes. Each
   backing round gets its own price for the whole project, from 333,333 to 50,000,000. The price is fixed when the round
   opens. The box is pre-filled (333,333 for a first round, then the last price), so a solo founder presses nothing extra.
   Raising the price is one tap (+25% / +50% / x2) with a "what's new" note built from the weekly updates. Prices may also
   go down; the page shows a warning. The caps stay in dollars. The auction always offers all 250M Shares, the runner picks
   its starting price (at least 0.0004), and the minimum is what all 250M raise at that price, so a default project keeps
   exactly 100,000. Creaton opens its rounds at 6,000,000. Its earlier backers get work-pot Shares at the price they paid,
   held on the same 365-day clock. This replaces "one price for every project, typed by nobody" in sections 4, 5 and 10.

## What I verified for this plan

Read in the reports and code; nothing was built or run except the simulations.

1. The 3 / 22 / 15 / 60 split was measured exact on a 20,358.36-dollar sale, and a 100-dollar buy moves the built
   pools 9.2% and 23.7% (`NEXT-VERSION-PLAN.md`, milestone 3 findings; `M3-REPORT.md`).
2. Exit in pieces: 4,670.84 against 4,560.00 for a holder of 80% (`M2-REPORT.md`, finding B2).
3. Gifts through fresh wallets: 100,000 to 84,728, minus 15.3% (`M2-REPORT.md`, finding B3).
4. M3's self-bid table calls the platform and pool share "not recoverable" and reports the 256-times ladder; the
   reserve cannot leave the built Launcher (`M3-REPORT.md`, self-bid section and point 5).
5. Gifts before the pool go to the Vester, the floor leaves out Shares the Treasury holds and unreleased Shares, and
   abandon starts the Vester clock (`contracts/next/src/Treasury.sol`, lines 218-220, 387-392, 457-458).
6. The BUSL-1.1 files and their change date (`NEXT-VERSION-PLAN.md`, milestone 1 review fixes).

Simulations (plain Python, standard library), all under
`docs/next-version/econ/`: `plan_v2.py` (this
plan's own numbers), and the designers' and attacker's `econ.py`, `platform_create.py`, `stage_ladder.py`,
`attacker.py`. Copied into the repo on 17 November 2026.

## Milestone 4 findings (17 November 2026)

Milestone 4 built sections 4 and 7's money rules in `contracts/next` (report: `docs/next-version/PLANV2-M4-REPORT.md`).
Where building and measuring showed this plan to be wrong or loose:

1. **Self-bidding is not "a real loss of about 7 to 15 of each 100".** Measured on the real Uniswap stack next to 100,000
   of honest demand, a founder's second account that bids 50,000 / 100,000 / 300,000 and sells everything into the pool
   gets back 39.6 / 30.5 / 22.6 of each 100 from the pool at once, and the project receives 75 of each 100 (15 at once, 60
   into the floor). So the loss at once is 45 to 62 of each 100; but if no holder hands back and the whole floor melts to
   the runner over a year, the founder side ends 14.6 / 5.5 of each 100 **ahead** at the two smaller sizes (2.4 behind at
   the largest). The protection is the holders' hand-back against the floor during that year, not the cost.
2. **The day-45 refund is 58.64 of each 100, not 58.60** (82 x 137/182 x 0.95 = 58.639).
3. **The auction's floor releases 1,150.68 a week, not 1,154**: the release runs per second over 365 days; the plan divided
   by 52 weeks.
4. **Fake demand can use up a project's whole cap.** Refunds do not reopen the cap (otherwise a founder could raise, take
   the money back through second accounts and raise again without limit). So an outsider who asks far more than the cap and
   keeps the ask past the 12th hour, then takes the money back, uses up a Solo project's 10,000 for about 22.1 of each 100
   accepted (2,210 dollars), and honest backers get the same small percent. Owner decision.
5. **The 1% gift cap measured on Shares in hands compounds slightly**: gifts count once given, so within 30 days the gifts
   can reach 1/99 of the Shares in hands before them (1.0101%), and the cap grows as held Shares release.
6. **The Council requirement (D230) and the first election contradict each other on a real network.** The auction needs a
   Council runner there, but the plan elects the Council's seats from auction buyers after the market opens. As built, no
   project can open the auction on a real network until milestone 9 says how a Council exists before a market.
7. **A founder leaving after the market is not trimmed.** The trim ("days served out of 365") is built for before a market
   only; after it the founder's grant is already on the market clock and a trim would have to undo released Shares.
   Milestone 9 (Council) should decide.
8. **Not built here, by scope:** the Team rule "after 28 silent days the second signer takes over", and "agents included" in
   the 500 a week (each signer has 500 a week; agents keep the Treasury's own daily caps).

## Milestone 4 review fixes (17 November 2026)

A review and an attack test of milestone 4 found the following; details in `docs/next-version/PLANV2-M4-REPORT.md`, section
"Review fixes".

1. **Fixed: a stranger could end a backer's refund** by taking their released held Shares out for them after the market (the
   money behind them then went to the project). Only the backer may take out their own held Shares now. The server's helper job
   must not deliver held Shares; it can still deliver founder, gift and stake Shares.
2. **Fixed: a later runner could cut the founder's grant** with a hand-over marked "founder leaves". Only the founder may mark
   it, in person or through a Pair they sign for.
3. **Correction to finding 4 above:** the faker's cost is 22.1 of each 100 *the faker had accepted*: 2,077 dollars when the
   honest backers hold 6% of the 10,000 cap (measured), at most 2,210 if the faker holds all of it.
4. **Owner decision: money stranded by a wind-down.** After a wind-down the release stops and the refund covers only Shares
   still held, so the unreleased money behind Shares a backer already took out belongs to nobody and stays in the round for
   ever (measured: 152.29 dollars on a 1,000 backing whose backer took out a fifth after "no market"). Section 3 says payments
   stop for good and section 4 that Shares taken out end the refund, so neither side is owed it. Choose: pay it to the
   project at the wind-down, or put it into the floor for holders to hand back against.
5. **Still open for the owner** (unchanged, now with tests pinning today's numbers): fake demand using up a cap (finding 4);
   D230 against the first election (finding 6); the Team takeover after 28 silent days and "agents included" in the 500 a
   week (finding 8; measured: one signer's key and three default agents spend 950 in 7 days). Team in the app is milestone 7.
