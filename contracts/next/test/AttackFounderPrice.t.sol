// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Platform} from "./helpers/Platform.sol";
import {BASE_SHARES_PER_RAW_DOLLAR, BASE_START_Q96, startQ96} from "./helpers/Prices.sol";
import {Rounds} from "../src/Rounds.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Finisher} from "../src/Finisher.sol";
import {Pair} from "../src/Pair.sol";
import {SaleParams} from "../src/Pinned.sol";

/// @notice Attacks on founder-set prices (`docs/next-version/FOUNDER-PRICE.md`, plan decision 7), milestone 2 world: anchoring
/// with a cheap round, a down round to the founder's own accounts, the exact price bounds with 1-dollar asks and scale-back
/// dust, overselling the 150M backing Shares across rounds at mixed prices, a round reading another round's price, a Pair
/// signer and the price, and the zero-stake setting. Each test logs its measured numbers.
contract AttackFounderPriceRoundsTest is RoundsBase {
    uint256 internal constant SIX_MILLION = 166_666_666_666_666;
    uint256 internal constant TOP = 2e13; // 50,000,000 for the whole project
    uint256 internal constant BACKING = 150_000_000e18;
    address internal own1 = makeAddr("founder's own account 1");
    address internal own2 = makeAddr("founder's own account 2");

    // ================================================ anchoring ======================================================

    /// @dev A1. The founder backs round 1 at the lowest price (333,333) from an own account, then outsiders back round 2 at
    /// 6,000,000: the round history reads "18x up". Measured: the founder side holds exactly the 30M Shares any solo founder's
    /// accounts can buy today; the anchor buys no extra Shares, only the story.
    function test_attack_lowThenHigh_anchor_buysNoExtraShares() public {
        _checkIn();
        uint256 id1 = _openRoundAt(BASE_SHARES_PER_RAW_DOLLAR);
        _ask(id1, own1, 10_000 * DOLLAR);
        _close(id1);
        rd.settle(id1, own1);
        uint256 anchorFee = rd.platformOwed();
        _team();
        _checkIn();
        uint256 id2 = _openRoundAt(SIX_MILLION);
        _ask(id2, bob, 40_000 * DOLLAR);
        _close(id2);
        rd.settle(id2, bob);
        uint256 ownShares = rd.positionOf(id1, own1).bought;
        uint256 bobShares = rd.positionOf(id2, bob).bought;
        assertEq(ownShares, 30_000_000 * SHARE, "the founder side: 30M, today's solo exposure, no more");
        assertEq(bobShares, 40_000 * DOLLAR * SIX_MILLION);
        // per dollar, the founder side bought 18x what the outsiders did
        assertEq(ownShares / (10_000 * DOLLAR) / (bobShares / (40_000 * DOLLAR)), 18);
        emit log_named_decimal_uint("A1 founder side Shares for 10,000 at 333,333", ownShares, 18);
        emit log_named_decimal_uint("A1 outsiders' Shares for 40,000 at 6M", bobShares, 18);
        emit log_named_uint(
            "A1 founder side's part of all backing Shares sold, per 1,000", ownShares * 1000 / (ownShares + bobShares)
        );
        emit log_named_decimal_uint("A1 platform's 3% on the founder side's 10,000", anchorFee, 6);
        // the money-weighted average price the server will show: 50,000 for 31.67M Shares
        emit log_named_decimal_uint(
            "A1 average whole-project price paid (dollars)",
            50_000 * DOLLAR * 1_000_000_000 * SHARE / (ownShares + bobShares),
            6
        );
    }

    /// @dev A2. Down round to own accounts: outsiders pay 6,000,000 in round 1 (10,000 solo), then the Pair opens round 2 at
    /// 333,333 to the founder's own accounts for the other 40,000. Measured: 120M Shares for 40,000 (fee 1,200), exactly a
    /// default founder's exposure today; the outsider can take back most of their money.
    function test_attack_downRoundToOwnAccounts_measured() public {
        _checkIn();
        uint256 id1 = _openRoundAt(SIX_MILLION);
        _ask(id1, alice, 10_000 * DOLLAR);
        _close(id1);
        rd.settle(id1, alice);
        _team();
        _checkIn();
        uint256 id2 = _openRoundAt(BASE_SHARES_PER_RAW_DOLLAR);
        _ask(id2, own1, 40_000 * DOLLAR);
        _close(id2);
        rd.settle(id2, own1);
        uint256 own = rd.positionOf(id2, own1).bought;
        uint256 out = rd.positionOf(id1, alice).bought;
        assertEq(own, 120_000_000 * SHARE, "the founder side: 120M for 40,000, today's Team exposure");
        assertEq(rd.unsold(), BACKING - own - out);
        uint256 refundable = rd.refundable(id1, alice);
        uint256 paid = _refund(id1, alice);
        assertEq(paid, refundable);
        assertGt(paid * 1000 / (10_000 * DOLLAR), 770, "the outsider takes back more than 77 of each 100 on day 1");
        emit log_named_decimal_uint("A2 outsider's Shares for 10,000 at 6M", out, 18);
        emit log_named_decimal_uint("A2 founder side's Shares for 40,000 at 333,333", own, 18);
        emit log_named_uint("A2 founder side's part of backing Shares sold, per 1,000", own * 1000 / (own + out));
        emit log_named_decimal_uint("A2 outsider's refund 1 day after their round closed (of 10,000)", paid, 6);
    }

    // ================================================ bounds and dust ================================================

    /// @dev A3. The exact bounds with 1-dollar asks: 20 Shares at 50,000,000 and 3,000 at 333,333, no rounding at all
    /// (Shares = dollars x a whole number). One raw unit outside either bound is refused.
    function test_attack_exactBounds_oneDollarAsks_noRounding() public {
        _checkIn();
        vm.prank(founder);
        vm.expectRevert(Rounds.CannotOpen.selector);
        launcher.openRound(key, TOP - 1);
        vm.prank(founder);
        vm.expectRevert(Rounds.CannotOpen.selector);
        launcher.openRound(key, 3e15 + 1);
        uint256 id1 = _openRoundAt(TOP);
        _ask(id1, alice, DOLLAR);
        usd.mint(bob, DOLLAR);
        vm.startPrank(bob);
        usd.approve(address(rd), type(uint256).max);
        vm.expectRevert(Rounds.BadAmount.selector);
        rd.ask(id1, DOLLAR - 1);
        vm.stopPrank();
        _close(id1);
        rd.settle(id1, alice);
        assertEq(rd.positionOf(id1, alice).bought, 20 * SHARE, "1 dollar at 50,000,000: exactly 20 Shares");
        _checkIn();
        uint256 id2 = _openRoundAt(3e15);
        _ask(id2, bob, DOLLAR);
        _close(id2);
        rd.settle(id2, bob);
        assertEq(rd.positionOf(id2, bob).bought, 3000 * SHARE, "1 dollar at 333,333: exactly 3,000 Shares");
        assertEq(rd.reserved(), 0, "no dust when nothing is scaled back");
    }

    /// @dev A3b. Scale-back dust at the highest price: a 1-dollar round, a whale asks 1,000,000 and a 1-dollar backer asks 1.
    /// Measured: the small backer is accepted 0 and gets the whole ask back (no Shares, no loss); the whale is accepted 999,999
    /// raw units; the dust (1 raw unit of dollars) leaves 2e13 raw Shares (0.00002 of a Share) set aside for good, and the
    /// platform's 3% rounds 30,000 raw down to 29,999. Under one Share at any price: no attack.
    function test_attack_scaleBackDust_atTheHighestPrice() public {
        _checkIn();
        uint256 id1 = _openRoundAt(TOP);
        _ask(id1, carol, 9999 * DOLLAR);
        _close(id1);
        rd.settle(id1, carol);
        _checkIn();
        uint256 id2 = _openRoundAt(TOP);
        assertEq(rd.roundOf(id2).size, DOLLAR, "1 dollar left under the solo cap");
        _ask(id2, bob, 1_000_000 * DOLLAR);
        _ask(id2, alice, DOLLAR);
        _close(id2);
        uint256 a0 = usd.balanceOf(alice);
        rd.settle(id2, alice);
        rd.settle(id2, bob);
        assertEq(rd.positionOf(id2, alice).bought, 0, "the small backer buys nothing");
        assertEq(usd.balanceOf(alice) - a0, DOLLAR, "and gets the whole ask back");
        assertEq(rd.positionOf(id2, bob).bought, 999_999 * TOP);
        assertEq(rd.reserved(), TOP, "1 raw dollar of dust: 2e13 raw Shares stay set aside");
        emit log_named_decimal_uint("A3b Shares stuck as dust at 50,000,000", rd.reserved(), 18);
        uint256 fee2 = rd.platformOwed() - 9999 * DOLLAR * 3 / 100;
        assertEq(fee2, 29_999);
        emit log_named_uint("A3b platform raw units owed for the 1-dollar round (3% of 1,000,000 raw is 30,000)", fee2);
    }

    // ================================================ oversell ======================================================

    /// @dev A4. All rounds at the lowest price fill the 150M exactly; the next round is refused by the cap, not by a lack of
    /// Shares. At mixed prices the Shares never run out first.
    function test_attack_lowestPriceEverywhere_fillsExactly150M() public {
        _checkIn();
        uint256 id1 = _openRoundAt(3e15);
        _ask(id1, own1, 10_000 * DOLLAR);
        _close(id1);
        rd.settle(id1, own1);
        _team();
        _checkIn();
        uint256 id2 = _openRoundAt(3e15);
        _ask(id2, own2, 1_000_000 * DOLLAR); // over-asked: scaled back to the 40,000 left
        _close(id2);
        rd.settle(id2, own2);
        assertEq(rd.positionOf(id1, own1).bought + rd.positionOf(id2, own2).bought, BACKING);
        assertEq(shares.balanceOf(address(rd)), 0, "every backing Share sold");
        assertEq(rd.unsold(), 0);
        _checkIn();
        bytes memory data = abi.encodeCall(Launcher.openRound, (key, TOP));
        _bothRefused(address(launcher), data, abi.encodeWithSelector(Launcher.CapReached.selector, 50_000 * DOLLAR));
    }

    /// @dev A4 fuzzed: a solo round then Team rounds at random prices in the range (the lowest price a third of the time) and
    /// random asks (1 to 60,000 dollars). Every open under the cap succeeds, the Shares handed out never pass 150M, and the
    /// Rounds' balance always equals the 150M less what was bought.
    function testFuzz_attack_mixedPricesNeverOversell(uint256 seed) public {
        uint256 bought;
        for (uint256 i; i < 6; ++i) {
            if (i == 1) _team();
            if (rd.raised() >= launcher.capOf(t.runner())) break;
            uint256 price = bound(uint256(keccak256(abi.encode(seed, i, "price"))), TOP, 3e15);
            if (uint256(keccak256(abi.encode(seed, i, "low"))) % 3 == 0) price = 3e15;
            uint256 amount = bound(uint256(keccak256(abi.encode(seed, i, "ask"))), DOLLAR, 60_000 * DOLLAR);
            address who = address(uint160(0xB0B0 + i));
            _checkIn();
            uint256 id = _openRoundAt(price);
            _ask(id, who, amount);
            _close(id);
            rd.settle(id, who);
            bought += rd.positionOf(id, who).bought;
            assertLe(bought, BACKING, "never more than the 150M");
            assertEq(shares.balanceOf(address(rd)), BACKING - bought, "the balance is the 150M less what was bought");
            assertEq(rd.reserved(), 0, "one backer a round: no scale-back dust");
        }
        assertLe(rd.raised(), 50_000 * DOLLAR);
    }

    // ================================================ another round's price ==========================================

    /// @dev A5. Round 1 at 50,000,000 closes; round 2 opens at 333,333. An ask to round 1 is refused (an ask goes to one round
    /// id), round 1's backer settled while round 2 is open gets round 1's price, and their refund cancels exactly round 1's
    /// Shares.
    function test_attack_settleAndRefundWhileAnotherRoundIsOpen_readTheirOwnRound() public {
        _checkIn();
        uint256 id1 = _openRoundAt(TOP);
        _ask(id1, alice, 1000 * DOLLAR);
        _close(id1);
        _checkIn();
        uint256 id2 = _openRoundAt(3e15);
        _ask(id2, bob, 1000 * DOLLAR);
        usd.mint(alice, DOLLAR);
        vm.prank(alice);
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.ask(id1, DOLLAR);
        rd.settle(id1, alice);
        assertEq(rd.positionOf(id1, alice).bought, 1000 * DOLLAR * TOP, "round 1's price: 20,000 Shares, not 3,000,000");
        uint256 r0 = shares.balanceOf(address(t));
        _refund(id1, alice);
        assertEq(shares.balanceOf(address(t)) - r0, 1000 * DOLLAR * TOP, "the refund cancels round 1's Shares only");
        _close(id2);
        rd.settle(id2, bob);
        assertEq(rd.positionOf(id2, bob).bought, 1000 * DOLLAR * 3e15);
    }

    // ================================================ the Pair and the price =========================================

    /// @dev A6. A Pair signer cannot confirm a price the other did not propose, nor confirm their own proposal. A proposal never
    /// expires: one the founder proposed at 333,333 and then left pending can still be confirmed weeks later by the cosigner,
    /// after the founder moved on to 6,000,000 (worked: a stale price runs unless the founder cancels it).
    function test_attack_pair_priceNeedsBothSigners_butAStaleProposalStillRuns() public {
        Pair pair = _team();
        bytes memory low = abi.encodeCall(Launcher.openRound, (key, BASE_SHARES_PER_RAW_DOLLAR));
        bytes memory high = abi.encodeCall(Launcher.openRound, (key, SIX_MILLION));
        vm.prank(founder);
        pair.propose(address(launcher), low);
        uint256 nLow = pair.nonce() - 1;
        vm.prank(cosigner);
        vm.expectRevert(Pair.UnknownCall.selector);
        pair.confirm(address(launcher), high, nLow);
        vm.prank(founder);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.confirm(address(launcher), low, nLow);
        // the founder moves on: a round at 6M, proposed and confirmed; the 333,333 proposal is left pending
        _checkIn();
        uint256 id1 = _openRoundAt(SIX_MILLION);
        _ask(id1, alice, 5000 * DOLLAR);
        _close(id1);
        uint256 proposedAt = _now();
        _live(21 days);
        // three weeks later the cosigner confirms the stale low proposal: a down round the founder no longer meant
        vm.prank(cosigner);
        uint256 id2 = abi.decode(pair.confirm(address(launcher), low, nLow), (uint256));
        assertEq(rd.roundOf(id2).sharesPerRawDollar, BASE_SHARES_PER_RAW_DOLLAR, "the stale price ran");
        emit log_named_uint("A6 days between the stale proposal and its confirm", (_now() - proposedAt) / 1 days);
    }

    // ================================================ zero stake =====================================================

    /// @dev A8. The zero stake was one global setting (the stake address set to zero), so ANY founder who launched while it
    /// was zero took no stake. Fixed: the stake address must always be named, and the admin names project zero by its key
    /// (`nameProjectZero`), used up by that one launch. A stranger who launches in the same block, with the same project id or
    /// any other, takes the stake. A founder still cannot set any of it.
    function test_attack_zeroStakeWindow_closed_onlyTheNamedProjectTakesNoStake() public {
        Launcher.Settings memory s = _settings();
        s.stake = address(0);
        vm.prank(founder);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.setSettings(s);
        vm.prank(admin);
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(s);
        bytes32 creatonKey = launcher.keyOf(founder, keccak256("creaton")); // read first: a prank applies to the next call
        vm.prank(founder);
        vm.expectRevert(Launcher.NotAdmin.selector);
        launcher.nameProjectZero(creatonKey);
        vm.prank(admin);
        launcher.nameProjectZero(creatonKey);
        // a stranger watching the chain launches in the same block, with Creaton's project id too: the stake is taken
        (, address dodger,) = _launch(stranger, keccak256("creaton"));
        (, address dodger2,) = _launch(stranger, keccak256("not project zero"));
        (, address creaton,) = _launch(founder, keccak256("creaton"));
        assertEq(Treasury(dodger).stakeAmount(), 20_000_000 * SHARE, "the stranger took the stake");
        assertEq(Treasury(dodger2).stakeAmount(), 20_000_000 * SHARE);
        assertEq(Treasury(creaton).stakeAmount(), 0, "only project zero takes none");
        (, address later,) = _launch(stranger, keccak256("after"));
        assertEq(Treasury(later).stakeAmount(), 20_000_000 * SHARE);
        emit log_named_decimal_uint("A8 stake the platform loses on a project launched in the window (now)", 0, 18);
    }
}

