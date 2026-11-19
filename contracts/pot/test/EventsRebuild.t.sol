// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {StackBase} from "./helpers/StackBase.sol";
import {PotHandler} from "./helpers/PotHandler.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";

/// @notice The recipe a server follows to rebuild a project from its logs alone, run as a test: a ledger reads only the events
/// of the Treasury and the Vester, in order, and after every step of a long mixed run (joins, take-outs, Team take-outs,
/// outside payments, grants, forfeits, vesting, draws, rate changes, check-ins, lapses, a wind-down) it must hold the very
/// numbers the contracts hold: pot, paid-in, Shares, Team Shares, the burn queue, the allowance box, outside money arriving,
/// active seconds and fees owed.
contract EventsRebuildTest is StackBase {
    // ---- the ledger: what a server rebuilds from logs
    uint256 internal lPot;
    uint256 internal lPaidIn;
    uint256 internal lShares;
    uint256 internal lTeam;
    uint256 internal lZ;
    uint256 internal lBox;
    uint256 internal lArriving;
    uint256 internal lActive;
    uint256 internal lFees;
    uint256 internal eventsRead;

    function _word(bytes memory d, uint256 i) internal pure returns (uint256 r) {
        assembly {
            r := mload(add(d, add(32, mul(32, i))))
        }
    }

    function _apply(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            bytes32 sig = logs[i].topics[0];
            bytes memory d = logs[i].data;
            if (logs[i].emitter == address(t)) {
                if (sig == Treasury.Joined.selector) {
                    (lFees, lPot, lPaidIn, lShares) = (lFees + _word(d, 1), _word(d, 4), _word(d, 5), _word(d, 6));
                } else if (sig == Treasury.Left.selector) {
                    (lPot, lPaidIn, lShares) = (_word(d, 3), _word(d, 4), _word(d, 5));
                } else if (sig == Treasury.TeamLeft.selector) {
                    (lPot, lTeam) = (_word(d, 3), _word(d, 4));
                } else if (sig == Treasury.AllowanceDrawn.selector) {
                    lBox = _word(d, 1);
                } else if (sig == Treasury.Settled.selector) {
                    (lPot, lBox, lArriving, lActive) = (_word(d, 3), _word(d, 4), _word(d, 5), _word(d, 6));
                } else if (sig == Treasury.RevenueAdded.selector) {
                    lArriving = _word(d, 1);
                } else if (sig == Treasury.RevenueReleased.selector) {
                    lArriving = _word(d, 1);
                } else if (sig == Treasury.WoundDown.selector) {
                    (lPot, lBox) = (lPot + _word(d, 2), 0);
                } else if (sig == Treasury.FeesCollected.selector) {
                    lFees -= _word(d, 0);
                } else if (sig == Treasury.BurnAnnounced.selector) {
                    lZ = _word(d, 1);
                } else {
                    continue;
                }
                ++eventsRead;
            } else if (logs[i].emitter == address(v)) {
                if (sig == Vester.ForfeitAnnounced.selector) {
                    lZ = _word(d, 3);
                } else if (sig == Vester.Forfeited.selector) {
                    (lZ, lTeam) = (_word(d, 1), _word(d, 2));
                } else if (sig == Vester.UngrantedBurned.selector) {
                    lTeam = _word(d, 1);
                } else {
                    continue;
                }
                ++eventsRead;
            }
        }
    }

    function _same(string memory step) internal view {
        assertEq(lPot, t.pot(), string.concat(step, ": pot"));
        assertEq(lPaidIn, t.paidIn(), string.concat(step, ": paid-in"));
        assertEq(lShares, shares.totalSupply(), string.concat(step, ": Shares"));
        assertEq(lTeam, team.totalSupply(), string.concat(step, ": Team Shares"));
        assertEq(lZ, t.Z(), string.concat(step, ": burn queue"));
        assertEq(lBox, t.box(), string.concat(step, ": box"));
        assertEq(lArriving, t.arriving(), string.concat(step, ": arriving"));
        assertEq(lActive, t.activeSeconds(), string.concat(step, ": active seconds"));
        assertEq(lFees, t.feesOwed(), string.concat(step, ": fees owed"));
    }

    function _check(string memory step) internal {
        t.settle(); // anyone may; it is what a server's own poke would be, and its Settled event is read like any other
        _apply(vm.getRecordedLogs());
        _same(step);
    }

    function test_aLedgerOfEventsAloneRebuildsTheProjectStepByStep() public {
        // the Team pool was minted at birth: a server reads it from ProjectLaunched
        lTeam = POOL;
        vm.recordLogs();
        PotHandler h = new PotHandler(usd, t, shares, team, v, founder, POOL);
        vm.getRecordedLogs(); // the handler's agent set-up is not part of the run
        uint256 seed = 0xC0FFEE;
        for (uint256 i; i < 400; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            try h.step(seed, false) {} catch {}
            _check(string.concat("step ", vm.toString(i)));
        }
        assertGt(eventsRead, 300, "the run produced events");
        assertGt(lShares, 0, "there were backers");
        // the end of the project: a wind-down by choice, a notice of one time unit, the rest of the Team pool burns
        vm.prank(founder);
        t.windDown();
        _check("wind-down");
        vm.warp(block.timestamp + UNIT + 1);
        try v.burnUngrantedAfterWindDown() {} catch {}
        _check("burn after wind-down");
        assertEq(lBox, 0, "the box went back to the pot");
        emit log_named_uint("events read by the ledger", eventsRead);
    }
}
