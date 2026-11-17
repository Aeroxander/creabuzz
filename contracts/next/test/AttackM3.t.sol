// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Platform} from "./helpers/Platform.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Finisher} from "../src/Finisher.sol";
import {IAuctionTest, IPermit2Test} from "./helpers/UniswapTest.sol";
import {
    PoolKey,
    PoolRead,
    SaleParams,
    MigratorParameters,
    PoolParameters,
    LiquidityAllocationBracket,
    AuctionParameters,
    IPinnedStrategy
} from "../src/Pinned.sol";

/// @notice Attack tests for milestone 3, first written by a tester who could not change the sources, then kept as regression tests
/// once the two defects they found were fixed. Each test is one hostile plan; a test whose name starts `test_attack_` states what
/// must hold. The first two defects: (1) a few dollars of bids in the last blocks of a sale set the pool's opening price and let a
/// holder take the pool's dollars, fixed by the closing window of 720 blocks in `MinBid` (the plan now is the same, placed at the
/// window's edge, and it loses money); (2) after a failed pool step any holder could make a pool at the project's key and the
/// Finisher took it for the project's, fixed by `Finisher.poolIsOpen` also asking that the pool step took this sale's money.
/// Run: `forge test --match-path test/AttackM3.t.sol -vv` (the fork variants need SEPOLIA_RPC_URL).
abstract contract AttackM3Common is Platform {
    function _fork() internal pure virtual returns (bool);

    address internal mallory = makeAddr("mallory");
    address internal malloryTwo = makeAddr("malloryTwo");

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    function _str(uint256 x, uint256 decimals) internal pure returns (string memory) {
        uint256 unit = 10 ** decimals;
        string memory frac = vm.toString(x % unit);
        while (bytes(frac).length < decimals) frac = string.concat("0", frac);
        return string.concat(vm.toString(x / unit), ".", frac);
    }

    // =========================================== a sale with an attacker in it =======================================

    struct Run {
        Proj p;
        Sale s;
        uint256[] attackerBids;
        uint256 minted; // dollars the attacker put in
        uint256 finalPriceQ96;
        uint256 poolUsd;
        uint256 poolShares;
        uint256 refundedAndSpent; // dollars the attacker has left after every exit
        uint256 attackerShares;
    }

    /// @dev The closing window: the last block that takes a bid is `endBlock - CLOSING`.
    uint256 internal constant CLOSING = 720;

    /// @dev The attacker's spike bid in block `blk`: a top price of the highest tick the 4-times rule allows against that block's
    /// clearing price, with enough dollars to buy every Share still to be issued at that price three times over (the rest is
    /// refunded). With `tryIt` a refused bid is skipped. Returns the bid and the dollars put in.
    function _spikeAt(Sale memory s, uint256 blk, bool tryIt) internal returns (uint256 bidId, uint256 amount) {
        vm.roll(blk);
        s.auction.checkpoint();
        uint256 c = s.auction.clearingPrice();
        uint256 maxPrice = s.floorQ96 + ((4 * c - s.floorQ96) / s.tickQ96) * s.tickQ96;
        uint256 need = maxPrice * ((s.endBlock - blk) * 60_000e18) >> 96;
        amount = need * 3 + DOLLAR;
        _fund(mallory, amount, s);
        bidId = s.auction.nextBidId();
        vm.prank(mallory);
        if (tryIt) {
            try s.auction.submitBid(maxPrice, uint128(amount), mallory, s.floorQ96, "") {}
            catch {
                amount = 0;
            }
        } else {
            s.auction.submitBid(maxPrice, uint128(amount), mallory, s.floorQ96, "");
        }
    }

    /// @dev One Standard sale: four honest bidders with 2,250 dollars each at one tick above the floor, the attacker with
    /// `ordinary` dollars at one tick above the floor, then `spikes` bids by the attacker in the last `spikes` blocks, each with the
    /// top price the 4-times rule allows against the clearing price of that block. Finished by a stranger.
    function _sale(bytes32 id, uint256 ordinary, uint256 spikes) internal returns (Run memory r) {
        return _saleSized(Launcher.Size.Standard, id, ordinary, spikes);
    }

    function _saleSized(Launcher.Size size, bytes32 id, uint256 ordinary, uint256 spikes)
        internal
        returns (Run memory r)
    {
        r.p = _launch(founder, id);
        r.s = _open(r.p, size);
        vm.roll(r.s.startBlock);
        (uint256 goal,) = launcher.sizeOf(size);
        address[4] memory honest = [alice, bob, carol, dave];
        for (uint256 i; i < 4; ++i) {
            _bid(r.s, honest[i], goal * 225 / 1000, 1);
        }
        r.attackerBids = new uint256[](spikes + 1);
        if (ordinary != 0) {
            r.attackerBids[0] = _bid(r.s, mallory, ordinary, 1);
            r.minted += ordinary;
        }
        for (uint256 j; j < spikes; ++j) {
            (uint256 bidId, uint256 amount) = _spikeAt(r.s, r.s.endBlock - CLOSING - (spikes - 1 - j), false);
            r.attackerBids[j + 1] = bidId;
            r.minted += amount;
        }
        _toEnd(r.s);
        r.finalPriceQ96 = r.s.auction.clearingPrice();
        _finish(r.p, r.s);
        PoolKey memory key = _key(r.p);
        r.poolUsd = usd.balanceOf(poolManager);
        r.poolShares = r.p.shares.balanceOf(poolManager);
        key;
        // the attacker collects every bid
        for (uint256 b; b < r.attackerBids.length; ++b) {
            if (b == 0 && ordinary == 0) continue;
            _collectBid(r.s, r.attackerBids[b]);
        }
        r.refundedAndSpent = usd.balanceOf(mallory);
        r.attackerShares = r.p.shares.balanceOf(mallory);
    }

    /// @dev Sell `n` Shares from the attacker into the pool; returns the dollars received.
    function _dump(Run memory r, uint256 n) internal returns (uint256 got) {
        (, got) = _swap(_key(r.p), address(r.p.shares), mallory, false, n);
    }

    /// @dev The best dump (of 10 sizes) and its dollars, then the state is restored.
    function _bestDump(Run memory r) internal returns (uint256 bestGot, uint256 bestN) {
        uint256 snap = vm.snapshotState();
        for (uint256 f = 1; f <= 10; ++f) {
            vm.revertToState(snap);
            snap = vm.snapshotState();
            uint256 n = r.attackerShares * f / 10;
            if (n == 0) continue;
            uint256 got = _dump(r, n);
            if (got > bestGot) (bestGot, bestN) = (got, n);
        }
        vm.revertToState(snap);
    }

    function _report(string memory tag, Run memory r) internal returns (int256 profit) {
        (uint256 got, uint256 n) = _bestDump(r);
        uint256 spent = r.minted - r.refundedAndSpent;
        profit = int256(got) - int256(spent);
        emit log_string(string.concat(
                tag,
                ": final price ",
                vm.toString(r.finalPriceQ96 * 1000 / r.s.floorQ96),
                " thousandths of the floor price; pool holds ",
                _str(r.poolUsd, 6),
                " dollars and ",
                _str(r.poolShares / 1e12, 6),
                " Shares; attacker net spent ",
                _str(spent, 6),
                ", holds ",
                _str(r.attackerShares / 1e12, 6),
                " Shares; best dump of ",
                _str(n / 1e12, 6),
                " Shares returns ",
                _str(got, 6),
                " dollars; profit ",
                profit < 0 ? "-" : "+",
                _str(uint256(profit < 0 ? -profit : profit), 6)
            ));
    }

    // ================================ the final price, and what the pool is seeded at ================================

    // ================================ a founder who bids from a second account =======================================

    // ================================ a transient failure of the pool step, then a fake pool ==========================

    /// @dev Builds and runs, as `mallory`, a second sale through the strategy for the project's own Share token with the
    /// project's own pool key (dollar, Share, 1%, spacing 200, the platform's guard). It needs only two Shares and a few cents.
    /// The strategy lets any holder do this once the first sale's reservation of the key has been cleared, and the guard only asks
    /// that the strategy is the creator.
    function _fakePool(Proj memory p, Sale memory real) internal returns (address fakeAuction) {
        vm.startPrank(mallory);
        p.shares.approve(strategy, 2e18);
        uint64 start = uint64(block.number + 1);
        uint64 end = start + 10;
        LiquidityAllocationBracket[] memory br = new LiquidityAllocationBracket[](1);
        br[0] = LiquidityAllocationBracket({lowerThreshold: 0, rate: 10_000_000});
        MigratorParameters memory mp = MigratorParameters({
            token: address(p.shares),
            currency: address(usd),
            migrationBlock: end + 1,
            reservedTokenAmountForLP: 1e18,
            recipient: mallory,
            positionRecipient: mallory,
            poolParameters: PoolParameters({
                fee: SaleParams.POOL_FEE, tickSpacing: SaleParams.POOL_TICK_SPACING, hook: guard
            }),
            positionDefinitions: abi.encode(new uint256[](0)),
            lpAllocationSchedule: abi.encode(br)
        });
        AuctionParameters memory ap = AuctionParameters({
            currency: address(usd),
            tokensRecipient: mallory,
            fundsRecipient: strategy,
            startBlock: start,
            endBlock: end,
            claimBlock: end + 1,
            tickSpacing: real.tickQ96,
            validationHook: address(0),
            floorPrice: real.floorQ96,
            requiredCurrencyRaised: 1,
            auctionStepsData: abi.encodePacked(bytes8(uint64(1_000_000) << 40 | uint64(10)))
        });
        IPinnedStrategy(strategy)
            .initializeDistribution(address(p.shares), 2e18, abi.encode(mp, abi.encode(ap)), bytes32(0));
        vm.stopPrank();
        fakeAuction = IPinnedStrategy(strategy).registeredPoolIds(PoolRead.id(p.finisher.poolKey()));
        // bid in the second sale, let it end, and run its pool step
        Sale memory fake;
        fake.auction = IAuctionTest(fakeAuction);
        vm.roll(start);
        _fund(mallory, 2 * DOLLAR, fake);
        vm.prank(mallory);
        fake.auction.submitBid(real.floorQ96 + real.tickQ96, uint128(2 * DOLLAR), mallory, real.floorQ96, "");
        vm.roll(end);
        fake.auction.checkpoint();
        vm.roll(end + 1);
        IPinnedStrategy(strategy).migrate(fakeAuction);
    }

    function _soldOutStandard(bytes32 id) internal returns (Proj memory p, Sale memory s, uint256 malloryBid) {
        p = _launch(founder, id);
        s = _open(p, Launcher.Size.Standard);
        vm.roll(s.startBlock);
        address[4] memory honest = [alice, bob, carol, dave];
        for (uint256 i; i < 4; ++i) {
            _bid(s, honest[i], 2250 * DOLLAR, 1);
        }
        malloryBid = _bid(s, mallory, 1000 * DOLLAR, 1);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
    }

    function callFakePool(Proj memory p, Sale memory s) external {
        _fakePool(p, s);
    }

    // ================================ many initialised price levels and the final checkpoint ==========================

    function _bidAt(Sale memory s, address who, uint256 amount, uint256 maxPrice, uint256 prevTick) internal {
        s.auction.submitBid(maxPrice, uint128(amount), who, prevTick, "");
    }

    // ================================ gifts of dollars and Shares to every contract in the finish =====================

    struct Outcome {
        uint256 arrived;
        uint256 spendable;
        uint256 melting;
        uint128 liquidity;
        uint160 sqrtPrice;
        uint256 platformUsd;
        uint256 treasuryShares;
        bool closed;
    }

    function _outcome(Proj memory p) internal view returns (Outcome memory o) {
        PoolKey memory key = _key(p);
        o = Outcome({
            arrived: p.treasury.spendable() + p.treasury.melting(),
            spendable: p.treasury.spendable(),
            melting: p.treasury.melting(),
            liquidity: _poolLiquidity(key),
            sqrtPrice: _sqrtPrice(key),
            platformUsd: usd.balanceOf(platform),
            treasuryShares: p.shares.balanceOf(address(p.treasury)),
            closed: p.treasury.saleClosed()
        });
    }

    function _giftEverything(Proj memory p, Sale memory s, uint256 dollars, uint256 sharesToGive) internal {
        address[8] memory to = [
            strategy,
            address(p.finisher),
            address(p.treasury),
            address(s.auction),
            positionManager,
            poolManager,
            address(p.vester),
            address(holder)
        ];
        for (uint256 i; i < to.length; ++i) {
            usd.mint(to[i], dollars);
            vm.prank(mallory);
            p.shares.transfer(to[i], sharesToGive);
        }
    }

    // ================================ abandon after a late success =====================================================

    // ================================ a price-moving trade between the finish steps =====================================

    // ================================ fuzz: any demand, any spikes, any gifts =========================================

    function _spikeBids(Sale memory s, uint256 spikes) internal {
        for (uint256 j; j < spikes; ++j) {
            _spikeAt(s, s.endBlock - CLOSING - (spikes - 1 - j), true);
        }
    }

    function _finishOrFail(Proj memory p, Sale memory s) internal {
        s;
        vm.startPrank(stranger);
        p.finisher.openPool();
        if (s.auction.isGraduated()) p.finisher.settle();
        p.finisher.sweep();
        vm.stopPrank();
    }

    // ================================ buy below the floor and hand back, by sale size =================================

    function _bearProject(Launcher.Size size, bytes32 id) internal returns (Proj memory p) {
        p = _launch(founder, id);
        Sale memory s = _open(p, size);
        (uint256 goal,) = launcher.sizeOf(size);
        uint256[5] memory ids = _flat(s, goal);
        _toEnd(s);
        _finish(p, s);
        for (uint256 i; i < 5; ++i) {
            _collectBid(s, ids[i]);
        }
    }

    function _floorPerShare(Proj memory p) internal view returns (uint256) {
        return p.treasury.melting() * 1e30 / p.treasury.countingSupply();
    }

    /// @dev Holders sell Shares into the pool, a small chunk at a time, until its price is `discountBps` under the floor per Share.
    function _dumpToDiscount(Proj memory p, uint256 discountBps) internal returns (uint256 reachedBps) {
        PoolKey memory key = _key(p);
        uint256 floorPS = _floorPerShare(p);
        uint256 target = floorPS * (10_000 - discountBps) / 10_000;
        address[5] memory h = [alice, bob, carol, dave, erin];
        uint256 chunk = p.shares.balanceOf(poolManager) / 100;
        for (uint256 i; i < 400 && _spot(key) > target; ++i) {
            address who = h[i % 5];
            if (p.shares.balanceOf(who) < chunk) break;
            _swap(key, address(p.shares), who, false, chunk);
        }
        uint256 spot = _spot(key);
        reachedBps = spot >= floorPS ? 0 : (floorPS - spot) * 10_000 / floorPS;
    }

    function _buyAndHandBack(Proj memory p, uint256 trade) internal returns (int256 profit) {
        usd.mint(trader, trade);
        (uint256 paid, uint256 got) = _swap(_key(p), address(p.shares), trader, true, trade);
        uint256 before_ = usd.balanceOf(trader);
        vm.startPrank(trader);
        p.shares.approve(address(p.treasury), type(uint256).max);
        p.treasury.handBack(got);
        vm.stopPrank();
        profit = int256(usd.balanceOf(trader) - before_) - int256(paid);
    }

    // ================================ a frozen Treasury while fees are collected =====================================

    function _nextTokenId() internal view returns (uint256 id) {
        (bool ok, bytes memory ret) = positionManager.staticcall(abi.encodeWithSignature("nextTokenId()"));
        require(ok);
        id = abi.decode(ret, (uint256));
    }
}

