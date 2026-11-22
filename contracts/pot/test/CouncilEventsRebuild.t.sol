// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Council} from "../src/Council.sol";
import {CouncilHandler} from "./helpers/CouncilHandler.sol";

/// @notice A ledger that sees only the Council's events (never a view) rebuilds the seats, the generation, the date of the
/// next election and how many seats have agreed to every pending call, over 400 random steps that include withdrawals,
/// resignations and elections. A reader that follows the Council from its logs needs no more than this.
contract CouncilEventsRebuildTest is Test {
    CouncilHandler internal h;
    Council internal c;
    // the ledger
    address[5] internal lSeats;
    uint64[5] internal lSeatedAt;
    uint32 internal lGeneration;
    uint64 internal lNext;
    mapping(bytes32 => uint8) internal lCount;
    uint256 internal lExecuted;

    function _feed(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(c)) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == Council.Proposed.selector) {
                lCount[logs[i].topics[1]] = 1;
            } else if (t0 == Council.Agreed.selector) {
                lCount[logs[i].topics[1]] = abi.decode(logs[i].data, (uint8));
            } else if (t0 == Council.Withdrawn.selector) {
                lCount[logs[i].topics[1]] = abi.decode(logs[i].data, (uint8));
            } else if (t0 == Council.Executed.selector || t0 == Council.Cancelled.selector) {
                lCount[logs[i].topics[1]] = 0;
                if (t0 == Council.Executed.selector) ++lExecuted;
            } else if (t0 == Council.SeatsSet.selector) {
                (lSeats, lSeatedAt, lGeneration, lNext) =
                    abi.decode(logs[i].data, (address[5], uint64[5], uint32, uint64));
            }
        }
    }

    function _compare(uint256 step) internal view {
        (address[5] memory s, uint64[5] memory at) = c.seatList();
        for (uint256 i; i < 5; ++i) {
            assertEq(lSeats[i], s[i], string.concat("seat after step ", vm.toString(step)));
            assertEq(lSeatedAt[i], at[i]);
        }
        assertEq(lGeneration, c.generation(), "generation");
        assertEq(lNext, c.nextElection(), "next election");
        for (uint256 i; i < h.pendCount(); ++i) {
            (bytes32 id,,) = h.pendAt(i);
            assertEq(lCount[id], c.agreedCount(id), "agreement count");
        }
        assertEq(lExecuted, h.ghostExecuted(), "executions");
    }

    /// forge-config: default.fuzz.runs = 150
    function testFuzz_theEventsAloneRebuildTheCouncil(uint256 seed) public {
        Council impl = new Council();
        vm.recordLogs();
        h = new CouncilHandler(impl, address(0xA11CE), 1_700_000_000);
        c = h.c();
        _feed(vm.getRecordedLogs()); // the birth: its SeatsSet is the first thing the ledger sees
        _compare(0);
        for (uint256 step; step < 400; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 pick = seed % 10;
            uint256 r = seed >> 8;
            if (pick < 3) h.propose(r);
            else if (pick < 6) h.agree(r, r >> 16);
            else if (pick == 6) h.withdraw(r, r >> 16);
            else if (pick == 7) h.resign(r);
            else if (pick == 8) h.election(r, (r >> 20) % 3 == 0);
            else h.pass(r);
            _feed(vm.getRecordedLogs());
            _compare(step);
        }
    }
}
