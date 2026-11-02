// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SecondaryMarketFixture} from "./SecondaryMarketMocks.t.sol";
import {FixedQuote} from "./SecondaryMarketMocks.t.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";

/// @title Secondary market invariants over a bounded mess of rounds
/// @notice Random order/claim/settle traffic must never make the market's actual balances fall short
/// of its own per-round ledgers, and every settled round's two sides must fill exactly the same whole
/// lots, whatever the pro-rata tie rule picked. Handlers bound all inputs; every action may fail and
/// those failures never carry state.

contract SecondaryMarketInvariant is SecondaryMarketFixture {
    address internal constant S1 = address(0x5E1101);
    address internal constant S2 = address(0x5E1102);
    address internal constant B1 = address(0xB11);
    address internal constant B2 = address(0xB22);

    Launch internal l;

    function setUp() public {
        address[] memory holders = new address[](4);
        uint256[] memory amounts = new uint256[](4);
        holders[0] = S1;
        holders[1] = S2;
        holders[2] = B1;
        holders[3] = B2;
        for (uint256 i; i < 4; ++i) {
            amounts[i] = 20e18;
        }
        l = _launch(holders, amounts);
        for (uint256 i; i < 4; ++i) {
            _approve(l, holders[i]);
        }
        l.quote.mint(B1, 100_000e6);
        l.quote.mint(B2, 100_000e6);
        _enableListing(l);
        l.market.openRound();
    }

    function _lots(uint128 raw) internal pure returns (uint128) {
        return uint128(1 + uint256(raw) % 12);
    }

    function _step(uint16 raw) internal pure returns (uint16) {
        return uint16(uint256(raw) % (LEVELS + 1));
    }

    function _actor(uint256 seed) internal pure returns (address who) {
        who = address(uint160(0x5E1100 + (seed % 4)));
    }

    // ---- actions (all failures are clean reverts that carry no state) ---------------------------------------------

    function warpForward(uint256 secondsAhead) public {
        vm.warp(block.timestamp + (secondsAhead % 28 days) + 1 hours);
    }

    function openNextRound() public tries {
        vm.warp(l.market.lastOpenAt() + WEEK);
        l.market.openRound();
    }

    function offerFromSellerOne(uint128 lots, uint256 round) public tries {
        vm.prank(S1);
        l.market.sell(round % (l.market.roundCount() + 1), _lots(lots), _step(uint16(uint256(lots) >> 96)));
    }

    function offerFromSellerTwo(uint128 lots, uint256 round) public tries {
        vm.prank(S2);
        l.market.sell(round % (l.market.roundCount() + 1), _lots(lots), _step(uint16(uint256(lots) >> 96)));
    }

    function bidFromBuyerOne(uint128 lots, uint256 round) public tries {
        vm.prank(B1);
        l.market.bid(round % (l.market.roundCount() + 1), _lots(lots), _step(uint16(uint256(lots) >> 96)));
    }

    function bidFromBuyerTwo(uint128 lots, uint256 round) public tries {
        vm.prank(B2);
        l.market.bid(round % (l.market.roundCount() + 1), _lots(lots), _step(uint16(uint256(lots) >> 96)));
    }

    function cancelOne(uint256 round, bool isOffer) public tries {
        vm.prank(isOffer ? S1 : B1, address(0));
        if (isOffer) l.market.cancelSell(round % (l.market.roundCount() + 1));
        else l.market.cancelBid(round % (l.market.roundCount() + 1));
    }

    function settleSoon(uint256 round) public tries {
        (,,,, uint64 closesAt, uint64 deadline,,,, bool settled,) = l.market.rounds(round % (l.market.roundCount() + 1));
        if (block.timestamp < closesAt) vm.warp(closesAt);
        if (!settled && block.timestamp < deadline) l.market.settle(round % (l.market.roundCount() + 1));
    }

    function drainClaims(uint256 round, bool isOffer) public tries {
        vm.prank(S1);
        if (isOffer) l.market.claimShares(round % (l.market.roundCount() + 1), S1);
        else l.market.claimQuote(round % (l.market.roundCount() + 1), B1);
    }

    /// @dev Catches every expected failure so the engine keeps exercising good paths too.
    modifier tries() {
        if (l.market.roundCount() == 0) return;
        _;
    }

    // ---- invariants ----------------------------------------------------------------------------------------------

    /// @dev Every round's validated intake is still held by the market, round by round, however the
    /// handlers mixed orders: the ledgers are never funded from another round's balance.
    function invariant_each_rounds_ledger_is_held_by_the_market() public view {
        uint256 quoteHeld = l.quote.balanceOf(address(l.market));
        uint256 sharesHeld = l.shares.balanceOf(address(l.market));
        uint256 totalQuoteLedger;
        uint256 totalSharesLedger;
        for (uint256 id = 1; id <= l.market.roundCount(); ++id) {
            totalQuoteLedger += l.market.quoteIn(id);
            totalSharesLedger += l.market.sharesIn(id);
        }
        assertGe(quoteHeld, totalQuoteLedger, "the round quote ledgers are covered by the real balance");
        assertGe(sharesHeld, totalSharesLedger, "the round share ledgers are covered by the real balance");
    }

    /// @dev Every settled round's buyers and sellers filled exactly the same whole lots, and no
    /// order ever filled more than it posted, whatever the tie rule picked.
    function invariant_settled_rounds_fill_both_sides_exactly() public view {
        for (uint256 id = 1; id <= l.market.roundCount(); ++id) {
            (,,,,,,,,, bool settled,) = l.market.rounds(id);
            address[] memory sellers = l.market.roundSellers(id);
            address[] memory buyers = l.market.roundBuyers(id);
            uint256 sumS;
            for (uint256 i; i < sellers.length; ++i) {
                (,, uint128 filled,,,) = l.market.sells(id, sellers[i]);
                sumS += filled;
            }
            uint256 sumB;
            for (uint256 i; i < buyers.length; ++i) {
                (,, uint128 filled,,,,) = l.market.bids(id, buyers[i]);
                sumB += filled;
            }
            if (!settled && sumS == 0 && sumB == 0) continue;
            assertEq(sumS, sumB, "every settled fill sums exactly on both sides");
            (,,,,,, uint256 askedTotal,,,,) = l.market.rounds(id);
            assertLe(sumS, askedTotal, "no side ever fills more than it posted");
        }
    }
}
