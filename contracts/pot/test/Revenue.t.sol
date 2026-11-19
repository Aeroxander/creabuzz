// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice Outside money arrives in the pot evenly over one time unit; a joiner pays it at face, a leaver is paid on what
/// has arrived. These tests run with no allowance (rate 0) so the numbers are the revenue's alone.
contract RevenueTest is PotBase {
    function setUp() public override {
        super.setUp();
        _relaunch(0, 0); // no Team Shares, no allowance
        _join(alice, 100_000e6); // pot and paid-in 98,000
    }

    function test_oneStreamIsLinearOverOneUnit() public {
        usd.mint(carol, 9800e6);
        vm.startPrank(carol);
        usd.approve(address(t), 9800e6);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.RevenueAdded(carol, 9800e6, 9800e6, uint64(T0 + UNIT));
        t.addRevenue(9800e6);
        vm.stopPrank();
        assertEq(t.arriving(), 9800e6);
        assertEq(t.pot(), 98_000e6, "none of it is in the pot yet");
        vm.warp(T0 + UNIT / 2);
        t.settle();
        assertEq(t.pot(), 98_000e6 + 4900e6);
        assertEq(t.arriving(), 4900e6);
        vm.warp(T0 + UNIT - 1);
        t.settle();
        assertGt(t.arriving(), 0);
        vm.warp(T0 + UNIT);
        t.settle();
        assertEq(t.arriving(), 0, "complete exactly at the end");
        assertEq(t.pot(), 107_800e6);
        _assertConserved();
    }

    function test_theWholePaymentArrivesWhateverTheSettlePoints() public {
        _revenue(carol, 10_000_001);
        uint256[5] memory at = [uint256(1), 1000, 100_000, 400_000, 604_799];
        for (uint256 i; i < at.length; ++i) {
            vm.warp(T0 + at[i]);
            t.settle();
        }
        vm.warp(T0 + UNIT + 5);
        t.settle();
        assertEq(t.arriving(), 0);
        assertEq(t.pot(), 98_000e6 + 10_000_001, "not a unit lost or made by the floors");
    }

    function test_aSecondPaymentMergesIntoOneStreamByWeightedAverage() public {
        _revenue(carol, 9800e6); // ends T0 + 7d
        vm.warp(T0 + 3.5 days);
        _checkIn();
        _revenue(carol, 4900e6); // 4,900 left of the first, 3.5 days to run; 4,900 new over 7
        assertEq(t.arriving(), 9800e6);
        assertEq(t.arrivalEnd(), T0 + 3.5 days + 5.25 days, "the average of 3.5 and 7 days, weighted equally");
        vm.warp(T0 + 8.75 days);
        t.settle();
        assertEq(t.arriving(), 0);
        assertEq(t.pot(), 98_000e6 + 14_700e6);
    }

    function test_minimumPayment() public {
        usd.mint(carol, 1e6);
        vm.startPrank(carol);
        usd.approve(address(t), 1e6);
        vm.expectRevert(abi.encodeWithSelector(Treasury.BelowMinimum.selector, 1e6, 999_999));
        t.addRevenue(999_999);
        t.addRevenue(1e6);
        vm.stopPrank();
    }

    function test_theArrivedAmountIsWhatIsCounted() public {
        usd.setFees(100, 0);
        _revenue(carol, 100e6);
        assertEq(t.arriving(), 99e6);
        assertEq(t.unaccounted(), 0);
    }

    // ---- a leaver is paid on what has arrived

    function test_honestLeaverGetsLessThanFaceWhileMoneyIsArriving() public {
        _revenue(carol, 9800e6); // 10% of the pot, face 107,800
        uint256 n = shares.balanceOf(alice);
        (uint256 now0,, uint256 left0) = t.quoteTakeOut(alice, n);
        assertEq(now0, 98_000e6);
        assertEq(left0, 9800e6, "the part still arriving stays for those who stay");
        // day 0: 90.9 per 100 of face
        assertApproxEqRel(now0 * 1e18 / 107_800e6, 0.909e18, 1e15);
        // day 3: 94.8 per 100
        vm.warp(T0 + 3 days);
        (uint256 now3,,) = t.quoteTakeOut(alice, n);
        assertEq(now3, 98_000e6 + 9800e6 * 3 / 7);
        assertApproxEqRel(now3 * 1e18 / 107_800e6, 0.948e18, 1e15);
    }

    function test_leaveExcludesTheArrivingMoney() public {
        _revenue(carol, 9800e6);
        uint256 n = shares.balanceOf(alice);
        assertEq(_leave(alice, n), 98_000e6);
        assertEq(t.arriving(), 9800e6, "still arriving, now for whoever joins");
        _assertConserved();
    }

    function test_aJoinerPaysTheArrivingMoneyAtFace() public {
        _revenue(carol, 9800e6);
        (uint256 quoted,,,) = t.quoteBack(100_000e6);
        // price = (pot + arriving + 1 dollar) per (Shares + 100): 98,000 + 9,800 + 1
        uint256 b = shares.totalSupply();
        uint256 expected = 98_000e6 * (b + 100e18) / (107_800e6 + 1e6);
        assertEq(quoted, expected);
        uint256 plain = 98_000e6 * (b + 100e18) / (98_000e6 + 1e6);
        assertLt(quoted, plain, "fewer Shares for the same money: the payment is already priced in");
    }

    function test_someoneWhoJoinsAfterThePaymentIsVisibleCapturesNoneOfIt() public {
        _revenue(carol, 9800e6);
        uint256 n = _join(bob, 100_000e6);
        vm.warp(T0 + UNIT);
        t.settle();
        uint256 got = _leave(bob, n);
        assertApproxEqRel(got, 98_000e6, 1e14, "98 per 100 paid, as if the payment had never come");
        assertLe(got, 98_000e6 + 98_000e6 / 1e4);
    }

    function test_anInsiderWhoJoinsBeforeAKnownPaymentAndStaysSharesIt() public {
        uint256 n = _join(bob, 100_000e6); // as much as the pot, before the payment
        _revenue(carol, 9800e6);
        vm.warp(T0 + UNIT);
        t.settle();
        uint256 got = _leave(bob, n);
        // +2.90 per 100 paid, over the week: not stopped, a question for counsel
        assertGt(got, 102_800e6);
        assertLt(got, 103_000e6);
        uint256 aliceGot = _leave(alice, shares.balanceOf(alice));
        assertApproxEqAbs(
            aliceGot, 102_900e6, 50e6, "Alice ends about 4,900 below the 107,800 she would have had alone"
        );
    }

    // ---- must-bind 5: join, payment and take-out in one block net the 2% fee and nothing else

    function _sandwich(uint256 payPct, uint256 joinTenths, uint256 pool) internal {
        _relaunch(pool, 0);
        _join(alice, 100_000e6);
        uint256 potNow = t.pot();
        uint256 joinAmt = potNow * joinTenths / 10;
        uint256 payment = potNow * payPct / 100;
        uint256 n = _join(bob, joinAmt);
        _revenue(carol, payment);
        uint256 got = _leave(bob, n);
        uint256 afterFee = joinAmt - joinAmt * 2 / 100;
        assertApproxEqAbs(got, afterFee, joinAmt / 5000 + 10, "-2.00 per 100 paid");
        assertLe(got, afterFee + joinAmt / 5000 + 10, "and no more than that");
        _assertConserved();
    }

    function test_theSandwichNetsOnlyTheFee() public {
        uint256[3] memory pays = [uint256(10), 25, 50];
        uint256[3] memory joins = [uint256(1), 10, 30]; // 0.1, 1 and 3 times the pot
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                _sandwich(pays[i], joins[j], 0);
            }
        }
    }

    function test_theSandwichWithATeamPoolNetsOnlyTheFee() public {
        uint256[3] memory pays = [uint256(10), 25, 50];
        uint256[3] memory joins = [uint256(1), 10, 30];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                _sandwich(pays[i], joins[j], POOL);
            }
        }
    }

    function test_aPaymentFirstThenJoinAndLeaveLosesMoreThanTheFee() public {
        _revenue(carol, 9800e6);
        uint256 n = _join(bob, 98_000e6);
        uint256 got = _leave(bob, n);
        uint256 afterFee = 98_000e6 - 98_000e6 * 2 / 100;
        assertLt(got, afterFee, "a joiner pays the arriving money at face and a leaver does not get it");
    }

    // ---- other states

    function test_arrivingMoneyKeepsReleasingWhenQuietAndAfterAWindDown() public {
        _revenue(carol, 9800e6);
        vm.warp(T0 + 3 * UNIT); // no check-in: quiet
        t.settle();
        assertEq(t.arriving(), 0, "released on calendar time");
        assertEq(t.pot(), 107_800e6);
        vm.prank(founder);
        t.windDown();
        _revenue(carol, 1000e6);
        vm.warp(block.timestamp + UNIT);
        t.settle();
        assertEq(t.arriving(), 0);
        assertEq(t.pot(), 108_800e6);
    }

    function test_revenueBeforeTheFirstBackerIsPricedAtFace() public {
        _relaunch(0, 0);
        _revenue(carol, 10e6);
        uint256 n = _join(bob, 100e6);
        // vq = (10 + 1 dollar) per 100 Shares of offset: 98 / 11 dollars worth of 0.01-Shares
        assertEq(n, uint256(98e6) * 100e18 / 11e6);
        assertLt(n, 9800e18);
    }
}
