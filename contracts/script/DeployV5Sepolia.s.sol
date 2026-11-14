// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {TestQuoteToken} from "../src/TestQuoteToken.sol";
import {WorkAreaBounty} from "../src/WorkAreaBounty.sol";
import {Summoner} from "../src/majeur/MolochPatched.sol";
import {TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {PayoutsFactory} from "../src/Payouts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title DeployV5Sepolia
/// @notice Puts the weekly-sale contract set on Sepolia, beside (never over) the 5 Nov deploy: a new work budget
/// factory, the voting policy and summoner that sit on it, the secondary market factory, the creation-version kit
/// (`ContributorKitV2`), a NEW work bounty and the payouts factory the new work budget factory made, and a free-mint
/// test token to trade in. The 5 Nov summoner cannot be reused: its voting policy is the old one, and the kit refuses
/// any policy that does not report the secondary version. A DAO accepts payout modules and bounties only from the
/// factory of its own work budget factory, so the bounty and payouts factory are new too. The court, test $CREATE and
/// its faucet, the open bounty and the remix bonds name none of these and stay as the 5 Nov manifest has them.
///
/// Order, one transaction each from one deployer, exactly as `V5LocalFixture` does it:
///   1. TreasuryMandateFactory   2. ActivationVoting(factory)   3. Summoner(policy)
///   4. predict the kit from the deployer's next-but-one nonce
///   5. SecondaryMarketFactory(summoner, predictedKit)   6. ContributorKitV2(summoner, marketFactory)
/// Nothing else may be sent by the deployer between 5 and 6: the kit refuses a factory that was authorised for
/// another address, so a stray transaction only wastes the factory. Then the work bounty and the test token.
///
/// Writes `deployments/v5-sepolia-11155111.json` (not ignored: commit it). `scripts/sepolia-deploy-v5.sh` rehearses
/// this on a Sepolia fork (same chain id, so the guard holds there too), restores the repo, and does the same on
/// the real network with `--broadcast`.
///
/// Env: PRIVATE_KEY (the deployer: a testnet-only key; the wrapper passes DEPLOYER_PRIVATE_KEY through the
/// environment, never on a command line).
contract DeployV5Sepolia is Script {
    uint256 internal constant SEPOLIA = 11155111;
    /// @dev Circle's USDC on Sepolia: what work bounties are paid in (same as DeployLaunchKit).
    address internal constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    string[] internal roleNames;
    address[] internal roleAddresses;

    function run() external {
        require(block.chainid == SEPOLIA, "DeployV5Sepolia: Sepolia only (chain id 11155111)");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        require(SEPOLIA_USDC.code.length != 0, "DeployV5Sepolia: no USDC at the expected Sepolia address");
        uint256 startBlock = block.number;

        vm.startBroadcast(pk);
        TreasuryMandateFactory mandateFactory = new TreasuryMandateFactory();
        ActivationVoting policyImplementation = new ActivationVoting(mandateFactory);
        Summoner summoner = new Summoner(address(policyImplementation));
        // The market factory is born authorised for exactly the address the kit will land on, so that address
        // is predicted before the factory takes the nonce below it.
        address predictedKit = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        SecondaryMarketFactory marketFactory = new SecondaryMarketFactory(summoner, predictedKit);
        ContributorKitV2 kit = new ContributorKitV2(summoner, marketFactory);
        // After the kit, so nothing can come between the factory and the kit.
        WorkAreaBounty workBounty = new WorkAreaBounty(IERC20(SEPOLIA_USDC), mandateFactory);
        PayoutsFactory payoutsFactory = mandateFactory.payoutsFactory();
        TestQuoteToken testToken = new TestQuoteToken();
        vm.stopBroadcast();

        require(address(kit) == predictedKit, "DeployV5Sepolia: the kit did not land on the predicted address");
        _requireCode(address(mandateFactory), "mandate factory");
        _requireCode(address(policyImplementation), "policy implementation");
        _requireCode(address(summoner), "summoner");
        _requireCode(address(marketFactory), "market factory");
        _requireCode(address(kit), "kit");
        _requireCode(address(workBounty), "work bounty");
        _requireCode(address(payoutsFactory), "payouts factory");
        _requireCode(address(testToken), "test token");
        require(marketFactory.authorizedKit() == address(kit), "DeployV5Sepolia: factory authorised another kit");
        require(kit.marketFactory() == marketFactory, "DeployV5Sepolia: kit pins another factory");
        require(
            address(marketFactory.summoner()) == address(summoner), "DeployV5Sepolia: factory pins another summoner"
        );
        require(address(kit.summoner()) == address(summoner), "DeployV5Sepolia: kit pins another summoner");
        require(summoner.mandateFactory() == address(mandateFactory), "DeployV5Sepolia: summoner on another factory");
        require(address(workBounty.factory()) == address(mandateFactory), "DeployV5Sepolia: bounty on another factory");

        console2.log("chain id:", block.chainid);
        _role("mandate-factory", "TreasuryMandateFactory", address(mandateFactory));
        _role("activation-voting-implementation", "ActivationVoting", address(policyImplementation));
        _role("summoner", "Summoner", address(summoner));
        _role("market-factory", "SecondaryMarketFactory", address(marketFactory));
        _role("contributor-kit-v2", "ContributorKitV2", address(kit));
        _role("work-bounty", "WorkAreaBounty", address(workBounty));
        _role("payouts-factory", "PayoutsFactory", address(payoutsFactory));
        _role("test-quote-token", "TestQuoteToken", address(testToken));
        _writeManifest(startBlock);
    }

    /// @dev The manifest, in the shape `DeployLaunchKit` writes. `block` is the chain's head when the script began, so
    /// it is at or before every deployment here: a safe place to start reading this set's history.
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
        string memory path = string.concat("deployments/v5-sepolia-", vm.toString(block.chainid), ".json");
        vm.writeFile(
            path,
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"project":"creaton","note":"forge script script/DeployV5Sepolia.s.sol --broadcast (weekly-sale set: new work budget factory, summoner, kit V2, work bounty, payouts factory, free-mint test token)","block":',
                vm.toString(startBlock),
                ',"roles":[',
                roles,
                "]}"
            )
        );
    }

    function _role(string memory role, string memory label, address at) internal {
        roleNames.push(role);
        roleAddresses.push(at);
        console2.log(string.concat(label, ":"), at);
    }

    function _requireCode(address target, string memory label) private view {
        require(target.code.length != 0, string.concat("DeployV5Sepolia: no code at the ", label));
    }
}
