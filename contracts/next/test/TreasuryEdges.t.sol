// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./helpers/Base.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Vester} from "../src/Vester.sol";

/// @notice The edges: pause and resume of the daily release, the boundary second of a check-in, dust, the largest raise,
/// and quote tokens that misbehave.
contract TreasuryEdgesTest is Base {
    // ---------------------------------------------------------------------------------------- pause and resume

    function test_edge_pauseAndResumeOfTheDailyRelease() public {
        _sale(7500 * DOLLAR);
        uint256 t0 = _now();
        vm.warp(t0 + 14 days); // a full window passes and nobody checks in again
        t.release();
        uint256 afterWindow = t.spendable();
        assertEq(afterWindow, S + M * 14 days / 365 days);
        // 60 days of silence: the daily release is paused, whatever is asked
        vm.warp(t0 + 74 days);
        assertEq(t.pendingRelease(), 0);
        t.release();
        assertEq(t.spendable(), afterWindow);
        // an agent presses check-in: the release resumes from this second, with no back pay for the 60 days
        vm.prank(founder);
        t.setAgent(agent, 0, 0);
        vm.prank(agent);
        t.checkIn();
        vm.warp(_now() + 1 days);
        assertEq(t.pendingRelease(), (M - M * 14 days / 365 days) * 1 days / (365 days - 14 days));
        // and it pauses again by itself 14 days after that check-in
        vm.warp(_now() + 40 days);
        t.release();
        assertEq(t.meltRemaining(), 365 days - 14 days - 14 days);
    }

    function test_edge_theFloorStaysWholeAndExitableWhileThePaymentsArePaused() public {
        _world();
        vm.warp(_now() + 100 days);
        t.release(); // 14 days were paid, the rest are paused
        uint256 floorWhilePaused = t.melting();
        vm.warp(_now() + 200 days);
        assertEq(t.melting(), floorWhilePaused);
        // 300 days after the pool opened, 300/365 of the founder's 200M are released (claimed or not) and count
        uint256 counting = 500_000_000 * SHARE + 200_000_000 * SHARE * 300 days / 365 days;
        uint256 slice = floorWhilePaused * (100_000_000 * SHARE) / counting;
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertEq(paid, slice - (slice * 500 + 9999) / 10_000);
    }

    // ------------------------------------------------------------------------------------- the boundary second

    function test_edge_aCheckInOnTheLastSecondOfTheWindowLosesNothingAndCountsNothingTwice() public {
        _sale(7500 * DOLLAR);
        uint256 t0 = _now();
        vm.warp(t0 + 14 days); // exactly lastCheckIn + 14 days
        assertEq(t.pendingRelease(), M * 14 days / 365 days, "the whole window is counted");
        vm.prank(founder);
        t.checkIn();
        uint256 afterFirst = t.spendable();
        assertEq(afterFirst, S + M * 14 days / 365 days);
        vm.warp(_now() + 14 days);
        uint256 second = t.pendingRelease();
        assertEq(second, (M - M * 14 days / 365 days) * 14 days / (365 days - 14 days));
        t.release();
        assertEq(t.meltRemaining(), 365 days - 28 days, "28 active days used, none twice");
    }

    function test_edge_aCheckInOneSecondLateLosesThatSecondForGood() public {
        _sale(7500 * DOLLAR);
        vm.warp(_now() + 14 days + 1);
        assertEq(t.pendingRelease(), M * 14 days / 365 days, "the second after the window is not counted");
        vm.prank(founder);
        t.checkIn();
        assertEq(t.meltRemaining(), 365 days - 14 days);
        vm.warp(_now() + 1);
        assertEq(t.pendingRelease(), (M - M * 14 days / 365 days) * 1 / (365 days - 14 days));
    }

    function test_edge_aCheckInOneSecondEarlyCountsEverySecond() public {
        _sale(7500 * DOLLAR);
        vm.warp(_now() + 14 days - 1);
        vm.prank(founder);
        t.checkIn();
        assertEq(t.meltRemaining(), 365 days - (14 days - 1));
        vm.warp(_now() + 14 days);
        t.release();
        assertEq(t.meltRemaining(), 365 days - (14 days - 1) - 14 days);
    }

    // ----------------------------------------------------------------------------------------------- dust

    function test_edge_exitsOfOneRawUnitOfSharesPayNothingAndAreRefusedUnburned() public {
        _world();
        uint256 supply = shares.totalSupply();
        vm.prank(alice);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.handBack(1);
        assertEq(shares.totalSupply(), supply, "nothing was burned");
        assertEq(shares.balanceOf(alice), 100_000_000 * SHARE);
    }

    function test_edge_theSmallestExitThatPaysAnythingPaysOneRawDollarUnitAndStaysConsistent() public {
        _world();
        uint256 counting = t.countingSupply();
        // slice = floor * amount / counting; the 5% fee rounds up; the least that leaves a unit is slice 2
        uint256 least = (2 * counting + M - 1) / M; // smallest amount with slice >= 2
        vm.prank(alice);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.handBack(least - 1);
        uint256 paid = _handBack(alice, least);
        assertEq(paid, 1, "one millionth of a dollar");
        assertEq(t.feesOwed(), 0, "a platform part under one unit rounds to nothing");
        assertEq(_buckets(), usd.balanceOf(address(t)));
        assertLe(t.melting(), M - 1);
    }

    /// The 4% of an exit that stays in the floor goes to "those who remain", and a holder who exits in pieces is one of
    /// them. So the fee is not a flat 5% against a holder who exits many times: the report says how much this is worth.
    function test_edge_exitingInManyPiecesRecoversPartOfTheFeeBoundedByTheHoldersShare() public {
        _world();
        uint256 snapshot = vm.snapshotState();
        uint256 oneGo = _handBack(alice, 100_000_000 * SHARE); // 20% of the counting Shares
        vm.revertToState(snapshot);
        uint256 total;
        for (uint256 i; i < 100; ++i) {
            total += _handBack(alice, 1_000_000 * SHARE);
        }
        emit log_named_uint("alice 20%, one exit (micro dollars)", oneGo);
        emit log_named_uint("alice 20%, 100 exits (micro dollars)", total);
        assertGt(total, oneGo, "a few more cents: she is one of those who remain");
        assertLt(total, oneGo * 1005 / 1000, "under half a percent more for a holder of a fifth of the counting Shares");
        // the most that anyone could take back is the 4% that stays, so a fee of 5% never falls under 1% of the slice
        assertGt(total, 6000 * DOLLAR / 5 * 95 / 100);
        vm.revertToState(snapshot);
        uint256 bobOne = _handBack(bob, 400_000_000 * SHARE); // 80%
        vm.revertToState(snapshot);
        uint256 bobMany;
        for (uint256 i; i < 400; ++i) {
            bobMany += _handBack(bob, 1_000_000 * SHARE);
        }
        emit log_named_uint("bob 80%, one exit", bobOne);
        emit log_named_uint("bob 80%, 400 exits", bobMany);
        assertLt(bobMany, 6000 * DOLLAR * 99 / 100, "never more than the floor less the platform's 1%");
        assertGt(bobMany, bobOne);
    }

    // ------------------------------------------------------------------------------------------ big and small

    function test_edge_theLargestRaiseThePlanAllowsPassesThroughEveryStep() public {
        // the route was proven up to a sale of 1 quadrillion dollars (1e15 dollars = 1e21 raw units); the treasury gets 75
        uint256 big = 750_000_000_000_000 * DOLLAR;
        _sale(big);
        _buy(alice, 100_000_000 * SHARE);
        _buy(bob, 400_000_000 * SHARE);
        _approveAll(alice);
        uint256 floorMoney = big * 60 / 75;
        assertEq(t.melting(), floorMoney);
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertEq(paid, floorMoney / 5 - (floorMoney / 5 * 500 + 9999) / 10_000);
        assertEq(_buckets(), usd.balanceOf(address(t)));
        // and a 22 dollar sale (the smallest the auction accepts) with a holder of one whole Share
    }

    function test_edge_theSmallestSaleStillSplitsAndPays() public {
        _sale(16_260_000); // 16.26 dollars reach the treasury of a 21.68 dollar sale
        _buy(alice, 400_000_000 * SHARE);
        _approveAll(alice);
        assertEq(t.spendable(), 16_260_000 / 5);
        uint256 paid = _handBack(alice, 400_000_000 * SHARE);
        assertGt(paid, 0);
        assertEq(_buckets(), usd.balanceOf(address(t)));
    }

    function test_edge_anAbsurdAmountRevertsInsteadOfWrapping() public {
        _sale(1e60); // far beyond any token's supply
        _buy(alice, 100_000_000 * SHARE);
        _approveAll(alice);
        vm.prank(alice);
        vm.expectRevert(); // floor * shares would pass 2^256: a checked multiplication, never a wrong payout
        t.handBack(100_000_000 * SHARE);
        assertEq(shares.balanceOf(alice), 100_000_000 * SHARE);
    }

    // ----------------------------------------------------------------------------- tokens that misbehave

    function test_edge_aTokenThatReturnsFalseInsteadOfRevertingMovesNothingAndChangesNothing() public {
        _world();
        usd.mint(alice, 100 * DOLLAR);
        vm.prank(alice);
        usd.approve(address(t), type(uint256).max);
        usd.setFalse(false, true); // every transfer returns false and moves nothing
        uint256 floorBefore = t.melting();
        uint256 supply = shares.totalSupply();
        vm.startPrank(founder);
        vm.expectRevert();
        t.spend(carol, 1 * DOLLAR);
        vm.stopPrank();
        vm.startPrank(alice);
        vm.expectRevert();
        t.topUp(10 * DOLLAR);
        vm.expectRevert();
        t.shareRevenue(10 * DOLLAR);
        vm.expectRevert();
        t.handBack(10_000_000 * SHARE);
        vm.stopPrank();
        usd.setFalse(false, false);
        // nothing was counted, burned or moved by the failed calls
        assertEq(t.spendable(), S);
        assertEq(t.melting(), floorBefore);
        assertEq(t.permanentFloor(), 0);
        assertEq(shares.totalSupply(), supply);
        assertEq(_buckets(), usd.balanceOf(address(t)));
        // and the same calls work once the token behaves
        vm.prank(alice);
        t.handBack(10_000_000 * SHARE);
    }

    function test_edge_aTokenThatReturnsFalseOnAnUnfundedPullIsRefused() public {
        usd.setFalse(true, false);
        vm.prank(alice);
        vm.expectRevert(); // no allowance: the token says false, the treasury reverts
        t.topUp(1);
        assertEq(t.spendable(), 0);
    }

    function test_edge_aTokenThatChargesTheSenderOnTopCannotMakeTheBucketsExceedTheBalance() public {
        _world();
        usd.setFees(0, 100); // the sender is charged 1% extra on every transfer
        vm.prank(founder);
        vm.expectRevert(Treasury.TokenMisbehaved.selector);
        t.spend(carol, 100 * DOLLAR);
        vm.prank(alice);
        vm.expectRevert(Treasury.TokenMisbehaved.selector);
        t.handBack(10_000_000 * SHARE);
        assertEq(shares.balanceOf(alice), 100_000_000 * SHARE, "the failed exit burned nothing");
        assertEq(t.spendable(), S);
        assertEq(_buckets(), usd.balanceOf(address(t)));
    }

    function test_edge_aTokenThatKeepsAFeeFromTheReceiverMakesOnlyTheReceiverPayIt() public {
        _world();
        usd.setFees(100, 0); // 1% of what is sent stays in the token
        vm.prank(founder);
        t.spend(carol, 100 * DOLLAR);
        assertEq(usd.balanceOf(carol), 99 * DOLLAR);
        assertEq(t.spendable(), S - 100 * DOLLAR);
        assertEq(_buckets(), usd.balanceOf(address(t)), "the treasury gave exactly what its buckets lost");
    }

    function test_edge_aFeeTokenCreditsOnlyWhatArrivedOnTopUp() public {
        usd.setFees(250, 0);
        usd.mint(alice, 1000 * DOLLAR);
        vm.startPrank(alice);
        usd.approve(address(t), 1000 * DOLLAR);
        t.topUp(1000 * DOLLAR);
        vm.stopPrank();
        assertEq(t.spendable(), 975 * DOLLAR);
        assertEq(_buckets(), usd.balanceOf(address(t)));
    }

    // --------------------------------------------------------------------------------------- other edges

    function test_edge_theFeesOwedCannotBeSettledAgainAsNewMoney() public {
        _world();
        _handBack(alice, 100_000_000 * SHARE);
        assertEq(t.feesOwed(), 12 * DOLLAR);
        assertEq(t.unaccounted(), 0);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotArrived.selector, 1, 0));
        t.settle(1);
    }

    function test_edge_afterTheFloorIsFullyReleasedOnlyTheRevenueFloorPays() public {
        _world();
        usd.mint(alice, 500 * DOLLAR);
        vm.startPrank(alice);
        usd.approve(address(t), 500 * DOLLAR);
        t.shareRevenue(500 * DOLLAR);
        vm.stopPrank();
        _runFor(366 days);
        t.release();
        assertEq(t.melting(), 0);
        // a year on, all of the founder's 200M are released and count whether or not the founder has claimed: 700M count
        uint256 slice = 500 * DOLLAR * 100 / 700;
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertEq(paid, slice - (slice * 500 + 9999) / 10_000, "a seventh of the 500 permanent floor, less 5%");
    }

    function test_edge_vestedSharesAreFreeExactlyAtTheEndOfTheYear() public {
        _openPool();
        uint256 s = v.start();
        vm.warp(s + 365 days - 1);
        assertLt(v.released(founder), 200_000_000 * SHARE);
        vm.warp(s + 365 days);
        assertEq(v.released(founder), 200_000_000 * SHARE);
    }

    function test_edge_giftsBeforeThePoolDoNotUseUpTheMonthlyCapAfterIt() public {
        vm.prank(founder);
        t.giveShares(alice, 50_000_000 * SHARE); // vests; far over 1%
        _openPool();
        assertEq(t.giftsUsed(), 0);
        vm.prank(founder);
        t.giveShares(bob, 10_000_000 * SHARE);
        assertEq(shares.balanceOf(bob), 10_000_000 * SHARE);
    }

    function test_edge_theCapFollowsTheSharesThatExistAfterBurns() public {
        _world();
        vm.prank(alice);
        shares.burn(100_000_000 * SHARE); // 10% of all Shares burned: 1% is now 9,000,000
        vm.startPrank(founder);
        t.giveShares(carol, 9_000_000 * SHARE);
        vm.expectRevert();
        t.giveShares(carol, 1);
        vm.stopPrank();
    }
}
