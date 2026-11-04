// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SecondaryMarketFixture} from "./SecondaryMarketMocks.t.sol";
import {BlockableQuote, FixedQuote, ReentrantQuote} from "./SecondaryMarketMocks.t.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";

/// @title Secondary market adversarial suite
/// @notice The D179 PoCs' shape, mapped onto the candidate's seams: a callback quote cannot rerun any
/// order state change; a blocked payout stays recorded and collectable; unattributed deposits become
/// no one's credit; forced ETH stays irrelevant; a rogue market can never receive locked Shares nor
/// take the birth exemption; claims survive a cleared exit exchange; the side caps bound every loop;
/// and whole-lot conservation holds at every grid level the fuzz reaches.

/// @dev Receives 1 wei from the test and selfdestructs it into the market: an uncallable path.
contract Dusty {
    function whoosh(address target) external payable {
        assembly ("memory-safe") {
            selfdestruct(target)
        }
    }
}

contract SecondaryMarketAdversary is SecondaryMarketFixture {
    address internal constant S1 = address(0x5E1101);
    address internal constant S2 = address(0x5E1102);
    address internal constant S3 = address(0x5E1103);
    address internal constant B1 = address(0xB11);
    address internal constant B2 = address(0xB22);
    address internal constant STANDIN = address(0x518D1);
    address internal constant ROGUE = address(0x9C01);

    Launch internal l;

    function setUp() public {
        address[] memory holders = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        holders[0] = S1;
        holders[1] = S2;
        holders[2] = S3;
        amounts[0] = 40e18;
        amounts[1] = 30e18;
        amounts[2] = 20e18;
        l = _launchWithQuote(holders, amounts, new FixedQuote(), true);
        _approve(l, S1);
        _approve(l, S2);
        _approve(l, S3);
        l.quote.mint(B1, 1_000_000e6);
        l.quote.mint(B2, 1_000_000e6);
        _approve(l, B1);
        _approve(l, B2);
    }

    /// @dev A fresh honest launch under the same summoner, the sellers stocked, with a hostile or
    /// blocking quote, plus its own buyer stocked and approved.
    function _hostileLaunch(ERC20 hostile) internal returns (Launch memory out) {
        address[] memory holders = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        holders[0] = address(0x5E2101);
        holders[1] = address(0x5E2102);
        holders[2] = address(0x5E2103);
        amounts[0] = 40e18;
        amounts[1] = 30e18;
        amounts[2] = 20e18;
        out = _launchWithQuote(holders, amounts, hostile, true);
        _approve(out, address(0x5E2101));
        _approve(out, address(0x5E2102));
        _approve(out, address(0x5E2103));
        out.quote.mint(address(0xB21), 1_000_000e6);
        _approve(out, address(0xB21));
    }

    // ---- no primary funding, no minting, no claimAndLeave ----------------------------------------------------------

    function test_no_primary_mint_funding_or_claimandleave_entrypoint_exists() public {
        bytes4 funding = bytes4(keccak256("openFunding(address)"));
        bytes4 settleTerms = bytes4(keccak256("settleFunding(uint256)"));
        bytes4 minting = bytes4(keccak256("mintFromMoloch(address,uint256)"));
        bytes4 leave = bytes4(keccak256("claimAndLeave(uint256,address[])"));
        (bool opened,) = address(l.market).call(abi.encodePacked(funding, abi.encode(address(0x9991))));
        assertFalse(opened, "no funding can be opened on the market");
        (bool settled,) = address(l.market).call(abi.encodePacked(settleTerms, abi.encode(uint256(1))));
        assertFalse(settled, "no funding can be settled on the market");
        (bool minted,) = address(l.market).call(abi.encodePacked(minting, abi.encode(address(0x9991), uint256(1))));
        assertFalse(minted, "nothing can be minted through the market");
        (bool left,) = address(l.market).call(abi.encodePacked(leave, abi.encode(uint256(1), new address[](0))));
        assertFalse(left, "no arbitrary-token claimAndLeave exists");
        assertEq(l.shares.totalSupply(), 90e18, "and no extra Shares appeared in the whole flow");
    }

    function test_the_dao_and_the_market_cannot_sell_inventory() public {
        uint256 id = _openRoundWith(l);
        vm.prank(address(l.dao));
        vm.expectRevert(SecondaryMarket.DaoCannotSell.selector);
        l.market.sell(id, 1, 0);
        // The market approves nobody, ever: its held escrow moves only through recorded claims.
        assertEq(l.quote.allowance(address(l.market), STANDIN), 0);
        assertEq(l.quote.allowance(address(l.market), address(l.dao)), 0);
        assertEq(l.shares.allowance(address(l.market), STANDIN), 0);
        assertEq(l.shares.allowance(address(l.market), address(l.dao)), 0);
    }

    // ---- callback tokens -------------------------------------------------------------------------------------------

    function test_a_reentering_quote_cannot_rerun_any_order_state_change() public {
        Launch memory hl = _hostileLaunch(new ReentrantQuote());
        ReentrantQuote quote2 = ReentrantQuote(address(hl.quote));
        quote2.arm(address(hl.market), SecondaryMarket.settle.selector);
        uint256 id = _openRoundWith(hl);
        vm.prank(address(0x5E2101));
        hl.market.sell(id, 5, 0);
        vm.prank(address(0xB21));
        hl.market.bid(id, 5, 1);
        // The quote re-entered settle while the bid's escrow was moving; the round cannot settle then.
        assertGe(quote2.pokes(), 1, "the reentry happened");
        (,,,,,,,,, bool settledEarly,) = hl.market.rounds(id);
        assertFalse(settledEarly, "and the refusals kept the round's state honest");
        // The settlement runs its normal, honest shape later, inside its own window.
        _toSettle(hl, id);
        hl.market.settle(id);
        (,, uint128 sFilled,, bool returned,) = hl.market.sells(id, address(0x5E2101));
        assertEq(sFilled, uint128(5));
        assertFalse(returned, "nothing was unsold");
        // The same quote then re-enters claimQuote from inside its own proceeds transfer.
        quote2.arm(address(hl.market), SecondaryMarket.claimQuote.selector);
        vm.prank(STANDIN);
        hl.market.claimShares(id, address(0xB21));
        vm.prank(STANDIN);
        hl.market.claimQuote(id, address(0x5E2101));
        assertGe(quote2.refusals(), 1, "the claim's own reentry was refused");
        assertEq(
            hl.quote.balanceOf(address(0x5E2101)), uint256(5) * 1_600, "paid exactly once at the lowest clearing level"
        );
    }

    function test_a_blocked_quote_strands_no_payout() public {
        Launch memory bl = _hostileLaunch(new BlockableQuote());
        BlockableQuote blocked = BlockableQuote(address(bl.quote));
        uint256 id = _openRoundWith(bl);
        // Cancel: the Shares return moved in the same transaction, whatever the quote's health.
        vm.prank(address(0x5E2101));
        bl.market.sell(id, 10, 0);
        uint256 before = bl.shares.balanceOf(address(0x5E2101));
        vm.prank(address(0x5E2101));
        bl.market.cancelSell(id);
        assertEq(bl.shares.balanceOf(address(0x5E2101)) - before, 10e18);
        assertEq(bl.market.sharesIn(id), 0, "and the ledger followed exactly");
        // Both sides escrow while the quote is healthy; then the quote refuses everything outbound.
        vm.prank(address(0x5E2101));
        bl.market.sell(id, 10, 0);
        vm.prank(address(0xB21));
        bl.market.bid(id, 10, 1);
        blocked.setBlocked(true);
        _toSettle(bl, id);
        bl.market.settle(id);
        vm.prank(STANDIN);
        bl.market.claimShares(id, address(0xB21));
        assertEq(bl.shares.balanceOf(address(0xB21)), 10e18, "the Shares side never needed the quote");
        vm.prank(STANDIN);
        vm.expectRevert(bytes4(keccak256("Blocked()")));
        bl.market.claimQuote(id, address(0x5E2101));
        assertEq(bl.market.quoteIn(id), uint256(10) * 2_100, "the round's whole intake stands until the claims pay it");
        blocked.setBlocked(false);
        vm.prank(STANDIN);
        bl.market.claimQuote(id, address(0x5E2101));
        assertEq(bl.quote.balanceOf(address(0x5E2101)), uint256(10) * 1_600, "one clean claim later, exactly once");
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        bl.market.claimQuote(id, address(0x5E2101));
    }

    // ---- unattributed deposits, forced ETH -------------------------------------------------------------------------

    function test_unattributed_deposits_become_no_ones_credit_and_are_never_paid() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B2);
        l.market.bid(id, 10, 1);
        // A holder shoves extra Shares straight at the market, unattributed to any round.
        vm.prank(S3);
        l.shares.transfer(address(l.market), 1e18);
        assertEq(l.market.sharesIn(id), uint256(10) * LOT_SIZE, "the ledger took none of it");
        _toSettle(l, id);
        l.market.settle(id);
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        vm.prank(STANDIN);
        l.market.claimQuote(id, B2);
        vm.prank(STANDIN);
        l.market.claimShares(id, B2);
        // Every claimed unit is exactly the orders'; the donation stays inert and unclaimable.
        assertEq(l.quote.balanceOf(S1), uint256(10) * 1_600);
        assertEq(l.shares.balanceOf(B2), 10e18);
        assertEq(l.shares.balanceOf(address(l.market)), 1e18, "the donation is not anyone's credit");
        assertEq(l.market.quoteIn(id), 0);
        assertEq(l.market.sharesIn(id), 0);
        // Nobody can cite the donation as any order: a claim with nothing owed refuses.
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimShares(id, S3);
        assertEq(l.shares.balanceOf(S3), 19e18, "S3 donated one lot that is nobody's credit");
        // ...and the matched assertion above: the round's own escrow is untouched by the donation.
    }

    function test_forced_eth_dust_stays_irrelevant() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B2);
        l.market.bid(id, 10, 1);
        Dusty emitter = new Dusty();
        emitter.whoosh{value: 1}(address(l.market));
        assertEq(address(l.market).balance, 1, "the dust sits there with no powers at all");
        _toSettle(l, id);
        l.market.settle(id);
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        vm.prank(STANDIN);
        l.market.claimQuote(id, B2);
        vm.prank(STANDIN);
        l.market.claimShares(id, B2);
        assertEq(l.quote.balanceOf(S1), uint256(10) * 1_600);
        assertEq(address(l.market).balance, 1, "no path exists to drain it, and none needed");
    }

    // ---- exit-exchange independence ------------------------------------------------------------------------------

    function test_claims_survive_a_cleared_or_replaced_exit_exchange() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        vm.prank(B2);
        l.market.bid(id, 5, 1);
        // The DAO turns the exchange slot completely off, as a vote can.
        vm.prank(address(l.dao));
        l.shares.clearExitExchange();
        assertEq(l.shares.exitExchange(), address(0));
        _toSettle(l, id);
        // Claims, returns and refunds all still complete: the market's birth exemption carries them.
        l.market.settle(id);
        vm.prank(STANDIN);
        l.market.claimQuote(id, S1);
        vm.prank(STANDIN);
        l.market.claimShares(id, B2);
        vm.prank(STANDIN);
        l.market.claimQuote(id, B2);
        // The seller's unsold half already went home inside the settle transaction, so its shares
        // claim has nothing left; it rightly refuses.
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        l.market.claimShares(id, S1);
        assertEq(l.shares.balanceOf(B2), 5e18);
        assertEq(l.shares.balanceOf(S1), 35e18);
        assertEq(
            l.quote.balanceOf(B2),
            1_000_000e6 - uint256(10_500) + uint256(2_500),
            "escrow at its 2100 limit; five lots cost 1600 each"
        );
        assertEq(l.shares.balanceOf(address(l.market)), 0);
    }

    // ---- rogue markets and the immutable exemption ----------------------------------------------------------------

    function test_a_rogue_market_never_receives_locked_shares_or_takes_the_exemption() public {
        vm.prank(S1);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        l.shares.transfer(address(ROGUE), 1e18);
        // The exemption set at birth is once and final, so no second market can have it either.
        vm.prank(address(l.dao));
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        l.shares.lockTransfersWithNotice(address(ROGUE));
        assertEq(l.shares.transferExempt(), address(l.market));
    }

    // ---- caps that bound every loop --------------------------------------------------------------------------------

    function _thirtyThree() internal pure returns (address[] memory out) {
        out = new address[](33);
        for (uint256 i; i < 33; ++i) {
            out[i] = address(uint160(0x7000 + i));
        }
    }

    function test_active_side_caps_bound_each_round() public {
        Launch memory big = _launchWithQuote(_thirtyThree(), _ones(), new FixedQuote(), true);
        vm.prank(address(big.dao));
        big.market.configureListing(true, MIN_PRICE, MAX_PRICE, LEVELS);
        uint256 id = big.market.openRound();
        for (uint256 i; i < 32; ++i) {
            _approve(big, address(uint160(0x7000 + i)));
            vm.prank(address(uint160(0x7000 + i)));
            big.market.sell(id, 1, 0);
        }
        vm.prank(address(uint160(0x7000 + 32)));
        vm.expectRevert(SecondaryMarket.TooManySellers.selector);
        big.market.sell(id, 1, 0);
        for (uint256 i; i < 32; ++i) {
            address who = address(uint160(0x7000 + i));
            big.quote.mint(who, 100_000e6);
            vm.prank(who);
            big.quote.approve(address(big.market), type(uint256).max);
            vm.prank(who);
            big.market.bid(id, 1, 0);
        }
        address last = address(uint160(0x7000 + 32));
        big.quote.mint(last, 100_000e6);
        vm.prank(last);
        big.quote.approve(address(big.market), type(uint256).max);
        vm.prank(last);
        vm.expectRevert(SecondaryMarket.TooManyBuyers.selector);
        big.market.bid(id, 1, 0);
    }

    function _ones() internal pure returns (uint256[] memory out) {
        out = new uint256[](33);
        for (uint256 i; i < 33; ++i) {
            out[i] = 1e18;
        }
    }

    // ---- settle determinism over the whole bounded grid ---------------------------------------------------------

    function testFuzz_settle_is_exact_at_every_grid_level(
        uint128 sellerLots,
        uint16 sellerStep,
        uint128 buyerLots,
        uint16 buyerStep
    ) public {
        sellerLots = 1 + sellerLots % 40;
        buyerLots = 1 + buyerLots % 20;
        sellerStep = uint16(uint256(sellerStep) % (LEVELS + 1));
        buyerStep = uint16(uint256(buyerStep) % (LEVELS + 1));
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, sellerLots, sellerStep);
        vm.prank(B2);
        l.market.bid(id, buyerLots, buyerStep);
        (uint256 level, uint256 matched, bool sellersShare) = l.market.clearingOf(id);
        _toSettle(l, id);
        l.market.settle(id);
        (,,,,,,,, uint16 roundPrice, bool settled, bool sharedSide) = l.market.rounds(id);
        assertTrue(settled);
        assertEq(uint256(roundPrice), level, "the preview and the settle agree everywhere");
        assertEq(sharedSide, sellersShare);
        // Whatever crossed filled whole and exactly: both sides' fill sums are one and the same,
        // regardless of which side the tie rule chose at the lowest matched level.
        (,, uint128 sFilled,,,) = l.market.sells(id, S1);
        (,, uint128 bFilled,,,,) = l.market.bids(id, B2);
        assertEq(uint256(sFilled), uint256(bFilled), "conservation is exact in whole lots");
        assertEq(uint256(sFilled), matched, "each side filled exactly the matched lots of its own order");
        // Conservation of the whole settle: every escrowed unit went back to the seller (their
        // unsold whole lots) or now sits exactly owed to the buyer.
        assertEq(l.market.sharesIn(id), uint256(bFilled) * LOT_SIZE, "escrow = unsold returned + buyer owed");
        assertEq(
            l.shares.balanceOf(address(l.market)),
            uint256(bFilled) * LOT_SIZE,
            "the market holds exactly what the buyers still claim"
        );
    }
}
