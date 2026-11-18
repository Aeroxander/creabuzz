// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Platform} from "./helpers/Platform.sol";
import {BASE_START_Q96, startQ96} from "./helpers/Prices.sol";
import {Launcher} from "../src/Launcher.sol";
import {Finisher} from "../src/Finisher.sol";
import {Treasury} from "../src/Treasury.sol";
import {SaleParams} from "../src/Pinned.sol";

/// @notice Founder-set prices, the auction (`docs/next-version/FOUNDER-PRICE.md`): the runner names the starting price, from
/// `salePrices` (0.0004 dollars a Share) to `MAX_START_Q96` (0.05); the minimum is all 250M Shares at that start, so a default
/// start keeps today's 100,000 exactly and Creaton's 0.006 (6,000,000 for the whole project) needs 1,500,000. On the real
/// Uniswap stack (local twin). Measured: the minimum, a sale that fills, one dollar short, self-bid-then-sell and a retry at 2.4M.
abstract contract FounderPriceAuctionBase is Platform {
    /// @dev 0.006 dollars a Share: 6,000,000 dollars for the whole project.
    uint256 internal constant SIX = 6000;

    function setUp() public virtual {
        _setUpPlatform(false); // the local twin of the real stack
    }

    /// @dev Open at `start` and return the sale with its `SaleOpened.minimum`.
    function _openWithMinimum(Proj memory p, uint256 start) internal returns (Sale memory s, uint256 minimum) {
        vm.recordLogs();
        s = _openAt(p, start);
        Vm.Log memory l = _one(vm.getRecordedLogs(), address(launcher), Launcher.SaleOpened.selector);
        uint256 floorQ96;
        uint256 tickQ96;
        (, minimum,,, floorQ96, tickQ96) = abi.decode(l.data, (address, uint256, uint64, uint64, uint256, uint256));
        assertEq(floorQ96, s.floorQ96, "the event's floor is the auction's");
        assertEq(tickQ96, s.tickQ96, "the event's tick is the auction's");
    }
}

