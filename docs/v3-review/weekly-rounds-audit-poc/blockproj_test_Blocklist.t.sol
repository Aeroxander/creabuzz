// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";

contract BlocklistTest is WeeklyRoundsTest {
    function test_blocklisted_dao_strands_seller_with_cut() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 30e18, 30);
        _bid(id, DEE, 30e18, 30);
        _settle(id);
        // USDC blocklists the DAO: any transfer to it reverts.
        vm.mockCallRevert(address(usd), abi.encodeWithSelector(IERC20.transfer.selector, address(dao)), "blocked");
        vm.expectRevert();
        rounds.claim(id, ANA);
        vm.prank(ANA);
        vm.expectRevert();
        rounds.claimAndLeave(id, _leaveWithUsd());
        // buyers are unaffected
        rounds.claim(id, BEN);
        rounds.claim(id, DEE);
        assertEq(shares.balanceOf(BEN), 25e18);
        // lift the blocklist: seller recovers in full
        vm.clearMockedCalls();
        rounds.claim(id, ANA);
        assertEq(usd.balanceOf(ANA), 62 * USD);
    }

    function test_seller_at_floor_has_no_cut_and_is_not_blocked() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 50e18, 0);
        _settle(id);
        vm.mockCallRevert(address(usd), abi.encodeWithSelector(IERC20.transfer.selector, address(dao)), "blocked");
        rounds.claim(id, ANA);
        assertEq(usd.balanceOf(ANA), 50 * USD);
    }
}
