// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Shares, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";
import {TreasuryMandateFactory} from "../src/TreasuryMandate.sol";

/// @notice Put the launch path on a chain that already has Uniswap's auction factory: our patched summoner (the one whose
/// Shares carry the milestone lock guard), the `DaoLaunchKit` that launches a DAO and its sale in one transaction, and the
/// `ContributorKit` that starts a contributor project (no sale, ready for work) on the same summoner, and the
/// `WorkAreaBounty` that holds outside money behind a work area of any work budget the summoner's factory makes (N1), and
/// the `OpenBounty` that holds money behind a post until someone's claim keeps a majority of it (N2). On a test network
/// it also makes test $CREATE and its faucet (N6), and the court that bounties on posts appeal to (N7).
///
/// Nothing else is deployed: the auction factory, Permit2 and the sale currency are the chain's own. The script refuses
/// to run where the factory has no code, and it checks the Shares implementation it computes really exists before it
/// deploys the kit that names it, so a wrong address cannot reach the chain.
///
/// Run (a rehearsal on a fork first; `scripts/sepolia-deploy.sh` does both):
///   PRIVATE_KEY=0x… forge script script/DeployLaunchKit.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
/// Env: PRIVATE_KEY (the deployer, a testnet key), CCA_FACTORY (default: the canonical factory, the same address on every
/// chain), BOUNTY_CURRENCY (what bounties and weekly rounds are paid in; default on Sepolia: Circle's USDC there,
/// required elsewhere),
/// LAUNCH_PROJECT (a label for the manifest).
contract DeployLaunchKit is Script {
    /// @dev Uniswap's continuous clearing auction factory v2.1.0: one address on every EVM chain.
    address internal constant CANONICAL_CCA_FACTORY = 0x000000001F26a0044BaA66024e7b6599c61963F8;
    uint256 internal constant SEPOLIA = 11155111;
    /// @dev Circle's USDC on Sepolia (the same address `scripts/lib/sepolia-fork.sh` funds).
    address internal constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    /// @dev The test court's settings: 100 $CREATE per seat, 1 USDC per seat per round.
    uint256 internal constant SEAT_STAKE = 100e18;
    uint256 internal constant FEE_PER_SEAT = 1e6;

    string[] internal roleNames;
    address[] internal roleAddresses;

    function run() external returns (address summoner, address sharesImplementation, address kit) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address ccaFactory = vm.envOr("CCA_FACTORY", CANONICAL_CCA_FACTORY);
        require(ccaFactory.code.length != 0, "DeployLaunchKit: no auction factory on this chain");
        address bountyCurrency = bountyCurrencyFor(block.chainid, vm.envOr("BOUNTY_CURRENCY", address(0)));
        require(bountyCurrency != address(0), "DeployLaunchKit: set BOUNTY_CURRENCY (what bounties are paid in)");
        require(bountyCurrency.code.length != 0, "DeployLaunchKit: no bounty currency at that address");

        // The summoner's constructor announces the Moloch implementation it made (`NewDAO(summoner, implementation)`),
        // which is where the Shares implementation comes from.
        vm.recordLogs();
        vm.startBroadcast(pk);
        Summoner made = newSummoner();
        summoner = address(made);
        address molochImplementation = _implementationFromLog(summoner);
        sharesImplementation = sharesImplementationOf(molochImplementation);
        require(sharesImplementation.code.length != 0, "DeployLaunchKit: the Shares implementation has no code");
        // The lock factories go beside the kit, which names them (its creation code has no room to carry them).
        address lockFactory = vm.deployCode("MilestoneLockFactory.sol:MilestoneLockFactory");
        address challengeFactory = vm.deployCode("MilestoneChallengeFactory.sol:MilestoneChallengeFactory");
        kit = vm.deployCode(
            "DaoLaunchKit.sol:DaoLaunchKit",
            abi.encode(summoner, ccaFactory, sharesImplementation, lockFactory, challengeFactory)
        );
        address contributorKit = vm.deployCode("ContributorKit.sol:ContributorKit", abi.encode(summoner));
        address workBounty =
            vm.deployCode("WorkAreaBounty.sol:WorkAreaBounty", abi.encode(bountyCurrency, made.mandateFactory()));
        // A test network gets a test $CREATE, its faucet (N6) and the court that stakes it (N7); this script never makes a
        // real one. Bounties on posts name the court, so their claimants can appeal.
        (address createToken, address createFaucet) =
            isTestNetwork(block.chainid) ? _deployTestCreate(vm.addr(pk)) : (address(0), address(0));
        address court = createToken == address(0)
            ? address(0)
            : vm.deployCode(
                "CreateCourt.sol:CreateCourt", abi.encode(createToken, bountyCurrency, SEAT_STAKE, FEE_PER_SEAT)
            );
        address openBounty = vm.deployCode("OpenBounty.sol:OpenBounty", abi.encode(bountyCurrency, court));
        // Payouts to holders (N10) need counsel before any real money: test networks only. The DAOs accept modules only
        // from the factory their work budget factory made, so that is the one the app is told of.
        address payoutsFactory =
            court == address(0) ? address(0) : address(TreasuryMandateFactory(made.mandateFactory()).payoutsFactory());
        // A remix's bond to its parent (N12), cased in the court: test networks only.
        address remixBonds =
            court == address(0) ? address(0) : vm.deployCode("RemixBond.sol:RemixBond", abi.encode(createToken, court));
        // Weekly rounds between holders and new buyers: test networks only. Its smallest price step is one cent a unit.
        address weeklyRounds = court == address(0)
            ? address(0)
            : vm.deployCode(
                "WeeklyRounds.sol:WeeklyRounds",
                abi.encode(bountyCurrency, 10 ** (uint256(IERC20Metadata(bountyCurrency).decimals()) - 2))
            );
        vm.stopBroadcast();
        require(kit.code.length != 0, "DeployLaunchKit: the kit has no code");
        require(contributorKit.code.length != 0, "DeployLaunchKit: the contributor kit has no code");
        require(workBounty.code.length != 0, "DeployLaunchKit: the work bounty has no code");
        require(openBounty.code.length != 0, "DeployLaunchKit: the open bounty has no code");

        console2.log("chain id:", block.chainid);
        _role("summoner", "Summoner", summoner);
        _role("moloch-implementation", "Moloch implementation", molochImplementation);
        _role("shares-implementation", "Shares implementation", sharesImplementation);
        _role("launch-kit", "DaoLaunchKit", kit);
        _role("contributor-kit", "ContributorKit", contributorKit);
        _role("work-bounty", "WorkAreaBounty", workBounty);
        _role("open-bounty", "OpenBounty", openBounty);
        if (createToken != address(0)) {
            _role("create-token", "CreateToken", createToken);
            _role("create-faucet", "CreateFaucet", createFaucet);
            _role("court", "CreateCourt", court);
            _role("payouts-factory", "PayoutsFactory", payoutsFactory);
            _role("remix-bonds", "RemixBond", remixBonds);
            _role("weekly-rounds", "WeeklyRounds", weeklyRounds);
        }
        _role("auction-factory", "Auction factory", ccaFactory);
        _writeManifest();
    }

    /// @notice A test network: Sepolia, or a local chain. Only these get test $CREATE.
    function isTestNetwork(uint256 chainId) public pure returns (bool) {
        return chainId == SEPOLIA || chainId == 31337;
    }

    /// @dev Test $CREATE: the whole supply is minted to the deployer and moved at once into the faucet, which has no
    /// owner, so nobody holds any but what the faucet hands out.
    function _deployTestCreate(address deployer) internal returns (address token, address faucet) {
        token = vm.deployCode("CreateToken.sol:CreateToken", abi.encode("Test CREATE", "tCREATE", deployer));
        faucet = vm.deployCode("CreateFaucet.sol:CreateFaucet", abi.encode(token));
        IERC20(token).transfer(faucet, IERC20(token).totalSupply());
        require(
            IERC20(token).balanceOf(faucet) == IERC20(token).totalSupply(), "DeployLaunchKit: the faucet holds less"
        );
    }

    /// @notice What bounties are paid in on `chainId`: the named currency, else Circle's USDC on Sepolia, else none (the
    /// script then refuses: a bounty currency is never guessed).
    function bountyCurrencyFor(uint256 chainId, address named) public pure returns (address) {
        if (named != address(0)) return named;
        return chainId == SEPOLIA ? SEPOLIA_USDC : address(0);
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
    /// needs to be checked later (who the kit points at), in the order they were recorded.
    function _writeManifest() internal {
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
        string memory path = string.concat("deployments/dao-launch-kit-", vm.toString(block.chainid), ".json");
        vm.writeFile(
            path,
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"project":"',
                vm.envOr("LAUNCH_PROJECT", string("creaton")),
                '","note":"forge script script/DeployLaunchKit.s.sol --broadcast","block":',
                vm.toString(block.number),
                ',"roles":[',
                roles,
                "]}"
            )
        );
    }

    /// @dev Record a deployed contract for the manifest and say where it is.
    function _role(string memory role, string memory label, address at) internal {
        roleNames.push(role);
        roleAddresses.push(at);
        console2.log(string.concat(label, ":"), at);
    }
}
