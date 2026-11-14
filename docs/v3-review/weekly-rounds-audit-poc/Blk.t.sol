// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {WeeklyRoundsTest} from "../WeeklyRounds.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract BlkTest is WeeklyRoundsTest {
    function test_blk_dao_blocks_seller_claim() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 30e18, 30);
        _bid(id, DEE, 30e18, 30);
        _settle(id);
        // simulate USDC blocklisting the DAO: any transfer(dao, *) reverts
        vm.mockCallRevert(address(usd), abi.encodeWithSelector(IERC20.transfer.selector, address(dao)), "blocked");
        vm.expectRevert();
        rounds.claim(id, ANA);
        // buyers unaffected
        rounds.claim(id, BEN);
        rounds.claim(id, DEE);
        // ANA cannot even leave
        vm.prank(ANA);
        vm.expectRevert();
        rounds.claimAndLeave(id, _leaveWithUsd());
        assertEq(usd.balanceOf(ANA), 0);
        vm.clearMockedCalls();
        rounds.claim(id, ANA);
        assertEq(usd.balanceOf(ANA), 62 * 1e6);
    }
}
