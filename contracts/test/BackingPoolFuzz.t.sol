// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture} from "./helpers/BackingPoolFixture.sol";

/// @notice Properties of the curve and of the escrow weights over random amounts and histories.
contract BackingPoolFuzzTest is BackingPoolFixture {
    function setUp() public override {
        super.setUp();
        _pastEarly();
    }

    /// @dev A pool with no fee and no project part: the bare curve.
    function _bareCurve() internal returns (BackingPool bare) {
        BackingPool.Params memory p = defaultTerms();
        p.feeBps = 0;
        p.projectBps = 0;
        p.earlyCap = 0;
        bare = new BackingPool(treasury, FOUNDER, IERC20(address(quote)), p);
        vm.prank(ALICE);
        quote.approve(address(bare), type(uint256).max);
        vm.prank(BOB);
        quote.approve(address(bare), type(uint256).max);
    }

    function testFuzz_buy_then_sell_never_returns_more_than_was_paid(uint256 prior, uint256 amount) public {
        prior = bound(prior, 0, 5_000_000e18);
        amount = bound(amount, 1e12, 5_000_000e18);
        if (prior >= 1e12) _buy(BOB, prior);
        uint256 units = _buy(ALICE, amount);
        uint256 out = _sell(ALICE, units);
        // With the default terms the project part and two fees stay behind.
        assertLe(out, amount * 70 / 100);
        _assertSolvent();
    }

    function testFuzz_the_bare_curve_round_trip_loses_only_rounding(uint256 prior, uint256 amount) public {
        BackingPool bare = _bareCurve();
        prior = bound(prior, 0, 5_000_000e18);
        amount = bound(amount, 1e12, 5_000_000e18);
        if (prior >= 1e12) {
            vm.prank(BOB);
            bare.buy(prior, 0, type(uint256).max);
        }
        vm.startPrank(ALICE);
        uint256 units = bare.buy(amount, 0, type(uint256).max);
        // One base unit of units is worth this much quote at the price just paid (rounded up).
        uint256 dust = (bare.virtualQuote() + bare.reserve()) / (bare.virtualUnits() - bare.totalSupply()) + 2;
        uint256 out = bare.sell(units, 0, type(uint256).max);
        vm.stopPrank();
        assertLe(out, amount, "no profit from a round trip");
        assertLe(amount - out, dust, "and no loss beyond rounding");
    }

    function testFuzz_selling_in_pieces_never_pays_more_than_selling_at_once(uint256 amount, uint256 cut) public {
        amount = bound(amount, 1e15, 5_000_000e18);
        _buy(BOB, 10_000e18);
        uint256 units = _buy(ALICE, amount);
        cut = bound(cut, 1, units - 1);
        (uint256 once,,,) = pool.quoteSell(ALICE, units);
        uint256 pieces = _sell(ALICE, cut) + _sell(ALICE, units - cut);
        // Fees leave the curve, so only rounding differs.
        assertLe(pieces, once);
        assertLe(once - pieces, 4);
    }

    function testFuzz_a_buy_raises_the_price_and_a_sale_lowers_it(uint256 amount) public {
        amount = bound(amount, 1e15, 5_000_000e18);
        uint256 p0 = pool.price();
        uint256 units = _buy(ALICE, amount);
        uint256 p1 = pool.price();
        assertGt(p1, p0);
        _sell(ALICE, units / 2 + 1);
        assertLt(pool.price(), p1);
        assertGe(pool.price(), p0);
    }

    function testFuzz_the_curve_constant_never_falls(uint256 a, uint256 b, uint256 sellPart) public {
        a = bound(a, 1e12, 5_000_000e18);
        b = bound(b, 1e12, 5_000_000e18);
        uint256 k0 = pool.virtualQuote() * pool.virtualUnits();
        uint256 units = _buy(ALICE, a);
        assertGe(_k(), k0);
        uint256 k1 = _k();
        _buy(BOB, b);
        assertGe(_k(), k1);
        k1 = _k();
        _sell(ALICE, bound(sellPart, 1, units));
        assertGe(_k(), k1);
    }

    function _k() internal view returns (uint256) {
        return (pool.virtualQuote() + pool.reserve()) * (pool.virtualUnits() - pool.totalSupply());
    }

    /// @dev The core fairness property of the escrow: whatever happened before, a newcomer's weight is worth
    /// the project money they just put in (never more), and nobody already holding is worth less for it.
    function testFuzz_a_newcomers_weight_is_worth_what_they_put_in(
        uint256 first,
        uint256 second,
        uint256 sold,
        uint256 late,
        bool release
    ) public {
        first = bound(first, 1e15, 2_000_000e18);
        second = bound(second, 1e15, 2_000_000e18);
        late = bound(late, 1e15, 2_000_000e18);
        uint256 bobUnits = _buy(BOB, first);
        _buy(CAROL, second);
        // Bob leaves some or all of his project money behind, and maybe a tranche is released.
        _sell(BOB, bound(sold, 1, bobUnits));
        if (release) {
            _post();
            _skip(7 days);
            pool.resolveMilestone();
        }
        uint256 carolBefore = pool.escrowOf(CAROL);
        uint256 bobBefore = pool.escrowOf(BOB);

        uint256 feesBefore = pool.feesTaken();
        (, uint256 fee, uint256 put,) = pool.quoteBuy(late);
        _buy(ALICE, late);
        assertEq(fee, pool.feesTaken() - feesBefore);
        assertLe(pool.escrowOf(ALICE), put, "never more than she added");
        // She is owed her own project money back, to within rounding (her weight is a whole number).
        assertGe(pool.escrowOf(ALICE) + 2 + put / 1e9, put, "and not less");
        assertGe(pool.escrowOf(CAROL) + 1, carolBefore, "an earlier backer lost nothing");
        assertGe(pool.escrowOf(BOB) + 1, bobBefore);
    }

    function testFuzz_refunds_after_abandonment_pay_out_the_whole_escrow(uint256 a, uint256 b, uint256 c, uint8 order)
        public
    {
        a = bound(a, 1e15, 2_000_000e18);
        b = bound(b, 1e15, 2_000_000e18);
        c = bound(c, 1e15, 2_000_000e18);
        _buy(ALICE, a);
        _buy(BOB, b);
        _buy(CAROL, c);
        vm.warp(pool.abandonableAt());
        pool.declareAbandoned();
        uint256 escrow = pool.escrow();
        uint256 reserve = pool.reserve();
        uint256[3] memory due = [pool.escrowOf(ALICE), pool.escrowOf(BOB), pool.escrowOf(CAROL)];
        address[3] memory who = [ALICE, BOB, CAROL];
        uint256 paid;
        for (uint256 i; i < 3; ++i) {
            uint256 k = (i + order) % 3;
            (,, uint256 refund,) = pool.quoteSell(who[k], pool.balanceOf(who[k]));
            // Going earlier or later changes nobody's refund by more than rounding.
            assertApproxEqAbs(refund, due[k], 3);
            paid += _sellAll(who[k]);
        }
        assertEq(pool.escrow(), 0);
        assertEq(pool.refunded(), escrow);
        assertLe(paid, escrow + reserve);
        assertGe(paid + 10, escrow + reserve);
        _assertSolvent();
    }

    function testFuzz_a_release_is_exactly_the_tranche_and_touches_no_reserve(uint256 a, uint256 b) public {
        a = bound(a, 1e15, 2_000_000e18);
        b = bound(b, 1e15, 2_000_000e18);
        _buy(ALICE, a);
        _buy(BOB, b);
        uint256 escrow = pool.escrow();
        uint256 reserve = pool.reserve();
        _post();
        _skip(7 days);
        (, uint256 amount) = pool.resolveMilestone();
        assertEq(amount, escrow * 2500 / 10_000);
        assertEq(pool.reserve(), reserve);
        assertEq(quote.balanceOf(treasury), amount + pool.feesTaken());
        _assertSolvent();
    }
}
