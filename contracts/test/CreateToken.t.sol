// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreateToken} from "../src/CreateToken.sol";
import {CreateFaucet} from "../src/CreateFaucet.sol";

/// @notice $CREATE (N6): a fixed supply minted once with no owner, vote checkpoints from the first transfer, and the
/// test-network faucet that hands it out once a day per wallet.
contract CreateTokenTest is Test {
    address internal constant ANN = address(0xA11);
    address internal constant BEN = address(0xB3E);
    CreateToken internal create;
    CreateFaucet internal faucet;

    function setUp() public {
        vm.warp(10 days);
        create = new CreateToken("Test CREATE", "tCREATE", address(this));
        faucet = new CreateFaucet(IERC20(address(create)));
        create.transfer(address(faucet), create.SUPPLY());
    }

    function test_the_whole_supply_exists_once_and_nothing_can_make_more() public view {
        assertEq(create.totalSupply(), 1_000_000_000e18);
        assertEq(create.balanceOf(address(faucet)), create.SUPPLY());
        assertEq(create.name(), "Test CREATE");
        assertEq(create.symbol(), "tCREATE");
        // No owner and no mint: neither function exists.
        (bool hasOwner,) = address(create).staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(hasOwner);
        (bool canMint,) = address(create).staticcall(abi.encodeWithSignature("mint(address,uint256)", ANN, 1));
        assertFalse(canMint);
    }

    function test_a_supply_with_nobody_to_hold_it_is_refused() public {
        vm.expectRevert(CreateToken.InvalidSetup.selector);
        new CreateToken("x", "x", address(0));
        vm.expectRevert(CreateFaucet.InvalidSetup.selector);
        new CreateFaucet(IERC20(address(0xBEEF)));
    }

    function test_votes_follow_the_tokens_once_delegated() public {
        vm.prank(ANN);
        faucet.drip();
        vm.prank(ANN);
        create.delegate(ANN);
        vm.roll(block.number + 1);
        assertEq(create.getVotes(ANN), 1_000e18);
        assertEq(create.getPastVotes(ANN, block.number - 1), 1_000e18);
        vm.prank(ANN);
        create.transfer(BEN, 400e18);
        assertEq(create.getVotes(ANN), 600e18);
        assertEq(create.getVotes(BEN), 0, "votes need delegating");
    }

    function test_each_wallet_takes_its_share_once_a_day() public {
        vm.prank(ANN);
        faucet.drip();
        assertEq(create.balanceOf(ANN), 1_000e18);
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(ANN);
        vm.expectRevert(abi.encodeWithSelector(CreateFaucet.TooSoon.selector, uint64(block.timestamp + 1)));
        faucet.drip();
        vm.prank(BEN);
        faucet.drip();
        vm.warp(block.timestamp + 1);
        vm.prank(ANN);
        faucet.drip();
        assertEq(create.balanceOf(ANN), 2_000e18);
    }

    function test_a_dry_faucet_says_so() public {
        CreateToken small = new CreateToken("x", "x", address(this));
        CreateFaucet dry = new CreateFaucet(IERC20(address(small)));
        small.transfer(address(dry), 999e18);
        vm.prank(ANN);
        vm.expectRevert(CreateFaucet.Empty.selector);
        dry.drip();
    }
}
