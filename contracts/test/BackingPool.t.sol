// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture, ReenteringQuote, SixDecimalQuote, SkimmingQuote} from "./helpers/BackingPoolFixture.sol";

/// @notice The pool's trading surface: creation terms, buy, sell, quotes, the read surface, and every revert.
contract BackingPoolTest is BackingPoolFixture {
    event Bought(
        address indexed buyer,
        uint256 quoteIn,
        uint256 unitsOut,
        uint256 fee,
        uint256 toEscrow,
        uint256 priceAfter,
        uint256 supplyAfter,
        uint256 reserveAfter
    );
    event Sold(
        address indexed seller,
        uint256 unitsIn,
        uint256 quoteOut,
        uint256 fee,
        uint256 refund,
        uint256 priceAfter,
        uint256 supplyAfter,
        uint256 reserveAfter
    );

    // ---- creation -------------------------------------------------------------------------------------------------

    function test_a_new_pool_reads_its_terms_and_starts_empty() public view {
        assertEq(pool.dao(), treasury);
        assertEq(pool.founder(), FOUNDER);
        assertEq(address(pool.quote()), address(quote));
        assertEq(pool.factory(), address(this));
        assertEq(pool.openedAt(), _now());
        assertEq(pool.virtualQuote(), 25_000e18);
        assertEq(pool.virtualUnits(), 1_000_000_000e18);
        assertEq(pool.projectBps(), 1000);
        assertEq(pool.feeBps(), 100);
        assertEq(pool.trancheBps(), 2500);
        assertEq(pool.objectionWindow(), 7 days);
        assertEq(pool.resolveWindow(), 7 days);
        assertEq(pool.claimInterval(), 28 days);
        assertEq(pool.abandonAfter(), 180 days);
        assertEq(pool.voteSeasoning(), 30 days);
        assertEq(pool.voteAfter(), 90 days);
        assertEq(pool.earlyWindow(), 1 days);
        assertEq(pool.earlyCap(), 1_000e18);
        assertEq(pool.decimals(), 18);
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.reserve(), 0);
        assertEq(pool.escrow(), 0);
        // 25,000 quote on paper against a billion units: 0.000025 quote a unit, in the 1e18 fixed point.
        assertEq(pool.price(), 0.000025e18 * 1e18);
        assertEq(pool.nextClaimAt(), _now() + 28 days);
        assertEq(pool.abandonableAt(), _now() + 180 days);
    }

    function _expectBadTerms(BackingPool.Params memory p) internal {
        vm.expectRevert(BackingPool.InvalidParams.selector);
        new BackingPool(treasury, FOUNDER, IERC20(address(quote)), p, 0);
    }

    function test_creation_refuses_terms_outside_the_bounds() public {
        BackingPool.Params memory p = defaultTerms();
        p.virtualQuote = 0;
        _expectBadTerms(p);
        p = defaultTerms();
        p.virtualQuote = uint256(type(uint112).max) + 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.virtualUnits = 1e18 - 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.virtualUnits = uint256(type(uint112).max) + 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.projectBps = 9001;
        _expectBadTerms(p);
        p = defaultTerms();
        p.feeBps = 501;
        _expectBadTerms(p);
        p = defaultTerms();
        p.trancheBps = 0;
        _expectBadTerms(p);
        p = defaultTerms();
        p.trancheBps = 5001;
        _expectBadTerms(p);
        p = defaultTerms();
        p.objectionWindow = 1 days - 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.objectionWindow = 30 days + 1;
        p.claimInterval = 60 days;
        _expectBadTerms(p);
        p = defaultTerms();
        p.resolveWindow = 1 days - 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.resolveWindow = 30 days + 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.claimInterval = p.objectionWindow - 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.claimInterval = 365 days + 1;
        p.abandonAfter = 800 days;
        _expectBadTerms(p);
        p = defaultTerms();
        p.abandonAfter = p.claimInterval + p.objectionWindow + p.resolveWindow;
        _expectBadTerms(p);
        p = defaultTerms();
        p.abandonAfter = 1460 days + 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.voteSeasoning = 90 days + 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.voteAfter = p.abandonAfter + 1;
        _expectBadTerms(p);
        p = defaultTerms();
        p.earlyWindow = 30 days + 1;
        _expectBadTerms(p);
    }

    function test_creation_refuses_a_treasury_or_quote_without_code() public {
        BackingPool.Params memory p = defaultTerms();
        vm.expectRevert(BackingPool.InvalidParams.selector);
        new BackingPool(address(0), FOUNDER, IERC20(address(quote)), p, 0);
        vm.expectRevert(BackingPool.InvalidParams.selector);
        new BackingPool(address(0x1234), FOUNDER, IERC20(address(quote)), p, 0);
        vm.expectRevert(BackingPool.InvalidParams.selector);
        new BackingPool(treasury, FOUNDER, IERC20(address(0x1234)), p, 0);
    }

    // ---- buy ------------------------------------------------------------------------------------------------------

    function test_a_buy_splits_the_money_and_mints_from_the_curve() public {
        (uint256 quotedUnits, uint256 quotedFee, uint256 quotedEscrow, uint256 quotedPrice) = pool.quoteBuy(1_000e18);
        // 1% fee to the treasury, then 10% of the rest to the project: 297 to the escrow, 693 to the reserve.
        assertEq(quotedFee, 10e18);
        assertEq(quotedEscrow, 99e18);
        uint256 expectedUnits = uint256(1_000_000_000e18) * 891e18 / (25_000e18 + 891e18);
        assertEq(quotedUnits, expectedUnits);

        vm.expectEmit(true, false, false, true, address(pool));
        emit Bought(ALICE, 1_000e18, expectedUnits, 10e18, 99e18, quotedPrice, expectedUnits, 891e18);
        uint256 units = _buy(ALICE, 1_000e18);

        assertEq(units, expectedUnits);
        assertEq(pool.balanceOf(ALICE), expectedUnits);
        assertEq(pool.totalSupply(), expectedUnits);
        assertEq(pool.reserve(), 891e18);
        assertEq(pool.escrow(), 99e18);
        assertEq(pool.feesTaken(), 10e18);
        assertEq(pool.treasuryOwed(), 10e18);
        assertEq(pool.price(), quotedPrice);
        assertGt(pool.price(), 0.000025e18 * 1e18, "a buy moves the price up");
        assertEq(pool.lastBuyAt(ALICE), _now());
        // Her weight stands for the project money she put in.
        assertApproxEqAbs(pool.escrowOf(ALICE), 99e18, 2);
        _assertSolvent();
    }

    function test_buy_refuses_a_passed_deadline() public {
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.Expired.selector);
        pool.buy(100e18, 0, _now() - 1);
    }

    function test_buy_refuses_fewer_units_than_asked_for() public {
        (uint256 units,,,) = pool.quoteBuy(100e18);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.Slippage.selector);
        pool.buy(100e18, units + 1, type(uint256).max);
        vm.prank(ALICE);
        assertEq(pool.buy(100e18, units, type(uint256).max), units);
    }

    function test_buy_refuses_an_amount_that_mints_nothing() public {
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.ZeroAmount.selector);
        pool.buy(0, 0, type(uint256).max);
    }

    function test_buy_refuses_amounts_past_the_curve_bounds() public {
        _pastEarly();
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.TooLarge.selector);
        pool.buy(uint256(type(uint128).max) + 1, 0, type(uint256).max);
        // And a reserve that would pass what the curve's arithmetic is sized for.
        BackingPool.Params memory p = defaultTerms();
        p.virtualQuote = type(uint112).max;
        p.projectBps = 0;
        p.feeBps = 0;
        p.earlyCap = 0;
        BackingPool big = new BackingPool(treasury, FOUNDER, IERC20(address(quote)), p, 0);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.TooLarge.selector);
        big.buy(type(uint128).max, 0, type(uint256).max);
    }

    function test_the_early_cap_limits_each_wallet_and_then_lifts() public {
        _buy(ALICE, 600e18);
        assertEq(pool.snapshot(ALICE).holderEarlyLeft, 400e18);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.EarlyCapReached.selector);
        pool.buy(400e18 + 1, 0, type(uint256).max);
        _buy(ALICE, 400e18);
        assertEq(pool.earlySpent(ALICE), 1_000e18);
        // Another wallet has its own cap.
        _buy(BOB, 1_000e18);
        // One second before the window ends the cap still holds; at the end it is gone.
        _skip(1 days - 1);
        vm.prank(ALICE);
        vm.expectRevert(BackingPool.EarlyCapReached.selector);
        pool.buy(1, 0, type(uint256).max);
        _skip(1);
        _buy(ALICE, 50_000e18);
        assertEq(pool.snapshot(ALICE).holderEarlyLeft, type(uint256).max);
        _assertSolvent();
    }

    function test_a_pool_without_a_cap_takes_any_size_at_once() public {
        BackingPool.Params memory p = defaultTerms();
        p.earlyCap = 0;
        BackingPool open = new BackingPool(treasury, FOUNDER, IERC20(address(quote)), p, 0);
        vm.startPrank(ALICE);
        quote.approve(address(open), type(uint256).max);
        open.buy(500_000e18, 0, type(uint256).max);
        vm.stopPrank();
        assertEq(open.snapshot(ALICE).holderEarlyLeft, type(uint256).max);
    }

    function test_a_token_that_keeps_part_of_a_transfer_is_refused() public {
        SkimmingQuote skim = new SkimmingQuote();
        BackingPool skimPool = new BackingPool(treasury, FOUNDER, IERC20(address(skim)), defaultTerms(), 0);
        skim.mint(ALICE, 1_000e18);
        vm.startPrank(ALICE);
        skim.approve(address(skimPool), type(uint256).max);
        vm.expectRevert(BackingPool.BadQuoteTransfer.selector);
        skimPool.buy(100e18, 0, type(uint256).max);
        vm.stopPrank();
        assertEq(skimPool.totalSupply(), 0);
    }

    function test_buy_without_allowance_or_balance_changes_nothing() public {
        address poor = address(0x9001);
        vm.prank(poor);
        vm.expectRevert();
        pool.buy(100e18, 0, type(uint256).max);
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.reserve(), 0);
    }

    // ---- sell -----------------------------------------------------------------------------------------------------

    function test_a_sale_pays_from_the_reserve_and_leaves_the_project_money() public {
        uint256 units = _buy(ALICE, 1_000e18);
        (uint256 quotedOut, uint256 quotedFee, uint256 quotedRefund, uint256 quotedPrice) =
            pool.quoteSell(ALICE, units);
        assertEq(quotedRefund, 0);
        // Selling everything empties the reserve to within the rounding the curve keeps.
        uint256 gross = quotedOut + quotedFee;
        assertLe(gross, 891e18);
        assertGe(gross, 891e18 - 2);
        assertEq(quotedFee, (gross + 99) / 100);

        uint256 before = quote.balanceOf(ALICE);
        vm.expectEmit(true, false, false, true, address(pool));
        emit Sold(ALICE, units, quotedOut, quotedFee, 0, quotedPrice, 0, 891e18 - gross);
        uint256 out = _sell(ALICE, units);

        assertEq(out, quotedOut);
        assertEq(quote.balanceOf(ALICE) - before, out);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.weightOf(ALICE), 0);
        assertEq(pool.totalWeight(), 0);
        // The project money stays; the two fees are the treasury's.
        assertEq(pool.escrow(), 99e18);
        assertEq(pool.treasuryOwed(), 10e18 + quotedFee);
        assertLt(out, 1_000e18 * 90 / 100, "a round trip gives back less than the reserve part");
        assertGt(out, 1_000e18 * 88 / 100, "and about 88% of what was paid");
        _assertSolvent();
    }

    function test_selling_part_gives_up_the_same_part_of_the_weight() public {
        uint256 units = _buy(ALICE, 1_000e18);
        uint256 weight = pool.weightOf(ALICE);
        _sell(ALICE, units / 4);
        assertApproxEqRel(pool.weightOf(ALICE), weight - weight / 4, 1e9);
        assertEq(pool.totalWeight(), pool.weightOf(ALICE));
        assertEq(pool.balanceOf(ALICE), units - units / 4);
    }

    function test_sell_refuses_zero_more_than_held_a_passed_deadline_and_too_little_out() public {
        uint256 units = _buy(ALICE, 1_000e18);
        vm.startPrank(ALICE);
        vm.expectRevert(BackingPool.ZeroAmount.selector);
        pool.sell(0, 0, type(uint256).max);
        vm.expectRevert(BackingPool.InsufficientUnits.selector);
        pool.sell(units + 1, 0, type(uint256).max);
        vm.expectRevert(BackingPool.Expired.selector);
        pool.sell(units, 0, _now() - 1);
        (uint256 out,,,) = pool.quoteSell(ALICE, units);
        vm.expectRevert(BackingPool.Slippage.selector);
        pool.sell(units, out + 1, type(uint256).max);
        assertEq(pool.sell(units, out, type(uint256).max), out);
        vm.stopPrank();
        vm.prank(BOB);
        vm.expectRevert(BackingPool.InsufficientUnits.selector);
        pool.sell(1, 0, type(uint256).max);
        vm.expectRevert(BackingPool.InsufficientUnits.selector);
        pool.quoteSell(BOB, 1);
    }

    function test_every_holder_can_sell_in_any_order_and_the_reserve_never_runs_short() public {
        _pastEarly();
        _buy(ALICE, 40_000e18);
        _buy(BOB, 7_000e18);
        _buy(CAROL, 90_000e18);
        _buy(ALICE, 3_333e18);
        uint256 reserveBefore = pool.reserve();
        // Not in the order they came in.
        uint256 out = _sellAll(BOB) + _sellAll(ALICE) + _sellAll(CAROL);
        assertEq(pool.totalSupply(), 0);
        assertLe(out, reserveBefore);
        // What the curve kept through rounding is a few base units.
        assertLt(pool.reserve(), 10);
        _assertSolvent();
    }

    // ---- quotes and reads -----------------------------------------------------------------------------------------

    function test_buy_price_is_the_curve_price_with_the_split_and_fee_on_top() public {
        _buy(ALICE, 1_000e18);
        uint256 spot = pool.price();
        uint256 buyPrice = pool.buyPrice();
        // 1 / (0.99 * 0.90)
        assertApproxEqRel(buyPrice, spot * 10_000 * 10_000 / (9_900 * 9_000), 1e9);
        // A small buy pays about that per unit.
        (uint256 units,,,) = pool.quoteBuy(1e18);
        assertApproxEqRel(1e18 * 1e36 / units, buyPrice, 1e14);
    }

    function test_quotes_match_what_the_trades_do() public {
        _pastEarly();
        _buy(BOB, 5_000e18);
        (uint256 units,,, uint256 priceAfterBuy) = pool.quoteBuy(2_500e18);
        assertEq(_buy(ALICE, 2_500e18), units);
        assertEq(pool.price(), priceAfterBuy);
        (uint256 out,,, uint256 priceAfterSell) = pool.quoteSell(ALICE, units / 2);
        assertEq(_sell(ALICE, units / 2), out);
        assertEq(pool.price(), priceAfterSell);
    }

    function test_snapshot_shows_the_pool_and_the_wallet() public {
        uint256 units = _buy(ALICE, 1_000e18);
        BackingPool.Snapshot memory s = pool.snapshot(ALICE);
        assertEq(s.price, pool.price());
        assertEq(s.buyPrice, pool.buyPrice());
        assertEq(s.reserve, 891e18);
        assertEq(s.escrow, 99e18);
        assertEq(s.feesTaken, 10e18);
        assertEq(s.treasuryOwed, 10e18);
        assertEq(s.released, 0);
        assertEq(s.refunded, 0);
        assertEq(s.totalSupply, units);
        assertEq(s.totalWeight, pool.totalWeight());
        assertFalse(s.abandoned);
        assertEq(s.openedAt, pool.openedAt());
        assertEq(s.nextClaimAt, pool.nextClaimAt());
        assertEq(s.abandonableAt, pool.abandonableAt());
        assertEq(s.milestoneId, 0);
        assertEq(uint8(s.milestone.status), uint8(BackingPool.MilestoneStatus.None));
        assertEq(s.holderUnits, units);
        assertEq(s.holderWeight, pool.weightOf(ALICE));
        assertEq(s.holderEscrow, pool.escrowOf(ALICE));
        (uint256 out,,,) = pool.quoteSell(ALICE, units);
        assertEq(s.holderSellValue, out);
        assertFalse(s.holderCanLeave);
        assertEq(s.holderLeaveValue, 0);
        assertEq(s.pending, 0);
        assertFalse(s.holderVotedAbandon);
        assertEq(s.holderEarlyLeft, 0);

        BackingPool.Snapshot memory nobody = pool.snapshot(address(0));
        assertEq(nobody.holderUnits, 0);
        assertEq(nobody.holderSellValue, 0);
        assertEq(nobody.totalSupply, units);

        _post();
        s = pool.snapshot(ALICE);
        assertEq(s.milestoneId, 1);
        assertEq(s.milestone.ref, REF);
        assertEq(uint8(s.milestone.status), uint8(BackingPool.MilestoneStatus.Open));
        assertEq(s.milestone.escrowAtPost, 99e18);
        assertEq(s.milestone.windowEndsAt, _now() + 7 days);
        assertEq(s.milestone.resolveBy, _now() + 14 days);
        assertEq(s.pending, 99e18 / 4);
        assertTrue(s.holderCanLeave);
        (uint256 leaveOut, uint256 fromCurve, uint256 fromEscrow,,) = pool.quoteLeave(ALICE);
        assertEq(s.holderLeaveValue, leaveOut);
        assertEq(leaveOut, fromCurve + fromEscrow);
        // Leaving hands back the whole escrow part, and that is what the wallet's escrow reads while it can leave.
        assertApproxEqAbs(fromEscrow, 99e18, 2);
        assertEq(s.holderEscrow, fromEscrow);
        assertGt(s.holderLeaveValue, s.holderSellValue);
    }

    /// @dev A 6-decimal quote token: the price is fine-grained enough to chart (it moves with every buy).
    function test_the_price_is_fine_grained_with_a_six_decimal_quote() public {
        SixDecimalQuote six = new SixDecimalQuote();
        BackingPool.Params memory p = defaultTerms();
        p.virtualQuote = 25_000e6;
        p.earlyCap = 0;
        BackingPool small = new BackingPool(treasury, FOUNDER, IERC20(address(six)), p, 0);
        six.mint(ALICE, 1_000_000e6);
        vm.startPrank(ALICE);
        six.approve(address(small), type(uint256).max);
        // 0.000025 of a token a unit: 25 base units a whole unit, in the 1e18 fixed point.
        uint256 last = small.price();
        assertEq(last, 25e18);
        for (uint256 i; i < 5; ++i) {
            small.buy(1e6, 0, type(uint256).max);
            assertGt(small.price(), last, "one token moves the price");
            last = small.price();
        }
        vm.stopPrank();
        // And about 0.007% a token, not the 4% steps a whole-number price had.
        assertLt(last, 25e18 * 1001 / 1000);
    }

    // ---- reentrancy -----------------------------------------------------------------------------------------------

    function _reenteringPool() internal returns (ReenteringQuote token, BackingPool rePool) {
        token = new ReenteringQuote();
        rePool = new BackingPool(treasury, FOUNDER, IERC20(address(token)), defaultTerms(), 0);
        token.mint(ALICE, 10_000e18);
        vm.prank(ALICE);
        token.approve(address(rePool), type(uint256).max);
    }

    function test_a_token_that_calls_back_during_a_buy_is_shut_out() public {
        (ReenteringQuote token, BackingPool rePool) = _reenteringPool();
        token.arm(rePool, abi.encodeCall(BackingPool.sell, (1, 0, type(uint256).max)));
        vm.prank(ALICE);
        rePool.buy(100e18, 0, type(uint256).max);
        assertTrue(token.reentered(), "the call back was refused");
        assertEq(bytes4(token.lastRevert()), BackingPool.Reentrancy.selector);
        assertEq(token.balanceOf(address(rePool)), rePool.reserve() + rePool.escrow() + rePool.treasuryOwed());
    }

    function test_a_token_that_calls_back_during_a_sale_or_a_release_is_shut_out() public {
        (ReenteringQuote token, BackingPool rePool) = _reenteringPool();
        vm.prank(ALICE);
        uint256 units = rePool.buy(100e18, 0, type(uint256).max);
        token.arm(rePool, abi.encodeCall(BackingPool.buy, (1e18, 0, type(uint256).max)));
        vm.prank(ALICE);
        rePool.sell(units / 2, 0, type(uint256).max);
        assertTrue(token.reentered());
        assertEq(bytes4(token.lastRevert()), BackingPool.Reentrancy.selector);

        vm.warp(rePool.nextClaimAt());
        vm.prank(FOUNDER);
        rePool.postMilestone(REF);
        _skip(7 days);
        token.arm(rePool, abi.encodeCall(BackingPool.resolveMilestone, ()));
        rePool.resolveMilestone();
        assertTrue(token.reentered());
        assertEq(bytes4(token.lastRevert()), BackingPool.Reentrancy.selector);
        assertEq(token.balanceOf(address(rePool)), rePool.reserve() + rePool.escrow() + rePool.treasuryOwed());
    }

    // ---- units are a ledger, not a token --------------------------------------------------------------------------

    function test_units_cannot_be_moved_between_wallets() public {
        _buy(ALICE, 100e18);
        (bool ok,) = address(pool).call(abi.encodeWithSignature("transfer(address,uint256)", BOB, 1));
        assertFalse(ok, "there is no transfer");
        (ok,) = address(pool).call(abi.encodeWithSignature("approve(address,uint256)", BOB, 1));
        assertFalse(ok, "there is no approve");
        (ok,) = address(pool).call(abi.encodeWithSignature("transferFrom(address,address,uint256)", ALICE, BOB, 1));
        assertFalse(ok, "there is no transferFrom");
    }

    function test_money_sent_to_the_pool_by_mistake_belongs_to_nobody_and_breaks_nothing() public {
        uint256 units = _buy(ALICE, 1_000e18);
        quote.mint(address(pool), 5_000e18);
        assertEq(pool.reserve(), 891e18);
        assertEq(pool.escrow(), 99e18);
        (uint256 out,,,) = pool.quoteSell(ALICE, units);
        assertEq(_sell(ALICE, units), out);
        assertEq(quote.balanceOf(address(pool)), pool.reserve() + pool.escrow() + pool.treasuryOwed() + 5_000e18);
    }
}
