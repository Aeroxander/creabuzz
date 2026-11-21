// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {PlayDollar} from "../src/PlayDollar.sol";
import {Parts} from "../src/Parts.sol";
import {Launcher} from "../src/Launcher.sol";
import {HolderPause} from "../src/HolderPause.sol";

/// @notice Deploys the money contracts of one network: the dollar (PlayDollar on a test network, or an existing token whose
/// address is given), the part implementations, and the Launcher with the platform settings. It holds no key and reads none:
/// the operator supplies the sender on the command line (`--private-key`, `--account` or `--ledger`) and, through the
/// environment, the choices below. It writes the addresses to `deployments/pot-<chainid>.json`.
///
/// Environment (all optional):
///   UNIT       the time unit N in seconds; default 7 days. On a network that is not a test network it must be exactly 7 days
///              (the Launcher refuses anything else); on a test network any multiple of 168 seconds (1680 works).
///   QUOTE      the address of the dollar token (6 decimals). Default: a new PlayDollar, test networks only.
///   PLATFORM   who receives the platform fee. Default on a test network: the sender. Required elsewhere.
///   ADMIN      who may change the platform settings for new projects. Default on a test network: the sender. Required
///              elsewhere.
///   FEE_BPS    the platform fee on a join, in ten-thousandths. Default 200 (2%). At most 500.
///   AGENT_USD  an agent's default daily dollar limit, in dollar units (millionths). Default 25,000,000 (25 dollars).
///   HOLDER_PAUSE  0 (the default) or 1. With 1 the script also deploys the holder pause (`HolderPause`) and binds it to the
///              Launcher in the same broadcast, before any project can be launched: every project launched from then on is born
///              with a pause that holders can use (docs/next-version/STEP4-PLAN.md). It is a switch of the deployment: it cannot
///              be changed later, and a project is born with the pause or without it for good. Off by default.
///
/// Example (a local test chain): `UNIT=1680 forge script script/DeployPot.s.sol --rpc-url anvil --broadcast
/// --private-key <your key>`.
contract DeployPot is Script {
    /// @notice What was deployed.
    struct Deployed {
        address quote;
        address parts;
        address launcher;
        address holderPause;
        address admin;
        address platform;
        uint256 unit;
        uint256 feeBps;
    }

    function run() external returns (Deployed memory d) {
        uint256 unit = vm.envOr("UNIT", uint256(7 days));
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(200));
        uint256 agentUsd = vm.envOr("AGENT_USD", uint256(25e6));
        address quoteIn = vm.envOr("QUOTE", address(0));
        uint256 holderPauseOn = vm.envOr("HOLDER_PAUSE", uint256(0));
        // every setting is checked before the broadcast starts, so a bad one sends nothing
        require(holderPauseOn <= 1, "HOLDER_PAUSE must be 0 or 1");

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        // The fee receiver and the admin are chosen for every new project: off a test network they are never the hot sender
        // by default.
        bool testNet = block.chainid == 31_337 || block.chainid == 11_155_111;
        address platform = testNet ? vm.envOr("PLATFORM", sender) : vm.envAddress("PLATFORM");
        address admin = testNet ? vm.envOr("ADMIN", sender) : vm.envAddress("ADMIN");
        require(
            unit <= type(uint32).max && feeBps <= type(uint16).max && agentUsd <= type(uint128).max, "setting too big"
        );

        address quote = quoteIn;
        if (quote == address(0)) quote = address(new PlayDollar(sender)); // reverts off a test network, by design
        Parts parts = new Parts();
        Launcher launcher = new Launcher(
            admin,
            Launcher.Platform({
                quote: IERC20(quote),
                platform: platform,
                feeBps: uint16(feeBps),
                unit: uint32(unit),
                agentUsd: uint128(agentUsd)
            }),
            parts
        );
        // the switch is bound in the same broadcast as the Launcher's deployment: the Launcher accepts it from its deployer only,
        // once, in its first hour, so no project can have been launched before it
        HolderPause pauseImpl;
        if (holderPauseOn == 1) {
            pauseImpl = new HolderPause();
            launcher.bindPause(address(pauseImpl));
        }
        vm.stopBroadcast();

        d = Deployed({
            quote: quote,
            parts: address(parts),
            launcher: address(launcher),
            holderPause: address(pauseImpl),
            admin: admin,
            platform: platform,
            unit: unit,
            feeBps: feeBps
        });
        console2.log("chain id        ", block.chainid);
        console2.log("dollar (quote)  ", quote);
        console2.log("parts           ", address(parts));
        console2.log("launcher        ", address(launcher));
        console2.log("time unit (s)   ", unit);
        console2.log("holder pause    ", address(pauseImpl));
        if (address(pauseImpl) != address(0)) console2.logBytes32(address(pauseImpl).codehash);

        string memory key = "deployed";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "quote", quote);
        vm.serializeAddress(key, "parts", address(parts));
        vm.serializeAddress(key, "admin", admin);
        vm.serializeAddress(key, "platform", platform);
        vm.serializeUint(key, "unit", unit);
        vm.serializeUint(key, "feeBps", feeBps);
        vm.serializeAddress(key, "holderPause", address(pauseImpl));
        vm.serializeBytes32(key, "holderPauseCodehash", address(pauseImpl).codehash);
        string memory out = vm.serializeAddress(key, "launcher", address(launcher));
        vm.createDir("deployments", true);
        vm.writeJson(out, string.concat("deployments/pot-", vm.toString(block.chainid), ".json"));
    }
}
