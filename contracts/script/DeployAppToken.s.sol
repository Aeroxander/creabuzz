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

/// @notice An env fee/spread/share is above the conservative ceiling.
error AboveCeiling(string what, uint256 value, uint256 ceiling);

/// @notice An env name/symbol contains a quote, backslash, or control
/// character and would corrupt the raw string interpolation of
/// `deployments/apptoken-latest.json`.
error JsonUnsafeString(string what, string value);

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
/// APPTOKEN_TREASURY (initial supply recipient; the broadcaster),
/// APPTOKEN_OWNER (token/pool owner, default = APPTOKEN_TREASURY; set it to the
///   DAO to hand the fee levers over — see "Ownership" below),
/// APPTOKEN_INITIAL_SUPPLY (whole tokens, default 1000000),
/// APPTOKEN_ROUTER (default TokenMaster router),
/// APPTOKEN_STANDARD_FACTORY, APPTOKEN_TV,
/// APPTOKEN_BUY_FEE_BPS / APPTOKEN_SELL_FEE_BPS (default 200),
/// APPTOKEN_SPREAD_BPS (default 100).
///
/// SAFE DEFAULTS (docs/dao-os.md R4). The pool's `max*` guardrails are IMMUTABLE:
/// whoever owns the token can move fees/spreads anywhere below them and never
/// above. They used to be 10_000 / 9999 (i.e. "owner may charge a 100% fee on
/// every sell") — a rug-capable configuration. They are now capped at
/// {MAX_FEE_BPS} = {MAX_SPREAD_BPS} = 1_000 bps (10%) and the creator's spend
/// share at {MAX_SPEND_CREATOR_SHARE_BPS} = 5_000 (the initial share, so it
/// can be lowered but never raised). The env fee/spread values must sit at or
/// below these ceilings (the script reverts otherwise).
///
/// Ownership. `initialOwner` is `APPTOKEN_OWNER` (default the treasury). Wiring
/// the transfer validator + Vanilla ruleset is an owner op, so the script does
/// it only when the owner IS the broadcaster; when `APPTOKEN_OWNER` names
/// another address (the DAO) the script deploys the token and stops — the owner
/// then wires the validator itself. To hand an existing treasury-owned token to
/// the DAO after graduation, call `transferOwnership(dao)` on the token.
///
/// Flow: compute deterministic address → router.deployToken (empty signature,
/// permissionless on fresh/local deployments) → Vanilla validator ruleset
/// (open trading; tighten later via the validator) → log AppTokenDeployed.
///
/// Emits a single `AppTokenDeployed(address)` log the CLI parses.
contract DeployAppToken is Script {
    event AppTokenDeployed(address indexed token);

    /// @notice Immutable pool ceilings for buy/sell fees, buy demand fee and
    /// buy/sell spreads: 10%. Mirrored by desktop `evmCalls.ts` and web
    /// `mint-tx.ts` (pinned by their tests).
    uint256 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MAX_SPREAD_BPS = 1_000;
    /// @notice Immutable ceiling on the creator's share of spent value. Equal to
    /// the initial share: it can be lowered, never raised.
    uint256 public constant MAX_SPEND_CREATOR_SHARE_BPS = 5_000;
    uint256 public constant INITIAL_SPEND_CREATOR_SHARE_BPS = 5_000;

    /// @notice The `StandardPoolInitializationParameters` this script deploys,
    /// with the conservative ceilings above. Public so the guardrails are
    /// testable against the real TokenMaster `StandardPool`.
    function initializationParameters(
        address supplyRecipient,
        uint256 initialSupply,
        uint16 spread,
        uint16 buyFee,
        uint16 sellFee
    ) public pure returns (StandardPoolInitializationParameters memory) {
        if (spread > MAX_SPREAD_BPS) revert AboveCeiling("spread", spread, MAX_SPREAD_BPS);
        if (buyFee > MAX_FEE_BPS) revert AboveCeiling("buyFee", buyFee, MAX_FEE_BPS);
        if (sellFee > MAX_FEE_BPS) revert AboveCeiling("sellFee", sellFee, MAX_FEE_BPS);
        return StandardPoolInitializationParameters({
            initialSupplyRecipient: supplyRecipient,
            initialSupplyAmount: initialSupply,
            minBuySpreadBPS: 0,
            maxBuySpreadBPS: MAX_SPREAD_BPS,
            maxBuyFeeBPS: MAX_FEE_BPS,
            maxBuyDemandFeeBPS: MAX_FEE_BPS,
            minSellSpreadBPS: 0,
            maxSellSpreadBPS: MAX_SPREAD_BPS,
            maxSellFeeBPS: MAX_FEE_BPS,
            maxSpendCreatorShareBPS: MAX_SPEND_CREATOR_SHARE_BPS,
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
            initialSpendParameters: StandardPoolSpendParameters({
                creatorShareBPS: uint16(INITIAL_SPEND_CREATOR_SHARE_BPS)
            }),
            initialPausedState: 0
        });
    }

    /// @notice Revert unless `value` is safe for raw string interpolation into
    /// the deployments JSON below: no quote, backslash, or control character.
    /// Public so the guardrail is testable without env plumbing.
    function requireJsonSafe(string memory what, string memory value) public pure {
        bytes memory raw = bytes(value);
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];
            // 0x7f is legal in a JSON string; < 0x20 is not.
            if (c == '"' || c == "\\" || uint8(c) < 0x20) revert JsonUnsafeString(what, value);
        }
    }

    function run() external returns (address token) {
        string memory name = vm.envString("APPTOKEN_NAME");
        string memory symbol = vm.envString("APPTOKEN_SYMBOL");
        // The deployments JSON at the end interpolates name/symbol raw —
        // reject anything that would corrupt it instead of writing a broken
        // file the CLI must parse.
        requireJsonSafe("APPTOKEN_NAME", name);
        requireJsonSafe("APPTOKEN_SYMBOL", symbol);
        uint256 salt = vm.envOr("APPTOKEN_SALT", uint256(1));
        address treasury = vm.envAddress("APPTOKEN_TREASURY");
        // The token/pool owner (holder of the fee levers, below the immutable
        // ceilings). Defaults to the treasury; pass the DAO to hand it over.
        address owner = vm.envOr("APPTOKEN_OWNER", treasury);
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
        // Validate the FULL env range before the uint16 narrowing: a bare
        // uint16 cast silently truncates values above 65_535 (65_736 would
        // become 200), slipping past the MAX_* ceiling check inside
        // `initializationParameters`. MAX_* < 65_536, so a value that passes
        // these checks is also safe to narrow.
        uint256 buyFeeBps = vm.envOr("APPTOKEN_BUY_FEE_BPS", uint256(200));
        uint256 sellFeeBps = vm.envOr("APPTOKEN_SELL_FEE_BPS", uint256(200));
        uint256 spreadBps = vm.envOr("APPTOKEN_SPREAD_BPS", uint256(100));
        if (spreadBps > MAX_SPREAD_BPS) revert AboveCeiling("spread", spreadBps, MAX_SPREAD_BPS);
        if (buyFeeBps > MAX_FEE_BPS) revert AboveCeiling("buyFee", buyFeeBps, MAX_FEE_BPS);
        if (sellFeeBps > MAX_FEE_BPS) revert AboveCeiling("sellFee", sellFeeBps, MAX_FEE_BPS);
        uint16 buyFee = uint16(buyFeeBps);
        uint16 sellFee = uint16(sellFeeBps);
        uint16 spread = uint16(spreadBps);

        PoolDeploymentParameters memory poolParams = PoolDeploymentParameters({
            name: name,
            symbol: symbol,
            tokenDecimals: 18,
            initialOwner: owner,
            pairedToken: address(0),
            initialPairedTokenToDeposit: pairedDeposit,
            encodedInitializationArgs: abi.encode(initializationParameters(treasury, initialSupply, spread, buyFee, sellFee)),
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
        // Owner ops: only the broadcaster can do them, and only when it IS the
        // owner. A DAO-owned deploy (`APPTOKEN_OWNER` != broadcaster) stops
        // here; the owner wires the validator itself.
        if (owner == msg.sender) {
            IToken(token).setTransferValidator(realTV);
            IValidatorRuleset(realTV).setRulesetOfCollection(token, 1, address(0), 0, 0);
        }
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
