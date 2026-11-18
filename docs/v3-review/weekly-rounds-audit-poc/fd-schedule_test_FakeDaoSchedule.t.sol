// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";

contract DummyToken {
    function totalSupply() external pure returns (uint256) { return 0; }
    function balanceOf(address) external pure returns (uint256) { return 0; }
}

contract FakeDao2 {
    address public shares;
    address public loot;
    address public payouts;
    constructor(address s) { shares = s; loot = address(new DummyToken()); }
}

contract FakeDaoScheduleTest is WeeklyRoundsTest {
    function test_fake_dao_round_moves_locked_shares_any_time_no_floor_no_cut_to_treasury() public {
        // Real DAO opens its weekly round: next one is a week away.
        uint256 real = rounds.open(address(dao));
        assertGt(real, 0);
        // Shares are locked: a direct transfer fails.
        vm.prank(ANA);
        vm.expectRevert();
        shares.transfer(BEN, 1e18);

        uint256 treasuryBefore = usd.balanceOf(address(dao));
        FakeDao2 fake = new FakeDao2(address(shares));
        uint256 id = rounds.open(address(fake)); // same block as the real round: schedule ignored
        assertEq(rounds.floorOf(address(fake)), 0, "floor 0, not 1.00");
        assertEq(rounds.priceAt(id, 0), 0);
        assertEq(rounds.priceAt(id, 1), 1e4, "one minStep: 0.01 USDC per whole Share");
        _sell(id, ANA, 50e18, 0);
        _bid(id, BEN, 50e18, 1);
        _settle(id);
        rounds.claim(id, ANA);
        rounds.claim(id, BEN);
        assertEq(shares.balanceOf(BEN), 50e18, "50 locked Shares moved ANA -> BEN");
        // BEN paid 0.50 USDC total for 50 Shares whose exit value is 50 USDC; cut 0.10 went to the fake DAO.
        assertEq(usd.balanceOf(BEN), 1_000 * USD - 50e4 * 50 / 50, "paid 0.50");
        assertEq(usd.balanceOf(address(fake)), 1e5, "the cut (0.10) went to the fake DAO");
        assertEq(usd.balanceOf(address(dao)), treasuryBefore, "the real treasury got nothing");
        // And again immediately with another fake DAO.
        FakeDao2 fake2 = new FakeDao2(address(shares));
        rounds.open(address(fake2));
    }
}
