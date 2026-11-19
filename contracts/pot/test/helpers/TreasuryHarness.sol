// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Treasury} from "../../src/Treasury.sol";

/// @notice The production Treasury plus functions that set its state directly, for the worked numbers that would take
/// thousands of joins to reach. Every production function is untouched. The caller must also fund the contract with
/// matching dollars (PotBase._force does).
contract TreasuryHarness is Treasury {
    function force(uint256 pot_, uint256 paidIn_, uint256 box_, uint256 arriving_, uint64 arrivalEnd_) external {
        (pot, paidIn, box, arriving, arrivalEnd) = (pot_, paidIn_, box_, arriving_, arrivalEnd_);
        // a forced stream is taken to have started at the last settle with the whole of `arriving_` still to come
        (arrivalStart, arrivalTotal) = (lastSettle, arriving_);
    }

    function forceShares(address to, uint256 n) external {
        shares.mint(to, n);
    }

    function forceZ(uint256 z) external {
        Z = z;
    }

    function forceFees(uint256 f) external {
        feesOwed = f;
    }
}
