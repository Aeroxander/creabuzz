// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {VotingFixture} from "./helpers/VotingFixture.sol";
import {Shares} from "../src/majeur/MolochPatched.sol";

/// @notice Says how many of a holder's Shares are locked, like the milestone lock does.
contract FixedLockGuard {
    mapping(address => uint256) public lockedOf;

    function set(address holder, uint256 amount) external {
        lockedOf[holder] = amount;
    }
}

/// @notice The least an exchange does: move Shares a holder allowed it to move.
contract PlainExchange {
    function move(Shares shares, address from, address to, uint256 amount) external {
        shares.transferFrom(from, to, amount);
    }
}

/// @notice The exchange slot on locked Shares (the deprecated weekly rounds contract used it, D131; the independence tests keep it as a real example, see FundingTerms.t.sol), against a real summoned DAO: only the
/// exchange the DAO named 30 days ahead passes the lock, and only with the holder's allowance; locked team Shares never
/// move; a vote turns it off at once.
contract ExitExchangeTest is VotingFixture {
    address internal constant SELLER = address(0x5E11E2);
    address internal constant BUYER = address(0xB0B0B);
    PlainExchange internal exchange;
    FixedLockGuard internal guard;

    function setUp() public override {
        super.setUp();
        vm.prank(ALICE);
        shares.transfer(SELLER, 40e18);
        exchange = new PlainExchange();
        guard = new FixedLockGuard();
        vm.startPrank(address(dao));
        shares.lockTransfersWithNotice(address(0));
        shares.setLockGuard(address(guard));
        shares.announceExitExchange(address(exchange));
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        vm.prank(SELLER);
        shares.approve(address(exchange), type(uint256).max);
    }

    function test_only_the_named_exchange_as_the_caller_passes_the_lock() public {
        vm.prank(SELLER);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        shares.transfer(BUYER, 1e18);
        // Another contract with the holder's allowance is still refused: only the named exchange passes.
        PlainExchange other = new PlainExchange();
        vm.prank(SELLER);
        shares.approve(address(other), type(uint256).max);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        other.move(shares, SELLER, BUYER, 1e18);
        exchange.move(shares, SELLER, BUYER, 1e18);
        assertEq(shares.balanceOf(BUYER), 1e18);
    }

    function test_locked_team_shares_never_move_through_the_exchange() public {
        guard.set(SELLER, 35e18);
        vm.expectRevert(Shares.LockedShares.selector);
        exchange.move(shares, SELLER, BUYER, 6e18);
        exchange.move(shares, SELLER, BUYER, 5e18);
        assertEq(shares.balanceOf(BUYER), 5e18);
    }

    function test_the_exchange_is_named_by_vote_and_switched_on_thirty_days_later_and_switched_off_at_once() public {
        vm.prank(address(dao));
        shares.clearExitExchange();
        assertEq(shares.exitExchange(), address(0));
        vm.expectRevert(bytes4(keccak256("Locked()")));
        exchange.move(shares, SELLER, BUYER, 1e18);

        vm.prank(BUYER);
        vm.expectRevert();
        shares.announceExitExchange(address(exchange));
        vm.prank(address(dao));
        vm.expectRevert();
        shares.announceExitExchange(address(0));
        vm.prank(address(dao));
        shares.announceExitExchange(address(exchange));
        assertEq(shares.pendingExitExchange(), address(exchange));
        uint256 due = shares.exitExchangeAnnouncedAt() + 30 days;

        vm.warp(due - 1);
        vm.expectRevert(Shares.ExitExchangeNotDue.selector);
        shares.activateExitExchange();
        vm.warp(due);
        vm.prank(BUYER); // anyone switches it on once it is due
        shares.activateExitExchange();
        assertEq(shares.exitExchange(), address(exchange));
        assertEq(shares.pendingExitExchange(), address(0));
        vm.expectRevert(Shares.ExitExchangeNotDue.selector);
        shares.activateExitExchange();
        exchange.move(shares, SELLER, BUYER, 1e18);
        assertEq(shares.balanceOf(BUYER), 1e18);

        vm.prank(BUYER);
        vm.expectRevert();
        shares.clearExitExchange();
    }
}
