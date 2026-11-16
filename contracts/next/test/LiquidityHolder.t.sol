// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Platform} from "./helpers/Platform.sol";
import {IPositionManagerTest, IPermit2Test, IPoolManagerTest} from "./helpers/UniswapTest.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";
import {Launcher} from "../src/Launcher.sol";
import {LiquidityHolder} from "../src/LiquidityHolder.sol";
import {PoolKey} from "../src/Pinned.sol";

/// @notice The LiquidityHolder: it owns every project's pool position for good, only trading fees leave it, and a position that
/// is not a project's pool's is a gift nobody can use.
abstract contract LiquidityHolderBase is Platform {
    uint256 internal positionId;
    Proj internal proj;
    Sale internal sale;
    IPositionManagerTest internal pm;

    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
        pm = IPositionManagerTest(positionManager);
        Proj memory p = _launch(founder, keccak256("holder"));
        Sale memory s = _open(p, Launcher.Size.Standard);
        _flat(s, 10_000 * DOLLAR);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        positionId = pm.nextTokenId();
        vm.startPrank(stranger);
        p.finisher.openPool();
        p.finisher.settle();
        p.finisher.sweep();
        vm.stopPrank();
        proj = p;
        sale = s;
    }

    /// @dev Trades until the pool has earned an odd number of dollar units and some Share fee, so a split has a remainder.
    function _tradeForFees() internal {
        usd.mint(trader, 1000 * DOLLAR);
        PoolKey memory key = _key(proj);
        (, uint256 got) = _swap(key, address(proj.shares), trader, true, 77 * DOLLAR + 12_345);
        _swap(key, address(proj.shares), trader, false, got / 3);
    }

    // ================================================ for good ========================================================

    function test_holder_ownsThePositionAndNobodyCanMoveItOrTakeLiquidityOut() public {
        assertEq(pm.ownerOf(positionId), address(holder));
        uint128 liq = pm.getPositionLiquidity(positionId);
        assertGt(liq, 0);
        address[5] memory attackers = [stranger, founder, platform, address(proj.treasury), address(proj.finisher)];
        for (uint256 i; i < attackers.length; ++i) {
            address a = attackers[i];
            vm.startPrank(a);
            vm.expectRevert();
            pm.transferFrom(address(holder), a, positionId);
            vm.expectRevert();
            pm.approve(a, positionId);
            // take all the liquidity out: DECREASE_LIQUIDITY(tokenId, liquidity, 0, 0, "") then TAKE_PAIR to the attacker
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(positionId, uint256(liq), uint128(0), uint128(0), bytes(""));
            params[1] = abi.encode(_key(proj).currency0, _key(proj).currency1, a);
            vm.expectRevert();
            pm.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x01), uint8(0x11)), params), block.timestamp + 1);
            // burn the position
            bytes[] memory burn = new bytes[](2);
            burn[0] = abi.encode(positionId, uint128(0), uint128(0), bytes(""));
            burn[1] = abi.encode(_key(proj).currency0, _key(proj).currency1, a);
            vm.expectRevert();
            pm.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x03), uint8(0x11)), burn), block.timestamp + 1);
            // a signed permit that was not signed by the owner (the holder cannot sign: it has no isValidSignature)
            vm.expectRevert();
            pm.permit(a, positionId, block.timestamp + 1, 0, new bytes(65));
            vm.expectRevert();
            pm.permitForAll(address(holder), a, block.timestamp + 1, 0, new bytes(65));
            vm.stopPrank();
        }
        assertEq(pm.ownerOf(positionId), address(holder), "still the holder's");
        assertEq(pm.getPositionLiquidity(positionId), liq, "and every unit of liquidity is still in it");
    }

    /// @dev The holder's public functions are exactly this list. Anything added (a transfer, an approval, a withdrawal, a
    /// signature check) breaks this test and so cannot be added without someone noticing.
    function test_holder_theWholeSurfaceIsCollectAndSweepOwed() public view {
        string memory json = vm.readFile("out/LiquidityHolder.sol/LiquidityHolder.json");
        string[] memory keys = vm.parseJsonKeys(json, ".methodIdentifiers");
        string[6] memory expected = [
            "collect(uint256)",
            "sweepOwed(address,address)",
            "owed(address,address)",
            "launcher()",
            "positionManager()",
            "guard()"
        ];
        assertEq(keys.length, expected.length, "no function was added or removed");
        for (uint256 i; i < expected.length; ++i) {
            bool found;
            for (uint256 j; j < keys.length; ++j) {
                if (keccak256(bytes(keys[j])) == keccak256(bytes(expected[i]))) found = true;
            }
            assertTrue(found, expected[i]);
        }
        // and none of the three doors an NFT owner could be walked through: signing, receiving, or a fallback
        bytes memory code = address(holder).code;
        assertFalse(_contains(code, hex"1626ba7e"), "no isValidSignature(bytes32,bytes)");
        assertFalse(_contains(code, hex"150b7a02"), "no onERC721Received");
        assertFalse(_contains(code, hex"a22cb465"), "no setApprovalForAll");
    }

    function _contains(bytes memory hay, bytes memory needle) private pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool ok = true;
            for (uint256 j; j < needle.length && ok; ++j) {
                if (hay[i + j] != needle[j]) ok = false;
            }
            if (ok) return true;
        }
        return false;
    }

    // ================================================ collecting ======================================================

    function test_holder_collectSplitsHalfToThePlatformHalfToTheProjectAndBurnsTheShares() public {
        _tradeForFees();
        uint128 liq = pm.getPositionLiquidity(positionId);
        uint256 supply = proj.shares.totalSupply();
        uint256 spendable = proj.treasury.spendable();
        uint256 platformBefore = usd.balanceOf(platform);
        vm.prank(stranger);
        (uint256 dollars, uint256 shares_) = holder.collect(positionId);
        assertGt(dollars, 0);
        assertGt(shares_, 0);
        assertEq(usd.balanceOf(platform) - platformBefore, dollars / 2, "half to the platform, rounded down");
        assertEq(
            proj.treasury.spendable() - spendable,
            dollars - dollars / 2,
            "the other half, with any odd unit, to the project's spendable"
        );
        assertEq(supply - proj.shares.totalSupply(), shares_, "the Share side is burned");
        assertEq(usd.balanceOf(address(holder)), 0);
        assertEq(proj.shares.balanceOf(address(holder)), 0);
        assertEq(pm.getPositionLiquidity(positionId), liq, "collecting takes no liquidity");
        assertEq(pm.ownerOf(positionId), address(holder));
        // anyone can call it, and the fees are collected once
        vm.prank(alice);
        (uint256 d2, uint256 s2) = holder.collect(positionId);
        assertEq(d2 + s2, 0);
    }

    /// @dev A dollar token that calls back into the holder while it is paying the platform: the call is refused.
    function test_holder_aCallBackFromTheDollarTokenCannotReenterCollect() public {
        _tradeForFees();
        usd.armCallback(platform, address(holder), abi.encodeCall(LiquidityHolder.collect, (positionId)));
        holder.collect(positionId);
        assertTrue(usd.callbackFired());
        assertFalse(usd.callbackOk(), "the call-back reverted");
        assertEq(bytes4(usd.callbackRet()), LiquidityHolder.Reentrancy.selector);
    }

    function test_holder_aFrozenPlatformAddressOnlyDelaysThePlatformsHalf() public {
        _tradeForFees();
        usd.setBlocked(platform, true);
        uint256 spendable = proj.treasury.spendable();
        uint256 supply = proj.shares.totalSupply();
        (uint256 dollars, uint256 shares_) = holder.collect(positionId);
        assertEq(holder.owed(address(usd), platform), dollars / 2, "the platform's half waits in the holder");
        assertEq(proj.treasury.spendable() - spendable, dollars - dollars / 2, "the project's half went through");
        assertEq(supply - proj.shares.totalSupply(), shares_, "and the burn");
        vm.expectRevert();
        holder.sweepOwed(address(usd), platform); // still frozen
        usd.setBlocked(platform, false);
        uint256 before = usd.balanceOf(platform);
        vm.prank(stranger);
        holder.sweepOwed(address(usd), platform);
        assertEq(usd.balanceOf(platform) - before, dollars / 2);
        assertEq(holder.owed(address(usd), platform), 0);
        holder.sweepOwed(address(usd), platform); // nothing left: harmless
    }

    // ================================================ a position that is not a project's =================================

    /// @dev Mint a position in a pool for `owner`, the way a person would: through the position manager, paying through Permit2.
    function _mintPosition(PoolKey memory key, address owner, address token0, address token1)
        internal
        returns (uint256 id)
    {
        id = pm.nextTokenId();
        QuoteToken(token0).mint(owner, 1_000_000_000e18);
        QuoteToken(token1).mint(owner, 1_000_000_000e18);
        vm.startPrank(owner);
        QuoteToken(token0).approve(PERMIT2, type(uint256).max);
        QuoteToken(token1).approve(PERMIT2, type(uint256).max);
        IPermit2Test(PERMIT2).approve(token0, positionManager, type(uint160).max, type(uint48).max);
        IPermit2Test(PERMIT2).approve(token1, positionManager, type(uint160).max, type(uint48).max);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            int24(-887_200),
            int24(887_200),
            uint256(1e12),
            uint128(type(uint128).max),
            uint128(type(uint128).max),
            owner,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        pm.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x02), uint8(0x0d)), params), block.timestamp + 1);
        vm.stopPrank();
    }

    function test_holder_aPositionOfAProjectThatDoesNotExistCannotBeCollected() public {
        // a pool of two tokens that belong to no project, with a position that its owner gives to the holder
        QuoteToken a = new QuoteToken();
        QuoteToken b = new QuoteToken();
        (address c0, address c1) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        PoolKey memory key = PoolKey({currency0: c0, currency1: c1, fee: 10_000, tickSpacing: 200, hooks: address(0)});
        IPoolManagerTest(poolManager).initialize(key, uint160(1) << 96);
        uint256 id = _mintPosition(key, stranger, c0, c1);
        vm.prank(stranger);
        pm.transferFrom(stranger, address(holder), id);
        assertEq(pm.ownerOf(id), address(holder), "the gift arrived");
        vm.expectRevert(LiquidityHolder.UnknownProject.selector);
        holder.collect(id);
        // the holder still cannot give it back or move it
        vm.prank(stranger);
        vm.expectRevert();
        pm.transferFrom(address(holder), stranger, id);
    }

    function test_holder_aPlainPoolOfARealProjectsSharesIsNotTheProjectsPool() public {
        // a stranger's own pool of the real project's Shares and its dollar, with no guard: its fees are not the project's to take
        PoolKey memory real = _key(proj);
        PoolKey memory plain = real;
        plain.hooks = address(0);
        IPoolManagerTest(poolManager).initialize(plain, uint160(1) << 96);
        // the stranger needs Shares: the Treasury hands some over (it holds the reserve)
        vm.prank(address(proj.treasury));
        proj.shares.transfer(stranger, 50_000_000 * SHARE);
        usd.mint(stranger, 1_000_000 * DOLLAR);
        uint256 id = pm.nextTokenId();
        vm.startPrank(stranger);
        usd.approve(PERMIT2, type(uint256).max);
        proj.shares.approve(PERMIT2, type(uint256).max);
        IPermit2Test(PERMIT2).approve(address(usd), positionManager, type(uint160).max, type(uint48).max);
        IPermit2Test(PERMIT2).approve(address(proj.shares), positionManager, type(uint160).max, type(uint48).max);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            plain,
            int24(-887_200),
            int24(887_200),
            uint256(1e9),
            uint128(type(uint128).max),
            uint128(type(uint128).max),
            stranger,
            bytes("")
        );
        params[1] = abi.encode(plain.currency0, plain.currency1);
        pm.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x02), uint8(0x0d)), params), block.timestamp + 1);
        pm.transferFrom(stranger, address(holder), id);
        vm.stopPrank();
        vm.expectRevert(LiquidityHolder.UnknownProject.selector);
        holder.collect(id);
    }

    function test_holder_aPositionItDoesNotOwnCannotBeCollected() public {
        vm.expectRevert(); // no such position at all
        holder.collect(positionId + 100);
        QuoteToken a = new QuoteToken();
        QuoteToken b = new QuoteToken();
        (address c0, address c1) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        PoolKey memory key = PoolKey({currency0: c0, currency1: c1, fee: 10_000, tickSpacing: 200, hooks: address(0)});
        IPoolManagerTest(poolManager).initialize(key, uint160(1) << 96);
        uint256 id = _mintPosition(key, stranger, c0, c1);
        vm.expectRevert(LiquidityHolder.NotHeld.selector);
        holder.collect(id); // owned by the stranger, not by the holder
    }
}

contract LiquidityHolderLocalTest is LiquidityHolderBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract LiquidityHolderForkTest is LiquidityHolderBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
