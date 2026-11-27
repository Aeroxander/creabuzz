# Milestone 2 report: Shares, Treasury, Vester, Launcher

Written 16 November 2026, branch `v4-governance-rework`; updated the same day after a review round (see "Review round" below, which also says which parts of the text further down it changed). For the owner. Plain words first. The code is in
`contracts/next/src`, the tests in `contracts/next/test`. Nothing is deployed anywhere and no key was held.

## The short answer

**Yes: one person, alone, can make a project's Shares and give them out, with no vote, no reviewer, no second person and
no wait.** One call to the Launcher creates the project's Shares, Treasury and Vester and puts every one of the
1,000,000,000 Shares where the plan says. The next call can already be Give Shares. The founder never holds the money:
it goes to the Treasury, and the Treasury's rules are the only way it moves.

The three written rules hold under random use, not only in hand-made cases:

1. **The buckets equal the balance.** The four dollar buckets never add up to more than the dollars held, and equal them
   exactly when nobody sent dollars by hand.
2. **An exit never pays more than its slice.** And it never lowers the floor per Share of those who stay, and never
   touches the spendable bucket.
3. **Project-held and unreleased Shares never count.** The exit denominator is always total Shares, less what the
   Treasury holds, less the Shares the Vester has not released yet (released Shares count whether or not their owner has
   pressed claim). No caller supplies it. *(Changed in the review round: it used to subtract the Vester's whole balance, which made every
   exit price depend on whether a stranger had pressed claim.)*

What is not done is milestone 3's work: the real sale, the real proof that a pool exists, the pool's liquidity holder.
Those parts are stubs with access control, as asked, and are listed under "What milestone 3 must do".

## Review round

Two reviewers went over the committed milestone 2: one read it against the plan (their findings are called **A1 to A5** here), one
attacked it as a hostile founder, holder and token (**B1 to B4**). I checked each finding before changing anything, then fixed it with a
test written for it. How I checked: at the start of this round the full suite on the committed code was 222 passed, 6 failed, 7 skipped;
the six failures were the reviewers' own `test_defect_*` tests, which shows A1/B4, A5, B1, B2 and B3 are real. A3 was already shown by a
passing test on the old code (`test_attack_theAdminCanChangeTheSettingsInTheBlockBeforeALaunch`: a project born with the changed opener).
A2 and A4 I confirmed by reading the code (no Launcher function moves the 500M; `handBack` counted every Share outside the Treasury and
Vester) and their fixes by removing them again (below). **All nine are real. Seven are addressed (A1 and B4 are the same defect), with the limits stated exactly in the table: A1/B4 is still a placeholder and A3 still lets the admin retarget
`opener` and `salePath`, both until milestone 3. Two (B2, B3) are changes to a money rule of the plan, which only you can make, so I changed nothing for them.**

| Finding | What was wrong | What changed | Test that fails without it | Removal run |
|---|---|---|---|---|
| **B1** (blocker) | The exit count left out the Vester's whole balance, so Shares already released but not yet claimed dropped out, and anyone could press `claim` for anyone. Measured by the reviewer: Alice's exit 577.81 dollars before a stranger pressed claim, 482.61 after (19.7%); a founder with an accomplice could pick the order and pay an honest 20% holder 35% less. | New `Vester.unreleased()` (granted total less `granted x elapsed / 365 days`; all of it before the clock starts; zero after a year). `Treasury.countingSupply` = total less Treasury balance less `vester.unreleased()`. A claim moves Shares from the Vester to a person and both count, so the number cannot move. The reviewer's `min(unreleased, vester balance)` is not needed: the Vester cannot hold less than it has granted and not claimed, and `unreleased` is never more than that (the sum of per-person rounded-down releases is at most the rounded-down total). | The two defect tests now pass (`test_defect_theExitPriceDependsOnWhetherReleasedSharesWereClaimed`, `test_defect_theFounderChoosesWhichSideOfThePressTheOtherHoldersLandOn`); new `test_countingSupply_countsReleasedSharesWhetherOrNotClaimed`; `Vester` tests `test_unreleased_*`; new invariants `invariant_rule3_aClaimNeverChangesTheCountingSupply` and `..._theCountingSupplyLeavesOutTheTreasuryAndTheUnreleasedShares` (the handler now keeps its own books of what was granted) | T10, T11, V10, V11, V12, V13 (all failed); T10 and T11 also against the invariants alone (failed) |
| **A4** | The exit opened at the first `settle` and counted every Share outside the Treasury and Vester, including the Launcher's unsold Shares and, in milestone 3, the auction's and the strategy's. An exit between finish step 2 (settle) and step 3 (sweep unsold) was paid from a diluted slice, and the shortfall stayed in the floor for nobody. | New `Treasury.markSaleClosed()`: only the `opener`, only after the pool is proven, once. `handBack` reverts `SaleNotClosed` until it was called. In milestone 3 the sweep of unsold Shares is the step that calls it. | `test_handBack_waitsForTheSaleToCloseSoUnsoldSharesNeverCountAsHeld` (alice holds 100M, 400M unsold: refused; after the sweep and close she is paid the whole floor less 5%), `test_saleClosed_only...`, `test_attack_handBackBeforeSettle` (step 3 added), invariant `invariant_noExitPaysBeforeTheSaleIsClosed` | T49, T50, T51, T52; T49 against the invariants alone (failed) |
| **A5** | Parts 40000 and 40000 were accepted by the Launcher and the Treasury; `settle` adds two `uint16` and reverted for every call, so sale money was stuck for good. | Both parts at most 10,000 (`MAX_SPLIT_PART` in `Interfaces.sol`) in `Launcher._set` and `Treasury.initialize`. I did **not** add the reviewer's `uint256` cast in `settle`: with both parts capped the sum is at most 20,000 and cannot overflow a `uint16`, so no test could ever show the cast does anything. | `test_attack_aSplitWhoseSumOverflowsIsRefusedAtTheLauncherAndAtTheTreasury`, `test_settings_bothPartsOfTheSplitHaveACeiling`, `test_birth_badSetupsAreRefused` (two new cases and the ceiling itself accepted) | T53, T54, L19, L20 |
| **A1 and B4** (same defect) | `openSale(projectId, strategy, poolHook)` took the strategy and the hook from the caller and only asked the hook who `authorized()` is, so a founder's own five-line contract passed (reviewers: `SaleNotBuilt` reached instead of `NoPoolGuard`). The owner call "refuse with no pool guard" was met only against a founder who forgot a guard. | `openSale(projectId)` takes nothing else. `strategy` and `poolGuard` are `immutable`, named by the platform in the constructor; `openSale` refuses unless the guard has code, its address carries exactly the `beforeInitialize` hook bit (bit 13 and no other of the 14), and `authorized()` is the platform's strategy. **Still a placeholder:** it does not read the pool key (there is none to read until milestone 3), and the hook is one guard per strategy shared by every project's pool, as milestone 1 built it, so there is no per-project hook address to derive. | `test_openSale_refusesASaleWithNoPoolGuard` (five wrongly configured platform guards: no contract, wrong bit, extra bit, not a guard, names someone else), `test_openSale_withTheRightGuardStopsOnlyBecauseTheSaleIsNotBuiltYet`, `test_attack_aFakeGuardNamedByTheFounderCannotPassTheLaunchersGuardCheck` (the old three-argument call no longer exists), `test_constructor_refusesBadSettings` (zero strategy or guard) | L02, L03, L04, L08, L11, L12, L21 |
| **A2** | This Launcher mints 500M Shares of every project to itself and has no way to move them. Any project launched on it is half locked for ever; milestone 3 cannot finish it, only replace the Launcher. The report read as if milestone 3 completes this contract. | Said plainly in the README, the contract's own documentation and here: **local tests only, never deploy it; milestone 3 ships a new Launcher** (with a per-project "sale opened" flag, once only). In code: the constructor reverts `TestChainOnly` on any chain but 31337 (Foundry's and anvil's local chain), so the trap cannot be set by accident. That refusal is my addition, beyond "say so": it is two lines, and you can drop it. | `test_constructor_refusesToRunOnAnyRealChain` (Sepolia and mainnet refused, 31337 accepted), `test_theHeldSharesHaveNoWayOut_soThisLauncherIsForLocalTestsOnly` | L14 |
| **A3** | A project's trust anchors (`opener`, `salePath`, `quote`, `platform`, fees) are copied from admin-changeable settings at the moment `launch` runs. A founder's transaction signed against old settings could land after the admin changed them (an EOA as `salePath` lets that address take the whole 10% reserve; `opener` could start vesting early). | `launch` now takes `expectedSettingsHash` (the hash of the settings the founder saw; read with `settingsHash()`) and reverts `SettingsMoved` otherwise. `_set` bounds: the dollar token must be a contract with 6 decimals; the platform address may not be the Launcher or the token; split parts at most 10,000. **Not fixed, only documented:** `opener` and `salePath` remain plain non-zero addresses and the admin can still retarget them for new projects (a founder who reads the new values and commits to them gets them: `test_attack_theAdminCanChangeTheSettingsInTheBlockBeforeALaunch` pins it). Milestone 3 must make them contracts the Launcher derives, not settings. Nothing real may be deployed while they are plain addresses. | `test_launch_refusesSettingsTheFounderDidNotSee`, `test_attack_theAdminCanChangeTheSettingsInTheBlockBeforeALaunch`, `test_settings_theDollarTokenAndPlatformAddressAreBounded` | L13, L15, L16, L17, L18 |
| **B2** | Exiting in many pieces recovers part of the 4% that "stays for those who remain" (it also lifts the leaver's own remaining Shares). Reviewer and I measure the same: a holder of 80% is paid 4,670.84 by 400 exits of 1M Shares instead of 4,560.00 by one (+2.43%); the one holder left is paid 1,215.99 instead of 1,322.40 (-8.0%). | **Nothing changed: owner decision.** Every fix changes a money rule: the whole slice leaves and the fee is paid out (the "4% lifts the floor for the rest" benefit of plan section 4 rule 3 goes, and the reviewer's try left the stay part unbacked), or the fee goes to the platform or is burned. Or accept it and say so in the plan, which is what the plan's milestone 2 findings already do. | `test_openDecision_exitingInPiecesPaysALargeHolderMoreThanOneExit` passes and pins the measured leak (between 0 and +3%, the leftover holder between -10% and 0), so a fix or a worse leak fails it. The reviewer's `test_defect_exitingInPiecesPaysMoreThanOneExit` stays in the file, **skipped** with the reason, ready to be switched on after your decision. | T45 and T13 each fail the pin |
| **B3** | After the pool opens a founder may give 1% of all Shares every 30 days, free at once. Given to fresh wallets that hand them straight back, they take floor money that should stay with holders, including the never-melting Share revenue. Reviewer's measure, 100,000 dollars of Share revenue and 11 gifts in a year: -18% of the permanent floor. Measured here after the other fixes: 100,000 to 84,728, i.e. -15.3% (15,830 dollars taken). | **Nothing changed: owner decision.** Every fix changes section 3 ("Shares given after the pool opens are free at once"): post-pool gifts also vest 90 to 365 days; or the cap is measured on the Shares people hold (about half the current drain, not a fix); or gifted Shares cannot be handed back for a fixed time. | `test_openDecision_postPoolGiftsToFreshWalletsTakeAShareOfTheFloor` passes and pins the loss (between 10% and 25%); the reviewer's `test_defect_giftsLetTheFounderDrainTheFloorThroughFreshWallets` stays, skipped with the reason. | T13 fails the pin |

