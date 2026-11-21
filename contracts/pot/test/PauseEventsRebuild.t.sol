// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {PauseBase} from "./helpers/PauseBase.sol";
import {PauseHandler} from "./helpers/PauseHandler.sol";

/// @notice The pause's events carry what a reader needs: a ledger built from `Parked`, `Unparked` and `Observed` alone holds,
/// after every one of 400 random steps, the same parked total, the same amount for every holder and the same `armedAt` as
/// the contract. (Joins are steps too: the Treasury's poke after a mint changes `armedAt` through `Observed`.)
contract PauseEventsRebuildTest is PauseBase {
    uint256 internal ledgerTotal;
    uint64 internal ledgerArmed;
    mapping(address => uint256) internal ledgerOf;

    function _apply(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pause)) continue;
            bytes32 sig = logs[i].topics[0];
            if (sig == HolderPause.Parked.selector || sig == HolderPause.Unparked.selector) {
                address who = address(uint160(uint256(logs[i].topics[1])));
                (, uint256 by, uint256 total,, uint64 armed) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint64));
                ledgerOf[who] = by;
                ledgerTotal = total;
                ledgerArmed = armed;
            } else if (sig == HolderPause.Observed.selector) {
                (uint256 total,, uint64 armed) = abi.decode(logs[i].data, (uint256, uint256, uint64));
                ledgerTotal = total;
                ledgerArmed = armed;
            }
        }
    }

    function testFuzz_aLedgerOfTheEventsHoldsTheSameParkedAmountsAndClock(uint256 seed) public {
        PauseHandler h = new PauseHandler(usd, t, shares, pause, founder);
        address[] memory who = h.actorsList();
        uint256 x = uint256(keccak256(abi.encode(seed)));
        for (uint256 step; step < 400; ++step) {
            x = uint256(keccak256(abi.encode(x, step)));
            uint256 a = x >> 128;
            uint256 b = uint256(uint128(x));
            uint256 kind = x % 12;
            vm.recordLogs();
            if (kind <= 1) h.join(a, b);
            else if (kind == 2) h.leave(a, b);
            else if (kind == 3) h.park(a, b);
            else if (kind == 4 || kind == 5) h.parkToLine(a);
            else if (kind == 6) h.unpark(a, b);
            else if (kind == 7) h.poke();
            else if (kind == 8 || kind == 9) h.warp(a, b);
            else if (kind == 10) h.draw(a);
            else h.announce(a);
            _apply(vm.getRecordedLogs());
            assertEq(ledgerTotal, pause.parkedTotal(), "parked total");
            assertEq(ledgerArmed, pause.armedAt(), "armedAt");
            for (uint256 i; i < who.length; ++i) {
                assertEq(ledgerOf[who[i]], pause.parkedOf(who[i]), "per holder");
            }
        }
        assertEq(bytes(h.violation()).length, 0, h.violation());
    }
}
