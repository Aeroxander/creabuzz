// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {SecondaryMarketFixture} from "./SecondaryMarketMocks.t.sol";
import {FixedQuote} from "./SecondaryMarketMocks.t.sol";
import {Shares} from "../src/majeur/MolochPatched.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";

/// @title Secondary market invariants over a bounded mess of rounds
/// @notice The fuzzer drives ONLY `SecondaryMarketHandler` (an explicit target: with no target Foundry
/// calls the market directly as a random sender and every order reverts, which made the earlier suite
/// compare 0 >= 0). The handler places 1 to 8 orders per side from eight funded actors (the same actor
/// may sit on both sides of a round), cancels, settles, voids rounds, and claims for anyone as anyone
/// (third parties included). Its inputs are bounded so every call it makes is valid: it runs with
/// `fail-on-revert`, so a market revert it did not expect is a failing run, never a skipped call.
///
/// The properties are the real ones, checked per round against an independent reading of the orders:
/// the quote and Shares ledgers equal the sum of what every order is still owed; the market's token
/// balances equal its ledgers; independently measured token flows (balance deltas, not the market's own
/// numbers) close each round; settled rounds clear by a reference matching rule, fill both sides
/// exactly, and tie-break the oversubscribed side by the pro-rata-then-lowest-order-id rule; and a
/// drained round pays out exactly its intake. A canary fails the suite if the handler never gets an
/// order accepted.

