// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Platform} from "./helpers/Platform.sol";
import {IPoolManagerTest} from "./helpers/UniswapTest.sol";
import {QuoteToken} from "./mocks/QuoteToken.sol";
import {Launcher} from "../src/Launcher.sol";
import {Finisher} from "../src/Finisher.sol";
import {Treasury} from "../src/Treasury.sol";
import {
    IPinnedStrategy,
    MigratorParameters,
    LiquidityAllocationBracket,
    PoolKey,
    PoolRead,
    SaleParams
} from "../src/Pinned.sol";

/// @notice What the Launcher fills in and what the sale enforces: the size menu, every setting of the auction and the pool,
/// the bid rules on a real sale, recipient-only sweeps, a stranger creating the pool first, and a dollar token that misbehaves.
abstract contract SaleRulesBase is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    // ============================================== every setting is filled in ========================================

    function test_openAuction_fillsInEverySetting() public {
        for (uint256 i; i < 1; ++i) {
            Proj memory p = _launch(founder, keccak256(abi.encode("sizes", i)));
            Sale memory s = _open(p);
            uint256 goal = 100_000 * DOLLAR;
            assertEq(launcher.AUCTION_MINIMUM(), goal, "the minimum is every Share sold at the starting price");
            // the auction
            assertEq(s.auction.currency(), address(usd));
            assertEq(s.auction.token(), address(p.shares));
            assertEq(s.auction.totalSupply(), SaleParams.SALE_SHARES, "250M Shares for sale");
            assertEq(SaleParams.SALE_SHARES, 250_000_000 * SHARE);
            assertEq(s.auction.startBlock(), block.number + 1);
            assertEq(s.auction.endBlock(), s.auction.startBlock() + 7200, "24 hours");
            assertEq(s.auction.claimBlock(), s.auction.endBlock() + 1);
            assertEq(s.auction.floorPrice(), s.floorQ96);
            assertEq(s.auction.tickSpacing(), s.tickQ96);
            assertEq(s.floorQ96, s.tickQ96 * 100, "the floor is tick 100");
            assertEq(s.auction.validationHook(), minBid);
            assertEq(s.auction.fundsRecipient(), strategy);
            assertEq(s.auction.tokensRecipient(), address(p.finisher));
            // selling all 250M Shares at the floor price raises the goal (the floor is rounded up to a whole tick, under 1% more)
            uint256 atFloor = SaleParams.SALE_SHARES * s.floorQ96 >> 96;
            assertGe(atFloor, goal);
            assertApproxEqRel(atFloor, goal, 0.01e18);
            // the strategy
            MigratorParameters memory mp = IPinnedStrategy(strategy).initializers(address(s.auction));
            assertEq(mp.token, address(p.shares));
            assertEq(mp.currency, address(usd));
            assertEq(mp.migrationBlock, s.auction.endBlock() + 1);
            assertEq(mp.reservedTokenAmountForLP, SaleParams.POOL_SHARES, "100M Shares to match the pool's dollars");
            assertEq(mp.recipient, address(p.finisher), "what the pool does not take comes back to the Finisher");
            assertEq(
                mp.positionRecipient, address(holder), "the pool position is the LiquidityHolder's from its first block"
            );
            assertEq(mp.poolParameters.fee, 10_000, "1% pool fee");
            assertEq(mp.poolParameters.tickSpacing, 200);
            assertEq(mp.poolParameters.hook, guard, "the pool's hook is the platform's guard");
            assertEq(mp.positionDefinitions, abi.encode(new uint256[](0)), "one full-range position, no extra ranges");
            LiquidityAllocationBracket[] memory br = abi.decode(mp.lpAllocationSchedule, (LiquidityAllocationBracket[]));
            assertEq(br.length, 1, "one bracket");
            assertEq(br[0].lowerThreshold, 0);
            assertEq(
                br[0].rate, 2_268_041, "22 of every 100 raised, as 2,268,041 of 10,000,000 of what is left after the 3"
            );
            assertEq(p.shares.balanceOf(address(p.finisher)), 0);
        }
    }

    /// @dev The minimum to go through: one dollar under it the sale fails (everyone refunded), at it the sale goes. The minimum is
    /// the full sale at the starting price, so the bid goes in at a top price above it (10 ticks) for the auction to clear it all.
    function test_openAuction_theMinimumIsTheMinimum() public {
        for (uint256 i; i < 1; ++i) {
            uint256 minimum = 100_000 * DOLLAR;
            for (uint256 under; under < 2; ++under) {
                Proj memory p = _launch(founder, keccak256(abi.encode("min", i, under)));
                Sale memory s = _open(p);
                vm.roll(s.startBlock);
                _bid(s, alice, under == 1 ? minimum - DOLLAR : minimum, 10);
                _toEnd(s);
                assertEq(s.auction.isGraduated(), under == 0, "goes through at the minimum, fails a dollar below it");
            }
        }
    }

    function test_openSale_theProjectsOwnDollarTokenIsUsedNotTheCurrentSetting() public {
        Proj memory p = _launch(founder, keccak256("old settings"));
        QuoteToken other = new QuoteToken();
        Launcher.Settings memory st = _settings();
        st.quote = IERC20(address(other));
        vm.prank(admin);
        launcher.setSettings(st);
        Sale memory s = _open(p);
        assertEq(s.auction.currency(), address(usd), "the sale raises the project's own dollar token");
        assertEq(IPinnedStrategy(strategy).initializers(address(s.auction)).currency, address(usd));
    }

    // ============================================== a stranger creates the pool first ================================

    function _initializeAt(PoolKey memory key) internal returns (bool ok) {
        vm.prank(stranger);
        try IPoolManagerTest(poolManager).initialize(key, uint160(1) << 96) returns (int24) {
            return true;
        } catch {
            return false;
        }
    }
}

