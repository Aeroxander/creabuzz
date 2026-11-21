// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Parts} from "../src/Parts.sol";
import {EarlierGrants} from "../src/EarlierGrants.sol";

/// @notice What the earlier grants cost in bytes. Recorded before this package (the build with the pause, switch off): Vester
/// runtime 7,355, Parts creation code 48,210 (942 to spare), Launcher 7,463. The plan's stop line for this package is Parts
/// creation code under 49,000 bytes; the contract limit is 49,152 (EIP-3860). The first design, with a separate
/// `grantProtected` beside `grant`, took the Parts creation code to 49,302 (over the limit); both callers now go through one `grant`
/// (see the Vester), which is what keeps it under.
contract SizeEarlierTest is StackBase {
    uint256 internal constant RUNTIME_LIMIT = 24_576;
    uint256 internal constant INITCODE_LIMIT = 49_152;
    uint256 internal constant STOP_LINE = 49_000;
    uint256 internal constant VESTER_BEFORE = 7355;

    function test_thePartsCreationCodeIsUnderTheStopLine() public {
        uint256 parts_ = type(Parts).creationCode.length;
        emit log_named_uint("Parts creation bytes", parts_);
        emit log_named_uint("Parts spare bytes under the limit", INITCODE_LIMIT - parts_);
        assertLt(parts_, STOP_LINE, "Parts creation code is over the stop line");
    }

    function test_theVesterFitsAndGrewByLessThanSevenHundredBytes() public {
        uint256 v_ = launcher.vesterImpl().code.length;
        emit log_named_uint("Vester runtime bytes", v_);
        emit log_named_uint("Vester grew by", v_ - VESTER_BEFORE);
        assertLt(v_, RUNTIME_LIMIT);
        assertLe(v_ - VESTER_BEFORE, 700);
    }

    function test_theClaimContractAndTheLauncherFit() public {
        uint256 e = type(EarlierGrants).creationCode.length;
        emit log_named_uint("EarlierGrants creation bytes", e);
        emit log_named_uint("Launcher runtime bytes", address(launcher).code.length);
        assertLt(e, INITCODE_LIMIT);
        assertLt(address(launcher).code.length, RUNTIME_LIMIT);
    }
}
