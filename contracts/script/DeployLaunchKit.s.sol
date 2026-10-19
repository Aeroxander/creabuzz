// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Shares, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";

/// @notice Put the launch path on a chain that already has Uniswap's auction factory: our patched summoner (the one whose
/// Shares carry the milestone lock guard), the `DaoLaunchKit` that launches a DAO and its sale in one transaction, and the
/// `ContributorKit` that starts a contributor project (no sale, ready for work) on the same summoner.
///
/// Nothing else is deployed: the auction factory, Permit2 and the sale currency are the chain's own. The script refuses
/// to run where the factory has no code, and it checks the Shares implementation it computes really exists before it
/// deploys the kit that names it, so a wrong address cannot reach the chain.
///
/// Run (a rehearsal on a fork first; `scripts/sepolia-deploy.sh` does both):
///   PRIVATE_KEY=0x… forge script script/DeployLaunchKit.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
/// Env: PRIVATE_KEY (the deployer, a testnet key), CCA_FACTORY (default: the canonical factory, the same address on every
/// chain), LAUNCH_PROJECT (a label for the manifest).
contract DeployLaunchKit is Script {
    /// @dev Uniswap's continuous clearing auction factory v2.1.0: one address on every EVM chain.
    address internal constant CANONICAL_CCA_FACTORY = 0x000000001F26a0044BaA66024e7b6599c61963F8;

    function run() external returns (address summoner, address sharesImplementation, address kit) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address ccaFactory = vm.envOr("CCA_FACTORY", CANONICAL_CCA_FACTORY);
        require(ccaFactory.code.length != 0, "DeployLaunchKit: no auction factory on this chain");

        // The summoner's constructor announces the Moloch implementation it made (`NewDAO(summoner, implementation)`),
        // which is where the Shares implementation comes from.
        vm.recordLogs();
        vm.startBroadcast(pk);
        Summoner made = newSummoner();
        summoner = address(made);
        address molochImplementation = _implementationFromLog(summoner);
        sharesImplementation = sharesImplementationOf(molochImplementation);
        require(sharesImplementation.code.length != 0, "DeployLaunchKit: the Shares implementation has no code");
        kit = vm.deployCode("DaoLaunchKit.sol:DaoLaunchKit", abi.encode(summoner, ccaFactory, sharesImplementation));
        address contributorKit = vm.deployCode("ContributorKit.sol:ContributorKit", abi.encode(summoner));
        vm.stopBroadcast();
        require(kit.code.length != 0, "DeployLaunchKit: the kit has no code");
        require(contributorKit.code.length != 0, "DeployLaunchKit: the contributor kit has no code");

        _writeManifest(summoner, molochImplementation, sharesImplementation, kit, contributorKit, ccaFactory);
        console2.log("chain id:", block.chainid);
        console2.log("Summoner:", summoner);
        console2.log("Moloch implementation:", molochImplementation);
        console2.log("Shares implementation:", sharesImplementation);
        console2.log("DaoLaunchKit:", kit);
        console2.log("ContributorKit:", contributorKit);
        console2.log("Auction factory:", ccaFactory);
    }

    /// @notice The Shares implementation a Moloch implementation made for itself: its constructor deploys it with CREATE2
    /// from its own address and a salt that is that address, so it is known without making a DAO to look at.
    function sharesImplementationOf(address molochImplementation) public pure returns (address) {
        bytes32 salt = bytes32(bytes20(molochImplementation));
        return vm.computeCreate2Address(salt, keccak256(type(Shares).creationCode), molochImplementation);
    }

    function _implementationFromLog(address summoner) internal returns (address implementation) {
        bytes32 newDaoTopic = keccak256("NewDAO(address,address)");
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == summoner && logs[i].topics.length == 3 && logs[i].topics[0] == newDaoTopic
                    && address(uint160(uint256(logs[i].topics[1]))) == summoner
            ) {
                return address(uint160(uint256(logs[i].topics[2])));
            }
        }
        revert("DeployLaunchKit: Moloch implementation not found in the Summoner's NewDAO log");
    }

    /// @dev `deployments/dao-launch-kit-<chainid>.json`, the shape the dev chain writes, with the extra roles a testnet
    /// needs to be checked later (who the kit points at).
    function _writeManifest(
        address summoner,
        address molochImplementation,
        address sharesImplementation,
        address kit,
        address contributorKit,
        address ccaFactory
    ) internal {
        string memory path = string.concat("deployments/dao-launch-kit-", vm.toString(block.chainid), ".json");
        string memory json = string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"project":"',
            vm.envOr("LAUNCH_PROJECT", string("creaton")),
            '","note":"forge script script/DeployLaunchKit.s.sol --broadcast","block":',
            vm.toString(block.number),
            ',"roles":[{"role":"launch-kit","address":"',
            vm.toString(kit),
            '"},{"role":"contributor-kit","address":"',
            vm.toString(contributorKit),
            '"},{"role":"summoner","address":"',
            vm.toString(summoner),
            '"},{"role":"moloch-implementation","address":"',
            vm.toString(molochImplementation),
            '"},{"role":"shares-implementation","address":"',
            vm.toString(sharesImplementation),
            '"},{"role":"auction-factory","address":"',
            vm.toString(ccaFactory),
            '"}]}'
        );
        vm.writeFile(path, json);
    }
}
