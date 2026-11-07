// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ContributorKit} from "../src/ContributorKit.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {TreasuryMandateFactory} from "../src/TreasuryMandate.sol";

/// @title LaunchV5TrialProject
/// @notice Starts ONE trial project through `ContributorKitV2.launch` from the broadcasting wallet, which becomes the
/// founder. For a wallet-sent launch (a normal account with a live gas estimate); the web Start form is the other
/// path. The kit, the work budget factory behind it and the free-mint test token are read from
/// `deployments/v5-sepolia-11155111.json` (written by `DeployV5Sepolia`), so a launch cannot name a kit the deploy
/// did not make.
///
/// Defaults are a safe trial: trading in the free test token, a lot of 0.01 Share, a sale schedule that starts at the
/// launch with no cliff and unlocks over 180 days, one reviewer (so a quorum of one), one first project.
///
/// Env: PRIVATE_KEY (the founder's testnet key; from the environment only), TRIAL_REVIEWER (required: another person's
/// address; the kit refuses the founder as a reviewer, and so does this script before sending anything).
/// Optional: TRIAL_NAME, TRIAL_SYMBOL, TRIAL_SALT (default: a hash of the name and the clock), TRIAL_QUOTE (default:
/// the test token), TRIAL_LOT_SIZE (default 1e16), TRIAL_SALE_START (default 0 = at the launch), TRIAL_SALE_CLIFF
/// (default 0), TRIAL_SALE_DURATION (default 180 days), TRIAL_CURRENCY (what claims name for a deposit; default
/// Circle's USDC on Sepolia), TRIAL_FOUNDER_SHARES / TRIAL_BUDGET_SHARES / TRIAL_PROJECT_SHARES (whole Shares;
/// default 100000 / 300000 / 25000, the Start form's own), TRIAL_MANIFEST (default the Sepolia V5 manifest).
///
/// Prints the launch's gas as measured in the simulation, the kit's address and the exact calldata (`LAUNCH_CALLDATA`),
/// so a wrapper can run `eth_estimateGas` on it before anything is sent.
contract LaunchV5TrialProject is Script {
    uint256 internal constant MAX_ROLES = 32;
    address internal constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    uint256 internal constant SHARE_UNIT = 1e18;
    uint64 internal constant BUDGET_DAYS = 90 days;
    /// @dev The EIP-7825 per-transaction cap (2**24): reported beside the measured gas, never silently assumed.
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address founder = vm.addr(pk);
        address reviewer = vm.envOr("TRIAL_REVIEWER", address(0));
        require(reviewer != address(0), "LaunchV5TrialProject: set TRIAL_REVIEWER (someone other than the founder)");
        require(reviewer != founder, "LaunchV5TrialProject: the reviewer must not be the founder");

        string memory manifest = vm.readFile(
            vm.envOr("TRIAL_MANIFEST", string.concat("deployments/v5-sepolia-", vm.toString(block.chainid), ".json"))
        );
        ContributorKitV2 kit = ContributorKitV2(_role(manifest, "contributor-kit-v2"));
        address quote = vm.envOr("TRIAL_QUOTE", address(0));
        if (quote == address(0)) quote = _role(manifest, "test-quote-token");
        require(address(kit).code.length != 0, "LaunchV5TrialProject: no kit at the manifest's address");
        require(quote.code.length != 0, "LaunchV5TrialProject: no token at the quote address");

        ContributorKitV2.LaunchParams memory p = _params(founder, reviewer, quote);
        // The budget factory makes each budget with a plain CREATE: its next slot is read just before sending.
        TreasuryMandateFactory budgets = kit.budgetFactory();
        p.base.predictedBudget = vm.computeCreateAddress(address(budgets), vm.getNonce(address(budgets)));

        (address expectedDao,, address expectedPolicy, address expectedMarket) =
            kit.predictLaunch(founder, p.base.founderShares, p.base.salt, p.quote, p.lotSize);

        console2.log("kit:", address(kit));
        console2.log("founder:", founder);
        console2.log("reviewer:", reviewer);
        console2.log("quote token:", quote);
        console2.log("predicted dao:", expectedDao);
        console2.log("predicted market:", expectedMarket);
        console2.log("LAUNCH_CALLDATA", vm.toString(abi.encodeCall(ContributorKitV2.launch, (p))));

        vm.startBroadcast(pk);
        uint256 gasBefore = gasleft();
        (address dao, address budget, address policy) = kit.launch(p);
        uint256 used = gasBefore - gasleft();
        vm.stopBroadcast();

        require(dao == expectedDao && policy == expectedPolicy, "LaunchV5TrialProject: the launch is not as predicted");
        require(dao.code.length != 0 && budget.code.length != 0, "LaunchV5TrialProject: the launch left no code");
        console2.log("dao:", dao);
        console2.log("budget:", budget);
        console2.log("policy:", policy);
        console2.log("market:", expectedMarket);
        console2.log("launch gas (simulation):", used);
        console2.log("per-transaction cap (EIP-7825):", TX_GAS_CAP);
        console2.log(used <= TX_GAS_CAP ? "launch is under the cap" : "launch is OVER the cap");
    }

    function _params(address founder, address reviewer, address quote)
        internal
        view
        returns (ContributorKitV2.LaunchParams memory p)
    {
        string memory name = vm.envOr("TRIAL_NAME", string("Creaton trial project"));
        uint64 expires = uint64(block.timestamp) + BUDGET_DAYS;

        address[] memory reviewers = new address[](1);
        reviewers[0] = reviewer;
        ContributorKit.FirstProject[] memory projects = new ContributorKit.FirstProject[](1);
        projects[0] = ContributorKit.FirstProject({
            id: keccak256("work-area:trial"),
            manager: founder,
            shares: uint128(vm.envOr("TRIAL_PROJECT_SHARES", uint256(25_000)) * SHARE_UNIT),
            expires: expires,
            check: keccak256("trial work merged and reviewed")
        });

        p.base = ContributorKit.Params({
            name: name,
            symbol: vm.envOr("TRIAL_SYMBOL", string("TRIAL")),
            founderShares: vm.envOr("TRIAL_FOUNDER_SHARES", uint256(100_000)) * SHARE_UNIT,
            salt: vm.envOr("TRIAL_SALT", keccak256(abi.encode(name, block.timestamp, founder))),
            currency: vm.envOr("TRIAL_CURRENCY", SEPOLIA_USDC),
            shareBudget: uint128(vm.envOr("TRIAL_BUDGET_SHARES", uint256(300_000)) * SHARE_UNIT),
            shareCap: uint128(vm.envOr("TRIAL_PROJECT_SHARES", uint256(25_000)) * SHARE_UNIT),
            budgetExpires: expires,
            reviewers: reviewers,
            quorum: 1,
            predictedBudget: address(0), // filled just before sending
            projects: projects
        });
        p.saleStart = uint64(vm.envOr("TRIAL_SALE_START", uint256(0)));
        p.saleCliff = uint64(vm.envOr("TRIAL_SALE_CLIFF", uint256(0)));
        p.saleDuration = uint64(vm.envOr("TRIAL_SALE_DURATION", uint256(180 days)));
        p.quote = quote;
        p.lotSize = vm.envOr("TRIAL_LOT_SIZE", uint256(1e16));
    }

    /// @dev One role's address from the manifest, reading at most MAX_ROLES entries.
    function _role(string memory manifest, string memory role) internal view returns (address) {
        for (uint256 i; i < MAX_ROLES; ++i) {
            string memory key = string.concat(".roles[", vm.toString(i), "]");
            if (!vm.keyExistsJson(manifest, key)) break;
            if (keccak256(bytes(vm.parseJsonString(manifest, string.concat(key, ".role")))) == keccak256(bytes(role))) {
                return vm.parseJsonAddress(manifest, string.concat(key, ".address"));
            }
        }
        revert(string.concat("LaunchV5TrialProject: the manifest has no ", role));
    }
}