What each fix cost: `Vester` 134 lines (was 120), `Treasury` 484 (was 461), `Launcher` 307 (was 243); about 21,000 more gas to start a project (730,899 to 752,006), 2,400 more for a hand back
(112,329 to 114,713: the extra call to the Vester), 254,000 more to deploy the Launcher; see "Gas". The exit now has two refusals before it pays: no money split yet, and the sale's finish not complete.

**Open for you from this round**, besides B2 and B3: (a) milestone 3's closing step (`markSaleClosed`) must be something any stranger can trigger by finishing
the sweep, never one person's button, and must not be able to get stuck: until it runs nobody can exit, and "a guard that hides the only recovery is a
functional failure" (rule 6 of the repo's review rules). I did not add a time-based fallback because it would re-open the unsold-Shares dilution that
A4 closes; say if you want one. (b) The chain-id refusal on the Launcher (A2) is optional.

**Owner calls (unchanged by this round, and how they stand now):** (1) unused Share reserve to the Treasury as plain Shares: unchanged. (2) no pool, no split;
the Launcher refuses to open a sale with no pool guard: now against a founder too, not only against one who forgets a guard, but it is a placeholder
until milestone 3 reads the real pool (A1). (3) compiler 0.8.37, 200 runs: unchanged, the Launcher also compiles on it. (4) nothing deployed: now also enforced for this
Launcher by its constructor.

## What exists

| Contract | Job | Lines (file / code only) | Plan |
|---|---|---|---|
| `ShareToken` | Plain fixed-supply ERC-20, 1,000,000,000 Shares, 18 decimals; no lock, no call-backs, no owner; holder may burn their own | 122 / 78 | 40 |
| `Vester` | Holds the founder's 20% and Shares given before the pool opens; releases over 365 days from pool open; says how much is not yet released (`unreleased`) | 134 / 77 | 150 |
| `Treasury` | Four dollar buckets, daily release with check-in, Give Shares, spend, agent caps, reserve, exit (opens when the sale's finish is marked complete), Share revenue | 484 / 312 | 550 |
| `Launcher` | One per network (local tests only in this milestone); clones a project's three parts in one transaction; settings for new projects that a founder commits to by hash; stub that refuses to open a sale unless the platform's pool guard is right | 307 / 196 | 400 |
| `RollingCap` | The limit behind agent daily caps and the 1%-in-30-days gift cap (not in the plan) | 46 / 25 | none |
| `Interfaces` | Two small interfaces and the ceiling for the split parts | 28 / 13 | none |

The four planned contracts are 663 lines of code (after the review round; 615 before) against 1,140 estimated, so the plan's size was high. `ShareToken` is
nearly twice its estimate (78 against 40, more than half over). Why: it is a clone, so it has an `initialize` that
mints once; it has `burnFrom` because the exit burns Shares the holder approved; and it carries its own allowance
logic rather than importing a library, so that first-party code stays in one compiler job (below).

Compiler: **0.8.37 with the optimizer at 200 runs**, as the repo's production code. The toolchain had 0.8.37 already
and used it with no network. It did not break interop with the 0.8.26 vendored strategy, because no milestone 2 file
imports vendored code: the Launcher reaches the pool guard through a one-function interface (`authorized()`), and the
milestone 1 files and everything vendored stay on 0.8.26. The only config changes: a restriction line sending the five
milestone 2 files and the repo's OpenZeppelin copy to 0.8.37 with 200 runs, and the `forge-std` pin to 0.8.26 removed
(a test that imports 0.8.37 code cannot also import a 0.8.26-pinned library; the 47 milestone 1 tests still pass).

## Owner calls followed

1. **Unused Share reserve** returned by the pool step goes to the Treasury as plain Shares. In the Treasury the reserve
   is "Shares held here beyond the work pot", so anything sent back or donated is reserve, is counted as treasury-held,
   and leaves only through the sale path. Test: `test_reserve_countsSharesReturnedOrDonatedToTheTreasury`.
2. **No pool, no split.** `settle` reverts `NoPool` until a pool is proven. `Launcher.openSale(projectId)` is a stub that reverts
   `NoPoolGuard` unless the **platform's** pool guard (fixed at construction, not named by the caller) has code, sits at an address with
   exactly the `beforeInitialize` bit and names the platform's strategy; only then does it reach the final `SaleNotBuilt`. *(Changed in
   the review round: it used to check addresses the founder chose, so a founder-written guard passed. It is still a placeholder
   until milestone 3 reads the real pool.)*
