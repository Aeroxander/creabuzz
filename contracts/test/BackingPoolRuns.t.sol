// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture} from "./helpers/BackingPoolFixture.sol";

/// @notice The run scenario of docs/v3-review/BACKING-POOL.md, "Runs on the curve", as a test: a project that is
/// doing fine, where some backers leave at a milestone and others sell on the curve. It is the contract's own
/// buy, sell and leave run over twenty wallets, with the price measured from `price()`. It pins the two things the
/// document claims:
///
///  1. Leaving no longer sells, so a milestone cannot start a run: the price after leavers have left is the price
///     before (a leave moves nothing), where the old exit, which sold every leaver's units, moved it by the leavers'
///     share.
///  2. A curve whose depth is about twice the raise (the "d = 2" tier) takes a sale of half its units with a price
///     drop of about a third, whatever the size of the raise, where the default depth (25,000) takes the same sale
///     with a drop of 28%, 72% and 97% at 10,000, 50,000 and 250,000 raised.
///
/// The model these numbers come from is the float model of the design note (the same split, the same curve); the
/// bands below are the model's numbers, widened for the wallets not holding exactly equal parts.
contract BackingPoolRunsTest is BackingPoolFixture {
    uint256 internal constant N = 20;
    /// @dev The wallets of a scenario: 0-9 sell when the price has fallen far enough (the panickers), 10-12 leave at the
    /// milestone, 13 starts the sale, the rest never sell.
    address[N] internal wallets;

    function setUp() public override {
        super.setUp();
        for (uint256 i; i < N; ++i) {
            wallets[i] = address(uint160(0xA000 + i));
        }
    }

    /// @dev A fresh pool of the default terms but for its curve depth, backed by the twenty wallets in turn, five rounds
    /// of equal buys, until `raised` has been paid in.
    function _build(uint256 depth, uint256 raised) internal {
        BackingPool.Params memory p = defaultTerms();
        p.virtualQuote = depth;
        p.earlyCap = 0;
        pool = new BackingPool(treasury, FOUNDER, IERC20(address(quote)), p, 0);
        uint256 each = raised / (N * 5);
        for (uint256 i; i < N; ++i) {
            quote.mint(wallets[i], raised);
            vm.prank(wallets[i]);
            quote.approve(address(pool), type(uint256).max);
        }
        for (uint256 round; round < 5; ++round) {
            for (uint256 i; i < N; ++i) {
                _buy(wallets[i], each);
            }
        }
    }

    /// @dev The price now, as a drop from `start`, in basis points.
    function _drop(uint256 start) internal view returns (uint256) {
        uint256 now_ = pool.price();
        return now_ >= start ? 0 : (start - now_) * 10_000 / start;
    }

    /// @dev Sell `units`, from wallet `from` up, each wallet all it holds before the next, and return the drop it made
    /// from the price at the start.
    function _sellUnits(uint256 units, uint256 from) internal returns (uint256 drop) {
        uint256 start = pool.price();
        for (uint256 i = from; i < N && units != 0; ++i) {
            uint256 held = pool.balanceOf(wallets[i]);
            uint256 part = held < units ? held : units;
            if (part != 0) _sell(wallets[i], part);
            units -= part;
        }
        return _drop(start);
    }

    /// @dev Sell `bps` of the supply as it is now, from the first wallet up.
    function _sellShare(uint256 bps) internal returns (uint256 drop) {
        return _sellUnits(pool.totalSupply() * bps / 10_000, 0);
    }

    function _assertBand(uint256 got, uint256 lowBps, uint256 highBps, string memory what) internal pure {
        assertGe(got, lowBps, string.concat(what, ": below its band"));
        assertLe(got, highBps, string.concat(what, ": above its band"));
    }

    // ---- depth ------------------------------------------------------------------------------------------------------

    /// @dev Half the units sold at once, at the default depth: the price falls by more the more has been raised,
    /// because the same paper reserve is a smaller part of the whole.
    function test_at_the_default_depth_a_sale_of_half_the_units_drops_the_price_more_the_more_was_raised() public {
        uint256[3] memory raised = [uint256(10_000e18), 50_000e18, 250_000e18];
        // The model: 28.0%, 72.0%, 96.6%.
        uint256[3] memory low = [uint256(2_650), 7_050, 9_560];
        uint256[3] memory high = [uint256(2_950), 7_350, 9_760];
        for (uint256 i; i < 3; ++i) {
            _build(25_000e18, raised[i]);
            uint256 drop = _sellShare(5_000);
            emit log_named_uint("default depth, raised", raised[i] / 1e18);
            emit log_named_uint("  drop after half the units are sold (bps)", drop);
            _assertBand(drop, low[i], high[i], "default depth");
        }
    }

    /// @dev At a depth of about twice the raise the same sale drops the price by about a third, whatever the raise.
    /// The tier is the smallest of the factory's six that is at least twice the raise.
    function test_at_twice_the_raise_a_sale_of_half_the_units_drops_the_price_by_about_a_third_at_any_size() public {
        uint256[3] memory raised = [uint256(10_000e18), 50_000e18, 250_000e18];
        uint256[3] memory tier = [uint256(25_000e18), 100_000e18, 500_000e18];
        // The model: 28.0% (a depth of 2.5 times the raise), 33.1% and 33.1% (twice the raise).
        uint256[3] memory low = [uint256(2_650), 3_160, 3_160];
        uint256[3] memory high = [uint256(2_950), 3_460, 3_460];
        for (uint256 i; i < 3; ++i) {
            _build(tier[i], raised[i]);
            uint256 drop = _sellShare(5_000);
            emit log_named_uint("tier, raised", raised[i] / 1e18);
            emit log_named_uint("  drop after half the units are sold (bps)", drop);
            _assertBand(drop, low[i], high[i], "twice the raise");
            // And the curve still pays every holder out whatever the order.
            for (uint256 w; w < N; ++w) {
                _sellAll(wallets[w]);
            }
            assertEq(pool.totalSupply(), 0);
            _assertSolvent();
        }
    }

    /// @dev The fall of the price under a given sale, as the depth goes from the tiers below the raise to the ones
    /// above it: deeper is always gentler (a strictly smaller drop for a bigger tier). The first depth is the 5,000
    /// one the factory no longer offers, kept here as the shallow end of the comparison.
    function test_each_deeper_tier_takes_the_same_sale_with_a_smaller_drop() public {
        uint256[7] memory tiers =
            [uint256(5_000e18), 10_000e18, 25_000e18, 50_000e18, 100_000e18, 250_000e18, 500_000e18];
        uint256 last = type(uint256).max;
        for (uint256 i; i < 7; ++i) {
            _build(tiers[i], 50_000e18);
            uint256 drop = _sellShare(5_000);
            assertLt(drop, last, "a deeper curve moves less");
            last = drop;
        }
        // At the deepest tier (ten times the raise) a sale of half the units takes the price down by about 8%
        // (the model: 8.3%), against 96.6% at the shallowest.
        assertLt(last, 1_000);
    }

    // ---- leaving and selling ----------------------------------------------------------------------------------------

    /// @dev A milestone at which 20% of the units leave and 10% are sold by others: the old exit sold the leavers'
    /// units too (30% sold), the new one sells none of them (10%). The model: at 50,000 raised and the default depth
    /// 65.9% against 28.0%; at a depth of 100,000, 28.0% against 8.3%.
    function test_a_milestone_where_a_fifth_leave_and_a_tenth_sell_moves_the_price_by_the_sellers_alone() public {
        uint256[2] memory depths = [uint256(25_000e18), 100_000e18];
        // The model, 50,000 raised: sellers alone 28.0% and 8.3%; the old exit (30% sold) 57.5% and 22.2%.
        uint256[2] memory sellersDrop = [uint256(2_796), 835];
        uint256[2] memory oldDropModel = [uint256(5_754), 2_219];
        for (uint256 d; d < 2; ++d) {
            // OLD: the leavers' units are sold as part of leaving (what leave used to do).
            _build(depths[d], 50_000e18);
            uint256 start = pool.price();
            uint256 tenth = pool.totalSupply() / 10;
            _post();
            _sellWallets(0, 4);
            _sellUnits(tenth, 4);
            uint256 oldDrop = _drop(start);

            // NEW: the same people, the leavers really leave and nothing of theirs is sold.
            _build(depths[d], 50_000e18);
            start = pool.price();
            tenth = pool.totalSupply() / 10;
            uint256 leaversShare = _leaverBps(4);
            _post();
            for (uint256 i; i < 4; ++i) {
                _leave(wallets[i]);
            }
            assertEq(pool.price(), start, "leaving does not move the price");
            assertGt(leaversShare, 1_900, "four of twenty hold a fifth of the units");
            _sellUnits(tenth, 4);
            uint256 newDrop = _drop(start);
            emit log_named_uint("depth", depths[d] / 1e18);
            emit log_named_uint("  old exit, drop (bps)", oldDrop);
            emit log_named_uint("  new exit, drop (bps)", newDrop);
            assertGt(oldDrop, newDrop * 3 / 2, "the old exit moved the price far more");
            _assertBand(newDrop, sellersDrop[d] - 150, sellersDrop[d] + 150, "sellers alone");
            // (The first four buyers hold a little more than a fifth of the units, so the old exit sold a little more than
            // the model's 30%.)
            _assertBand(oldDrop, oldDropModel[d] - 250, oldDropModel[d] + 600, "the old exit");
            _assertSolvent();
        }
    }

    /// @dev A third of the units leave and nobody sells: the old exit dropped the price by two thirds at 50,000
    /// raised at the default depth; the new one by nothing.
    function test_a_third_of_the_units_leaving_and_nobody_selling_moves_nothing() public {
        _build(25_000e18, 50_000e18);
        uint256 start = pool.price();
        uint256 supply = pool.totalSupply();
        _post();
        for (uint256 i; i < 7; ++i) {
            _leave(wallets[i]);
        }
        assertEq(pool.price(), start);
        assertEq(_drop(start), 0);
        assertEq(pool.totalSupply(), supply, "not one unit was sold");
        // The same people leaving the old way: a sale of 35% of the units (the model: 62.1%).
        _build(25_000e18, 50_000e18);
        _post();
        _assertBand(_sellShare(3_500), 5_900, 6_500, "the old exit, 35% of the units");
    }

    // ---- the cascade ------------------------------------------------------------------------------------------------

    /// @dev Half the holders are panickers: each sells all it holds once the price has fallen past its own line (3%
    /// to 40%, in equal steps). Three more leave at the milestone, and one wallet, 3% of the units, starts it. The
    /// model's result, with no surcharge: at a depth of twice the raise the leavers can no longer start it (the seed
    /// drops the price by under 3%, short of the first line) and the old exit could.
    function test_a_cascade_of_leavers_and_sellers_at_three_raise_sizes_and_the_tiers_that_stop_it() public {
        uint256[3] memory raised = [uint256(10_000e18), 50_000e18, 250_000e18];
        uint256[3] memory tier = [uint256(25_000e18), 100_000e18, 500_000e18];
        for (uint256 r; r < 3; ++r) {
            // At the default depth the cascade runs wherever the raise is larger than the depth.
            (uint256 shallowOld, uint256 shallowNew) = _cascade(25_000e18, raised[r]);
            // At twice the raise it dies at the seed.
            (uint256 deepOld, uint256 deepNew) = _cascade(tier[r], raised[r]);
            emit log_named_uint("raised", raised[r] / 1e18);
            emit log_named_uint("  default depth, old exit (bps)", shallowOld);
            emit log_named_uint("  default depth, new exit (bps)", shallowNew);
            emit log_named_uint("  twice the raise, old exit (bps)", deepOld);
            emit log_named_uint("  twice the raise, new exit (bps)", deepNew);
            // The new exit at twice the raise: the seed alone, short of every line.
            assertLt(deepNew, 300, "the cascade does not start at twice the raise");
            // The old exit at twice the raise: the leavers' dump crosses the lines and the cascade runs.
            assertGt(deepOld, 2_000, "the old exit started it, even at twice the raise");
            // The deeper curve is never worse than the shallow one.
            assertLe(deepNew, shallowNew);
            assertLe(deepOld, shallowOld);
            if (raised[r] >= 50_000e18) {
                // Where the raise is larger than the depth, depth alone is what decides: the leave change does not
                // save a thin curve, which is why the two changes ship together.
                assertGt(shallowNew, 5_000, "a thin curve runs even when the leavers keep their units");
            }
        }
    }

    /// @dev One cascade: build the pool, post a milestone, let the leavers go (`leave`, or sell their units: the old
    /// exit), start it with the seed, and let each panicker sell when the fall passes its line. Returns the final
    /// drop for the old exit and for the new one, in basis points.
    function _cascade(uint256 depth, uint256 raised) internal returns (uint256 oldDrop, uint256 newDrop) {
        for (uint256 mode; mode < 2; ++mode) {
            _build(depth, raised);
            uint256 start = pool.price();
            uint256 seed = pool.totalSupply() * 3 / 100;
            _post();
            for (uint256 i = 10; i < 13; ++i) {
                if (mode == 0) _sellAll(wallets[i]);
                else _leave(wallets[i]);
            }
            _sell(wallets[13], seed);
            bool[10] memory sold;
            for (uint256 pass; pass < 11; ++pass) {
                bool changed;
                for (uint256 i; i < 10; ++i) {
                    // Lines of 3%, 7.1%, 11.2% ... 40% of the price at the start.
                    uint256 line = 300 + i * 3_700 / 9;
                    if (!sold[i] && _drop(start) >= line && pool.balanceOf(wallets[i]) != 0) {
                        sold[i] = true;
                        _sellAll(wallets[i]);
                        changed = true;
                    }
                }
                if (!changed) break;
            }
            uint256 drop = _drop(start);
            if (mode == 0) oldDrop = drop;
            else newDrop = drop;
            _assertSolvent();
            // Whatever happened, everyone still gets out, leavers included, in either order.
            for (uint256 i; i < N; ++i) {
                _sellAll(wallets[i]);
            }
            assertEq(pool.totalSupply(), 0);
            _assertSolvent();
        }
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------

    /// @dev The share of the supply held by the first `n` wallets, in basis points.
    function _leaverBps(uint256 n) internal view returns (uint256 bps) {
        uint256 units;
        for (uint256 i; i < n; ++i) {
            units += pool.balanceOf(wallets[i]);
        }
        return units * 10_000 / pool.totalSupply();
    }

    function _sellWallets(uint256 from, uint256 to) internal {
        for (uint256 i = from; i < to; ++i) {
            _sellAll(wallets[i]);
        }
    }
}