abstract contract SaleRulesBase2 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    function test_openAuction_onlyThePairOpensAndOnlyThroughTheLauncher() public {
        Proj memory p = _launch(founder, keccak256("mine"));
        vm.prank(alice);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.openAuction(p.key);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.WrongRunner.selector, Launcher.RunnerKind.Pair));
        launcher.openAuction(p.key); // a single founder may not open the auction
        vm.prank(founder);
        vm.expectRevert(Finisher.NotLauncher.selector);
        p.finisher.open("");
        vm.prank(address(p.treasury));
        vm.expectRevert(Finisher.NotLauncher.selector);
        p.finisher.open("");
        // an agent of the project is a different account: opening a sale is the runner's own touch
        vm.prank(founder);
        p.treasury.authoriseAgent(bob);
        vm.prank(bob);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.openAuction(p.key);
        // with a Pair: one signer alone cannot (the Launcher answers only the Pair itself), both can, and a second open sale is
        // refused
        _team(p);
        vm.prank(founder);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.openAuction(p.key);
        _open(p);
        _openRefused(p, abi.encodeWithSelector(Finisher.CannotOpen.selector));
    }

    function test_openSale_aProjectThatAlreadySoldCannotSellAgain() public {
        Proj memory p = _launch(founder, keccak256("sold"));
        Sale memory s = _open(p);
        _flat(s, 100_000 * DOLLAR);
        _toEnd(s);
        _finish(p, s);
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Done));
        vm.roll(block.number + 1_000_000);
        _openRefused(p, abi.encodeWithSelector(Launcher.WrongStage.selector));
    }

    // ============================================== bid rules on a real sale ===========================================

    function test_bids_dustIsRefusedAndOneDollarIsNot() public {
        Proj memory p = _launch(founder, keccak256("dust"));
        Sale memory s = _open(p);
        vm.roll(s.startBlock);
        _fund(alice, 5 * DOLLAR, s);
        vm.startPrank(alice);
        vm.expectRevert();
        s.auction.submitBid(_price(s, 1), uint128(DOLLAR - 1), alice, s.floorQ96, ""); // 0.999999 dollars
        vm.expectRevert();
        s.auction.submitBid(_price(s, 1), 1, alice, s.floorQ96, ""); // one millionth of a dollar
        s.auction.submitBid(_price(s, 1), uint128(DOLLAR), alice, s.floorQ96, ""); // exactly one dollar
        vm.stopPrank();
    }

    function test_bids_aTopPriceAboveFourTimesIsRefusedAndFourTimesIsNot() public {
        Proj memory p = _launch(founder, keccak256("cap"));
        Sale memory s = _open(p);
        vm.roll(s.startBlock);
        _fund(alice, 100 * DOLLAR, s);
        vm.startPrank(alice);
        vm.expectRevert();
        s.auction.submitBid(_price(s, 301), uint128(10 * DOLLAR), alice, s.floorQ96, ""); // one tick above 4 times
        s.auction.submitBid(_price(s, 300), uint128(10 * DOLLAR), alice, s.floorQ96, ""); // exactly 4 times
        vm.stopPrank();
        assertEq(_price(s, 300), 4 * s.floorQ96, "tick 300 above the floor is 4 times the floor");
    }

    /// @dev The closing window: the last bid that counts is in block end - 720; from end - 719 to the last block of the sale (end - 1; the auction itself
    /// refuses from `end`) a bid is refused with the block and the last allowed block in the error. (Why: `MinBid` and `AttackM3.t.sol`.)
    function test_bids_nothingInTheLast720BlocksOfTheSale() public {
        Proj memory p = _launch(founder, keccak256("window"));
        Sale memory s = _open(p);
        assertEq(s.endBlock - s.startBlock, 7200, "the sale is 7,200 blocks");
        _fund(alice, 100 * DOLLAR, s);
        vm.roll(s.endBlock - 720);
        vm.prank(alice);
        s.auction.submitBid(_price(s, 1), uint128(DOLLAR), alice, s.floorQ96, ""); // the last block that takes bids
        uint256[3] memory late = [uint256(s.endBlock - 719), s.endBlock - 360, s.endBlock - 1];
        for (uint256 i; i < late.length; ++i) {
            vm.roll(late[i]);
            bytes memory reason =
                abi.encodeWithSignature("BidTooLate(uint256,uint256)", late[i], uint256(s.endBlock - 720));
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSignature("ValidationHookCallFailed(bytes)", reason));
            s.auction.submitBid(_price(s, 1), uint128(DOLLAR), alice, s.floorQ96, "");
        }
        assertEq(s.auction.nextBidId(), 1, "only the early bid went in");
    }
}