3. **Compiler**: 0.8.37, 200 runs (above).
4. **Nothing deployed; the licence question stays with counsel.**

## The rules, where they live, and the test that fails without them

**Rows changed in the review round are marked in "Review round" above; the rows below carry their new guards.** The first round of this
section (74 removals) was run on the code before the review round; the numbers from this round are in the paragraph after the table.

Every guard in this list was removed once, in its own run (`contracts/next/scripts/mutate-guards.py`, which holds the list;
the ids below are its ids): 74 removals, each followed by the whole milestone 2 suite (all
files except the invariants, which have their own runs), the file restored from git after each, and **every one of the 74 made
at least one test fail**. Eleven more removals were run against the invariant suite alone (the rest were not needed there); all
eleven failed an invariant. The "(+N)" says how many other tests failed too. A row with two guards for one danger (the transfer
check and the balance check on the way in and out) shows the single removal and the layered removal. Test names are in
`contracts/next/test`.

| Rule | Where | Guard removed once | A test that failed |
|---|---|---|---|
| Founder's 20% is released evenly over 365 days from the day the pool opens, and nothing before | `Vester.released`, `Vester.startNow` | V05: Shares release before the clock starts; V06: the release does not stop at the grant; V08: a claim does not record what was claimed | V05 `test_nothingIsReleasedUntilTheClockStarts`; V06 `testFuzz_releasedNeverExceedsTheGrantAndNeverFallsAsTimePasses` (+1); V08 `test_release_isLinearOverAYearFromTheStart` |
| Shares given before the pool follow the same release and cannot be handed back until released | `Treasury.giveShares` (before-pool branch) into `Vester.grant`; `countingSupply` | T24: gifts before the pool go straight to the person; V03: grants may be added after the clock started; V04: a grant needs no Shares behind it; V09: anyone may add grants | T24 `test_attack_aFounderDumpAtPoolOpen` (+5); V03 `test_attack_aFounderDumpAtPoolOpen` (+1); V04 `test_grant_onlyTheGranter_onlyBeforeStart_onlyIfFunded` (+1); V09 `test_grant_onlyTheGranter_onlyBeforeStart_onlyIfFunded` |
| Shares given after the pool are free at once, at most 1% of all Shares in any 30 days for the project | `Treasury.giveShares` and `RollingCap` | T23: no monthly cap on gifts after the pool; R01: no cap check; R02: only the newest part counts; R03: a used amount stops counting one part early | T23 `testFuzz_giftsAfterThePoolNeverPassOnePercentInAnyThirtyDays` (+4); R01 `testFuzz_anAgentNeverPassesItsDailyDollarCapInAnyTwentyFourHours` (+14); R02 `testFuzz_anAgentNeverPassesItsDailyDollarCapInAnyTwentyFourHours` (+6); R03 `testFuzz_anAgentNeverPassesItsDailyDollarCapInAnyTwentyFourHours` (+6) |
| The reserve leaves only through the sale path; returned or donated Shares are reserve | `Treasury.releaseReserve`, `Treasury.reserve` | T26: anyone may take the reserve out; T41: the reserve ignores Shares returned or donated to it | T26 `test_attack_theReserveLeavesOnlyThroughTheSalePath` (+1); T41 `test_reserve_countsSharesReturnedOrDonatedToTheTreasury` |
| The pool-open time is set once, by an authorised caller only (Vester clock and Treasury flag) | `Treasury.markPoolOpen`, `Vester.startNow` | T03: anybody may declare the pool open; T04: the pool may be declared open twice; V01: anyone may start the clock; V02: the clock may be started twice | T03 `test_attack_theFounderCannotDeclareThePoolOpenToStartVestingOrSplitMoney` (+1); T04 `test_pool_onlyTheOpenerMayProveItAndOnlyOnce`; V01 `test_attack_theFounderCannotDeclareThePoolOpenToStartVestingOrSplitMoney` (+1); V02 `test_start_onlyTheStarterAndOnlyOnce` |
| Split of sale money is 15 : 60, only when a pool is proven, never more than has arrived | `Treasury.settle` | T05: settle works with no proven pool; T06: settle may split more than arrived; T07: settle ratio is not 15:60 | T05 `test_attack_theFounderCannotDeclareThePoolOpenToStartVestingOrSplitMoney` (+1); T06 `test_edge_theFeesOwedCannotBeSettledAgainAsNewMoney` (+1); T07 `testFuzz_aSequenceOfExitsPaysEachHolderTheirOwnSliceOnly` (+32) |
| The melting floor is released evenly (0.164 of each 100 a day), as a share of what is left, blended by money across sales | `Treasury._preview`, `_accrue`, `settle` | T34: release is a share of the original deposit, not of what is left; T33: a second sale restarts the clock at a year | T34 `testFuzz_theDailyReleaseDoesNotDependOnHowOftenItIsAsked` (+7); T33 `test_settle_aSecondTrancheBlendsTheReleaseTimeByMoney` |
| The release accrues only inside the 14-day check-in window, with no back pay; only the founder or an agent may check in | `Treasury._preview`, `checkIn`, `settle` (first call only) | T18: the release ignores the check-in window; T19: anyone may check in; T43: a check-in does not first work out the release; T08: any settle renews the check-in window; T17: an exit does not first work out the daily release | T18 `test_edge_aCheckInOneSecondLateLosesThatSecondForGood` (+4); T19 `test_checkIn_onlyFounderOrAnAgent`; T43 `testFuzz_theFounderCanNeverSpendMoreThanSpendablePlusWhatIsOwed` (+4); T08 `test_checkIn_aStrangerSettlingDustDoesNotRenewTheWindow`; T17 `test_handBack_includesTheDailyReleaseAlreadyOwed` |
| Hand back is refused until the sale money has been split and the sale's finish is marked complete | `Treasury.handBack` (settled flag, saleClosed flag), `Treasury.markSaleClosed` | T09: hand back before the sale money is split; T49: hand back before the sale is closed; T50: anybody may mark the sale closed; T51: closed before the pool is proven; T52: closed twice | T09 `test_attack_handBackBeforeSettle` (+1); T49 `test_attack_handBackBeforeSettle` (+1); T50, T51, T52 `test_saleClosed_onlyTheOpenerMarksIt_onlyAfterThePoolIsProven_andOnlyOnce` |
| The exit denominator leaves out Treasury-held and unreleased Vester Shares, counts released ones claimed or not, and nobody supplies it | `Treasury.countingSupply`, `Vester.unreleased`, `handBack` | T10: the Vester's whole balance leaves the count (the review's blocker); T11: the Treasury counts in the exit denominator; V10: unreleased is nothing before the clock starts; V11: unreleased does not fall with time; V12: unreleased forgets what was granted; V13: unreleased falls with claims; T36: more than the counting supply may be handed back (error kind) | T10 `test_countingSupply_countsReleasedSharesWhetherOrNotClaimed` and both `test_defect_*` claim tests; T11 `testFuzz_attack_changingTheCountingSupplyNeverPaysTheSender` (+22); V10 `test_unreleased_isEverythingBeforeTheClockAndFallsEvenlyToZero`; V11 `test_countingSupply_countsReleasedSharesWhetherOrNotClaimed` (+4); V12 (+22); V13 `test_unreleased_doesNotDependOnWhoHasClaimed` (+3); T36 `test_attack_anExitWithNothingCountingCannotDivideByZeroOrDrain` (+1) |
| An exit reaches only the floor, never `spendable`, and pays at most its slice | `Treasury.handBack` | T12: the exit slice reaches spendable; T46: an exit pays twice its slice | T12 `testFuzz_aSequenceOfExitsPaysEachHolderTheirOwnSliceOnly` (+20); T46 `invariant_rule2_anExitNeverLowersTheFloorPerShareOfThoseWhoRemain` (+2) |
| The exit fee is 5% (rounded up for the holder): 4 stays in the floor, 1 is owed to the platform | `Treasury.handBack`, `feesOwed`, `sweepFees` | T13: no exit fee; T14: exit fee rounds down; T15: the platform part of the fee is not recorded; T47: the platform part is recorded twice; T45: the exit takes the fee from the floor instead of leaving it (the 4 percent leaves too); T31: fees are swept to the caller; T32: fees owed count as new money | T13 `testFuzz_anExitNeverPaysMoreThanItsSliceAndConservesMoney` (+25); T14 `testFuzz_attack_payingIntoTheFloorThenExitingNeverProfits` (+5); T15 `testFuzz_aSequenceOfExitsPaysEachHolderTheirOwnSliceOnly` (+11); T47 `invariant_rule1_bucketsNeverExceedTheBalance` (+1); T45 `testFuzz_aSequenceOfExitsPaysEachHolderTheirOwnSliceOnly` (+13); T31 `test_sweepFees_aBlockedPlatformAddressDoesNotBlockExits` (+1); T32 `testFuzz_anExitNeverPaysMoreThanItsSliceAndConservesMoney` (+2) |
| The exit burns the Shares, takes from both floors in proportion, and refuses a slice too small to pay | `Treasury.handBack` | T16: an exit does not burn the Shares; T37: a hand back that pays nothing still burns; T38: the exit takes everything from the melting floor | T16 `testFuzz_anExitNeverPaysMoreThanItsSliceAndConservesMoney` (+10); T37 `testFuzz_anExitNeverPaysMoreThanItsSliceAndConservesMoney` (+3); T38 `testFuzz_anExitNeverPaysMoreThanItsSliceAndConservesMoney` (+2) |
| Share revenue goes to the permanent floor, which never melts | `Treasury.shareRevenue` | T39: shareRevenue goes to the melting floor | T39 `test_attack_reenteringATopUpFromInsideAShareRevenueDeposit` (+4) |
| The founder moves only spendable; an agent only inside its daily dollar cap; the release counts | `Treasury.spend` | T21: spend does not stop at spendable (error kind); T44: spend does not work out the release first; T20: an agent spends with no daily cap; T48: spend lets spendable fall below zero silently | T21 `test_attack_theFounderAndHisAgentsCanNeverMoveMoreThanSpendable` (+1); T44 `test_spend_includesWhatTheDailyReleaseOwesWithNoBotRunning`; T20 `testFuzz_anAgentNeverPassesItsDailyDollarCapInAnyTwentyFourHours` (+3); T48 `invariant_rule1_bucketsNeverExceedTheBalance` (+2) |
| An agent gives Shares only inside its daily Share cap; only the founder sets or switches agents | `Treasury.giveShares`, `setAgent`, `revokeAgent` | T22: an agent gives Shares with no daily cap; T27: anyone may set agents; T28: anyone may switch agents off; T25: the work pot may be overdrawn (error kind); T35: gifts to the Vester address are allowed | T22 `test_attack_anAgentSplitsCallsToPassItsDailyShareCap` (+1); T27 `test_agents_onlyTheFounderSetsThem_andTheLimitsAreTheRunnersChoice` (+1); T28 `test_agents_onlyTheFounderSetsThem_andTheLimitsAreTheRunnersChoice`; T25 `test_give_refusals` (+1); T35 `test_give_refusals` |
| A clone is set up once (Treasury, Vester, ShareToken), and the implementations are locked | `initialize` of each | T01: initialize may be called again; V07: initialize may be called twice; S01: birth may be repeated; S05: the implementation is not locked | T01 `test_attack_doubleInitialiseAClone` (+1); V07 `test_attack_doubleInitialiseAClone` (+3); S01 `test_attack_doubleInitialiseAClone` (+2); S05 `test_birth_theImplementationIsLocked` |
| Fixed supply: the birth amounts add to exactly 1,000,000,000; allowances are spent | `ShareToken` | S02: birth amounts need not add up to the supply; S03: burnFrom ignores the allowance; S04: transferFrom ignores the allowance | S02 `test_birth_amountsMustAddUpToTheSupply`; S03 `test_burnFrom_needsAnAllowanceAndSpendsIt` (+1); S04 `test_allowance_transferFromSpendsIt` |
| A call-back from the dollar token cannot make a deposit count twice | `Treasury.nonReentrant` | T02: no re-entrancy lock | T02 `test_attack_reenteringATopUpFromInsideAShareRevenueDeposit` (+1) |
| A token that keeps a fee, charges the sender, or returns false cannot make the buckets exceed the balance (layered: the transfer check and the balance check) | `Treasury._pull`, `_pay` | T29: an outgoing token fee is not noticed; T29b: raw transfer, no balance measurement on the way out (both layers); T30: a pulled amount is credited as asked, not as received; T30b: raw transferFrom, no arrival check on the way in (both layers) | T29 `test_edge_aTokenThatChargesTheSenderOnTopCannotMakeTheBucketsExceedTheBalance`; T29b `test_edge_aTokenThatChargesTheSenderOnTopCannotMakeTheBucketsExceedTheBalance` (+1); T30 `test_edge_aFeeTokenCreditsOnlyWhatArrivedOnTopUp` (+1); T30b `test_edge_aFeeTokenCreditsOnlyWhatArrivedOnTopUp` (+3) |
| Birth checks of a Treasury (fee ceiling, platform part, nonzero parts, ceiling on both parts of the split) | `Treasury.initialize` | T40: an exit fee of 100% or more is accepted; T42: a platform part above the whole fee is accepted; T53, T54: no ceiling on one part of the split | T40 `test_birth_badSetupsAreRefused`; T42 `test_birth_badSetupsAreRefused`; T53, T54 `test_birth_badSetupsAreRefused` |
| The Launcher never opens a sale unless the platform's pool guard is right, and the caller names none | `Launcher.openSale`, constructor | L02: no contract at the guard address; L11: the guard's address lacks the `beforeInitialize` bit; L12: extra hook bits allowed; L03: the guard names someone else; L04: a hook that is not a guard; L08: the sale opens without a known project; L21: zero strategy or guard at construction | L02, L03, L04, L11, L12 `test_openSale_refusesASaleWithNoPoolGuard`; L08 `test_openSale_refusesAnUnknownProject`; L21 `test_constructor_refusesBadSettings` |
| Settings: only the admin, ceilings, bounds, new projects only, and the founder commits to what they saw | `Launcher.setSettings`, `_set`, `launch` | L05: anyone may change settings; L06: the exit fee ceiling is not checked; L07: the platform part may exceed the whole fee; L13: launch ignores the settings hash; L15: the dollar token may be an account; L16: any decimals; L17, L18: platform may be the Launcher or the token; L19, L20: no ceiling on a part of the split | L05 `test_admin_canHandOnOrRenounce_andRenouncingFreezesSettings` (+1); L06, L07 `test_settings_badValuesAreRefused`; L13 `test_launch_refusesSettingsTheFounderDidNotSee` (+1); L15 to L18 `test_settings_theDollarTokenAndPlatformAddressAreBounded`; L19, L20 `test_settings_bothPartsOfTheSplitHaveACeiling` |
| A project is the founder's own, the allocation is exact, an id is used once, and this Launcher lives only on the local test chain | `Launcher.launch`, constructor | L01: a founder may reuse an id (error kind); L09: the founder allocation is 190M not 200M (every test fails: the birth amounts then do not add up to the supply and the launch itself reverts); L10: the founder is the Launcher, not the caller; L14: the Launcher may be created on any chain | L01 `test_launch_theSameFounderCannotReuseAnId_butAnotherFounderCan`; L09 `setUp`; L10 `testFuzz_anAgentNeverPassesItsDailyDollarCapInAnyTwentyFourHours` (+42); L14 `test_constructor_refusesToRunOnAnyRealChain` |
| The cap itself: no stretch of a window passes it | `RollingCap` | R01: no cap check; R02: only the newest part counts; R03: a used amount stops counting one part early | R01 `testFuzz_anAgentNeverPassesItsDailyDollarCapInAnyTwentyFourHours` (+14); R02 `testFuzz_anAgentNeverPassesItsDailyDollarCapInAnyTwentyFourHours` (+6); R03 `testFuzz_anAgentNeverPassesItsDailyDollarCapInAnyTwentyFourHours` (+6) |


