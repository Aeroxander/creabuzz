# Plan version 2, milestone 4: the money rules

Written 17 November 2026 on branch `v4-governance-rework`, for the owner. The plan is `docs/PLAN-V2.md` (decisions D224 to
D230); this milestone is its section 9 row 4: Rounds, the Launcher rewrite, and the Treasury, Vester and MinBid changes. The
code is in `contracts/next/src`, the tests in `contracts/next/test`. **Nothing is deployed anywhere, no key was held, nothing
was pushed.**

## The short answer

**Built and tested: backing rounds with the personal refund, the one clock for held Shares, the Team runner (Pair), the
stage caps, the one auction with the absolute bid cap, Creaton's stake, "no market", wind down, the pause hook and the
reserve sale.** Every M2 and M3 guarantee still holds except where plan version 2 changed the rule on purpose (the exit fee's 4, Share
revenue, the gift cap, check-in by agents, the relative bid cap); their tests were re-run at the new sizes, and the B2 and B3
pins were turned round to prove the fixes. The fuzz found one real defect on the way (a refund could pay a raw unit the project had already
been paid; fixed, below). Several things the plan said turned out wrong or loose (section "What the plan got wrong"); the
biggest: **a founder bidding in their own
auction and selling into the pool does not lose "7 to 15 of each 100"**; the loss is 45 to 62 at once, but if no holder
hands back and the floor melts to the runner over a year, the founder side ends a few percent ahead (section "Re-runs").

**Gates, as run on 17 November 2026** (Foundry 1.4.3, one forge process at a time):

| Gate | Result |
|---|---|
| `forge build` | passes. `forge build --sizes` exits 1 for one contract only, the milestone 1 test helper `Deployer` (111,684 bytes; unchanged and known since milestone 1). Every `src` contract and every test contract is under both limits: Launcher 19,236 runtime / 35,075 creation, Treasury 13,918 / 13,963, Rounds 8,641 / 8,685, Finisher 7,857 / 8,278, Vester 3,643 / 3,687, Pair 2,839 / 2,883, Parts 437 / 33,073, MinBid 1,591 / 1,795 |
| Local suite, no RPC (`forge test`) | **437 passed, 0 failed, 35 skipped** in 102 suites (the 35 are the Sepolia fork twins, which skip with a message without an RPC) |
| Sepolia fork suite, once (`SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test --match-contract Fork`) | **136 passed, 0 failed, 0 skipped** in 35 suites at fork block 12,156,614, including `AuctionV2ForkTest` (6) and every milestone 1 and 3 fork twin. Run once |
| Fuzz | default 1,000 runs; set per test: the whole-sale fuzz 2,000; the split under spikes and gifts 1,000; the M2 money fuzzes 2,000 to 3,000; the rounds' two fuzzes 1,000 each |
| Invariants | 256 runs of depth 200 (51,200 calls) for each of the 7 new rounds invariants, the 15 Treasury invariants and the 9 sale invariants. The first full run of the new rounds invariants failed once, on the handler's own bound (it assumed the 5% refund fee after a wind-down, where the rule is the platform's 1%); I fixed the handler, and the suite then passed 256 runs and the full suite above passed |
| `forge fmt --check src test script` | clean |
| Guard removals (`python3 scripts/mutate-guards.py --m4`) | **108 milestone 4 guards removed one at a time: every one fails at least one test.** In the first pass 10 failed none (N36, N40, N41, N43, N44, N59, N71, N72, N74, N76); I wrote tests for them (`RoundsReentry.t.sol`, `VesterHeld.t.sol`, `TreasurySeams.t.sol`, and `AuctionV2.t.sol` added to two suites) and re-ran those 10: each fails now. The 29 milestone 2 and 3 entries whose code moved (T06, T08, T11-T14, T19, T23, T26-T28, T38, T43, T45, T46, T49, V03, V09-V11, V13, A11, A12, A14, A17, A20, A26, A29, A30) were rewritten to the new text and re-run: each fails at least one test. A27 and A28 (the Small and Large sizes) were removed with the sizes. The other milestone 1 to 3 entries were not re-run in this milestone |
| `git diff --stat` since the plan's commit | 54 files, all under `contracts/next/` and `docs/` |

## What exists

