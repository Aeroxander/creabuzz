// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RoyaltyDistributor, IERC20Bal} from "../src/RoyaltyDistributor.sol";
import {SellRateGate} from "../src/SellRateGate.sol";
import {TieredSellRouter} from "../src/TieredSellRouter.sol";
import {BuybackKeeper} from "../src/BuybackKeeper.sol";
import {ClaimStake} from "../src/ClaimStake.sol";

/// @notice DeployRoyalty — wire the royalty layer for an EXISTING launch.
///
/// The launch's currency, project token, ClaimStake, treasury and buyback
/// sink are already live (see DeployAppToken / DeployOrgDao). This script
/// deploys the RoyaltyDistributor + SellRateGate + TieredSellRouter +
/// BuybackKeeper and performs the one-shot `ClaimStake.setRoyalties` wiring.
///
/// Wiring order note: the gate's `venue` is the router and the router holds
/// the gate — the router's CREATE address is predicted (RLP of [sender,
/// nonce]) so the gate can be deployed first, exactly as `test/Wiring.t.sol`
/// binds. `BuybackKeeper` becomes the distributor's `buybackSink` unless
/// ROYALTY_BUYBACK_SINK is given.
///
/// The broadcaster MUST be the ClaimStake treasury (`setRoyalties` is
/// treasury-only and one-shot).
///
/// Env:
///   ROYALTY_CURRENCY      revenue currency (e.g. USDC)
///   ROYALTY_PROJECT_TOKEN the launched project token
///   ROYALTY_TREASURY      treasury address
///   ROYALTY_CLAIM_STAKE   live ClaimStake
///   ROYALTY_GOVERNANCE    may only unsuspend schedules (e.g. the majeur DAO)
///   ROYALTY_OPERATOR      keeper that runs sells/buybacks
///   ROYALTY_BUYBACK_SINK  optional override (default: the deployed keeper)
///   ROYALTY_WINDOW_LEN    optional, default 30 days
///   ROYALTY_BUYBACK_BPS   optional, default 4000 (β 40%)
///   ROYALTY_TREASURY_BPS  optional, default 2000 (τ 20%)
contract DeployRoyalty is Script {
    function run() external {
        address currency = vm.envAddress("ROYALTY_CURRENCY");
        address projectToken = vm.envAddress("ROYALTY_PROJECT_TOKEN");
        address treasury = vm.envAddress("ROYALTY_TREASURY");
        address claimStake = vm.envAddress("ROYALTY_CLAIM_STAKE");
        address governance = vm.envAddress("ROYALTY_GOVERNANCE");
        address operator = vm.envAddress("ROYALTY_OPERATOR");
        address buybackSinkOverride = vm.envOr("ROYALTY_BUYBACK_SINK", address(0));
        uint64 windowLen = uint64(vm.envOr("ROYALTY_WINDOW_LEN", uint256(30 days)));
        uint16 buybackBps = uint16(vm.envOr("ROYALTY_BUYBACK_BPS", uint256(4000)));
        uint16 treasuryBps = uint16(vm.envOr("ROYALTY_TREASURY_BPS", uint256(2000)));

        vm.startBroadcast();
        uint64 nonce = vm.getNonce(msg.sender);
        // Deploy order inside the broadcast: keeper (N), distributor (N+1),
        // gate (N+2, venue = predicted router), router (N+3). The gate's
        // `venue` is the router and the router holds the gate — the router's
        // CREATE address is predicted (RLP of [sender, nonce]) exactly as
        // `test/Wiring.t.sol` binds.
        address predictedRouter = _createAddress(msg.sender, nonce + 3);
        BuybackKeeper keeper = new BuybackKeeper(IERC20Bal(currency), governance, operator);
        RoyaltyDistributor dist = new RoyaltyDistributor(
            IERC20Bal(currency),
            IERC20Bal(projectToken),
            treasury,
            buybackSinkOverride == address(0) ? address(keeper) : buybackSinkOverride,
            claimStake,
            governance,
            windowLen,
            buybackBps,
            treasuryBps
        );
        SellRateGate gate = new SellRateGate(dist, predictedRouter);
        TieredSellRouter router = new TieredSellRouter(gate, operator);
        require(address(router) == predictedRouter, "router nonce drift");
        ClaimStake(claimStake).setRoyalties(address(dist));
        vm.stopBroadcast();

        console2.log("RoyaltyDistributor:", address(dist));
        console2.log("SellRateGate:", address(gate));
        console2.log("TieredSellRouter:", address(router));
        console2.log("BuybackKeeper:", address(keeper));
    }

    /// @dev CREATE address derivation: keccak(RLP([sender, nonce])).
    function _createAddress(address deployer, uint64 nonce) internal pure returns (address) {
        bytes memory data;
        if (nonce == 0x00) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x80));
        } else if (nonce <= 0x7f) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(nonce));
        } else if (nonce <= 0xff) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x81), uint8(nonce));
        } else {
            revert("nonce beyond helper range");
        }
        return address(uint160(uint256(keccak256(data))));
    }
}
