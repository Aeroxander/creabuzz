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

/// @notice The Treasury at birth and as sale money comes in: set-up, pool proof, settle, top-up, Share revenue, check-in and the
/// daily release (the rest is `TreasuryActions.t.sol`). The worked example used in many tests: sale money of
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
}
