// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {InitializerHook} from "liquidity-launcher/src/periphery/hooks/InitializerHook.sol";
import {IProtocolFeeController} from "liquidity-launcher/src/interfaces/IProtocolFeeController.sol";
import {ProtocolFeeController} from "liquidity-launcher/src/periphery/ProtocolFeeController.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {MigratorParams} from "liquidity-launcher/src/libraries/MigratorParams.sol";
import {ValidationHookLib} from "continuous-clearing-auction/src/libraries/ValidationHookLib.sol";
import {IValidationHook} from "continuous-clearing-auction/src/interfaces/IValidationHook.sol";
import {SaleBase} from "./helpers/SaleBase.sol";
import {FixedFeeController} from "../src/FixedFeeController.sol";
import {MinBid} from "../src/MinBid.sol";
import {PoolGuard} from "../src/PoolGuard.sol";

/// @notice Step 3 of milestone 1: the three small pieces, each alone and then together.
/// (a) FixedFeeController + our own factory: the 3% raise fee through the auction's own fee setting.
/// (b) MinBid: no dust bids, no top price far above the market.
/// (c) PoolGuard: only the strategy can create the project's pool.
abstract contract PiecesBase is SaleBase {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        if (!_setUpStack(_fork())) return;
        _deployTokens(true);
        _deployInfra(_defaultConfig());
    }

    // ===================================== (a) the fee controller and the factory ===================================

    function test_fee_ceilingAndRecipientAreEnforcedAtDeployment() public {
        new FixedFeeController(platform, 50_000); // exactly the ceiling is fine
        vm.expectRevert(
            abi.encodeWithSelector(IProtocolFeeController.InvalidFeePips.selector, uint24(50_001), uint24(50_000))
        );
        new FixedFeeController(platform, 50_001);
        vm.expectRevert(FixedFeeController.ZeroRecipient.selector);
        new FixedFeeController(address(0), 30_000);
    }

    function test_fee_amountIsAFixedShareRoundedDown() public view {
        assertEq(feeController.getProtocolFeeAmount(address(quote), 10_000e6), 300e6, "3% of 10,000 dollars");
        assertEq(feeController.getProtocolFeeAmount(address(quote), 33), 0, "rounds down, never up");
        assertEq(feeController.getProtocolFeeAmount(address(quote), 34), 1, "1.02 rounds to 1");
        assertEq(feeController.getProtocolFeeAmount(address(0), 0), 0, "nothing raised, no fee");
        assertEq(feeController.protocolFeeRecipient(), platform, "recipient");
        assertEq(feeController.getProtocolFeeBracketsForCurrency(address(quote)).length, 0, "no brackets");
    }

    function test_fee_nobodyCanChangeIt() public {
        IProtocolFeeController.ProtocolFeeBracket[] memory none = new IProtocolFeeController.ProtocolFeeBracket[](0);
        vm.startPrank(platform); // not even the recipient
        vm.expectRevert(FixedFeeController.Immutable.selector);
        feeController.setGlobalProtocolFeePips(1_000_000);
        vm.expectRevert(FixedFeeController.Immutable.selector);
        feeController.setProtocolFeeRecipient(platform);
        vm.expectRevert(FixedFeeController.Immutable.selector);
        feeController.setProtocolFeeBracketsForCurrency(address(quote), none);
        vm.stopPrank();
        assertEq(feeController.feePips(), 30_000, "still 3%");
    }

    /// @notice The plan's claim about Uniswap's own controller, shown: its owner can set 100%. That is why we do not use it.
    function test_fee_theVendoredControllerLetsItsOwnerTakeEverything() public {
        ProtocolFeeController vendored = new ProtocolFeeController(address(this));
        vendored.setProtocolFeeRecipient(platform);
        vendored.setGlobalProtocolFeePips(1_000_000);
        assertEq(vendored.getProtocolFeeAmount(address(quote), 10_000e6), 10_000e6, "100% of the raise");
        vm.expectRevert();
        vendored.setGlobalProtocolFeePips(1_000_001); // the only ceiling is 100%
    }

    function test_fee_ourFactoryIsBoundToItForEverySale() public {
        assertEq(address(factory.protocolFeeController()), address(feeController), "the factory's controller");
        Sale memory s = _openSale(_standard());
        // Dollars raised -> exactly 3% to the platform, through the auction's own sweep, nothing through our code.
        vm.roll(s.startBlock);
        _bid(s, alice(), 12_000e6, 100);
        _toEnd(s);
        uint256 raised = s.auction.currencyRaised();
        vm.roll(s.endBlock + 1);
        strategy.migrate(ILBPInitializer(address(s.auction)));
        assertEq(quote.balanceOf(platform), raised * 30_000 / 1_000_000, "platform got exactly 3% of what was raised");
        assertGt(quote.balanceOf(platform), 0, "and it is not zero");
    }

    // ===================================== (b) MinBid ===============================================================

    function test_minBid_dustBidsAreRefused() public {
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        _fund(alice(), 10e6, s);
        bytes memory reason = abi.encodeWithSelector(MinBid.BidTooSmall.selector, uint128(999_999), uint128(1_000_000));
        vm.prank(alice());
        vm.expectRevert(abi.encodeWithSelector(ValidationHookLib.ValidationHookCallFailed.selector, reason));
        s.auction.submitBid(_price(s, 10), 999_999, alice(), s.floorQ96, "");

        reason = abi.encodeWithSelector(MinBid.BidTooSmall.selector, uint128(1), uint128(1_000_000));
        vm.prank(alice());
        vm.expectRevert(abi.encodeWithSelector(ValidationHookLib.ValidationHookCallFailed.selector, reason));
        s.auction.submitBid(_price(s, 10), 1, alice(), s.floorQ96, "");

        // exactly one dollar is accepted
        vm.prank(alice());
        s.auction.submitBid(_price(s, 10), 1_000_000, alice(), s.floorQ96, "");
        assertEq(s.auction.nextBidId(), 1, "the one-dollar bid went in");
    }

    function test_minBid_topPriceAboveFourTimesTheMarketIsRefused() public {
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        s.auction.checkpoint();
        uint256 clearing = s.auction.clearingPrice();
        assertEq(clearing, s.floorQ96, "at the start the market price is the floor");
        _fund(alice(), 100e6, s);
        // exactly 4x is the most allowed (the floor is tick 100, so 4x is tick 400, i.e. 300 ticks above)
        vm.prank(alice());
        s.auction.submitBid(_price(s, 300), 50e6, alice(), s.floorQ96, "");
        // one tick more is refused, with the exact limit in the error
        bytes memory reason =
            abi.encodeWithSelector(MinBid.TopPriceTooHigh.selector, _price(s, 301), clearing * TOP_PRICE_MULTIPLE);
        vm.prank(alice());
        vm.expectRevert(abi.encodeWithSelector(ValidationHookLib.ValidationHookCallFailed.selector, reason));
        s.auction.submitBid(_price(s, 301), 50e6, alice(), s.floorQ96, "");
        // the auction's own ceiling is astronomically high: without the hook there is no practical limit
        assertGt(s.auction.MAX_BID_PRICE(), s.floorQ96 * 1e18, "the auction's own max price is enormous");
    }

    function test_minBid_theLimitMovesWithTheMarket() public {
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        _bid(s, alice(), 30_000e6, 300); // 3x the goal at up to 4x: pushes the clearing price up
        vm.roll(s.startBlock + 3000);
        s.auction.checkpoint();
        uint256 clearing = s.auction.clearingPrice();
        assertGt(clearing, _price(s, 50), "the price has risen well above the floor");
        // 4x floor is now far below 4x the market, so a bid above 4x floor is allowed
        _bid(s, bob(), 2000e6, 300 + 100); // 5x floor, allowed because the market is higher now
        assertEq(s.auction.nextBidId(), 2, "accepted");
    }

    function test_minBid_withoutTheHookDustAndExtremePricesGoIn() public {
        // Control: the same sale with a permissive hook accepts what the real one refuses.
        minBid = new MinBid(0, 0, 0); // the sale below takes its hook from `minBid`
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        _fund(alice(), 10e6, s);
        vm.prank(alice());
        s.auction.submitBid(_price(s, 10), 1, alice(), s.floorQ96, ""); // one millionth of a dollar
        vm.prank(alice());
        s.auction.submitBid(_price(s, 3000), 1e6, alice(), s.floorQ96, ""); // 31x the floor
        assertEq(s.auction.nextBidId(), 2, "both accepted with no rules");
    }

    function test_minBid_saysItIsABidHook() public view {
        assertTrue(minBid.supportsInterface(type(IValidationHook).interfaceId), "IValidationHook");
        assertEq(minBid.minAmount(), 1_000_000, "one dollar");
        assertEq(minBid.maxPriceMultiple(), 4, "4x");
    }

    // ===================================== (c) PoolGuard ===========================================================

    function test_guard_itIsBuiltOnTheVendoredHookAndAuthorizesOnlyTheStrategy() public view {
        assertEq(guard.authorized(), address(strategy), "authorized is the strategy");
        assertEq(
            uint160(address(guard)) & Hooks.ALL_HOOK_MASK, Hooks.BEFORE_INITIALIZE_FLAG, "only the beforeInitialize bit"
        );
        Hooks.Permissions memory p = guard.getHookPermissions();
        assertTrue(p.beforeInitialize, "asks for beforeInitialize");
        assertFalse(
            p.beforeSwap || p.afterSwap || p.beforeAddLiquidity || p.beforeRemoveLiquidity,
            "nothing on trades or liquidity"
        );
    }

    function test_guard_aStrangerCannotCreateTheProjectsPool() public {
        PoolKey memory key = _poolKey(address(guard));
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(guard),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(InitializerHook.InvalidInitializer.selector, stranger, address(strategy)),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        poolManager.initialize(key, 79_228_162_514_264_337_593_543_950_336);
    }

    function test_guard_theStrategyRefusesAGuardThatNamesSomeoneElse() public {
        PoolGuard wrong = _deployGuard(stranger); // a valid hook, but authorizing a stranger
        guard = wrong;
        // opening a sale with it must be refused: the strategy requires `authorized() == itself`
        share.mint(address(this), SHARES);
        share.approve(address(strategy), SALE_AND_RESERVE);
        uint64 start = uint64(block.number + 1);
        (uint256 f, uint256 t) = _floorAndTick(10_000e6);
        bytes memory cfg = abi.encode(
            _migratorParams(start + SALE_BLOCKS, address(wrong)), abi.encode(_auctionParams(_standard(), start, f, t))
        );
        vm.expectRevert(abi.encodeWithSelector(MigratorParams.InvalidHook.selector, address(wrong)));
        strategy.initializeDistribution(address(share), SALE_AND_RESERVE, cfg, bytes32(0));
    }

    function test_guard_mustLiveAtAMinedAddress() public {
        // An ordinary address has no hook bits: the pool manager's own check in the hook constructor refuses.
        vm.expectRevert();
        new PoolGuard(poolManager, address(strategy));
    }

    // ===================================== together ================================================================

    function test_together_feeBidRulesAndGuardInOneSale() public {
        Sale memory s = _openSale(_standard());
        assertEq(address(s.key.hooks), address(guard), "the sale's pool key carries the guard");
        vm.roll(s.startBlock);
        // dust refused
        _fund(alice(), 10e6, s);
        vm.prank(alice());
        vm.expectRevert();
        s.auction.submitBid(_price(s, 10), 500_000, alice(), s.floorQ96, "");
        // too-high top price refused
        vm.prank(alice());
        vm.expectRevert();
        s.auction.submitBid(_price(s, 301), 5e6, alice(), s.floorQ96, "");
        // honest bids go in
        _bid(s, alice(), 6000e6, 100);
        _bid(s, bob(), 6000e6, 150);
        // a stranger cannot take the pool key
        vm.prank(stranger);
        vm.expectRevert();
        poolManager.initialize(s.key, 79_228_162_514_264_337_593_543_950_336);
        // ... and the sale still finishes into a pool, with the fee paid
        _toEnd(s);
        uint256 raised = s.auction.currencyRaised();
        vm.roll(s.endBlock + 1);
        strategy.migrate(ILBPInitializer(address(s.auction)));
        assertGt(_poolSqrtPrice(s.key), 0, "the pool exists");
        assertEq(quote.balanceOf(platform), raised * 30_000 / 1_000_000, "fee");
    }

    // small address helpers so the test bodies read clearly
    function alice() internal returns (address) {
        return makeAddr("alice");
    }

    function bob() internal returns (address) {
        return makeAddr("bob");
    }
}

contract PiecesLocalTest is PiecesBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract PiecesForkTest is PiecesBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
