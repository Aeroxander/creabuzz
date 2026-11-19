// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {PotHandler} from "./helpers/PotHandler.sol";
import {PotMath} from "../src/PotMath.sol";

/// @notice Fuzz tests that need no handler state: the formulas against a plain reference where the plain reference cannot
/// overflow, a round trip through the real stack from a random state, and random sequences of every kind of step with the
/// handler's own rules and the dollar sums checked after each.
contract PotFuzzTest is StackBase {
    /// @dev `PotMath` uses 512-bit division; where `n x a` fits in 256 bits a plain `n * a / b` must give the same number.
    function testFuzz_theFormulasEqualAPlainReferenceWhereItCannotOverflow(
        uint256 n,
        uint256 pot,
        uint256 paidIn,
        uint256 b,
        uint256 g
    ) public pure {
        n = bound(n, 1, 1e30);
        pot = bound(pot, 0, 1e16);
        paidIn = bound(paidIn, 0, 1e16);
        b = bound(b, n, 1e30);
        g = bound(g, 0, 1e27);
        uint256 a1 = pot < paidIn ? pot : paidIn;
        uint256 s = pot - a1;
        assertEq(PotMath.cash(n, pot, paidIn, b, g), n * a1 / b + n * s / (b + g), "cash");
        assertEq(PotMath.teamCash(n, pot, paidIn, b, g), n * s / (b + g), "team cash");
        assertEq(PotMath.paidInCut(paidIn, n, b), paidIn * n / b, "cut");
        (uint256 num, uint256 den) = PotMath.quote(pot, 0, paidIn, b, g);
        uint256 m = bound(n, 1, 1e12);
        assertEq(PotMath.sharesFor(m, num, den), m * den / num, "shares");
    }

    /// @dev From a state built by a few random joins and a spend, a stranger who joins and leaves in the same second is paid no
    /// more than they put in after the fee, less the offset's give-away (100 Shares at the old value, less one dollar).
    function testFuzz_joinThenLeaveNeverNetsMoreThanPaidMinusTheFee(uint256 seed, uint256 amount) public {
        for (uint256 i; i < 4; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            _join(address(uint160(0xA000 + i)), bound(seed, 1e6, 500_000e6));
        }
        if (seed % 3 == 0) _revenue(carol, bound(seed >> 8, 1e6, 100_000e6));
        vm.warp(block.timestamp + (seed >> 16) % 6 days);
        _checkIn();
        t.settle();
        amount = bound(amount, 1e6, 2_000_000e6);
        uint256 hundred = t.leaveValue() * 100;
        uint256 give = hundred > 1e6 ? hundred - 1e6 : 0;
        uint256 n = _join(stranger, amount);
        uint256 cash = _leave(stranger, n);
        assertLe(cash, amount - t.feeFor(amount) + give + 50, "nothing is made by joining and leaving at once");
        _assertConserved();
    }

    /// @dev The handler's task steps are reached in a long run: announced, taken (and blocked), paid in full and in part,
    /// rejected, cancelled, ended by time, and their exit notes claimed. Without this a green run could be a run that never
    /// took a task.
    function test_theHandlerWalksEveryKindOfTaskStep() public {
        PotHandler h = new PotHandler(usd, t, shares, team, v, founder, POOL);
        uint256 seed = 0x7A5C;
        for (uint256 i; i < 2500; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            try h.step(seed, false) {} catch {}
            assertEq(h.violation(), "", "a step broke a rule");
        }
        bytes32[8] memory kinds =
            [bytes32("announce"), "take", "acceptFull", "acceptPart", "reject", "cancel", "claimNote", "advanceToTask"];
        for (uint256 i; i < kinds.length; ++i) {
            assertGt(h.count(kinds[i]), 0, string(abi.encodePacked("the run never made a ", kinds[i], " step")));
            emit log_named_uint(string(abi.encodePacked(kinds[i])), h.count(kinds[i]));
        }
        assertGt(h.workerPaid(), 0, "a worker was paid");
        assertGt(h.notesPaid(), 0, "a note was paid");
    }

    /// @dev Random sequences of every kind of step (the handler's own), with the handler's rules and the exact dollar sums.
    /// forge-config: default.fuzz.runs = 40
    function testFuzz_randomSequencesKeepEveryRule(uint256 seed) public {
        PotHandler h = new PotHandler(usd, t, shares, team, v, founder, POOL);
        for (uint256 i; i < 120; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            try h.step(seed, true) {} catch {}
            assertEq(h.violation(), "", "a step broke a rule");
            assertEq(usd.balanceOf(address(t)), h.cashIn() - h.cashOut(), "balance is dollars in less dollars out");
            _assertConserved();
        }
    }
}
