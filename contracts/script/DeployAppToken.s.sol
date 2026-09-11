// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {DeploymentParameters, PoolDeploymentParameters, SignatureECDSA} from "tm-tokenmaster/DataTypes.sol";
import {ITokenMasterRouter} from "tm-tokenmaster/interfaces/ITokenMasterRouter.sol";
import {
    StandardPoolBuyParameters,
    StandardPoolInitializationParameters,
    StandardPoolSellParameters,
    StandardPoolSpendParameters
} from "tm-tokenmaster/pools/standard-token-pool/DataTypes.sol";
import {StandardPoolFactory} from "tm-tokenmaster/pools/standard-token-pool/StandardPoolFactory.sol";

/// @notice Minimal Transfer Validator surface: collection ruleset only.
/// Depending on the full implementation drags version-skewed transitive deps
/// into the build; the canonical address + selector are stable across versions.
interface IRouterInfraFee {
    function infrastructureFeeBPS() external view returns (uint16);
}

error NotTreasuryBroadcaster(address caller);

interface IToken {
    function setTransferValidator(address validator) external;
}

interface IValidatorRuleset {
    function setRulesetOfCollection(
        address collection,
        uint8 rulesetId,
        address customRuleset,
        uint8 globalOptions,
        uint16 rulesetOptions
    ) external;
}

