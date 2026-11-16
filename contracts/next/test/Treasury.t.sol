// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {Base} from "./helpers/Base.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Vester} from "../src/Vester.sol";
import {IShares, IVester} from "../src/Interfaces.sol";
import {RollingCap} from "../src/RollingCap.sol";

/// @notice Every function and revert of the Treasury, one at a time. The worked example used in many tests: sale money of
/// 7,500 dollars reaches the Treasury (75 of each 100 of a 10,000 raise), is split 1,500 spendable : 6,000 melting floor,
/// and the holders are alice (100M Shares) and bob (400M Shares), so 500M Shares count.
contract TreasuryTest is Base {
    // ------------------------------------------------------------------------------------------------- birth

    function test_birth_valuesComeFromTheLauncher() public view {
        assertEq(address(t.quote()), address(usd));
        assertEq(address(t.shares()), address(shares));
        assertEq(address(t.vester()), address(v));
        assertEq(t.founder(), founder);
        assertEq(t.platform(), platform);
        assertEq(t.opener(), opener);
        assertEq(t.salePath(), salePath);
        assertEq(t.exitFeeBps(), 500);
        assertEq(t.platformFeeBps(), 100);
        assertEq(t.spendableParts(), 15);
        assertEq(t.floorParts(), 60);
        assertEq(t.defaultAgentUsd(), 25 * DOLLAR);
        assertEq(t.defaultAgentShares(), 1_000_000 * SHARE);
        assertEq(t.workPot(), 200_000_000 * SHARE);
        assertEq(t.reserve(), 100_000_000 * SHARE);
        assertEq(shares.balanceOf(address(t)), 300_000_000 * SHARE);
        assertFalse(t.poolOpen());
        assertFalse(t.settled());
    }

    function test_birth_aCloneCannotBeSetUpASecondTime() public {
        Treasury.Setup memory s = _setup();
        vm.expectRevert(Treasury.BadSetup.selector);
        t.initialize(s);
        vm.prank(founder);
        vm.expectRevert(Treasury.BadSetup.selector);
        t.initialize(s);
    }

    function test_birth_theImplementationIsLocked() public {
        Treasury impl = Treasury(launcher.treasuryImpl());
        vm.expectRevert(Treasury.BadSetup.selector);
        impl.initialize(_setup());
    }

    function test_birth_badSetupsAreRefused() public {
        Treasury fresh;
        Treasury.Setup memory s;
        for (uint256 i; i < 11; ++i) {
            fresh = Treasury(Clones.clone(launcher.treasuryImpl()));
            s = _setup();
            s.workPot = 0;
            if (i == 0) s.founder = address(0);
            if (i == 1) s.platform = address(0);
            if (i == 2) s.opener = address(0);
            if (i == 3) s.salePath = address(0);
            if (i == 4) s.quote = IERC20(address(0));
            if (i == 5) s.exitFeeBps = 10_000;
            if (i == 6) s.platformFeeBps = 501;
            if (i == 7) s.spendableParts = 0;
            if (i == 8) s.floorParts = 0;
            if (i == 9) s.workPot = 1; // the clone holds no Shares to back a work pot
            if (i == 10) s.vester = IVester(address(0));
            vm.expectRevert(Treasury.BadSetup.selector);
            fresh.initialize(s);
        }
    }

    function _setup() internal view returns (Treasury.Setup memory) {
        return Treasury.Setup({
            quote: IERC20(address(usd)),
            shares: IShares(address(shares)),
            vester: IVester(address(v)),
            founder: founder,
            platform: platform,
            opener: opener,
            salePath: salePath,
            exitFeeBps: 500,
            platformFeeBps: 100,
            spendableParts: 15,
            floorParts: 60,
            agentUsd: uint128(25 * DOLLAR),
            agentShares: uint128(1_000_000 * SHARE),
            workPot: 200_000_000 * SHARE
        });
    }

    // ------------------------------------------------------------------------------------------ pool is proven

    function test_pool_onlyTheOpenerMayProveItAndOnlyOnce() public {
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markPoolOpen();
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markPoolOpen(); // not even the founder
        _openPool();
        assertTrue(t.poolOpen());
        assertEq(v.start(), _now(), "the Vester's clock starts in the same call");
        vm.prank(opener);
        vm.expectRevert(Treasury.PoolAlreadyOpen.selector);
        t.markPoolOpen();
    }

    // ------------------------------------------------------------------------------------------------- settle

    function test_settle_refusedUntilAPoolIsProven() public {
        _arrive(7500 * DOLLAR);
        vm.expectRevert(Treasury.NoPool.selector);
        t.settle(7500 * DOLLAR);
        assertEq(_buckets(), 0);
        _openPool();
        t.settle(7500 * DOLLAR);
        assertEq(t.spendable(), S);
    }

    function test_settle_splitsFifteenToSixty() public {
        _sale(7500 * DOLLAR);
        assertEq(t.spendable(), S);
        assertEq(t.melting(), M);
        assertEq(t.permanentFloor(), 0);
        assertEq(usd.balanceOf(address(t)), 7500 * DOLLAR);
        assertEq(t.unaccounted(), 0);
        assertTrue(t.settled());
        assertEq(t.accruedUpTo(), _now());
        assertEq(t.lastCheckIn(), _now(), "the first settle opens the check-in window");
        assertEq(t.meltRemaining(), 365 days);
    }

    function test_settle_anyoneMayCall_butNeverMoreThanArrived() public {
        _arrive(100 * DOLLAR);
        _openPool();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotArrived.selector, 100 * DOLLAR + 1, 100 * DOLLAR));
        t.settle(100 * DOLLAR + 1);
        vm.prank(alice);
        t.settle(100 * DOLLAR);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotArrived.selector, 1, 0));
        t.settle(1); // already in a bucket: it cannot be split twice
        vm.expectRevert(Treasury.BadInput.selector);
        t.settle(0);
    }

    function test_settle_partialCallsAddUpAndRoundTowardsTheFloor() public {
        _arrive(1000);
        _openPool();
        t.settle(7); // 7 * 15 / 75 = 1.4: spendable gets 1, the floor gets the rest
        assertEq(t.spendable(), 1);
        assertEq(t.melting(), 6);
        t.settle(3); // 0.6 rounds down to 0
        assertEq(t.spendable(), 1);
        assertEq(t.melting(), 9);
        t.settle(990);
        assertEq(t.spendable() + t.melting(), 1000);
    }

    function test_settle_aSecondTrancheBlendsTheReleaseTimeByMoney() public {
        _sale(7500 * DOLLAR); // melting 6000 with 365 days left
        _runFor(100 days);
        t.release();
        uint256 old = t.melting();
        uint256 remainingOld = t.meltRemaining();
        assertApproxEqAbs(old, M - M * 100 days / 365 days, 20, "100 days of the 6,000 were released first");
        assertEq(remainingOld, 265 days);
        _arrive(7500 * DOLLAR);
        t.settle(7500 * DOLLAR);
        assertEq(t.melting(), old + M);
        assertEq(t.meltRemaining(), (old * remainingOld + M * 365 days) / (old + M));
        assertGt(t.meltRemaining(), remainingOld);
        assertLt(t.meltRemaining(), 365 days);
    }

    function test_settle_aDonationBeforeTheSaleIsSplitLikeAnyOtherMoneyAndNotLost() public {
        usd.mint(address(t), 5 * DOLLAR); // a stranger sends dollars by hand
        assertEq(t.unaccounted(), 5 * DOLLAR);
        assertEq(_buckets(), 0);
        _sale(7500 * DOLLAR);
        assertEq(t.unaccounted(), 5 * DOLLAR, "the donation stays out of the buckets until someone settles it");
        t.settle(5 * DOLLAR);
        assertEq(_buckets(), usd.balanceOf(address(t)));
    }

    // ---------------------------------------------------------------------------------------- topUp, revenue

    function test_topUp_goesToSpendableByTheMeasuredAmount() public {
        usd.mint(alice, 100 * DOLLAR);
        vm.startPrank(alice);
        usd.approve(address(t), 100 * DOLLAR);
        t.topUp(40 * DOLLAR);
        vm.stopPrank();
        assertEq(t.spendable(), 40 * DOLLAR);
        assertEq(usd.balanceOf(address(t)), 40 * DOLLAR);
        vm.prank(alice);
        vm.expectRevert(Treasury.BadInput.selector);
        t.topUp(0);
        vm.prank(bob);
        vm.expectRevert(); // no dollars, no allowance
        t.topUp(1);
    }

    function test_shareRevenue_goesToThePermanentFloorAndNeverMelts() public {
        _world();
        usd.mint(alice, 1000 * DOLLAR);
        vm.startPrank(alice);
        usd.approve(address(t), 1000 * DOLLAR);
        t.shareRevenue(1000 * DOLLAR);
        vm.stopPrank();
        assertEq(t.permanentFloor(), 1000 * DOLLAR);
        _runFor(366 days);
        t.release();
        assertEq(t.melting(), 0, "the melting floor is gone after a year of active time...");
        assertEq(t.permanentFloor(), 1000 * DOLLAR, "...the permanent floor is not");
    }

    function test_shareRevenue_creditsWhatArrivedWhenATokenKeepsAFee() public {
        usd.setFees(100, 0); // 1% of every transfer is kept by the token
        usd.mint(alice, 1000 * DOLLAR);
        vm.startPrank(alice);
        usd.approve(address(t), 1000 * DOLLAR);
        t.shareRevenue(1000 * DOLLAR);
        vm.stopPrank();
        assertEq(t.permanentFloor(), 990 * DOLLAR);
        assertEq(usd.balanceOf(address(t)), 990 * DOLLAR);
    }

    function test_shareRevenue_zeroIsRefused() public {
        vm.expectRevert(Treasury.BadInput.selector);
        t.shareRevenue(0);
    }

    // ----------------------------------------------------------------------------- check-in and the daily release

    function test_release_isEvenAndWorkedOutOnDemand() public {
        _sale(7500 * DOLLAR);
        vm.warp(_now() + 1 days);
        assertEq(t.pendingRelease(), M * 1 days / 365 days);
        assertEq(t.pendingRelease(), 16_438_356, "0.164 of each 100 a day: 16.438356 dollars of a 6,000 floor");
        assertEq(t.spendable(), S, "nothing moves until somebody asks");
        t.release();
        assertEq(t.spendable(), S + 16_438_356);
        assertEq(t.melting(), M - 16_438_356);
        assertEq(t.pendingRelease(), 0);
        vm.warp(_now() + 1 days);
        t.release();
        assertEq(t.spendable() + t.melting(), S + M, "release only moves money between buckets");
        assertApproxEqAbs(t.melting(), M - 2 * 16_438_356, 1, "a share of what is left, so the days stay even");
    }

    function test_release_callingOftenOrRarelyGivesTheSameWithinDust() public {
        _sale(7500 * DOLLAR);
        for (uint256 i; i < 10; ++i) {
            vm.warp(_now() + 1 days);
            t.release();
            vm.prank(founder);
            t.checkIn();
        }
        uint256 oftenMelting = t.melting();
        // a second project, worked out only at the end
        (address s2, address tr2, address ve2) = _launch(alice, keccak256("two"));
        Treasury t2 = Treasury(tr2);
        s2;
        ve2;
        usd.mint(tr2, 7500 * DOLLAR);
        vm.prank(opener);
        t2.markPoolOpen();
        t2.settle(7500 * DOLLAR);
        vm.warp(_now() + 10 days);
        t2.release();
        assertApproxEqAbs(oftenMelting, t2.melting(), 10);
    }

    function test_release_stopsAfterTheWindowAndIsNeverPaidBack() public {
        _sale(7500 * DOLLAR);
        uint256 t0 = _now();
        vm.warp(t0 + 20 days); // silent for 6 days of the 20
        t.release();
        uint256 first = M * 14 days / 365 days;
        assertEq(t.spendable(), S + first, "only the 14 days inside the window were paid");
        assertEq(t.meltRemaining(), 365 days - 14 days);
        vm.warp(t0 + 100 days);
        t.release();
        assertEq(t.spendable(), S + first, "nothing accrues with no check-in");
        vm.prank(founder);
        t.checkIn(); // resumes now; the 80 silent days are gone for good
        vm.warp(t0 + 105 days);
        t.release();
        assertEq(t.spendable(), S + first + (M - first) * 5 days / (365 days - 14 days));
    }

    function test_checkIn_onlyFounderOrAnAgent() public {
        _sale(7500 * DOLLAR);
        vm.prank(alice);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.checkIn();
        vm.prank(founder);
        t.setAgent(agent, 0, 0);
        vm.warp(_now() + 10 days);
        vm.prank(agent);
        t.checkIn();
        assertEq(t.lastCheckIn(), _now());
        vm.prank(founder);
        t.revokeAgent(agent);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.checkIn();
    }

    function test_checkIn_aStrangerSettlingDustDoesNotRenewTheWindow() public {
        _sale(7500 * DOLLAR);
        uint256 t0 = _now();
        vm.warp(t0 + 30 days);
        usd.mint(address(t), 1); // a stranger tries to revive the window with a settle of one unit
        t.settle(1);
        assertEq(t.lastCheckIn(), t0);
        assertEq(t.pendingRelease(), 0);
    }

    function test_endDate_everyDayOutsideAWindowPushesTheEndOneDayLater() public {
        _sale(7500 * DOLLAR);
        uint256 t0 = _now();
        vm.warp(t0 + 30 days); // 16 silent days after the first window
        vm.prank(founder);
        t.checkIn();
        for (uint256 i; i < 26; ++i) {
            vm.warp(_now() + 13 days);
            vm.prank(founder);
            t.checkIn();
        }
        assertGt(t.melting(), 0, "351 active days needed, 350 passed");
        assertEq(t.meltRemaining(), 13 days);
        vm.warp(_now() + 12 days);
        t.release();
        assertGt(t.melting(), 0);
        vm.warp(t0 + 365 days + 16 days);
        t.release();
        assertEq(t.melting(), 0, "365 active days + 16 silent days = 381 days after the sale");
        assertEq(t.spendable(), S + M);
    }

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
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertEq(paid, (floorLeft / 5) - ((floorLeft / 5) * 500 + 9999) / 10_000);
        assertEq(t.spendable(), S + gone);
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