**Removals caught by the invariant suite alone** (no unit, fuzz or attack test run), so the invariants are not decoration:
T10 and T11 (Vester or Treasury Shares counted in the denominator) fail `invariant_rule3_theCountingSupplyLeavesOutTheTreasuryAndTheVester`;
T12 and T46 (an exit that reaches spendable, or pays twice its slice) fail `invariant_rule2_anExitNeverPaysMoreThanItsSlice` and
`invariant_rule2_anExitNeverLowersTheFloorPerShareOfThoseWhoRemain`; T15 (platform part not recorded) fails
`invariant_rule1_bucketsPlusStrayEqualTheBalance`; T47 and T48 (platform part recorded twice; spend lets spendable fall silently) fail both
rule 1 invariants, and T48 also `invariant_theFounderAndAgentsNeverSpendMoreThanSpendable`; T16 (an exit that does not burn) fails
`invariant_sharesAreConservedAcrossVestGiftAndExit`; T20 and T22 (agent caps removed) fail
`invariant_anAgentNeverPassesItsDailyCapInAnyTwentyFourHours`; T23 (no monthly gift cap) fails
`invariant_giftsAfterThePoolNeverPassOnePercentInAnyThirtyDays`.

**Removals in the review round.** After the fixes I ran **all 98 removals in `scripts/mutate-guards.py` again**: the 77 entries the list had before this round (patterns updated where the code moved: T03, T05, T10, T11, L02, L08)
and 21 new ones (T49 to T54, V10 to V13, L11 to L21), each against the whole milestone 2 suite without the invariants, the file restored from git after each. **Every one of the 98 made at least one test fail;
none failed to compile and none is a guard no test needs.** (The first round's text above counted 74; the list had 77 entries, so the older number was three short.) Six were also run against the invariant suite alone and
each failed an invariant: T10 (two invariants, including the new claim one, and the scripted reach check), T11, T15, T16 (two), T23, and T49 (`invariant_noExitPaysBeforeTheSaleIsClosed` and the reach check). One more removal by hand:
putting the old three-argument `openSale` back makes `test_attack_aFakeGuardNamedByTheFounderCannotPassTheLaunchersGuardCheck` fail. For the two pinned owner decisions: removing the 4% that stays in the floor
(T45) fails the B2 pin, and no exit fee (T13) fails both pins. **Removing the monthly gift cap (T23) does not fail the B3 pin**, because that test gives exactly the cap each time, so the pin guards
how much the cap lets through, not the cap's existence (the cap itself is guarded by T23's other failing tests). The `uint256` cast the review asked for in `settle` was not added (see A5), so there is no
removal to run for it. The guards still not proven by removal are the ones the first round listed below.

