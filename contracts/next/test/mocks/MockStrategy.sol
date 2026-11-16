// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice A stand-in for the pool strategy, only as much as the Launcher reads when it is made: where the pool manager, the
/// position manager and the auction factory are. The real strategy is tested in `Life.t.sol` and the others.
contract MockStrategy {
    address public immutable poolManager;
    address public immutable positionManager;
    address public immutable initializerFactory;

    constructor(address poolManager_, address positionManager_, address factory) {
        (poolManager, positionManager, initializerFactory) = (poolManager_, positionManager_, factory);
    }
}
