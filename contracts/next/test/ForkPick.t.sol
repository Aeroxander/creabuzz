// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ForkPick} from "./helpers/ForkPick.sol";

/// @notice What the Sepolia fork suites do with the node they are given. Each case is a way a run on another machine
/// or in CI really failed before (see M1-REPORT.md, "Fix round"): a node that cannot serve the pinned block, or one that
/// does not answer. Local: no network is needed.
contract ForkPickTest is Test {
    uint256 internal constant PIN = 12_146_937;
    uint256 internal constant HEAD = 12_200_000;

    function test_aDeadNodeSkipsEvenWhenTheCacheIsTrusted() public pure {
        // Before: createSelectFork reverted inside setUp ("could not instantiate forked environment").
        ForkPick.Plan memory p = ForkPick.decide(false, 0, 0, PIN, false, true);
        assertTrue(p.skip, "skipped");
        assertGt(bytes(p.message).length, 0, "says why");
    }

    function test_aServedPinIsUsed() public pure {
        ForkPick.Plan memory p = ForkPick.decide(true, HEAD, 0, PIN, true, false);
        assertFalse(p.skip);
        assertEq(p.blockNumber, PIN);
        assertEq(bytes(p.message).length, 0, "nothing to say");
    }

    function test_anUnservedPinMovesToARecentBlockWithAMessage() public pure {
        // Before: the pin was forked anyway and setUp died with "Archive requests require a personal token".
        ForkPick.Plan memory p = ForkPick.decide(true, HEAD, 0, PIN, false, false);
        assertFalse(p.skip, "the suites still run");
        assertEq(p.blockNumber, HEAD - ForkPick.RECENT_LAG, "a block just behind the head");
        assertGt(bytes(p.message).length, 0, "says the block is not the pin");
    }

    function test_aNamedBlockTheNodeCannotServeSkipsWithAMessage() public pure {
        // Before: SEPOLIA_FORK_BLOCK=12140000 against the public node failed in setUp.
        ForkPick.Plan memory p = ForkPick.decide(true, HEAD, 12_140_000, PIN, false, false);
        assertTrue(p.skip, "skipped, not failed");
        assertGt(bytes(p.message).length, 0);
    }

    function test_aNamedBlockTheNodeServesIsUsed() public pure {
        ForkPick.Plan memory p = ForkPick.decide(true, HEAD, HEAD - 5, PIN, true, false);
        assertFalse(p.skip);
        assertEq(p.blockNumber, HEAD - 5);
    }

    function test_trustingTheCacheForksTheUnservedPin() public pure {
        // The one machine whose Foundry cache holds the pin asks for it by saying so.
        ForkPick.Plan memory p = ForkPick.decide(true, HEAD, 0, PIN, false, true);
        assertFalse(p.skip);
        assertEq(p.blockNumber, PIN);
        ForkPick.Plan memory q = ForkPick.decide(true, HEAD, 12_140_000, PIN, false, true);
        assertFalse(q.skip);
        assertEq(q.blockNumber, 12_140_000);
    }
}