**What this does not show.**
* Three of the 74 (T21, T25, T36) are guards that sit in front of checked arithmetic: without them the call still reverts, with a plain
  arithmetic error instead of the named one, and the test that failed asserts the named error. They protect the message, not the money.
* Guards I did not remove: the zero-address and zero-amount refusals (`BadInput`), the 192-bit limit in `RollingCap`, the zero-recipient and
  list-length refusals in `ShareToken`, the name and symbol length limits, nine of the eleven conditions inside `Treasury.initialize`'s birth
  check (two were removed; one test exercises all eleven), and the refusal when the Shares contract returns false. They are tested by unit tests,
  but I did not prove those tests fail without them.
* "Settings changes never reach a launched project" has no guard to remove: the Treasury keeps its own copy and holds no link back to the
  Launcher. `test_settings_onlyTheAdminChangesThem_andOnlyNewProjectsSeeThem` shows the behaviour.
* The mutation runs used the test layout before the Treasury tests were split into `Treasury.t.sol` and `TreasuryActions.t.sol` and before
  the Launcher was loaded from the build output in the tests; those two changes moved tests without editing them. The first full batch of
  removals was thrown away: Foundry keeps the failing input of a failed fuzz or invariant test and replays it in the next run, so a later
  removal could be blamed for an earlier one's failure. The batch was rerun with those stored files deleted before each run.


## Every number or rule the plan left open, and what I chose

**Money and clocks**

1. **`settle(amount)`.** The plan said "take the figures as parameters of the call". I took them as parameters **of the
   project at birth**: the Launcher copies `spendableParts = 15` and `floorParts = 60` into the Treasury, and `settle` takes
   only the amount. Why: anyone may call `settle` (the finish is three steps that any stranger may do), so a caller-chosen
   ratio would let a stranger choose how much of the sale money the founder can spend. The amount is capped at the dollars
   that arrived and are in no bucket, so a caller cannot invent money either. The ratio applies to the 75 of every 100 that
   reach the Treasury: 15 : 60 is 1/5 : 4/5, so the spendable part is `amount * 15 / 75`, rounded down, and the floor gets
   the rest (rounding favours the floor, which belongs to holders). The 3 for the platform and 22 for the pool never reach
   the Treasury; milestone 3 handles them.
