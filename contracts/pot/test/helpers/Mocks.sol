// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ILauncherPairs, IPair, IPairSigners} from "../../src/Interfaces.sol";
import {Treasury} from "../../src/Treasury.sol";

/// @notice Stands in for the Launcher: a registry of Pairs and the wind-down forwarder.
contract MockSalePath is ILauncherPairs {
    mapping(address => bool) public isPair;

    function setPair(address who, bool on) external {
        isPair[who] = on;
    }

    function wind(address treasury) external {
        Treasury(treasury).markWoundDown();
    }
}

/// @notice Stands in for the Pair: `exec` calls a target with `bothSigned` true or false around the call only.
contract MockPair is IPair, IPairSigners {
    bool public bothSigned;
    address public first;
    address public second;

    constructor(address first_, address second_) {
        (first, second) = (first_, second_);
    }

    function exec(address target, bytes calldata data, bool signed) external returns (bool ok, bytes memory ret) {
        bothSigned = signed;
        (ok, ret) = target.call(data);
        bothSigned = false;
    }
}

/// @notice Stands in for the Vester: holds the Team pool and records the founder trim.
contract MockVester {
    address public exited;
    uint256 public exitCalls;

    function exitAll(address member) external {
        exited = member;
        ++exitCalls;
    }
}
