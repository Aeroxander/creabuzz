// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WeeklyRounds} from "../src/WeeklyRounds.sol";
import {MandateCurrency} from "./TreasuryMandate.t.sol";
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";

contract DummyLoot {
    function totalSupply() external pure returns (uint256) { return 0; }
    function balanceOf(address) external pure returns (uint256) { return 0; }
}

contract FakeDao2 {
    address public shares;
    address public loot;
    constructor(address s) { shares = s; loot = address(new DummyLoot()); }
    function payouts() external pure returns (address) { return address(0); }
    function sweep(IERC20 t, address to) external { t.transfer(to, t.balanceOf(address(this))); }
}

contract FakeDaoRoundTest is WeeklyRoundsTest {
    function test_fake_dao_round_moves_locked_shares_anytime_cut_to_fake() public {
        // the real DAO's weekly round is opened today, so the real schedule is used up
        uint256 real = rounds.open(address(dao));
        assertGt(real, 0);
        // locked: a plain transfer fails
        vm.prank(ANA);
        vm.expectRevert();
        shares.transfer(BEN, 1e18);

        uint256 daoUsdBefore = usd.balanceOf(address(dao));
        uint256 realFloor = rounds.floorOf(address(dao));
        for (uint256 k; k < 3; ++k) {
            FakeDao2 fake = new FakeDao2(address(shares));
            uint256 id = rounds.open(address(fake)); // same day as the real round, three times
            assertEq(rounds.priceAt(id, 0), 0, "floor zero");
            _sell(id, ANA, 10e18, 0);
            _bid(id, BEN, 10e18, 100);
            _settle(id);
            rounds.claim(id, ANA);
            rounds.claim(id, BEN);
            emit log_named_uint("price per unit", rounds.priceAt(id, 100));
            emit log_named_uint("cut to fake dao", usd.balanceOf(address(fake)));
            assertGt(usd.balanceOf(address(fake)), 0);
        }
        assertEq(shares.balanceOf(BEN), 30e18, "30 locked Shares moved ANA -> BEN");
        assertEq(usd.balanceOf(address(dao)), daoUsdBefore, "real treasury got no cut");
        emit log_named_uint("real floor per unit", realFloor);
        emit log_named_uint("BEN paid total", 1_000 * USD - usd.balanceOf(BEN));
    }
}
