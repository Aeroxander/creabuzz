// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {VerifierSet} from "../../src/VerifierSet.sol";
import {MockUSDC} from "./MoneyPathsHandler.sol";

/// @notice A reviewer's bond is taken only by its owner (the work budget, which only a DAO vote can drive) and never beyond
/// what the reviewer holds: their stake first, then bond they asked back and have not yet taken. Whatever is taken is paid
/// to the owner, and what is left stays fully backed. Fuzzes the stake, the part asked back, the amount a vote asks for,
/// and whether the unbonding wait has passed.
contract BondSlashFuzzTest is Test {
    address internal constant REVIEWER = address(0x4E01);
    address internal constant OTHER = address(0x4E02);

    function testFuzz_slash_takes_at_most_what_is_held(
        uint128 stakeSeed,
        uint128 pendingSeed,
        uint256 amountSeed,
        uint128 otherSeed,
        bool waited,
        address stranger
    ) public {
        vm.assume(stranger != address(this));
        MockUSDC usdc = new MockUSDC();
        VerifierSet panel = new VerifierSet(address(this), 1);
        panel.setBond(address(usdc), 1);
        panel.acceptVerifier(REVIEWER);
        panel.acceptVerifier(OTHER);

        uint256 total = bound(stakeSeed, 0, 1e15);
        uint256 pending = bound(pendingSeed, 0, total);
        uint256 other = bound(otherSeed, 0, 1e15);
        _bond(usdc, panel, REVIEWER, total);
        _bond(usdc, panel, OTHER, other);
        if (pending != 0) {
            vm.prank(REVIEWER);
            panel.requestUnbond(pending);
        }
        if (waited) vm.warp(block.timestamp + panel.UNBOND_DELAY());
        uint256 held = total; // stake + pending
        uint256 amount = bound(amountSeed, 0, 3e15);

        // Nobody but the owner can slash.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.OnlyOwner.selector, stranger));
        panel.slash(REVIEWER, amount);

        uint256 ownerBefore = usdc.balanceOf(address(this));
        uint256 taken = panel.slash(REVIEWER, amount);
        uint256 expected = amount < held ? amount : held;
        assertEq(taken, expected, "took other than min(asked, held)");
        assertEq(usdc.balanceOf(address(this)) - ownerBefore, taken, "the owner did not receive what was taken");

        (, uint256 stakeAfter,, uint256 slashed) = panel.verifiers(REVIEWER);
        (uint256 pendingAfter,) = panel.unbonds(REVIEWER);
        (, uint256 otherStake,,) = panel.verifiers(OTHER);
        assertEq(slashed, taken);
        assertEq(stakeAfter + pendingAfter, held - taken, "what is left is what was held less what was taken");
        assertEq(otherStake, other, "another reviewer's bond was touched");
        assertEq(usdc.balanceOf(address(panel)), stakeAfter + pendingAfter + otherStake, "the panel is fully backed");
        // The stake goes first: bond waiting to be taken back is touched only once the stake is gone.
        if (pendingAfter < pending) assertEq(stakeAfter, 0, "the bond asked back was taken before the stake");
    }

    function _bond(MockUSDC usdc, VerifierSet panel, address who, uint256 amount) internal {
        if (amount == 0) return;
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(panel), amount);
        panel.bond(amount);
        vm.stopPrank();
    }
}
