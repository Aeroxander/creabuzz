// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MilestoneChallenge} from "./MilestoneChallenge.sol";
import {MilestoneLock} from "./MilestoneLock.sol";

/// @title MilestoneLockFactory
/// @notice Makes the milestone locks of the launch kit (both kinds), which has no room for their creation code beside its
/// own. The kit deploys one of these in its constructor and is its only user in practice, but anyone may call it: the
/// address of every lock is CREATE2 from the caller and a salt, so nobody can take an address another caller will use, and
/// `createdBy` records which caller made a lock so a client can tell the kit's locks from anyone else's.
contract MilestoneLockFactory {
    mapping(address lock => address creator) public createdBy;

    event Created(address indexed lock, address indexed dao, address indexed creator, bool challenge);

    /// @notice A lock whose milestones a panel of named reviewers approves.
    function createPanelLock(
        bytes32 salt,
        address dao,
        address[] calldata team,
        uint256[] calldata totals,
        bytes32[] calldata checks,
        uint16[] calldata bps
    ) external returns (address lock) {
        lock = address(new MilestoneLock{salt: _salt(salt)}(dao, team, totals, checks, bps));
        createdBy[lock] = msg.sender;
        emit Created(lock, dao, msg.sender, false);
    }

    /// @notice A lock whose milestones unlock unless holders object.
    function createChallengeLock(
        bytes32 salt,
        address dao,
        address[] calldata team,
        uint256[] calldata totals,
        bytes32[] calldata checks,
        uint16[] calldata bps,
        MilestoneChallenge.Terms calldata terms
    ) external returns (address lock) {
        lock = address(new MilestoneChallenge{salt: _salt(salt)}(dao, team, totals, checks, bps, terms));
        createdBy[lock] = msg.sender;
        emit Created(lock, dao, msg.sender, true);
    }

    function _salt(bytes32 salt) private view returns (bytes32) {
        return keccak256(abi.encode(msg.sender, salt));
    }
}
