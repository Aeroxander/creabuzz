// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {PotBase} from "./helpers/PotBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {PotMath} from "../src/PotMath.sol";
import {PlayDollar} from "../src/PlayDollar.sol";
import {TreasuryHarness} from "./helpers/TreasuryHarness.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {MockVester} from "./helpers/Mocks.sol";

contract JoinTest is PotBase {
    function test_firstJoinPricesOneCentWhateverTheTeamPool() public {
        uint256[3] memory pools = [uint256(0), POOL, 100_000_000e18];
        for (uint256 i; i < 3; ++i) {
            (TreasuryHarness tr, ShareToken sh,,) = _launch(IERC20(address(usd)), pools[i], 1000, 200, UNIT);
            usd.mint(alice, 100e6);
            vm.startPrank(alice);
            usd.approve(address(tr), 100e6);
            uint256 n = tr.join(100e6, 0, alice);
            vm.stopPrank();
            assertEq(n, 9_800e18, "98 dollars at 0.01 a Share");
            assertEq(sh.balanceOf(alice), 9_800e18);
            assertEq(tr.pot(), 98e6);
            assertEq(tr.paidIn(), 98e6);
            assertEq(tr.feesOwed(), 2e6);
        }
    }

    function test_secondJoinAtParIsAlsoOneCent() public {
        _join(alice, 100e6);
        uint256 n = _join(bob, 100e6);
        assertEq(n, 9_800e18);
        assertEq(t.pot(), 196e6);
        assertEq(t.paidIn(), 196e6);
    }

    function test_feeRoundsUpByAtMostOneUnit() public {
        uint256 n = _join(alice, 1_000_001); // exact fee 20,000.02
        assertEq(t.feesOwed(), 20_001);
        assertEq(t.pot(), 980_000);
        assertEq(n, 980_000 * 1e14);
        assertEq(t.pot() + t.feesOwed(), 1_000_001);
    }

    function test_belowOneDollarReverts() public {
        usd.mint(alice, 2e6);
        vm.startPrank(alice);
        usd.approve(address(t), 2e6);
        vm.expectRevert(abi.encodeWithSelector(Treasury.BelowMinimum.selector, 1e6, 999_999));
        t.join(999_999, 0, alice);
        t.join(1e6, 0, alice); // exactly one dollar is fine
        vm.stopPrank();
    }

    function test_minSharesGuard() public {
        usd.mint(alice, 100e6);
        vm.startPrank(alice);
        usd.approve(address(t), 100e6);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooFewShares.selector, 9_800e18 + 1, 9_800e18));
        t.join(100e6, 9_800e18 + 1, alice);
        t.join(100e6, 9_800e18, alice);
        vm.stopPrank();
    }

    function test_sharesGoToTheNamedRecipient() public {
        usd.mint(alice, 100e6);
        vm.startPrank(alice);
        usd.approve(address(t), 100e6);
        t.join(100e6, 0, bob);
        vm.stopPrank();
        assertEq(shares.balanceOf(bob), 9_800e18);
        assertEq(shares.balanceOf(alice), 0);
    }

    function test_doorSwitchShutsJoinButNotLeave() public {
        uint256 n = _join(alice, 100e6);
        vm.prank(founder);
        t.setDoor(false);
        usd.mint(bob, 100e6);
        vm.startPrank(bob);
        usd.approve(address(t), 100e6);
        vm.expectRevert(Treasury.DoorShut.selector);
        t.join(100e6, 0, bob);
        vm.stopPrank();
        assertGt(_leave(alice, n), 0);
        vm.prank(founder);
        t.setDoor(true);
        _join(bob, 100e6);
    }

    function test_doorShutsExactlyAtTheEndOfTheWindow() public {
        uint256 end = t.activeEnd();
        assertEq(end, T0 + 2 * UNIT);
        vm.warp(end - 1);
        assertTrue(t.doorOpenNow());
        _join(alice, 100e6);
        vm.warp(end);
        assertFalse(t.doorOpenNow());
        usd.mint(bob, 100e6);
        vm.startPrank(bob);
        usd.approve(address(t), 100e6);
        vm.expectRevert(Treasury.DoorShut.selector);
        t.join(100e6, 0, bob);
        vm.stopPrank();
        vm.warp(end + 1);
        assertFalse(t.doorOpenNow());
        _checkIn();
        assertTrue(t.doorOpenNow());
        _join(bob, 100e6);
    }

    function test_doorShutAfterWindDown() public {
        vm.prank(founder);
        t.windDown();
        usd.mint(bob, 100e6);
        vm.startPrank(bob);
        usd.approve(address(t), 100e6);
        vm.expectRevert(Treasury.DoorShut.selector);
        t.join(100e6, 0, bob);
        vm.stopPrank();
    }

    function test_quoteBackEqualsTheRealJoinExactly() public {
        uint256[6] memory amounts = [uint256(1e6), 7e6 + 3, 100e6, 5_000e6, 80_000e6, 400_000e6];
        _join(alice, 50_000e6);
        _revenue(carol, 3_000e6); // money still arriving
        vm.warp(block.timestamp + 2 days);
        _checkIn();
        for (uint256 i; i < amounts.length; ++i) {
            t.settle(); // the quote works out the release up to now; so does the join
            (uint256 quoted,,, uint256 arrivingLine) = t.quoteBack(amounts[i]);
            assertEq(arrivingLine, t.arriving());
            uint256 got = _join(bob, amounts[i]);
            assertEq(got, quoted, "the quote is the join");
            vm.warp(block.timestamp + 3 hours);
        }
    }

    function test_quoteBackTakeOutNowIsWhatAnInstantLeaveGives() public {
        _join(alice, 50_000e6);
        (uint256 sharesOut, uint256 takeOutNow,,) = t.quoteBack(1_000e6);
        uint256 n = _join(bob, 1_000e6);
        assertEq(n, sharesOut);
        assertEq(_leave(bob, n), takeOutNow, "the sheet's 'take out now' is exact");
    }

    function test_feeOnTransferTokenIsMeasured() public {
        usd.setFees(100, 0); // the token keeps 1% of every transfer
        usd.mint(alice, 100e6);
        vm.startPrank(alice);
        usd.approve(address(t), 100e6);
        t.join(100e6, 0, alice);
        vm.stopPrank();
        // 99 dollars arrived; the 2% fee is on what arrived
        assertEq(t.feesOwed(), PotMath.fee(99e6, 200));
        assertEq(t.pot(), 99e6 - PotMath.fee(99e6, 200));
        assertEq(usd.balanceOf(address(t)), 99e6);
        assertEq(t.unaccounted(), 0);
    }

    function test_sharesCap() public {
        _join(alice, 100e6);
        t.forceShares(bob, 1e30 - 9_800e18 - 5e18);
        vm.expectRevert(Treasury.TooManyShares.selector);
        this.joinAs(carol, 100e6);
    }

    function joinAs(address who, uint256 amount) external {
        _join(who, amount);
    }

    // ---- paid-in credit in both regimes

    function test_creditIsTheWholePaymentWhenThePotIsAtOrUnderPaidIn() public {
        _join(alice, 100e6);
        _force(60e6, 98e6, 0, 0, 0); // spent down to 60 of 98
        uint256 beforeA = t.paidIn();
        uint256 n = _join(bob, 10e6);
        assertEq(t.paidIn() - beforeA, PotMath.credit(9_800_000, n, beforeA, shares.totalSupply() - n));
        // pot under paid-in: new money is credited in full only if n x A / B is not smaller
        assertLe(t.paidIn() - beforeA, 9_800_000);
    }

    function test_creditIsTheBackersSliceWhenThePotIsAbovePaidIn() public {
        _join(alice, 100e6);
        _force(120e6, 98e6, 0, 0, 0); // surplus of 22 above paid-in
        uint256 b = shares.totalSupply();
        uint256 n = _join(bob, 10e6);
        uint256 credit = t.paidIn() - 98e6;
        assertEq(credit, n * 98e6 / b);
        assertLt(credit, 9_800_000, "the rest buys a slice of the surplus");
    }

    function test_creditWithMoneyArriving() public {
        _join(alice, 100e6);
        _revenue(carol, 10e6);
        uint256 b = shares.totalSupply();
        uint256 aBefore = t.paidIn();
        uint256 n = _join(bob, 10e6);
        assertEq(t.paidIn() - aBefore, PotMath.credit(9_800_000, n, aBefore, b));
    }

    // ---- zero mint and the donation trick

    function test_mintThatRoundsToZeroIsRefused() public {
        _join(alice, 100e6);
        _force(1e32, 98e6, 0, 0, 0); // a pot so large one dollar buys under one Share unit
        usd.mint(bob, 1e6);
        vm.startPrank(bob);
        usd.approve(address(t), 1e6);
        vm.expectRevert(Treasury.ZeroMint.selector);
        t.join(1e6, 0, bob);
        vm.stopPrank();
    }

    function test_donationDoesNotMoveThePrice() public {
        // First depositor joins with the smallest amount, then donates a lot by plain transfer to inflate the price.
        uint256 attackerShares = _join(alice, 1e6);
        usd.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usd.transfer(address(t), 1_000_000e6);
        assertEq(t.unaccounted(), 1_000_000e6);
        uint256 victim = _join(bob, 1e6);
        assertEq(victim, attackerShares, "the same dollar buys the same Shares: the donation is not in the pot");
        assertEq(t.pot(), 1_960_000);
    }

    function test_donationIsNotAnExit() public {
        _join(alice, 100e6);
        usd.mint(bob, 5e6);
        vm.prank(bob);
        usd.transfer(address(t), 5e6);
        uint256 cash = _leave(alice, shares.balanceOf(alice));
        assertEq(cash, 98e6, "a leaver is paid the pot, not the donation");
        assertEq(t.unaccounted(), 5e6);
    }

    // ---- instant round trips

    function test_instantJoinThenLeaveGivesNinetyEightPerHundredAtAnySize() public {
        _join(alice, 100_000e6);
        uint256 holder = shares.balanceOf(alice);
        uint256 holderValueBefore = PotMath.cash(holder, t.pot(), t.paidIn(), shares.totalSupply(), team.totalSupply());
        uint256[5] memory sizes = [uint256(1e6), 100e6, 10_000e6, 100_000e6, 900_000e6];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 n = _join(bob, sizes[i]);
            uint256 got = _leave(bob, n);
            uint256 expected = sizes[i] * 98 / 100;
            // within 0.01 of every 100 paid (the quote offset is worth about 100 Shares)
            assertApproxEqAbs(got, expected, sizes[i] / 10_000 + 2, "98.00 per 100");
            assertLe(got, expected + sizes[i] / 10_000 + 2);
        }
        uint256 holderValueAfter = PotMath.cash(holder, t.pot(), t.paidIn(), shares.totalSupply(), team.totalSupply());
        assertApproxEqAbs(holderValueAfter, holderValueBefore, 150e6 / 1000, "earlier holders are not moved");
    }

    function test_whaleRoundTripCostsOnlyTheFee() public {
        _join(alice, 100_000e6);
        uint256 n = _join(bob, 900_000e6);
        uint256 got = _leave(bob, n);
        assertApproxEqAbs(got, 882_000e6, 100e6);
        assertLe(got, 882_000e6 + 100e6);
        assertEq(t.feesOwed(), 2_000e6 + 18_000e6);
    }

    // ---- mediant, within the offset bound

    function testFuzz_aJoinMovesHoldersByAtMostTheOffsetBound(uint256 firstJoin, uint256 spent, uint256 amount) public {
        firstJoin = bound(firstJoin, 10e6, 5_000_000e6);
        amount = bound(amount, 1e6, 5_000_000e6);
        _join(alice, firstJoin);
        uint256 b = shares.totalSupply();
        uint256 potNow = t.pot();
        spent = bound(spent, potNow / 3, potNow + potNow / 2); // spent down, at par, or above paid-in
        _force(spent, t.paidIn(), 0, 0, 0);
        uint256 g = team.totalSupply();
        uint256 before = PotMath.cash(b, t.pot(), t.paidIn(), b, g);
        _join(bob, amount);
        uint256 afterVal = PotMath.cash(b, t.pot(), t.paidIn(), shares.totalSupply(), g);
        // 100 virtual Shares at the holders' value, less the virtual dollar; plus rounding
        uint256 virtualShares = PotMath.OFFSET_SHARES * before / b;
        uint256 bound_ = virtualShares > PotMath.OFFSET_USD ? virtualShares - PotMath.OFFSET_USD : 0;
        if (afterVal < before) assertLe(before - afterVal, bound_ + 20, "loss within the offset bound");
    }

    // ---- events

    function test_joinedEventCarriesTheResultingState() public {
        usd.mint(alice, 100e6);
        vm.startPrank(alice);
        usd.approve(address(t), 100e6);
        vm.expectEmit(true, true, false, true, address(t));
        emit Treasury.Joined(alice, bob, 100e6, 2e6, 9_800e18, 98e6, 98e6, 98e6, 9_800e18);
        t.join(100e6, 0, bob);
        vm.stopPrank();
    }

    // ---- pay-and-call

    function _playProject() internal returns (TreasuryHarness tr, ShareToken sh, PlayDollar pd) {
        pd = new PlayDollar(address(this));
        (tr, sh,,) = _launch(IERC20(address(pd)), POOL, 1000, 200, UNIT);
    }

    function test_payAndCallJoinIsOneStepAndEqualsTheApprovePath() public {
        (TreasuryHarness tr, ShareToken sh, PlayDollar pd) = _playProject();
        pd.mint(alice, 100e6);
        vm.prank(alice);
        pd.transferAndCall(address(tr), 100e6, abi.encode(uint256(9_800e18), address(0)));
        // the same payment through approve and join, in the ordinary project
        uint256 viaApprove = _join(bob, 100e6);
        assertEq(sh.balanceOf(alice), viaApprove);
        assertEq(tr.pot(), t.pot());
        assertEq(tr.paidIn(), t.paidIn());
        assertEq(tr.feesOwed(), t.feesOwed());
        assertEq(pd.balanceOf(address(tr)), 100e6);
        assertEq(tr.unaccounted(), 0);
    }

    function test_payAndCallNamesARecipientAndHonoursMinShares() public {
        (TreasuryHarness tr, ShareToken sh, PlayDollar pd) = _playProject();
        pd.mint(alice, 200e6);
        vm.startPrank(alice);
        pd.transferAndCall(address(tr), 100e6, abi.encode(uint256(0), bob));
        assertEq(sh.balanceOf(bob), 9_800e18);
        vm.expectRevert(); // TooFewShares bubbles through the token
        pd.transferAndCall(address(tr), 100e6, abi.encode(uint256(9_800e18 + 1), address(0)));
        vm.stopPrank();
    }

    function test_payAndCallOnlyFromTheProjectsDollar() public {
        (TreasuryHarness tr,, PlayDollar pd) = _playProject();
        pd.mint(address(tr), 100e6); // dollars sit unaccounted
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        tr.onTransferReceived(stranger, stranger, 100e6, abi.encode(uint256(0), address(0)));
        // another token cannot call it either
        PlayDollar other = new PlayDollar(address(this));
        other.mint(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(); // the other token's receiver check: not the project's dollar
        other.transferAndCall(address(tr), 100e6, abi.encode(uint256(0), address(0)));
    }

    function test_payAndCallOnlyForTheSendersOwnMoney() public {
        (TreasuryHarness tr, ShareToken sh, PlayDollar pd) = _playProject();
        pd.mint(alice, 100e6);
        vm.prank(alice);
        pd.approve(bob, 100e6);
        // bob moves alice's approved dollars with transferFromAndCall: operator (bob) is not the payer (alice)
        vm.prank(bob);
        vm.expectRevert();
        pd.transferFromAndCall(alice, address(tr), 100e6, abi.encode(uint256(0), bob));
        assertEq(sh.totalSupply(), 0);
        assertEq(pd.balanceOf(alice), 100e6);
    }

    function test_payAndCallNeedsExactlyTheEncodedData() public {
        (TreasuryHarness tr,, PlayDollar pd) = _playProject();
        pd.mint(alice, 100e6);
        vm.startPrank(alice);
        vm.expectRevert();
        pd.transferAndCall(address(tr), 100e6, "");
        vm.expectRevert();
        pd.transferAndCall(address(tr), 100e6, hex"00");
        vm.stopPrank();
    }

    function test_payAndCallRefusesWhenTheDoorIsShut() public {
        (TreasuryHarness tr,, PlayDollar pd) = _playProject();
        vm.prank(founder);
        tr.setDoor(false);
        pd.mint(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert();
        pd.transferAndCall(address(tr), 100e6, abi.encode(uint256(0), address(0)));
    }

    function test_payAndCallCannotClaimADonationThatIsNotItsValue() public {
        (TreasuryHarness tr,, PlayDollar pd) = _playProject();
        // a token that lies about `value` (here: a direct call as the token) with no dollars behind it is refused
        vm.prank(address(pd));
        vm.expectRevert(Treasury.TokenMisbehaved.selector);
        tr.onTransferReceived(alice, alice, 100e6, abi.encode(uint256(0), address(0)));
    }
}
