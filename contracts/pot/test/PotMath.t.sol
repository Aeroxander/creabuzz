// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PotMath} from "../src/PotMath.sol";

contract PotMathTest is Test {
    function test_feeRoundsUp() public pure {
        assertEq(PotMath.fee(100e6, 200), 2e6);
        assertEq(PotMath.fee(1_000_001, 200), 20_001); // 20,000.02 rounds up by 0.98 of a unit
        assertEq(PotMath.fee(1e6, 0), 0);
    }

    function testFuzz_feeIsWithinOneUnitAboveExact(uint256 a, uint256 bps) public pure {
        a = bound(a, 1, 1e18);
        bps = bound(bps, 0, 500);
        uint256 f = PotMath.fee(a, bps);
        uint256 floorFee = a * bps / 10_000;
        assertGe(f, floorFee);
        assertLe(f - floorFee, 1);
        assertLe(f, a);
    }

    function test_quoteNumeratorIsNeverZero() public pure {
        (uint256 num, uint256 den) = PotMath.quote(0, 0, 0, 0, 0);
        assertGt(num, 0);
        assertGt(den, 0);
        (num, den) = PotMath.quote(0, 0, 0, 0, 10_000_000e18);
        assertGt(num, 0);
    }

    function test_firstJoinPricesOneCentForAnyTeamPool() public pure {
        uint256[3] memory pools = [uint256(0), 10_000_000e18, 100_000_000e18];
        for (uint256 i; i < 3; ++i) {
            (uint256 num, uint256 den) = PotMath.quote(0, 0, 0, 0, pools[i]);
            assertEq(PotMath.sharesFor(98e6, num, den), 98e6 * 1e14); // 0.01 a Share: 9,800 Shares for 98 dollars
        }
    }

    function test_noOverflowAtTheLimits() public pure {
        // B 1e30, pool 1e26, pot 1e16 dollar units (ten billion dollars)
        (uint256 num, uint256 den) = PotMath.quote(1e16, 1e16, 1e16, 1e30, 1e26);
        assertGt(PotMath.sharesFor(1e16, num, den), 0);
        assertGt(PotMath.cash(1e29, 1e16, 1e16, 1e30, 1e26), 0);
        assertGt(PotMath.teamCash(1e25, 2e16, 1e16, 1e30, 1e26), 0);
        assertEq(PotMath.credit(1e16, 1e29, 1e16, 1e30, 0, 0, 0), 1e15);
    }

    function testFuzz_payoutsNeverExceedThePot(uint256 pot, uint256 paid, uint256 b, uint256 g, uint256 nb, uint256 ng)
        public
        pure
    {
        pot = bound(pot, 0, 1e16);
        paid = bound(paid, 0, 1e16);
        b = bound(b, 1, 1e30);
        g = bound(g, 0, 1e26);
        nb = bound(nb, 0, b);
        ng = bound(ng, 0, g);
        uint256 backers = PotMath.cash(b, pot, paid, b, g);
        uint256 teams = PotMath.teamCash(g, pot, paid, b, g);
        assertLe(backers + teams, pot, "all Shares together are paid no more than the pot");
        assertLe(PotMath.cash(nb, pot, paid, b, g), backers);
        assertLe(PotMath.teamCash(ng, pot, paid, b, g), teams);
    }

    function testFuzz_creditNeverAboveThePayment(uint256 m, uint256 n, uint256 a, uint256 b) public pure {
        m = bound(m, 1, 1e16);
        b = bound(b, 1, 1e30);
        n = bound(n, 1, 1e30);
        a = bound(a, 0, 1e16);
        assertLe(PotMath.credit(m, n, a, b, 0, 0, 0), m);
        assertEq(PotMath.credit(m, n, a, 0, 0, 0, 0), m);
    }

    function testFuzz_paidInCutRoundsDownSoPaidInRoundsUp(uint256 a, uint256 n, uint256 b) public pure {
        a = bound(a, 0, 1e16);
        b = bound(b, 1, 1e30);
        n = bound(n, 0, b);
        uint256 cut = PotMath.paidInCut(a, n, b);
        assertLe(cut, a);
        assertLe(cut * b, a * n); // never more than the exact share
        if (n == b) assertEq(cut, a); // the last leaver clears paid-in
    }
}
