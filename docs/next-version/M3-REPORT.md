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
   owner; the bid hook is 1 dollar and 4 times. The size menu is fixed (goal 4,000 / 10,000 / 50,000; minimum 2,000 / 2,500 / 12,500;
   24-hour sale; smallest bid 1 dollar; 4-times cap through the bid hook). `launch` still takes the settings hash the founder saw.
7. **Compiler.** First-party code, and the milestone 3 tests, build with 0.8.37 and 200 runs; the vendored strategy and auction stay at
   their own pins and are reached only through `Pinned.sol`. One drift test (`PinnedDrift.t.sol`) fails if upstream changes (below).
8. **Licence with counsel; nothing deployed; a mined strategy address per network.** The licence question is untouched. The search cost I
   measured is in "Mined addresses".

## What exists

| File | Job | Lines (file / code only) |
|---|---|---|
| `Launcher.sol` | Makes a project (four clones), opens its one sale with every setting filled in, checks the platform's stack at construction | 468 / 325 |
| `Finisher.sol` | Per project: holds the sale Shares, three-step finish, abandon, reads the pool | 320 / 195 |
| `LiquidityHolder.sol` | Owns the positions, collects and splits fees | 143 / 83 |
| `Pinned.sol` | Copies of the vendored structs and interfaces, the pool-state reader, the sale's shared numbers | 195 / 110 |
| `Treasury.sol` | Two additions: abandoned state, floor-only split | 523 / 336 (was 484 / 312) |
| `Interfaces.sol` | Two more small interfaces | 71 / 34 |

The plan estimated Launcher 400, LiquidityHolder 120, PoolGuard 30, Pinned interfaces 150 lines: these come to 325 + 195 (Finisher, not in the
plan's table) + 83 + 110 code lines. Contract sizes: Launcher 9,533 bytes of code and 38,998 of creation code (limit 49,152, so
it deploys), Finisher 7,064, LiquidityHolder 3,737, Treasury 10,209.

## The rules, where they live, and the test that fails without them

Every guard added or changed in this milestone was **removed once, in its own run** (`contracts/next/scripts/mutate-guards.py`, which holds the
list), the file restored from git after each, and the suites that should catch it run (the finish, sale, Launcher, holder, Treasury or drift
suites, local twin only; the fork copies run the same tests). **83 removals, run twice (once, then again after the test files were split into smaller contracts); every one made at least one test fail in both runs**; none failed to compile. The table is the second run. The number in
brackets is how many tests failed in all. The id letters: F = Finisher, A = Launcher, H = LiquidityHolder, P = the numbers in `Pinned.sol`, X = the
Treasury's abandoned state.

How the runs found real weaknesses, and what I did about them:
* **P06** (abandon after one day instead of seven) was not caught on the first run, because the tests took the seven-day number from the
  same constant that was changed. The tests now write the numbers out (50,400 blocks, the pool rate, the fee, the tick spacing, the
  sale and pool Share amounts), and the removal is caught.
