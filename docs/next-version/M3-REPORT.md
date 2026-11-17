# Milestone 3 report: the sale into a pool, the floor, the exit, the way out

Written 16 November 2026, branch `v4-governance-rework`. For the owner. Plain words first. The code is in `contracts/next/src`, the
tests in `contracts/next/test`. Nothing is deployed anywhere, no key was held, and every number below was run, except where it says
"outside knowledge" (my memory of other products) or "estimate".

## The short answer

**Yes: one founder, in one transaction, opens a 24-hour sale; a stranger finishes it in three steps; a Uniswap pool opens with 22 of
every 100 dollars raised and the Shares that match them; the project gets 15 at once and 60 paid over a year; anyone can hand Shares
back at the floor; and if the pool never opens, anyone can open the exits after seven days.** The plan's split came out as
written on a local copy of Uniswap and on the real Uniswap contracts on a Sepolia fork, with the dollar token on either side of the
Share in the pool: every dollar is accounted for to the unit, and the pool's 22 matches to within a thousandth of a dollar (the pool's
rate is a whole number of ten-millionths, 2,268,041).

The sale in the main test raised 20,358.356920 dollars. Where every dollar went:

| Part | Dollars | Of each 100 raised |
|---|---|---|
| Platform (taken by the auction itself) | 610.750707 | 3.000 |
| Into the Uniswap pool, with 59,717,840.7 Shares | 4,478.838054 | 22.000 |
| To the project at once (spendable) | 3,053.753631 | 15.000 |
| Into the melting floor (paid out over 365 days) | 12,215.014528 | 60.000 |
| Sum | 20,358.356920 | 100.000 |

The founder never held a dollar. The auction paid the strategy, the strategy paid the project's **Finisher** (a small contract that
exists once per project), and the Finisher paid the Treasury, marking the pool open and splitting 15 : 60 in the same transaction.

What is new, in one line each:

* **Launcher** (replaces the milestone 2 one, which could never finish a sale): `openSale(projectId, size)` fills in every auction and
  strategy setting itself. The founder picks one of three sizes and nothing else.
* **Finisher** (one clone per project): holds the sale Shares, receives the sale's dollars, runs the three-step finish, and is the only
  address the Treasury believes about the pool. Also the abandon path.
* **LiquidityHolder** (one per Launcher): owns every project's pool position, with no function that moves or shrinks it. Collects trading
  fees: half the dollars to the platform, half into the project's spendable bucket, the Shares burned.
* **Pinned.sol**: our fixed view of the vendored Uniswap code, with one drift test that fails if upstream moves.
* **Treasury**: two small additions for the abandoned case (`markAbandoned`, `settleToFloor`). Nothing else changed in what it does.

## Fix round after review (17 November 2026)