/// @notice The range, today's sale at the base start, Creaton's 0.006 start (minimum, one dollar short, a sale that fills, the
/// bid cap) and a retry at 0.0024.
contract FounderPriceAuctionLocalTest is FounderPriceAuctionBase {
    // ================================================ the range =======================================================

    function test_openAuction_aStartBelowTheBaseOrAboveTheCeilingIsRefused() public {
        Proj memory p = _launch(founder, keccak256("range"));
        bytes memory bad = abi.encodeWithSelector(Launcher.BadStart.selector);
        _openRefusedAt(p, BASE_START_Q96 - 1, bad);
        _openRefusedAt(p, BASE_START_Q96 / 2, bad);
        _openRefusedAt(p, launcher.MAX_START_Q96() + 1, bad);
        assertEq(launcher.MAX_START_Q96(), startQ96(50_000), "0.05 dollars a Share");
        (Sale memory s, uint256 minimum) = _openWithMinimum(p, launcher.MAX_START_Q96());
        assertGe(s.floorQ96, launcher.MAX_START_Q96(), "the ceiling itself opens");
        assertEq(minimum, s.floorQ96 * SaleParams.SALE_SHARES >> 96);
        assertApproxEqRel(minimum, 12_500_000 * DOLLAR, 1e12, "all 250M at 0.05: 12,500,000");
    }

    /// @dev A project that does not choose a price gets today's sale exactly.
    function test_openAuction_atTheBaseStart_todaysFloorTickAndMinimumExactly() public {
        Proj memory p = _launch(founder, keccak256("base"));
        (Sale memory s, uint256 minimum) = _openWithMinimum(p, BASE_START_Q96);
        (uint256 floorQ96, uint256 tickQ96) = launcher.salePrices();
        assertEq(BASE_START_Q96, floorQ96, "the tests' base start is salePrices()");
        assertEq(s.floorQ96, floorQ96);
        assertEq(s.tickQ96, tickQ96);
        assertEq(minimum, 100_000 * DOLLAR, "100,000.000000 exactly");
        assertEq(minimum, launcher.AUCTION_MINIMUM());
    }

    // ================================================ Creaton at 0.006 ================================================

    /// @dev Start 0.006: the minimum is 1,500,000; demand one dollar short fails and refunds; demand at the minimum sells every
    /// Share at the start and opens a pool of 22 of each 100 with about 55M Shares.
    function test_start0006_minimumIs1500000_oneDollarShortFails_theMinimumSellsEveryShare() public {
        uint256 snap = vm.snapshotState();
        Proj memory p = _launch(founder, keccak256("short"));
        (Sale memory s, uint256 minimum) = _openWithMinimum(p, startQ96(SIX));
        assertEq(minimum, 1_500_000 * DOLLAR, "all 250M at 0.006");
        assertEq(s.floorQ96, (startQ96(SIX) + 99) / 100 * 100, "the start on its grid");
        _flat(s, minimum - DOLLAR);
        _toEnd(s);
        assertFalse(s.auction.isGraduated(), "one dollar short: the sale fails");
        emit log_named_decimal_uint("start 0.006: one dollar short raised", s.auction.currencyRaised(), 6);

        vm.revertToState(snap);
        p = _launch(founder, keccak256("fills"));
        (s,) = _openWithMinimum(p, startQ96(SIX));
        _flat(s, 1_500_000 * DOLLAR);
        _toEnd(s);
        assertTrue(s.auction.isGraduated());
        assertEq(s.auction.clearingPrice(), s.floorQ96, "the price stays at the start");
        uint256 sold = s.auction.totalCleared();
        assertApproxEqRel(sold, SaleParams.SALE_SHARES, 0.01e18, "every auction Share sold");
        uint256 raised = s.auction.currencyRaised();
        assertGe(raised, 1_500_000 * DOLLAR - 10);
        _finish(p, s);
        assertEq(usd.balanceOf(platform), raised * 3 / 100, "3%");
        assertApproxEqAbs(usd.balanceOf(poolManager), raised * 22 / 100, 50_000, "22% in the pool");
        assertApproxEqAbs(p.treasury.spendable(), raised * 15 / 100, 50_000);
        assertApproxEqAbs(p.treasury.melting(), raised * 60 / 100, 50_000);
        uint256 inPool = p.shares.balanceOf(poolManager);
        assertApproxEqRel(inPool, 55_000_000 * SHARE, 0.01e18, "the pool's Shares match its dollars at the start");
        assertApproxEqAbs(
            p.shares.balanceOf(address(p.treasury)),
            280_000_000 * SHARE + (SaleParams.SALE_SHARES - sold) + (SaleParams.POOL_SHARES - inPool),
            10,
            "unsold dust and the unused pool reserve are plain reserve (after the 20M stake left it)"
        );
        emit log_named_decimal_uint("start 0.006: minimum (dollars)", minimum, 6);
        emit log_named_decimal_uint("start 0.006: raised", raised, 6);
        emit log_named_decimal_uint("start 0.006: Shares sold", sold, 18);
        emit log_named_decimal_uint("start 0.006: pool dollars", usd.balanceOf(poolManager), 6);
        emit log_named_decimal_uint("start 0.006: pool Shares", inPool, 18);
        emit log_named_decimal_uint("start 0.006: spendable at once", p.treasury.spendable(), 6);
        emit log_named_decimal_uint("start 0.006: floor (melting over a year)", p.treasury.melting(), 6);
    }

    /// @dev The bid cap follows the chosen start: 4 times 0.006 is accepted, one tick more is refused.
    function test_start0006_aBidAboveFourTimesTheStartIsRefused() public {
        Proj memory p = _launch(founder, keccak256("cap"));
        (Sale memory s,) = _openWithMinimum(p, startQ96(SIX));
        vm.roll(s.startBlock);
        _fund(alice, 100 * DOLLAR, s);
        vm.startPrank(alice);
        // refused by the bid rules, with this sale's own limit (4 times its 0.006 floor) in the error
        // (MinBid and the auction's library are on another compiler version, so their selectors are spelled out here)
        bytes memory reason = abi.encodeWithSelector(
            bytes4(keccak256("TopPriceTooHigh(uint256,uint256)")), _price(s, 301), 4 * s.floorQ96
        );
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("ValidationHookCallFailed(bytes)")), reason));
        s.auction.submitBid(_price(s, 301), uint128(10 * DOLLAR), alice, s.floorQ96, "");
        s.auction.submitBid(_price(s, 300), uint128(10 * DOLLAR), alice, s.floorQ96, "");
        vm.stopPrank();
        assertEq(_price(s, 300), 4 * s.floorQ96);
        assertGt(s.floorQ96, BASE_START_Q96 * 14, "the cap is on this start, not today's");
    }

    /// @dev A failed auction at 0.006 is no trap: 24 hours after it ended the runner opens again at 0.0024 (2,400,000 for the
    /// whole project, minimum 600,000), and the same 1,000,000 of demand that failed at 0.006 sells everything.
    function test_failedAt0006_retryAt00024Opens_andSells() public {
        Proj memory p = _launch(founder, keccak256("retry"));
        (Sale memory s,) = _openWithMinimum(p, startQ96(SIX));
        uint256[5] memory ids = _flat(s, 1_000_000 * DOLLAR);
        _toEnd(s);
        assertFalse(s.auction.isGraduated(), "1,000,000 is under the 1,500,000 minimum");
        vm.roll(s.endBlock + 1);
        vm.startPrank(stranger);
        p.finisher.openPool();
        vm.expectRevert(Finisher.SaleDidNotGraduate.selector);
        p.finisher.settle();
        p.finisher.sweep();
        vm.stopPrank();
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Failed));
        for (uint256 i; i < 5; ++i) {
            (uint256 refund,) = _collectBid(s, ids[i]);
            assertEq(refund, 200_000 * DOLLAR, "refunded in full");
        }
        vm.roll(p.finisher.retryBlock());
        (Sale memory s2, uint256 minimum) = _openWithMinimum(p, startQ96(2400));
        assertEq(minimum, 600_000 * DOLLAR, "all 250M at 0.0024");
        _flat(s2, 1_000_000 * DOLLAR);
        _toEnd(s2);
        assertTrue(s2.auction.isGraduated());
        _finish(p, s2);
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Done));
        assertTrue(p.treasury.saleClosed());
        uint256 sold = s2.auction.totalCleared();
        assertApproxEqRel(sold, SaleParams.SALE_SHARES, 0.01e18, "every Share sold");
        emit log_named_decimal_uint("retry at 0.0024: raised", s2.auction.currencyRaised(), 6);
        emit log_named_uint(
            "retry at 0.0024: end price, hundredths of the start", s2.auction.clearingPrice() * 100 / s2.floorQ96
        );
        emit log_named_decimal_uint("retry at 0.0024: pool dollars", usd.balanceOf(poolManager), 6);
        emit log_named_decimal_uint("retry at 0.0024: pool Shares", p.shares.balanceOf(poolManager), 18);
    }
}