* **H02** (a check in the LiquidityHolder that exactly one side of the position's pool is a project's Shares) was not caught, because it can
  never be reached: a pool with the platform's guard as its hook can only be made by the strategy for a project's sale. I deleted the
  check and kept the hook test, which is the one that matters (its removal, H03, is caught).

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
| A08 | Launcher: the smallest bid may be anything | `test_constructor_theBidRulesMustBeOneDollarAndFourTimes` (1) |
| A09 | Launcher: the top-price cap may be anything | `test_constructor_theBidRulesMustBeOneDollarAndFourTimes` (1) |
| A10 | Launcher: the strategy may be no contract | `test_constructor_theFeeMustBeExactlyThreePercentAndHaveNoOwner` (1) |
| A11 | Launcher: the bid hook may be no contract | `test_constructor_refusesBadSettings` (1) |
| A12 | Launcher: the Treasury trusts the founder as its opener | `testFuzz_attack_aStrangerCannotMakeTheFounderLoseRelease` (26) |
| A13 | Launcher: the Treasury trusts the founder as its sale path | `test_attack_theAdminCanChangeTheSettingsInTheBlockBeforeALaunch` (3) |
| A14 | Launcher: the sale Shares are minted to the Launcher, not the Finisher | `testFuzz_attack_changingTheCountingSupplyNeverPaysTheSender` (26) |
| A15 | Launcher: the holder cannot tell which Treasury a project's Shares belong to | `test_launch_recordsTheProjectUnderFounderAndId` (2) |
| A16 | Launcher: the sale raises the current dollar setting, not the project's own (strategy side) | `test_openSale_theProjectsOwnDollarTokenIsUsedNotTheCurrentSetting` (1) |
| A17 | Launcher: the sale raises the current dollar setting, not the project's own (auction side) | `test_openSale_theProjectsOwnDollarTokenIsUsedNotTheCurrentSetting` (1) |
| A18 | Launcher: the pool position goes to the Finisher, not the LiquidityHolder | `test_life_aWholeProjectLife` (3) |
| A19 | Launcher: what the pool leaves goes to the founder | `test_attack_aDollarTokenThatFreezesAnAddressStopsTheFinishWithoutHalfDoingIt` (8) |
| A20 | Launcher: the unsold Shares go to the founder | `test_life_aWholeProjectLife` (7) |
| A21 | Launcher: no bid rules | `test_bids_aTopPriceAboveFourTimesIsRefusedAndFourTimesIsNot` (4) |
| A22 | Launcher: the pool has no guard | `test_attack_aDollarTokenThatFreezesAnAddressStopsTheFinishWithoutHalfDoingIt` (14) |
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
| F32 | Finisher: the pool key leaves out the guard (a stranger's plain pool counts) | `test_abandon_gives15And82AndOpensExits` (26) |
| H01 | LiquidityHolder: anyone's position may be collected, held or not | `test_holder_aPositionItDoesNotOwnCannotBeCollected` (1) |
| H03 | LiquidityHolder: a position of a stranger's plain pool of a project's Shares may be collected | `test_holder_aPlainPoolOfARealProjectsSharesIsNotTheProjectsPool` (2) |
| H04 | LiquidityHolder: the platform gets all the dollar fees | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (4) |
| H05 | LiquidityHolder: the project gets nothing of the dollar fees | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (4) |
| H06 | LiquidityHolder: the Share fees are kept, not burned | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (3) |
| H07 | LiquidityHolder: a platform address the token refuses stops the whole collect | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (1) |
| H08 | LiquidityHolder: a collect takes out liquidity (a decrease of one unit) | `test_holder_collectSplitsHalfToThePlatformHalfToTheProjectAndBurnsTheShares` (2) |
| H09 | LiquidityHolder: no re-entry lock | `test_holder_aCallBackFromTheDollarTokenCannotReenterCollect` (1) |
| H10 | LiquidityHolder: owed amounts are paid out and not cleared | `test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf` (1) |
| P01 | Pinned: the pool takes 20 of every 100 raised | `test_life_aWholeProjectLife` (2) |
| P02 | Pinned: the pool fee is 0.3 percent | `test_life_tradesFeesHandBackAndTheDailyRelease` (2) |
| P03 | Pinned: the pool tick spacing is 60 | `test_openSale_fillsInEverySettingFromTheSize` (1) |
| P04 | Pinned: the sale is 6,000 blocks | `test_attack_aDollarTokenThatFreezesAnAddressStopsTheFinishWithoutHalfDoingIt` (14) |
| P05 | Pinned: the pool state is read from the wrong storage slot | `test_drift_poolStateReadsMatchStateLibrary_local` (1) |
| P06 | Pinned: abandon opens after one day | `test_abandon_isNotUsableEarlyAndUsableOnTime` (1) |
| X01 | Treasury: anybody may mark the sale abandoned | `test_markAbandoned_onlyTheOpener_onceAndNotAfterThePoolOpened` (1) |
| X02 | Treasury: a sale may be abandoned after the pool opened | `test_markAbandoned_isRefusedOnceThePoolIsOpen` (2) |
| X03 | Treasury: anybody may put sale money wholly into the floor | `test_settleToFloor_onlyTheOpener_onlyWhenAbandoned_andOnlyWhatArrived` (1) |
| X04 | Treasury: money may be put wholly into the floor when the sale was not abandoned | `test_settleToFloor_onlyTheOpener_onlyWhenAbandoned_andOnlyWhatArrived` (1) |
| X05 | Treasury: more than arrived may be put into the floor | `test_settleToFloor_onlyTheOpener_onlyWhenAbandoned_andOnlyWhatArrived` (1) |
| X06 | Treasury: an abandoned sale does not start the Vester's clock | `test_abandon_gives15And82AndOpensExits` (2) |

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
4. A stranger can send the holder any NFT. It stays there for ever, and cannot be collected unless its pool is a project's pool.
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
* **"A pool exists" means** the pool manager holds liquidity at the project's guarded key, and the guard names the strategy as the only
  creator. Read from the pool manager's storage, never from an event. A price with no liquidity does not count.
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

How much the price can be pulled: from 1x to the 4-times cap, at a cost of 25% of what the founder spends (the 3 to the platform and 22 into
the pool; the 15 returns to the founder's own spendable, the 60 is the floor that every holder, the founder included, can hand back
against). **The honest bidders pay the most: at the cap they get 9% of the Shares their money would have bought.** The 4-times cap
bounds this; it does not prevent it. Nothing on chain tells a founder's second account from anyone else's.

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
   of the extra spend. The 4-times cap is the whole defence.
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

**Finisher** (one per project; the server follows each one from `ProjectLaunched`):
* `SaleOpenedBy(auction (i), endBlock, attempt)`; `PoolStep(auction (i), poolOpen)` (the true outcome, read from the pool manager);
  `Settled(auction (i), raised, afterFee, toTreasury)`; `Swept(auction (i), sharesToTreasury)`; `SaleFailed(auction (i), retryBlock)`;
  `Abandoned(auction (i), toFloorOnly, split)`.
* Views to read each time: `stage()` (0 Idle, 1 Open, 2 Done, 3 Failed, 4 Abandoned), `poolIsOpen()`, `settled()`, `endBlock()`,
  `retryBlock()`, `abandonBlock()`, `auction()`, `canOpen()`, `poolKey()`.

**Treasury** (one per project): `PoolOpened(time)`, `SaleAbandoned(time)`, `SaleClosed(time)`, `Settled(amount, toSpendable, toFloor)`,
`Released`, `CheckedIn`, `Spent`, `SharesGiven`, `HandedBack(holder, shares, paid, toPlatform, stays)`, `ShareRevenue`, `ToppedUp` (the pool
fee's project half arrives as `ToppedUp` with `from` = the LiquidityHolder), `FeesSwept`, `AgentSet`, `ReserveReleased`.

**LiquidityHolder**: `Collected(tokenId (i), treasury (i), dollars, toPlatform, toProject, sharesBurned)`, `Owed`, `OwedSent`. The position's
token id is found in the pool step's transaction as the ERC-721 `Transfer(0, holder, tokenId)` of the position manager (the project's one
full-range position); it is also `positionManager.nextTokenId()` read just before the step.

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
  fee recipient or a frozen Finisher; tested): nothing is lost, but the finish waits. A token that takes a fee on transfer breaks the
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
| `forge test`, no node (`SEPOLIA_RPC_URL` unset) | **320 passed, 0 failed, 29 skipped** in 73 suites (27 skips are fork suites saying they have no node; 2 are the reviewers' held-back B2 and B3 tests). Before this milestone: 241 passed. |
| `forge test` with the public Sepolia node | **421 passed, 0 failed, 2 skipped** in 73 suites. Every milestone 3 fork suite ran at **block 12,150,279** (the node's head minus 3: the pinned block is no longer served, so the suites move to a recent block and say so). The fork tests do not depend on the block; the numbers in this report are identical on the local twin and on the fork. |
| New test functions in milestone 3 | about 90 (the same test runs on the local twin and on the fork, in both token orders for the whole life): Life 4, FinishAttacks 13, SaleRules 10, MarketAttacks 6, LiquidityHolder 8, FinisherPool 6, PinnedDrift 6, TreasuryAbandon 5, LifeFuzz 2, LifeInvariants 9, GasM3 4, MinedCost 1, and 6 more Launcher tests |
| Fuzz | **2,000 runs** of the whole-sale conservation test (random size, random bids at random times and prices, random finish order, every bidder collects) with a reach test beside it: of 90 sales taken in order, 52 reached their minimum, 38 did not, and the auction refused 88 of 495 bids by its own price rules. Milestone 2's fuzz counts are unchanged (1,000 to 3,000). |
| Invariants | milestone 3: **9 invariants, each 256 runs of depth 200 (51,200 calls each, 460,800 in all)** on the real platform, with a handler of 14 actions (bids, time, the three steps by any stranger, the strategy's pool step called directly, a failing pool step, abandon, a week passing, a new try, claims, trades, fee collection, hand backs, check-ins, donations). Reach over those 460,800 calls: 1,410 bids placed, 9,828 pool steps, 1,184 settles, 5,158 sweeps, 421 abandons, 1,937 new tries, 1,337 claims, 4,119 trades, 4,573 fee collections, 1,253 hand backs. Milestone 2's 15 invariants (256 runs of depth 200) still pass. |
| `forge fmt --check src test` | clean |
| `forge build --sizes` | Launcher 38,998 bytes of creation code (limit 49,152), Finisher 7,478, LiquidityHolder 3,945, Treasury 10,254 |
| The guard-removal script, milestone 3 entries | **83 of 83 caught** (`python3 scripts/mutate-guards.py --m3`, run in three copies of the project at once) |
| The guard-removal script, milestone 2 entries | **90 of 90 caught** (`M2_ONLY=1 python3 scripts/mutate-guards.py`), see above |
| The deploy script outline | `forge script script/DeployPlatform.s.sol --fork-url <Sepolia>` (a simulation, nothing sent): runs, 26,974,221 gas estimated over seven transactions, strategy mined in 19,815 tries, guard in 1,999 |
| `git diff --stat 06343285a..HEAD` | @@DIFFSTAT@@ |

What was not run: nothing on a real network; no key; the old suite in `contracts/`; any external review; the server side (milestone 4 does not exist).


## What I did not do

* No deployment, no key, no real network. The deploy script is an outline, simulated against a Sepolia fork only.
* The trade through Uniswap's UniversalRouter is milestone 1's test; milestone 3's trades use Uniswap's own test router (`PoolSwapTest`,
  deployed on Sepolia), because the router's calls are the same pool and the same hook-free path.
* A later-round sale from the reserve, as asked.
* No change to the gift rules (B3) or to the exit rule (B2).
* No external review.