/// @dev Drives the market through its production entrypoints only. Ghost counters and per-round flow
/// ledgers are measured from token balance deltas around each call, never read back from the market.
contract SecondaryMarketHandler is Test {
    uint256 public constant ACTOR_COUNT = 8;
    uint256 internal constant MAX_LOTS = 12;

    SecondaryMarket public immutable market;
    FixedQuote public immutable quote;
    Shares public immutable shares;
    uint256 internal immutable LOT;

    address[8] public actors;
    address[3] public outsiders = [address(0xC0FFEE01), address(0xC0FFEE02), address(0xC0FFEE03)];

    // ---- ghost counters: proof that the handler really reaches the interesting states ---------------------------
    uint256 public calls;
    uint256 public ordersAccepted;
    uint256 public sellsAccepted;
    uint256 public bidsAccepted;
    uint256 public cancelsAccepted;
    uint256 public roundsOpened;
    uint256 public roundsSettled;
    uint256 public settledWithFill;
    uint256 public partialFilledOrders;
    uint256 public selfTradeRounds;
    uint256 public claimsPaid;
    uint256 public thirdPartyClaims;
    uint256 public voidClaimsPaid;
    uint256 public roundsDrained;
    /// @dev Seller remainders of SETTLED rounds returned by a claim: the path settle no longer takes itself.
    uint256 public settledRemainderClaims;

    // ---- independently measured flows per round -----------------------------------------------------------------
    mapping(uint256 => uint256) public quoteTakenIn;
    mapping(uint256 => uint256) public quotePaidOut;
    mapping(uint256 => uint256) public sharesTakenIn;
    mapping(uint256 => uint256) public sharesPaidOut;

    constructor(SecondaryMarket market_, FixedQuote quote_, Shares shares_, address[8] memory actors_) {
        market = market_;
        quote = quote_;
        shares = shares_;
        LOT = market_.lotSize();
        actors = actors_;
    }

    // ---- views the invariants and tests use ---------------------------------------------------------------------

    function now_() public view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _times(uint256 id) internal view returns (uint64 closesAt, uint64 deadline, bool settled) {
        (,,,, closesAt, deadline,,,, settled,) = market.rounds(id);
    }

    // ---- orders ---------------------------------------------------------------------------------------------------

    /// @notice A random actor offers 1 to 12 of their own lots at a random level in the current round,
    /// opening the next round first when the current one has closed.
    function sell(uint256 actorSeed, uint256 lotsSeed, uint256 stepSeed) external {
        calls++;
        uint256 id = _tradingRound(stepSeed);
        address a = actors[actorSeed % ACTOR_COUNT];
        (uint128 had,,,,,) = market.sells(id, a);
        if (had != 0) return;
        uint256 held = shares.balanceOf(a) / LOT;
        if (held == 0) return;
        uint128 lots = uint128(1 + lotsSeed % (held < MAX_LOTS ? held : MAX_LOTS));
        uint16 step = uint16(stepSeed % (_levels() + 1));
        uint256 before = shares.balanceOf(address(market));
        vm.prank(a);
        market.sell(id, lots, step);
        sharesTakenIn[id] += shares.balanceOf(address(market)) - before;
        ordersAccepted++;
        sellsAccepted++;
        _noteSelfTrade(id, a);
    }

    /// @notice A random actor bids 1 to 12 lots at a random level in the current round.
    function bid(uint256 actorSeed, uint256 lotsSeed, uint256 stepSeed) external {
        calls++;
        uint256 id = _tradingRound(stepSeed);
        address a = actors[actorSeed % ACTOR_COUNT];
        (uint128 had,,,,,,) = market.bids(id, a);
        if (had != 0) return;
        uint128 lots = uint128(1 + lotsSeed % MAX_LOTS);
        uint16 step = uint16(stepSeed % (_levels() + 1));
        if (quote.balanceOf(a) < uint256(lots) * market.priceAt(id, step)) return;
        uint256 before = quote.balanceOf(address(market));
        vm.prank(a);
        market.bid(id, lots, step);
        quoteTakenIn[id] += quote.balanceOf(address(market)) - before;
        ordersAccepted++;
        bidsAccepted++;
        _noteSelfTrade(id, a);
    }

    function cancelSell(uint256 actorSeed) external {
        calls++;
        uint256 id = market.roundCount();
        (uint64 closesAt,,) = _times(id);
        if (now_() >= closesAt) return;
        address a = actors[actorSeed % ACTOR_COUNT];
        (uint128 had,,,,,) = market.sells(id, a);
        if (had == 0) return;
        uint256 before = shares.balanceOf(address(market));
        vm.prank(a);
        market.cancelSell(id);
        sharesPaidOut[id] += before - shares.balanceOf(address(market));
        cancelsAccepted++;
    }

    function cancelBid(uint256 actorSeed) external {
        calls++;
        uint256 id = market.roundCount();
        (uint64 closesAt,,) = _times(id);
        if (now_() >= closesAt) return;
        address a = actors[actorSeed % ACTOR_COUNT];
        (uint128 had,,,, bool cancelled,,) = market.bids(id, a);
        if (had == 0 || cancelled) return;
        vm.prank(a);
        market.cancelBid(id);
        cancelsAccepted++;
    }

    // ---- time and rounds ------------------------------------------------------------------------------------------

    /// @notice Open the next round as soon as the market allows (anyone may), waiting out the interval.
    function openRound(uint256 jitter) external {
        calls++;
        // Usually settle the round being replaced first, so most rounds settle and only some go void.
        if (jitter % 4 != 0) _settleRound(market.roundCount());
        _openNext(jitter / 4 % 1 days);
    }

    function elapse(uint256 secondsAhead) external {
        calls++;
        vm.warp(now_() + 1 + secondsAhead % 4 days);
    }

    /// @notice Let the newest round go past its settle deadline unsettled, so it is void.
    function lapse() external {
        calls++;
        (, uint64 deadline, bool settled) = _times(market.roundCount());
        if (!settled && now_() < deadline) vm.warp(deadline);
    }

    /// @notice Settle any not yet settled round that is still inside its window, from an outsider.
    function settle(uint256 roundSeed) external {
        calls++;
        _settleRound(1 + roundSeed % market.roundCount());
    }

    // ---- claims, by anyone for anyone -----------------------------------------------------------------------------

    function claimQuote(uint256 roundSeed, uint256 whoSeed, uint256 callerSeed) external {
        calls++;
        _claimQuote(1 + roundSeed % market.roundCount(), actors[whoSeed % ACTOR_COUNT], _caller(callerSeed));
    }

    function claimShares(uint256 roundSeed, uint256 whoSeed, uint256 callerSeed) external {
        calls++;
        _claimShares(1 + roundSeed % market.roundCount(), actors[whoSeed % ACTOR_COUNT], _caller(callerSeed));
    }

    /// @notice Claim every right of one finished round (settled, or void past its deadline) for every
    /// actor, then assert the whole round paid out exactly what it took in and the market owes it nothing.
    function drainRound(uint256 roundSeed, uint256 callerSeed) external {
        calls++;
        uint256 id = 1 + roundSeed % market.roundCount();
        (, uint64 deadline, bool settled) = _times(id);
        if (!settled && now_() < deadline) return;
        address caller = _caller(callerSeed);
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            _claimShares(id, actors[i], caller);
            _claimQuote(id, actors[i], caller);
        }
        assertEq(market.quoteIn(id), 0, "a drained round holds no quote ledger");
        assertEq(market.sharesIn(id), 0, "a drained round holds no Shares ledger");
        assertEq(quotePaidOut[id], quoteTakenIn[id], "the quote paid out of a drained round equals its intake");
        assertEq(sharesPaidOut[id], sharesTakenIn[id], "the Shares paid out of a drained round equal its intake");
        roundsDrained++;
    }

    // ---- inside ---------------------------------------------------------------------------------------------------

    function _levels() internal view returns (uint32 levels) {
        (,, levels,,,,,,,,) = market.rounds(market.roundCount());
    }

    function _caller(uint256 seed) internal view returns (address) {
        uint256 i = seed % (ACTOR_COUNT + outsiders.length);
        return i < ACTOR_COUNT ? actors[i] : outsiders[i - ACTOR_COUNT];
    }

    function _isActor(address who) internal view returns (bool) {
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            if (actors[i] == who) return true;
        }
        return false;
    }

    function _noteSelfTrade(uint256 id, address a) internal {
        (uint128 s,,,,,) = market.sells(id, a);
        (uint128 b,,,,,,) = market.bids(id, a);
        if (s != 0 && b != 0) selfTradeRounds++;
    }

    /// @dev The round orders go into: the newest one, opening the next (and usually settling the one it
    /// replaces) when the newest has closed. Warps forward only as far as the market's own interval needs.
    function _tradingRound(uint256 seed) internal returns (uint256 id) {
        id = market.roundCount();
        (uint64 closesAt,,) = _times(id);
        if (now_() >= closesAt) {
            if (seed % 4 != 0) _settleRound(id);
            id = _openNext(0);
        }
    }

    function _openNext(uint256 jitter) internal returns (uint256 id) {
        uint256 at = market.lastOpenAt() + market.EVERY();
        if (now_() < at) vm.warp(at + jitter);
        id = market.openRound();
        roundsOpened++;
    }

    function _settleRound(uint256 id) internal {
        (uint64 closesAt, uint64 deadline, bool settled) = _times(id);
        if (settled || now_() >= deadline) return;
        if (now_() < closesAt) vm.warp(closesAt);
        uint256 before = shares.balanceOf(address(market));
        vm.prank(outsiders[id % outsiders.length]);
        market.settle(id);
        // Settle only books fills: it moves no Shares at all, so unsold remainders wait for their claim.
        assertEq(shares.balanceOf(address(market)), before, "settle moves no Shares");
        roundsSettled++;
        (, uint256 matched,) = market.clearingOf(id);
        if (matched != 0) settledWithFill++;
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            (uint128 sl,, uint128 sf,,,) = market.sells(id, actors[i]);
            (uint128 bl,, uint128 bf,,,,) = market.bids(id, actors[i]);
            if (sf != 0 && sf < sl) partialFilledOrders++;
            if (bf != 0 && bf < bl) partialFilledOrders++;
        }
    }

    function _claimQuote(uint256 id, address who, address caller) internal {
        uint256 marketBefore = quote.balanceOf(address(market));
        uint256 whoBefore = quote.balanceOf(who);
        bool wasVoid = market.voided(id);
        vm.prank(caller);
        try market.claimQuote(id, who) {}
        catch (bytes memory err) {
            _onlyNothingToClaim(err);
            return;
        }
        uint256 paid = marketBefore - quote.balanceOf(address(market));
        assertEq(quote.balanceOf(who) - whoBefore, paid, "a quote claim pays the order's owner, whoever called");
        quotePaidOut[id] += paid;
        _noteClaim(wasVoid, caller);
    }

    function _claimShares(uint256 id, address who, address caller) internal {
        uint256 marketBefore = shares.balanceOf(address(market));
        uint256 whoBefore = shares.balanceOf(who);
        bool wasVoid = market.voided(id);
        (uint128 sellLots,, uint128 sellFilled,, bool wasReturned,) = market.sells(id, who);
        (,,,,,,,,, bool settledBefore,) = market.rounds(id);
        vm.prank(caller);
        try market.claimShares(id, who) {}
        catch (bytes memory err) {
            _onlyNothingToClaim(err);
            return;
        }
        uint256 paid = marketBefore - shares.balanceOf(address(market));
        assertEq(shares.balanceOf(who) - whoBefore, paid, "a Shares claim pays the order's owner, whoever called");
        sharesPaidOut[id] += paid;
        if (settledBefore && !wasReturned && sellLots > sellFilled) settledRemainderClaims++;
        _noteClaim(wasVoid, caller);
    }

    function _noteClaim(bool wasVoid, address caller) internal {
        claimsPaid++;
        if (wasVoid) voidClaimsPaid++;
        if (!_isActor(caller)) thirdPartyClaims++;
    }

    /// @dev Nothing to claim is the one expected, harmless refusal; any other revert is a defect and is
    /// re-thrown so the run fails with the market's own error.
    function _onlyNothingToClaim(bytes memory err) internal pure {
        if (bytes4(err) == SecondaryMarket.NothingToClaim.selector) return;
        assembly ("memory-safe") {
            revert(add(err, 32), mload(err))
        }
    }
}