/// @notice The self-bid table at Creaton's 0.006 start (in its own contract to keep each test contract's code under the limit).
contract FounderPriceSelfBidLocalTest is FounderPriceAuctionBase {
    /// @dev `test_selfBidThenSellIntoThePool_measured` at a 0.006 start, every amount 15 times larger: a founder's second
    /// account bids 750,000 / 1,500,000 / 4,500,000 next to 1,500,000 of honest demand and sells what it bought into the pool.
    function test_start0006_selfBidThenSellIntoThePool_measured() public {
        uint256[3] memory founderBids = [uint256(750_000 * DOLLAR), 1_500_000 * DOLLAR, 4_500_000 * DOLLAR];
        uint256 snap = vm.snapshotState();
        Proj memory p0 = _launch(founder, keccak256("honest only"));
        (Sale memory s0,) = _openWithMinimum(p0, startQ96(SIX));
        vm.roll(s0.startBlock);
        uint256 h0 = _bid(s0, alice, 1_500_000 * DOLLAR, 300);
        _toEnd(s0);
        _finish(p0, s0);
        _collectBid(s0, h0);
        uint256 project0 = p0.treasury.spendable() + p0.treasury.melting();
        uint256 spendable0 = p0.treasury.spendable();
        for (uint256 z; z < 3; ++z) {
            vm.revertToState(snap);
            snap = vm.snapshotState();
            Proj memory p = _launch(founder, keccak256(abi.encode("self", z)));
            (Sale memory s,) = _openWithMinimum(p, startQ96(SIX));
            vm.roll(s.startBlock);
            uint256 honest = _bid(s, alice, 1_500_000 * DOLLAR, 300);
            address second = makeAddr("founder's second account");
            uint256 fid = _bid(s, second, founderBids[z], 300);
            _toEnd(s);
            _finish(p, s);
            _collectBid(s, honest);
            (uint256 refund, uint256 bought) = _collectBid(s, fid);
            uint256 spent = founderBids[z] - refund;
            uint256 project = p.treasury.spendable() + p.treasury.melting();
            uint256 atOnce = p.treasury.spendable() - spendable0;
            (, uint256 fromPool) = _swap(_key(p), address(p.shares), second, false, bought);
            uint256 backPer100 = fromPool * 10_000 / spent;
            uint256 projectPer100 = (project - project0) * 10_000 / spent;
            uint256 atOncePer100 = atOnce * 10_000 / spent;
            int256 lossNowPer100 = 10_000 - int256(backPer100) - int256(atOncePer100);
            int256 lossPer100 = 10_000 - int256(backPer100) - int256(projectPer100);
            emit log_string(string.concat(
                    "start 0.006: self-bid ",
                    vm.toString(founderBids[z] / DOLLAR),
                    " next to 1,500,000 honest: price x",
                    vm.toString(s.auction.clearingPrice() * 100 / s.floorQ96),
                    "/100; per 100 spent: ",
                    vm.toString(backPer100),
                    "/100 back from the pool, ",
                    vm.toString(projectPer100),
                    "/100 more for the project (",
                    vm.toString(atOncePer100),
                    " of it spendable at once); loss at once ",
                    vm.toString(uint256(lossNowPer100)),
                    "/100; if the whole floor melts to the runner: ",
                    lossPer100 < 0 ? "GAIN " : "loss ",
                    vm.toString(uint256(lossPer100 < 0 ? -lossPer100 : lossPer100)),
                    "/100"
                ));
            assertGt(lossNowPer100, 3000, "at once, more than 30 of each 100 is gone");
            assertEq(projectPer100 * 100 / 7500, 100, "75 of each 100 spent reached the project (15 + 60)");
        }
    }
}

