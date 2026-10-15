// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Call, Moloch, Shares, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";
import {DeployLaunchKit} from "../script/DeployLaunchKit.s.sol";

/// @notice The deploy script names the Shares implementation without making a DAO to look at. That address has to be the
/// one every DAO the summoner makes really clones: the kit predicts each DAO's Shares from it, and a wrong one would
/// revert every launch, so a test checks it against a real DAO.
contract DeployLaunchKitTest is Test {
    function test_the_computed_shares_implementation_is_the_one_a_real_dao_clones() public {
        DeployLaunchKit script = new DeployLaunchKit();
        vm.recordLogs();
        Summoner summoner = newSummoner();
        // The summoner announces the Moloch implementation it made.
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        address molochImplementation;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(summoner) && logs[i].topics[0] == keccak256("NewDAO(address,address)")) {
                molochImplementation = address(uint160(uint256(logs[i].topics[2])));
            }
        }
        assertTrue(molochImplementation != address(0), "the summoner announced its implementation");
        address computed = script.sharesImplementationOf(molochImplementation);
        assertGt(computed.code.length, 0, "the computed Shares implementation exists");

        // What a real DAO clones: the proxy's runtime code is nine bytes of prefix, the implementation, then the tail.
        address[] memory holders = new address[](1);
        holders[0] = address(0xBEEF);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1e18;
        Moloch probe = summoner.summon(
            "Probe", "PRB", "", 500, true, address(0), bytes32("probe"), holders, amounts, new Call[](0)
        );
        bytes memory code = address(probe.shares()).code;
        address cloned;
        for (uint256 i; i < 20; ++i) {
            cloned = address(uint160(cloned) << 8 | uint160(uint8(code[9 + i])));
        }
        assertEq(computed, cloned, "the script's address is the implementation a DAO really clones");
    }

    function test_the_script_refuses_a_chain_with_no_auction_factory() public {
        DeployLaunchKit script = new DeployLaunchKit();
        vm.setEnv("PRIVATE_KEY", vm.toString(uint256(1)));
        vm.setEnv("CCA_FACTORY", vm.toString(address(0x1234)));
        vm.expectRevert("DeployLaunchKit: no auction factory on this chain");
        script.run();
    }
}
