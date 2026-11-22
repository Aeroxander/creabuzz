// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {PlayDollar} from "../src/PlayDollar.sol";
import {Parts} from "../src/Parts.sol";
import {Launcher} from "../src/Launcher.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {Council} from "../src/Council.sol";
import {EarlierGrants} from "../src/EarlierGrants.sol";

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
///   COUNCIL    0 (the default) or 1. With 1 (and HOLDER_PAUSE=1, which it needs: a Council reads its project's pause as its vote
///              contract) the script also deploys the `Council` implementation and binds it to the Launcher in the same broadcast,
///              before any project can be launched: a project's runner can then hand the seat to a Council of five accounts, three of
///              which must agree to every action (docs/next-version/COUNCIL-PLAN.md). It is a switch of the deployment: it cannot
///              be changed later. Off by default; with it off nothing about a project or the Launcher's behaviour differs.
///
///   EARLIER_*  the earlier backers' claim (docs/next-version/STEP4-PLAN.md, section 3). All six or none; none is the default and
///              then nothing is claimable. Set together they deploy `EarlierGrants` and bind it to the Launcher in the same
///              broadcast, before any project can be launched; the project named by EARLIER_FOUNDER and EARLIER_PROJECT_ID is
///              then born with an extra Team pool for the list. The list and the text are never in this repository: only their
///              fingerprints are given here.
///                EARLIER_ROOT         the list's fingerprint (a Merkle root, bytes32)
///                EARLIER_TEXT_HASH    the fingerprint of the text a claimant accepts (bytes32)
///                EARLIER_TOTAL        the pool in Team Share wei (the sum of the rows)
///                EARLIER_ROWS         the number of rows
///                EARLIER_FOUNDER      who will launch project zero
///                EARLIER_PROJECT_ID   the id project zero is launched under (bytes32)
///              A pool over the founder's Team pool limit (100,000,000 Shares) is refused unless EARLIER_ALLOW_LARGE=1, so a
///              pool that large is a stated choice. Any setting set without the others reverts before anything is sent.
///
/// Example (a local test chain): `UNIT=1680 forge script script/DeployPot.s.sol --rpc-url anvil --broadcast
/// --private-key <your key>`.
contract DeployPot is Script {
    /// @dev The founder's own Team pool limit (`Launcher.MAX_TEAM_POOL`): a larger earlier pool must be asked for on purpose.
    uint256 internal constant FOUNDER_POOL_CAP = 100_000_000e18;
    /// @dev The claim contract's own ceiling (`EarlierGrants.MAX_EARLIER_POOL`).
    uint256 internal constant MAX_EARLIER_POOL = 1_000_000_000e18;

    /// @notice What was deployed.
    struct Deployed {
        address quote;
        address parts;
        address launcher;
        address holderPause;
        address holderVote;
        address earlier;
        address council;
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
        uint256 councilOn = vm.envOr("COUNCIL", uint256(0));
        require(holderPauseOn <= 1, "HOLDER_PAUSE must be 0 or 1");
        require(councilOn <= 1, "COUNCIL must be 0 or 1");
        require(councilOn == 0 || holderPauseOn == 1, "COUNCIL=1 needs HOLDER_PAUSE=1");
        (
            bool earlierOn,
            bytes32 earlierKey,
            bytes32 earlierRoot,
            bytes32 earlierText,
            uint256 earlierTotal,
            uint256 earlierRows
        ) = _earlierSettings();

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
        HolderVote voteImpl;
        if (holderPauseOn == 1) {
            // with the Council switch on the project's pause is the vote contract (it is the custody the votes are counted in)
            if (councilOn == 1) {
                voteImpl = new HolderVote();
                pauseImpl = HolderPause(address(voteImpl));
            } else {
                pauseImpl = new HolderPause();
            }
            launcher.bindPause(address(pauseImpl));
        }
        Council councilImpl;
        if (councilOn == 1) {
            councilImpl = new Council();
            launcher.bindCouncil(address(councilImpl));
        }
        EarlierGrants claims;
        if (earlierOn) {
            claims = new EarlierGrants(
                address(launcher), earlierRoot, earlierText, earlierTotal, uint32(earlierRows), earlierKey
            );
            launcher.bindEarlier(address(claims));
        }
        vm.stopBroadcast();

        d = Deployed({
            quote: quote,
            parts: address(parts),
            launcher: address(launcher),
            holderPause: address(pauseImpl),
            holderVote: address(voteImpl),
            earlier: address(claims),
            council: address(councilImpl),
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
        console2.log("holder vote     ", address(voteImpl));
        console2.log("earlier grants  ", address(claims));
        console2.log("council         ", address(councilImpl));
        if (address(councilImpl) != address(0)) console2.logBytes32(address(councilImpl).codehash);

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
        vm.serializeAddress(key, "holderVote", address(voteImpl));
        if (address(voteImpl) != address(0)) {
            vm.serializeBytes32(key, "holderVoteCodehash", address(voteImpl).codehash);
        }
        vm.serializeAddress(key, "council", address(councilImpl));
        vm.serializeBytes32(key, "councilCodehash", address(councilImpl).codehash);
        vm.serializeAddress(key, "earlierGrants", address(claims));
        vm.serializeBytes32(key, "earlierKey", earlierOn ? earlierKey : bytes32(0));
        string memory out = vm.serializeAddress(key, "launcher", address(launcher));
        vm.createDir("deployments", true);
        vm.writeJson(out, string.concat("deployments/pot-", vm.toString(block.chainid), ".json"));
    }

    /// @dev The earlier-grant settings, all or none, checked before the broadcast starts. A setting left out reads as zero, so
    /// "set" means non-zero; one set without the rest, or a pool over the founder cap without EARLIER_ALLOW_LARGE=1, reverts.
    function _earlierSettings()
        internal
        view
        returns (bool on, bytes32 key, bytes32 root, bytes32 text, uint256 total, uint256 rows)
    {
        root = vm.envOr("EARLIER_ROOT", bytes32(0));
        text = vm.envOr("EARLIER_TEXT_HASH", bytes32(0));
        total = vm.envOr("EARLIER_TOTAL", uint256(0));
        rows = vm.envOr("EARLIER_ROWS", uint256(0));
        address founder = vm.envOr("EARLIER_FOUNDER", address(0));
        bytes32 projectId = vm.envOr("EARLIER_PROJECT_ID", bytes32(0));
        uint256 allowLarge = vm.envOr("EARLIER_ALLOW_LARGE", uint256(0));
        require(allowLarge <= 1, "EARLIER_ALLOW_LARGE must be 0 or 1");
        uint256 given = (root != 0 ? 1 : 0) + (text != 0 ? 1 : 0) + (total != 0 ? 1 : 0) + (rows != 0 ? 1 : 0)
            + (founder != address(0) ? 1 : 0) + (projectId != 0 ? 1 : 0);
        require(given == 0 || given == 6, "EARLIER settings: give all six or none");
        if (given == 0) return (false, 0, 0, 0, 0, 0);
        require(rows <= type(uint32).max, "EARLIER_ROWS too big");
        require(total <= MAX_EARLIER_POOL, "EARLIER_TOTAL is over the ceiling");
        require(
            total <= FOUNDER_POOL_CAP || allowLarge == 1, "EARLIER_TOTAL is over the founder cap: EARLIER_ALLOW_LARGE=1"
        );
        return (true, keccak256(abi.encode(founder, projectId)), root, text, total, rows);
    }
}
