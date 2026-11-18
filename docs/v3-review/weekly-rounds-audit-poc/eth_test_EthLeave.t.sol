// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";

contract EthLeaveTest is WeeklyRoundsTest {
    function test_poc_eth_left_behind_when_exchange_cleared() public {
        vm.deal(address(dao), 1 ether);
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 50e18, 10);
        vm.prank(address(dao));
        shares.clearExitExchange();
        _settle(id);
        // claim (taking Shares) is impossible now
        vm.expectRevert();
        rounds.claim(id, BEN);
        // ETH cannot be named
        address[] memory t = new address[](2);
        t[0] = address(0); t[1] = address(usd);
        vm.prank(BEN);
        vm.expectRevert(abi.encodeWithSelector(WeeklyRounds.BadToken.selector, address(0)));
        rounds.claimAndLeave(id, t);
        // only route: leave with USDC only
        vm.prank(BEN);
        rounds.claimAndLeave(id, _leaveWithUsd());
        assertEq(BEN.balance, 0, "Ben got no ETH");
        assertEq(address(dao).balance, 1 ether, "Ben's 0.25 ETH stays in the DAO");
        assertEq(shares.balanceOf(BEN), 0);
        // contrast: Ana (holding Shares directly) can ragequit with ETH
        address[] memory t2 = new address[](2); t2[0] = address(0); t2[1] = address(usd);
        uint256 cyBal = shares.balanceOf(CY);
        vm.prank(CY);
        dao.ragequit(t2, cyBal, 0);
        emit log_named_uint("CY eth", CY.balance);
        assertGt(CY.balance, 0);
    }
}