abstract contract AttackM3PoolSeedBase is AttackM3Common {
    /// @dev The plan: a bidder who holds ordinary Shares bought at the floor spends on bids that lift the final clearing price (the
    /// pool's opening price), so the pool holds the same dollars (22 of 100 raised) and far fewer Shares and Shares sold into it
    /// return a multiple of what they cost. Before the closing window the bids could go into the last block, where a few dollars
    /// bought the whole lift (x4 for 5.66 dollars, x256 for 493 on a 10,000-dollar sale; the best dump then took 64% and 99% of the
    /// pool's dollars, a profit of 410 and 794 on a 1,000-dollar position). Now the last bid that counts is 720 blocks before the end, so
    /// a lifted price must be paid on every one of those blocks. The test measures a no-attack baseline, then 1 to 4 spike bids in
    /// consecutive blocks ending at the edge of the window, and requires that none of them pays.
    function test_attack_spikeBidsAtTheEdgeOfTheClosingWindowSeedThePoolButLoseMoney() public {
        uint256 base = vm.snapshotState();
        Run memory r0 = _sale(keccak256("a0"), 1000 * DOLLAR, 0);
        int256 p0 = _report("baseline (no spike)", r0);
        assertLt(p0, 0, "without a spike, selling into the pool loses money");

        for (uint256 spikes = 1; spikes <= 4; ++spikes) {
            vm.revertToState(base);
            base = vm.snapshotState();
            Run memory r = _sale(keccak256(abi.encode("a", spikes)), 1000 * DOLLAR, spikes);
            int256 profit = _report(string.concat(vm.toString(spikes), " spike bid(s) at the edge of the window"), r);
            assertGt(r.finalPriceQ96, r0.finalPriceQ96, "the price is lifted: the attack is real, it just does not pay");
            assertLt(profit, 0, "a lift paid for on every block of the closing window costs more than the pool holds");
            uint256 spent = r.minted - r.refundedAndSpent;
            assertGt(spent, r.poolUsd, "the lift alone costs more than all the dollars in the pool");
        }
    }

    /// @dev The same bids one block later (inside the window) are refused, in the first block of it and in the last.
    function test_attack_aBidInTheClosingWindowIsRefused() public {
        Proj memory p = _launch(founder, keccak256("window-attack"));
        Sale memory s = _open(p, Launcher.Size.Standard);
        vm.roll(s.startBlock);
        _bid(s, alice, 9000 * DOLLAR, 1);
        uint256[3] memory blocks_ = [uint256(s.endBlock - CLOSING + 1), s.endBlock - 1, s.endBlock];
        for (uint256 i; i < blocks_.length; ++i) {
            vm.roll(blocks_[i]);
            s.auction.checkpoint();
            uint256 c = s.auction.clearingPrice();
            uint256 maxPrice = s.floorQ96 + ((4 * c - s.floorQ96) / s.tickQ96) * s.tickQ96;
            _fund(mallory, 10 * DOLLAR, s);
            vm.prank(mallory);
            vm.expectRevert();
            s.auction.submitBid(maxPrice, uint128(10 * DOLLAR), mallory, s.floorQ96, "");
        }
    }

    /// @dev The founder's second account does the same, and the dollars it takes out of the pool are other bidders' money. The
    /// founder's whole position is counted: what the Treasury holds (his to spend now or over a year), what the second account takes
    /// from the pool, less what that account put into the sale. The same sale with only the honest bidders is the baseline.
    function test_attack_aFounderDrainsThePoolWithASecondAccount() public {
        uint256 base = vm.snapshotState();
        Run memory r0 = _sale(keccak256("founder-base"), 0, 0);
        uint256 v0 = r0.p.treasury.spendable() + r0.p.treasury.melting();
        vm.revertToState(base);
        Run memory r = _sale(keccak256("founder-two"), 1000 * DOLLAR, 4);
        uint256 v1 = r.p.treasury.spendable() + r.p.treasury.melting();
        (uint256 got,) = _bestDump(r);
        uint256 spent = r.minted - r.refundedAndSpent;
        emit log_named_uint("project money without the attack (spendable + floor)", v0);
        emit log_named_uint("project money with the attack", v1);
        emit log_named_uint("pool dollars at opening", r.poolUsd);
        emit log_named_uint("dollars the second account takes out of the pool", got);
        emit log_named_uint("what the second account put into the sale, net of refunds", spent);
        int256 gain = int256(v1) + int256(got) - int256(spent) - int256(v0);
        emit log_named_int("the founder's gain from the attack (6 decimals)", gain);
        assertLt(got, r.poolUsd, "cannot take more than the pool holds");
        assertLe(gain, 0, "THE FOUNDER GAINS BY BIDDING IN HIS OWN SALE: the pool's dollars are other bidders' money");
        assertLt(got, spent, "what the second account takes out is less than it put in");
    }

    /// @dev The same plan at each sale size: the attacker holds 10% of the goal in ordinary Shares and places one and four spike bids at
    /// the edge of the closing window. Reports how much of the pool's dollars the best dump takes out, and the attacker's profit;
    /// the profit must be negative for every size.
    function test_attack_edgeSpikes_bySaleSize() public {
        uint256 base = vm.snapshotState();
        Launcher.Size[3] memory sizes = [Launcher.Size.Small, Launcher.Size.Standard, Launcher.Size.Large];
        for (uint256 z; z < 3; ++z) {
            (uint256 goal,) = launcher.sizeOf(sizes[z]);
            uint256[3] memory blocks_ = [uint256(0), 1, 4];
            for (uint256 b; b < 3; ++b) {
                vm.revertToState(base);
                base = vm.snapshotState();
                Run memory r = _saleSized(sizes[z], keccak256(abi.encode("bs", z, b)), goal / 10, blocks_[b]);
                (uint256 got,) = _bestDump(r);
                uint256 spent = r.minted - r.refundedAndSpent;
                emit log_string(string.concat(
                        "goal ",
                        vm.toString(goal / DOLLAR),
                        ", spike blocks ",
                        vm.toString(blocks_[b]),
                        ": final price x",
                        _str(r.finalPriceQ96 * 100 / r.s.floorQ96, 2),
                        ", pool ",
                        _str(r.poolUsd, 6),
                        " dollars, attacker spent ",
                        _str(spent, 6),
                        ", pool dollars taken ",
                        _str(got, 6),
                        " (",
                        vm.toString(got * 100 / r.poolUsd),
                        "% of the pool), profit ",
                        got >= spent ? "+" : "-",
                        _str(got >= spent ? got - spent : spent - got, 6)
                    ));
                if (blocks_[b] != 0) {
                    assertLt(got, spent, "a spike at the edge of the window does not pay at any size");
                }
            }
        }
    }
}

