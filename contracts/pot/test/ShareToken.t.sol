// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {ShareToken} from "../src/ShareToken.sol";

contract ShareTokenTest is Test {
    ShareToken internal impl;
    ShareToken internal tok;
    address internal ctl = makeAddr("controller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        impl = new ShareToken();
        tok = ShareToken(Clones.clone(address(impl)));
        tok.initialize("Shares", "SHR", ctl, alice, 100e18);
    }

    function test_initializeOnceAndMintsBirthAmount() public {
        assertEq(tok.balanceOf(alice), 100e18);
        assertEq(tok.totalSupply(), 100e18);
        assertEq(tok.controller(), ctl);
        assertEq(tok.decimals(), 18);
        vm.expectRevert(ShareToken.BadBirth.selector);
        tok.initialize("X", "X", ctl, alice, 1);
    }

    function test_implementationIsLocked() public {
        vm.expectRevert(ShareToken.BadBirth.selector);
        impl.initialize("X", "X", ctl, alice, 1);
    }

    function test_badBirthInputs() public {
        ShareToken a = ShareToken(Clones.clone(address(impl)));
        vm.expectRevert(ShareToken.BadBirth.selector);
        a.initialize("X", "X", address(0), alice, 0);
        vm.expectRevert(ShareToken.BadBirth.selector);
        a.initialize("X", "X", ctl, address(0), 1);
        a.initialize("X", "X", ctl, address(0), 0); // no birth amount needs no recipient
        assertEq(a.totalSupply(), 0);
    }

    function test_onlyControllerMints() public {
        address[4] memory who = [stranger, alice, address(this), address(tok)];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(ShareToken.NotController.selector);
            tok.mint(who[i], 1);
        }
        vm.prank(ctl);
        tok.mint(bob, 5);
        assertEq(tok.balanceOf(bob), 5);
        assertEq(tok.totalSupply(), 100e18 + 5);
    }

    /// @dev Binds the burn seam (must-bind 9): a holder, the Vester-like birth recipient and a stranger cannot burn
    /// anything, not even their own; only the controller can, and only by name.
    function test_onlyControllerBurns() public {
        address[4] memory who = [stranger, alice, address(this), bob];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(ShareToken.NotController.selector);
            tok.burnFor(alice, 1);
        }
        vm.prank(ctl);
        tok.burnFor(alice, 40e18);
        assertEq(tok.balanceOf(alice), 60e18);
        assertEq(tok.totalSupply(), 60e18);
    }

    function test_burnMoreThanHeldReverts() public {
        vm.prank(ctl);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        tok.burnFor(alice, 100e18 + 1);
    }

    function test_noPublicBurnOrBurnFromSelector() public {
        (bool ok,) = address(tok).call(abi.encodeWithSignature("burn(uint256)", 1));
        assertFalse(ok);
        (ok,) = address(tok).call(abi.encodeWithSignature("burnFrom(address,uint256)", alice, 1));
        assertFalse(ok);
        // the same from the holder itself, and with an allowance
        vm.prank(alice);
        tok.approve(bob, type(uint256).max);
        vm.prank(bob);
        (ok,) = address(tok).call(abi.encodeWithSignature("burnFrom(address,uint256)", alice, 1));
        assertFalse(ok);
        vm.prank(alice);
        (ok,) = address(tok).call(abi.encodeWithSignature("burn(uint256)", 1));
        assertFalse(ok);
        assertEq(tok.totalSupply(), 100e18);
    }

    function test_transferApproveTransferFrom() public {
        vm.prank(alice);
        tok.transfer(bob, 10e18);
        assertEq(tok.balanceOf(bob), 10e18);
        vm.prank(alice);
        tok.approve(bob, 5e18);
        vm.prank(bob);
        tok.transferFrom(alice, stranger, 5e18);
        assertEq(tok.balanceOf(stranger), 5e18);
        assertEq(tok.allowance(alice, bob), 0);
        vm.prank(bob);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        tok.transferFrom(alice, stranger, 1);
    }

    function test_maxAllowanceNeverFalls() public {
        vm.prank(alice);
        tok.approve(bob, type(uint256).max);
        vm.prank(bob);
        tok.transferFrom(alice, bob, 1e18);
        assertEq(tok.allowance(alice, bob), type(uint256).max);
    }

    function test_transferGuards() public {
        vm.prank(alice);
        vm.expectRevert(ShareToken.ZeroRecipient.selector);
        tok.transfer(address(0), 1);
        vm.prank(alice);
        vm.expectRevert(ShareToken.InsufficientBalance.selector);
        tok.transfer(bob, 100e18 + 1);
        vm.prank(ctl);
        vm.expectRevert(ShareToken.ZeroRecipient.selector);
        tok.mint(address(0), 1);
    }
}
