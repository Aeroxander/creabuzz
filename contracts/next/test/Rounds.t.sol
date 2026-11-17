// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Rounds} from "../src/Rounds.sol";
import {Vester} from "../src/Vester.sol";
import {Treasury} from "../src/Treasury.sol";
import {Launcher} from "../src/Launcher.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {IShares, IVester, ITreasuryRounds} from "../src/Interfaces.sol";
import {BASE_SHARES_PER_RAW_DOLLAR} from "./helpers/Prices.sol";

/// @notice Backing rounds, one rule at a time: the price, the 24 hours, asks and lowering, the close and the scale-back, the
/// 3 / 15 / 82 split, the 26-week release inside the check-in window, the personal refund and its numbers, the wind-down.
contract RoundsTest is RoundsBase {
    // ================================================ the price and the round ==========================================

    /// @dev Founder-set prices: the range is 3,000 Shares a dollar (333,333 dollars for the whole project; 50,000 dollars buy
    /// exactly the 150M backing Shares) to 20 Shares a dollar (50,000,000 for the whole project).
    function test_price_theRangeIs333333To50000000ForTheWholeProject() public view {
        assertEq(rd.MAX_SHARES_PER_RAW_DOLLAR() * DOLLAR, 3000 * SHARE, "lowest price: 1 dollar buys 3,000 Shares");
        assertEq(rd.MAX_SHARES_PER_RAW_DOLLAR() * 50_000 * DOLLAR, 150_000_000 * SHARE, "50,000 dollars buy the 150M");
        assertEq(rd.MIN_SHARES_PER_RAW_DOLLAR() * DOLLAR, 20 * SHARE, "highest price: 1 dollar buys 20 Shares");
        assertEq(rd.MIN_SHARES_PER_RAW_DOLLAR() * 50_000_000 * DOLLAR, 1_000_000_000 * SHARE, "50M buys every Share");
        assertEq(shares.balanceOf(rounds), 150_000_000 * SHARE);
        assertEq(rd.unsold(), 150_000_000 * SHARE);
    }

    /// @dev The lowest price: 3e15 opens, one raw unit more (a lower price) does not.
    function test_open_theLowestPrice_3e15Opens_3e15PlusOneIsRefused() public {
        vm.startPrank(address(launcher));
        vm.expectRevert(Rounds.CannotOpen.selector);
        rd.open(DOLLAR, 3e15 + 1);
        rd.open(DOLLAR, 3e15);
        vm.stopPrank();
        assertEq(rd.roundOf(1).sharesPerRawDollar, 3e15);
    }

    /// @dev The highest price: 2e13 opens, one raw unit less (a higher price) does not.
    function test_open_theHighestPrice_2e13Opens_2e13LessOneIsRefused() public {
        vm.startPrank(address(launcher));
        vm.expectRevert(Rounds.CannotOpen.selector);
        rd.open(DOLLAR, 2e13 - 1);
        rd.open(DOLLAR, 2e13);
        vm.stopPrank();
        assertEq(rd.roundOf(1).sharesPerRawDollar, 2e13);
    }

    /// @dev The Launcher passes the runner's price through; the Rounds refuse one outside the range.
    function test_openRound_aPriceOutsideTheRangeIsRefusedThroughTheLauncher() public {
        vm.startPrank(founder);
        vm.expectRevert(Rounds.CannotOpen.selector);
        launcher.openRound(key, 3e15 + 1);
        vm.expectRevert(Rounds.CannotOpen.selector);
        launcher.openRound(key, 2e13 - 1);
        uint256 id = launcher.openRound(key, 166_666_666_666_666);
        vm.stopPrank();
        assertEq(rd.roundOf(id).sharesPerRawDollar, 166_666_666_666_666, "6,000,000 for the whole project");
    }

    function test_open_onlyTheLauncher_oneAtATime_andNeverBeyondTheSharesLeft() public {
        vm.expectRevert(Rounds.NotAllowed.selector);
        rd.open(1000 * DOLLAR, BASE_SHARES_PER_RAW_DOLLAR);
        vm.startPrank(address(launcher));
        vm.expectRevert(Rounds.CannotOpen.selector);
        rd.open(DOLLAR - 1, BASE_SHARES_PER_RAW_DOLLAR); // under 1 dollar
        vm.expectRevert(Rounds.CannotOpen.selector);
        rd.open(50_000 * DOLLAR + 1, BASE_SHARES_PER_RAW_DOLLAR); // more than the 150M can cover
        uint256 id = rd.open(50_000 * DOLLAR, BASE_SHARES_PER_RAW_DOLLAR); // the budget exactly
        assertEq(id, 1);
        assertTrue(rd.isOpen());
        vm.expectRevert(Rounds.CannotOpen.selector);
        rd.open(DOLLAR, BASE_SHARES_PER_RAW_DOLLAR); // one at a time
        vm.stopPrank();
        Rounds.Round memory r = rd.roundOf(1);
        assertEq(r.size, 50_000 * DOLLAR);
        assertEq(r.sharesPerRawDollar, BASE_SHARES_PER_RAW_DOLLAR);
        assertEq(r.openedAt, _now());
    }

    /// @dev Both RoundOpened events carry the round's price (the milestone 5 server reads it).
    function test_open_eventsCarrySizePriceAndTimes() public {
        vm.recordLogs();
        vm.prank(founder);
        launcher.openRound(key, 166_666_666_666_666);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == rounds && logs[i].topics[0] == Rounds.RoundOpened.selector) {
                (uint256 size, uint256 price, uint256 opens, uint256 closes) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                assertEq(size, 10_000 * DOLLAR);
                assertEq(price, 166_666_666_666_666);
                assertEq(closes - opens, 1 days);
                seen++;
            }
            if (logs[i].emitter == address(launcher) && logs[i].topics[0] == Launcher.RoundOpened.selector) {
                (uint256 size, uint256 cap, uint256 before, uint256 price) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                assertEq(size, 10_000 * DOLLAR);
                assertEq(cap, 10_000 * DOLLAR);
                assertEq(before, 0);
                assertEq(price, 166_666_666_666_666);
                seen++;
            }
        }
        assertEq(seen, 2);
    }

    // ================================================ asks =============================================================

    function test_ask_atLeastOneDollarInTotal_only24Hours_andTheDollarsWaitHere() public {
        uint256 id = _openRound();
        usd.mint(alice, 10 * DOLLAR);
        vm.startPrank(alice);
        usd.approve(rounds, type(uint256).max);
        vm.expectRevert(Rounds.BadAmount.selector);
        rd.ask(id, DOLLAR - 1);
        vm.expectRevert(Rounds.BadAmount.selector);
        rd.ask(id, 0);
        rd.ask(id, DOLLAR);
        rd.ask(id, 1); // once at 1 dollar, any top-up is fine
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.ask(id + 1, DOLLAR); // no such round
        vm.warp(_now() + 1 days);
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.ask(id, DOLLAR); // the 24 hours are over
        vm.stopPrank();
        assertEq(rd.positionOf(id, alice).ask, DOLLAR + 1);
        assertEq(rd.roundOf(id).asked, DOLLAR + 1);
        assertEq(usd.balanceOf(rounds), DOLLAR + 1, "the dollars wait in the Rounds");
        assertEq(usd.balanceOf(address(t)), 0);
    }

    function test_ask_aTokenThatDeliversLessIsRefused() public {
        uint256 id = _openRound();
        usd.setFees(100, 0); // 1% kept on the way in
        usd.mint(alice, 100 * DOLLAR);
        vm.startPrank(alice);
        usd.approve(rounds, type(uint256).max);
        vm.expectRevert(Rounds.TokenMisbehaved.selector);
        rd.ask(id, 100 * DOLLAR);
        vm.stopPrank();
    }

    function test_lower_onlyInTheFirst12Hours_downOrToZero_andTheDifferenceComesBack() public {
        uint256 id = _openRound();
        _ask(id, alice, 100 * DOLLAR);
        vm.startPrank(alice);
        vm.expectRevert(Rounds.BadAmount.selector);
        rd.lower(id, 100 * DOLLAR); // not lower
        vm.expectRevert(Rounds.BadAmount.selector);
        rd.lower(id, DOLLAR - 1); // between zero and 1 dollar
        rd.lower(id, 40 * DOLLAR);
        assertEq(usd.balanceOf(alice), 60 * DOLLAR);
        vm.warp(_now() + 12 hours - 1);
        rd.lower(id, 0); // withdrawn, one second before the 12 hours end
        assertEq(usd.balanceOf(alice), 100 * DOLLAR);
        rd.ask(id, 50 * DOLLAR); // and may ask again
        vm.warp(_now() + 1);
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.lower(id, 10 * DOLLAR); // from the 12th hour on, the amount asked stays
        vm.stopPrank();
        assertEq(rd.roundOf(id).asked, 50 * DOLLAR);
    }

    // ================================================ the close and the scale-back =====================================

    function test_close_after24HoursOnce_acceptsTheSmallerOfAskedAndSize() public {
        _checkIn();
        uint256 id = _openRound(); // 10,000 for a single founder
        _ask(id, alice, 4000 * DOLLAR);
        vm.warp(_now() + 1 days - 1);
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.close(id);
        vm.warp(_now() + 1);
        vm.prank(stranger);
        rd.close(id);
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.close(id);
        Rounds.Round memory r = rd.roundOf(id);
        assertEq(r.accepted, 4000 * DOLLAR);
        assertEq(rd.raised(), 4000 * DOLLAR);
        assertEq(rd.firstMoneyAt(), _now(), "Backed from this close");
        assertEq(rd.reserved(), 4000 * DOLLAR * 3e15, "the Shares owed stay set aside until settled");
        assertFalse(rd.isOpen());
    }

    function test_close_withNothingAskedLeavesTheProjectSolo() public {
        uint256 id = _openRound();
        _close(id);
        assertEq(rd.firstMoneyAt(), 0);
        assertEq(uint256(launcher.stageOf(key)), uint256(Launcher.Stage.Solo));
        uint256 id2 = _openRound(); // the next round may open at once
        assertEq(id2, 2);
    }

    /// @dev 12,000 asked into a 10,000 round: everyone gets the same percent (10,000 / 12,000), the rest comes back.
    function test_settle_scaleBack_everyAskTheSamePercent_restReturned() public {
        _checkIn();
        uint256 id = _openRound();
        _ask(id, alice, 6000 * DOLLAR);
        _ask(id, bob, 3000 * DOLLAR);
        _ask(id, carol, 3000 * DOLLAR);
        _close(id);
        assertEq(rd.roundOf(id).accepted, 10_000 * DOLLAR);
        address[] memory who = new address[](3);
        (who[0], who[1], who[2]) = (alice, bob, carol);
        rd.settleMany(id, who);
        uint256 a = rd.positionOf(id, alice).bought / 3e15;
        uint256 b = rd.positionOf(id, bob).bought / 3e15;
        assertEq(a, 6000 * DOLLAR * 10_000 / 12_000, "alice: 5,000");
        assertEq(b, 3000 * DOLLAR * 10_000 / 12_000, "bob: 2,500 (rounded down)");
        assertEq(usd.balanceOf(alice), 1000 * DOLLAR, "the rest of alice's ask came back");
        assertEq(usd.balanceOf(bob), 3000 * DOLLAR - b);
        // the same percent for everyone, to the unit
        assertEq(a * 12_000 / 6000, 10_000 * DOLLAR);
        // the scale-back dust (a raw unit or two of accepted money no one holds Shares for) went back to the backers with the
        // rest of their asks; `raised` (what the caps measure) still counts it
        uint256 accepted = a + 2 * b;
        assertLe(10_000 * DOLLAR - accepted, 2);
        assertEq(usd.balanceOf(alice) + usd.balanceOf(bob) + usd.balanceOf(carol), 12_000 * DOLLAR - accepted);
        assertEq(rd.raised(), 10_000 * DOLLAR, "raised counts the dust");
        assertEq(rd.reserved(), (10_000 * DOLLAR - accepted) * 3e15, "only the dust's Shares stay set aside");
    }

    function test_settle_splits3_15_82_andHoldsTheSharesInTheVester() public {
        uint256 id = _round(alice, 100 * DOLLAR);
        assertEq(rd.platformOwed(), 3 * DOLLAR, "3 to the platform (owed until swept)");
        assertEq(t.spendable(), 15 * DOLLAR, "15 to the project at once");
        assertEq(rd.roundOf(id).held, 82 * DOLLAR, "82 held for 26 weeks");
        assertEq(rd.positionOf(id, alice).held, 82 * DOLLAR);
        (uint256 total, uint256 claimed) = v.heldGrants(id, alice);
        assertEq(total, 300_000 * SHARE, "300,000 Shares, held");
        assertEq(claimed, 0);
        assertEq(shares.balanceOf(alice), 0, "nothing in hand before a market");
        assertEq(shares.balanceOf(address(v)), 200_000_000 * SHARE + 300_000 * SHARE);
        assertEq(usd.balanceOf(rounds), 85 * DOLLAR, "the 82 and the platform's 3");
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.settle(id, alice); // once
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.settle(id, bob); // never asked
    }

    function test_settle_beforeTheCloseIsRefused() public {
        uint256 id = _openRound();
        _ask(id, alice, 100 * DOLLAR);
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.settle(id, alice);
    }

    // ================================================ the release =====================================================

    function test_release_evenlyOver26WeeksWhileCheckedIn() public {
        uint256 id = _round(alice, 1000 * DOLLAR); // 820 held
        _live(13 weeks);
        assertEq(rd.releasable(id), 410 * DOLLAR, "half after 13 weeks");
        vm.prank(stranger);
        assertEq(rd.release(id), 410 * DOLLAR);
        assertEq(t.spendable(), 150 * DOLLAR + 410 * DOLLAR);
        _live(13 weeks);
        assertEq(rd.release(id), 410 * DOLLAR, "all of it after 26 weeks");
        _live(10 weeks);
        assertEq(rd.release(id), 0, "and nothing more");
        assertEq(usd.balanceOf(rounds), 30 * DOLLAR, "only the platform's 3 is left, waiting to be swept");
    }

    /// @dev The built Treasury's rule: time outside the 14-day window after a check-in never counts and is never paid back, so a
    /// lapse pushes the end date out by exactly the time lapsed.
    function test_release_aLapsePushesTheEndDateOutAndIsNeverPaidBack() public {
        uint256 id = _round(alice, 1820 * DOLLAR); // 1,492.4 held: 8.2 a day
        uint256 closed = _now();
        vm.warp(closed + 44 days); // the check-in was a day before the close: 13 days count, 31 are lost
        assertEq(rd.activeNow() - rd.roundOf(id).activeAtClose, 13 days);
        _checkIn();
        _live(169 days - 1);
        assertLt(rd.releasable(id), 1492.4e6, "26 weeks after the close plus the lapse is not enough");
        vm.warp(closed + 44 days + 169 days);
        _checkIn();
        assertEq(rd.releasable(id), 1492.4e6, "the end came 31 days late, to the second");
    }

    function test_release_pausedTimeDoesNotCount() public {
        uint256 id = _round(alice, 1820 * DOLLAR);
        address pauser = makeAddr("pauser");
        vm.prank(councilMaker);
        launcher.setPauser(key, pauser);
        _live(10 days);
        uint256 before = rd.releasable(id);
        vm.prank(pauser);
        t.setPaused(true);
        _live(30 days);
        assertEq(rd.releasable(id), before, "nothing while paused");
        vm.prank(pauser);
        t.setPaused(false);
        _live(1 days);
        assertEq(rd.releasable(id), before + 8.2e6, "one more day after the pause");
    }

    function test_release_aPauserMustBeNamedAndOnlyTheCouncilMakerNamesIt() public {
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setPaused(true); // no pauser yet: nobody
        vm.prank(founder);
        vm.expectRevert(Launcher.NotCouncilMaker.selector);
        launcher.setPauser(key, founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setPauser(founder);
    }

    // ================================================ the refund ======================================================

    /// @dev The plan's numbers, per 100 paid: 77.90 on day 0, 65.9 at week 4, 38.95 at week 13, nothing at week 26.
    function test_refund_thePlansNumbers() public {
        uint256 snap = vm.snapshotState();
        uint256[4] memory weeks_ = [uint256(0), 4, 13, 26];
        uint256[4] memory want = [uint256(77_900_000), 65_915_384, 38_950_000, 0];
        for (uint256 i; i < 4; ++i) {
            vm.revertToState(snap);
            uint256 id = _round(alice, 100 * DOLLAR);
            _live(weeks_[i] * 1 weeks);
            if (want[i] == 0) {
                vm.expectRevert(Rounds.NothingToRefund.selector);
                _refund(id, alice);
            } else {
                assertEq(rd.refundable(id, alice), want[i]);
                assertEq(_refund(id, alice), want[i]);
            }
        }
    }

    function test_refund_theFeeIsFiveOfTheUnreleased_fourToTheProjectOneToThePlatform_andTheSharesGoToTheReserve()
        public
    {
        uint256 id = _round(alice, 100 * DOLLAR);
        uint256 reserveBefore = t.reserve();
        uint256 spendableBefore = t.spendable();
        vm.recordLogs();
        assertEq(_refund(id, alice), 77.9e6);
        assertEq(t.spendable() - spendableBefore, 3.28e6, "4 of each 100 unreleased");
        assertEq(rd.platformOwed(), 3 * DOLLAR + 0.82e6, "1 of each 100 unreleased");
        assertEq(t.reserve() - reserveBefore, 300_000 * SHARE, "the held Shares are cancelled into the reserve");
        (uint256 total,) = v.heldGrants(id, alice);
        assertEq(total, 0);
        assertEq(rd.positionOf(id, alice).held, 0);
        vm.expectRevert(Rounds.NothingToRefund.selector);
        _refund(id, alice); // once
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == rounds && logs[i].topics[0] == Rounds.Refunded.selector) {
                (uint256 unrel, uint256 paid, uint256 toProject, uint256 toPlatform, uint256 cancelled) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256));
                assertEq(unrel, 82e6);
                assertEq(paid + toProject + toPlatform, unrel);
                assertEq(cancelled, 300_000 * SHARE);
                seen = true;
            }
        }
        assertTrue(seen);
    }

    function test_refund_settlesFirstIfNobodyDid() public {
        _checkIn();
        uint256 id = _openRound();
        _ask(id, alice, 100 * DOLLAR);
        _close(id);
        assertEq(_refund(id, alice), 77.9e6);
        assertEq(t.spendable(), 15 * DOLLAR + 3.28e6);
    }

    function test_refund_nobodyElseLeavingChangesYourNumber() public {
        _checkIn();
        uint256 id = _openRound();
        _ask(id, alice, 300 * DOLLAR);
        _ask(id, bob, 700 * DOLLAR);
        _ask(id, carol, 2000 * DOLLAR);
        _close(id);
        rd.settle(id, alice);
        rd.settle(id, bob);
        rd.settle(id, carol);
        _live(30 days);
        uint256 a = rd.refundable(id, alice);
        uint256 b = rd.refundable(id, bob);
        _refund(id, carol); // the biggest backer leaves
        assertEq(rd.refundable(id, alice), a);
        _refund(id, bob);
        assertEq(rd.refundable(id, alice), a, "nobody's leaving moves alice's number");
        assertEq(b, rd.refundable(id, alice) * 700 / 300 + (b - a * 700 / 300), "and bob's was his own");
        _live(10 days);
        rd.release(id);
        assertEq(_refund(id, alice) <= a, true);
    }

    /// @dev After the market opens the refund covers only the Shares still held for the backer; taking Shares out ends the refund
    /// for those Shares.
    function test_refund_afterTheMarket_onlyForSharesStillHeld() public {
        uint256 id = _round(alice, 1000 * DOLLAR); // 3,000,000 Shares held, 820 held money
        _live(30 days);
        _sale(7500 * DOLLAR); // the market opens: the clock of held Shares starts
        _live(73 days);
        uint256 full = rd.refundable(id, alice);
        vm.prank(alice);
        assertEq(v.claimHeld(id, alice), 3_000_000 * SHARE * 73 days / 365 days, "a fifth released and taken out");
        uint256 part = rd.refundable(id, alice);
        assertApproxEqAbs(part, full * 4 / 5, 2, "the refund now covers the four fifths still held");
        uint256 reserveBefore = t.reserve();
        assertEq(_refund(id, alice), part);
        assertEq(t.reserve() - reserveBefore, 3_000_000 * SHARE * 4 / 5, "the Shares still held are cancelled");
        assertEq(shares.balanceOf(alice), 600_000 * SHARE, "what alice took out stays hers");
        assertEq(rd.positionOf(id, alice).held, 820 * DOLLAR / 5, "her other fifth keeps paying the project");
        vm.expectRevert(Rounds.NothingToRefund.selector);
        _refund(id, alice);
        _live(26 weeks);
        rd.release(id);
        assertEq(rd.releasable(id), 0);
        assertEq(usd.balanceOf(rounds), rd.platformOwed(), "every held dollar reached the project or alice");
    }

    function test_refund_afterTakingEverythingOutThereIsNothingToTakeBack() public {
        uint256 id = _round(alice, 1000 * DOLLAR);
        _sale(7500 * DOLLAR);
        _live(366 days);
        vm.prank(alice);
        v.claimHeld(id, alice);
        vm.expectRevert(Rounds.NothingToRefund.selector);
        _refund(id, alice);
    }

    // ================================================ wind down and the rest ============================================

    function test_windDown_releaseStopsForGood_andTheRefundFeeIsThePlatformsOne() public {
        uint256 id = _round(alice, 100 * DOLLAR);
        _live(28 days);
        uint256 rel = rd.releasable(id);
        vm.prank(founder);
        launcher.windDown(key);
        assertTrue(rd.woundDown());
        _live(60 days);
        assertEq(rd.releasable(id), rel, "no release after the wind-down");
        uint256 held = 82e6;
        uint256 unrel = held - (held * 28 + 181) / 182; // the released part rounds up against the backer
        uint256 fee = (unrel + 99) / 100;
        assertEq(_refund(id, alice), unrel - fee, "only the platform's 1 is kept");
        assertEq(rd.platformOwed(), 3 * DOLLAR + fee);
    }

    function test_sweepFees_sendsThePlatformItsMoney_andABlockedPlatformBlocksOnlyThis() public {
        uint256 id = _round(alice, 100 * DOLLAR);
        usd.setBlocked(platform, true);
        vm.expectRevert();
        rd.sweepFees();
        _refund(id, alice); // the refund still works
        usd.setBlocked(platform, false);
        rd.sweepFees();
        assertEq(usd.balanceOf(platform), 3 * DOLLAR + 0.82e6);
        assertEq(rd.platformOwed(), 0);
        rd.sweepFees(); // nothing owed: nothing happens
    }

    function test_returnUnsold_onlyOnceNoRoundCanOpen_andKeepsWhatIsOwed() public {
        _checkIn();
        uint256 id = _openRound();
        _ask(id, alice, 100 * DOLLAR);
        _close(id);
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.returnUnsold();
        _market();
        uint256 before = t.reserve();
        rd.returnUnsold();
        assertEq(t.reserve() - before, 150_000_000 * SHARE - 300_000 * SHARE, "everything but alice's Shares");
        vm.warp(_now() + 1 days);
        rd.settle(id, alice); // alice is settled after the market: her Shares were kept for her
        (uint256 total,) = v.heldGrants(id, alice);
        assertEq(total, 300_000 * SHARE);
        assertGt(v.claimableHeld(id, alice), 0, "on the same clock: part of it is released at once if time passed");
    }

    function test_sync_anyone_windDown_onlyTheTreasury() public {
        rd.sync();
        vm.expectRevert(Rounds.NotAllowed.selector);
        rd.windDown();
    }

    function test_initialize_onceAndNotOnTheImplementation() public {
        vm.expectRevert(Rounds.BadSetup.selector);
        rd.initialize(
            address(this), ITreasuryRounds(address(t)), IVester(address(v)), IShares(address(shares)), usd_(), platform
        );
        Rounds impl = Rounds(launcher.roundsImpl());
        vm.expectRevert(Rounds.BadSetup.selector);
        impl.initialize(
            address(this), ITreasuryRounds(address(t)), IVester(address(v)), IShares(address(shares)), usd_(), platform
        );
    }

    function usd_() internal view returns (IERC20) {
        return IERC20(address(usd));
    }
}
