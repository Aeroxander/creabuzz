// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {ForkGate} from "./ForkGate.sol";
import {ForkPick} from "./ForkPick.sol";
import {Launcher} from "../../src/Launcher.sol";
import {Treasury} from "../../src/Treasury.sol";
import {Vester} from "../../src/Vester.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Finisher} from "../../src/Finisher.sol";
import {LiquidityHolder} from "../../src/LiquidityHolder.sol";
import {Rounds} from "../../src/Rounds.sol";
import {Pair} from "../../src/Pair.sol";
import {PoolKey, PoolRead, IPinnedPoolManager, IPinnedStrategy, SaleParams} from "../../src/Pinned.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";
import {
    IDeployer,
    IAuctionTest,
    IPermit2Test,
    ISwapTest,
    SwapParams,
    TestSettings,
    Bid,
    Checkpoint
} from "./UniswapTest.sol";
import {BASE_START_Q96} from "./Prices.sol";

/// @notice The whole platform on top of Uniswap, built the way a deploy script builds it: Uniswap's pool manager, position
/// manager and Permit2 (the real ones on a Sepolia fork, or a local twin built from the vendored source), then our fee
/// controller, auction factory, strategy (mined address), pool guard (mined address), bid hook, and the real Launcher with the
/// Finisher, LiquidityHolder and the rest. No test double stands in for any of it. Helpers launch projects, open sales, bid,
/// finish, collect and trade. The milestone 1 contracts (`Deployer`, `FixedFeeController`, `MinBid`, `PoolGuard`) are 0.8.26 files that
/// a 0.8.37 test cannot import; they are loaded from their build output, which the milestone 1 suites keep fresh.
abstract contract Platform is ForkGate {
    uint256 internal constant DOLLAR = 1e6;
    uint256 internal constant SHARE = 1e18;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    address internal poolManager;
    address internal positionManager;
    address internal swapTest;
    IDeployer internal deployer;
    bool internal onFork;

    QuoteToken internal usd;
    Launcher internal launcher;
    address internal strategy;
    address internal guard;
    address internal minBid;
    address internal parts;
    address internal feeController;
    address internal factory;
    LiquidityHolder internal holder;

    address internal admin = makeAddr("admin");
    /// @dev Receives the 3% of every raise (the fee controller's recipient) and the exit fee's platform part.
    address internal platform = makeAddr("platform");
    address internal founder = makeAddr("founder");
    /// @dev The second signer of every project's Pair (the auction needs a Pair runner).
    address internal cosigner = makeAddr("cosigner");
    address internal stakeHolder = makeAddr("stake");
    address internal councilMaker = makeAddr("council maker");
    address internal stranger = makeAddr("stranger");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal erin = makeAddr("erin");
    address internal trader = makeAddr("trader");

    /// @notice One project's contracts.
    struct Proj {
        address founder;
        bytes32 id;
        ShareToken shares;
        Treasury treasury;
        Vester vester;
        Finisher finisher;
        Rounds rounds;
        bytes32 key;
    }

    /// @notice One sale's figures.
    struct Sale {
        IAuctionTest auction;
        uint256 floorQ96;
        uint256 tickQ96;
        uint64 startBlock;
        uint64 endBlock;
    }

    /// @dev The one log `emitter` wrote with event `sig`; fails if there are none or several.
    function _one(Vm.Log[] memory logs, address emitter, bytes32 sig) internal pure returns (Vm.Log memory found) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length != 0 && logs[i].topics[0] == sig) {
                found = logs[i];
                ++n;
            }
        }
        require(n == 1, string.concat("expected exactly one log, found ", vm.toString(n)));
    }

    function _count(Vm.Log[] memory logs, address emitter, bytes32 sig) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length != 0 && logs[i].topics[0] == sig) ++n;
        }
    }

    function _addr(bytes32 topic) internal pure returns (address) {
        return address(uint160(uint256(topic)));
    }

    /// @dev Call first in `setUp`. Returns false when the fork mode was asked for and cannot run (tests skip).
    function _setUpPlatform(bool fork) internal returns (bool) {
        onFork = fork;
        if (fork) {
            string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
            if (bytes(rpc).length == 0) {
                vm.skip(
                    true, "SEPOLIA_RPC_URL is not set: the Sepolia fork tests are skipped (the local twin still runs)"
                );
                return false;
            }
            ForkPick.Plan memory plan = _planFork(rpc);
            if (bytes(plan.message).length != 0) emit log_string(plan.message);
            if (plan.skip) {
                vm.skip(true, plan.message);
                return false;
            }
            vm.createSelectFork(rpc, plan.blockNumber);
            emit log_named_uint("Sepolia fork block", plan.blockNumber);
            poolManager = SEPOLIA_POOL_MANAGER;
            positionManager = SEPOLIA_POSITION_MANAGER;
            swapTest = SEPOLIA_POOL_SWAP_TEST;
            deployer = IDeployer(deployCode("out/Deployer.sol/Deployer.json")); // after the fork is selected
        } else {
            deployer = IDeployer(deployCode("out/Deployer.sol/Deployer.json"));
            deployCodeTo("out/Permit2.sol/Permit2.json", PERMIT2);
            (poolManager, positionManager, swapTest) = deployer.localStack(PERMIT2);
        }
        _deployPlatform();
        return true;
    }

    /// @dev The deploy order of a real network: fee controller, auction factory, strategy (mined), pool guard (mined), bid
    /// hook, Launcher (which makes the Finisher implementation and the LiquidityHolder).
    function _deployPlatform() internal {
        usd = new QuoteToken();
        feeController = deployCode("FixedFeeController.sol:FixedFeeController", abi.encode(platform, uint24(30_000)));
        factory = deployer.auctionFactory(feeController);
        strategy = deployer.strategy(positionManager, poolManager, factory);
        guard = deployer.guard(poolManager, strategy);
        minBid = deployCode("MinBid.sol:MinBid", abi.encode(uint128(1e6), uint256(4), uint64(720)));
        parts = deployCode("Parts.sol:Parts");
        launcher = Launcher(
            deployCode(
                "Launcher.sol:Launcher", abi.encode(admin, _settings(), strategy, guard, minBid, parts, councilMaker)
            )
        );
        holder = LiquidityHolder(launcher.holder());
    }

    function _settings() internal view returns (Launcher.Settings memory) {
        return Launcher.Settings({
            quote: IERC20(address(usd)),
            platform: platform,
            stake: stakeHolder,
            exitFeeBps: 500,
            platformFeeBps: 100,
            spendableParts: 15,
            floorParts: 60,
            agentUsd: uint128(25 * DOLLAR),
            agentShares: uint128(SUPPLY / 1000)
        });
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    // ================================================ projects and sales =============================================

    function _launch(address who, bytes32 id) internal returns (Proj memory p) {
        bytes32 h = launcher.launchHash(launcher.keyOf(who, id));
        vm.prank(who);
        (address s, address t, address v) = launcher.launch(id, "Project", "PRJ", h);
        p = Proj({
            founder: who,
            id: id,
            shares: ShareToken(s),
            treasury: Treasury(t),
            vester: Vester(v),
            finisher: Finisher(launcher.project(who, id).finisher),
            rounds: Rounds(launcher.project(who, id).rounds),
            key: launcher.keyOf(who, id)
        });
    }

    /// @dev Launch with an id chosen so the dollar token's address is below (`quoteIsCurrency0`) or above the Shares', because
    /// Uniswap prices the pool differently for the two orders and the whole route must work with both.
    function _launchOrdered(address who, bool quoteIsCurrency0) internal returns (Proj memory p) {
        for (uint256 i; i < 64; ++i) {
            bytes32 id = keccak256(abi.encode("ordered", who, i));
            address predicted = _predictShares(who, id);
            if ((address(usd) < predicted) == quoteIsCurrency0) return _launch(who, id);
        }
        revert("could not order the tokens");
    }

    function _predictShares(address who, bytes32 id) internal view returns (address) {
        bytes32 key = launcher.keyOf(who, id);
        bytes32 salt = keccak256(abi.encode(key, "shares"));
        address impl = launcher.shareImpl();
        // the same address `Clones.cloneDeterministic` makes: EIP-1167 runtime, deployed by the Launcher with CREATE2
        bytes memory init =
            abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3");
        return
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(launcher), salt, keccak256(init)))))
            );
    }

    /// @dev Team: the founder offers the runner seat to the Pair of (founder, `cosigner`) and the cosigner accepts.
    function _team(Proj memory p) internal returns (Pair pair) {
        address predicted = launcher.pairAddress(p.key, p.founder, cosigner);
        vm.prank(p.founder);
        p.treasury.handOver(predicted, false);
        vm.prank(cosigner);
        pair = Pair(launcher.makePair(p.key, p.founder));
    }

    /// @dev Both signers of the project's Pair agree to a call to `target` (the founder proposes, the cosigner confirms).
    function _both(Proj memory p, address target, bytes memory data) internal returns (bytes memory result) {
        Pair pair = Pair(p.treasury.runner());
        (address first, address second) = (pair.first(), pair.second());
        vm.prank(first);
        pair.propose(target, data);
        uint256 n = pair.nonce() - 1;
        vm.prank(second);
        result = pair.confirm(target, data, n);
    }

    /// @dev Open the project's one auction: become Team if not yet, then both signers open it.
    function _open(Proj memory p) internal returns (Sale memory s) {
        return _openAt(p, BASE_START_Q96);
    }

    /// @dev Open the project's one auction at the starting price `start` (Q96).
    function _openAt(Proj memory p, uint256 start) internal returns (Sale memory s) {
        if (!launcher.isPair(p.treasury.runner())) _team(p);
        _both(p, address(launcher), abi.encodeCall(Launcher.openAuction, (p.key, start)));
        s = _saleOf(p);
    }

    /// @dev Both signers try to open the auction and the Launcher (or what it calls) refuses with `err`.
    function _openRefused(Proj memory p, bytes memory err) internal {
        _openRefusedAt(p, BASE_START_Q96, err);
    }

    /// @dev Both signers try to open the auction at the starting price `start` and it is refused with `err`.
    function _openRefusedAt(Proj memory p, uint256 start, bytes memory err) internal {
        if (!launcher.isPair(p.treasury.runner())) _team(p);
        Pair pair = Pair(p.treasury.runner());
        bytes memory data = abi.encodeCall(Launcher.openAuction, (p.key, start));
        (address first, address second) = (pair.first(), pair.second());
        vm.prank(first);
        pair.propose(address(launcher), data);
        uint256 n = pair.nonce() - 1;
        vm.prank(second);
        vm.expectRevert(err);
        pair.confirm(address(launcher), data, n);
    }

    /// @dev Both signers of the project's Pair agree to a call and it reverts (with anything).
    function _bothReverts(Proj memory p, address target, bytes memory data) internal {
        Pair pair = Pair(p.treasury.runner());
        (address first, address second) = (pair.first(), pair.second());
        vm.prank(first);
        pair.propose(target, data);
        uint256 n = pair.nonce() - 1;
        vm.prank(second);
        vm.expectRevert();
        pair.confirm(target, data, n);
    }

    /// @dev The runner checks in (through the Pair when there is one).
    function _checkIn(Proj memory p) internal {
        address r = p.treasury.runner();
        if (launcher.isPair(r)) {
            address first = Pair(r).first();
            vm.prank(first);
            Pair(r).checkIn();
        } else {
            vm.prank(r);
            p.treasury.checkIn();
        }
    }

    /// @dev The runner gives Shares (both signers when it is a Pair).
    function _give(Proj memory p, address to, uint256 amount) internal {
        address r = p.treasury.runner();
        if (launcher.isPair(r)) {
            _both(p, address(p.treasury), abi.encodeCall(Treasury.giveShares, (to, amount)));
        } else {
            vm.prank(r);
            p.treasury.giveShares(to, amount);
        }
    }

    function _saleOf(Proj memory p) internal view returns (Sale memory s) {
        s.auction = IAuctionTest(p.finisher.auction());
        (s.floorQ96, s.tickQ96) = (s.auction.floorPrice(), s.auction.tickSpacing()); // the start the runner chose
        s.startBlock = s.auction.startBlock();
        s.endBlock = s.auction.endBlock();
    }

    function _key(Proj memory p) internal view returns (PoolKey memory) {
        return p.finisher.poolKey();
    }

    // ================================================ bids ===========================================================

    /// @dev Top price `k` ticks above the floor (the floor is tick 100, so 4 times the floor is `k = 300`).
    function _price(Sale memory s, uint256 k) internal pure returns (uint256) {
        return s.floorQ96 + k * s.tickQ96;
    }

    function _fund(address who, uint256 amount, Sale memory s) internal {
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(PERMIT2, type(uint256).max);
        IPermit2Test(PERMIT2).approve(address(usd), address(s.auction), uint160(amount), type(uint48).max);
        vm.stopPrank();
    }

    /// @dev Funds `who` and places a bid of `amount` raw dollars with a top price `k` ticks above the floor.
    function _bid(Sale memory s, address who, uint256 amount, uint256 k) internal returns (uint256 bidId) {
        _fund(who, amount, s);
        bidId = s.auction.nextBidId();
        vm.prank(who);
        s.auction.submitBid(_price(s, k), uint128(amount), who, s.floorQ96, "");
    }

    function _toEnd(Sale memory s) internal {
        vm.roll(s.endBlock);
        s.auction.checkpoint();
    }

    /// @dev Exit one bid with the right call and hints, found by walking the auction's checkpoint list.
    function _exit(Sale memory s, uint256 bidId) internal {
        Bid memory b = s.auction.bids(bidId);
        uint256 finalPrice = s.auction.checkpoints(s.auction.lastCheckpointedBlock()).clearingPrice;
        if (!s.auction.isGraduated() || b.maxPrice > finalPrice) {
            s.auction.exitBid(bidId);
            return;
        }
        uint64 blk = b.startBlock;
        uint64 lastFull = blk;
        uint64 outbid = 0;
        while (blk != type(uint64).max) {
            Checkpoint memory c = s.auction.checkpoints(blk);
            if (c.clearingPrice < b.maxPrice) {
                lastFull = blk;
            } else if (c.clearingPrice > b.maxPrice) {
                outbid = blk;
                break;
            }
            blk = c.next;
        }
        s.auction.exitPartiallyFilledBid(bidId, lastFull, outbid);
    }

    /// @dev Exit and claim one bid for its owner (anyone may; the money and Shares go to the owner).
    function _collectBid(Sale memory s, uint256 bidId) internal returns (uint256 refund, uint256 shares) {
        address who = s.auction.bids(bidId).owner;
        uint256 d0 = usd.balanceOf(who);
        _exit(s, bidId);
        refund = usd.balanceOf(who) - d0;
        if (s.auction.isGraduated()) {
            uint256 s0 = IERC20(s.auction.token()).balanceOf(who);
            vm.prank(stranger);
            s.auction.claimTokens(bidId);
            shares = IERC20(s.auction.token()).balanceOf(who) - s0;
        }
    }

    /// @dev `total` raw dollars of demand in five equal bids one tick above the floor, placed at the start. With `total` equal
    /// to the goal the price stays at the floor and every sale Share sells.
    function _flat(Sale memory s, uint256 total) internal returns (uint256[5] memory ids) {
        vm.roll(s.startBlock);
        address[5] memory who = [alice, bob, carol, dave, erin];
        for (uint256 i; i < 5; ++i) {
            ids[i] = _bid(s, who[i], total / 5, 1);
        }
    }

    /// @dev Makes the pool step fail the way milestone 1 reproduced it: the dollar token refuses to send to the position
    /// manager, so the strategy's inner step reverts, the strategy catches it and reports success.
    function _failThePoolStep(bool on) internal {
        usd.setBlocked(positionManager, on);
    }

    function _selectors() internal pure returns (bytes4[3] memory) {
        return [Finisher.openPool.selector, Finisher.settle.selector, Finisher.sweep.selector];
    }

    // ================================================ the finish =====================================================

    /// @dev The three steps in the natural order, by a stranger.
    function _finish(Proj memory p, Sale memory s) internal {
        vm.roll(s.endBlock + 1);
        vm.startPrank(stranger);
        p.finisher.openPool();
        p.finisher.settle();
        p.finisher.sweep();
        vm.stopPrank();
    }

    /// @dev Five bidders, 320,000 dollars of demand for the 100,000-dollar auction: a low early bid that ends up outbid, and bids at
    /// 1.2x, 1.5x, 3x and 4x the floor price, at different blocks across the 24 hours (the milestone 1 route's demand).
    function _fiveBids(Sale memory s) internal returns (uint256[5] memory ids) {
        vm.roll(s.startBlock);
        ids[0] = _bid(s, erin, 20_000 * DOLLAR, 1);
        vm.roll(s.startBlock + 500);
        ids[1] = _bid(s, dave, 30_000 * DOLLAR, 20);
        vm.roll(s.startBlock + 2000);
        ids[2] = _bid(s, carol, 120_000 * DOLLAR, 150);
        vm.roll(s.startBlock + 4000);
        ids[3] = _bid(s, bob, 90_000 * DOLLAR, 200);
        vm.roll(s.startBlock + 6000);
        ids[4] = _bid(s, alice, 60_000 * DOLLAR, 300);
    }

    // ================================================ trading ========================================================

    /// @dev Exact-input swap through v4's test swap router. `quoteIn` true spends dollars to get Shares. Returns what `who`
    /// paid and received (both positive).
    function _swap(PoolKey memory key, address token, address who, bool quoteIn, uint256 amountIn)
        internal
        returns (uint256 paid, uint256 received)
    {
        bool zeroForOne = quoteIn == (key.currency0 == address(usd));
        IERC20 tokenIn = quoteIn ? IERC20(address(usd)) : IERC20(token);
        vm.startPrank(who);
        tokenIn.approve(swapTest, type(uint256).max);
        int256 d = ISwapTest(swapTest)
            .swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amountIn),
                    sqrtPriceLimitX96: zeroForOne
                        ? 4_295_128_740
                        : 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341
                }),
                TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        vm.stopPrank();
        int128 a0 = int128(d >> 128);
        int128 a1 = int128(d);
        int128 in_ = zeroForOne ? a0 : a1;
        int128 out = zeroForOne ? a1 : a0;
        paid = uint256(uint128(-in_));
        received = uint256(uint128(out));
    }

    function _sqrtPrice(PoolKey memory key) internal view returns (uint160) {
        return PoolRead.sqrtPrice(IPinnedPoolManager(poolManager), PoolRead.id(key));
    }

    function _poolLiquidity(PoolKey memory key) internal view returns (uint128) {
        return PoolRead.liquidity(IPinnedPoolManager(poolManager), PoolRead.id(key));
    }

    /// @dev Price of one whole Share in whole dollars, scaled by 1e18, from the pool's sqrt price.
    function _spot(PoolKey memory key) internal view returns (uint256) {
        uint256 sq = _sqrtPrice(key);
        if (key.currency0 == address(usd)) {
            // dollars are currency0: sq^2 / 2^192 is Share raw per dollar raw; whole dollars per whole Share = 1e12 / that
            return Math.mulDiv(1 << 192, 1e30, sq * sq);
        }
        // Shares are currency0: sq^2 / 2^192 is dollar raw per Share raw; whole dollars per whole Share = that * 1e12
        return Math.mulDiv(sq * sq, 1e30, 1 << 192);
    }
}
