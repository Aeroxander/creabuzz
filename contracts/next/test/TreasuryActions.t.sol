// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./helpers/Base.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {RollingCap} from "../src/RollingCap.sol";

/// @notice The Treasury's money and Shares going out, one function at a time: spend, agents, Give Shares, the reserve, the
/// exit and the platform's fees. (The first half is `Treasury.t.sol`; the worked example is the same.)
contract TreasuryActionsTest is Base {
    // ----------------------------------------------------------------------------------------------- spend

    function test_spend_founderSendsAnythingUpToSpendable() public {
        _sale(7500 * DOLLAR);
        vm.prank(founder);
        t.spend(carol, 1000 * DOLLAR);
        assertEq(usd.balanceOf(carol), 1000 * DOLLAR);
        assertEq(t.spendable(), 500 * DOLLAR);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, 500 * DOLLAR + 1, 500 * DOLLAR));
        t.spend(carol, 500 * DOLLAR + 1);
        vm.prank(founder);
        t.spend(carol, 500 * DOLLAR);
        assertEq(t.spendable(), 0);
        assertEq(t.melting(), M, "the floor was not touched");
    }

    function test_spend_includesWhatTheDailyReleaseOwesWithNoBotRunning() public {
        _sale(7500 * DOLLAR);
        vm.warp(_now() + 10 days);
        uint256 owed = M * 10 days / 365 days;
        vm.prank(founder);
        t.spend(carol, S + owed);
        assertEq(usd.balanceOf(carol), S + owed);
    }

    function test_spend_refusals() public {
        _sale(7500 * DOLLAR);
        vm.prank(alice);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.spend(alice, 1);
        vm.startPrank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.spend(address(0), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.spend(carol, 0);
        vm.stopPrank();
    }

    function test_spend_anAgentIsHeldToItsDailyDollarCap() public {
        _sale(7500 * DOLLAR);
        vm.prank(founder);
        t.authoriseAgent(agent); // the default: 25 dollars a day
        vm.startPrank(agent);
        t.spend(carol, 10 * DOLLAR);
        t.spend(carol, 15 * DOLLAR);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.CapExceeded.selector, 25 * DOLLAR, 1, 25 * DOLLAR));
        t.spend(carol, 1);
        assertEq(t.agentUsdUsed(agent), 25 * DOLLAR);
        vm.warp(_now() + 28 hours - 1);
        vm.expectRevert();
        t.spend(carol, 1); // a used amount counts for 24 to 28 hours
        vm.warp(_now() + 1);
        t.spend(carol, 25 * DOLLAR);
        vm.stopPrank();
        assertEq(usd.balanceOf(carol), 50 * DOLLAR);
    }

    function test_spend_anAgentWhoIsNotSwitchedOnCannotSpend() public {
        _sale(7500 * DOLLAR);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.spend(carol, 1);
    }

    // ---------------------------------------------------------------------------------------------- agents

    function test_agents_onlyTheFounderSetsThem_andTheLimitsAreTheRunnersChoice() public {
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.setAgent(agent, type(uint128).max, type(uint128).max); // an agent cannot raise its own limit
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.authoriseAgent(agent);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.revokeAgent(agent);
        vm.startPrank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.setAgent(address(0), 1, 1);
        t.setAgent(agent, 7 * uint128(DOLLAR), 5 * uint128(SHARE));
        (bool active, uint128 usdCap, uint128 shareCap) = t.agents(agent);
        assertTrue(active);
        assertEq(usdCap, 7 * DOLLAR);
        assertEq(shareCap, 5 * SHARE);
        t.revokeAgent(agent);
        (active,,) = t.agents(agent);
        assertFalse(active);
        vm.stopPrank();
    }

    function test_agents_switchingOneOffAndOnDoesNotResetWhatItUsed() public {
        _sale(7500 * DOLLAR);
        vm.prank(founder);
        t.authoriseAgent(agent);
        vm.prank(agent);
        t.spend(carol, 25 * DOLLAR);
        vm.startPrank(founder);
        t.revokeAgent(agent);
        t.authoriseAgent(agent);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert();
        t.spend(carol, 1);
    }

    // ----------------------------------------------------------------------------------------- Give Shares

    function test_give_beforeThePoolGoesToTheVesterAndFollowsItsSchedule() public {
        vm.prank(founder);
        t.giveShares(alice, 1000 * SHARE);
        assertEq(t.workPot(), 200_000_000 * SHARE - 1000 * SHARE);
        assertEq(shares.balanceOf(alice), 0, "not in her hands yet");
        assertEq(shares.balanceOf(address(v)), 200_001_000 * SHARE);
        (uint256 total,) = v.grants(alice);
        assertEq(total, 1000 * SHARE);
        _openPool();
        vm.warp(_now() + 365 days / 2);
        v.claim(alice);
        assertEq(shares.balanceOf(alice), 500 * SHARE);
    }

    function test_give_afterThePoolGoesStraightToThePersonUpToOnePercentAMonth() public {
        _world();
        vm.startPrank(founder);
        uint256 gifted = _now();
        t.giveShares(carol, 6_000_000 * SHARE);
        assertEq(shares.balanceOf(carol), 6_000_000 * SHARE);
        t.giveShares(carol, 4_000_000 * SHARE); // exactly 1% of 1,000,000,000
        assertEq(t.giftsUsed(), 10_000_000 * SHARE);
        vm.expectRevert(
            abi.encodeWithSelector(RollingCap.CapExceeded.selector, 10_000_000 * SHARE, 1, 10_000_000 * SHARE)
        );
        t.giveShares(alice, 1);
        vm.warp(gifted + 30 days - 1);
        vm.expectRevert();
        t.giveShares(alice, 1); // a gift counts for at least 30 days...
        vm.warp(gifted + 33 days);
        t.giveShares(alice, 10_000_000 * SHARE); // ...and at most 33
        vm.stopPrank();
    }

    function test_give_refusals() public {
        vm.prank(alice);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.giveShares(alice, 1);
        vm.startPrank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.giveShares(address(0), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.giveShares(address(t), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.giveShares(address(v), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.giveShares(address(shares), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.giveShares(alice, 0);
        vm.expectRevert(
            abi.encodeWithSelector(Treasury.WorkPotShort.selector, 200_000_001 * SHARE, 200_000_000 * SHARE)
        );
        t.giveShares(alice, 200_000_001 * SHARE);
        vm.stopPrank();
    }

    function test_give_thePotIsAllThatCanBeGiven_theReserveIsNotTouched() public {
        vm.startPrank(founder);
        t.giveShares(alice, 200_000_000 * SHARE); // before the pool there is no monthly cap, only the pot
        vm.expectRevert(abi.encodeWithSelector(Treasury.WorkPotShort.selector, 1, 0));
        t.giveShares(alice, 1);
        vm.stopPrank();
        assertEq(t.reserve(), 100_000_000 * SHARE);
    }

    function test_give_anAgentIsHeldToItsDailyShareCapOnBothRoads() public {
        vm.prank(founder);
        t.authoriseAgent(agent); // 0.1% of the supply a day: 1,000,000 Shares
        vm.startPrank(agent);
        t.giveShares(alice, 600_000 * SHARE);
        t.giveShares(bob, 400_000 * SHARE);
        vm.expectRevert(
            abi.encodeWithSelector(RollingCap.CapExceeded.selector, 1_000_000 * SHARE, 1, 1_000_000 * SHARE)
        );
        t.giveShares(carol, 1);
        vm.stopPrank();
        assertEq(t.agentSharesUsed(agent), 1_000_000 * SHARE);
        _openPool(); // after the pool opens the same daily cap holds on the direct road
        vm.warp(_now() + 28 hours);
        vm.startPrank(agent);
        t.giveShares(alice, 1_000_000 * SHARE);
        vm.expectRevert();
        t.giveShares(alice, 1);
        vm.stopPrank();
    }

    // --------------------------------------------------------------------------------------------- reserve

    function test_reserve_leavesOnlyThroughTheSalePath() public {
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.releaseReserve(alice, 1);
        vm.startPrank(salePath);
        vm.expectRevert(Treasury.BadInput.selector);
        t.releaseReserve(address(0), 1);
        vm.expectRevert(Treasury.BadInput.selector);
        t.releaseReserve(alice, 0);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, 100_000_001 * SHARE, 100_000_000 * SHARE));
        t.releaseReserve(alice, 100_000_001 * SHARE);
        t.releaseReserve(alice, 100_000_000 * SHARE);
        vm.stopPrank();
        assertEq(shares.balanceOf(alice), 100_000_000 * SHARE);
        assertEq(shares.balanceOf(address(t)), t.workPot(), "the work pot is still all there");
    }

    function test_reserve_countsSharesReturnedOrDonatedToTheTreasury() public {
        _buy(alice, 10 * SHARE);
        vm.prank(alice);
        shares.transfer(address(t), 4 * SHARE);
        assertEq(t.reserve(), 100_000_000 * SHARE + 4 * SHARE);
        assertEq(t.workPot(), 200_000_000 * SHARE);
    }

    // -------------------------------------------------------------------------------------------- hand back

    function test_handBack_workedExample() public {
        _world();
        assertEq(t.countingSupply(), 500_000_000 * SHARE);
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        // slice 6000 * 100M / 500M = 1200; fee 5% = 60 (4% = 48 stays, 1% = 12 owed to the platform)
        assertEq(paid, 1140 * DOLLAR);
        assertEq(usd.balanceOf(alice), 1140 * DOLLAR);
        assertEq(t.feesOwed(), 12 * DOLLAR);
        assertEq(t.melting(), M - 1152 * DOLLAR);
        assertEq(t.spendable(), S, "the spendable bucket is never reachable");
        assertEq(shares.balanceOf(alice), 0);
        assertEq(t.countingSupply(), 400_000_000 * SHARE);
        // the 48 that stayed lifted the floor per Share for bob: 4848 / 400M against 6000 / 500M before
        uint256 bobPaid = _handBack(bob, 400_000_000 * SHARE);
        assertEq(bobPaid, (4848 * DOLLAR * 95) / 100);
        assertEq(_buckets(), usd.balanceOf(address(t)));
    }

    function test_handBack_refusedBeforeSaleMoneyHasBeenSplit() public {
        _buy(alice, 10 * SHARE);
        _approveAll(alice);
        vm.prank(alice);
        vm.expectRevert(Treasury.NotSettled.selector);
        t.handBack(1 * SHARE);
        _arrive(7500 * DOLLAR); // money arrived but nobody has split it
        _openPool();
        vm.prank(alice);
        vm.expectRevert(Treasury.NotSettled.selector);
        t.handBack(1 * SHARE);
    }

    function test_handBack_refusals() public {
        _world();
        vm.prank(alice);
        vm.expectRevert(Treasury.BadInput.selector);
        t.handBack(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, 500_000_001 * SHARE, 500_000_000 * SHARE));
        t.handBack(500_000_001 * SHARE);
        vm.prank(alice);
        vm.expectRevert(ShareToken.InsufficientBalance.selector); // more than she holds
        t.handBack(100_000_001 * SHARE);
        vm.prank(carol);
        vm.expectRevert(ShareToken.InsufficientBalance.selector); // holds nothing
        t.handBack(1 * SHARE);
    }

    function test_handBack_needsTheHoldersOwnApproval() public {
        _world();
        vm.prank(alice);
        shares.approve(address(t), 0);
        vm.prank(alice);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        t.handBack(1_000_000 * SHARE);
    }

    function test_handBack_burnsTheShares() public {
        _world();
        uint256 supply = shares.totalSupply();
        _handBack(alice, 50_000_000 * SHARE);
        assertEq(shares.totalSupply(), supply - 50_000_000 * SHARE);
    }

    function test_handBack_vesterAndTreasurySharesNeverCount() public {
        _world();
        // 200M in the Vester, 300M in the Treasury, 500M with holders: the floor is shared among holders only
        assertEq(t.countingSupply(), shares.totalSupply() - shares.balanceOf(address(t)) - shares.balanceOf(address(v)));
        vm.prank(founder);
        t.giveShares(carol, 1_000_000 * SHARE); // the pool is open: straight to carol, who now counts
        assertEq(t.countingSupply(), 501_000_000 * SHARE);
        uint256 before = t.countingSupply();
        vm.warp(_now() + 365 days);
        v.claim(founder); // released Shares leave the Vester and now count
        assertEq(t.countingSupply(), before + 200_000_000 * SHARE);
    }

    function test_handBack_takesFromBothFloorsInProportion() public {
        _world();
        usd.mint(alice, 3000 * DOLLAR);
        vm.startPrank(alice);
        usd.approve(address(t), 3000 * DOLLAR);
        t.shareRevenue(3000 * DOLLAR); // permanent 3000, melting 6000
        vm.stopPrank();
        _handBack(bob, 250_000_000 * SHARE); // half of the counting Shares: slice 4500, paid 4275, platform 45
        assertEq(t.feesOwed(), 45 * DOLLAR);
        assertEq(usd.balanceOf(bob), 4275 * DOLLAR);
        // leaves = 4275 + 45 = 4320: 1/3 from permanent, 2/3 from melting
        assertEq(t.permanentFloor(), 3000 * DOLLAR - 1440 * DOLLAR);
        assertEq(t.melting(), M - 2880 * DOLLAR);
    }

    function test_handBack_includesTheDailyReleaseAlreadyOwed() public {
        _world();
        vm.warp(_now() + 14 days);
        uint256 gone = M * 14 days / 365 days; // moved to spendable by this very call
        uint256 floorLeft = M - gone;
        // the founder's 200M are released by the day, claimed or not, and released Shares count as held by people
        uint256 counting = 500_000_000 * SHARE + 200_000_000 * SHARE * 14 days / 365 days;
        uint256 slice = floorLeft * (100_000_000 * SHARE) / counting;
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertEq(paid, slice - (slice * 500 + 9999) / 10_000);
        assertEq(t.spendable(), S + gone);
    }

    /// @dev The review's blocker: the exit count used to subtract the Vester's whole balance, so a claim (anyone may press
    /// it, for anyone) changed the price of every exit. Released Shares count whether or not they were claimed.
    function test_countingSupply_countsReleasedSharesWhetherOrNotClaimed() public {
        _world();
        vm.warp(_now() + 180 days);
        uint256 released = 200_000_000 * SHARE * 180 days / 365 days;
        uint256 expected = 500_000_000 * SHARE + released; // buyers, plus the founder's released Shares
        assertEq(t.countingSupply(), expected, "released but unclaimed");
        assertGt(v.claimable(founder), 0);
        v.claim(founder); // a stranger presses claim
        assertEq(t.countingSupply(), expected, "released and claimed: the same number");
        assertEq(shares.balanceOf(founder), released);
    }

    /// @dev The review's second finding on the exit count: the Launcher's unsold Shares (and, in milestone 3, the auction's
    /// and the strategy's) are outside the Treasury but in nobody's hands. The exit therefore waits for the finish's last
    /// step, the sweep of unsold Shares to the Treasury. Here alice bought 100M and 400M are unsold.
    function test_handBack_waitsForTheSaleToCloseSoUnsoldSharesNeverCountAsHeld() public {
        _arrive(7500 * DOLLAR);
        _openPool();
        t.settle(7500 * DOLLAR); // step 2 of the finish is done: the money is split
        _buy(alice, 100_000_000 * SHARE);
        _approveAll(alice);
        assertEq(
            t.countingSupply(),
            500_000_000 * SHARE,
            "while 400M sit unsold they would count, and alice's slice is a fifth"
        );
        vm.prank(alice);
        vm.expectRevert(Treasury.SaleNotClosed.selector);
        t.handBack(100_000_000 * SHARE);
        // step 3: the unsold Shares are swept to the Treasury, and the finish is marked complete
        vm.prank(address(launcher));
        shares.transfer(address(t), 400_000_000 * SHARE);
        _closeSale();
        assertEq(t.countingSupply(), 100_000_000 * SHARE);
        assertEq(t.reserve(), 500_000_000 * SHARE, "the unsold Shares are plain reserve");
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertEq(
            paid, M - M * 500 / 10_000, "the whole floor, less the 5 percent fee: nothing was lost to unsold Shares"
        );
    }

    function test_handBack_aSliceTooSmallToPayIsRefusedRatherThanBurnedForNothing() public {
        _world();
        vm.prank(alice);
        shares.transfer(carol, 1);
        _approveAll(carol);
        vm.prank(carol);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.handBack(1); // 1 unit of 500M of a 6,000 dollar floor is under a millionth of a cent
        vm.prank(carol);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.handBack(1);
    }

    function test_sweepFees_anyoneMaySend_theMoneyGoesToThePlatform() public {
        _world();
        _handBack(alice, 100_000_000 * SHARE);
        vm.prank(carol);
        t.sweepFees();
        assertEq(usd.balanceOf(platform), 12 * DOLLAR);
        assertEq(t.feesOwed(), 0);
        t.sweepFees(); // nothing owed: no revert, no transfer
        assertEq(usd.balanceOf(platform), 12 * DOLLAR);
    }

    function test_sweepFees_aBlockedPlatformAddressDoesNotBlockExits() public {
        _world();
        // the token refuses the platform address (a frozen account): sweeping fails, exits still work
        vm.mockCallRevert(address(usd), abi.encodeWithSelector(usd.transfer.selector, platform), "frozen");
        _handBack(alice, 100_000_000 * SHARE);
        vm.expectRevert();
        t.sweepFees();
        assertEq(t.feesOwed(), 12 * DOLLAR);
        _handBack(bob, 100_000_000 * SHARE);
        assertEq(t.feesOwed(), 12 * DOLLAR + 12_120_000, "the second exit's 1% of 1,212 is owed too");
    }
}