/// @notice Project zero on the real stack (local twin): the admin names its key, it launches with no stake, and a full sale
/// at today's start and the Finisher's three steps grant nothing. The same sale run for an ordinary project, from the same
/// state, gives the 20M stake; every other figure is the same.
contract FounderPriceZeroStakeLocalTest is FounderPriceAuctionBase {
    struct After {
        uint256 reserveBalance; // the Treasury's Shares
        uint256 stakeGranted; // the stake address's grant in the Vester
        uint256 counting; // countingSupply()
        uint256 vesterUnreleased;
        uint256 spendable;
        uint256 melting;
        uint256 stakeEvents;
    }

    function _run(bool projectZero) internal returns (After memory a) {
        bytes32 id = keccak256("creaton");
        if (projectZero) {
            bytes32 key0 = launcher.keyOf(founder, id); // read first: a prank applies to the next call
            vm.prank(admin);
            launcher.nameProjectZero(key0);
        }
        Proj memory p = _launch(founder, id);
        assertEq(p.treasury.stakeAmount(), projectZero ? 0 : 20_000_000 * SHARE);
        Sale memory s = _open(p);
        _flat(s, 100_000 * DOLLAR);
        _toEnd(s);
        assertTrue(s.auction.isGraduated());
        vm.recordLogs();
        _finish(p, s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == Treasury.StakeGranted.selector) ++a.stakeEvents;
        }
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Done));
        (a.stakeGranted,) = p.vester.grants(stakeHolder);
        a.reserveBalance = p.shares.balanceOf(address(p.treasury));
        a.counting = p.treasury.countingSupply();
        a.vesterUnreleased = p.vester.unreleased();
        a.spendable = p.treasury.spendable();
        a.melting = p.treasury.melting();
        assertEq(
            a.counting,
            p.shares.totalSupply() - a.reserveBalance - p.shares.balanceOf(address(p.rounds))
                - p.shares.balanceOf(address(p.finisher)) - a.vesterUnreleased,
            "countingSupply is the formula"
        );
    }

    function test_projectZero_fullSaleAndFinish_grantsNoStake_reserveKeepsThe20M() public {
        uint256 snap = vm.snapshotState();
        After memory ordinary = _run(false);
        vm.revertToState(snap);
        After memory zero = _run(true);
        assertEq(ordinary.stakeEvents, 1);
        assertEq(ordinary.stakeGranted, 20_000_000 * SHARE);
        assertEq(zero.stakeEvents, 0, "no StakeGranted");
        assertEq(zero.stakeGranted, 0);
        // project zero's founder slice (200M, no earlier raise named here) is the Treasury's team budget, not a Vester grant
        assertEq(
            zero.reserveBalance,
            ordinary.reserveBalance + 20_000_000 * SHARE + 200_000_000 * SHARE,
            "the reserve keeps the 20M; the team budget is held here too"
        );
        assertEq(
            zero.vesterUnreleased + 20_000_000 * SHARE + 200_000_000 * SHARE,
            ordinary.vesterUnreleased,
            "nothing held for the stake or the founder"
        );
        assertEq(zero.counting, ordinary.counting, "the held stake never counted, so the count is the same");
        assertEq(zero.spendable, ordinary.spendable);
        assertEq(zero.melting, ordinary.melting);
        emit log_named_decimal_uint("project zero: Treasury Shares after the sale", zero.reserveBalance, 18);
        emit log_named_decimal_uint("project zero: counting supply after the sale", zero.counting, 18);
    }
}
