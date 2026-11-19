// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PotBase} from "./helpers/PotBase.sol";
import {PotMath} from "../src/PotMath.sol";

/// @notice The worked numbers of JOIN-LEAVE-DESIGN.md sections 2.1 and 2.2, and the later-joins count of 2.1.3.
contract WorkedTest is PotBase {
    /// @dev Section 2.1: pot 83,500, paid-in 98,000, 9.8M backer Shares, 10M Team Shares.
    function test_worked_2_1_quote() public {
        t.forceShares(carol, 9_800_000e18);
        _force(83_500e6, 98_000e6, 0, 0, 0);
        assertEq(team.totalSupply(), 10_000_000e18);
        assertEq(t.leaveValue(), 8_520, "0.008520 a Share");
        uint256 holdersBefore = PotMath.cash(9_800_000e18, t.pot(), t.paidIn(), shares.totalSupply(), POOL);

        (uint256 quoted, uint256 takeOutNow,,) = t.quoteBack(100e6);
        uint256 n = _join(alice, 100e6);
        assertEq(n, quoted);
        // the text rounds 11,501.78 to 11,502
        assertApproxEqAbs(n, 11_501.78e18, 0.01e18, "about 11,502 Shares for 100");
        assertEq(t.feesOwed(), 2e6, "platform 2");
        assertEq(t.pot(), 83_500e6 + 98e6, "98 into the pot");

        uint256 got = _leave(alice, n);
        assertEq(got, takeOutNow);
        assertApproxEqAbs(got, 98e6, 2_000, "taking out at once gives 98.00 (97.9998)");
        assertLe(got, 98e6 + 2_000);

        uint256 holdersAfter = PotMath.cash(9_800_000e18, t.pot(), t.paidIn(), shares.totalSupply(), POOL);
        assertApproxEqAbs(holdersAfter, holdersBefore, 2_000, "earlier holders change by 0.0000");
        assertGe(holdersAfter + 2, holdersBefore, "and not for the worse");
    }

    /// @dev Section 2.2: pot 120,000, paid-in 98,000, 9.8M backer and 10M Team Shares.
    function test_worked_2_2_leave() public {
        t.forceShares(carol, 9_800_000e18);
        _force(120_000e6, 98_000e6, 0, 0, 0);
        vm.prank(carol);
        uint256 backer = t.leave(1_000_000e18, 0, carol);
        assertEq(backer, 11_111_111_111, "1,000,000 backer Shares leave with 11,111.111111");
    }

    function test_worked_2_2_teamLeave() public {
        t.forceShares(carol, 9_800_000e18);
        _force(120_000e6, 98_000e6, 0, 0, 0);
        vm.prank(address(vester));
        team.transfer(bob, 1_000_000e18);
        vm.prank(bob);
        assertEq(t.leaveTeam(1_000_000e18, 0, bob), 1_111_111_111, "1,000,000 Team Shares leave with 1,111.111111");
    }

    /// @dev Section 2.1 step 3 and must-bind 7: a first join of 10,000, then 200 joins of 500, the whole Team pool
    /// vested and leaving: the Team gets nothing and the backers get 98.00 per 100 paid.
    function test_worked_laterJoinsGiveTheTeamNothing() public {
        uint256 first = _join(alice, 10_000e6);
        uint256 bobShares;
        for (uint256 i; i < 200; ++i) {
            bobShares += _join(address(uint160(0x2000 + i)), 500e6);
        }
        // the team side asks for its whole pool
        uint256 teamClaim = PotMath.teamCash(POOL, t.pot(), t.paidIn(), shares.totalSupply(), POOL);
        assertEq(teamClaim, 0, "later joins give the Team nothing");
        // backers: everyone out; 98.00 per 100 paid in total
        uint256 total = _leave(alice, first);
        for (uint256 i; i < 200; ++i) {
            address a = address(uint160(0x2000 + i));
            total += _leave(a, shares.balanceOf(a));
        }
        uint256 paid = 10_000e6 + 200 * 500e6;
        assertApproxEqAbs(total, paid * 98 / 100, 20e6, "98.00 per 100 paid");
        assertLe(total, paid * 98 / 100 + 20e6);
    }
}
