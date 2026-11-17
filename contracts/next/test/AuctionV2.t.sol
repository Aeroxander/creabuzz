// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Platform} from "./helpers/Platform.sol";
import {IAuctionTest} from "./helpers/UniswapTest.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Pair} from "../src/Pair.sol";
import {PoolKey, SaleParams} from "../src/Pinned.sol";
import {BASE_START_Q96} from "./helpers/Prices.sol";

/// @notice Plan version 2's one auction on the real Uniswap stack (local twin, and the Sepolia fork when an RPC is set): the
/// 100,000 worked example with the stake, demand at the cap ten times the supply, a founder bidding through a second account then
/// selling into the pool, the Council requirement on a real network, and the reserve sale.
abstract contract AuctionV2Base is Platform {
    function _fork() internal pure virtual returns (bool);

    address internal council = makeAddr("council stand-in");

    function setUp() public virtual {
        _setUpPlatform(_fork());
    }

    function _soldAndFinished(bytes32 id, uint256 total, uint256 k) internal returns (Proj memory p, Sale memory s) {
        p = _launch(founder, id);
        s = _open(p);
        vm.roll(s.startBlock);
        address[5] memory who = [alice, bob, carol, dave, erin];
        for (uint256 i; i < 5; ++i) {
            _bid(s, who[i], total / 5, k);
        }
        _toEnd(s);
        _finish(p, s);
        for (uint256 i; i < 5; ++i) {
            _collectBid(s, i);
        }
    }

    /// @dev The council stand-in (milestone 9 builds the Council) takes the runner seat from the Pair.
    function _councilRuns(Proj memory p) internal {
        vm.prank(councilMaker);
        launcher.registerCouncil(council);
        _both(p, address(p.treasury), abi.encodeCall(Treasury.handOver, (council, false)));
        vm.prank(council);
        p.treasury.takeSeat();
    }

    /// @dev The worked example "100,000, the auction at its minimum": platform 3,000, a pool of 22,000 dollars and 55M Shares
    /// locked for good, 15,000 at once, 60,000 over 12 months (1,150.68 a week of active time; the plan's 1,154 divides by 52
    /// weeks), and Creaton receives 20M held Shares.
    function test_worked_100000_theAuctionAtItsMinimum() public {
        (Proj memory p, Sale memory s) = _soldAndFinished(keccak256("min"), 100_000 * DOLLAR, 1);
        uint256 raised = s.auction.currencyRaised();
        assertEq(raised, 100_000 * DOLLAR, "every dollar of the minimum was raised");
        assertEq(usd.balanceOf(platform), 3000 * DOLLAR, "platform 3,000");
        assertApproxEqAbs(usd.balanceOf(poolManager), 22_000 * DOLLAR, 5000, "a pool of 22,000 dollars");
        assertApproxEqRel(p.shares.balanceOf(poolManager), 55_000_000 * SHARE, 0.01e18, "and 55M Shares");
        assertApproxEqAbs(p.treasury.spendable(), 15_000 * DOLLAR, 5000, "15,000 at once");
        assertApproxEqAbs(p.treasury.melting(), 60_000 * DOLLAR, 5000, "60,000 over 12 months");
        (uint256 stake,) = p.vester.grants(stakeHolder);
        assertEq(stake, 20_000_000 * SHARE, "Creaton receives 20M held Shares");
        assertEq(p.vester.claimable(stakeHolder), 0);
        assertEq(uint256(launcher.stageOf(p.key)), uint256(Launcher.Stage.Council), "the market is open");
        uint256 m0 = p.treasury.melting();
        vm.warp(_now() + 7 days);
        p.treasury.release();
        assertEq(m0 - p.treasury.melting(), m0 * 7 days / 365 days, "a week of active time");
        emit log_named_uint("100,000 auction: released in the first week (micro dollars)", m0 * 7 days / 365 days);
    }

    /// @dev Demand at the cap ten times the supply: 4,000,000 dollars bid at 4 times the starting price for 250M Shares worth
    /// 400,000 there. The price stops at the cap, everyone is filled pro rata, and the rest comes back.
    function test_demandAtTheCapTenTimesTheSupply() public {
        (Proj memory p, Sale memory s) = _soldAndFinished(keccak256("ten"), 4_000_000 * DOLLAR, 300);
        uint256 finalPrice = s.auction.clearingPrice();
        assertEq(finalPrice, 4 * s.floorQ96, "the price stops at 4 times the starting price");
        uint256 raised = s.auction.currencyRaised();
        assertApproxEqRel(raised, 400_000 * DOLLAR, 0.01e18, "the whole supply at the cap: 400,000");
        uint256 got = p.shares.balanceOf(alice);
        assertApproxEqRel(got, 50_000_000 * SHARE, 0.01e18, "a fifth of the Shares each");
        assertApproxEqRel(usd.balanceOf(alice), 720_000 * DOLLAR, 0.01e18, "and 9 of each 10 dollars back");
        assertApproxEqAbs(usd.balanceOf(poolManager), raised * 22 / 100, 10_000, "a pool of 88,000");
        emit log_named_uint("ten times demand: raised (dollars)", raised / DOLLAR);
        emit log_named_uint("ten times demand: price, hundredths of the start", finalPrice * 100 / s.floorQ96);
        emit log_named_uint("ten times demand: pool dollars", usd.balanceOf(poolManager) / DOLLAR);
    }

    /// @dev A founder bids through a second account next to 100,000 of honest demand, then sells everything the account bought into
    /// the pool. Measured per 100 the account spent: what came back from the pool at once, the 15 the project can spend at once,
    /// and the 60 that went into the floor. The floor is the holders' (they can hand back against it) and melts into spendable
    /// over a year only while the runner checks in; so the loss is real at once, and turns into a gain for the founder only if
    /// the holders never hand back and the whole floor melts to the runner. Both figures are printed; the plan's "real loss about
    /// 7 to 15 of each 100" is not what this measures (see the report).
    function test_selfBidThenSellIntoThePool_measured() public {
        uint256[3] memory founderBids = [uint256(50_000 * DOLLAR), 100_000 * DOLLAR, 300_000 * DOLLAR];
        uint256 snap = vm.snapshotState();
        (Proj memory p0,) = _soldAndFinished(keccak256("honest only"), 100_000 * DOLLAR, 300);
        uint256 project0 = p0.treasury.spendable() + p0.treasury.melting();
        uint256 spendable0 = p0.treasury.spendable();
        for (uint256 z; z < 3; ++z) {
            vm.revertToState(snap);
            snap = vm.snapshotState();
            Proj memory p = _launch(founder, keccak256(abi.encode("self", z)));
            Sale memory s = _open(p);
            vm.roll(s.startBlock);
            uint256 honest = _bid(s, alice, 100_000 * DOLLAR, 300);
            address second = makeAddr("founder's second account");
            uint256 fid = _bid(s, second, founderBids[z], 300);
            _toEnd(s);
            _finish(p, s);
            _collectBid(s, honest);
            (uint256 refund, uint256 bought) = _collectBid(s, fid);
            uint256 spent = founderBids[z] - refund;
            uint256 project = p.treasury.spendable() + p.treasury.melting();
            uint256 atOnce = p.treasury.spendable() - spendable0;
            (, uint256 fromPool) = _swap(_key(p), address(p.shares), second, false, bought);
            // per 100 spent: back from the pool, extra money the project got because of the bid, and what is gone
            uint256 backPer100 = fromPool * 10_000 / spent;
            uint256 projectPer100 = (project - project0) * 10_000 / spent;
            uint256 atOncePer100 = atOnce * 10_000 / spent;
            int256 lossNowPer100 = 10_000 - int256(backPer100) - int256(atOncePer100);
            int256 lossPer100 = 10_000 - int256(backPer100) - int256(projectPer100);
            emit log_string(string.concat(
                    "self-bid ",
                    vm.toString(founderBids[z] / DOLLAR),
                    " next to 100,000 honest: price x",
                    vm.toString(s.auction.clearingPrice() * 100 / s.floorQ96),
                    "/100; per 100 spent: ",
                    vm.toString(backPer100),
                    "/100 back from the pool, ",
                    vm.toString(projectPer100),
                    "/100 more for the project (",
                    vm.toString(atOncePer100),
                    " of it spendable at once); loss at once ",
                    vm.toString(uint256(lossNowPer100)),
                    "/100; if the whole floor melts to the runner: ",
                    lossPer100 < 0 ? "GAIN " : "loss ",
                    vm.toString(uint256(lossPer100 < 0 ? -lossPer100 : lossPer100)),
                    "/100"
                ));
            assertGt(lossNowPer100, 3000, "at once, more than 30 of each 100 is gone");
            assertEq(projectPer100 * 100 / 7500, 100, "75 of each 100 spent reached the project (15 + 60)");
        }
    }

    /// @dev D230: on a real network the auction needs a Council runner. A Launcher made on chain 1 refuses a Pair and lets a
    /// Council (the stand-in the council maker registered) open the same sale.
    function test_onARealNetworkOnlyACouncilOpensTheAuction() public {
        uint256 local = block.chainid;
        vm.chainId(1);
        Launcher l = Launcher(
            deployCode(
                "Launcher.sol:Launcher", abi.encode(admin, _settings(), strategy, guard, minBid, parts, councilMaker)
            )
        );
        vm.chainId(local);
        assertTrue(l.requireCouncilForAuction());
        bytes32 h = l.settingsHash();
        vm.prank(founder);
        l.launch(keccak256("real"), "R", "R", h);
        bytes32 k = l.keyOf(founder, keccak256("real"));
        Treasury t = Treasury(l.projectByKey(k).treasury);
        address pa = l.pairAddress(k, founder, cosigner);
        vm.prank(founder);
        t.handOver(pa, false);
        vm.prank(cosigner);
        Pair pair = Pair(l.makePair(k, founder));
        bytes memory data = abi.encodeCall(Launcher.openAuction, (k, BASE_START_Q96));
        vm.prank(founder);
        pair.propose(address(l), data);
        vm.prank(cosigner);
        vm.expectRevert(abi.encodeWithSelector(Launcher.WrongRunner.selector, Launcher.RunnerKind.Council));
        pair.confirm(address(l), data, 0);
        vm.prank(councilMaker);
        l.registerCouncil(council);
        vm.prank(founder);
        pair.propose(address(t), abi.encodeCall(Treasury.handOver, (council, false)));
        vm.prank(cosigner);
        pair.confirm(address(t), abi.encodeCall(Treasury.handOver, (council, false)), 1);
        vm.prank(council);
        t.takeSeat();
        vm.prank(council);
        address auction = l.openAuction(k, BASE_START_Q96);
        assertEq(IAuctionTest(auction).totalSupply(), SaleParams.SALE_SHARES, "the Council opened the one auction");
    }

    /// @dev The reserve sale: a plain auction of reserve Shares, opened by the Council at least 28 days after the last sale ended,
    /// starting at the price that sale ended at; exits wait while it runs; finished by anyone: 3 to the platform, 15 spendable and
    /// 82 floor of each 100, the unsold Shares back to the reserve; the next one starts from this one's end price, 28 days later.
    function test_reserveSale_endToEnd() public {
        (Proj memory p, Sale memory s) = _soldAndFinished(keccak256("reserve"), 150_000 * DOLLAR, 100);
        uint256 lastPrice = s.auction.clearingPrice();
        _councilRuns(p);
        vm.prank(council);
        vm.expectRevert(abi.encodeWithSelector(Launcher.TooEarly.selector, uint256(s.endBlock) + 201_600));
        launcher.openReserveSale(p.key, 10_000_000 * SHARE);
        vm.roll(uint256(s.endBlock) + 201_600);
        uint256 reserve0 = p.treasury.reserve();
        uint256 g = gasleft();
        vm.prank(council);
        address ra = launcher.openReserveSale(p.key, 10_000_000 * SHARE);
        emit log_named_uint("gas: open a reserve sale", g - gasleft());
        assertEq(p.treasury.reserve(), reserve0 - 10_000_000 * SHARE);
        Sale memory r = _saleAt(ra);
        assertGe(r.floorQ96, lastPrice, "it starts at the last sale's end price (rounded up to its grid)");
        assertLt(r.floorQ96 - lastPrice, r.tickQ96 + 1);
        // exits wait while reserve Shares are out
        vm.startPrank(alice);
        p.shares.approve(address(p.treasury), type(uint256).max);
        vm.expectRevert(Treasury.SaleNotClosed.selector);
        p.treasury.handBack(1000 * SHARE);
        vm.stopPrank();
        vm.prank(council);
        vm.expectRevert(Launcher.WrongStage.selector);
        launcher.openReserveSale(p.key, 1); // one at a time
        vm.roll(r.startBlock);
        uint256 bid = _bid(r, trader, 5000 * DOLLAR, 50); // a buyer who held none of these Shares before
        _toEnd(r);
        vm.roll(r.endBlock + 1);
        uint256 spend0 = p.treasury.spendable();
        uint256 melt0 = p.treasury.melting();
        uint256 plat0 = usd.balanceOf(platform);
        g = gasleft();
        vm.prank(stranger);
        launcher.finishReserveSale(p.key);
        emit log_named_uint("gas: finish a reserve sale", g - gasleft());
        uint256 raised = r.auction.currencyRaised();
        uint256 net = raised - raised * 3 / 100;
        assertEq(usd.balanceOf(platform) - plat0, raised * 3 / 100, "3 to the platform");
        uint256 toSpendable = p.treasury.spendable() - spend0;
        assertApproxEqAbs(toSpendable, net * 15 / 97, 1, "15 of each 100 spendable");
        assertApproxEqAbs(p.treasury.melting() - melt0, net * 82 / 97, 2, "82 of each 100 into the floor"); // no time passed
        assertEq(usd.balanceOf(address(launcher)), 0, "the Launcher keeps nothing");
        assertEq(p.shares.balanceOf(address(launcher)), 0);
        _collectBid(r, bid);
        assertGt(p.shares.balanceOf(trader), 0);
        assertEq(p.treasury.reserve() + p.shares.balanceOf(trader) + p.shares.balanceOf(ra), reserve0, "unsold back");
        vm.prank(alice);
        p.treasury.handBack(1000 * SHARE); // exits are open again
        (uint64 lastEnd, uint256 endPrice) = launcher.lastSale(p.key);
        assertEq(lastEnd, r.endBlock);
        assertEq(endPrice, r.auction.clearingPrice());
        vm.prank(council);
        vm.expectRevert(abi.encodeWithSelector(Launcher.TooEarly.selector, uint256(r.endBlock) + 201_600));
        launcher.openReserveSale(p.key, 1000 * SHARE);
    }

    function _saleAt(address a) internal view returns (Sale memory r) {
        r.auction = IAuctionTest(a);
        r.floorQ96 = r.auction.floorPrice();
        r.tickQ96 = r.auction.tickSpacing();
        r.startBlock = r.auction.startBlock();
        r.endBlock = r.auction.endBlock();
    }

    /// @dev Gas of the steps the server's helper job and the Team will send.
    function test_gas_theStakeGrantRidesOnStepTwo() public {
        Proj memory p = _launch(founder, keccak256("gas stake"));
        Sale memory s = _open(p);
        _flat(s, 100_000 * DOLLAR);
        _toEnd(s);
        vm.roll(s.endBlock + 1);
        p.finisher.openPool();
        uint256 g = gasleft();
        p.finisher.settle();
        g -= gasleft();
        emit log_named_uint("gas: finish step 2 (money split, pool marked open, the 20M stake granted)", g);
        assertLt(g, 600_000);
    }
}

contract AuctionV2LocalTest is AuctionV2Base {
    function _fork() internal pure override returns (bool) {
        return false;
    }
}

contract AuctionV2ForkTest is AuctionV2Base {
    function _fork() internal pure override returns (bool) {
        return true;
    }
}