/// @notice Deploy a Standard-pool apptoken (ERC-20C, native pairing).
///
/// All params via env (defaults = local/dev):
/// APPTOKEN_NAME, APPTOKEN_SYMBOL, APPTOKEN_SALT (default 1),
/// APPTOKEN_TREASURY (owner + initial supply recipient),
/// APPTOKEN_INITIAL_SUPPLY (whole tokens, default 1000000),
/// APPTOKEN_ROUTER (default TokenMaster router),
/// APPTOKEN_STANDARD_FACTORY, APPTOKEN_TV,
/// APPTOKEN_BUY_FEE_BPS / APPTOKEN_SELL_FEE_BPS (default 200),
/// APPTOKEN_SPREAD_BPS (default 100).
///
/// Flow: compute deterministic address → router.deployToken (empty signature,
/// permissionless on fresh/local deployments) → Vanilla validator ruleset
/// (open trading; tighten later via the validator) → log AppTokenDeployed.
///
/// Emits a single `AppTokenDeployed(address)` log the CLI parses.
contract DeployAppToken is Script {
    event AppTokenDeployed(address indexed token);

    function run() external returns (address token) {
        string memory name = vm.envString("APPTOKEN_NAME");
        string memory symbol = vm.envString("APPTOKEN_SYMBOL");
        uint256 salt = vm.envOr("APPTOKEN_SALT", uint256(1));
        address treasury = vm.envAddress("APPTOKEN_TREASURY");
        uint256 initialSupply = vm.envOr("APPTOKEN_INITIAL_SUPPLY", uint256(1_000_000)) * 1e18;
        // Native pairing requires a nonzero initial deposit (the pool's
        // starting reserve). Funded by the broadcaster as msg.value.
        uint256 pairedDeposit = vm.envOr("APPTOKEN_PAIRED_DEPOSIT_WEI", uint256(0.1 ether));
        address router = vm.envOr("APPTOKEN_ROUTER", address(0x0E00009d00d1000069ed00A908e00081F5006008));
        address factory = vm.envOr("APPTOKEN_STANDARD_FACTORY", address(0x000000c5F2DF717F497BeAcCE161F8b042310d17));
        // Default: no validator at construction so the initial mint is
        // open. The script wires the canonical TV + Vanilla ruleset right
        // after deploy (broadcaster must equal treasury — true for every
        // local flow; production uses explicit owner ops). Pass APPTOKEN_TV
        // to pin a specific validator.
        address tv = vm.envOr("APPTOKEN_TV", address(0));
        uint16 buyFee = uint16(vm.envOr("APPTOKEN_BUY_FEE_BPS", uint256(200)));
        uint16 sellFee = uint16(vm.envOr("APPTOKEN_SELL_FEE_BPS", uint256(200)));
        uint16 spread = uint16(vm.envOr("APPTOKEN_SPREAD_BPS", uint256(100)));

        PoolDeploymentParameters memory poolParams = PoolDeploymentParameters({
            name: name,
            symbol: symbol,
            tokenDecimals: 18,
            initialOwner: treasury,
            pairedToken: address(0),
            initialPairedTokenToDeposit: pairedDeposit,
            encodedInitializationArgs: abi.encode(
                StandardPoolInitializationParameters({
                    initialSupplyRecipient: treasury,
                    initialSupplyAmount: initialSupply,
                    minBuySpreadBPS: 0,
                    maxBuySpreadBPS: 9999,
                    maxBuyFeeBPS: 10_000,
                    maxBuyDemandFeeBPS: 10_000,
                    minSellSpreadBPS: 0,
                    maxSellSpreadBPS: 9999,
                    maxSellFeeBPS: 10_000,
                    maxSpendCreatorShareBPS: 10_000,
                    creatorEmissionRateNumerator: 0,
                    creatorEmissionRateDenominator: 1,
                    creatorEmissionsHardCap: 0,
                    initialBuyParameters: StandardPoolBuyParameters({
                        buySpreadBPS: spread,
                        buyFeeBPS: buyFee,
                        buyCostPairedTokenNumerator: 1e18,
                        buyCostPoolTokenDenominator: 1e18,
                        useTargetSupply: false,
                        reserved: 0,
                        buyDemandFeeBPS: 0,
                        targetSupplyBaseline: 0,
                        targetSupplyBaselineScaleFactor: 0,
                        targetSupplyGrowthRatePerSecond: 0,
                        targetSupplyBaselineTimestamp: 0
                    }),
                    initialSellParameters: StandardPoolSellParameters({sellSpreadBPS: spread, sellFeeBPS: sellFee}),
                    initialSpendParameters: StandardPoolSpendParameters({creatorShareBPS: 5000}),
                    initialPausedState: 0
                })
            ),
            defaultTransferValidator: tv,
            useRouterForPairedTransfers: false,
            partnerFeeRecipient: address(0),
            partnerFeeBPS: 0
        });

        uint256 liveInfraFee = IRouterInfraFee(router).infrastructureFeeBPS();
        token = StandardPoolFactory(factory)
            .computeDeploymentAddress(bytes32(salt), poolParams, pairedDeposit, liveInfraFee);

        DeploymentParameters memory deployParams = DeploymentParameters({
            tokenFactory: factory,
            tokenSalt: bytes32(salt),
            tokenAddress: token,
            blockTransactionsFromUntrustedChannels: false,
            restrictPairingToLists: false,
            poolParams: poolParams,
            maxInfrastructureFeeBPS: 250
        });

        vm.startBroadcast();
        ITokenMasterRouter(router).deployToken{value: pairedDeposit}(
            deployParams, SignatureECDSA({v: 0, r: bytes32(0), s: bytes32(0)})
        );
        address realTV = tv == address(0) ? address(0x721C008fdff27BF06E7E123956E2Fe03B63342e3) : tv;
        // Wire the canonical validator + Vanilla ruleset (1: open trading).
        // Requires broadcaster == treasury (collection owner).
        if (treasury != msg.sender) revert NotTreasuryBroadcaster(msg.sender);
        IToken(token).setTransferValidator(realTV);
        IValidatorRuleset(realTV).setRulesetOfCollection(token, 1, address(0), 0, 0);
        vm.stopBroadcast();
        emit AppTokenDeployed(token);
        // Machine-readable handoff for the CLI (script emits never land in
        // broadcast receipts). Overwritten on every successful deploy.
        vm.writeFile(
            "deployments/apptoken-latest.json",
            string.concat('{"token":"', vm.toString(token), '","name":"', name, '","symbol":"', symbol, '"}')
        );
    }
}