| Contract | Job | Lines (file / code) | Plan |
|---|---|---|---|
| `Rounds` (new, one clone per project) | 24-hour backing rounds at 3,000 Shares a dollar, scale-back, 3 / 15 / 82, the 26-week release on the check-in window, personal refund | 443 / 285 | 300 |
| `Pair` (new, one clone per Team project) | Two signers: 500 dollars a week each alone, both for everything else; check-in by either | 132 / 78 | 100 |
| `Parts` (new, one per network) | Makes the five implementations the clones copy (the Launcher's creation code could not hold them) | 33 / 18 | none |
| `Launcher` (rewritten) | Birth 20/20/15/25/10/10; stage caps; the one auction; the stake; "no market"; wind down; the reserve sale; the Council seam | 814 / 554 (was 473 / 327) | +200 |
| `Treasury` (changed) | Runner seat and hand-over; check-in by the runner only; the fee's 4 to spendable; revenue by all Shares; gift cap on Shares in hands; pause; wind down; no market; the stake; reserve-sale money | 709 / 454 (was 336 code) | +80 |
| `Vester` (changed) | Backer grants per round (cancel on refund), the founder's trim, the one clock | 259 / 153 (was 77 code) | +40 |
| `MinBid` (changed) | The cap is 4 times the auction's floor price, not the current clearing price | 74 / 34 (one line changed) | +5 |
| `Pinned`, `Interfaces`, `Finisher` | The auction sells 250M (one constant); four auction functions and the factory's `create` pinned; new interfaces; Finisher doc text | | |

`contracts/next/src` is 3,603 lines (2,289 before). Kept unchanged: ShareToken, RollingCap, LiquidityHolder, PoolGuard,
FixedFeeController, HookSalt and the Finisher's code.

## The rules, where they live, and the test that fails without them

"Guard" is the id in `contracts/next/scripts/mutate-guards.py`: the script removes that one check, runs the named suites, and
records which tests fail (section "Guard removals").

### The backing round (`Rounds`)

| Rule (PLAN-V2 section 4) | Exact integer rule as built | Tests | Guards |
|---|---|---|---|
| One price for every project | 1 raw dollar unit buys `SHARES_PER_RAW_DOLLAR` = 3e15 raw Share units: 1 dollar = 3,000 Shares; 50,000 dollars = exactly the 150M backing Shares | `test_price_oneDollarBuysExactly3000Shares_and50000BuysTheWholeBudget`, worked examples | N19 |
| Size = what is left under the stage cap; smallest backing 1 dollar | The Launcher opens a round of `cap - raised`; Rounds refuses a size under 1 dollar or one the unsold Shares cannot cover, and a second round while one is open; a backer's total ask in a round must be at least 1 dollar | `test_open_*`, `test_ask_*`, `test_solo_capIs10000InTotal_andRoundsFollowWithNoWait`, `test_team_capIs50000InTotal` | N01, N02, N03, N05, N82, N83 |
| 24 hours; lower or withdraw only in the first 12 | `ask` until `openedAt + 24h`; `lower` (to zero or to 1 dollar and more) until `openedAt + 12h`; the amount can only grow after that | `test_ask_*`, `test_lower_*`, `test_attack_fakeDemandForcesAScaleBack_measured` | N04, N07, N08 |
| Scale-back: the same percent for everyone | Close (anyone, after 24 hours, once): `accepted = min(asked, size)`. Settle (anyone, per backer): `acc = ask * accepted / asked` rounded down, the rest of the ask returned. The rounding dust (under one raw dollar unit per backer) is accepted money nobody holds Shares for; it is split like the rest, so it ends with the platform (3) and the project (97). | `test_settle_scaleBack_everyAskTheSamePercent_restReturned`, fuzz | N09, N10, N11, N13, N14, N15 |
| Each 100: 3 platform, 15 at once, 82 over 26 weeks | `toPlatform = acc*300/10000`, `held = acc*8200/10000` (both rounded down), `toProject = acc - toPlatform - held` (15 plus the dust) to `spendable` at once | `test_settle_splits3_15_82_andHoldsTheSharesInTheVester`, worked examples | N16, N17 |
| Released evenly over 26 weeks while checked in | One shared clock of active seconds: time counts only up to `treasury.activeEnd()` (the last check-in + 14 days; zero while paused or wound down). A round's release is `held * min(active since its close, 182 days) / 182 days`, rounded down. A lapse pushes the end date out by exactly the lapse and is never paid back (the built Treasury's rule); the Treasury works the clock out before every change of the window (check-in, pause, resume, wind down, the auction's first money) | `test_release_evenlyOver26WeeksWhileCheckedIn`, `test_release_aLapsePushesTheEndDateOutAndIsNeverPaidBack`, `test_release_pausedTimeDoesNotCount`, `test_theAuctionsFirstMoneyDoesNotPayTheRoundsForALapse`, `testFuzz_theReleaseDoesNotDependOnHowOftenItIsAsked` | N20, N21, N22, N51, N76 |
| Bought Shares are held (one clock) | At settle the Shares go to the Vester as a backer grant of that round (`grantHeld`); released over 365 days from the market or a "no market" declaration, claimable with `claimHeld` | `test_settle_splits...`, `test_attack_aFounderFillsTheirOwnRoundsThroughManyAccounts_andCannotSellBeforeRelease` | N18, N40, N48 |
| Personal refund, per round | `refund(round)`: the backer's own held money for the Shares still held for them (`part = held * stillHeld / granted`), less its released part (rounded UP), less a 5% fee rounded up (1 of each 100 to the platform rounded down, the rest of the fee to `spendable`); the Shares still held are cancelled into the reserve. Per 100 paid: 77.90 on day 0, 65.92 at week 4, 38.95 at week 13, nothing at week 26 | `test_refund_thePlansNumbers`, `test_refund_theFeeIs...`, `test_refund_nobodyElseLeavingChangesYourNumber`, fuzz, invariants | N23, N24, N25, N26, N28, N29, N30, N41, N42, N43, N44 |
| After a market the refund continues for Shares still held | Shares the backer took out (`claimHeld`) end the refund for their share of the money; that money keeps releasing to the project | `test_refund_afterTheMarket_onlyForSharesStillHeld`, `test_attack_aRefundAfterTheMarketTakesNothingFromTheFloor` | N27 |
| Refunds do not reopen the cap | `raised` counts every accepted dollar ever (my choice; see "Numbers I chose") | `test_solo_capIs...`, `test_attack_refundThenReAskGainsNothing` | N12 |
| Wind down | Releases stop for good; the refund fee becomes the platform's 1 | `test_windDown_releaseStopsForGood_andTheRefundFeeIsThePlatformsOne` | N31, N32, N60, N61 |
| Unsold backing Shares join the reserve | `returnUnsold` (anyone) once no round can open (market, "no market", wind-down); Shares owed to unsettled accepted asks stay | `test_returnUnsold_onlyOnceNoRoundCanOpen_andKeepsWhatIsOwed` | N33, N34 |

### Vester, Treasury and the runner seat

| Rule | As built | Tests | Guards |
|---|---|---|---|
| One clock for held Shares | Everything handed out before a market (founder, gifts, backers, the stake) is in the Vester; `start` is set when the Finisher proves the pool or when "no market" is declared | `test_noMarket_*`, `test_stake_*`, M2 Vester tests | V01-V13, N64 |
| A leaving founder keeps the days served | `handOver(next, true)` then `takeSeat()`: the founder keeps `200M * min(days since launch, 365) / 365`, the rest returns to the work pot; before a market only (refused after it) | `test_handOver_aLeavingFounderKeepsTheDaysServed_theRestReturnsToTheWorkPot`, `test_handOver_aTrimAfterTheMarketIsRefused_andTheSeatStaysPut`, `test_trim_onlyTheTreasury` | N45, N46, N47, N55 |
| The fee's 4 goes to spendable (B2) | The whole slice leaves the floor: 95 to the holder, 1 owed to the platform, 4 to `spendable` | `test_fixed_exitingInPiecesPaysTheSameAsOneExit` (400 pieces pay 4,560.00 less rounding, as one exit does), `test_edge_exitingInManyPiecesPaysWhatOneExitPays`, `test_handBack_workedExample` | T45, T13, T14 |
| Share revenue is shared by all Shares; the gift cap is on Shares in hands (B3) | `slice = melting * burned / countingSupply + permanentFloor * burned / totalSupply`; the 30-day gift cap is 1% of `countingSupply()` | `test_fixed_postPoolGiftsToFreshWalletsNeverThinTheRevenueFloor`, `test_fixed_giftsThroughFreshWalletsTakeUnderATenthOfTheRevenueFloor`, `test_handBack_takesFromBothFloorsInProportion` | N67, N68, T23, T38 |
| Held Shares never count | `countingSupply = totalSupply - Treasury - Rounds - Finisher - vester.unreleased()` | `invariant_heldSharesNeverCount`, `invariant_rule3_*`, `test_attack_aFounderFills...` (zero counting before a market) | T10, T11, N69, N70 |
| Check-in by the runner only | `checkIn` requires `msg.sender == runner`; a Pair's either signer checks in through the Pair; agents may not | `test_checkIn_onlyTheRunner_notAnAgent`, `test_agents_cannotCheckIn_andAHandOverSwitchesThemOff`, `test_checkIn_eitherSigner_notAStranger_notTheFounderDirectly` | T19 |
| The runner seat | `runner` (the founder at birth); `handOver(next, founderLeaves)` by the runner, `takeSeat()` by `next`; a hand-over switches off every agent the old runner set | `test_handOver_twoSteps_onlyTheRunnerOffers_onlyTheNamedTakes`, `test_agents_...` | N52, N53, N54, N77, N78, T27, T28 |
| Pause hook | `setPauser` only through the Launcher's council maker; `setPaused` only by the pauser; paused time never counts (melting floor and rounds) | `test_release_pausedTimeDoesNotCount`, `test_release_aPauserMustBeNamedAndOnlyTheCouncilMakerNamesIt` | N56, N57, N58, N98 |
| Wind down (minimal safe rule) | Only through the Launcher: the runner before a market (and after "no market" or an abandoned sale), only a Council runner after a market; never while a round is open or the auction runs. Payments stop for good (melting floor and rounds); the exit fee drops to the platform's 1; backers keep refunding at 1; the floor stays for holders; `spendable` stays the runner's | `test_windDown_theRunnerBeforeAMarket_onlyACouncilAfter`, `test_windDown_notWhileARoundIsOpen`, `test_windDown_releaseStops...` | N59, N60, N61, N62, N92 |
| The stake | When the Finisher proves the pool, 20M Shares (or the reserve, if ever smaller) go from the reserve into the Vester as a held grant to the stake address; nothing with "no market" | `test_stake_20MHeldSharesFromTheReserveWhenTheMarketOpens`, `test_worked_100000_theAuctionAtItsMinimum`, `test_noMarket_*` | N65, NA0 |

### Team (`Pair`) and the stages (`Launcher`)

| Rule | As built | Tests | Guards |
|---|---|---|---|
| Becoming Team: two transactions, no wait | The founder offers the seat to `pairAddress(key, founder, second)`; the second signer calls `makePair(key, founder)`, which makes the clone and takes the seat | `test_makePair_*` | N99, NP6, NP7 |
| 500 a week alone, per signer | `RollingCap` per signer: 500 dollars in any 7 days (counted 7 to 8 days) | `test_spendAlone_upTo500InAny7Days_perSigner`, `test_spendAlone_501InAWeekIsRefused_evenInPieces` | NP0, NP5 |
| Both for more, raises and goal changes | `propose(target, data)` then the other signer's `confirm`; targets only the Treasury and the Launcher; the Launcher answers only the runner, so a signer alone cannot raise | `test_bothSigners_spendMore`, `test_aRaiseNeedsBoth_*`, `test_propose_*`, `test_confirm_*` | NP1, NP2, NP3, NP4, NP8, N80 |
| Caps: 10,000 alone, 50,000 with a Pair | `capOf(runner)`; total accepted money ever | `test_solo_*`, `test_team_*`, invariants | N81, N82, N83 |
| No rounds after a market | `openRound` refused once the pool opened, "no market" was declared, the project wound down, or while the auction runs | `test_openRound_onlyTheRunner_neverAfterAMarketOrAWindDown` | N84 |
| The auction only for a Pair (Council on a real network) | `openAuction` refuses a single runner; with `requireCouncilForAuction` (true on every chain but 31337 and 11155111, set in the constructor) only a Council | `test_openAuction_aSingleFounderCannot`, `test_requireCouncilForAuction_*`, `test_onARealNetworkOnlyACouncilOpensTheAuction` | N85, N86, N87, N88 |
| The one auction | 250M Shares, starting price the tick-rounded 0.0004 dollars, minimum 100,000, bids 1 dollar to 4 times the starting price, closing window 720 blocks, 3 / 22 / 15 / 60 through the Finisher | `test_openAuction_fillsInEverySetting`, `test_openAuction_theMinimumIsTheMinimum`, `test_minimumIsTheWholeSale_*`, `test_worked_100000_*` | A26, A29, A30, NB0 |
| Absolute bid cap (MinBid) | `limit = auction.floorPrice() * 4` | `test_fixed_aLadderOfBidsCannotPassFourTimesTheStartingPrice` (and the fill test inside it), `test_minBid_theLimitDoesNotMoveWithTheMarket`, `test_demandAtTheCapTenTimesTheSupply` | NB0 |
| "No market" | The runner, from 365 days after the first round that took money closed (from launch if none did), no auction running, no round open, before any market; the clock starts; no auction ever | `test_noMarket_*` | N63, N64, N90, N91 |
| Reserve sale | Only a Council runner, only after the market (Finisher `Done`), not after a wind-down, one at a time, at least 201,600 blocks (28 days) after the last sale ended; a plain auction of `amount` reserve Shares from the last sale's end price (tick-rounded up), bids to 4 times that, 720-block closing window, no minimum; `finishReserveSale` (anyone): the dollars less the 3 (taken by the fee controller) split 15 : 82 into `spendable` and the floor, unsold back, exits reopen | `test_reserveSale_endToEnd`, `test_reserveSale_onlyACouncil_onlyAfterAMarket` | N71, N72, N73, N74, N75, N93, N94, N95, N96, NA4, NA5 |
| The Council seam | `councilMaker` (constructor; zero until milestone 9) alone registers Councils and names pausers | `test_councilSeam_onlyTheCouncilMaker` | N97, N98 |
| The settings hash and the fixed rules are kept | `launch(..., expectedSettingsHash)`; every setting is copied at birth | M2/M3 Launcher tests (`test_launch_refusesSettingsTheFounderDidNotSee` and others) | L-series, NA3 |

## Attacks, measured

| Attack (task list) | What happens | Test |
|---|---|---|
| A founder fills their own rounds through 20 accounts, then tries to sell before release | Nothing is in any hand before a market (the accounts hold no Share; nothing counts for an exit). On the market's first day 1/365 of the 30M is free: 82,191 Shares. If all 20 accounts take their money back at once they get 7,725 of the 10,000 (the platform keeps its 3 and its 1; the 15 already went to the project the founder runs) | `test_attack_aFounderFillsTheirOwnRoundsThroughManyAccounts_andCannotSellBeforeRelease` |
| Fake demand forcing a scale-back on honest backers | 60 honest backers ask 100 each, one account asks 94,000 into a 10,000 round and keeps the ask past the 12th hour (it cannot pull it out after that). Everyone gets 10%: the honest 600 dollars in all, the faker 9,400. Taking it all back at once costs the faker 2,077.40 (22.1 of each 100 accepted: 3 + 15 + 5% of 82), and **the project's 10,000 cap is used up** (refunds do not reopen it). See "What the plan got wrong" | `test_attack_fakeDemandForcesAScaleBack_measured` |
| A refund after the market opens | Covers only the Shares still held; pays at most the backer's own unreleased money for them less 5%; the floor (melting and Share revenue) is untouched | `test_refund_afterTheMarket_onlyForSharesStillHeld`, `test_attack_aRefundAfterTheMarketTakesNothingFromTheFloor` |
| A refund then a new ask to game the scale-back | Withdrawing in the first 12 hours and asking again later gives the same percent as everyone; refunding one round does not reopen the cap for the next | `test_attack_refundThenReAskGainsNothing` |
| An agent account trying to check in | Refused; a hand-over also switches every agent of the old runner off | `test_checkIn_onlyTheRunner_notAnAgent`, `test_agents_cannotCheckIn_andAHandOverSwitchesThemOff` |
| A single founder passing the 10,000 cap or opening the auction | `CapReached(10,000)`; `WrongRunner(Pair)` | `test_solo_capIs10000InTotal_andRoundsFollowWithNoWait`, `test_openAuction_aSingleFounderCannot`, `test_worked_10000_theBackedCap` |
| One Pair signer spending 501 in a week or opening a raise alone | `CapExceeded` (also in pieces over 6 days); the Launcher answers only the Pair itself (`NotRunner`), and a proposal alone opens nothing | `test_spendAlone_501InAWeekIsRefused_evenInPieces`, `test_aRaiseNeedsBoth_oneSignerAloneCannotOpenARoundOrTheAuction` |
| Gifts through fresh wallets after the market (B3) | Milestone 2 measured 100,000 to 84,728 of Share revenue (-15.3%) in a year of gifts handed straight back. Now each gift takes only its own slice of the revenue (shared by all 1,000M Shares that exist) and the cap is 1% of the Shares in hands: the same year of 11 gifts handed back takes 6,929.34 (100,000 to 93,187.23, -6.8%, every dollar of it the gifts' own slice), and the claim per Share of everyone else does not fall | `test_fixed_postPoolGiftsToFreshWalletsNeverThinTheRevenueFloor`, `test_fixed_giftsThroughFreshWalletsTakeUnderATenthOfTheRevenueFloor` (the M2 pins, turned round) |
| Exit in pieces (B2) | One exit of a holder of 80%: 4,560.00. 400 pieces: 4,560.00 less at most one raw unit a piece (milestone 2: 4,670.84). The holder left behind is paid the same either way (1,140.00) | `test_fixed_exitingInPiecesPaysTheSameAsOneExit`, `test_edge_exitingInManyPiecesPaysWhatOneExitPays` |

## Re-runs (PLAN-V2 section 7)

All on the real Uniswap stack (local twin; the Sepolia fork twin in "Gates"), at the one auction's size: 250M Shares, a
starting price of 0.0004 dollars, a 100,000 minimum, bids at most 4 times the starting price.

**The M3 closing-window attack table** (`AttackM3.t.sol`, `test_attack_edgeSpikes_bySaleSize` and
`test_attack_spikeBidsAtTheEdgeOfTheClosingWindowSeedThePoolButLoseMoney`). Honest demand of exactly the minimum at one tick
above the start; the attacker bids 10% of it and then the most the rules allow in the last block before the closing window.

| Spike blocks | Final price | Pool dollars | Attacker spent (net) | Best dump takes | Attacker's profit |
|---|---|---|---|---|---|
| 0 (baseline) | 1.01 x | 22,220.00 | 9,181.82 | 6,450.97 (29% of the pool) | -2,730.85 |
| 1 | 4.00 x | 28,835.89 | 48,488.75 | 20,606.65 (71%) | -27,882.09 |
| 4 | 4.00 x | 28,863.28 | 48,651.48 | 20,632.85 (71%) | -28,018.64 |

The absolute cap stops every spike at 4 times the starting price (milestone 3 measured up to 256 times with the relative cap),
and the lift still costs far more than the pool holds. `test_attack_aFounderDrainsThePoolWithASecondAccount`: the founder's
gain from the same plan is -4,621.09 dollars.

**The whole-sale fuzz at the new size** (`LifeFuzz.t.sol`): 2,000 random sales (random bids up to 1.2 million dollars, refused
bids included, the finish steps called in random order by strangers): every dollar bid is the raise or a refund, raised = 3 + 22
+ 15 + 60, every Share is somewhere, and a sale under the minimum changes nothing. Reach over 90 seeds: 40 graduated, 50 failed,
495 bids attempted, 117 refused by the auction's rules. The split fuzz under spikes and gifts (`AttackM3`): 1,000 runs.

**Demand at the cap ten times the supply** (`test_demandAtTheCapTenTimesTheSupply`): 4,000,000 dollars bid at 4 times the
start for 250M Shares. The price stops at exactly 4.00 times; raised 400,000; each of five bidders gets a fifth of the Shares and
9 of each 10 dollars back; the pool holds 87,999 dollars.

**Self-bidding followed by selling into the pool** (`test_selfBidThenSellIntoThePool_measured`), per 100 the second account spent,
next to 100,000 of honest demand at the cap:

| Founder's bid | Final price | Back from the pool | Spendable at once | All to the project (15 + 60) | Loss at once | If the whole floor melts to the runner |
|---|---|---|---|---|---|---|
| 50,000 | 1.49 x | 39.59 | 15 | 75 | 45.41 | **gain 14.59** |
| 100,000 | 1.99 x | 30.46 | 15 | 75 | 54.54 | **gain 5.46** |
| 300,000 | 3.99 x | 22.62 | 15 | 75 | 62.38 | loss 2.38 |

So the plan's "real loss about 7 to 15 of each 100" is wrong both ways: much more is lost at once, and nothing is lost in the end
if the holders never hand back against the floor while it melts. The second account also takes out of the pool the honest
bidders' 22 of each 100 they paid. Milestone 3's measure in the same file (`test_attack_theFounderBidsInTheirOwnSale_measured`):
a founder bid of 50,000 / 200,000 / 1,000,000 next to 100,000 honest lifts the price to 1.49 / 2.99 / 4.00 times and leaves the
honest bidders 66% / 33% / 9% of the Shares they would have had.

**A minimum equal to the full sale at the starting price** (`test_minimumIsTheWholeSale_halfTheDemandFails_theWholeDemandSellsEveryShare`,
`test_openAuction_theMinimumIsTheMinimum`): 50,000 of demand fails and refunds everyone; one dollar under 100,000 fails; 100,000
sells every Share at the starting price (the price is rounded up by under one tick), the pool opens with 22,000 dollars and 55M
Shares, the 45M pool Shares it did not need are reserve. There is no partial sale any more.

**Other milestone 3 measures at the new size** (`MarketAttacks.t.sol`): the 100,000 pool (21,999.998 dollars, 54,999,994 Shares,
opening at 0.0004): a 100-dollar buy moves the price +0.9% and a 2,500-dollar buy +23.7% (the plan's table: +0.9% and +23.8%);
a 2,500 sell -19.2%. The floor pays 0.000197 dollars a Share at opening (49.2% of the price, as the plan says). Buying below the
floor and handing back starts to pay a 20-dollar trade at 7.91% under the floor (milestone 3: about 6 to 8%). 1% of the Shares
in hands (2,068,767 Shares) dumped at the pool's opening moves the price from 0.000400 to 0.000372 and raises 789.82 dollars.

**The worked example "100,000, the auction at its minimum"** (`test_worked_100000_theAuctionAtItsMinimum`): raised exactly
100,000; platform 3,000; pool 22,000 dollars (to a thousandth) and 55M Shares; 15,000 spendable; 60,000 melting; Creaton holds
20M Shares in the Vester, nothing claimable on day one; the first week releases 1,150.68.

## Numbers and rules I chose (the plan left them open)

1. **Refunds do not reopen the cap.** `raised` counts every dollar ever accepted. Otherwise a founder could raise, take the
   money back through second accounts (losing about 22 of each 100) and raise again past the cap.
2. **Rounding.** The scale-back rounds each backer's accepted part down (the backer gets the rest of the ask back); the split
   rounds the platform's 3 and the held 82 down (the dust goes to the project's 15); the release rounds down; a refund rounds
   the released part of the money taken back **up** and the 5% fee up (both against the backer), and the platform's 1 down. The
   fuzz found that rounding the refunded part down let one raw unit be paid twice (to the project by the round's release and to
   the backer by the refund), which left the platform's sweep a unit short; rounding it up closes it (guard N29).
3. **Lazy per backer.** `close` costs the same for any number of asks; each backer is settled by anyone (`settle`,
   `settleMany`). Nothing has to be paged (gas below).
4. **The release clock** is one counter of active seconds for all of a project's rounds, worked out by the Treasury before every
   change of its window. It is per second, not weekly.
5. **Runner kinds.** A Pair is one this Launcher made; a Council is one the council maker registered (zero until milestone 9);
   anything else (the founder, or a successor they named) is one person.
6. **"No market"**: 365 days after the first round that took money (from launch if none did), by the runner, while no auction
   runs and no round is open.
7. **Wind down** (minimal safe rule, as the task asked): before a market the runner (founder or Pair); after a market only a
   Council runner (none exists until milestone 9, so a market project cannot wind down yet); after "no market" or an abandoned
   sale, the runner. Payments stop for good; the exit fee drops to the platform's 1; backers' refunds keep working at 1;
   the floor stays for holders; `spendable` stays the runner's.
8. **The trim** applies only before a market (the founder keeps `200M * days since launch / 365`, capped at the whole grant).
9. **Pause**: one pauser per project, named only through the Launcher by the council maker (the holders' vote of milestone 9).
10. **The reserve sale** has no minimum (a plain auction; whatever sells, sells, at the last sale's end price or above); its
    starting price is the last end price rounded up to its own one-hundredth grid; exits wait while its Shares are out.
11. **The stake** is granted when the pool is proven (step 2 of the finish), from the reserve, as a held grant; if the reserve
    ever held less than 20M, the whole reserve.
12. **Rounds' fees** (the 3 and the refund's 1) go to the project's platform address (the exit-fee address fixed at birth),
    owed and swept by anyone, so a frozen platform address blocks only the sweep. The auction's 3 still goes through the fee
    controller.
13. **Parts.** The Launcher's creation code could not hold all five implementations under 49,152 bytes, so a `Parts`
    contract, deployed first, makes them; the Launcher reads their addresses once and checks they have code. Like the
    strategy and the guard, this is a deploy-time trust: a reviewer compares `Parts`'s deployed code with the build.
14. **The first auction settle renews the check-in window** (as milestone 2 built); the Rounds' clock is worked out first, so
    a lapse before it stays lost (`test_theAuctionsFirstMoneyDoesNotPayTheRoundsForALapse`).

## What the plan got wrong or left loose

Appended to `docs/PLAN-V2.md` as "Milestone 4 findings":

1. **Self-bidding is not "a real loss of about 7 to 15 of each 100"** (measured above): 45 to 62 at once; a gain of 5 to 15 if
   the whole floor melts to the runner with no holder handing back.
2. Day-45 refund: **58.64**, not 58.60, of each 100.
3. The auction floor's weekly release is **1,150.68**, not 1,154 (365 days per second, not 52 weeks).
4. **Fake demand can use up a project's cap** for about 22.1 of each 100 accepted (2,210 dollars for a Solo project's 10,000).
5. The 1% gift cap on Shares in hands **compounds** to 1/99 of the Shares in hands before the gifts (1.0101%) in 30 days, and
   grows as held Shares release.
6. **D230 and the first election contradict each other**: the auction needs a Council runner on a real network, and the
   Council is elected by auction buyers after the market. As built, no auction can open on a real network until milestone 9
   resolves it.
7. A founder leaving **after** the market is not trimmed (refused); milestone 9 should decide.
8. Not built (out of this milestone's list): the Team takeover after 28 silent days; "agents included" in the 500 a week
   (agents keep the Treasury's own daily caps; each signer has 500 a week).
9. Sizes: Rounds 285 code lines (plan 300), Pair 78 (100), Launcher +227 (+200), Treasury +118 (+80), Vester +76 (+40),
   MinBid one line (+5).

## Gas

Measured with cold storage where a real call would find it cold (`GasM4.t.sol`, `GasM3.t.sol`, `Gas.t.sol`, `AuctionV2.t.sol`).

| Step | Gas |
|---|---|
| Launch a project (five clones, the allocation, every setup) | 1,383,989 (another founder: 1,368,980) |
| Launch and open the first backing round in one passkey batch | 1,476,598 |
| Open a backing round (`Launcher.openRound`) | 130,485 |
| Ask (a backer's first ask) | 107,121 |
| Lower an ask | 63,217 |
| Close a round | 133,337 with 10 asks, 133,352 with 100, 133,352 with 1,000: **the same whatever the number of asks; nothing is paged** |
| Settle one backer (scale-back, split, Shares held in the Vester), cold | 273,469 |
| Settle in batches (`settleMany`) | 132,278 each for 10; 119,157 each for 100; 153,672 each for the first 100 of 1,000 (a batch of 100 is about 12 to 15 million gas, so batches of about 100 fit a block) |
| Refund (cancels the held Shares) | 143,235 |
| Weekly release of a round | 86,968 |
| Hand over to a Pair: the founder's offer | 28,247 |
| Hand over to a Pair: the second signer accepts (`makePair`: clone, set up, take the seat) | 206,089 |
| Pair spend alone (inside 500 a week) | 120,858 |
| Pair check-in | 35,824 |
| Pair propose (any call above the limit, any raise) | 52,095 |
| Open the auction through the Pair (`Pair.confirm(openAuction)`: Finisher, strategy, a new auction) | 4,410,537 |
| The stake grant (it rides on the finish's step 2: money split, pool marked open, 20M Shares held) | 274,861 for the whole step 2 |
| Open a reserve sale (a new auction is deployed) | 3,976,779 |
| Finish a reserve sale | 172,630 |
| Deploy `Parts` / the Launcher | 6,839,620 / 6,487,713 |

## Events the server (milestone 5) must index

Every event below is emitted by a contract whose address the server learns from `Launcher.ProjectLaunched` (its `project`
field names the Shares, Treasury, Vester, Finisher and Rounds) or from `Launcher.PairMade` / `ReserveSaleOpened` / `SaleOpened`.
`key` is `keccak256(abi.encode(founder, projectId))`.

**Launcher**
- `ProjectLaunched(bytes32 indexed key, bytes32 indexed projectId, address indexed founder, Project project, Allocation allocation, Settings settings)`: at launch. `Project` = founder, shares, treasury, vester, finisher, rounds, launchedAt; `Allocation` = sale 250M, poolReserve 100M, founder 200M, workPot 200M, reserve 100M, backing 150M; `Settings` = quote, platform, stake, exitFeeBps, platformFeeBps, spendableParts, floorParts, agentUsd, agentShares.
- `RoundOpened(bytes32 indexed key, address indexed rounds, uint256 indexed round, uint256 size, uint256 cap, uint256 raisedBefore)`: a round opened (the cap tells the stage: 10,000 one person, 50,000 Pair or Council).
- `SaleOpened(bytes32 indexed key, address indexed auction, address indexed runner, address finisher, uint256 minimum, uint64 startBlock, uint64 endBlock, uint256 floorPriceQ96, uint256 tickSpacingQ96)`: the one auction opened.
- `PairMade(bytes32 indexed key, address indexed pair, address first, address second)`: the project became Team.
- `CouncilRegistered(address indexed council)`, `PauserNamed(bytes32 indexed key, address indexed pauser)`: the milestone 9 seam.
- `NoMarket(bytes32 indexed key, address indexed runner)`, `WoundDown(bytes32 indexed key, address indexed runner)`.
- `ReserveSaleOpened(bytes32 indexed key, address indexed auction, uint256 amount, uint256 floorPriceQ96, uint256 tickSpacingQ96, uint64 startBlock, uint64 endBlock)`, `ReserveSaleFinished(bytes32 indexed key, address indexed auction, uint256 toTreasury, uint256 sharesBack, uint256 endPriceQ96)`.
- `SettingsChanged(Settings)`, `AdminChanged(address indexed admin)`.

**Rounds** (one per project)
- `RoundOpened(uint256 indexed round, uint256 size, uint256 opensAt, uint256 closesAt)`.
- `Asked(uint256 indexed round, address indexed backer, uint256 total, uint256 added)`; `AskLowered(uint256 indexed round, address indexed backer, uint256 total, uint256 returned)`.
- `RoundClosed(uint256 indexed round, uint256 asked, uint256 accepted, uint256 activeAtClose)`: the scale-back percent is `accepted / asked` when below one.
- `Settled(uint256 indexed round, address indexed backer, uint256 accepted, uint256 returned, uint256 shares, uint256 toPlatform, uint256 toProject, uint256 held)`: Shares delivered (held) and the money split for one backer.
- `Released(uint256 indexed round, uint256 amount)`: held money to the project's spendable.
- `Refunded(uint256 indexed round, address indexed backer, uint256 unreleased, uint256 paid, uint256 toProject, uint256 toPlatform, uint256 shares)`.
- `FeesSwept(address indexed to, uint256 amount)`, `UnsoldReturned(uint256 amount)`, `WoundDown(uint256 time)`.

**Vester**
- `Granted(address indexed beneficiary, uint256 amount)`, `Claimed(address indexed beneficiary, uint256 amount)`, `Started(uint256 time)` (the clock: market open or "no market").
- `HeldGranted(uint256 indexed round, address indexed backer, uint256 amount)`, `HeldCancelled(uint256 indexed round, address indexed backer, uint256 amount)`, `HeldClaimed(uint256 indexed round, address indexed backer, uint256 amount)`.
- `FounderTrimmed(uint256 kept, uint256 cut)`.

**Treasury**
- Money in: `Settled(uint256 amount, uint256 toSpendable, uint256 toFloor)`, `ReserveSaleSettled(uint256 amount, uint256 toSpendable, uint256 toFloor)`, `ShareRevenue(address indexed from, uint256 amount)`, `ToppedUp(address indexed from, uint256 amount)` (the Rounds' 15, releases and refund fees arrive as top-ups from the Rounds' address).
- Release and window: `Released(uint256 amount)`, `CheckedIn(address indexed by)`, `Paused(bool on)`, `PauserSet(address indexed pauser)`.
- Out: `Spent(address indexed by, address indexed to, uint256 amount)`, `SharesGiven(address indexed by, address indexed to, uint256 amount, bool vested)`, `HandedBack(address indexed holder, uint256 shares, uint256 paid, uint256 toPlatform, uint256 toProject)` (the last field was "stays" in milestones 2 and 3), `FeesSwept(address indexed to, uint256 amount)`, `ReserveReleased(address indexed to, uint256 amount)`, `ReserveSaleClosed(uint256 time)`.
- State: `PoolOpened(uint256 time)`, `StakeGranted(address indexed stake, uint256 amount)`, `SaleAbandoned(uint256 time)`, `SaleClosed(uint256 time)`, `NoMarketDeclared(uint256 time)`, `WoundDown(uint256 time)`.
- Runner and agents: `SeatOffered(address indexed from, address indexed to, bool founderLeaves)`, `RunnerChanged(address indexed from, address indexed to, uint256 cut)`, `AgentSet(address indexed agent, bool active, uint256 usdCap, uint256 shareCap)`.

**Pair**: `SpentAlone(address indexed by, address indexed to, uint256 amount)`, `Proposed(bytes32 indexed id, address indexed by, address target, bytes data, uint256 nonce)`, `Executed(bytes32 indexed id, address indexed confirmedBy)`, `Cancelled(bytes32 indexed id)`.

**Finisher and LiquidityHolder**: unchanged from milestone 3 (its report lists them); `Finisher.PoolOpened` and `Settled` are
always present at a pool's opening, `PoolStep` may be missing.

The stage the page shows can be read with `Launcher.stageOf(key)` or derived: Solo until `Rounds.RoundClosed` with
`accepted > 0`; Backed after it; Team after `PairMade` (or `RunnerChanged` to a Pair); Council after `Treasury.PoolOpened`;
Open 365 days after it.

## Guard removals

Each line of `scripts/mutate-guards.py` with an id starting with N removes one check of this milestone and names the suites to run.
The full list and what each removal broke (first failing test shown; "n" is the number of failing tests):

| Id | Removed | n | A test that fails |
|---|---|---|---|
| N01 | Rounds: anyone may open a round | 1 | `test_open_onlyTheLauncher_oneAtATime_andNeverBeyondTheSharesLeft` |
| N02 | Rounds: a round may open while another is open | 1 | `test_open_onlyTheLauncher_oneAtATime_andNeverBeyondTheSharesLeft` |
| N03 | Rounds: a round may be larger than the Shares left | 1 | `test_open_onlyTheLauncher_oneAtATime_andNeverBeyondTheSharesLeft` |
| N04 | Rounds: asks are taken after the 24 hours | 1 | `test_ask_atLeastOneDollarInTotal_only24Hours_andTheDollarsWaitHere` |
| N05 | Rounds: an ask under 1 dollar is taken | 1 | `test_ask_atLeastOneDollarInTotal_only24Hours_andTheDollarsWaitHere` |
| N06 | Rounds: a dollar token that delivers less is not noticed | 1 | `test_ask_aTokenThatDeliversLessIsRefused` |
| N07 | Rounds: asks may be lowered after the 12th hour | 2 | `test_attack_fakeDemandForcesAScaleBack_measured` |
| N08 | Rounds: an ask may be lowered to under 1 dollar | 1 | `test_lower_onlyInTheFirst12Hours_downOrToZero_andTheDifferenceComesBack` |
| N09 | Rounds: a round may close before 24 hours | 1 | `test_close_after24HoursOnce_acceptsTheSmallerOfAskedAndSize` |
| N10 | Rounds: a round may close twice | 1 | `test_close_after24HoursOnce_acceptsTheSmallerOfAskedAndSize` |
| N11 | Rounds: a round accepts more than its size | 4 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N12 | Rounds: accepted money does not count against the cap | 7 | `test_attack_fakeDemandForcesAScaleBack_measured` |
| N13 | Rounds: no scale-back | 5 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N14 | Rounds: a backer may be settled twice | 1 | `test_settle_splits3_15_82_andHoldsTheSharesInTheVester` |
| N15 | Rounds: a backer may be settled before the close | 1 | `test_settle_beforeTheCloseIsRefused` |
| N16 | Rounds: the platform takes 30 instead of 3 | 26 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N17 | Rounds: nothing is held, all goes to the project at once | 19 | `test_attack_aFounderFillsTheirOwnRoundsThroughManyAccounts_andCannotSellBeforeRelease` |
| N18 | Rounds: bought Shares go straight to the backer, not held | 16 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N19 | Rounds: 6,000 Shares a dollar | 26 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N20 | Rounds: the held money is released at once | 8 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N21 | Rounds: time outside the check-in window counts | 3 | `test_release_aLapsePushesTheEndDateOutAndIsNeverPaidBack` |
| N22 | Rounds: a release is not recorded (paid again) | 6 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N23 | Rounds: a refund ignores the release (the whole held money back) | 6 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N24 | Rounds: a refund has no fee | 13 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N25 | Rounds: the refund fee rounds down | 4 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N26 | Rounds: a refund leaves the held Shares in place | 2 | `test_refund_afterTheMarket_onlyForSharesStillHeld` |
| N27 | Rounds: after the market a refund covers Shares already taken out | 2 | `test_attack_aRefundAfterTheMarketTakesNothingFromTheFloor` |
| N28 | Rounds: a refund does not lower the round's held money | 3 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N29 | Rounds: a refund's released part rounds down (the fuzz finding: a unit paid twice) | 4 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N30 | Rounds: the whole refund fee goes to the platform | 4 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N31 | Rounds: after a wind-down the refund fee stays 5 | 1 | `test_windDown_releaseStopsForGood_andTheRefundFeeIsThePlatformsOne` |
| N32 | Rounds: anyone may wind the Rounds down | 1 | `test_sync_anyone_windDown_onlyTheTreasury` |
| N33 | Rounds: unsold Shares may leave before any market | 1 | `test_returnUnsold_onlyOnceNoRoundCanOpen_andKeepsWhatIsOwed` |
| N34 | Rounds: unsold includes the Shares owed to accepted asks | 1 | `test_returnUnsold_onlyOnceNoRoundCanOpen_andKeepsWhatIsOwed` |
| N35 | Rounds: initialize may be called again | 1 | `test_initialize_onceAndNotOnTheImplementation` |
| N36 | Rounds: no re-entrancy lock | 1 | `test_aCallBackIntoTheRoundsWhileDollarsAreSentIsRefused` |
| N37 | Rounds: fees are swept to the caller | 2 | `testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded` |
| N40 | Vester: anyone may add a backer grant | 1 | `test_onlyTheRoundsAddAndCancelBackerGrants` |
| N41 | Vester: anyone may cancel a backer grant | 1 | `test_onlyTheRoundsAddAndCancelBackerGrants` |
| N42 | Vester: a cancel takes back Shares already claimed | 1 | `test_refund_afterTheMarket_onlyForSharesStillHeld` |
| N43 | Vester: a cancelled grant stays on the clock (unreleased overcounted) | 1 | `test_aCancelTakesTheGrantOffTheClock` |
| N44 | Vester: a grant may be cancelled with nothing held | 1 | `test_aGrantWithNothingHeldCannotBeCancelledTwice` |
| N45 | Vester: anyone may trim the founder | 1 | `test_trim_onlyTheTreasury` |
| N46 | Vester: the founder may be trimmed after the clock started | 1 | `test_handOver_aTrimAfterTheMarketIsRefused_andTheSeatStaysPut` |
| N47 | Vester: a trimmed founder keeps nothing | 1 | `test_handOver_aLeavingFounderKeepsTheDaysServed_theRestReturnsToTheWorkPot` |
| N48 | Vester: a backer grant is claimable before its release | 3 | `test_attack_aFounderFillsTheirOwnRoundsThroughManyAccounts_andCannotSellBeforeRelease` |
| N51 | Treasury: a check-in does not work out the Rounds' clock first | 1 | `test_release_aLapsePushesTheEndDateOutAndIsNeverPaidBack` |
| N52 | Treasury: anyone may offer the runner seat | 1 | `test_handOver_twoSteps_onlyTheRunnerOffers_onlyTheNamedTakes` |
| N53 | Treasury: anyone may take the runner seat | 2 | `test_handOver_twoSteps_onlyTheRunnerOffers_onlyTheNamedTakes` |
| N54 | Treasury: a hand-over leaves the old runner's agents working | 1 | `test_agents_cannotCheckIn_andAHandOverSwitchesThemOff` |
| N55 | Treasury: the trimmed Shares do not return to the work pot | 1 | `test_handOver_aLeavingFounderKeepsTheDaysServed_theRestReturnsToTheWorkPot` |
| N56 | Treasury: anyone may pause | 1 | `test_release_aPauserMustBeNamedAndOnlyTheCouncilMakerNamesIt` |
| N57 | Treasury: a pause does not stop the release | 1 | `test_release_pausedTimeDoesNotCount` |
| N58 | Treasury: anyone may name the pauser | 1 | `test_release_aPauserMustBeNamedAndOnlyTheCouncilMakerNamesIt` |
| N59 | Treasury: anyone may wind the project down | 1 | `test_onlyTheLauncherWindsDown` |
| N60 | Treasury: a wind-down does not stop the release | 2 | `test_windDown_releaseStopsForGood_andTheRefundFeeIsThePlatformsOne` |
| N61 | Treasury: a wind-down does not reach the Rounds | 1 | `test_windDown_releaseStopsForGood_andTheRefundFeeIsThePlatformsOne` |
| N62 | Treasury: after a wind-down the exit fee stays 5 | 1 | `test_windDown_theRunnerBeforeAMarket_onlyACouncilAfter` |
| N63 | Treasury: anyone may declare no market | 1 | `test_noMarket_withNoRoundCountsFromTheLaunch` |
| N64 | Treasury: no market does not start the clock | 1 | `test_noMarket_onlyAfter365DaysFromTheFirstMoneyRound_thenTheClockStartsAndTheAuctionIsClosed` |
| N65 | Treasury: the stake is not granted (sent but not set aside) | 26 | `testFuzz_attack_donatingSharesToTheProjectNeverPaysTheDonor` |
| N67 | Treasury: Share revenue is shared by the Shares in hands (B3 comes back) | 5 | `testFuzz_anExitNeverPaysMoreThanItsSliceAndConservesMoney` |
| N68 | Treasury: the gift cap is on all Shares (B3 comes back) | 5 | `test_attack_aFounderDumpAfterPoolOpenIsCappedAtOnePercentAMonth` |
| N69 | Treasury: the Rounds' Shares count as in hands | 2 | `test_attack_aFounderFillsTheirOwnRoundsThroughManyAccounts_andCannotSellBeforeRelease` |
| N70 | Treasury: the Finisher's Shares count as in hands | 2 | `test_attack_aFounderFillsTheirOwnRoundsThroughManyAccounts_andCannotSellBeforeRelease` |
| N71 | Treasury: exits run while a reserve sale is out | 2 | `test_reserveSale_endToEnd` |
| N72 | Treasury: a second reserve sale may start while one is out | 1 | `test_reserveSale_oneAtATime_andExitsWaitWhileItIsOut` |
| N73 | Treasury: anyone may settle a reserve sale | 1 | `test_reserveSale_onlyACouncil_onlyAfterAMarket` |
| N74 | Treasury: a reserve sale is all spendable | 1 | `test_reserveSale_endToEnd` |
| N75 | Treasury: anyone may close a reserve sale | 1 | `test_reserveSale_onlyACouncil_onlyAfterAMarket` |
| N76 | Treasury: the first settle does not work out the Rounds' clock | 1 | `test_theAuctionsFirstMoneyDoesNotPayTheRoundsForALapse` |
| N77 | Treasury: setAgent does not record the runner's epoch | 1 | `test_agents_cannotCheckIn_andAHandOverSwitchesThemOff` |
| N78 | Treasury: spend ignores the agent epoch | 1 | `test_agents_cannotCheckIn_andAHandOverSwitchesThemOff` |
| N80 | Launcher: anyone may act as the runner | 4 | `test_aRaiseNeedsBoth_oneSignerAloneCannotOpenARoundOrTheAuction` |
| N81 | Launcher: a single founder may raise 50,000 | 6 | `test_attack_fakeDemandForcesAScaleBack_measured` |
| N82 | Launcher: a round is sized to the whole cap, not what is left | 3 | `test_solo_capIs10000InTotal_andRoundsFollowWithNoWait` |
| N83 | Launcher: no cap check before the round opens | 4 | `test_attack_refundThenReAskGainsNothing` |
| N84 | Launcher: rounds open after a market | 2 | `test_noMarket_onlyAfter365DaysFromTheFirstMoneyRound_thenTheClockStartsAndTheAuctionIsClosed` |
| N85 | Launcher: a single founder may open the auction | 1 | `test_openAuction_aSingleFounderCannot` |
| N86 | Launcher: the Council requirement is ignored | 2 | `test_onARealNetworkOnlyACouncilOpensTheAuction` |
| N87 | Launcher: the Council requirement is off on every network | 3 | `test_onARealNetworkOnlyACouncilOpensTheAuction` |
| N88 | Launcher: the auction opens while a round is open | 1 | `test_openAuction_notWhileARoundIsOpen_notAfterAMarket` |
| N90 | Launcher: no market may be declared at once | 1 | `test_noMarket_onlyAfter365DaysFromTheFirstMoneyRound_thenTheClockStartsAndTheAuctionIsClosed` |
| N91 | Launcher: no market counts from the launch even after a round | 1 | `test_noMarket_onlyAfter365DaysFromTheFirstMoneyRound_thenTheClockStartsAndTheAuctionIsClosed` |
| N92 | Launcher: a Pair may wind down after a market | 1 | `test_windDown_theRunnerBeforeAMarket_onlyACouncilAfter` |
| N93 | Launcher: any runner may open a reserve sale | 1 | `test_reserveSale_onlyACouncil_onlyAfterAMarket` |
| N94 | Launcher: reserve sales need no 28 days between them | 1 | `test_reserveSale_endToEnd` |
| N95 | Launcher: a reserve sale may open before the market | 1 | `test_reserveSale_onlyACouncil_onlyAfterAMarket` |
| N96 | Launcher: a reserve sale starts at the first sale's starting price | 1 | `test_reserveSale_endToEnd` |
| N97 | Launcher: anyone may register a Council | 1 | `test_councilSeam_onlyTheCouncilMaker` |
| N98 | Launcher: anyone may name a pauser | 1 | `test_release_aPauserMustBeNamedAndOnlyTheCouncilMakerNamesIt` |
| N99 | Launcher: a Pair it made is not marked as a Pair | 12 | `test_demandAtTheCapTenTimesTheSupply` |
| NA0 | Launcher: no stake | 3 | `test_launch_recordsTheProjectUnderFounderAndId` |
| NA1 | Launcher: the backing Shares are minted to the Treasury | 37 | `test_ask_aTokenThatDeliversLessIsRefused` |
| NA2 | Launcher: parts with no code are accepted | 1 | `test_constructor_refusesBadSettings` |
| NA3 | Launcher: the stake address may be zero | 1 | `test_constructor_refusesBadSettings` |
| NA4 | Launcher: a finished reserve sale's money is not split | 1 | `test_reserveSale_endToEnd` |
| NA5 | Launcher: a finished reserve sale leaves exits closed | 1 | `test_reserveSale_endToEnd` |
| NP0 | Pair: a signer alone spends with no weekly limit | 2 | `test_spendAlone_501InAWeekIsRefused_evenInPieces` |
| NP1 | Pair: anyone may act as a signer | 3 | `test_checkIn_eitherSigner_notAStranger_notTheFounderDirectly` |
| NP2 | Pair: a signer may confirm their own proposal | 1 | `test_bothSigners_spendMore` |
| NP3 | Pair: a proposal may run twice | 1 | `test_bothSigners_spendMore` |
| NP4 | Pair: calls may go anywhere | 1 | `test_propose_onlySigners_onlyTheTreasuryOrTheLauncher_andCancel` |
| NP5 | Pair: the two signers share one weekly limit | 1 | `test_spendAlone_upTo500InAny7Days_perSigner` |
| NP6 | Pair: initialize may be called again | 1 | `test_initialize_onceOnlyAndNotOnTheImplementation` |
| NP7 | Pair: the same person may be both signers | 1 | `test_initialize_onceOnlyAndNotOnTheImplementation` |
| NP8 | Pair: anyone may cancel a proposal | 1 | `test_propose_onlySigners_onlyTheTreasuryOrTheLauncher_andCancel` |
| NB0 | MinBid: the cap is 64 times the starting price (back towards milestone 3's ladder) | 5 | `test_bids_aTopPriceAboveFourTimesIsRefusedAndFourTimesIsNot` |

(Ids N36, N40, N41, N43, N44, N59, N71, N72, N74 and N76 are from the second pass, after their tests were written.)

## What I ran, and what I did not do

- Ran: everything in "Gates"; each test file while writing it; the removal script for the 108 new and 29 moved guards. Nothing
  else was run against Sepolia; nothing is deployed; no key was used.
- Not done: the Council, HolderVote, Tasks (milestones 8 and 9); the Team takeover after 28 silent days; a trim for a founder who
  leaves after the market; the server side. The milestone 1 to 3 removal entries whose code did not move were not re-run.
- `Launcher.finishReserveSale` moves the reserve sale's dollars with a plain `transfer` (a token that returns false makes the
  Treasury's `settleReserveSale` revert with `NotArrived`, so nothing is lost silently); `SafeERC20` would give a clearer error.
- The Deploy script (`script/DeployPlatform.s.sol`) was updated to make `Parts` first and pass the stake address and a zero
  council maker; it was not simulated in this milestone.
