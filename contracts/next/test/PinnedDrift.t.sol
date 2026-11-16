// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey as VPoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {ILBPStrategy} from "liquidity-launcher/src/interfaces/ILBPStrategy.sol";
import {ILBPInitializer, LBPInitializationParams as VInit} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {IProtocolFeeController} from "liquidity-launcher/src/interfaces/IProtocolFeeController.sol";
import {
    MigratorParameters as VMigrator,
    PoolParameters as VPool,
    LiquidityAllocationBracket as VBracket,
    MigratorParams
} from "liquidity-launcher/src/libraries/MigratorParams.sol";
import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {InitializerHook} from "liquidity-launcher/src/periphery/hooks/InitializerHook.sol";
import {
    AuctionParameters as VAuction,
    IContinuousClearingAuction
} from "continuous-clearing-auction/src/interfaces/IContinuousClearingAuction.sol";
import {IAuctionStorage} from "continuous-clearing-auction/src/interfaces/IAuctionStorage.sol";
import {ContinuousClearingAuctionFactory} from "continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol";
import {ILBPInitializer as IInit2} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {
    PoolKey,
    MigratorParameters,
    PoolParameters,
    LiquidityAllocationBracket,
    AuctionParameters,
    LBPInitializationParams,
    IPinnedStrategy,
    IPinnedAuction,
    IPinnedAuctionFactory,
    IPinnedFeeController,
    IPinnedPoolManager,
    IPinnedPositionManager,
    IPinnedGuard,
    PoolRead,
    SaleParams
} from "../src/Pinned.sol";
import {SaleBase} from "./helpers/SaleBase.sol";
import {IAuctionSweeps} from "./mocks/MockTreasury.sol";

