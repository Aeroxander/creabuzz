// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Permit2} from "permit2/src/Permit2.sol";

/// @notice Deploys the vendored Uniswap Permit2 so a test can place its runtime
/// code at the canonical address the auction's bid pull path hardcodes
/// (`SafeTransferLib.PERMIT2`, `0x000000000022D473030F116dDEE9F6B43aC78BA3`).
/// @dev Permit2 pins `pragma solidity 0.8.17`, which the `^0.8.24` lifecycle
/// test cannot import directly. The test deploys this harness via
/// `vm.deployCode("test/Permit2Harness.sol:Permit2Harness")`, reads the
/// constructed `Permit2`, and `vm.etch`es its runtime code (constructor-resolved
/// immutables included) at the canonical address. The EIP-712 cached domain
/// separator inside that code was computed for the harness-side address; the
/// lifecycle test only uses `approve` + `transferFrom` (allowance, not
/// signature, paths), where the domain separator is irrelevant.
contract Permit2Harness {
    /// @notice The freshly constructed vendored Permit2.
    Permit2 public permit2;

    constructor() {
        permit2 = new Permit2();
    }
}