abstract contract SaleRulesBase3 is Platform {
    function _fork() internal pure virtual returns (bool);

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    // ============================================== a stranger creates the pool first ================================

    function _initializeAt(PoolKey memory key) internal returns (bool ok) {
        vm.prank(stranger);
        try IPoolManagerTest(poolManager).initialize(key, uint160(1) << 96) returns (int24) {
            return true;
        } catch {
            return false;
        }
    }

    // ============================================== who may sweep what =================================================

    function test_sweeps_onlyTheNamedRecipientsMaySweep() public {
        Proj memory p = _launch(founder, keccak256("sweeps"));
        Sale memory s = _open(p);
        _fiveBids(s);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        address[4] memory who = [stranger, founder, address(p.treasury), platform];
        for (uint256 i; i < who.length; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert();
            s.auction.sweepCurrency(); // only the strategy
            vm.expectRevert();
            s.auction.sweepUnsoldTokens(); // only the Finisher
            vm.stopPrank();
        }
        assertEq(usd.balanceOf(platform), 0, "no fee was taken by those calls");
    }

    /// @dev Before the sale opens, while it runs and after the pool step: a stranger cannot create the guarded pool (the guard
    /// refuses everyone but the strategy), and a plain pool at the same price changes nothing about the project's own.
    function test_attack_aStrangerCreatesThePoolFirst() public {
        Proj memory p = _launch(founder, keccak256("poolfirst"));
        PoolKey memory key = _key(p);
        assertFalse(_initializeAt(key), "before the sale: the guarded pool cannot be created by a stranger");
        PoolKey memory plain = key;
        plain.hooks = address(0);
        assertTrue(_initializeAt(plain), "a plain pool of the same two tokens is the stranger's own, and harmless");
        Sale memory s = _open(p); // the sale opens although a plain pool exists
        assertFalse(_initializeAt(key), "while the sale runs: still refused");
        _fiveBids(s);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        p.finisher.openPool();
        assertTrue(p.finisher.poolIsOpen(), "the project's own pool, at the guarded key, was made by the strategy");
        assertTrue(p.finisher.settle());
        assertEq(
            _sqrtPrice(plain),
            uint160(1) << 96,
            "the stranger's plain pool is a different pool, at the stranger's price"
        );
        // and the Finisher's answer does not depend on the plain pool: a project with only a stranger's plain pool has none
        Proj memory q = _launch(founder, keccak256("poolfirst two"));
        PoolKey memory plain2 = _key(q);
        plain2.hooks = address(0);
        assertTrue(_initializeAt(plain2));
        assertFalse(q.finisher.poolIsOpen(), "a stranger's plain pool is never taken for the project's pool");
    }

    // ============================================== a dollar token that misbehaves =====================================

    /// @dev The assumption, stated: the platform's dollar token is one ordinary ERC-20 per network, chosen by the platform. It
    /// may revert on a transfer to a frozen address (as a real stablecoin can). Then: a frozen Treasury stops step 2 and leaves
    /// nothing half done; a frozen Finisher or a frozen fee recipient stops the pool step itself (the strategy cannot send the
    /// money) until the address is unfrozen, and nothing is lost meanwhile.
    function test_attack_aDollarTokenThatFreezesAnAddressStopsTheFinishWithoutHalfDoingIt() public {
        Proj memory p = _launch(founder, keccak256("hostile"));
        Sale memory s = _open(p);
        _fiveBids(s);
        _toEnd(s);
        vm.roll(s.endBlock + 1);

        // a frozen fee recipient: the auction cannot pay the 3% when it is swept, so the pool step cannot run
        usd.setBlocked(platform, true);
        vm.prank(stranger);
        vm.expectRevert();
        p.finisher.openPool();
        usd.setBlocked(platform, false);
        // a frozen Finisher: the strategy cannot send back what the pool did not take
        usd.setBlocked(address(p.finisher), true);
        vm.prank(stranger);
        vm.expectRevert();
        p.finisher.openPool();
        usd.setBlocked(address(p.finisher), false);
        assertEq(
            usd.balanceOf(address(s.auction)),
            320_000 * DOLLAR,
            "nothing was lost: every dollar is still in the auction"
        );
        assertFalse(p.finisher.poolIsOpen());

        vm.prank(stranger);
        assertTrue(p.finisher.openPool(), "once unfrozen the pool step runs");

        // a frozen Treasury: step 2 reverts as a whole
        usd.setBlocked(address(p.treasury), true);
        uint256 held = usd.balanceOf(address(p.finisher));
        vm.prank(stranger);
        vm.expectRevert();
        p.finisher.settle();
        assertFalse(p.finisher.settled(), "step 2 left nothing half done");
        assertFalse(p.treasury.poolOpen());
        assertEq(p.vester.start(), 0);
        assertEq(usd.balanceOf(address(p.finisher)), held, "the money is where it was");
        usd.setBlocked(address(p.treasury), false);
        vm.prank(stranger);
        assertTrue(p.finisher.settle());
        assertEq(usd.balanceOf(address(p.finisher)), 0);
    }
}

contract SaleRulesLocalTest is SaleRulesBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract SaleRulesForkTest is SaleRulesBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

contract SaleRulesLocal2Test is SaleRulesBase2 {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract SaleRulesLocal3Test is SaleRulesBase3 {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract SaleRulesFork2Test is SaleRulesBase2 {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

contract SaleRulesFork3Test is SaleRulesBase3 {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
