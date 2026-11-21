// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Parts} from "../src/Parts.sol";

/// @notice What the pause cost in bytes. The recorded sizes at 1fed95002 were: Treasury 23,577 (999 to spare), Launcher 6,650,
/// Parts creation code 47,707 (1,445 to spare). The plan's gates: the Treasury may grow by at most 650 bytes and keep at least
/// 300 spare; Parts creation code stays at least 400 under its limit (the next package, earlier grants, adds to the Vester,
/// which Parts also creates). Step 4's second package (K2) used that room: the Vester grew by 585 bytes, and the floor became
/// the plan's own stop line for it, Parts creation code under 49,000 bytes (at least 152 spare); the gate for K1's stage, 400, was
/// replaced in that change.
contract SizePauseTest is StackBase {
    uint256 internal constant RUNTIME_LIMIT = 24_576;
    uint256 internal constant INITCODE_LIMIT = 49_152;
    uint256 internal constant TREASURY_BEFORE = 23_577;
    uint256 internal constant LAUNCHER_BEFORE = 6650;
    uint256 internal constant PARTS_BEFORE = 47_707;

    function test_theTreasuryGrewByAtMost650BytesAndKeepsRoom() public {
        uint256 treasury = launcher.treasuryImpl().code.length;
        emit log_named_uint("Treasury runtime bytes", treasury);
        emit log_named_uint("Treasury grew by", treasury - TREASURY_BEFORE);
        emit log_named_uint("Treasury spare bytes", RUNTIME_LIMIT - treasury);
        assertLe(treasury - TREASURY_BEFORE, 650, "the Treasury grew by more than the plan allows");
        assertGe(RUNTIME_LIMIT - treasury, 300, "the Treasury has under 300 bytes spare");
    }

    function test_thePartsCreationCodeStaysUnderTheStopLine() public {
        uint256 parts_ = type(Parts).creationCode.length;
        emit log_named_uint("Parts creation bytes", parts_);
        emit log_named_uint("Parts grew by", parts_ - PARTS_BEFORE);
        emit log_named_uint("Parts spare bytes", INITCODE_LIMIT - parts_);
        assertGe(INITCODE_LIMIT - parts_, 152, "Parts creation code is over 49,000 bytes");
    }

    function test_theLauncherFits() public {
        uint256 l = address(launcher).code.length;
        emit log_named_uint("Launcher runtime bytes", l);
        emit log_named_uint("Launcher grew by", l - LAUNCHER_BEFORE);
        assertLt(l, RUNTIME_LIMIT);
    }
}
