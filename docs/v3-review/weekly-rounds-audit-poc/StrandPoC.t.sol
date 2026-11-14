// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VotingFixture} from "/Volumes/ExternalSSD/Applications/creabuzz/contracts/test/helpers/VotingFixture.sol";
import {WeeklyRounds} from "/Volumes/ExternalSSD/Applications/creabuzz/contracts/src/WeeklyRounds.sol";
import {MandateCurrency} from "/Volumes/ExternalSSD/Applications/creabuzz/contracts/test/TreasuryMandate.t.sol";

/// @notice Says how many of each holder's Shares are locked, and how many in all, like the milestone lock does.
contract CountingLockGuard {
    mapping(address => uint256) public lockedOf;
    uint256 public totalLocked;

    function set(address holder, uint256 amount) external {
        totalLocked = totalLocked - lockedOf[holder] + amount;
        lockedOf[holder] = amount;
    }
}

/// @notice Weekly rounds on a real summoned DAO with its Shares locked: a sale through a round keeps the treasury's
/// money, the price follows one stated rule, partial fills add up exactly, a round nobody settles gives everything back,
/// and leaving is always open, from escrow too.
contract WeeklyRoundsTest is VotingFixture {
    address internal constant ANA = address(0xA4A);
    address internal constant CY = address(0xC4C);
    address internal constant FAY = address(0xFA1);
    address internal constant BEN = address(0xBE4);
    address internal constant DEE = address(0xDEE);
    address internal constant EVE = address(0xE7E);
    uint256 internal constant USD = 1e6;

    MandateCurrency internal usd;
    WeeklyRounds internal rounds;
    CountingLockGuard internal guard;

    function setUp() public override {
        super.setUp();
        // Alice keeps 10 of her 100 Shares; Bob holds 100 Loot. 200 units can leave, so 200 USDC makes a floor of 1.00.
        vm.startPrank(ALICE);
        shares.transfer(ANA, 50e18);
        shares.transfer(CY, 30e18);
        shares.transfer(FAY, 10e18);
        vm.stopPrank();
        usd = new MandateCurrency();
        usd.mint(address(dao), 200 * USD);
        rounds = new WeeklyRounds(IERC20(address(usd)), 1e4);
        guard = new CountingLockGuard();
        vm.startPrank(address(dao));
        shares.lockTransfersWithNotice(address(0));
        shares.setLockGuard(address(guard));
        shares.announceExitExchange(address(rounds));
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        address[3] memory sellers = [ANA, CY, FAY];
        for (uint256 i; i < sellers.length; ++i) {
            vm.prank(sellers[i]);
            shares.approve(address(rounds), type(uint256).max);
        }
        address[3] memory buyers = [BEN, DEE, EVE];
        for (uint256 i; i < buyers.length; ++i) {
            usd.mint(buyers[i], 1_000 * USD);
            vm.prank(buyers[i]);
            usd.approve(address(rounds), type(uint256).max);
        }
    }

    // ---- helpers -------------------------------------------------------------------------------------------------

    function _sell(uint256 id, address who, uint256 amount, uint256 step) internal {
        vm.prank(who);
        rounds.sell(id, amount, step);
    }

    function _bid(uint256 id, address who, uint256 amount, uint256 step) internal {
        vm.prank(who);
        rounds.bid(id, amount, step);
    }

    function _close(uint256 id) internal {
        (,,, uint64 closesAt,,,,,,,,,,,,,,) = rounds.rounds(id);
        vm.warp(closesAt);
    }

    function _settle(uint256 id) internal returns (uint256 step) {
        _close(id);
        (step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
    }

    function _usd() internal pure returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = address(0);
    }

    function _leaveWithUsd() internal view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = address(usd);
    }


    function test_clearing_the_exchange_strands_a_premium_buyer() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _sell(id, CY, 30e18, 400);
        _bid(id, BEN, 50e18, 300);
        assertEq(_settle(id), 300);
        rounds.claim(id, ANA);
        vm.prank(address(dao));
        shares.clearExitExchange();
        vm.expectRevert();
        rounds.claim(id, BEN);
        vm.expectRevert();
        rounds.claim(id, CY);
        assertEq(usd.balanceOf(address(dao)), 230 * USD);
        uint256 b0 = usd.balanceOf(BEN);
        vm.prank(BEN);
        rounds.claimAndLeave(id, _leaveWithUsd());
        emit log_named_uint("BEN paid", 1_000 * USD - b0);
        emit log_named_uint("BEN leaving pays", usd.balanceOf(BEN) - b0);
        uint256 c0 = usd.balanceOf(CY);
        vm.prank(CY);
        rounds.claimAndLeave(id, _leaveWithUsd());
        emit log_named_uint("CY leaving pays", usd.balanceOf(CY) - c0);
        // waiting path: re-announce, 30 days, claim works
    }

    function test_waiting_path_recovers_after_reannounce() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _sell(id, CY, 30e18, 400);
        _bid(id, BEN, 50e18, 300);
        _settle(id);
        vm.prank(address(dao));
        shares.clearExitExchange();
        vm.prank(address(dao));
        shares.announceExitExchange(address(rounds));
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        rounds.claim(id, BEN);
        rounds.claim(id, CY);
        assertEq(shares.balanceOf(BEN), 50e18);
        assertEq(shares.balanceOf(CY), 30e18);
    }

    function test_mid_bidding_seller_cannot_cancel_back_to_shares() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, CY, 30e18, 400);
        vm.prank(address(dao));
        shares.clearExitExchange();
        vm.prank(CY);
        vm.expectRevert();
        rounds.cancelSell(id, new address[](0));
    }
}