/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: default.invariant.runs = 24
/// forge-config: default.invariant.depth = 150
contract SecondaryMarketInvariant is SecondaryMarketFixture {
    uint256 internal constant ACTOR_COUNT = 8;
    uint256 internal constant STARTING_LOTS = 20;
    /// @dev The canary only fires once the handler has had this many calls: a short sequence may
    /// legitimately have drawn nothing but cancels and claims, a long one never does.
    uint256 internal constant CANARY_CALLS = 150;

    Launch internal l;
    SecondaryMarketHandler internal handler;
    uint256 internal initialShares;
    uint256 internal initialQuote;

    function setUp() public {
        address[] memory holders = new address[](ACTOR_COUNT);
        uint256[] memory amounts = new uint256[](ACTOR_COUNT);
        address[8] memory actors;
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            actors[i] = address(uint160(0x5E1100 + i));
            holders[i] = actors[i];
            amounts[i] = STARTING_LOTS * LOT_SIZE;
        }
        l = _launch(holders, amounts);
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            _approve(l, actors[i]);
            l.quote.mint(actors[i], 10_000_000e6);
        }
        _enableListing(l);
        l.market.openRound();
        initialShares = l.shares.totalSupply();
        initialQuote = l.quote.totalSupply();

        handler = new SecondaryMarketHandler(l.market, l.quote, l.shares, actors);
        targetContract(address(handler));
        // Orders are weighted (three entries each) so rounds fill up with orders before time moves on.
        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = handler.sell.selector;
        selectors[1] = handler.bid.selector;
        selectors[2] = handler.cancelSell.selector;
        selectors[3] = handler.cancelBid.selector;
        selectors[4] = handler.openRound.selector;
        selectors[5] = handler.elapse.selector;
        selectors[6] = handler.lapse.selector;
        selectors[7] = handler.settle.selector;
        selectors[8] = handler.claimQuote.selector;
        selectors[9] = handler.claimShares.selector;
        selectors[10] = handler.drainRound.selector;
        selectors[11] = handler.sell.selector;
        selectors[12] = handler.bid.selector;
        selectors[13] = handler.sell.selector;
        selectors[14] = handler.bid.selector;
        selectors[15] = handler.sell.selector;
        selectors[16] = handler.bid.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        excludeContract(address(l.market));
        excludeContract(address(l.quote));
        excludeContract(address(l.shares));
        excludeContract(address(l.dao));
        excludeContract(address(l.policy));
    }

    // ---- reference readings of one round --------------------------------------------------------------------------

    struct View {
        uint128 minPrice;
        uint128 step;
        uint32 levels;
        uint64 closesAt;
        uint64 deadline;
        uint16 price;
        bool settled;
        bool sellersShare;
    }

    function _round(uint256 id) internal view returns (View memory v) {
        (v.minPrice, v.step, v.levels,, v.closesAt, v.deadline,,, v.price, v.settled, v.sellersShare) =
            l.market.rounds(id);
    }

    function _actor(uint256 i) internal view returns (address) {
        return handler.actors(i);
    }

    /// @dev What every order of round `id` is still owed, read straight from the order records and the
    /// round's frozen grid, never from the market's ledgers.
    function _owed(uint256 id) internal view returns (uint256 quoteOwed, uint256 sharesOwed) {
        View memory v = _round(id);
        bool finished = v.settled || vm.getBlockTimestamp() >= v.deadline;
        uint256 price = uint256(v.minPrice) + uint256(v.price) * v.step;
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            (uint128 sl,, uint128 sf,, bool returned, bool proceedsPaid) = l.market.sells(id, _actor(i));
            if (sl != 0) {
                if (finished && !proceedsPaid) quoteOwed += uint256(sf) * price;
                // The unsold remainder (the whole offer until the round settles or goes void) is owed until the
                // seller's claim returns it; settle itself returns nothing.
                if (!returned) sharesOwed += uint256(sl - (v.settled ? sf : 0)) * LOT_SIZE;
            }
            (uint128 bl, uint16 maxStep, uint128 bf,, bool cancelled, bool sharesPaid, bool refundDone) =
                l.market.bids(id, _actor(i));
            if (bl != 0) {
                uint256 escrow = uint256(bl) * (uint256(v.minPrice) + uint256(maxStep) * v.step);
                if (!refundDone) quoteOwed += (v.settled && !cancelled) ? escrow - uint256(bf) * price : escrow;
                if (v.settled && !sharesPaid) sharesOwed += uint256(bf) * LOT_SIZE;
            }
        }
    }

    // ---- invariants -----------------------------------------------------------------------------------------------

    /// @dev Round by round, the market's quote and Shares ledgers equal exactly what that round's orders
    /// are still owed: nothing is funded from another round, nothing is left behind after a payout.
    function invariant_each_rounds_ledgers_equal_what_its_orders_are_owed() public view {
        for (uint256 id = 1; id <= l.market.roundCount(); ++id) {
            (uint256 quoteOwed, uint256 sharesOwed) = _owed(id);
            assertEq(l.market.quoteIn(id), quoteOwed, "the round's quote ledger is exactly its unpaid quote rights");
            assertEq(l.market.sharesIn(id), sharesOwed, "the round's Shares ledger is exactly its unpaid Shares rights");
        }
    }

    /// @dev The market's real balances are exactly its ledgers (no donation exists here), and nothing is
    /// created or lost anywhere in the system.
    function invariant_market_balances_equal_ledgers_and_supply_is_conserved() public view {
        uint256 quoteLedger;
        uint256 sharesLedger;
        for (uint256 id = 1; id <= l.market.roundCount(); ++id) {
            quoteLedger += l.market.quoteIn(id);
            sharesLedger += l.market.sharesIn(id);
        }
        assertEq(l.quote.balanceOf(address(l.market)), quoteLedger, "the market holds exactly its quote ledgers");
        assertEq(l.shares.balanceOf(address(l.market)), sharesLedger, "the market holds exactly its Shares ledgers");
        uint256 actorQuote;
        uint256 actorShares;
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            actorQuote += l.quote.balanceOf(_actor(i));
            actorShares += l.shares.balanceOf(_actor(i));
        }
        assertEq(actorQuote + quoteLedger, initialQuote, "quote is neither created nor lost");
        assertEq(actorShares + sharesLedger, initialShares, "Shares are neither created nor lost");
        assertEq(l.shares.totalSupply(), initialShares, "no Shares were minted or burned");
    }

    /// @dev The independently measured token flows close each round: what went in equals what is still
    /// on the ledger plus what was paid out, for quote and for Shares.
    function invariant_measured_flows_close_each_round() public view {
        for (uint256 id = 1; id <= l.market.roundCount(); ++id) {
            assertEq(
                handler.quoteTakenIn(id), l.market.quoteIn(id) + handler.quotePaidOut(id), "quote in = held + paid out"
            );
            assertEq(
                handler.sharesTakenIn(id),
                l.market.sharesIn(id) + handler.sharesPaidOut(id),
                "Shares in = held + paid out"
            );
        }
    }

    /// @dev Every settled round cleared by the reference rule (lowest level matching the most lots), both
    /// sides filled exactly the matched lots, only crossing orders filled, the short side filled whole,
    /// the long side filled its pro-rata share rounded by at most one lot in ascending order-id order.
    function invariant_settled_rounds_clear_and_fill_by_the_reference_rule() public view {
        for (uint256 id = 1; id <= l.market.roundCount(); ++id) {
            View memory v = _round(id);
            assertLe(l.market.roundSellers(id).length, l.market.MAX_ACTIVE_SELLERS(), "seller list is bounded");
            assertLe(l.market.roundBuyers(id).length, l.market.MAX_ACTIVE_BUYERS(), "buyer list is bounded");
            if (!v.settled) {
                _assertUnfilled(id);
                continue;
            }
            (uint256 level, uint256 matched, bool sellersShare) = _reference(id, v.levels);
            assertEq(v.price, level, "the settled price is the reference clearing level");
            if (matched != 0) assertEq(v.sellersShare, sellersShare, "the oversubscribed side is the reference one");
            _assertFills(id, v, matched);
        }
    }

    /// @dev Nothing is ever filled in a round that has not settled.
    function _assertUnfilled(uint256 id) internal view {
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            (,, uint128 sf,,,) = l.market.sells(id, _actor(i));
            (,, uint128 bf,,,,) = l.market.bids(id, _actor(i));
            assertEq(sf, 0, "an unsettled round filled a seller");
            assertEq(bf, 0, "an unsettled round filled a buyer");
        }
    }

    function _reference(uint256 id, uint32 levels)
        internal
        view
        returns (uint256 level, uint256 matched, bool sellersShare)
    {
        for (uint256 lv; lv <= levels; ++lv) {
            uint256 supply;
            uint256 demand;
            for (uint256 i; i < ACTOR_COUNT; ++i) {
                (uint128 sl, uint16 minStep,,,,) = l.market.sells(id, _actor(i));
                if (sl != 0 && minStep <= lv) supply += sl;
                (uint128 bl, uint16 maxStep,,, bool cancelled,,) = l.market.bids(id, _actor(i));
                if (bl != 0 && !cancelled && maxStep >= lv) demand += bl;
            }
            uint256 fill = supply < demand ? supply : demand;
            if (fill > matched) {
                matched = fill;
                level = lv;
                sellersShare = supply > demand;
            }
        }
    }

    function _assertFills(uint256 id, View memory v, uint256 matched) internal view {
        uint256 sumS;
        uint256 sumB;
        uint256 sellerQuota; // lots the sharing side's crossing orders are offered, when it is sellers
        uint256 buyerQuota;
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            (uint128 sl, uint16 minStep, uint128 sf,,,) = l.market.sells(id, _actor(i));
            (uint128 bl, uint16 maxStep, uint128 bf,, bool cancelled,,) = l.market.bids(id, _actor(i));
            bool sellCrosses = sl != 0 && minStep <= v.price;
            bool bidCrosses = bl != 0 && !cancelled && maxStep >= v.price;
            assertLe(sf, sl, "a seller never fills more than they offered");
            assertLe(bf, bl, "a buyer never fills more than they bid");
            if (!sellCrosses) assertEq(sf, 0, "an order past the price filled");
            if (!bidCrosses) assertEq(bf, 0, "an order past the price filled");
            sumS += sf;
            sumB += bf;
            if (sellCrosses) sellerQuota += sl;
            if (bidCrosses) buyerQuota += bl;
        }
        assertEq(sumS, matched, "the sellers filled exactly the matched lots");
        assertEq(sumB, matched, "the buyers filled exactly the matched lots");
        if (matched == 0) return;
        // The short side (the one that does not share) fills whole; the long side shares pro rata.
        _assertSide(id, v, matched, v.sellersShare ? sellerQuota : buyerQuota, v.sellersShare);
    }

    function _assertSide(uint256 id, View memory v, uint256 matched, uint256 total, bool sellers) internal view {
        uint256 withExtra;
        uint256 distributedBase;
        for (uint256 i; i < ACTOR_COUNT; ++i) {
            (uint256 lots, uint256 filled, uint256 orderId, bool crosses) = _side(id, v, i, sellers);
            (uint256 otherLots, uint256 otherFilled,, bool otherCrosses) = _side(id, v, i, !sellers);
            // The other side is the short one: every crossing order fills whole.
            if (otherCrosses) assertEq(otherFilled, otherLots, "the short side's crossing orders fill whole");
            if (!crosses) continue;
            uint256 base = lots * matched / total;
            distributedBase += base;
            assertTrue(filled == base || filled == base + 1, "a pro-rata fill is its share rounded by one lot at most");
            if (filled == base + 1) {
                withExtra++;
                // A leftover lot only ever goes to a lower order id than every order that did not get one.
                for (uint256 j; j < ACTOR_COUNT; ++j) {
                    (uint256 lotsJ, uint256 filledJ, uint256 idJ, bool crossesJ) = _side(id, v, j, sellers);
                    if (crossesJ && filledJ == (lotsJ * matched / total)) {
                        assertLt(orderId, idJ, "leftover lots go to the lowest order ids first");
                    }
                }
            }
        }
        assertEq(withExtra, matched - distributedBase, "exactly the leftover lots were handed out");
    }

    function _side(uint256 id, View memory v, uint256 i, bool sellers)
        internal
        view
        returns (uint256 lots, uint256 filled, uint256 orderId, bool crosses)
    {
        if (sellers) {
            uint16 minStep;
            uint128 sl;
            uint128 sf;
            uint64 oid;
            (sl, minStep, sf, oid,,) = l.market.sells(id, _actor(i));
            return (sl, sf, oid, sl != 0 && minStep <= v.price);
        }
        (uint128 bl, uint16 maxStep, uint128 bf, uint64 boid, bool cancelled,,) = l.market.bids(id, _actor(i));
        return (bl, bf, boid, bl != 0 && !cancelled && maxStep >= v.price);
    }

    /// @dev CANARY. A suite whose handlers never get an order accepted proves nothing (the earlier
    /// suite compared 0 >= 0 for exactly that reason): once the handler has made enough calls, orders
    /// must have been accepted and rounds must exist.
    function invariant_canary_the_handler_really_trades() public view {
        assertGt(l.market.roundCount(), 0, "rounds exist");
        if (handler.calls() >= CANARY_CALLS) {
            assertGt(handler.ordersAccepted(), 0, "no order was ever accepted: the suite is vacuous");
            assertGt(handler.sellsAccepted(), 0, "no offer was ever accepted");
            assertGt(handler.bidsAccepted(), 0, "no bid was ever accepted");
        }
    }

    // ---- directed runs: bind the handler to the production seam so the canary cannot rot silently -----------------

    /// @dev One scripted round through the very handler the fuzzer drives: three sellers and three buyers
    /// with a pro-rata tie, an actor on both sides, a third-party drain, then a void round drained too.
    function test_handler_drives_a_real_pro_rata_round_and_a_void_round() public {
        // Round 1 (opened in setUp): sellers 0,1,2 offer 3,4,5 lots at level 0; buyers 3,4,0 bid 3,3,2 at level 8,
        // so the sellers are the oversubscribed side and every one is part-filled (8 of 12 lots sell).
        handler.sell(0, 2, 0);
        handler.sell(1, 3, 0);
        handler.sell(2, 4, 0);
        handler.bid(3, 2, 8);
        handler.bid(4, 2, 8);
        handler.bid(0, 1, 8); // actor 0 is on both sides
        assertEq(handler.ordersAccepted(), 6, "all six orders were accepted");
        assertEq(handler.selfTradeRounds(), 1, "one actor sat on both sides");
        handler.elapse(uint256(BIDDING)); // past closesAt
        handler.settle(0);
        assertEq(handler.roundsSettled(), 1, "the round settled");
        assertEq(handler.settledWithFill(), 1, "and matched lots");
        assertGt(handler.partialFilledOrders(), 0, "the oversubscribed side was filled pro rata");
        assertEq(handler.settledRemainderClaims(), 0, "settle returned no remainder before any claim");
        invariant_each_rounds_ledgers_equal_what_its_orders_are_owed();
        handler.drainRound(0, 9); // an outsider drains everything
        assertEq(handler.roundsDrained(), 1, "round one drained exactly");
        assertGt(handler.settledRemainderClaims(), 0, "a part-filled seller's remainder came home by claim");
        assertGt(handler.thirdPartyClaims(), 0, "claims were paid for others by a third party");
        // Round 2 goes void: orders, then nobody settles.
        handler.sell(5, 1, 3);
        handler.bid(6, 2, 8);
        handler.lapse();
        handler.drainRound(1, 8);
        assertEq(handler.roundsDrained(), 2, "the void round drained exactly");
        assertGt(handler.voidClaimsPaid(), 0, "void claims were paid");
        // And the invariants hold on the final state.
        invariant_each_rounds_ledgers_equal_what_its_orders_are_owed();
        invariant_market_balances_equal_ledgers_and_supply_is_conserved();
        invariant_measured_flows_close_each_round();
        invariant_settled_rounds_clear_and_fill_by_the_reference_rule();
    }
}