A reviewer and an attacker-tester went through this milestone (the report below is the earlier text, corrected where it was wrong). **Two findings
were real defects; the rest were test gaps, wrong words, or things only the owner can decide.** Each was checked first. Nothing in the split, the
fee, the exit rule or the gift rules was changed (those are the owner's); nothing was deployed.

| Finding | Real? | What I did |
|---|---|---|
| **F1 (blocker)** a few dollars of bids in the last blocks lift the pool's opening price and let a holder of cheap Shares empty the pool | Yes. The tester's numbers (I did not re-run the unfixed code; instead, removing the fix again, entries B01 and F33 below, makes the attack tests fail): Standard sale, 1 spike block cost 5.66 dollars for a 4.0x price and a best dump took 64% of the pool's dollars (profit +409.68); 4 spike blocks cost 493 for 256x and took 99% (+793.52); a founder's second account ended 1,909.43 dollars ahead (21% of the honest raise) | **No bids in the last 720 blocks of a sale** (a tenth of it, 2.4 hours at 12 seconds): `MinBid` has a third setting, the Launcher's constructor refuses a hook that does not have 720. A lifted price now has to be paid on every block after the last bid that counts. The same attack placed at the edge of the window loses money at every size (table below). Option 2 of the finding (abandon when the final price is high) was **not** used: it would also abandon honest sales whose demand rose, and it changes the split. |
| **F2 / R-01** a pool made by someone else at the project's key after a swallowed failure counts as the project's | Yes (the reviewer's and the tester's reproduction; removing the fix, entry F33, makes the fake-pool tests fail): spendable 19.39% instead of 15.00, floor 77.60% instead of 82, the way out shut (`PoolExists`) for good | `Finisher.poolIsOpen` now needs both: a guarded pool with liquidity at the key **and** that the pool step took this sale's money (at least half of the pool's dollar budget missing from what the strategy returned; a failed step returns all of it). After step 2 it stays true. Tested with the squat (both fail-and-squat flows), the way out after it (15 / 82, Vester clock, exits), and a gift after step 2. |
| **R-02** the 4-times rule is against the price at the time of each bid, not the floor | Yes, as stated | Reported as it is: "4 times the clearing price at the time of that bid". A ladder test measures 4x, 16x, 64x, 256x (below). The cap is **not** made absolute: that limits honest late bidders, so it is an owner decision (listed below). The Launcher, `MinBid`, the plan and the test comments say the real rule. |
| **R-03** the events were asserted nowhere | Yes: I deleted `emit Settled`, `Collected` and `SaleOpened` one by one and the old suite passed | `FinishEvents.t.sol` asserts every event of the finish, the sale opening, the failed sale, the way out and a pool step run directly by a stranger, with figures; the holder's `Collected`, `Owed`, `OwedSent` are asserted in its own tests. 17 removals of an `emit` (E01 to E17) each fail a test. New `Finisher.PoolOpened(auction, poolId, sqrtPrice, poolDollars, poolShares)` always comes from step 2. The position's token id is **not** in it: no bounded on-chain way to find it exists (the holder has no callback and scanning is unbounded); it is the position manager's `Transfer(0, holder, id)` in the pool step's transaction. `PoolStep` can be missing (a stranger may call the strategy's `migrate`); the server must not rely on it. |
| **R-04** abandon does not help when the pool step reverts for good (frozen fee recipient) | Yes. Reproduced here by a test that now stays in the suite: `openPool` and `abandon` revert; `settle` and exits wait | No code fix is possible (the auction pays its 3% only through the strategy). Stated now, and pinned by a test: **abandon covers a pool step that never ran and one that failed and was swallowed, not a frozen fee recipient.** Treat a freezable dollar token and a freezable fee recipient as one point of failure for every project when the token is chosen (owner). |
| **R-05** the sealed reserve | Yes, already flagged | Owner decision, unchanged: see "What the plan got wrong" point 5. I did not add a function to the Launcher. |
| **R-06** the branch for a token that answers `false` had no test | Yes: changing it to `if (!ok)` passed all 320 tests | New `QuoteToken` mode and a holder test (the platform's half stays owed and in the holder, `sweepOwed` reverts while frozen and pays after). Removal H12 is caught. |
| **F2 variant, found while fixing** a guarded pool of a stranger's own token | Reachable (the strategy builds guarded pools for anyone) | The holder's "one side is a project's Shares" check is back, with its own test (earlier removal H02 had called it unreachable; that was wrong, it was only unreachable by the project's own path). |

**What the closing window costs, and what it does not stop.** Honest bidders cannot bid or raise a bid in the last 720 blocks. A sale just under its
minimum when the window opens cannot be topped up. The price can still rise in the window from bids placed before it (a bid is spent evenly over the
rest of the sale), so a founder or a rich bidder can still lift the price, but only by paying it on every block. Measured on the local twin: the attacker
holds 10% of the goal in ordinary Shares and places 1 or 4 spike bids ending at the last block that takes bids, then sells into the new pool the best way
of 10 sizes. The profit is negative at every size, and the lift alone costs more than all the dollars in the pool.

| Sale | No spike: profit | 1 spike bid at the edge: price, spent, pool dollars taken, profit | 4 spike bids: price, spent, taken, profit |
|---|---|---|---|
| Small (4,000) | -126.90 | 4.00x, 1,968.99, 830.34 (72% of a 1,145.52 pool), -1,138.65 | 256x, 103,396.06, 20,922.81, -82,473.25 |
| Standard (10,000) | -317.24 | 4.00x, 4,922.46, 2,075.84 (72% of 2,863.80), -2,846.62 | 256x, 258,490.16, 52,307.03, -206,183.13 |
| Large (50,000) | -1,586.21 | 4.00x, 24,612.32, 10,379.20 (72% of 14,319.01), -14,233.12 | 256x, 1,292,450.80, 261,535.13, -1,030,915.67 |

The Standard row also for 2 and 3 spike bids: 16x (-12,330.14) and 64x (-51,052.71). A founder's second account in the Standard sale (honest 9,000, 1,000 of
ordinary Shares, 4 spike bids) ends **12,997.21 dollars worse off** than the same sale without the attack (before the window: 1,909.43 better off).

**The ladder (R-02), Standard sale, 10,000 honest, a second account placing four bids 20 blocks apart well before the window, each at 4 times the
price of that block and sized to buy every Share still for sale:** the price after each bid was 4.00x, 16.00x, 64.00x and 256.00x the floor; the sale raised
2,505,618.16 dollars, the second account spent 2,505,471.41 net of refunds, 551,235.94 dollars were in the pool. The rule limits one bid's jump,
not the climb; cost does (25 of each 100 spent goes to the platform and the pool and never comes back).

**What fixing F2 cannot do, measured.** Dollars sent to the Finisher before step 2 make a real pool look as if it took less. On the Standard sale (pool
budget 2,200 dollars) a gift of 1,095 changes nothing and a gift of 1,105 hides the pool: step 2 refuses, and seven days later the way out opens although
a pool exists. The gift goes to the project, so the sender pays more than 11 of each 100 dollars raised for it; exits still open, and the money is conserved.
(Before the fix a gift never mattered, but a fake pool did.)

**Gas after the fix (local twin, cold):** `openPool` 776,832 (was 766,203: it now reads the auction and the balance to report the outcome),
`settle` 286,619 (was 271,524: reads the pool, emits the new event), `sweep` 67,006, `collect` 265,227 (was 262,173), `abandon` 311,675 / 734,010 (was 306,784 /
724,725). Opening a sale and the batched start-and-open call are unchanged (4,380,084 and 5,262,762).

**Test changes that were not defects.** Some old tests were rewritten or tightened because the rules changed: the three reviewer attack tests (bids in the last
blocks now sit at the edge of the window), the "gifts to every contract" test (gifts of 300 dollars, not 777, because 3 x 777 is more than half the pool's budget:
the limit above), the whole-sale fuzz (gifts to the Finisher capped at 40% of the pool's budget; its tolerance for pool rounding now grows with the raise,
after a counterexample at a 1.3-million-dollar raise was 0.004 dollars over the 2,000-unit allowance), the 300-tick test (the big bid now sits at the edge of the window; the checkpoint that
crosses 300 ticks costs 327,826 gas), and the pool-reading tests (`poolAtTheKey` is the new name of the old "a pool exists" read).

**Owner calls this round** (nothing here changes sections 3 and 4): (a) the closing window's length (720 blocks, a tenth) and the choice **not** to make the 4-times
cap absolute, (b) the sealed reserve (R-05), (c) the dollar token and the frozen-recipient limit (R-04), (d) B3 (open) and B2 (accepted), as before.

## Owner calls, and how each was followed

1. **Pool Shares and unsold Shares in the exit count.** Followed as the milestone 2 rule says. The pool's Shares count as in people's
   hands. Unsold Shares count only while they sit outside the Treasury, which is why exits stay closed until step 3 moves them into
   the Treasury as plain reserve (tested: a trader who buys from the new pool between step 2 and step 3 is refused). After step 3 they
   are the Treasury's and are left out. **The floor-per-Share consequence, with real numbers:**

   | Sale | Floor money | Shares counted | Floor per Share counting the pool | Leaving the pool's Shares out | Price the pool opened at |
   |---|---|---|---|---|---|
   | Standard, demand exactly the goal (10,000 raised) | 6,000.00 | 488.0 million (400.0 buyers + 88.0 pool) | $0.00001230, 49.2% of the opening price | $0.00001500, 60.0% | $0.000025 |
   | The main test (20,358 raised, price rose 3x) | 12,215.01 | 459.7 million (400.0 + 59.7) | $0.00002657, 35.4% of the opening price | $0.00003054, 40.7% | $0.000075 |

   Counting the pool's Shares lowers the floor per Share by the pool's share of the count: 18.0% in the first sale, 13.0% in the second.
   The plan's example said 48%; the real figure is 49.2% for a sale at its goal, by luck (the plan assumed 100 million pool Shares, the pool
   takes 88 million), and 35.4% when the price rises.
2. **Exit in pieces recovers part of the 4% fee (milestone 2 finding B2): accepted, rule not changed.** Plainly: a holder who hands back in
   many small pieces pays less than 5%, because the 4% that "stays for those who remain" also lifts the floor under their own remaining
   Shares. Measured at milestone 2: a holder of 20% of the counted Shares gets 0.43% more in 100 pieces, a holder of 80% gets 2.4% more in
   400 pieces, and a sole holder in the limit pays about 1% instead of 5%. The pinned test and the skipped reviewer test are as they were.
   For the plan: section 4's "buy and hand back only pays when the price is more than about 5% under the floor" is exact only for small
   holders; see the bear-market numbers below, which are larger than 5% for a different reason.
3. **Post-pool gifts through fresh wallets (finding B3): open, nothing changed.** The pinned test (a drain of between 10% and 25% of a
   permanent floor) and the skipped reviewer test are as they were. This milestone only measures the allowance (below).
4. **Abandon path: built as asked, and it is my call in the details.** If the pool step has not produced a pool 7 days (50,400 blocks)
   after the sale ends, anyone may call `abandon`. Details I chose are in "Numbers I chose". Of each 100 raised: **3 to the platform, 15
   spendable, 82 into the melting floor** (the 60 plus the 22 that had no pool to go to). Derived from the plan like this: after the 3, the
   money that would have gone into the pool is 2,268,041 of 10,000,000 of what is left; the rest is split 15 : 60 as always, the pool's
   part goes wholly to the floor. All Shares come back to the Treasury as plain reserve. Tested early (refused at block end + 50,399),
   on time, with the figures, after a failed pool step, and when a pool exists (refused).
5. **`markSaleClosed` and `markPoolOpen` only by the real finish contract; opener and sale path no longer changeable.** The Treasury's
   `opener` is the project's own Finisher, derived by the Launcher at launch, and its `sale path` is the Launcher. Neither is a setting
   any more (the Launcher's settings lost both fields), and a test shows that whatever the admin sets and whatever a founder commits to,
   the Treasury gets those two.
6. **A real Launcher.** No chain-id refusal. The strategy, the pool guard and the bid rules are immutables of the Launcher, and its
   constructor refuses to build unless they fit: the guard is a contract at a mined address with exactly the `beforeInitialize` bit and
   names the strategy as the only creator; the strategy's fee controller reports exactly 3% of a test amount, pays someone, and has no
   owner; the bid hook is 1 dollar, 4 times the price at the time of the bid, and no bids in the last 720 blocks (added in the fix round). The size menu is fixed (goal 4,000 / 10,000 / 50,000; minimum 2,000 / 2,500 / 12,500;
   24-hour sale; smallest bid 1 dollar; 4-times cap through the bid hook, against the price at the time of the bid; no bids in the last 720 blocks).
   `launch` still takes the settings hash the founder saw.
7. **Compiler.** First-party code, and the milestone 3 tests, build with 0.8.37 and 200 runs; the vendored strategy and auction stay at
   their own pins and are reached only through `Pinned.sol`. One drift test (`PinnedDrift.t.sol`) fails if upstream changes (below).
8. **Licence with counsel; nothing deployed; a mined strategy address per network.** The licence question is untouched. The search cost I
   measured is in "Mined addresses".

## What exists

| File | Job | Lines (file / code only) |
|---|---|---|
| `Launcher.sol` | Makes a project (four clones), opens its one sale with every setting filled in, checks the platform's stack at construction | 473 / 327 |
| `Finisher.sol` | Per project: holds the sale Shares, three-step finish, abandon, reads the pool | 377 / 227 |
| `LiquidityHolder.sol` | Owns the positions, collects and splits fees | 147 / 83 |
| `Pinned.sol` | Copies of the vendored structs and interfaces, the pool-state reader, the sale's shared numbers | 200 / 112 |
| `Treasury.sol` | Two additions: abandoned state, floor-only split | 523 / 336 (was 484 / 312) |
| `Interfaces.sol` | Two more small interfaces | 71 / 34 |

The plan estimated Launcher 400, LiquidityHolder 120, PoolGuard 30, Pinned interfaces 150 lines: these come to 327 + 227 (Finisher, not in the
plan's table) + 83 + 112 code lines (after the fix round; `MinBid` is 34 code lines). Contract sizes: Launcher 9,572 bytes of code and 39,945 of creation code (limit 49,152, so
it deploys), Finisher 7,857 (8,278 creation code), LiquidityHolder 3,710 (3,918), Treasury 10,209.

## The rules, where they live, and the test that fails without them

Every guard added or changed in this milestone was **removed once, in its own run** (`contracts/next/scripts/mutate-guards.py`, which holds the
list), the file restored from git after each, and the suites that should catch it run (the finish, sale, Launcher, holder, Treasury or drift
suites, local twin only; the fork copies run the same tests). **109 removals: the 83 of the first round (run twice then) and 26 added in the fix round; the whole list was run again after the fixes, in three copies of the project at once, and every one made at least one test fail**; none failed to compile. The table is that last run (the failing tests of some old entries changed with the fixes: F28 to F30 now fail the `poolAtTheKey` tests). The number in
brackets is how many tests failed in all. The id letters: F = Finisher, A = Launcher, H = LiquidityHolder, P = the numbers in `Pinned.sol`, X = the
Treasury's abandoned state, B = the bid hook (`MinBid`), E = an event that is no longer emitted (written as `emit X(` turned into `abi.encode(`, which keeps the arguments and drops the event). The fix-round entries are F33 to F36, A31, B01, B02, H11, H12 and E01 to E17.

How the runs found real weaknesses, and what I did about them:
* **P06** (abandon after one day instead of seven) was not caught on the first run, because the tests took the seven-day number from the
  same constant that was changed. The tests now write the numbers out (50,400 blocks, the pool rate, the fee, the tick spacing, the
  sale and pool Share amounts), and the removal is caught.
* **H02** (a check in the LiquidityHolder that exactly one side of the position's pool is a project's Shares) was not caught, so I deleted it,
  reasoning that a pool with the platform's guard as its hook can only be made for a project's sale. **That reasoning was wrong** (fix round): the strategy builds a
  guarded pool for anyone's token, and for a project's own Shares once a failed pool step has freed the key. A check that a project owns one side is back
  (`UnknownProject` when neither side is a project's Shares), with a test that makes such a pool for a stranger's token (H11 is caught).

Guards not removed, and why: the zero-address and zero-amount refusals of the Treasury and the checked-arithmetic guards (as in milestone 2);
the Finisher's `initialize` refusals of a zero treasury, Shares or dollar token (one test sets up a clone with real values, none with zero);
the `Launcher.launch` name-length checks (milestone 2's); the pool-state reader's offset constant `LIQUIDITY_OFFSET` and the auction's creation salt (the attempt number) are exercised by the drift test's
liquidity read and by the retry test, and were not removed separately.

| Id | The guard removed once | A test that failed (and how many failed in all) |
|---|---|---|
| A01 | Launcher: the guard may be no contract | `test_constructor_refusesASaleWithNoPoolGuard` (1) |
| A02 | Launcher: the guard may sit at an address without exactly the beforeInitialize bit | `test_constructor_refusesASaleWithNoPoolGuard` (1) |
| A03 | Launcher: the guard may name someone else as the pool's only creator | `test_constructor_refusesASaleWithNoPoolGuard` (1) |
| A04 | Launcher: the fee controller may be no contract | `test_constructor_theFeeMustBeExactlyThreePercentAndHaveNoOwner` (1) |
| A05 | Launcher: the raise fee may be any rate | `test_constructor_theFeeMustBeExactlyThreePercentAndHaveNoOwner` (1) |
| A06 | Launcher: the fee may go to nobody | `test_constructor_theFeeMustBeExactlyThreePercentAndHaveNoOwner` (1) |
| A07 | Launcher: the fee controller may have an owner | `test_constructor_theFeeMustBeExactlyThreePercentAndHaveNoOwner` (1) |
| A08 | Launcher: the smallest bid may be anything | `test_constructor_theBidRulesMustBeOneDollarFourTimesAndAClosingWindow` (1) |
| A09 | Launcher: the top-price cap may be anything | `test_constructor_theBidRulesMustBeOneDollarFourTimesAndAClosingWindow` (1) |
| A10 | Launcher: the strategy may be no contract | `test_constructor_theFeeMustBeExactlyThreePercentAndHaveNoOwner` (1) |
| A11 | Launcher: the bid hook may be no contract | `test_constructor_refusesBadSettings` (1) |
| A12 | Launcher: the Treasury trusts the founder as its opener | `testFuzz_attack_aStrangerCannotMakeTheFounderLoseRelease` (26) |
| A13 | Launcher: the Treasury trusts the founder as its sale path | `test_attack_theAdminCanChangeTheSettingsInTheBlockBeforeALaunch` (3) |
| A14 | Launcher: the sale Shares are minted to the Launcher, not the Finisher | `testFuzz_attack_changingTheCountingSupplyNeverPaysTheSender` (27) |
| A15 | Launcher: the holder cannot tell which Treasury a project's Shares belong to | `test_launch_recordsTheProjectUnderFounderAndId` (2) |
| A16 | Launcher: the sale raises the current dollar setting, not the project's own (strategy side) | `test_openSale_theProjectsOwnDollarTokenIsUsedNotTheCurrentSetting` (1) |
| A17 | Launcher: the sale raises the current dollar setting, not the project's own (auction side) | `test_openSale_theProjectsOwnDollarTokenIsUsedNotTheCurrentSetting` (1) |
| A18 | Launcher: the pool position goes to the Finisher, not the LiquidityHolder | `test_life_aWholeProjectLife` (3) |
| A19 | Launcher: what the pool leaves goes to the founder | `test_attack_aDollarTokenThatFreezesAnAddressStopsTheFinishWithoutHalfDoingIt` (8) |
| A20 | Launcher: the unsold Shares go to the founder | `test_life_aWholeProjectLife` (7) |
| A21 | Launcher: no bid rules | `test_bids_aTopPriceAboveFourTimesIsRefusedAndFourTimesIsNot` (5) |
| A22 | Launcher: the pool has no guard | `test_attack_aDollarTokenThatFreezesAnAddressStopsTheFinishWithoutHalfDoingIt` (15) |
| A23 | Launcher: the pool is reserved half the Shares | `test_life_aWholeProjectLife` (2) |
| A24 | Launcher: the pool step may run later than the first block after the sale | `test_attack_aDollarTokenThatFreezesAnAddressStopsTheFinishWithoutHalfDoingIt` (8) |
| A25 | Launcher: bidders may claim later than the first block after the sale | `test_life_aWholeProjectLife` (4) |
| A26 | Launcher: the Standard minimum is 2,000 dollars | `test_openSale_fillsInEverySettingFromTheSize` (2) |
| A27 | Launcher: the Small goal is 5,000 dollars | `test_openSale_fillsInEverySettingFromTheSize` (2) |
| A28 | Launcher: the Large minimum is 10,000 dollars | `test_openSale_fillsInEverySettingFromTheSize` (2) |
| A29 | Launcher: the floor price is rounded down to the tick | `test_openSale_fillsInEverySettingFromTheSize` (1) |
| A30 | Launcher: the sale starts in the block it is opened | `test_openSale_fillsInEverySettingFromTheSize` (1) |
| F01 | Finisher: anyone may open the sale | `test_openSale_onlyTheFounderOpensAndOnlyThroughTheLauncher` (1) |
| F02 | Finisher: anyone may set a clone up | `test_attack_noOneCanInitialiseAFinisherOrItsImplementation` (1) |
| F03 | Finisher: a clone may be set up twice | `test_attack_noOneCanInitialiseAFinisherOrItsImplementation` (1) |
| F04 | Finisher: a failed sale may open again at once | `test_underMinimum_refundsEveryoneAndTheProjectTriesAgain` (1) |
| F05 | Finisher: a project that sold may open another sale | `test_openSale_aProjectThatAlreadySoldCannotSellAgain` (2) |
| F06 | Finisher: a second sale may open while one is open | `test_openSale_onlyTheFounderOpensAndOnlyThroughTheLauncher` (1) |
| F07 | Finisher: an abandoned project may open another sale | `test_abandon_gives15And82AndOpensExits` (1) |
| F08 | Finisher: step 1 runs the pool step again | `test_attack_aFailedPoolStepIsNeverSplitAsThoughThePoolExisted` (2) |
| F09 | Finisher: step 1 works on a project with no sale | `test_finish_stepsOnAProjectWithNoSaleRefuse` (1) |
| F10 | Finisher: step 2 does not know it is done | `test_attack_strangersCallTheStepsInEveryOrderAndRepeatThem` (2) |
| F11 | Finisher: step 2 works at any stage | `test_finish_stepsOnAProjectWithNoSaleRefuse` (1) |
| F12 | Finisher: step 2 does not need step 1 | `test_finish_eachStepRefusesWithItsOwnReasonWhenCalledTooEarly` (1) |
| F13 | Finisher: step 2 splits a sale that did not reach its minimum | `test_underMinimum_refundsEveryoneAndTheProjectTriesAgain` (1) |
| F14 | Finisher: step 2 splits the money when no pool exists (the swallowed failure) | `test_attack_aFailedPoolStepIsNeverSplitAsThoughThePoolExisted` (1) |
| F15 | Finisher: step 2 does not compare the money with the auction's figures | `test_settle_refusesWhenLessCameBackThanTheAuctionsFiguresSay` (1) |
| F16 | Finisher: step 3 does not need step 1 | `test_finish_eachStepRefusesWithItsOwnReasonWhenCalledTooEarly` (1) |
| F17 | Finisher: step 3 does not need step 2 | `test_attack_aFailedPoolStepIsNeverSplitAsThoughThePoolExisted` (2) |
| F18 | Finisher: step 3 does not tell a failed sale from a good one | `test_underMinimum_refundsEveryoneAndTheProjectTriesAgain` (1) |
| F19 | Finisher: a failed sale may retry from the block it failed in | `test_underMinimum_refundsEveryoneAndTheProjectTriesAgain` (1) |
| F20 | Finisher: step 3 does not know it is done | `test_attack_strangersCallTheStepsInEveryOrderAndRepeatThem` (3) |
| F21 | Finisher: step 3 works on a project with no sale | `test_finish_stepsOnAProjectWithNoSaleRefuse` (1) |
| F22 | Finisher: abandon works at any stage | `test_abandon_gives15And82AndOpensExits` (3) |
| F23 | Finisher: abandon works before seven days | `test_abandon_isNotUsableEarlyAndUsableOnTime` (1) |
| F24 | Finisher: abandon works on a sale that did not reach its minimum | `test_abandon_isRefusedForASaleThatFailedItsMinimum` (1) |
| F25 | Finisher: abandon works when a pool exists | `test_abandon_refusesWhenAPoolExists` (1) |
| F26 | Finisher: abandon does not run the pool step first | `test_abandon_refusesWhenAPoolExists` (2) |
| F27 | Finisher: abandon sends nothing to the floor alone (15 : 60 of everything) | `test_abandon_gives15And82AndOpensExits` (1) |
| F28 | Finisher: a guard that names someone else counts as the project's guard | `test_poolIsOpen_aPoolWhoseGuardNamesSomeoneElseIsNoPool` (1) |
| F29 | Finisher: a hook that answers nothing makes the answer revert | `test_poolIsOpen_aGuardThatIsNotAGuardIsNoPool` (1) |
| F30 | Finisher: a pool with no liquidity counts as open | `test_poolIsOpen_aPoolWithAPriceAndNoLiquidityIsNoPool` (1) |
| F31 | Finisher: no re-entry lock | `test_settle_aCallBackFromTheDollarTokenCannotReenter` (1) |
| F32 | Finisher: the pool key leaves out the guard (a stranger's plain pool counts) | `test_abandon_gives15And82AndOpensExits` (27) |
| H01 | LiquidityHolder: anyone's position may be collected, held or not | `test_holder_aPositionItDoesNotOwnCannotBeCollected` (1) |
| H03 | LiquidityHolder: a position of a stranger's plain pool of a project's Shares may be collected | `test_holder_aPlainPoolOfARealProjectsSharesIsNotTheProjectsPool` (1) |
| H04 | LiquidityHolder: the platform gets all the dollar fees | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (5) |
| H05 | LiquidityHolder: the project gets nothing of the dollar fees | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (5) |
| H06 | LiquidityHolder: the Share fees are kept, not burned | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (3) |
| H07 | LiquidityHolder: a platform address the token refuses stops the whole collect | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (2) |
| H08 | LiquidityHolder: a collect takes out liquidity (a decrease of one unit) | `test_holder_collectSplitsHalfToThePlatformHalfToTheProjectAndBurnsTheShares` (2) |
| H09 | LiquidityHolder: no re-entry lock | `test_holder_aCallBackFromTheDollarTokenCannotReenterCollect` (1) |
| H10 | LiquidityHolder: owed amounts are paid out and not cleared | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (1) |
| P01 | Pinned: the pool takes 20 of every 100 raised | `test_life_aWholeProjectLife` (2) |
| P02 | Pinned: the pool fee is 0.3 percent | `test_life_tradesFeesHandBackAndTheDailyRelease` (2) |
| P03 | Pinned: the pool tick spacing is 60 | `test_openSale_fillsInEverySettingFromTheSize` (1) |
| P04 | Pinned: the sale is 6,000 blocks | `test_attack_aDollarTokenThatFreezesAnAddressStopsTheFinishWithoutHalfDoingIt` (15) |
| P05 | Pinned: the pool state is read from the wrong storage slot | `test_drift_poolStateReadsMatchStateLibrary_local` (1) |
| P06 | Pinned: abandon opens after one day | `test_abandon_isNotUsableEarlyAndUsableOnTime` (1) |
| X01 | Treasury: anybody may mark the sale abandoned | `test_markAbandoned_onlyTheOpener_onceAndNotAfterThePoolOpened` (1) |
| X02 | Treasury: a sale may be abandoned after the pool opened | `test_markAbandoned_isRefusedOnceThePoolIsOpen` (2) |
| X03 | Treasury: anybody may put sale money wholly into the floor | `test_settleToFloor_onlyTheOpener_onlyWhenAbandoned_andOnlyWhatArrived` (1) |
| X04 | Treasury: money may be put wholly into the floor when the sale was not abandoned | `test_settleToFloor_onlyTheOpener_onlyWhenAbandoned_andOnlyWhatArrived` (1) |
| X05 | Treasury: more than arrived may be put into the floor | `test_settleToFloor_onlyTheOpener_onlyWhenAbandoned_andOnlyWhatArrived` (1) |
| X06 | Treasury: an abandoned sale does not start the Vester's clock | `test_abandon_gives15And82AndOpensExits` (2) |
| F33 | Finisher: a pool the pool step did not fund counts as this sale's pool (the fake pool after a failed step) | `test_attack_afterAFakePoolTheWayOutStillOpensAndPaysFifteenAndEightyTwo` (3) |
| F34 | Finisher: a pool that took only 5 of each 100 dollars of its budget counts | `test_measured_aGiftOfMoreThanHalfThePoolsBudgetHidesARealPool` (1) |
| F35 | Finisher: after the sale is done the pool is not reported open | `test_attack_abandonOnTheFirstBlockWithTheStepNeverRunLeavesTheSaleWhole` (1) |
| F36 | Finisher: after step 2 the pool is judged by the dollars held again (a gift can reopen the way out) | `test_attack_aGiftAfterStepTwoCannotOpenTheWayOutAgain` (1) |
| A31 | Launcher: the bid hook may have any closing window | `test_constructor_theBidRulesMustBeOneDollarFourTimesAndAClosingWindow` (1) |
| B01 | MinBid: bids are accepted in the closing window | `test_attack_aBidInTheClosingWindowIsRefused` (2) |
| B02 | MinBid: the window is one block short | `test_attack_aBidInTheClosingWindowIsRefused` (2) |
| H11 | LiquidityHolder: a guarded pool of a stranger's own token may be collected | `test_holder_aGuardedPoolOfAStrangersOwnTokenIsNoProjectsPool` (1) |
| H12 | LiquidityHolder: a token that answers false counts as paid | `test_holder_aTokenThatAnswersFalseForAFrozenPlatformKeepsItsHalfOwed` (1) |
| E01 | Launcher: SaleOpened is not emitted | `test_events_openingASale` (1) |
| E02 | Finisher: SaleOpenedBy is not emitted | `test_events_openingASale` (1) |
| E03 | Finisher: PoolStep is not emitted | `test_events_aSaleUnderItsMinimum` (3) |
| E04 | Finisher: PoolOpened is not emitted | `test_events_aStrangerRunsThePoolStepDirectly` (2) |
| E05 | Finisher: Settled is not emitted | `test_events_aStrangerRunsThePoolStepDirectly` (2) |
| E06 | Finisher: Swept is not emitted by sweep | `test_events_theThreeStepsOfAGoodFinish` (1) |
| E07 | Finisher: Swept is not emitted by abandon | `test_events_theWayOut` (1) |
| E08 | Finisher: SaleFailed is not emitted | `test_events_aSaleUnderItsMinimum` (1) |
| E09 | Finisher: Abandoned is not emitted | `test_events_theWayOut` (1) |
| E10 | LiquidityHolder: Collected is not emitted | `test_holder_collectSplitsHalfToThePlatformHalfToTheProjectAndBurnsTheShares` (1) |
| E11 | LiquidityHolder: Owed is not emitted | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (1) |
| E12 | LiquidityHolder: OwedSent is not emitted | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (1) |
| E13 | Treasury: PoolOpened is not emitted | `test_events_aStrangerRunsThePoolStepDirectly` (2) |
| E14 | Treasury: SaleAbandoned is not emitted | `test_events_theWayOut` (1) |
| E15 | Treasury: SaleClosed is not emitted | `test_events_theThreeStepsOfAGoodFinish` (2) |
| E16 | Treasury: the floor-only Settled is not emitted | `test_events_theWayOut` (1) |
| E17 | Treasury: Settled is not emitted by settle | `test_events_theThreeStepsOfAGoodFinish` (2) |

**Milestone 2's removals, re-run.** The Launcher was replaced and the Treasury's `settle` was reorganised, so I re-ran the milestone 2 list
against the milestone 2 suites: **90 entries, every one fails at least one test.** Eight entries of the old list are gone because the code they
guarded is gone (the chain-id refusal, and the checks of the old stub `openSale`: L02, L03, L04, L08, L11, L12, L14, L21; the new
constructor checks A01 to A11 replace them). Two entries' text had to be rewritten, because the code around them changed and the text
now matched twice or not at all (T06, the cap on what `settle` may split; L06, the exit fee ceiling), and both then failed a test. The
milestone 2 invariant-only runs were not repeated. ShareToken, Vester and RollingCap did not change in this milestone.

## The LiquidityHolder: what "for good" rests on, and what could still go wrong

The vendored position manager makes each pool position an ordinary NFT (ERC-721) that its owner may transfer, approve, burn or shrink.
So "for good" is a fact about the owner, which is the `LiquidityHolder`, and about what its code can do, which is two things:
`collect` (a decrease of **zero** liquidity, then a take of the fees to itself) and `sweepOwed`. What I did and tested:

* The strategy mints each position straight to the holder (`positionRecipient`), so nobody else ever owned one.
* The holder has **no** function that transfers, approves or burns a position or removes liquidity. A test reads the compiled contract's
  list of public functions and fails if it is anything but `collect`, `sweepOwed`, `owed` and three getters, and scans its code for
  `isValidSignature`, `onERC721Received` and `setApprovalForAll`.
* It does not implement `isValidSignature`, so a permit "signed by" the holder cannot exist (the position manager checks a contract
  owner's signature that way).
* Attackers (a stranger, the founder, the platform, the Treasury, the Finisher) tried to transfer it, approve themselves, decrease its
  liquidity, burn it, and permit themselves: all refused, and the position and every unit of its liquidity were unchanged.
* A `collect` leaves the liquidity unchanged (tested), and works for anyone, so nobody has to be trusted to call it.

**What could still go wrong, said exactly:**
1. A bug in Uniswap's position manager or pool manager (neither is ours, neither is audited by us) could move or lock the position.
2. If someone later adds a function to the holder, the test above fails first; that is the only protection against a future edit.
3. A dollar token that freezes the platform's address delays the platform's half of the fees (it waits in `owed`); a token that freezes
   the Treasury would stop `collect` entirely until unfrozen, because the project's half is paid by a call into the Treasury (by reading
   the code; not tested). Nothing is lost: the fees keep accruing in the position.
4. A stranger can send the holder any NFT. It stays there for ever, and cannot be collected unless its pool is a project's pool. The guard does not make
   a pool "ours": the strategy builds a guarded pool for anyone's token, and a holder of a project's Shares can build one at the project's own key once a failed
   pool step has freed it. So the holder's second check (one side of the pool is a real project's Shares, known to the Launcher) matters and is tested
   with a stranger's own token; a stranger's position in a project's guarded pool earns fees that are split like any other and reaches nobody's money.
5. The Shares the pool earns as fees are burned, which lowers the Share supply a little (and with it the 1% gift cap).

## The pinned interfaces and the drift test

First-party code never imports Uniswap's source. It uses `src/Pinned.sol`: copies of the structs (pool key, strategy settings, auction
settings, brackets, the auction's report) and small interfaces of the strategy, the auction, the factory, the fee controller, the
bid hook, the pool manager's storage reader and the position manager, plus the pool-state reader and the sale's shared numbers.
`test/PinnedDrift.t.sol` is the one test that fails if upstream moves. It checks: every selector we call against the vendored one;
every struct we copy encodes to the same bytes as the vendored struct; the pool manager's storage layout (price and liquidity of a
pool read by `PoolRead` equal Uniswap's own `StateLibrary` on a pool the strategy made, on the local twin and on the Sepolia fork);
the action numbers and hook bits we use; and, as the catch-all, **the hash of the creation code of the strategy, the auction factory
(which holds the auction), the pool manager, the position manager and our pool guard** (which holds Uniswap's hook base): one changed
byte in any of them fails it, with a message naming what to review. The hashes were taken on 16 November 2026 at the versions in
`M1-FACTS.md`. Its limit: it detects change, it does not say whether a change matters.

## Numbers I chose

* **Finisher per project, not one for all.** The strategy sends the money left over after the pool to one address in one transfer, and
  any stranger may run the pool step directly, so only an address that belongs to one project can tell whose money it is. The 500 million
  Shares (400M sale + 100M pool match) are minted to the Finisher at birth; the Launcher holds nothing.
* **Step 2 sends the Treasury every dollar the Finisher holds**, and uses the auction's own report of the raise only as the least that must
  be there (`afterFee - afterFee x 2,268,041 / 10,000,000`). The exact amount cannot be read from the raise, because the pool may take
  less than its budget (it is limited by the Shares it can pair). A dollar donated to the Finisher before step 2 is split like the rest.
* **"This sale's pool exists" means** (fix round) the pool manager holds liquidity at the project's guarded key, the guard names the strategy as the only
  creator (`poolAtTheKey`), **and** the pool step took this sale's money: at least half of the pool's dollar budget is missing from what the strategy returned
  to the Finisher. Read from the pool manager's storage and the auction, never from an event. A price with no liquidity does not count; a pool at the key
  that took none of this sale's money (made by someone else after a failed step) does not count; after step 2 it stays true.
* **Time is counted in blocks:** the sale 7,200 blocks, abandon after 50,400 blocks, retry 7,200 blocks after a failed sale ended. They are
  24 hours, 7 days and 24 hours only at 12 seconds a block (Ethereum and Sepolia). On another chain they are different lengths.
* **Abandon** runs the pool step itself if nobody did (so "nobody ever called it" is covered), reverts `PoolExists` if that makes a pool
  (the normal finish then applies), refuses a sale that did not reach its minimum (that path returns the Shares for a retry), and starts
  the Vester's clock (founder Shares must not stay locked behind a pool that will never open). A project whose sale was abandoned does not
  open another.
* **Retry after a sale under its minimum:** from 7,200 blocks after the failed sale ended, any of the three sizes. The 500 million Shares
  wait in the Finisher. A project that sold, or whose sale was abandoned, never opens another sale from this Launcher.
* **Founder only opens a sale; an agent cannot.** The task said "or a founder's agent inside caps". Opening a sale uses no dollars or
  Shares from any cap, so no cap could cover it, and plan section 6 says opening needs the runner's touch. The sale is irreversible
  (a project sells once), so it stays the founder's own call. Tested: an agent is refused.
* **LiquidityHolder keeps no list.** `collect(tokenId)` reads the position's pool from the position manager and accepts it only if its
  hook is the platform's guard and one side is a real project's Shares. "A position of a project that does not exist cannot be added"
  means: it can be sent there as a gift (anyone can send an NFT), but it can never be collected, split or used.
* **The platform's half of the fee does not stop the collect.** If the dollar token refuses to pay the platform's address (a frozen
  address), the amount waits in the holder (`owed`) and anyone may send it later; the project's half and the burn go through.
* **The 15 : 82 split uses one new Treasury function**, `settleToFloor`, callable only by the Finisher and only after an abandon.
* **Test files.** The milestone 3 tests and their base build at 0.8.37 and 200 runs (the 11,111-run setting ran out of stack in one of the large
  via-IR test contracts). Every test contract I wrote or changed is under the 49,152-byte creation-code limit: the three milestone 2 test
  contracts that milestone 3's bigger shared base had pushed over it were split, the milestone 3 suites are split into smaller bases, and the
  invariant test loads its handler from the build output. (Milestone 1's own test contracts, `Attacks`, `Pieces`, `Measure` and `Route`, still carry
  that warning, as they did.)

## Measured

### The bear-market drain (buy below the floor and hand back)

A sale at its goal (10,000 raised, Standard), finished. The pool opens at $0.000025 a Share; the floor pays $0.00001230 a Share before the
5% fee. Holders then sell Shares into the pool until its price is a chosen distance under the floor; a trader buys with `x` dollars and
hands every Share straight back. All fees and the price the trade moves are included. Gas is separate.

| Pool price vs the floor | Spend 20 dollars | Spend 200 dollars | Spend 1,000 dollars |
|---|---|---|---|
| no dump: the pool at its opening price, 2.03 times the floor | loss 10.83 | loss 115.13 | loss 681.01 |
| 1.7% under | loss 1.10 | loss 30.46 | loss 418.82 |
| 4.7% under | loss 0.50 | loss 25.43 | loss 404.16 |
| 6.2% under | loss 0.20 | loss 22.89 | loss 396.79 |
| **7.6% under** | **profit 0.10** | loss 20.33 | loss 389.40 |
| 9.0% under | profit 0.40 | loss 17.76 | loss 381.98 |
| 10.3% under | profit 0.71 | loss 15.17 | loss 374.54 |
| 15.5% under | profit 1.95 | loss 4.66 | loss 344.52 |

Gas of the trade: about 130,000 to buy and 62,000 to hand back (units). **It stops paying a little above 6% under the floor for a tiny
trade, 7.6% in my steps, and never in this pool for a 200-dollar trade even 15% under.** The plan's "more than about 5%" counted the exit
fee alone: the pool's own 1% fee and the price the trade itself moves in a 2,200-dollar pool add to it. After gas (at 10 gwei and 3,000
dollars an ETH, both outside knowledge, 190,000 gas is about 5.70 dollars) the 20-dollar trade at 15.5% under (profit 1.95) loses, so only
a larger trade at a deeper discount pays, and a larger trade moves the price against itself. The drain is real and bounded: it takes
price falls past the floor in a thin pool, and each hand back leaves the leaver's 4% to those who stay.

### Sniping the pool in its first block

Dollars in the pool and the average price paid, against the opening price (Standard and Small sales at their goal):

| | Pool | Buy 100 dollars | Buy 2,500 dollars | Sell 100 dollars' worth | Sell 2,500 dollars' worth |
|---|---|---|---|---|---|
| **Standard** | 2,200 dollars, 88.0M Shares | price up 9.2%, avg 5.5% above | price up 351.5%, avg 114.6% above | price down 8.4%, avg 5.2% below | price down 77.8%, avg 53.4% below |
| **Small** | 880 dollars, 88.0M Shares | price up 23.7%, avg 12.3% above | price up 1,353.5%, avg 285.1% above | price down 19.2%, avg 11.0% below | price down 93.1%, avg 74.0% below |

The pools are small, as section 9 warned. A 2,500-dollar buy at the Small size multiplies the price by 14.5. Nothing in the contracts stops
this; the page has to show the pool's depth next to the price.

### A founder dump at pool open

Founder Shares (200 million) and Shares given before the pool opens sit in the Vester and release evenly over 365 days from the moment
the pool opens: at that moment nothing is released and `claim` pays nothing (tested for the founder, a friend, and a second wallet).
After one day exactly 1/365 of each grant is claimable. No grant can be added once the clock has started. What the plan allows, measured:
Shares given **after** the pool opens are free at once, at most 1% of all Shares (10 million) in 30 days. Nine million Shares given to a
fresh wallet and sold into a Standard pool at once move the price from $0.0000250 to $0.0000206 (down 17.5%) and raise 202.27 dollars.

### A founder bidding in their own sale (Standard, 10,000 dollars of honest demand)

| Founder's extra bid | Final price | Honest bidders' Shares | Founder spends | Founder gets | Platform and pool share of that spend (not recoverable) |
|---|---|---|---|---|---|
| none | 1.00 x floor | 400.0M (100%) | 0 | 0 | 0 |
| 5,000 | 1.49 x | 266.7M (66%) | 5,000 | 133.3M | 1,250 |
| 20,000 | 2.99 x | 133.3M (33%) | 20,000 | 266.7M | 5,000 |
| 100,000 | 4.00 x (the cap) | 36.4M (9%) | 36,364 | 363.6M | 9,091 |

How much the price can be pulled **in one block**: from 1x to 4x (this table has every bid in the first block, when the price is the floor), at a cost
of 25% of what the founder spends (the 3 to the platform and 22 into the pool; the 15 returns to the founder's own spendable, the 60 is the floor that every
holder, the founder included, can hand back against). **The honest bidders pay the most: at 4x they get 9% of the Shares their money would have bought.**
**This is not a ceiling.** The rule (corrected in the fix round) is "4 times the clearing price at the time of that bid", so bids some blocks apart
climb: a ladder of four bids 20 blocks apart took the same sale to 4x, 16x, 64x, 256x the floor (see "Fix round"). The only limit is the cost, 25 of each 100
spent. Nothing on chain tells a founder's second account from anyone else's.

### Two projects at the same time

Two projects (Standard and Small) opened sales in the same block, took bids in turn, were finished by different strangers in an interleaved
order (A's pool step, B's pool step, B settle, A settle, A sweep, B sweep), traded in both pools and had their fees collected: each ended
exactly as it would alone, one holder owns both positions, and each Treasury received only its own fees. This was untested in milestone 1.

### Gas

Measured in the Foundry test VM on the local twin, every contract made cold first, execution gas only (no 21,000 base, no call data).
Our contracts at 0.8.37 / 200 runs; the vendored auction and strategy at their own 11,111 runs, so their 4 million does not shrink.

| Step | Gas |
|---|---|
| **Open the sale** (`Launcher.openSale`, Standard: Finisher, strategy, a new auction) | 4,380,084 |
| **A batched passkey-style call: start the project and open the sale** | 5,262,795 |
| Start a project (`launch`: four clones, allocation, setup), first founder / another | 904,456 / 894,447 |
| Step 1 `openPool` (sweep, 3% fee, make the pool, mint the position) | 766,203 |
| Step 2 `settle` (read the pool, send, mark open, split) | 271,524 |
| Step 3 `sweep` (unsold Shares to the Treasury, close the sale) | 67,081 |
| `LiquidityHolder.collect` | 262,173 |
| `abandon`, pool step already run / running the failing step itself | 306,784 / 724,725 |
| Deploy the Launcher (five implementations inside) | 7,503,861 |

Milestone 2's numbers that changed: Launcher.launch 752,006 to 904,456 (a fourth clone), deploy 4,529,986 to 7,503,861. The whole platform
deployment, simulated against a Sepolia fork with the script outline (below), estimated 26,974,221 gas over seven transactions, the
largest being the Launcher (10.5 million as estimated by the script, with its safety margin), the factory 6.8 million and the strategy
6.7 million. **What exceeds typical limits (outside knowledge, not checked against any sponsor):** a 5.26 million batch is about 9% of a
60 million block and under the 16.7 million per-transaction cap I remember from late 2025; whether a fee sponsor accepts a 5 million gas
operation is still unchecked, as in milestone 1. The Launcher's deployment (10.5 million) is also under that cap but is a one-off by the
platform, not a sponsored action.

### Mined addresses (strategy and pool guard)

Each must sit at an address whose lowest 14 bits are exactly 0x2000, about one salt in 16,384. **Measured (16 different deployers, our
own in-EVM search):** the strategy needed 13,750 tries on average (the worst of 16 was 61,305), the guard 23,906 (worst 73,014). **Off chain
with `cast create2 --ends-with 2000`** (one fitting suffix out of four, so four times the work needed): 15 milliseconds for the strategy and
5 milliseconds for the guard on this machine's four cores. The deploy script outline mined them on a Sepolia fork in 19,815 and 1,999
tries inside the simulation. So the cost is seconds of computer time, not money, and **every network needs its own mined strategy and its own
guard** (the guard names the strategy), and a deployment must come with the CREATE2 deployer present (it is on Sepolia).

## What the plan got wrong or left loose

1. **"Settle the Treasury from the auction's own reported total" cannot be exact.** What comes back after the pool is the raise less the
   3 less whatever the pool actually took, and the pool takes less than its budget whenever the Shares side limits it. The Finisher moves
   what it holds and uses the auction's figure as a minimum.
2. **The M2 "a stranger splits a small part first" window is closed by design, not by a check.** The Treasury refuses to split until the pool
   is marked open, only the Finisher can mark it, and the money reaches the Treasury only inside that same transaction. A stranger can
   still send dollars to the Treasury and call `settle` after the pool is open: a gift split 15 : 60.
3. **Section 4, anti-drain rule 2, "about 5%", is 6% at least and 7.6% in practice for a tiny trade**, and nothing in this pool for a trade
   of 200 dollars or more. See the table. The rule is stronger than the plan said, for the reason that the pool is thin.
4. **The floor-per-share example** (48%) is 49.2% for a sale at its goal and 35.4% when demand lifts the price 3x, because the pool's
   Shares count (owner call 1).
5. **Sections 3 and 8, "later sales from the reserve", need a decision before anything real.** In this Launcher the Treasury's only sale
   path is the Launcher itself, and the Launcher has no function that takes reserve Shares (the task said later rounds are not this
   milestone). So **the reserve, the unsold Shares and the unused pool Shares are plain reserve that cannot leave the Treasury**, for every
   project born on this Launcher. The Launcher cannot be extended after it is deployed, and a Treasury's sale path is fixed at birth, so
   milestone 8 means a new Launcher and new projects, or a function added to this Launcher before any real deployment. Written here because it
   is the one thing in this milestone that is easy to forget until it is expensive.
6. **Sniping and thin pools are worse than "prices will jump"** (section 9): a 100-dollar buy moves a Small pool 24% and a 2,500-dollar buy
   multiplies its price by 14.5.
7. **The founder's own bids** can hand honest bidders 9% of what their money would have bought (table above), at a cost to the founder of 25%
   of the extra spend. **Corrected in the fix round:** the 4-times rule is against the price at the time of each bid, so it is not "the whole defence"
   and not a ceiling: the price can climb 4x, 16x, 64x, 256x over several blocks. The defence is the cost (25 of each 100 spent is gone for good); the
   closing window stops the cheap last-minute version of the same move.
8. **Section 5, "the app reads the outcome from the strategy's event":** the strategy's events say success on a failed step (milestone 1). The
   outcome is `Finisher.poolIsOpen()`, which reads the pool manager. The app and the server must use that, not the event.
9. **The size table was high again** (Launcher estimated 400 lines, built 325 code lines; but the Finisher, 195, is not in the plan's table).

## What milestone 4 (the server reading the chain) must index

Everything below is an event (or a view) of a contract in this milestone. Indexed fields are marked (i).

**Launcher** (one per network):
* `ProjectLaunched(projectId (i), founder (i), shares, treasury, vester, finisher, quote, platform, Allocation{sale, poolReserve, founder,
  workPot, reserve}, Settings{quote, platform, exitFeeBps, platformFeeBps, spendableParts, floorParts, agentUsd, agentShares})`. A signed project
  record is matched by (founder, projectId).
* `SaleOpened(projectId (i), founder (i), auction (i), finisher, size {0 Small, 1 Standard, 2 Large}, goal, minimum, startBlock, endBlock,
  floorPriceQ96, tickSpacingQ96)`: the sale's figures, in raw dollars (6 decimals) and the auction's Q96 price units.
* `SettingsChanged`, `AdminChanged` (only for the settings screen).

**Finisher** (one per project; the server follows each one from `ProjectLaunched`); every event below is asserted with its figures in `FinishEvents.t.sol`:
* `SaleOpenedBy(auction (i), endBlock, attempt)`; `PoolStep(auction (i), poolOpen)` (the true outcome, read from the pool manager; **may be missing**: anyone may call
  the strategy's `migrate` directly, then the Finisher emits no `PoolStep`, and the server learns of the pool from step 2);
  `PoolOpened(auction (i), poolId, sqrtPriceX96, poolDollars, poolShares)` (new; always from step 2; the two amounts read low if someone sent dollars or Shares to the Finisher
  before step 2); `Settled(auction (i), raised, afterFee, toTreasury)`; `Swept(auction (i), sharesToTreasury)`; `SaleFailed(auction (i), retryBlock)`;
  `Abandoned(auction (i), toFloorOnly, split)`. After an abandon the Treasury emits two `Settled` events, the first (amount, 0, amount) the floor-only part
  (the same shape as an ordinary one), so the server must read `Abandoned` (or `SaleAbandoned`) to tell the two apart.
* Views to read each time: `stage()` (0 Idle, 1 Open, 2 Done, 3 Failed, 4 Abandoned), `poolIsOpen()`, `settled()`, `endBlock()`,
  `retryBlock()`, `abandonBlock()`, `auction()`, `canOpen()`, `poolKey()`.

**Treasury** (one per project): `PoolOpened(time)`, `SaleAbandoned(time)`, `SaleClosed(time)`, `Settled(amount, toSpendable, toFloor)`,
`Released`, `CheckedIn`, `Spent`, `SharesGiven`, `HandedBack(holder, shares, paid, toPlatform, stays)`, `ShareRevenue`, `ToppedUp` (the pool
fee's project half arrives as `ToppedUp` with `from` = the LiquidityHolder), `FeesSwept`, `AgentSet`, `ReserveReleased`.

**LiquidityHolder**: `Collected(tokenId (i), treasury (i), dollars, toPlatform, toProject, sharesBurned)`, `Owed(token (i), to (i), amount)`, `OwedSent(token (i), to (i), amount)`. The position's
token id is in no first-party event (nothing on chain can find it in bounded work); it is the ERC-721 `Transfer(0, holder, tokenId)` of the position manager in the pool
step's transaction (the project's one full-range position), and `positionManager.getPoolAndPositionInfo(tokenId)` gives its pool key to check against `poolKey()`.

**Auction** (from `SaleOpened.auction`): `BidSubmitted(id (i), owner (i), priceQ96, amount)`, `BidExited`, `TokensClaimed`,
`CheckpointUpdated(blockNumber, clearingPriceQ96, cumulativeMps)`, `ClearingPriceUpdated`. **Strategy:** `Migrated`, `MigrationFailed`,
`FundsRecovered` (shown for the record; do not trust them for the outcome). **Pool manager:** `Swap(id (i), sender (i), amount0, amount1,
sqrtPriceX96, liquidity, tick, fee)` for the chart, filtered by the project's pool id (`keccak256(abi.encode(poolKey))`); `Initialize`. **ShareToken:**
`Transfer`, `Approval`. **Vester:** `Started`, `Claimed`.

**The helper job's calls** (all open to anyone): after `endBlock + 1`, `finisher.openPool()`, then `settle()`, then `sweep()`, each safe to
repeat; bidders' `exitBid`/`exitPartiallyFilledBid` and `claimTokens` (hints found by walking the auction's checkpoints); every so often
`holder.collect(tokenId)`; after `abandonBlock()` with no pool, `finisher.abandon()`. It must skip dust, cap its spending, and write each step
down before trying it (section 7).

## What still blocks any real deployment

* **An outside review** of the whole set, and of the vendored strategy (v3.0.0, no audit listed in the vendored docs) and auction (audited
  at v2.0.0, vendored at v2.1.0 plus two commits). This milestone adds about 700 lines of code to review (Launcher 325, Finisher 195,
  LiquidityHolder 83, Pinned 110), with the Treasury changes.
* **The strategy's licence** (two BUSL-1.1 files of Uniswap's pool code reach its bytecode): counsel.
* **A mined strategy and guard per network, and the CREATE2 deployer on that network.** The script outline simulates on Sepolia only.
* **Which dollar token.** A token that can freeze addresses can stop the pool step until it is unfrozen (the strategy cannot pay a frozen
  fee recipient or a frozen Finisher; tested): nothing is lost, but the finish waits. **Abandon does not help here** (fix round, tested): it runs the pool
  step itself, and when that step reverts for good (a frozen fee recipient: the auction pays its 3% only through the strategy) `abandon`, `openPool` and every
  exit wait with it, for every project at once. Abandon covers a step that never ran and one that failed and was swallowed. A freezable token or fee-recipient
  address is a single point of failure for the platform; choose a token that cannot freeze, or accept that. A token that takes a fee on transfer breaks the
  sale itself. The platform must name a plain 6-decimal token.
* **The 12-second block assumption** behind 24 hours, 7 days and the retry wait. Chains with other block times need their own numbers.
* **The sealed reserve** (point 5 above) and the **two open owner decisions** (B2 accepted, B3 open).
* **Whether a fee sponsor accepts a 5 million gas action**, and the passkey account's own limits.
* **The position manager and pool manager are Uniswap's and unaudited by us.** If they had a bug, the LiquidityHolder could not protect
  the pool.
* **No one has read the server side.** Milestone 4 does not exist yet; nothing finishes a sale until it does.

## What I ran

Run from `contracts/next` on this machine (`forge 1.4.3`, solc 0.8.37 for first-party code, 0.8.26 for milestone 1 and the vendored code), 16 November 2026.

| Gate | Result |
|---|---|
| `forge build` | passes. A forced rebuild prints compiler warnings only of the kinds milestone 1 and 2 had (style lints on test code, the creation-code size of milestone 1's four big test contracts and the Deployer's code size). **None from `src/`.** In my new test files: lint notes for unnamed return variables and unchecked token calls in test code. |
| `forge test`, no node (`SEPOLIA_RPC_URL` unset) | **346 passed, 0 failed, 36 skipped** in 88 suites (34 skips are fork suites saying they have no node; 2 are the reviewers' held-back B2 and B3 tests). Before the fix round: 320 passed; before this milestone: 241. Fuzz at 1,000 runs and the invariant suites at 256 runs of depth 200 are inside this run. |
| `forge test` with the public Sepolia node | **471 passed, 0 failed, 2 skipped** in 88 suites (before the fix round: 421). The fork suites ran at a recent block (the node's head minus 3; the head was about 12,151,400 when the run was made), because the pinned block is no longer served, so the suites move to a recent block and say so. The fork tests do not depend on the block; the numbers in this report are identical on the local twin and on the fork. |
| New test functions in milestone 3 | about 90 (the same test runs on the local twin and on the fork, in both token orders for the whole life): Life 4, FinishAttacks 13, SaleRules 10, MarketAttacks 6, LiquidityHolder 8, FinisherPool 6, PinnedDrift 6, TreasuryAbandon 5, LifeFuzz 2, LifeInvariants 9, GasM3 4, MinedCost 1, and 6 more Launcher tests |
| Fuzz | **2,000 runs** of the whole-sale conservation test (random size, random bids at random times and prices, random finish order, every bidder collects) with a reach test beside it: of 90 sales taken in order, 52 reached their minimum, 38 did not, and the auction refused 88 of 495 bids by its own price rules. Milestone 2's fuzz counts are unchanged (1,000 to 3,000). |
| Invariants | milestone 3: **9 invariants, each 256 runs of depth 200 (51,200 calls each, 460,800 in all)** on the real platform, with a handler of 14 actions (bids, time, the three steps by any stranger, the strategy's pool step called directly, a failing pool step, abandon, a week passing, a new try, claims, trades, fee collection, hand backs, check-ins, donations). Reach over those 460,800 calls: 1,410 bids placed, 9,828 pool steps, 1,184 settles, 5,158 sweeps, 421 abandons, 1,937 new tries, 1,337 claims, 4,119 trades, 4,573 fee collections, 1,253 hand backs. Milestone 2's 15 invariants (256 runs of depth 200) still pass. |
| `forge fmt --check src test` | clean |
| `forge build --sizes` | Launcher 39,945 bytes of creation code (limit 49,152), Finisher 8,278, LiquidityHolder 3,918, Treasury 10,254 |
| The guard-removal script, milestone 3 entries | **109 of 109 caught.** 83 of the first round were run twice (first round, then in three copies of the project after the review fixes); the 26 fix-round entries (F33 to F36, A31, B01, B02, H11, H12, E01 to E17) were run again one at a time on the final tree (`python3 scripts/mutate-guards.py F33 ... E17`): each made 1 to 3 tests fail, none failed to compile, the tree was clean afterwards. B01 reported "old string count 0" in one of the three-copy runs (a copy out of date), and was caught in the final run. The 83 older entries were not run a third time after the last test-file split (commit a81d00535, tests only). |
| The guard-removal script, milestone 2 entries | **90 of 90 caught** (`M2_ONLY=1 python3 scripts/mutate-guards.py`), see above |
| The deploy script outline | `forge script script/DeployPlatform.s.sol --fork-url <Sepolia>` (a simulation, nothing sent): runs, 26,974,221 gas estimated over seven transactions, strategy mined in 19,815 tries, guard in 1,999 |
| `git diff --stat 06343285a` (the commit before milestone 3) | 48 files changed, about 8,150 insertions, 317 deletions (with this report and the plan's fix-round section): 46 under `contracts/next`, `docs/NEXT-VERSION-PLAN.md`, and `docs/next-version/M3-REPORT.md`. Nothing under `contracts/src`, `contracts/test`, `contracts/script`, `contracts/lib`, `web`, `crates` or `packages`. |

What was not run: nothing on a real network; no key; the old suite in `contracts/`; any external review; the server side (milestone 4 does not exist).


## What I did not do

* No deployment, no key, no real network. The deploy script is an outline, simulated against a Sepolia fork only.
* The trade through Uniswap's UniversalRouter is milestone 1's test; milestone 3's trades use Uniswap's own test router (`PoolSwapTest`,
  deployed on Sepolia), because the router's calls are the same pool and the same hook-free path.
* A later-round sale from the reserve, as asked.
* No change to the gift rules (B3) or to the exit rule (B2).
* No external review.
