// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ILauncherPairs, IPair, IPairSigners} from "../../src/Interfaces.sol";
import {Treasury} from "../../src/Treasury.sol";

/// @notice Stands in for the Launcher: a registry of runner contracts and the wind-down forwarder.
contract MockSalePath is ILauncherPairs {
    mapping(address => uint8) public runnerKindOf;

    function isPair(address who) external view returns (bool) {
        return runnerKindOf[who] == 1;
    }

    function setPair(address who, bool on) external {
        runnerKindOf[who] = on ? 1 : 0;
    }

    /// @dev Register `who` as a runner contract of kind 2 (a Council), without a real Council behind it.
    function setCouncilLike(address who, bool on) external {
        runnerKindOf[who] = on ? 2 : 0;
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

    function isSeat(address a) external view returns (bool) {
        return a == first || a == second;
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
