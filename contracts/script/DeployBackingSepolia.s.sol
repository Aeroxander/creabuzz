// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFactory} from "../src/BackingPoolFactory.sol";
import {BackingTerms} from "./BackingTerms.sol";
import {ContributorKitV3} from "../src/ContributorKitV3.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {Summoner} from "../src/majeur/MolochPatched.sol";

/// @title DeployBackingSepolia
/// @notice Puts the instant-backing set on Sepolia, beside (never over) the weekly-sale set of
/// `DeployV5Sepolia`: a backing pool factory, and the kit that opens a pool at a project's birth
/// (`ContributorKitV3`) with the market factory it needs. Nothing already deployed is touched or redeployed. The
/// summoner is the weekly-sale set's, so a project made there by `ContributorKitV2` can open its pool here with one
/// call from its founder, and the quote token is that set's free-mint test token.
///
/// Order, one transaction each from one deployer:
///   1. predict the kit from the deployer's next-but-two nonce
///   2. SecondaryMarketFactory(summoner, predictedKit)   3. BackingPoolFactory(summoner, quote, terms, predictedKit)
///   4. ContributorKitV3(summoner, marketFactory, poolFactory)
/// Nothing else may be sent by the deployer between 2 and 4: the kit refuses factories authorised for another
/// address, so a stray transaction only wastes the factories.
///
/// The pool terms are the defaults of docs/v3-review/BACKING-POOL.md (`BackingTerms`), with the amounts scaled to the quote
/// token's decimals. They are fixed in the factory for good: other terms are another factory.
///
/// Writes `deployments/backing-sepolia-11155111.json` (not ignored: commit it after a real deploy; a run without
/// `--broadcast`, or against a local node, writes the file too: delete that one).
///
/// Opening rounds use the canonical auction factory already on Sepolia (the `auction-factory` of
/// `deployments/dao-launch-kit-11155111.json`), with the round defaults of `BackingTerms.round`.
///
/// Env: PRIVATE_KEY (the deployer: a testnet-only key, passed through the environment, never on a command
/// line). Optional: BACKING_SUMMONER, BACKING_QUOTE and BACKING_AUCTION_FACTORY, to name a summoner, a quote
/// token and an auction factory other than the ones in the manifests.
contract DeployBackingSepolia is Script {
    uint256 internal constant SEPOLIA = 11155111;
    string internal constant V5_MANIFEST = "deployments/v5-sepolia-11155111.json";
    string internal constant LAUNCH_MANIFEST = "deployments/dao-launch-kit-11155111.json";

    string[] internal roleNames;
    address[] internal roleAddresses;

    function run() external {
        require(block.chainid == SEPOLIA, "DeployBackingSepolia: Sepolia only (chain id 11155111)");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        Summoner summoner = Summoner(vm.envOr("BACKING_SUMMONER", _manifestRole(V5_MANIFEST, "summoner")));
        address quote = vm.envOr("BACKING_QUOTE", _manifestRole(V5_MANIFEST, "test-quote-token"));
        _requireCode(address(summoner), "summoner");
        _requireCode(quote, "quote token");
        // The canonical auction factory opening rounds are created on: the one the 5 Nov launch kit uses.
        address auctionFactory = vm.envOr("BACKING_AUCTION_FACTORY", _manifestRole(LAUNCH_MANIFEST, "auction-factory"));
        _requireCode(auctionFactory, "auction factory");
        BackingPool.Params memory terms = BackingTerms.defaults(IERC20Metadata(quote).decimals());
        // The factory stores the terms unchecked (a pool's constructor is what refuses bad ones), so build one
        // pool here, in the simulation only, before anything is sent.
        new BackingPool(address(summoner), deployer, IERC20(quote), terms, 0);
        uint256 startBlock = block.number;

        vm.startBroadcast(pk);
        address predictedKit = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 2);
        SecondaryMarketFactory marketFactory = new SecondaryMarketFactory(summoner, predictedKit);
        BackingPoolFactory poolFactory =
            new BackingPoolFactory(summoner, IERC20(quote), terms, predictedKit, BackingTerms.round(auctionFactory));
        ContributorKitV3 kit = new ContributorKitV3(summoner, marketFactory, poolFactory);
        vm.stopBroadcast();

        require(address(kit) == predictedKit, "DeployBackingSepolia: the kit did not land on the predicted address");
        _requireCode(address(marketFactory), "market factory");
        _requireCode(address(poolFactory), "pool factory");
        _requireCode(address(kit), "kit");
        require(marketFactory.authorizedKit() == address(kit), "DeployBackingSepolia: market factory for another kit");
        require(poolFactory.authorizedKit() == address(kit), "DeployBackingSepolia: pool factory for another kit");
        require(kit.marketFactory() == marketFactory, "DeployBackingSepolia: kit pins another market factory");
        require(kit.poolFactory() == poolFactory, "DeployBackingSepolia: kit pins another pool factory");
        require(address(kit.summoner()) == address(summoner), "DeployBackingSepolia: kit pins another summoner");
        require(
            address(poolFactory.summoner()) == address(summoner), "DeployBackingSepolia: pool factory on another summoner"
        );
        require(address(poolFactory.quote()) == quote, "DeployBackingSepolia: pool factory on another quote");
        require(
            address(poolFactory.auctionFactory()) == auctionFactory, "DeployBackingSepolia: another auction factory"
        );
        require(
            keccak256(abi.encode(poolFactory.terms())) == keccak256(abi.encode(terms)),
            "DeployBackingSepolia: the stored terms differ"
        );

        console2.log("chain id:", block.chainid);
        _role("summoner", "Summoner (reused)", address(summoner));
        _role("backing-quote-token", "Quote token (reused)", quote);
        _role("auction-factory", "Auction factory (reused)", auctionFactory);
        _role("market-factory-v3", "SecondaryMarketFactory", address(marketFactory));
        _role("backing-pool-factory", "BackingPoolFactory", address(poolFactory));
        _role("contributor-kit-v3", "ContributorKitV3", address(kit));
        _writeManifest(startBlock);
    }

    /// @dev One role's address from the weekly-sale manifest.
    function _manifestRole(string memory manifest, string memory role) internal view returns (address) {
        string memory json = vm.readFile(manifest);
        for (uint256 i; i < 32; ++i) {
            string memory key = string.concat(".roles[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, key)) break;
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(key, ".role")))) == keccak256(bytes(role))) {
                return vm.parseJsonAddress(json, string.concat(key, ".address"));
            }
        }
        revert(string.concat("DeployBackingSepolia: no ", role, " in ", manifest));
    }

    /// @dev The manifest, in the shape `DeployV5Sepolia` writes. `block` is the chain's head when the script began.
    function _writeManifest(uint256 startBlock) internal {
        string memory roles;
        for (uint256 i; i < roleNames.length; ++i) {
            roles = string.concat(
                roles,
                i == 0 ? "" : ",",
                '{"role":"',
                roleNames[i],
                '","address":"',
                vm.toString(roleAddresses[i]),
                '"}'
            );
        }
        string memory path = string.concat("deployments/backing-sepolia-", vm.toString(block.chainid), ".json");
        vm.writeFile(
            path,
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"project":"creaton","note":"forge script script/DeployBackingSepolia.s.sol --broadcast (instant-backing set: market factory, backing pool factory, kit V3; the summoner and the quote token are the weekly-sale set\'s)","block":',
                vm.toString(startBlock),
                ',"roles":[',
                roles,
                "]}"
            )
        );
    }

    function _role(string memory role, string memory label, address where) internal {
        roleNames.push(role);
        roleAddresses.push(where);
        console2.log(string.concat(label, ":"), where);
    }

    function _requireCode(address target, string memory label) private view {
        require(target.code.length != 0, string.concat("DeployBackingSepolia: no code at the ", label));
    }
}
