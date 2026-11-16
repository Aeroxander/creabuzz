// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice A stand-in for the pool guard hook (`InitializerHook`): it names the one address allowed to create the pool.
contract MockGuard {
    address public authorized;

    constructor(address creator) {
        authorized = creator;
    }
}

/// @notice A hook that is a contract but is not a guard: it has no `authorized()`.
contract NotAGuard {
    fallback() external {
        revert("no");
    }
}
