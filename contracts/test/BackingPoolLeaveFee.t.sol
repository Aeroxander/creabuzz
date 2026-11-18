// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFixture, ReenteringQuote} from "./helpers/BackingPoolFixture.sol";

/// @notice The leave fee over time, and the units a wallet keeps after it leaves. Every test here drives the
/// pool's own `leave` and `sell`, and compares them with what the rules say, written out here from the pool's public
/// reads:
///
///  - The fee is the ordinary sale fee on what the units that carry weight would fetch on the curve now, but never
///    more than the leaver's own part of the tranche (what staying one more milestone would cost them). So leaving
///    never costs more than staying, and returns at least (10000 - trancheBps) / 10000 of the held part at every
///    milestone, at any price. The review that found the old rule measured it at the default terms and a flat price:
///    90.09 back of 98.999 at milestone 1, 22.4 of 31.3 at milestone 5, 1.0 at milestone 9, and nothing from
///    milestone 10 on, the whole held part going to the treasury.
///  - Units that already left carry no weight (`bareUnitsOf`). A sale uses them first, so it never burns the weight
///    that money put in after leaving carries, and they are not in the base of a later leave fee.
contract BackingPoolLeaveFeeTest is BackingPoolFixture {
    // ---- the rules, from public reads ------------------------------------------------------------------------------

    function _curveOut(uint256 units) internal view returns (uint256) {
        return (pool.virtualQuote() + pool.reserve()) * units / (pool.virtualUnits() - pool.totalSupply() + units);
    }

    function _feeOn(uint256 units) internal view returns (uint256) {
        return (_curveOut(units) * pool.feeBps() + 9_999) / 10_000;
    }

    /// @dev What staying one more milestone would cost `who`: their part of the open tranche.
    function _theirTranche(address who) internal view returns (uint256) {
        return Math.mulDiv(pool.pending(), pool.weightOf(who), pool.staked());
    }

    /// @dev Leave now, and check that the quote and the state change agree.
    function _leaveAndCheck(address who) internal returns (uint256 out, uint256 held, uint256 fee) {
        (uint256 quoted, uint256 fromEscrow, uint256 quotedFee) = pool.quoteLeave(who);
        uint256 escrowBefore = pool.escrow();
        uint256 owedBefore = pool.treasuryOwed();
        uint256 cashBefore = quote.balanceOf(who);
        uint256 unitsBefore = pool.balanceOf(who);
        out = _leave(who);
        assertEq(out, quoted, "leave pays what quoteLeave said");
        assertEq(quote.balanceOf(who) - cashBefore, out, "the wallet received it");
        assertEq(escrowBefore - pool.escrow(), fromEscrow, "the whole held part left the escrow");
        assertEq(pool.treasuryOwed() - owedBefore, quotedFee, "the fee is what the treasury is owed");
        assertEq(fromEscrow - quotedFee, out);
        assertEq(pool.balanceOf(who), unitsBefore, "nothing was sold");
        assertEq(pool.weightOf(who), 0);
        assertEq(pool.bareUnitsOf(who), unitsBefore, "every unit kept now carries no weight");
        _assertSolvent();
        return (out, fromEscrow, quotedFee);
    }

    // ---- fix 1: the fee never outgrows what staying costs ----------------------------------------------------------

    /// @dev One backer who put in 1,000 and never traded again, at the default terms and a flat price: at milestones
    /// 1, 5, 9 and 12 (and every other), leaving costs no more than staying one more milestone and returns at least
    /// three quarters of the held part. At milestone 1 the fee is the ordinary 1%, unchanged.
    function test_leaving_returns_the_held_share_less_a_bounded_fee_at_every_milestone() public {
        _pastEarly();
        _buy(ALICE, 1_000e18);
        uint256[4] memory checked = [uint256(1), 5, 9, 12];
        // What leaving returns at those milestones (the numbers in docs/v3-review/BACKING-POOL.md). The old rule
        // returned 90.09, 22.41, 1.00 and nothing.
        uint256[4] memory returns_ = [uint256(90.09e18), 23.4932e18, 7.4334e18, 3.136e18];
        uint256 next;
        for (uint256 m = 1; m <= 12; ++m) {
            _post();
            (uint256 quoted, uint256 held, uint256 fee) = pool.quoteLeave(ALICE);
            uint256 tranche = _theirTranche(ALICE);
            // The quote itself: bounded, and always something back.
            assertLe(fee, tranche, "leaving never costs more than staying");
            assertGt(quoted, 0, "something always comes back");
            assertGe(quoted, held - tranche, "at least what staying would have kept");
            assertGe(quoted + 4, held * 3 / 4, "at least three quarters of the held part, to the rounding");
            if (m == 1) {
                // The ordinary 1% rate, unchanged where the fee was already the smaller number.
                assertApproxEqAbs(fee, 8.91e18, 0.01e18, "milestone 1 fee is still 1% of the units' worth");
                assertApproxEqAbs(quoted, 90.089e18, 0.01e18);
            }
            if (m == checked[next]) {
                assertApproxEqAbs(quoted, returns_[next], 0.001e18, "the figure the doc gives");
                uint256 snap = vm.snapshotState();
                (uint256 out,, uint256 paid) = _leaveAndCheck(ALICE);
                assertGt(out, 0, "the production leave path returns money");
                assertGe(out + 4, held * 3 / 4);
                assertLe(paid, tranche);
                assertTrue(vm.revertToState(snap));
                ++next;
            }
            _skip(7 days);
            pool.resolveMilestone();
        }
    }

    /// @dev The old rule's other failure: the price had risen about eleven times (another backer put in 100,000
    /// after Alice's 1,000) and the fee was the whole refund at the very first milestone.
    function test_leaving_after_the_price_has_multiplied_still_returns_three_quarters() public {
        _pastEarly();
        uint256 start = pool.price();
        _buy(ALICE, 1_000e18);
        _buy(BOB, 100_000e18);
        assertGt(pool.price(), start * 11, "the price is more than eleven times higher");
        _post();
        (, uint256 held, uint256 fee) = pool.quoteLeave(ALICE);
        // The ordinary fee on her units' worth is now more than the whole refund.
        assertGt(_feeOn(pool.balanceOf(ALICE)), held, "the uncapped fee would take everything");
        assertEq(fee, _theirTranche(ALICE), "the fee is what staying would have cost, no more");
        (uint256 out,,) = _leaveAndCheck(ALICE);
        assertGt(out, 0);
        assertGe(out + 4, held * 3 / 4);
    }

    // ---- fix 2: units that already left ----------------------------------------------------------------------------

    /// @dev Alice and Bob put in 10,000 each; Alice leaves at milestone 1 and keeps her units with no weight; she
    /// then puts in 1,000 more, and a second milestone is posted. Returns with the second window open.
    function _aliceLeftAndCameBack() internal returns (uint256 bare, uint256 fresh) {
        _pastEarly();
        _buy(ALICE, 10_000e18);
        _buy(BOB, 10_000e18);
        _post();
        _leave(ALICE);
        _skip(7 days);
        pool.resolveMilestone();
        bare = pool.balanceOf(ALICE);
        assertEq(pool.bareUnitsOf(ALICE), bare);
        fresh = _buy(ALICE, 1_000e18);
        assertEq(pool.bareUnitsOf(ALICE), bare, "buying adds no bare units");
        assertEq(pool.balanceOf(ALICE), bare + fresh);
    }

    /// @dev The fee base is the units that carry weight. Alice's old units already paid; at the next milestone she
    /// pays on the 1,000 she put in since (about 8.91), not on everything she holds (the old units alone are worth
    /// about ten times that, so the fee would be her whole part of the tranche).
    function test_the_leave_fee_leaves_out_units_that_already_left() public {
        (uint256 bare, uint256 fresh) = _aliceLeftAndCameBack();
        _post();
        (uint256 quoted,, uint256 fee) = pool.quoteLeave(ALICE);
        assertEq(fee, _feeOn(fresh) < _theirTranche(ALICE) ? _feeOn(fresh) : _theirTranche(ALICE));
        assertApproxEqAbs(fee, 8.91e18, 0.01e18, "1% of the money put in since");
        assertGt(_feeOn(bare + fresh), _theirTranche(ALICE), "on all her units the fee would be the whole cap");
        assertGt(quoted, 0);
        (uint256 out,, uint256 paid) = _leaveAndCheck(ALICE);
        assertEq(paid, fee);
        assertEq(out, quoted);
    }

    /// @dev Selling the old units first gives up none of the weight the new money carries. (Before, the weight fell
    /// by the share of units sold: selling the old units burned about 95% of the held part of the 1,000 put in
    /// after leaving, and handed it to the other backers.)
    function test_selling_the_units_that_left_burns_no_weight() public {
        (uint256 bare, uint256 fresh) = _aliceLeftAndCameBack();
        uint256 weight = pool.weightOf(ALICE);
        uint256 total = pool.totalWeight();
        uint256 held = pool.escrowOf(ALICE);
        assertGt(weight, 0);
        (uint256 quoted,,,) = pool.quoteSell(ALICE, bare);
        assertEq(_sell(ALICE, bare), quoted);
        assertEq(pool.weightOf(ALICE), weight, "her weight is untouched");
        assertEq(pool.totalWeight(), total);
        assertEq(pool.escrowOf(ALICE), held, "so is her part of the escrow");
        assertEq(pool.bareUnitsOf(ALICE), 0, "none left");
        assertEq(pool.balanceOf(ALICE), fresh);
    }

    /// @dev A sale smaller than the bare units takes from them alone; a sale larger than them burns weight only for
    /// the units beyond them, in proportion to the units that carry it.
    function test_a_sale_uses_the_units_that_left_first_and_burns_weight_for_the_rest() public {
        (uint256 bare, uint256 fresh) = _aliceLeftAndCameBack();
        uint256 weight = pool.weightOf(ALICE);
        uint256 snap = vm.snapshotState();

        // Less than the bare units: only they shrink.
        _sell(ALICE, bare / 3);
        assertEq(pool.bareUnitsOf(ALICE), bare - bare / 3);
        assertEq(pool.weightOf(ALICE), weight);
        assertTrue(vm.revertToState(snap));

        // The bare units and half of the rest: half the weight goes, and no bare unit is left.
        uint256 beyond = fresh / 2;
        _sell(ALICE, bare + beyond);
        assertEq(pool.bareUnitsOf(ALICE), 0);
        assertEq(pool.balanceOf(ALICE), fresh - beyond);
        assertEq(pool.weightOf(ALICE), weight - Math.mulDiv(weight, beyond, fresh));
        assertTrue(vm.revertToState(snap));

        // Everything: all the weight goes, as it always did.
        _sell(ALICE, bare + fresh);
        assertEq(pool.weightOf(ALICE), 0);
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.bareUnitsOf(ALICE), 0);
        _assertSolvent();
    }

    /// @dev A wallet that left and bought nothing since holds only units without weight: they sell, in parts or at
    /// once, with nothing to divide by and no weight to give up.
    function test_a_leaver_who_bought_nothing_since_sells_all_the_units_in_parts() public {
        _pastEarly();
        _buy(ALICE, 1_000e18);
        _buy(BOB, 1_000e18);
        _post();
        _leave(ALICE);
        uint256 units = pool.balanceOf(ALICE);
        assertEq(pool.bareUnitsOf(ALICE), units);
        _sell(ALICE, units / 4);
        assertEq(pool.bareUnitsOf(ALICE), units - units / 4);
        _sell(ALICE, pool.balanceOf(ALICE));
        assertEq(pool.balanceOf(ALICE), 0);
        assertEq(pool.bareUnitsOf(ALICE), 0);
        assertEq(pool.weightOf(ALICE), 0);
        _assertSolvent();
    }

    /// @dev Units without weight never exceed the units a wallet holds, through any run of buys, sales and leaves.
    function testFuzz_the_units_that_left_are_always_part_of_the_units_held(uint8 steps, uint256 seed) public {
        _pastEarly();
        _buy(BOB, 5_000e18);
        for (uint256 i; i < uint256(steps) % 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 pick = seed % 4;
            if (pick == 0) {
                _buy(ALICE, 10e18 + (seed >> 8) % 2_000e18);
            } else if (pick == 1 && pool.balanceOf(ALICE) != 0) {
                _sell(ALICE, 1 + (seed >> 8) % pool.balanceOf(ALICE));
            } else if (pick == 2) {
                _post();
                if (pool.canLeave(ALICE)) _leave(ALICE);
                _skip(7 days);
                pool.resolveMilestone();
            } else {
                _release();
            }
            assertLe(pool.bareUnitsOf(ALICE), pool.balanceOf(ALICE));
            if (pool.bareUnitsOf(ALICE) == pool.balanceOf(ALICE)) assertEq(pool.weightOf(ALICE), 0);
        }
        _assertSolvent();
    }

    // ---- reentrancy during leave -----------------------------------------------------------------------------------

    /// @dev `leave` ends in a transfer of the quote token, which can call back. Both the guard and the order (state
    /// written first) matter: the call back is refused, and what the pool holds still covers what it owes.
    function test_a_token_that_calls_back_during_a_leave_is_shut_out() public {
        ReenteringQuote token = new ReenteringQuote();
        BackingPool rePool = new BackingPool(treasury, FOUNDER, IERC20(address(token)), defaultTerms(), 0);
        token.mint(ALICE, 10_000e18);
        vm.prank(ALICE);
        token.approve(address(rePool), type(uint256).max);
        vm.warp(block.timestamp + 1 days);
        vm.prank(ALICE);
        rePool.buy(1_000e18, 0, type(uint256).max);
        vm.warp(rePool.nextClaimAt());
        vm.prank(FOUNDER);
        rePool.postMilestone(REF);

        token.arm(rePool, abi.encodeCall(BackingPool.leave, (0, type(uint256).max)));
        vm.prank(ALICE);
        uint256 out = rePool.leave(0, type(uint256).max);
        assertGt(out, 0);
        assertTrue(token.reentered(), "the call back was refused");
        assertEq(bytes4(token.lastRevert()), BackingPool.Reentrancy.selector);
        assertEq(rePool.weightOf(ALICE), 0);
        assertEq(token.balanceOf(address(rePool)), rePool.reserve() + rePool.escrow() + rePool.treasuryOwed());
    }
}
