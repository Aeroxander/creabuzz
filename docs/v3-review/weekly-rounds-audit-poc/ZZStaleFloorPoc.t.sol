// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";
import {console2} from "forge-std/console2.sol";
contract ZZStaleFloorPoc is WeeklyRoundsTest {
    function test_poc_stale_floor() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 2);
        usd.mint(address(dao), 200 * USD);
        console2.log("floor now", rounds.floorOf(address(dao)));
        _bid(id, BEN, 50e18, 2);
        _settle(id);
        rounds.claim(id, ANA);
        console2.log("ANA receives", usd.balanceOf(ANA));
        uint256 before = usd.balanceOf(BEN);
        vm.prank(BEN);
        rounds.claimAndLeave(id, _leaveWithUsd());
        console2.log("BEN paid", 1000 * USD - before, "net after leave", usd.balanceOf(BEN) - before);
    }
}