2. **Partial and repeated settles are allowed**, each split the same way. The floor's release time is blended by money:
   when new floor money joins old, the remaining active time becomes the money-weighted mean of the old remainder and
   365 days. A test pins it (`test_settle_aSecondTrancheBlendsTheReleaseTimeByMoney`), and a stranger settling one dust unit cannot renew the check-in window (only the very first
   settle opens it).
3. **The daily release is a share of what is left, not of the original deposit:** each time it is worked out it releases
   `melting * active seconds / remaining active seconds`. For an untouched floor this is exactly the plan's 0.164 of each
   100 a day (6,000 floor: 16.438356 dollars on day one, pinned in a test). It keeps the release even when holders have
   handed back part of the floor; a release fixed on the original deposit would run the floor dry early after exits.
4. **Check-in window, exact rule.** Release accrues only for the part of time that falls inside the window
   `lastCheckIn ... lastCheckIn + 14 days`. Whenever anything works the release out, the time after the window is thrown
   away for good (`accruedUpTo` jumps to now): no back pay for paused time. **How it moves the end date:** the floor needs
   365 *active* days, so every day outside a window pushes the end one day later; a founder who checks in at least every
   14 days finishes 365 days after the sale, one who is silent 16 days extra finishes at day 381 (test:
   `test_endDate_everyDayOutsideAWindowPushesTheEndOneDayLater`). The first settle counts as a check-in, so the window
   starts open. The founder or any switched-on agent can press check-in. At the boundary second: a check-in exactly 14 days
   later loses nothing and counts nothing twice; one second late loses that second; one second early counts every second.
5. **Lazy, not a bot.** Nothing runs by itself. `settle`, `checkIn`, `spend`, `handBack` and the public `release()` all work
   the release out first, so every reader sees an up-to-date number and `pendingRelease()` shows what is owed.
6. **Exit fee arithmetic.** slice = (melting + permanent floor) x burned / counting supply, rounded down; fee = 5% of the
   slice **rounded up** (so a holder never pays less than 5%); platform part = 1% of the slice rounded down; the rest of the
   fee stays in the floor. The money that leaves the floor (paid + platform part) is taken from the melting and permanent
   buckets in proportion to their sizes. An exit whose slice is too small to pay one unit **reverts** `NothingToPay` before
   burning anything, so nobody burns Shares for nothing (the smallest amount that pays one millionth of a dollar is worked out
   in a test).
7. **The platform's part is owed, not sent in the exit.** It goes into a fourth bucket (`feesOwed`) that anyone may sweep to
   the platform address. A dollar token that freezes an address (a real stablecoin can) would otherwise let a frozen platform
   address block every exit; now it only blocks its own sweep (test: `test_sweepFees_aBlockedPlatformAddressDoesNotBlockExits`).
8. **The last holder pays the fee too.** Waiving it for a sole counting holder would make buying up the last Shares cheaper
   for exactly the person best placed to try it, and the 4% is not lost: it stays in the floor for whoever holds Shares next.
   Test: `test_attack_anExitWithNothingCountingCannotDivideByZeroOrDrain` (a later holder finds the left-over floor).
