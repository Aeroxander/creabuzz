// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {SaleBase} from "./helpers/SaleBase.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Does the real Uniswap trade router on Sepolia trade in the pool the strategy opens? Fork only. A person
/// spends dollars to get Shares through the universal router, paying through Permit2, exactly as a wallet or the app
/// would, and then sells them back.
contract UniversalRouterForkTest is SaleBase {
    /// @dev Command byte of a v4 swap in the universal router (outside knowledge; the call below proves it on chain).
    uint8 internal constant V4_SWAP = 0x10;
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        if (!_setUpStack(true)) return;
        _deployTokens(true);
        _deployInfra(_defaultConfig());
    }

    function _swapViaRouter(PoolKey memory key, address who, bool zeroForOne, uint128 amountIn) internal {
        Currency cIn = zeroForOne ? key.currency0 : key.currency1;
        Currency cOut = zeroForOne ? key.currency1 : key.currency0;
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key, zeroForOne: zeroForOne, amountIn: amountIn, amountOutMinimum: 1, hookData: ""
            })
        );
        params[1] = abi.encode(cIn, uint256(amountIn));
        params[2] = abi.encode(cOut, uint256(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        vm.startPrank(who);
        // a wallet's usual two approvals: the token to Permit2, then Permit2 to the router
        (Currency.unwrap(cIn) == address(quote) ? quote : share).approve(PERMIT2, type(uint256).max);
        permit2.approve(Currency.unwrap(cIn), SEPOLIA_UNIVERSAL_ROUTER, amountIn, type(uint48).max);
        IUniversalRouter(SEPOLIA_UNIVERSAL_ROUTER).execute(abi.encodePacked(V4_SWAP), inputs, block.timestamp + 1);
        vm.stopPrank();
    }

    function test_fork_theRealTradeRouterTradesInTheNewPool() public {
        Sale memory s = _openSale(_standard());
        vm.roll(s.startBlock);
        _bid(s, makeAddr("alice"), 12_000e6, 100);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        treasury.openPool(strategy, ILBPInitializer(address(s.auction)));
        assertTrue(treasury.poolIsOpen(strategy, ILBPInitializer(address(s.auction))), "pool is open");

        bool quoteIsZero = address(quote) < address(share);
        quote.mint(buyer, 100e6);
        uint256 poolQuote = quote.balanceOf(address(poolManager));
        uint256 poolShares = share.balanceOf(address(poolManager));
        uint256 g = gasleft();
        _swapViaRouter(s.key, buyer, quoteIsZero, 100e6);
        emit log_named_uint("gas: trade through the universal router (buy, includes 2 approvals)", g - gasleft());
        uint256 got = share.balanceOf(buyer);
        assertGt(got, 0, "the buyer received Shares through the real router");
        assertEq(quote.balanceOf(buyer), 0, "and spent exactly their 100 dollars");
        assertEq(quote.balanceOf(address(poolManager)), poolQuote + 100e6, "the pool took the dollars");
        assertEq(share.balanceOf(address(poolManager)), poolShares - got, "and gave the Shares");

        _swapViaRouter(s.key, buyer, !quoteIsZero, uint128(got));
        assertEq(share.balanceOf(buyer), 0, "sold them all back");
        assertGt(quote.balanceOf(buyer), 90e6, "and most of the dollars returned");
        assertLt(quote.balanceOf(buyer), 100e6, "less the pool fee both ways");
    }
}
