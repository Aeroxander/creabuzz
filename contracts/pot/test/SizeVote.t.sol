// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {VoteBase} from "./helpers/VoteBase.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {Parts} from "../src/Parts.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice What the vote part cost in bytes (COUNCIL-PLAN 2.13 and 1.7): `HolderVote` under the limit with at least 3,000 to
/// spare, the Treasury not grown by K2 (K1's gate left it at 24,153 of 24,576), Parts creation code still at least 152 spare,
/// and `HolderPause`'s runtime bytecode exactly the code recorded before the round (its three hook calls and two empty internal
/// functions compile to nothing).
contract SizeVoteTest is VoteBase {
    uint256 internal constant RUNTIME_LIMIT = 24_576;
    uint256 internal constant INITCODE_LIMIT = 49_152;
    uint256 internal constant TREASURY_AFTER_K1 = 24_153;
    uint256 internal constant PARTS_BEFORE = 48_810;
    /// @dev The pause's runtime hash recorded in DEPLOYMENTS.md at v6, before the Council round.
    bytes32 internal constant PAUSE_HASH_BEFORE = 0x968400a44b9da42191d6e20ab5f47532e161ee3255d508c807d49f82f0a3ccdf;

    function test_theVoteContractHasAtLeast3000BytesSpare() public {
        uint256 voteBytes = address(new HolderVote()).code.length;
        emit log_named_uint("HolderVote runtime bytes", voteBytes);
        emit log_named_uint("HolderVote spare bytes", RUNTIME_LIMIT - voteBytes);
        assertLt(voteBytes, RUNTIME_LIMIT - 3000, "HolderVote has under 3,000 bytes spare");
    }

    function test_theTreasuryIsUnchangedByK2() public view {
        // K2 adds nothing to the Treasury; K1's gate allowed it to grow by at most 190 from 24,080
        assertLe(address(t).code.length, TREASURY_AFTER_K1, "K2 grew the Treasury");
        assertLe(address(t).code.length, 24_080 + 190, "the Treasury is over K1's gate");
    }

    function test_thePartsCreationCodeStillKeeps152BytesSpare() public {
        uint256 partsBytes = type(Parts).creationCode.length;
        emit log_named_uint("Parts creation bytes", partsBytes);
        assertGe(INITCODE_LIMIT - partsBytes, 152, "Parts creation code is over its gate");
    }

    function test_thePauseIsByteIdenticalToTheCodeBeforeTheRound() public {
        bytes32 nowHash = address(new HolderPause()).codehash;
        emit log_named_bytes32("HolderPause runtime hash", nowHash);
        assertEq(nowHash, PAUSE_HASH_BEFORE, "the pause's bytecode changed: its hooks do not compile to nothing");
    }
}
