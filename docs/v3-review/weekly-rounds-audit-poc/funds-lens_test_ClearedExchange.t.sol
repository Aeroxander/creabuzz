// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";

contract ClearedExchangeTest is VotingFixture {
    address internal constant BEN = address(0xBE4);
    uint256 internal constant USD = 1e6;
    MandateCurrency internal usd;
    WeeklyRounds internal rounds;

    function setUp() public override {
        super.setUp();
        usd = new MandateCurrency();
        usd.mint(address(dao), 200 * USD);
        rounds = new WeeklyRounds(IERC20(address(usd)), 1e4);
        vm.startPrank(address(dao));
        shares.setIssuanceRule(type(uint16).max);
        shares.lockTransfersWithNotice(address(0));
        shares.setLockGuard(address(0));
        shares.announceExitExchange(address(rounds));
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        usd.mint(BEN, 1_000 * USD);
        vm.prank(BEN);
        usd.approve(address(rounds), type(uint256).max);
    }

    function _settled() internal returns (uint256 id) {
        id = rounds.open(address(dao));
        vm.prank(ALICE);
        shares.approve(address(rounds), 50e18);
        vm.prank(ALICE);
        rounds.sell(id, 50e18, 0);
        vm.prank(BEN);
        rounds.bid(id, 20e18, 0);
        (,,, uint64 closesAt,,,,,,,,,,,,,,) = rounds.rounds(id);
        vm.warp(closesAt);
        (uint256 step,,) = rounds.clearingStep(id);
        rounds.settle(id, step);
    }

    function test_partly_filled_seller_money_stuck_with_locked_reason() public {
        uint256 id = _settled();
        uint256 held = usd.balanceOf(address(rounds));
        emit log_named_uint("usd held for round", held);
        vm.prank(address(dao));
        shares.clearExitExchange();
        vm.expectRevert(bytes4(keccak256("Locked()")));
        rounds.claim(id, ALICE);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        rounds.claim(id, BEN);
        assertEq(usd.balanceOf(ALICE), 0);
    }

    function test_recoverable_only_by_dao_renaming_30_days_later() public {
        uint256 id = _settled();
        vm.prank(address(dao));
        shares.clearExitExchange();
        vm.prank(address(dao));
        shares.announceExitExchange(address(rounds));
        vm.warp(block.timestamp + 30 days);
        shares.activateExitExchange();
        rounds.claim(id, ALICE);
        rounds.claim(id, BEN);
        emit log_named_uint("alice usd", usd.balanceOf(ALICE));
        emit log_named_uint("alice shares back", shares.balanceOf(ALICE));
        emit log_named_uint("ben shares", shares.balanceOf(BEN));
    }
}