9. **Dollars sent by hand are never counted.** The buckets only change through the functions. Dollars that arrive otherwise
   (sale money before it is split, a donation) are "unaccounted"; anyone may split them with `settle`, so nothing is stuck.
   An exit ignores them (test: a donation of 100,000 dollars leaves an exit's pay unchanged to the unit).
10. **Quote token assumptions.** The platform picks one dollar token per network; a founder never does. The Treasury assumes
    it is a standard ERC-20 that may revert, return false, keep a fee on transfer, charge the sender extra, or call back
    into an account around a transfer. It does not assume more. Deposits credit what the balance rose by; payments insist
    the balance fell by exactly the amount, else `TokenMisbehaved`; a transfer that returns false reverts; and every function
    that changes a bucket is non-reentrant (a transient lock). A token that is malicious in other ways (lies about balances)
    could harm only the projects built on it, which is a platform choice made once.

**Shares**

11. **Agent limits.** The founder sets an agent's two daily limits (dollars and Shares); defaults are Launcher settings,
    **25 dollars and 0.1% of the supply (1,000,000 Shares)**. An agent cannot raise its own; switching an agent off and on
    does not reset what it used. "Their runner sets" is read as the founder, because the Treasury has one authority.
12. **Both limits and the gift cap are rolling, not "reset each day".** A reset counter lets twice the cap through around the
    reset. `RollingCap` cuts the window into equal parts and counts a used amount until its part is a full window old, so
    the promise is exact: **in no 24 hours (30 days) is more than the cap let through.** The price: a used amount can stay
    counted for up to one part longer. Daily limits use 6 parts of 4 hours, so a used amount counts for **24 to 28 hours**;
    the monthly gift cap uses 10 parts of 3 days, so it counts for **30 to 33 days**. Chosen to keep reads at 7 and 11 slots.
13. **The gift cap is 1% of the Shares that exist at the time** (`totalSupply`), so burns lower it a little. It is one cap for
    the whole project, shared by the founder and every agent. Before the pool opens there is no monthly cap (only the work
    pot of 200,000,000, and the 365-day release); gifts made before the pool opens do not count against it afterwards.
14. **Give Shares.** Before the pool opens the Shares go to the Vester and are granted to the person in the same call. After
    it they go straight to the person. A gift to the zero address, the Treasury, the Vester or the Shares contract is refused.
15. **Hand back needs the holder's approval** (the exit burns with `burnFrom`), so a holder approves the Treasury once, then
    hands back. A passkey account does both in one batch.
16. **The pool-open signal.** `markPoolOpen` (stub: only the `opener` the Launcher named, once) sets the Treasury's flag and
    starts the Vester's clock in the same call, so the two can never disagree. The Vester's starter and granter are both the
    Treasury; tests of the Vester alone use plain addresses.
17. **Shares sent to the Vester or Treasury by hand** are never anyone's to claim: stray Shares in the Treasury become
    reserve (left out of the exit count). Stray Shares in the Vester stay there for ever and, since the review round, **still
    count** in the exit denominator, because only the Vester's *unreleased grants* are left out. Moving your own Shares there changes
    nothing in the count, so nobody gains; they are stuck, and the floor money they stand for stays in the floor, unclaimable (the
    same as Shares burned by losing a key). The old rule left them out and raised the others' slice.

**Launcher**

18. **A project is known by the pair (founder, project id)**, not by the id alone, so nobody can take an id the founder has
    not used yet (squatting on someone's id would otherwise cost them the launch). The server matches a signed record to the
    event by founder and id. The three clones are made at fixed addresses from that pair, so a repeat is refused.
19. **The Launcher holds the 400M sale Shares and the 100M for the pool** until milestone 3, in one balance, with no way
    out, ever. The amounts are constants, not a per-project ledger. **This Launcher can therefore never finish a sale and must not be
    deployed anywhere but local tests** (review finding A2): its constructor refuses any chain but 31337, and milestone 3 ships a new
    Launcher. This replaces the earlier answer "no way out yet".
20. **Settings** (`quote`, `platform`, `opener`, `salePath`, exit fee, platform part, 15 and 60, agent defaults) are held by
    an `admin`, copied into each new project at launch, and cannot reach a launched project (the Treasury keeps its own
    copy and has no link back). Ceilings and bounds: exit fee at most **10%**, platform part at most the fee, both parts of the split
    between 1 and **10,000**, addresses nonzero, the dollar token a **contract with 6 decimals**, the platform address not the Launcher
    or the token. The admin can hand the role on or renounce it (settings then never change again). Name and symbol: 1 to 64 bytes.
    A founder's `launch` carries the hash of the settings they saw (`SettingsMoved` otherwise). `strategy` and `poolGuard` are not
    settings: they are fixed when the Launcher is made.
21. **One event** `ProjectLaunched` carries project id and founder (indexed), the three addresses, the dollar token, the
    platform address, the five-part allocation and the settings.
22. **The sale's finish is complete (review round).** `markSaleClosed` (stub: only the `opener`, once, only after the pool is proven)
    opens the exit. It is separate from `markPoolOpen` because the two are different finish steps (open the pool; sweep unsold Shares
    back) that milestone 3 lets different strangers do, in any order. The exit needs both this flag and a first `settle`.
23. **The exit count (review round).** Total Shares, less the Treasury's balance, less `vester.unreleased()`; see B1 above.
    Released-and-unclaimed Shares count. Unsold Shares in the Launcher count until the sweep, which is why the exit waits for the sweep.


## What the plan got wrong or left loose

1. **The exit fee is not a flat 5% against a holder who exits in pieces and keeps some Shares.** The 4% that stays "for
   those who remain" also reaches the leaver's own remaining Shares. Measured on the worked example (6,000 floor, 500M
   counting Shares): a holder of 20% who exits all in one go gets 1,140.00 dollars; in 100 exits, 1,144.87 (**+0.43%**).
   A holder of 80%: 4,560.00 in one go, 4,670.84 in 400 exits (**+2.4%**). In the limit a sole holder who exits in
   infinitely many pieces recovers 0.95 / 0.96 = 98.96% of the floor, so their fee falls to about 1%. This is the plan's own
   rule working as written, but section 4's anti-drain rule 2 ("buy and hand back only pays when the price is more than about
   5% under the floor") is only true for small holders; for a holder of a large share of the counting Shares the break-even
   is lower. It needs many transactions for a real gain and a pool that lets a whale buy most of the Shares under the floor.
   Options if you want it closed: none is free (a flat fee burned or paid to the platform would drop the "4% lifts the floor
   for the rest" rule). Test: `test_edge_exitingInManyPiecesRecoversPartOfTheFeeBoundedByTheHoldersShare`.
2. **"Accrues only while inside the check-in window" needs one more rule to be defined**: what the end date does. Written
   and tested above (every silent day pushes the end one day later).
3. **"1% of all Shares per 30 days" cannot be exact with a cheap counter.** A daily or monthly reset lets 2% through around the
   reset. The exact promise costs a ring of storage slots and means a used amount counts up to one part longer (30 to 33 days).
4. **The size table was high** for Vester, Treasury and Launcher (615 lines of code against 1,140) and low for ShareToken
   (78 against 40).
5. **The plan's worked example for the floor per Share (6,000 over 500,000,000 Shares = 48% on day one) will not hold in
   milestone 3** if the Shares inside the pool count as people's hands: milestone 1 measured about 59.7 million Shares in the
   pool of its 20,358-dollar test sale, which are held by the pool manager, not by the project or the Vester. The denominator rule
   in this milestone (total less Treasury less the Vester's unreleased Shares) counts them. See "What milestone 3 must do".
6. **"Refused until the sale money has arrived" is a fact about the Treasury's own books, not about the sale.** The Treasury
   can only know that money was split, so the exit opens at the first `settle` (and, since the review round, once the sale's
   finish is marked complete). A stranger who splits a small part first
   opens it before the rest is split. Holders who exit in that window are paid from a small floor, which is their loss and
   nobody's gain. Milestone 3 closes it by proving the pool and splitting the whole amount in one transaction.
7. **Section 4, "Shares not yet released are left out", was built as "the Vester's whole balance is left out" and was wrong** (review
   finding B1): released Shares that nobody had claimed dropped out too, and anyone could press claim for anyone, so the exit price
   depended on who pressed it. Now exactly the unreleased part is left out.
8. **Section 3, "Shares given after the pool opens are free at once, at most 1% of all Shares per 30 days", is a drain** (B3): given to
   fresh wallets that hand them back, 11 gifts in a year took 15.3% of a 100,000-dollar permanent floor in this test. Owner decision, below.
9. **Section 4, "the 4% left behind lifts the floor for the rest", also lifts the floor of the leaver's own remaining Shares** (B2): the
   point 1 above, now measured the same way by a second person. Owner decision, below.
10. **No wrong prices or prose found** in sections 3 and 4 otherwise: the 0.164 a day, the 15 : 60 split, 14-day window, 5% exit
   fee (4 stays, 1 to the platform) and 1% a month all run as written.


## Gas

Measured in the Foundry test VM, with production compiler settings (0.8.37, 200 runs, via IR), and with every project
contract made cold first (`vm.cool`) so each call pays for its first read of each slot, as a real transaction does.
**Execution gas only: the 21,000 base cost and the call data are not included.** Not measured on any network. Reproduce with
`forge test --match-path test/Gas.t.sol -vv` from `contracts/next`.

| Step | Gas |
|---|---|
| **Launcher start**: three clones, mint, set-up (`launch`), first project of a founder | 752,006 |
| Launcher start, another founder | 744,497 |
| Deploy the Launcher (once per network; holds the three implementations) | 4,529,986 |
| **Give Shares** before the pool: first gift to a person (Vester grant) | 91,222 |
| Give Shares before the pool: same person again | 40,319 |
| Give Shares after the pool: first of the period (straight to the person) | 94,227 |
| Give Shares after the pool: second in the same period | 74,445 |
| Give Shares by an agent after the pool (first use of its cap) | 94,106 |
| **Check-in** (works out up to 3 days of release first) | 17,774 |
| **Daily release**, asked by anyone (lazy, no bot) | 14,782 |
| Spend by the founder (works out the release inside the call) | 66,847 |
| **Hand back**: first exit | 114,713 |
| Hand back: second exit | 92,013 |
| Mark pool open (stub; starts the Vester's clock) | 118,038 |
| Settle, first split | 128,917 |
| Vester claim | 72,215 |

Re-measured after the review round, with the same method (the figures not changed by it are unchanged; `markSaleClosed` was not measured). For comparison, milestone 1 measured a plain token deploy at 581,395; a clone of the Shares is cheaper than that, and the whole
project start costs a little more than one such deploy. The same calls with warm storage (as when several calls follow in one
transaction) are much cheaper: for example a check-in was 7,774 and a second gift to the same person 14,030.


## What I ran

Run from `contracts/next` on this machine (`forge 1.4.3`, solc 0.8.37 for milestone 2 files, 0.8.26 for the rest), 16 November 2026.

| Gate | Result |
|---|---|
| `forge build` | passes. A forced rebuild of everything (`forge build --force`) prints compiler warnings only for milestone 1 files and vendored code (initcode and code size of the fork test contracts, a transient-storage note in Uniswap's `CurrencyReserves.sol`); **none from a milestone 2 file**. I removed two I had introduced: a test variable named `at` (a coming keyword), and test contracts over the 49,152-byte creation-code limit (the Treasury tests were split in two and the tests load the Launcher from the build output instead of embedding it). Lint notes (naming style of the Launcher's three implementation addresses and the token's `decimals`) remain, as in milestone 1's files. |
| `forge test` (whole project, no `SEPOLIA_RPC_URL`), after the review round | **241 passed, 0 failed, 9 skipped** in 26 suites. The 9 skipped: milestone 1's 7 fork setUps (no RPC) and the 2 reviewer tests held back for your decision (B2, B3). Milestone 1's 47 local tests are among the 241 and unchanged. The other **194** are milestone 2's (159 in the first round, 35 more). Before the fixes the committed code ran 222 passed, 6 failed, 7 skipped. |
| milestone 2 tests by file | ShareToken 13, Vester 14, RollingCap 5, Treasury 22, TreasuryActions 27, Launcher 20, TreasuryAttacks 19, TreasuryEdges 21, TreasuryFuzz 8, TreasuryInvariants 16 (15 invariants and one scripted check that the handler reaches the states), Gas 7, AttackM2 22 (14 and 8; the reviewer's attack file, plus 2 more skipped). |
| Fuzz run counts (money paths 1,000 or more) | default 1,000 (`[fuzz]` in `foundry.toml`). 3,000: exit never pays more than its slice. 2,000: settle split; daily release independent of call count; founder spend; gifts per 30 days; agent dollar cap; paying into the floor then exiting never profits; donating Shares never pays the donor; the cap library. 1,000: Vester release; token supply; exit sequences; blended sales. |
| Invariants | 15, each **256 runs of depth 200 (51,200 calls)**, a handler with 22 actions (founder, two agents, four holders, a stranger, the opener, the sale path, a donor; time passes). The count of invariants is two more than in the first round (a claim never changes the count; no exit before the sale is closed) and one was renamed. Reach, re-measured after the review round on one 256-run pass of 51,200 checks (each check sees the sequence so far): the sale was marked closed in 40,345 of the checks and at least one exit had paid in 19,326. The first round's per-call totals (exits, gifts, spends, settles, claims) were not re-measured; the new handler action `closeSale` is reached often enough for the exits to happen. |
| `forge fmt --check src test` | clean |
| `git diff --stat e4b3597ae..HEAD` | only `contracts/next/**` and `docs/**` (`docs/archive/M2-REPORT.md`, and the plan's appended findings, written in the first round; this round touched only `contracts/next/**` and `docs/archive/M2-REPORT.md`) |

What was not run: nothing on a real or forked network (milestone 2 needs neither); the old suite in `contracts/`; any external review. The
gas figures are from the test VM, not a network.


## What milestone 3 must do

1. **Replace the `opener` stub with a proof.** Today `markPoolOpen` and `markSaleClosed` trust one address the Launcher named. Milestone 3 must make
   `markPoolOpen` read the pool itself (the pool manager's price for the key whose hook is the guard that names the strategy; M1-REPORT item 3)
   and do three things in one call: set the Treasury's flag, start the Vester's clock, and split. `markSaleClosed` must become the last
   step of the sweep of unsold Shares, callable by anyone who finishes the sweep, and must not be able to get stuck (until it runs, nobody
   can exit). A fork test must exit after step 2 and before step 3 and be refused (review finding A4). Then the "a stranger splits a
   small part first and opens the exit early" window (point 6 above) cannot exist. Keep `markPoolOpen` safe to repeat (it reverts
   today when already set; the finish is "each step safe to repeat").
2. **`settle` gets the auction's reported total**, not "whatever is unaccounted". The Treasury already refuses more than has
   arrived and refuses before a pool is proven; the finish should pass the exact figure it read from the auction.
3. **Write the real `openSale`, in a NEW Launcher.** This milestone's Launcher cannot be completed: it has no function that moves the 500M
   Shares it holds, so milestone 3 ships a different contract and nothing launched here carries over (A2). In the new one: take the
   strategy and the guard from the platform (as this version already does) and, on top of today's checks, read the pool key and confirm the
   hook is the one in the pool manager's key and has the `beforeInitialize` bit set; move that project's 400M sale Shares and 100M pool Shares
   out of its own balance (a per-project ledger, not a constant pair in one balance) into the auction and the strategy, with the Treasury
   as the strategy's `recipient` and the auction's `tokensRecipient`, and the `LiquidityHolder` as `positionRecipient`. It must
   remember that a project's sale was opened (once only, so a second `openSale` cannot run). Make `opener` and `salePath` contracts the
   Launcher derives or holds as immutables, not settings an admin can change (A3). Until then nothing real may be deployed.
4. **Decide whether Shares inside the pool count as holders' Shares.** As specified, `countingSupply` is total less Treasury less
   Vester, so the roughly 6% of Shares the pool holds count and lower the floor per Share (point 5 above). Excluding them needs
   the `LiquidityHolder`'s position read in the denominator, which is a new moving part. This needs your call before the first fork test.
5. **Unsold Shares and the unused part of the pool reserve arrive at the Treasury as plain Shares**, and the sweep that sends them is the step that
   marks the sale closed (point 1). A test here shows they become reserve and are counted as treasury-held (owner call 1) and that the exit
   waits for them; milestone 3's fork test should assert both.
6. **Reserve for later sales.** `releaseReserve` is the hook; the real sale path must be an address the Launcher approves.
7. **Milestone 7 will need two things this Treasury does not have:** a way to change who runs a project (the founder is fixed at
   birth) and a way for the Stop vote to pause the daily release. Both are new functions in a new Treasury implementation; clones
   already launched cannot gain them, which the plan accepts for testnet.
8. **Milestone 4 can index now.** `ProjectLaunched` carries the project id and founder (both indexed), the three addresses, the dollar
   token, the platform address, the five-part allocation and the settings. A server matches a signed record by (founder, id); a stranger
   cannot take another founder's id.
9. **Sponsor limits.** The new numbers for the batch of "start and give": `launch` about 0.75M gas plus a gift about 0.09M; open a
   sale about 4.27M (milestone 1, at 11,111 runs; about 0.47M fewer at 200 by milestone 1's size estimate, not measured). The sum is near 5.1M, as the plan guessed, not more.

10. **Two owner decisions on money rules, both unchanged in the code** (review findings B2 and B3, in "Review round"): whether exiting in pieces may
    recover part of the 4% (and, if not, who gets it), and whether Shares given after the pool opens may be handed back at once.

## What I did not do

* The real sale, the real pool proof, the pool's liquidity holder, the Launcher releasing the 500M held for the sale: milestone 3.
* The `opener` and `salePath` addresses are stubs with access control. In the tests they are plain addresses. A wrong `opener` could start a
  project's vesting early, let sale money be split with no pool, or never mark the sale closed; that trust is the stub's, and milestone 3 removes it.
  The admin can still change them for new projects (a founder commits to what they saw by hash, but a founder who reads the new values gets them).
* B2 (exit in pieces) and B3 (gifts to fresh wallets): money-rule decisions, not changed. See "Review round".
* The Launcher still does not read a real pool key (nothing exists yet to read), and the review's "derive the expected hook address from (strategy, project)"
  does not apply to this design: one guard per strategy serves every project's pool.
* No external review. The plan's "off until an outside audit" list still applies, and now includes these four contracts.
* Gas on a real network, and whether the fee sponsor accepts these sizes, were not checked.
* The agents' defaults are raw units in the Launcher's settings (25,000,000 for 25 dollars of a 6-decimal token). Since the review round the Launcher
  refuses a dollar token that is not a contract with 6 decimals; it still cannot tell an honest 6-decimal token from a lying one.

