// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MilestoneChallenge} from "./MilestoneChallenge.sol";

/// @title MilestoneChallengeFactory
/// @notice Makes the `MilestoneChallenge` locks of the launch kit (see `MilestoneLockFactory`: the same arrangement, and a
/// separate contract because the two locks' creation code together is over the 24,576-byte limit). Every lock's address is
/// CREATE2 from the caller and a salt, and `createdBy` records the caller.
contract MilestoneChallengeFactory {
    mapping(address lock => address creator) public createdBy;

    event Created(address indexed lock, address indexed dao, address indexed creator);

    function create(
        bytes32 salt,
        address dao,
        address[] calldata team,
        uint256[] calldata totals,
        bytes32[] calldata checks,
        uint16[] calldata bps,
        MilestoneChallenge.Terms calldata terms
    ) external returns (address lock) {
        lock = address(
            new MilestoneChallenge{salt: keccak256(abi.encode(msg.sender, salt))}(dao, team, totals, checks, bps, terms)
        );
        createdBy[lock] = msg.sender;
        emit Created(lock, dao, msg.sender);
    }
}