contract AttackM3PoolSeedLocalTest is AttackM3PoolSeedBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract AttackM3PoolSeedForkTest is AttackM3PoolSeedBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

abstract contract AttackM3FinishBase is AttackM3Common {
    /// @dev The Finisher's test for "a pool exists" is "the pool manager holds liquidity at the project's key and the guard names
    /// the strategy". The key is reserved in the strategy while the sale's own pool step is pending; once that step has run and
    /// failed (the same transient failure the milestone 3 abandon tests use: the dollar token refuses the position manager for
    /// a while), the reservation is clear and any holder of the project's Shares can create a pool at the same key through the
    /// strategy, at a price and with liquidity of his choosing. The Finisher then takes it for the project's pool: step 2 sends the
    /// 97 dollars of every 100 to the Treasury and splits them 15:60, so the founder gets 19.4 spendable instead of the 15 that the
    /// way out (abandon) pays, and the way out is shut (PoolExists). The assertions state what should hold; they fail today.
    function test_attack_afterATransientPoolFailureAHolderMakesAFakePoolAndTheFinishTreatsItAsTheProjectsPool() public {
        (Proj memory p, Sale memory s, uint256 mid) = _soldOutStandard(keccak256("fake"));
        uint256 raised = s.auction.currencyRaised();
        _failThePoolStep(true);
        p.finisher.openPool();
        _failThePoolStep(false);
        assertFalse(p.finisher.poolIsOpen(), "no pool after the failed step");
        _collectBid(s, mid);
        assertGt(p.shares.balanceOf(mallory), 2e18, "the attacker holds Shares he bought in the sale");

        address fakeAuction = _fakePool(p, s);
        emit log_named_address("the attacker's own auction, holding the project's pool key", fakeAuction);
        bool fakeIsTakenForReal = p.finisher.poolIsOpen();
        emit log_named_string("Finisher.poolIsOpen() after the fake pool", fakeIsTakenForReal ? "true" : "false");

        // the stranger finishes: step 2 and 3
        if (fakeIsTakenForReal) {
            p.finisher.settle();
            p.finisher.sweep();
            emit log_named_uint("spendable (dollars, 6 decimals)", p.treasury.spendable());
            emit log_named_uint("fifteen percent of the raise", raised * 15 / 100);
            emit log_named_uint("floor (melting)", p.treasury.melting());
            emit log_named_uint(
                "eighty-two percent of the raise (what abandon would put in the floor)", raised * 82 / 100
            );
        }
        assertFalse(fakeIsTakenForReal, "A POOL THAT THE ATTACKER MADE WITH TWO SHARES IS TAKEN FOR THE PROJECT'S POOL");
    }

    /// @dev The fix for the fake pool: it is at the key, but the pool step took none of this sale's money, so the Finisher does not
    /// count it. Step 2 refuses, and seven days after the sale the way out opens and pays what a sale with no pool pays: of each
    /// 100 raised 3 to the platform, 15 spendable, 82 into the floor (before the fix it was refused with `PoolExists` for good, and
    /// step 2 split 19.4 : 77.6).
    function test_attack_afterAFakePoolTheWayOutStillOpensAndPaysFifteenAndEightyTwo() public {
        (Proj memory p, Sale memory s, uint256 mid) = _soldOutStandard(keccak256("fake-out"));
        uint256 raised = s.auction.currencyRaised();
        _failThePoolStep(true);
        p.finisher.openPool();
        _failThePoolStep(false);
        _collectBid(s, mid);
        _fakePool(p, s);
        assertTrue(p.finisher.poolAtTheKey(), "the fake pool is at the key, with liquidity and the right guard");
        assertFalse(p.finisher.poolIsOpen(), "but the pool step took none of this sale's money");
        vm.expectRevert(Finisher.NoPool.selector);
        p.finisher.settle();
        vm.roll(s.endBlock + 50_400);
        vm.prank(stranger);
        p.finisher.abandon();
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Abandoned));
        assertFalse(p.finisher.poolIsOpen(), "an abandoned sale has no pool of its own, whatever stands at the key");
        assertTrue(p.treasury.saleClosed(), "exits are open");
        assertApproxEqAbs(p.treasury.spendable(), raised * 15 / 100, 1000, "15 of each 100 raised are spendable");
        assertApproxEqAbs(p.treasury.melting(), raised * 82 / 100, 1000, "82 of each 100 are the floor");
        assertEq(usd.balanceOf(platform), raised * 3 / 100, "3 to the platform");
        assertGt(p.vester.start(), 0, "the founder's Shares start releasing");
    }

    /// @dev After step 2 the pool is the project's for good: dollars sent to the Finisher then (more than the pool's budget, so that
    /// "dollars missing from what the Finisher holds" would read as nothing taken) must not make the pool look absent and open the way
    /// out, which would split the sale's money a second time.
    function test_attack_aGiftAfterStepTwoCannotOpenTheWayOutAgain() public {
        (Proj memory p, Sale memory s, uint256 mid) = _soldOutStandard(keccak256("after-two"));
        _collectBid(s, mid);
        p.finisher.openPool();
        p.finisher.settle();
        assertTrue(p.finisher.poolIsOpen());
        usd.mint(address(p.finisher), 100_000 * DOLLAR);
        assertTrue(p.finisher.poolIsOpen(), "a gift after step 2 changes nothing");
        vm.roll(s.endBlock + 50_400);
        vm.expectRevert(Finisher.PoolExists.selector);
        p.finisher.abandon();
        p.finisher.sweep();
        assertTrue(p.treasury.saleClosed());
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Done));
    }

    /// @dev Measured, a limit of the fix: dollars sent to the Finisher before step 2 make a real pool look as if it took less. Up to
    /// 1,095 dollars on this 10,000-dollar sale (the pool's budget is 2,200) change nothing; 1,105 hide the pool: step 2 refuses, and
    /// seven days later the way out opens although a pool exists (the money is conserved and exits open; the gift went to the project,
    /// so the sender paid 1,105 dollars for it).
    function test_measured_aGiftOfMoreThanHalfThePoolsBudgetHidesARealPool() public {
        (Proj memory p, Sale memory s, uint256 mid) = _soldOutStandard(keccak256("grief"));
        _collectBid(s, mid);
        uint256 snap = vm.snapshotState();
        usd.mint(address(p.finisher), 1095 * DOLLAR);
        p.finisher.openPool();
        assertTrue(p.finisher.poolIsOpen(), "a gift under half the budget changes nothing");
        p.finisher.settle();
        vm.revertToState(snap);
        usd.mint(address(p.finisher), 1105 * DOLLAR);
        p.finisher.openPool();
        assertTrue(p.finisher.poolAtTheKey(), "the real pool is there");
        assertFalse(p.finisher.poolIsOpen(), "but it looks as if it took less than half its budget");
        vm.expectRevert(Finisher.NoPool.selector);
        p.finisher.settle();
        vm.roll(s.endBlock + 50_400);
        p.finisher.abandon();
        assertTrue(p.treasury.saleClosed(), "exits are open, so nobody is trapped");
    }

    /// @dev Measured, a limit that no code in this project can remove: the auction pays its 3% only through the strategy, and the
    /// strategy's recovery path pays it too. If the dollar token freezes the fee recipient, the pool step reverts (it is not
    /// swallowed), so `openPool` reverts, and so does `abandon`, which starts by running that step. The way out covers a pool step
    /// that never ran and one that failed and was swallowed; it does not cover a frozen fee recipient. Unfreezing frees it.
    function test_limit_aFrozenFeeRecipientStopsTheFinishAndTheWayOutToo() public {
        (Proj memory p, Sale memory s,) = _soldOutStandard(keccak256("frozen-fee"));
        usd.setBlocked(platform, true);
        vm.roll(s.endBlock + 50_400);
        vm.expectRevert();
        p.finisher.openPool();
        vm.expectRevert();
        p.finisher.abandon();
        assertFalse(p.treasury.saleClosed(), "nobody can exit while the fee recipient is frozen");
        usd.setBlocked(platform, false);
        p.finisher.openPool();
        p.finisher.settle();
        p.finisher.sweep();
        assertTrue(p.treasury.saleClosed(), "unfrozen, the ordinary finish completes");
    }

    /// @dev While the sale's own pool step is still pending the strategy has the key reserved: a second distribution cannot take it.
    function test_attack_theKeyIsReservedWhileTheSalesOwnPoolStepIsPending() public {
        (Proj memory p, Sale memory s, uint256 mid) = _soldOutStandard(keccak256("reserved"));
        _collectBid(s, mid);
        vm.expectRevert();
        this.callFakePool(p, s);
    }

    /// @dev The auction's own comment says the checkpoint "can revert with out of gas if there are a large number of ticks". The price
    /// grid between the floor and four times the floor has 300 levels; a $1 bid at each makes 300 initialised ticks, and one large
    /// bid in the last block that takes bids (the closing window keeps later ones out) moves the clearing price across all of them in
    /// the checkpoint of the next block, and the sale then runs to its end. Measures the gas of that checkpoint and of the three finish
    /// steps; the pool step must still be callable.
    function test_attack_threeHundredTicksThenOneJumpDoesNotWedgeTheFinish() public {
        Proj memory p = _launch(founder, keccak256("ticks"));
        Sale memory s = _open(p, Launcher.Size.Standard);
        vm.roll(s.startBlock);
        for (uint256 k = 1; k <= 300; ++k) {
            usd.mint(mallory, DOLLAR);
        }
        vm.startPrank(mallory);
        usd.approve(PERMIT2, type(uint256).max);
        IPermit2Test(PERMIT2).approve(address(usd), address(s.auction), type(uint160).max, type(uint48).max);
        for (uint256 k = 1; k <= 299; ++k) {
            _bidAt(s, mallory, DOLLAR, s.floorQ96 + k * s.tickQ96, s.floorQ96 + (k - 1) * s.tickQ96);
        }
        vm.stopPrank();
        _bid(s, alice, 9000 * DOLLAR, 1);
        vm.roll(s.endBlock - CLOSING);
        s.auction.checkpoint();
        uint256 c = s.auction.clearingPrice();
        uint256 maxPrice = s.floorQ96 + ((4 * c - s.floorQ96) / s.tickQ96) * s.tickQ96;
        _fund(bob, 5000 * DOLLAR, s);
        vm.prank(bob);
        s.auction.submitBid(maxPrice, uint128(5000 * DOLLAR), bob, s.floorQ96 + 299 * s.tickQ96, "");
        vm.roll(s.endBlock - CLOSING + 1);
        uint256 g0 = gasleft();
        s.auction.checkpoint();
        uint256 gCheckpoint = g0 - gasleft();
        emit log_named_uint("gas of the checkpoint that crosses ~300 initialised ticks", gCheckpoint);
        emit log_named_uint("price in thousandths of the floor", s.auction.clearingPrice() * 1000 / s.floorQ96);
        vm.roll(s.endBlock);
        s.auction.checkpoint();
        vm.roll(s.endBlock + 1);
        g0 = gasleft();
        p.finisher.openPool();
        emit log_named_uint("gas of openPool", g0 - gasleft());
        g0 = gasleft();
        p.finisher.settle();
        p.finisher.sweep();
        emit log_named_uint("gas of settle and sweep", g0 - gasleft());
        assertTrue(p.treasury.saleClosed(), "the finish completes");
        assertLt(gCheckpoint, 15_000_000, "the checkpoint fits in a quarter of a block");
    }

    /// @dev Dollars and Shares are sent to the strategy, the Finisher, the Treasury, the auction, the position manager, the pool
    /// manager, the Vester and the holder before the pool step. The pool (liquidity and price) is exactly the same; only what
    /// reached the Finisher and the Treasury (directly, or through the position manager's leftover) is split 15:60; the sale closes.
    function test_attack_giftsToEveryContractChangeNeitherThePoolNorTheSplitOfTheSaleMoney() public {
        (Proj memory p, Sale memory s, uint256 mid) = _soldOutStandard(keccak256("gifts"));
        _collectBid(s, mid);
        uint256 base = vm.snapshotState();
        p.finisher.openPool();
        p.finisher.settle();
        p.finisher.sweep();
        Outcome memory a = _outcome(p);
        vm.revertToState(base);
        _giftEverything(p, s, 300 * DOLLAR, 1_000_000e18);
        p.finisher.openPool();
        p.finisher.settle();
        p.finisher.sweep();
        Outcome memory b = _outcome(p);
        assertEq(b.liquidity, a.liquidity, "same liquidity");
        assertEq(b.sqrtPrice, a.sqrtPrice, "same price");
        assertEq(b.platformUsd, a.platformUsd, "same fee");
        // what was given to the Finisher, the Treasury and the position manager (which hands its whole balance back to the strategy
        // as leftover, and the strategy to the Finisher) is split with the sale money; the rest stays where it was given
        assertEq(
            b.arrived - a.arrived, 3 * 300 * DOLLAR, "only the gifts that reach the Finisher or the Treasury are split"
        );
        assertTrue(b.closed);
        assertGe(
            b.treasuryShares - a.treasuryShares,
            2 * 1_000_000e18,
            "Shares given to the Finisher and the Treasury are reserve"
        );
        // and exits work
        vm.startPrank(mallory);
        p.shares.approve(address(p.treasury), type(uint256).max);
        uint256 got = p.treasury.handBack(p.shares.balanceOf(mallory) / 2);
        vm.stopPrank();
        assertGt(got, 0);
    }

    /// @dev Nobody runs the pool step for seven days; a hostile holder who wants the way out (82 into the floor, not 60 and a pool)
    /// calls abandon at the first moment. The call runs the pool step, which works, and then refuses (PoolExists): the whole call
    /// is undone, so the pool step is still pending and an ordinary finish follows.
    function test_attack_abandonOnTheFirstBlockWithTheStepNeverRunLeavesTheSaleWhole() public {
        (Proj memory p, Sale memory s,) = _soldOutStandard(keccak256("late"));
        vm.roll(s.endBlock + 50_400);
        bytes32 before_ = keccak256(
            abi.encode(uint8(p.finisher.stage()), usd.balanceOf(address(p.finisher)), usd.balanceOf(strategy))
        );
        vm.prank(mallory);
        vm.expectRevert(Finisher.PoolExists.selector);
        p.finisher.abandon();
        bytes32 after_ = keccak256(
            abi.encode(uint8(p.finisher.stage()), usd.balanceOf(address(p.finisher)), usd.balanceOf(strategy))
        );
        assertEq(before_, after_, "nothing moved");
        _finish(p, s);
        assertTrue(p.treasury.saleClosed());
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Done));
        assertTrue(p.finisher.poolIsOpen());
    }

    /// @dev Between the pool step and the split a bot pushes the pool price a very long way up (a thousand times the pool's dollars)
    /// and back. The split does not depend on the price, the pool is still the project's pool, and the finish completes.
    function test_attack_aHugeTradeBetweenStepsOneAndTwoDoesNotChangeTheSplit() public {
        (Proj memory p, Sale memory s,) = _soldOutStandard(keccak256("sandwich"));
        // before the pool exists nobody can trade in it
        PoolKey memory key = _key(p);
        usd.mint(trader, 10 * DOLLAR);
        vm.startPrank(trader);
        usd.approve(swapTest, type(uint256).max);
        vm.stopPrank();
        uint256 snap = vm.snapshotState();
        p.finisher.openPool();
        uint256 raised = s.auction.currencyRaised();
        usd.mint(trader, 2_000_000 * DOLLAR);
        (, uint256 got) = _swap(key, address(p.shares), trader, true, 2_000_000 * DOLLAR);
        emit log_named_uint("Shares bought with 2,000,000 dollars from a 2,200-dollar pool", got);
        emit log_named_uint("spot after, thousandths of a dollar", _spot(key) / 1e15);
        assertTrue(p.finisher.poolIsOpen(), "still the project's pool after a huge price move");
        p.finisher.settle();
        p.finisher.sweep();
        assertApproxEqAbs(
            p.treasury.spendable(), raised * 15 / 100, 1000, "split by amounts, not prices: 15 of each 100 raised"
        );
        assertApproxEqAbs(p.treasury.melting(), raised * 60 / 100, 1000, "and 60 into the floor");
        vm.revertToState(snap);
    }

    /// @dev The milestone 3 report lists this as reasoned but not run. The dollar token refuses to send to the Treasury (a frozen
    /// address); fees are due. `collect` does the platform's half, then the project's, then the burn, in one call: when the
    /// project's half fails the whole call is undone, so the platform's half and the burn wait too. Measured: what happens, and
    /// that nothing is lost once the token lets the Treasury receive again.
    function test_attack_aFrozenTreasuryDelaysEveryPoolFeeUntilItThaws() public {
        (Proj memory p, Sale memory s,) = _soldOutStandard(keccak256("frozen"));
        uint256 id = _nextTokenId();
        _finish(p, s);
        PoolKey memory key = _key(p);
        usd.mint(trader, 3000 * DOLLAR);
        (, uint256 got) = _swap(key, address(p.shares), trader, true, 1000 * DOLLAR);
        _swap(key, address(p.shares), trader, false, got / 2);
        usd.setBlocked(address(p.treasury), true);
        vm.expectRevert();
        holder.collect(id);
        usd.setBlocked(address(p.treasury), false);
        uint256 before = p.treasury.spendable();
        (uint256 dollars,) = holder.collect(id);
        assertGt(dollars, 0, "the fees were still there");
        assertEq(p.treasury.spendable() - before, dollars - dollars / 2);
    }
}