/// @notice Attacks on the runner's auction start, on the real Uniswap stack (local twin): the ceiling start through the whole
/// sale and the pool step, in both token orders.
contract AttackFounderPriceCeilingTest is Platform {
    function setUp() public {
        _setUpPlatform(false);
    }

    /// @dev A7. Start at `MAX_START_Q96` (0.05 a Share), demand up to the 4x cap (0.2): the minimum is about 12,500,000 and
    /// fits easily, the sale graduates, the pool opens with about 55M Shares and the price at the end price, both token orders.
    function test_attack_ceilingStart_fullSaleAndPool_quoteIsCurrency0() public {
        _ceiling(true);
    }

    function test_attack_ceilingStart_fullSaleAndPool_sharesAreCurrency0() public {
        _ceiling(false);
    }

    function _ceiling(bool quoteIsCurrency0) internal {
        Proj memory p = _launchOrdered(founder, quoteIsCurrency0);
        Sale memory s = _openAt(p, launcher.MAX_START_Q96());
        uint256 minimum = s.floorQ96 * SaleParams.SALE_SHARES >> 96;
        assertLt(minimum, type(uint128).max);
        assertApproxEqRel(minimum, 12_500_000 * DOLLAR, 1e12);
        vm.roll(s.startBlock);
        uint256 a = _bid(s, alice, 40_000_000 * DOLLAR, 300); // at the 4x cap, 0.2 a Share
        uint256 b = _bid(s, bob, 20_000_000 * DOLLAR, 150);
        _toEnd(s);
        assertTrue(s.auction.isGraduated(), "graduated at the ceiling start");
        _finish(p, s);
        assertEq(uint256(p.finisher.stage()), uint256(Finisher.Stage.Done), "the pool step ran at a 0.2 price");
        _collectBid(s, a);
        _collectBid(s, b);
        uint256 inPool = p.shares.balanceOf(poolManager);
        uint256 end = s.auction.clearingPrice();
        uint256 spot = _spot(_key(p)); // whole dollars a whole Share, x 1e18
        uint256 endWhole = (end * 1e18 >> 96) * 1e12; // raw dollars per raw Share, to whole dollars per whole Share x 1e18
        assertApproxEqRel(spot, endWhole, 0.02e18, "the pool starts at the sale's end price");
        assertApproxEqRel(inPool, 55_000_000 * SHARE, 0.02e18, "about 55M Shares in the pool");
        // a trade both ways works
        usd.mint(trader, 10_000 * DOLLAR);
        (, uint256 got) = _swap(_key(p), address(p.shares), trader, true, 10_000 * DOLLAR);
        assertGt(got, 0);
        (, uint256 back) = _swap(_key(p), address(p.shares), trader, false, got);
        assertGt(back, 9000 * DOLLAR);
        emit log_named_decimal_uint("A7 minimum at the ceiling start", minimum, 6);
        emit log_named_decimal_uint("A7 raised", s.auction.currencyRaised(), 6);
        emit log_named_uint("A7 end price, hundredths of the start", end * 100 / s.floorQ96);
        emit log_named_decimal_uint("A7 pool dollars", usd.balanceOf(poolManager), 6);
        emit log_named_decimal_uint("A7 pool Shares", inPool, 18);
    }
}

