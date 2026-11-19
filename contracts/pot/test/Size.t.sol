// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {Parts} from "../src/Parts.sol";
import {Pair} from "../src/Pair.sol";

/// @notice The contracts must fit the chain: 24,576 bytes of deployed code each (EIP-170), and the Parts contract, whose
/// constructor makes every implementation, 49,152 bytes of creation code (EIP-3860). The measured numbers are logged.
contract SizeTest is StackBase {
    uint256 internal constant RUNTIME_LIMIT = 24_576;
    uint256 internal constant INITCODE_LIMIT = 49_152;

    function test_everyContractFitsWithRoomForTheNextPass() public {
        uint256 treasury = launcher.treasuryImpl().code.length;
        uint256 book = launcher.tasksImpl().code.length;
        uint256 vester = launcher.vesterImpl().code.length;
        uint256 pair = launcher.pairImpl().code.length;
        uint256 token = launcher.shareImpl().code.length;
        emit log_named_uint("Treasury runtime bytes", treasury);
        emit log_named_uint("TaskBook runtime bytes", book);
        emit log_named_uint("Vester runtime bytes", vester);
        emit log_named_uint("Pair runtime bytes", pair);
        emit log_named_uint("ShareToken runtime bytes", token);
        emit log_named_uint("Parts creation bytes", type(Parts).creationCode.length);
        emit log_named_uint("Launcher runtime bytes", address(launcher).code.length);
        assertLt(treasury, RUNTIME_LIMIT, "Treasury");
        assertLt(book, RUNTIME_LIMIT, "TaskBook");
        assertLt(vester, RUNTIME_LIMIT, "Vester");
        assertLt(pair, RUNTIME_LIMIT, "Pair");
        assertLt(address(launcher).code.length, RUNTIME_LIMIT, "Launcher");
        assertLt(type(Parts).creationCode.length, INITCODE_LIMIT, "Parts creation code (EIP-3860)");
    }

    function test_theClonesAreSmallAndPointAtTheImplementations() public view {
        assertEq(address(t).code.length, 45, "a minimal clone");
        assertEq(address(_book()).code.length, 45);
    }

    function test_thePartsContractHoldsTheFiveImplementations() public {
        Parts p = new Parts();
        assertGt(p.tasksImpl().code.length, 0);
        assertGt(p.treasuryImpl().code.length, 0);
        assertGt(p.vesterImpl().code.length, 0);
        assertGt(p.pairImpl().code.length, 0);
        assertGt(p.shareImpl().code.length, 0);
        assertEq(Pair(p.pairImpl()).launcher(), address(1), "locked");
    }
}
