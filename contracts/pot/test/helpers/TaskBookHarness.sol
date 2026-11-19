// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TaskBook} from "../../src/TaskBook.sol";

/// @notice The production TaskBook plus functions that set its state directly, for what the pass that mints exit notes will
/// make through a real leave: a note against a task, and a ring of takes in any state. Every production function is untouched.
contract TaskBookHarness is TaskBook {
    /// @dev Move `part` of a taken task's stayer claim into a note held by `holder` (what a leave does). The Treasury's own
    /// buckets must be moved to match (`TreasuryHarness.forceNote`).
    function forceNote(uint64 serial, address holder, uint256 part) external {
        Task storage k = _task[serial];
        k.stayer -= uint128(part);
        k.noteFace += uint128(part);
        noteOf[serial][holder] += part;
    }

    /// @dev Put a take of `bps` at time `at` into ring slot `i`, and point the ring at slot `next`.
    function forceRing(uint256 i, uint256 at, uint256 bps, uint8 next) external {
        _takes[i] = uint80((at << 16) | bps);
        _takeIdx = next;
    }
}