/// @notice A9: high rounds, then an auction started low "to dump onto backers", and the app's 1.2x pre-fill at the top.
contract AttackFounderPriceDumpTest is Platform {
    function setUp() public {
        _setUpPlatform(false);
    }

    function _roundAt(Proj memory p, uint256 price, address who, uint256 amount) internal returns (uint256 id) {
        _checkIn(p);
        address r = p.treasury.runner();
        if (launcher.isPair(r)) {
            id = abi.decode(_both(p, address(launcher), abi.encodeCall(Launcher.openRound, (p.key, price))), (uint256));
        } else {
            vm.prank(r);
            id = launcher.openRound(p.key, price);
        }
        usd.mint(who, amount);
        vm.startPrank(who);
        IERC20(address(usd)).approve(address(p.rounds), type(uint256).max);
        p.rounds.ask(id, amount);
        vm.stopPrank();
        vm.warp(_now() + 1 days);
        p.rounds.close(id);
        p.rounds.settle(id, who);
    }

    /// @dev Outsiders back 50,000 at 50,000,000 (1M Shares), then the Pair starts the auction at today's 0.0004 and the
    /// founder's second account is the only bidder for the 100,000 minimum: 250M liquid Shares for 100,000 against the
    /// outsiders' 1M for 50,000. Measured: what the outsiders' Shares are worth at the sale price, and what they can still take
    /// back right after the market opened (their protection: the refund, not a price tie).
    function test_attack_highRoundsThenLowStart_dumpOntoBackers_measured() public {
        Proj memory p = _launch(founder, keccak256("dump"));
        uint256 id1 = _roundAt(p, 2e13, alice, 10_000 * DOLLAR);
        _team(p);
        uint256 id2 = _roundAt(p, 2e13, bob, 40_000 * DOLLAR);
        uint256 backerShares = p.rounds.positionOf(id1, alice).bought + p.rounds.positionOf(id2, bob).bought;
        assertEq(backerShares, 1_000_000 * SHARE);
        Sale memory s = _openAt(p, BASE_START_Q96);
        address second = makeAddr("founder's second account");
        vm.roll(s.startBlock);
        uint256 fid = _bid(s, second, 100_000 * DOLLAR, 1);
        _toEnd(s);
        vm.warp(_now() + 1 days);
        _finish(p, s);
        (, uint256 bought) = _collectBid(s, fid);
        uint256 end = s.auction.clearingPrice();
        uint256 backersWorth = backerShares * end >> 96;
        emit log_named_decimal_uint("A9 founder's second account: Shares for 100,000", bought, 18);
        emit log_named_decimal_uint("A9 outsiders' 1M Shares at the sale price (paid 50,000)", backersWorth, 6);
        uint256 pa = p.rounds.refundable(id1, alice);
        uint256 pb = p.rounds.refundable(id2, bob);
        vm.prank(alice);
        assertEq(p.rounds.refund(id1), pa);
        vm.prank(bob);
        assertEq(p.rounds.refund(id2), pb);
        emit log_named_decimal_uint("A9 alice takes back of 10,000 (2 days after her round closed)", pa, 6);
        emit log_named_decimal_uint("A9 bob takes back of 40,000 (1 day after his round closed)", pb, 6);
        assertGt((pa + pb) * 100 / (50_000 * DOLLAR), 76, "outsiders take back more than 76 of each 100");
        assertLt(
            backersWorth, 500 * DOLLAR, "without the refund the outsiders' Shares price at under 1% of what they paid"
        );
    }

    /// @dev The app's pre-fill for the auction start (1.2 x the last round's price) is refused on chain once the last round is
    /// above 41,666,666 for the whole project: 1.2 x 50,000,000 is 0.06 a Share, above the 0.05 ceiling.
    function test_attack_prefillAboveTheCeilingIsRefused() public {
        Proj memory p = _launch(founder, keccak256("prefill"));
        _roundAt(p, 2e13, alice, DOLLAR); // a 1-dollar round at the top price is enough to set "the last round's price"
        _openRefusedAt(p, startQ96(60_000), abi.encodeWithSelector(Launcher.BadStart.selector));
        Sale memory s = _openAt(p, startQ96(50_000));
        assertGe(s.floorQ96, startQ96(50_000));
    }
}