contract AttackM3FinishLocalTest is AttackM3FinishBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract AttackM3FinishForkTest is AttackM3FinishBase {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}

abstract contract AttackM3MarketBase is AttackM3Common {
    /// @dev Random size, random honest demand (30% to 180% of the goal), an attacker with an ordinary bid and 0 to 4 blocks of
    /// spike bids, and dollars given to the Finisher and the Treasury before the finish. Whatever happens: the platform gets exactly
    /// 3% of the raise, the pool gets 22% of it (to a thousandth of a dollar), the founder's spendable bucket never holds more than
    /// 15% of the raise plus a fifth of the gifts, the floor never holds less than 60% of the raise plus four fifths of the gifts,
    /// no dollar stays in the Finisher or the strategy, and a sale under its minimum refunds everyone and pays nobody.
    /// forge-config: default.fuzz.runs = 3000
    function testFuzz_splitAndConservationUnderSpikesAndGifts(
        uint256 seed,
        uint8 sizeSel,
        uint8 spikes,
        uint16 giftDollars
    ) public {
        Launcher.Size size = Launcher.Size(sizeSel % 3);
        (uint256 goal,) = launcher.sizeOf(size);
        Proj memory p = _launch(founder, keccak256(abi.encode("fz", seed)));
        Sale memory s = _open(p, size);
        vm.roll(s.startBlock);
        uint256 honestTotal = goal * (30 + seed % 150) / 100;
        address[4] memory honest = [alice, bob, carol, dave];
        for (uint256 i; i < 4; ++i) {
            _bid(s, honest[i], honestTotal / 4, 1 + (seed >> (8 * i)) % 40);
        }
        _bid(s, mallory, goal / 10, 1);
        _spikeBids(s, spikes % 5);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        bool graduated = s.auction.isGraduated();
        uint256 raised = s.auction.currencyRaised();
        // a gift to the Finisher of more than half the pool's budget (11 of each 100 raised) makes the pool step look as if it
        // took too little (`test_measured_aGiftOfMoreThanHalfThePoolsBudgetHidesARealPool`), so the fuzzed gift stays under 40% of it
        uint256 gift = uint256(giftDollars) * DOLLAR;
        if (gift > raised * 22 / 100 * 40 / 100) gift = raised * 22 / 100 * 40 / 100;
        usd.mint(address(p.finisher), gift);
        usd.mint(address(p.treasury), gift);
        _finishOrFail(p, s);
        if (!graduated) {
            assertEq(usd.balanceOf(platform), 0, "a failed sale pays no fee");
            assertEq(p.treasury.spendable() + p.treasury.melting(), 0, "and splits nothing");
            return;
        }
        assertEq(usd.balanceOf(platform), raised * 30_000 / 1_000_000, "exactly 3% to the platform");
        uint256 pool = usd.balanceOf(poolManager);
        assertApproxEqAbs(pool, raised * 22 / 100, 1500 + raised / 1_000_000, "22% of the raise in the pool");
        uint256 sp = p.treasury.spendable();
        uint256 fl = p.treasury.melting();
        // the pool's liquidity rounds, so what the pool leaves behind is the budget's rounding (a few thousandths of a dollar, and
        // about 3 in a billion of a very large raise: a counterexample at a 1.3-million-dollar raise was 0.004 dollars off)
        uint256 dust = 2000 + raised / 100_000_000;
        assertLe(
            sp * 100, raised * 15 + 2 * gift * 20 + dust * 100, "the founder never gets more than 15% of the raise"
        );
        assertGe(fl * 100 + dust * 100, raised * 60 + 2 * gift * 80, "the floor never gets less than 60% of the raise");
        assertEq(usd.balanceOf(address(p.finisher)), 0, "nothing stays in the Finisher");
        assertEq(usd.balanceOf(strategy), 0, "nothing stays in the strategy");
        assertLe(p.treasury.unaccounted(), 2, "nothing unsplit in the Treasury");
        assertApproxEqAbs(
            pool + sp + fl + usd.balanceOf(platform), raised + 2 * gift, 4, "every dollar of the raise and the gifts"
        );
    }

    /// @dev The drain, over the three sale sizes: how far under the floor the pool must be before buying there and handing back
    /// pays, for a small, a medium and a large trade, with the pool's 1% fee, the price the trade moves and the 5% exit fee in.
    function test_attack_buyBelowTheFloorAndHandBack_bySaleSize() public {
        uint256 base = vm.snapshotState();
        Launcher.Size[3] memory sizes = [Launcher.Size.Small, Launcher.Size.Standard, Launcher.Size.Large];
        uint256[6] memory discounts = [uint256(0), 600, 700, 800, 1000, 1500];
        for (uint256 z; z < 3; ++z) {
            (uint256 goal,) = launcher.sizeOf(sizes[z]);
            uint256[3] memory trades = [goal / 500, goal / 50, goal / 10];
            for (uint256 d; d < discounts.length; ++d) {
                string memory line = string.concat("size ", vm.toString(goal / DOLLAR), " discount ");
                for (uint256 t; t < 3; ++t) {
                    vm.revertToState(base);
                    base = vm.snapshotState();
                    Proj memory p = _bearProject(sizes[z], keccak256(abi.encode("bg", z, d)));
                    uint256 reached = discounts[d] == 0 ? 0 : _dumpToDiscount(p, discounts[d]);
                    int256 profit = _buyAndHandBack(p, trades[t]);
                    line = string.concat(
                        line,
                        t == 0 ? string.concat(vm.toString(reached), "bps reached: ") : " | ",
                        "trade ",
                        vm.toString(trades[t] / DOLLAR),
                        ": ",
                        profit < 0 ? "-" : "+",
                        _str(uint256(profit < 0 ? -profit : profit), 6)
                    );
                    if (d == 0) assertLt(profit, 0, "no profit at the floor");
                }
                emit log_string(line);
            }
        }
    }
}

contract AttackM3MarketLocalTest is AttackM3MarketBase {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}
