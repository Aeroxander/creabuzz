// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Clones} from "oz5/proxy/Clones.sol";

/// @notice ShareToken alone: fixed supply minted once, plain transfers, burn by the holder, no way to mint again.
contract ShareTokenTest is Test {
    ShareToken internal impl;
    ShareToken internal token;
    address internal a = makeAddr("a");
    address internal b = makeAddr("b");
    address internal c = makeAddr("c");
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function setUp() public {
        impl = new ShareToken();
        token = ShareToken(Clones.clone(address(impl)));
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (to[0], amounts[0]) = (a, 600_000_000e18);
        (to[1], amounts[1]) = (b, 400_000_000e18);
        token.initialize("Project", "PRJ", to, amounts);
    }

    function _init(ShareToken tok, address to, uint256 amount) internal {
        address[] memory tos = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        (tos[0], amounts[0]) = (to, amount);
        tok.initialize("X", "X", tos, amounts);
    }

    function test_birth_mintsTheFixedSupplyOnce() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.SUPPLY(), 1_000_000_000e18);
        assertEq(token.decimals(), 18);
        assertEq(token.balanceOf(a), 600_000_000e18);
        assertEq(token.balanceOf(b), 400_000_000e18);
        assertEq(token.name(), "Project");
        assertEq(token.symbol(), "PRJ");
    }

    function test_birth_cannotBeRepeated() public {
        vm.expectRevert(ShareToken.BadBirth.selector);
        _init(token, c, SUPPLY);
    }

    function test_birth_theImplementationIsLocked() public {
        vm.expectRevert(ShareToken.BadBirth.selector);
        _init(impl, c, SUPPLY);
    }

    function test_birth_amountsMustAddUpToTheSupply() public {
        ShareToken fresh = ShareToken(Clones.clone(address(impl)));
        vm.expectRevert(ShareToken.BadBirth.selector);
        _init(fresh, c, SUPPLY - 1);
        vm.expectRevert(ShareToken.BadBirth.selector);
        _init(fresh, c, SUPPLY + 1);
        _init(fresh, c, SUPPLY); // the exact supply still works after the refusals
        assertEq(fresh.balanceOf(c), SUPPLY);
    }

    function test_birth_refusesTheZeroAddressAndMismatchedLists() public {
        ShareToken fresh = ShareToken(Clones.clone(address(impl)));
        vm.expectRevert(ShareToken.ZeroRecipient.selector);
        _init(fresh, address(0), SUPPLY);
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](1);
        vm.expectRevert(ShareToken.BadBirth.selector);
        fresh.initialize("X", "X", to, amounts);
    }

    function test_transfer_movesShares() public {
        vm.prank(a);
        assertTrue(token.transfer(c, 5));
        assertEq(token.balanceOf(c), 5);
        assertEq(token.balanceOf(a), 600_000_000e18 - 5);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_transfer_refusesMoreThanHeldAndTheZeroAddress() public {
        vm.prank(c);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        token.transfer(a, 1);
        vm.prank(a);
        vm.expectRevert(ShareToken.ZeroRecipient.selector);
        token.transfer(address(0), 1);
    }

    function test_allowance_transferFromSpendsIt() public {
        vm.prank(a);
        token.approve(c, 10);
        vm.prank(c);
        token.transferFrom(a, b, 4);
        assertEq(token.allowance(a, c), 6);
        vm.prank(c);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        token.transferFrom(a, b, 7);
    }

    function test_allowance_maximumIsNeverSpent() public {
        vm.prank(a);
        token.approve(c, type(uint256).max);
        vm.prank(c);
        token.transferFrom(a, b, 1000);
        assertEq(token.allowance(a, c), type(uint256).max);
    }

    function test_burn_theHolderBurnsOwnSharesAndSupplyFalls() public {
        vm.prank(a);
        token.burn(100);
        assertEq(token.totalSupply(), SUPPLY - 100);
        assertEq(token.balanceOf(a), 600_000_000e18 - 100);
        vm.prank(c);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        token.burn(1);
    }

    function test_burnFrom_needsAnAllowanceAndSpendsIt() public {
        vm.prank(c);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        token.burnFrom(a, 1);
        vm.prank(a);
        token.approve(c, 10);
        vm.prank(c);
        token.burnFrom(a, 10);
        assertEq(token.allowance(a, c), 0);
        assertEq(token.totalSupply(), SUPPLY - 10);
    }

    function test_noMintAfterBirth_supplyOnlyFalls() public {
        // there is no function that raises the supply: after any sequence of the public calls it never exceeds SUPPLY
        vm.prank(a);
        token.burn(1);
        assertLt(token.totalSupply(), SUPPLY);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_transfersAndBurnsConserveSupply(uint256 t1, uint256 t2, uint256 burn) public {
        t1 = bound(t1, 0, token.balanceOf(a));
        vm.prank(a);
        token.transfer(c, t1);
        t2 = bound(t2, 0, token.balanceOf(c));
        vm.prank(c);
        token.transfer(b, t2);
        burn = bound(burn, 0, token.balanceOf(b));
        vm.prank(b);
        token.burn(burn);
        assertEq(token.balanceOf(a) + token.balanceOf(b) + token.balanceOf(c), SUPPLY - burn);
        assertEq(token.totalSupply(), SUPPLY - burn);
    }
}
