// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Council} from "../src/Council.sol";
import {Parts} from "../src/Parts.sol";

/// @notice What the Council round cost in bytes. The sizes at 4c36f73d6 (the build the round started from) were: Treasury
/// runtime 24,080 (496 to spare), Parts creation code 48,810 (342 to spare), Pair runtime 2,558, Launcher runtime 8,724. The
/// plan's gates: the Treasury grows at most 190 bytes and keeps at least 300 spare; Parts creation code keeps at least 152
/// spare (the Pair may grow at most 190); the Council is under the limit with at least 3,000 spare; the Launcher is under it.
contract SizeCouncilTest is StackBase {
    uint256 internal constant RUNTIME_LIMIT = 24_576;
    uint256 internal constant INITCODE_LIMIT = 49_152;
    uint256 internal constant TREASURY_BEFORE = 24_080;
    uint256 internal constant PARTS_BEFORE = 48_810;
    uint256 internal constant PAIR_BEFORE = 2558;
    uint256 internal constant LAUNCHER_BEFORE = 8724;

    function test_theTreasuryGrewByAtMost190BytesAndKeepsRoom() public {
        uint256 treasury = launcher.treasuryImpl().code.length;
        emit log_named_uint("Treasury runtime bytes", treasury);
        emit log_named_int("Treasury grew by", int256(treasury) - int256(TREASURY_BEFORE));
        emit log_named_uint("Treasury spare bytes", RUNTIME_LIMIT - treasury);
        assertLe(treasury, TREASURY_BEFORE + 190, "the Treasury grew by more than the plan allows");
        assertGe(RUNTIME_LIMIT - treasury, 300, "the Treasury has under 300 bytes spare");
    }

    function test_thePartsCreationCodeKeepsAtLeast152BytesSpare() public {
        uint256 parts_ = type(Parts).creationCode.length;
        emit log_named_uint("Parts creation bytes", parts_);
        emit log_named_int("Parts grew by", int256(parts_) - int256(PARTS_BEFORE));
        emit log_named_uint("Parts spare bytes", INITCODE_LIMIT - parts_);
        assertGe(INITCODE_LIMIT - parts_, 152, "Parts creation code is over 48,999 bytes");
    }

    function test_thePairGrewByAtMost190Bytes() public {
        uint256 pair = launcher.pairImpl().code.length;
        emit log_named_uint("Pair runtime bytes", pair);
        emit log_named_uint("Pair grew by", pair - PAIR_BEFORE);
        assertLe(pair - PAIR_BEFORE, 190);
    }

    function test_theCouncilAndTheLauncherFit() public {
        uint256 council = address(new Council()).code.length;
        uint256 l = address(launcher).code.length;
        emit log_named_uint("Council runtime bytes", council);
        emit log_named_uint("Council spare bytes", RUNTIME_LIMIT - council);
        emit log_named_uint("Launcher runtime bytes", l);
        emit log_named_uint("Launcher grew by", l - LAUNCHER_BEFORE);
        assertLt(council, RUNTIME_LIMIT - 3000, "the Council has under 3,000 bytes spare");
        assertLt(l, RUNTIME_LIMIT);
    }
}
