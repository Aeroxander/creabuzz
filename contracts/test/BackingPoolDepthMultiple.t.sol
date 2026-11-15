// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture} from "./helpers/BackingPoolFixture.sol";

/// @notice The table of docs/v3-review/BACKING-POOL.md, "What the first buyers hold", measured on the pool itself: its
/// own `buy`, `price` and `quoteSell`, nothing modelled. For each depth a founder may choose (and the 5,000 one that
/// was dropped), a pool takes in half, once, twice, five and ten times its depth, with the first buyer putting in
/// 1% of the whole before anyone else. It pins three things the document says:
///
///  1. The price multiple from the first unit to the last depends only on how much came in next to the depth, never
///     on the tier: `(1 + 0.891 x taken in / depth)^2`, so 2.09, 3.58, 7.74, 29.8 and 98.2 times at every tier.
///  2. What the first buyer of 1% holds is the same multiple of their money at every tier too: 1.85, 3.16, 6.78, 25.4
///     and 80.3 times at the last price, and 1.82, 3.08, 6.40, 20.4 and 43.9 times if they sold it all at once.
///  3. So a tier decides one thing: how much money it takes. The same 25,000 paid in moves the price 29.8 times at a
///     depth of 5,000, 10.4 times at 10,000 and 3.58 times at the default.
contract BackingPoolDepthMultipleTest is BackingPoolFixture {
    /// @dev Hundredths: 209 is 2.09 times.
    uint256 internal constant HUNDREDTHS = 100;

    /// @dev A fresh pool of the default terms but for its depth, with no early cap (the cap is per wallet and only
    /// for the first day; the table is about the curve).
    function _open(uint256 depth) internal {
        BackingPool.Params memory p = defaultTerms();
        p.virtualQuote = depth;
        p.earlyCap = 0;
        pool = new BackingPool(treasury, FOUNDER, IERC20(address(quote)), p, 0);
        vm.prank(ALICE);
        quote.approve(address(pool), type(uint256).max);
        vm.prank(BOB);
        quote.approve(address(pool), type(uint256).max);
    }

    /// @dev Take in `total`: ALICE the first hundredth, BOB the rest in nine equal buys.
    /// @return multiple The price now over the opening price, in hundredths.
    /// @return heldMark What ALICE's units are worth at the price now, over what she paid, in hundredths.
    /// @return heldSale What the pool would pay ALICE for all her units now (fee taken), over what she paid.
    function _take(uint256 depth, uint256 total)
        internal
        returns (uint256 multiple, uint256 heldMark, uint256 heldSale)
    {
        _open(depth);
        quote.mint(ALICE, total);
        quote.mint(BOB, total);
        uint256 opening = pool.price();
        uint256 paid = total / 100;
        uint256 units = _buy(ALICE, paid);
        uint256 each = (total - paid) / 9;
        for (uint256 i; i < 9; ++i) {
            _buy(BOB, each);
        }
        uint256 last = pool.price();
        multiple = last * HUNDREDTHS / opening;
        // `price` is quote base units per whole unit, times 1e18.
        heldMark = units * last / 1e36 * HUNDREDTHS / paid;
        (uint256 out,,,) = pool.quoteSell(ALICE, units);
        heldSale = out * HUNDREDTHS / paid;
    }

    function _depths() internal pure returns (uint256[7] memory d) {
        d = [uint256(5_000e18), 10_000e18, 25_000e18, 50_000e18, 100_000e18, 250_000e18, 500_000e18];
    }

    function _near(uint256 got, uint256 want, string memory what) internal pure {
        // Within one part in a hundred of the closed form (the fee and the project part round up, the units down).
        assertApproxEqRel(got, want, 0.01e18, what);
    }

    /// @dev Every row of the table, at every depth.
    function test_the_price_multiple_and_the_first_buyers_holding_follow_what_came_in_next_to_the_depth_alone() public {
        // What came in, in tenths of the depth: half, once, twice, five and ten times.
        uint256[5] memory tenths = [uint256(5), 10, 20, 50, 100];
        // (1 + 0.891 m)^2, and the first 1% buyer's holding at the last price and if sold at once.
        uint256[5] memory wantMultiple = [uint256(209), 358, 774, 2976, 9821];
        uint256[5] memory wantMark = [uint256(185), 316, 678, 2538, 8034];
        uint256[5] memory wantSale = [uint256(182), 308, 640, 2039, 4393];
        uint256[7] memory depths = _depths();
        for (uint256 t; t < 7; ++t) {
            for (uint256 i; i < 5; ++i) {
                (uint256 multiple, uint256 mark, uint256 sale) = _take(depths[t], depths[t] * tenths[i] / 10);
                emit log_named_uint("depth", depths[t] / 1e18);
                emit log_named_uint("  taken in (tenths of the depth)", tenths[i]);
                emit log_named_uint("  price multiple (hundredths)", multiple);
                emit log_named_uint("  first 1% buyer, at the last price (hundredths of what they paid)", mark);
                emit log_named_uint("  first 1% buyer, sold at once (hundredths of what they paid)", sale);
                _near(multiple, wantMultiple[i], "the price multiple");
                _near(mark, wantMark[i], "the first buyer's holding at the last price");
                _near(sale, wantSale[i], "the first buyer's holding if sold");
                _assertSolvent();
            }
        }
    }

    /// @dev The same money at each depth: the shallower the curve, the more the price multiplies. This is the row the
    /// decision to drop the 5,000 depth rests on.
    function test_the_same_money_multiplies_the_price_most_at_the_shallowest_depth() public {
        uint256[7] memory depths = _depths();
        // 25,000 paid in: (1 + 0.891 x 25,000 / depth)^2.
        uint256[7] memory want = [uint256(2976), 1042, 358, 209, 150, 119, 109];
        uint256 last = type(uint256).max;
        for (uint256 t; t < 7; ++t) {
            (uint256 multiple,,) = _take(depths[t], 25_000e18);
            emit log_named_uint("depth", depths[t] / 1e18);
            emit log_named_uint("  price multiple after 25,000 came in (hundredths)", multiple);
            _near(multiple, want[t], "the price multiple at 25,000 paid in");
            assertLt(multiple, last, "a deeper curve multiplies the price less");
            last = multiple;
        }
    }
}