/// @notice The one version-drift test. First-party code (0.8.37) reaches the vendored Uniswap code (0.8.26 and its own settings)
/// only through `src/Pinned.sol`. Everything in that file is a copy of something upstream, so this test fails, with a message
/// that names what to review, if upstream moves under it: a selector, a struct layout, the pool manager's storage layout, an action
/// number, a hook flag, or (the catch-all) a single byte of any vendored contract we deploy or call.
contract PinnedDriftTest is SaleBase {
    using PoolIdLibrary for VPoolKey;
    using StateLibrary for IPoolManager;

    /// @dev Hashes of the creation code of the vendored contracts (build artifacts, solc 0.8.26, via-IR, 11,111 runs, no metadata).
    /// Any change to the vendored source or to these build settings changes a hash. When one fails: read the upstream diff, check
    /// `src/Pinned.sol` and the drift tests below against it, then update the hash. The hashes were taken on 16 November 2026 at
    /// continuous-clearing-auction v2.1.0 plus two commits and liquidity-launcher v3.0.0 (see docs/next-version/M1-FACTS.md).
    bytes32 internal constant H_STRATEGY = 0x88c9c9fbe02f84bc1578973bc6a4cbe892b37aac9422996ef8fea9b4a3ac256c;
    bytes32 internal constant H_FACTORY = 0x00c51816e2621745852769a04339565a64efa4d2ddf593845f4add765fe339d9;
    bytes32 internal constant H_POOL_MANAGER = 0xf160a81a723908b264f322fad1f972109022837c4eac34a898797dc6e43c476e;
    bytes32 internal constant H_POSITION_MANAGER = 0xa71370dc46d633b73f5bac3e9a55cde6073d7b523becc7f4c00a1f4d99c23640;
    bytes32 internal constant H_POOL_GUARD = 0x12a9cad046b377bfe8b9148fb64ac14f0e3d6c7c56b15c919953e3d3851a00b5; // our PoolGuard, which is the vendored InitializerHook with one address

    function test_drift_selectorsOfEveryPinnedFunctionAreTheVendoredOnes() public view {
        LBPStrategy st = LBPStrategy(payable(address(0))); // public variables expose their getter's selector on an instance
        InitializerHook gh = InitializerHook(address(0));
        assertEq(
            IPinnedStrategy.initializeDistribution.selector,
            LBPStrategy.initializeDistribution.selector,
            "initializeDistribution"
        );
        assertEq(IPinnedStrategy.migrate.selector, ILBPStrategy.migrate.selector, "migrate");
        assertEq(IPinnedStrategy.initializers.selector, ILBPStrategy.initializers.selector, "initializers");
        assertEq(IPinnedStrategy.registeredPoolIds.selector, st.registeredPoolIds.selector, "registeredPoolIds");
        assertEq(IPinnedStrategy.poolManager.selector, st.poolManager.selector, "poolManager");
        assertEq(IPinnedStrategy.positionManager.selector, st.positionManager.selector, "positionManager");
        assertEq(IPinnedStrategy.initializerFactory.selector, st.initializerFactory.selector, "initializerFactory");
        assertEq(IPinnedAuction.isGraduated.selector, IContinuousClearingAuction.isGraduated.selector, "isGraduated");
        assertEq(IPinnedAuction.currencyRaised.selector, IAuctionStorage.currencyRaised.selector, "currencyRaised");
        assertEq(
            IPinnedAuction.lbpInitializationParams.selector,
            ILBPInitializer.lbpInitializationParams.selector,
            "lbpInitializationParams"
        );
        assertEq(IPinnedAuction.endBlock.selector, ILBPInitializer.endBlock.selector, "endBlock");
        assertEq(
            IPinnedAuction.sweepUnsoldTokens.selector, ILBPInitializer.sweepUnsoldTokens.selector, "sweepUnsoldTokens"
        );
        assertEq(
            IPinnedAuctionFactory.protocolFeeController.selector,
            ContinuousClearingAuctionFactory.protocolFeeController.selector,
            "protocolFeeController"
        );
        assertEq(
            IPinnedFeeController.getProtocolFeeAmount.selector,
            IProtocolFeeController.getProtocolFeeAmount.selector,
            "getProtocolFeeAmount"
        );
        assertEq(
            IPinnedFeeController.protocolFeeRecipient.selector,
            IProtocolFeeController.protocolFeeRecipient.selector,
            "protocolFeeRecipient"
        );
        // `extsload(bytes32)` is overloaded upstream, so its selector is proven by the read tests below, which call it
        assertEq(
            IPinnedPositionManager.modifyLiquidities.selector,
            IPositionManager.modifyLiquidities.selector,
            "modifyLiquidities"
        );
        assertEq(
            IPinnedPositionManager.getPoolAndPositionInfo.selector,
            IPositionManager.getPoolAndPositionInfo.selector,
            "getPoolAndPositionInfo"
        );
        assertEq(
            IPinnedPositionManager.getPositionLiquidity.selector,
            IPositionManager.getPositionLiquidity.selector,
            "getPositionLiquidity"
        );
        assertEq(IPinnedPositionManager.ownerOf.selector, bytes4(keccak256("ownerOf(uint256)")), "ownerOf");
        assertEq(IPinnedGuard.authorized.selector, gh.authorized.selector, "authorized");
    }

    function test_drift_theStructsEncodeTheSameBytes() public view {
        VBracket[] memory vb = new VBracket[](1);
        vb[0] = VBracket({lowerThreshold: 7, rate: 2_268_041});
        LiquidityAllocationBracket[] memory pb = new LiquidityAllocationBracket[](1);
        pb[0] = LiquidityAllocationBracket({lowerThreshold: 7, rate: 2_268_041});
        assertEq(abi.encode(vb), abi.encode(pb), "LiquidityAllocationBracket[]");

        VMigrator memory vm_ = VMigrator({
            token: address(0x11),
            currency: address(0x22),
            migrationBlock: 123_456,
            reservedTokenAmountForLP: 100_000_000e18,
            recipient: address(0x33),
            positionRecipient: address(0x44),
            poolParameters: VPool({fee: 10_000, tickSpacing: -200, hook: address(0x55)}),
            positionDefinitions: hex"aabb",
            lpAllocationSchedule: hex"ccddee"
        });
        MigratorParameters memory pm_ = MigratorParameters({
            token: address(0x11),
            currency: address(0x22),
            migrationBlock: 123_456,
            reservedTokenAmountForLP: 100_000_000e18,
            recipient: address(0x33),
            positionRecipient: address(0x44),
            poolParameters: PoolParameters({fee: 10_000, tickSpacing: -200, hook: address(0x55)}),
            positionDefinitions: hex"aabb",
            lpAllocationSchedule: hex"ccddee"
        });
        assertEq(abi.encode(vm_), abi.encode(pm_), "MigratorParameters");

        VAuction memory va = VAuction({
            currency: address(0x1),
            tokensRecipient: address(0x2),
            fundsRecipient: address(0x3),
            startBlock: 10,
            endBlock: 20,
            claimBlock: 21,
            tickSpacing: 12_345,
            validationHook: address(0x4),
            floorPrice: 54_321,
            requiredCurrencyRaised: 2500e6,
            auctionStepsData: hex"0102030405060708"
        });
        AuctionParameters memory pa = AuctionParameters({
            currency: address(0x1),
            tokensRecipient: address(0x2),
            fundsRecipient: address(0x3),
            startBlock: 10,
            endBlock: 20,
            claimBlock: 21,
            tickSpacing: 12_345,
            validationHook: address(0x4),
            floorPrice: 54_321,
            requiredCurrencyRaised: 2500e6,
            auctionStepsData: hex"0102030405060708"
        });
        assertEq(abi.encode(va), abi.encode(pa), "AuctionParameters");

        VPoolKey memory vk = VPoolKey({
            currency0: Currency.wrap(address(0xA)),
            currency1: Currency.wrap(address(0xB)),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(0xC))
        });
        PoolKey memory pk = PoolKey({
            currency0: address(0xA), currency1: address(0xB), fee: 10_000, tickSpacing: 200, hooks: address(0xC)
        });
        assertEq(abi.encode(vk), abi.encode(pk), "PoolKey");
        assertEq(PoolId.unwrap(vk.toId()), PoolRead.id(pk), "the pool id is the hash of the encoded key");

        VInit memory vi = VInit({initialPriceX96: 1, tokensSold: 2, currencyRaised: 3});
        LBPInitializationParams memory pi =
            LBPInitializationParams({initialPriceX96: 1, tokensSold: 2, currencyRaised: 3});
        assertEq(abi.encode(vi), abi.encode(pi), "LBPInitializationParams");
        // an empty list of position definitions is the same bytes as an empty list of anything
        assertEq(abi.encode(new uint256[](0)).length, 64);
    }

    function test_drift_theNumbersWeCopied() public view {
        assertEq(uint256(MigratorParams.MAX_BRACKET_RATE), SaleParams.RATE_SCALE, "the pool-share scale");
        assertEq(uint256(Hooks.BEFORE_INITIALIZE_FLAG), uint256(1) << 13, "the hook bit the Launcher requires");
        assertEq(uint256(Hooks.ALL_HOOK_MASK), (uint256(1) << 14) - 1, "the 14 hook bits");
        assertEq(Actions.DECREASE_LIQUIDITY, 0x01, "the position manager's decrease action");
        assertEq(Actions.TAKE_PAIR, 0x11, "the position manager's take-pair action");
        assertEq(Actions.MINT_POSITION, 0x02);
        assertEq(Actions.SETTLE_PAIR, 0x0d);
        assertEq(Actions.BURN_POSITION, 0x03);
        assertEq(SaleParams.SALE_BLOCKS, 7200);
    }

    /// @dev The pool manager's storage layout, read by `PoolRead`, against its own `StateLibrary`, on a pool the strategy made:
    /// local twin and (in the fork contract) the real deployment on Sepolia.
    function _readsMatch() internal {
        _deployTokens(true);
        _deployInfra(_defaultConfig());
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        _bid(s, makeAddr("a"), 12_000e6, 100);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        assertEq(
            PoolRead.sqrtPrice(IPinnedPoolManager(address(poolManager)), PoolRead.id(_pin(s.key))), 0, "no pool yet"
        );
        assertEq(PoolRead.liquidity(IPinnedPoolManager(address(poolManager)), PoolRead.id(_pin(s.key))), 0);
        treasury.openPool(ILBPStrategy(address(strategy)), ILBPInitializer(address(s.auction)));
        PoolId id = s.key.toId();
        (uint160 price,,,) = poolManager.getSlot0(id);
        assertGt(price, 0);
        assertEq(PoolRead.sqrtPrice(IPinnedPoolManager(address(poolManager)), PoolId.unwrap(id)), price, "price slot");
        assertEq(
            PoolRead.liquidity(IPinnedPoolManager(address(poolManager)), PoolId.unwrap(id)),
            poolManager.getLiquidity(id),
            "liquidity slot"
        );
        assertGt(poolManager.getLiquidity(id), 0);
        assertEq(PoolId.unwrap(id), PoolRead.id(_pin(s.key)));
        // and the pinned auction functions answer on the real auction
        IPinnedAuction a = IPinnedAuction(address(s.auction));
        assertTrue(a.isGraduated());
        assertEq(a.currencyRaised(), s.auction.currencyRaised());
        assertEq(a.endBlock(), s.endBlock);
        assertEq(
            a.lbpInitializationParams().currencyRaised + s.auction.currencyRaised() * 30_000 / 1_000_000,
            s.auction.currencyRaised()
        );
    }

    function _pin(VPoolKey memory k) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.unwrap(k.currency0),
            currency1: Currency.unwrap(k.currency1),
            fee: k.fee,
            tickSpacing: k.tickSpacing,
            hooks: address(k.hooks)
        });
    }

    function test_drift_poolStateReadsMatchStateLibrary_local() public {
        if (!_setUpStack(false)) return;
        _readsMatch();
    }

    function test_drift_poolStateReadsMatchStateLibrary_sepoliaFork() public {
        if (!_setUpStack(true)) return;
        _readsMatch();
    }

    /// @dev The catch-all: any byte of any vendored contract we deploy or call, changed.
    function test_drift_theVendoredContractsAreByteForByteTheOnesWePinned() public {
        bytes32[5] memory got = [
            keccak256(vm.getCode("LBPStrategy.sol:LBPStrategy")),
            keccak256(vm.getCode("ContinuousClearingAuctionFactory.sol:ContinuousClearingAuctionFactory")),
            keccak256(vm.getCode("PoolManager.sol:PoolManager")),
            keccak256(vm.getCode("PositionManager.sol:PositionManager")),
            keccak256(vm.getCode("PoolGuard.sol:PoolGuard"))
        ];
        bytes32[5] memory want = [H_STRATEGY, H_FACTORY, H_POOL_MANAGER, H_POSITION_MANAGER, H_POOL_GUARD];
        string[5] memory names = [
            "LBPStrategy",
            "ContinuousClearingAuctionFactory",
            "PoolManager",
            "PositionManager",
            "PoolGuard (the vendored InitializerHook and BaseHook inside it)"
        ];
        for (uint256 i; i < 5; ++i) {
            if (got[i] != want[i]) emit log_named_bytes32(string.concat("hash now: ", names[i]), got[i]);
        }
        for (uint256 i; i < 5; ++i) {
            assertEq(
                got[i],
                want[i],
                string.concat(
                    "UPSTREAM CHANGED: ",
                    names[i],
                    ". Review src/Pinned.sol and the other drift tests against the upstream diff, then update the hash"
                )
            );
        }
    }
}
