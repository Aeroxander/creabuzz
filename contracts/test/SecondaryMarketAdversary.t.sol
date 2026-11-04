// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SecondaryMarketFixture} from "./SecondaryMarketMocks.t.sol";
import {BlockableQuote, FixedQuote, ReentrantQuote} from "./SecondaryMarketMocks.t.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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

/// @dev The cases are written once and run twice: against the stood-in mock policy
/// (`SecondaryMarketAdversary`) and against the production composition, a real `ContributorKitV2`
/// launch with the real `ActivationVoting` policy and its real escrow hooks
/// (`SecondaryMarketAdversaryReal`). A case that holds only under the mock proves nothing about the
/// real consume -> prepare -> transfer ordering, the real escrow books or the real hooks' own reverts.
abstract contract SecondaryMarketAdversaryCases is SecondaryMarketFixture {
    address internal constant S1 = address(0x5E1101);
    address internal constant S2 = address(0x5E1102);
    address internal constant S3 = address(0x5E1103);
    address internal constant B1 = address(0xB11);
    address internal constant B2 = address(0xB22);
    address internal constant STANDIN = address(0x518D1);
    address internal constant ROGUE = address(0x9C01);

    Launch internal l;
    /// @dev Total Shares at launch: 90 whole lots under the mock; the founder's whole grant under the real kit.
    uint256 internal supply0;

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
        supply0 = l.shares.totalSupply();
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
        assertEq(l.shares.totalSupply(), supply0, "and no extra Shares appeared in the whole flow");
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

    // ---- callback tokens: every guarded entrypoint ---------------------------------------------------------------
    //
    // The hostile quote re-enters from inside the payout of a real `claimQuote`, with well-formed calldata
    // for one guarded entrypoint at a time, in a state where that call would otherwise SUCCEED: the quote
    // acts as a funded seller and buyer itself, and the round is open or past its close as the case needs.
    // Each case asserts the nested call reverted with `Reentrancy` and nothing else, that a full snapshot
    // matches an identical run with no re-entry, and that the honest payout then still completes.
    // Deleting `nonReentrant` from `sell`, `bid`, `cancelSell`, `cancelBid`, `settle` or `claimShares`
    // fails exactly the one case below that targets it. `claimQuote` is also the host of every case, so
    // deleting its guard fails all of them: it then neither guards itself nor holds the lock open.

    address internal constant RS = address(0x5E3101);
    address internal constant RB = address(0xB31);

    /// @dev One launch whose quote token is the hostile actor: the honest seller `RS`, the honest buyer
    /// `RB`, and the quote itself holding Shares and quote of its own with the market approved for both.
    struct Reentry {
        Launch l;
        ReentrantQuote q;
        uint256 id;
    }

    function _reentryLaunch() internal returns (Reentry memory r) {
        r.q = new ReentrantQuote();
        address[] memory holders = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        holders[0] = RS;
        holders[1] = address(r.q);
        amounts[0] = 40e18;
        amounts[1] = 10e18;
        r.l = _launchWithQuote(holders, amounts, r.q, true);
        _approve(r.l, RS);
        _approve(r.l, RB);
        r.q.mint(RB, 1_000_000e6);
        r.q.mint(address(r.q), 1_000_000e6);
        r.q.approveMarket(address(r.l.market), IERC20(address(r.l.shares)));
        r.id = _openRoundWith(r.l);
    }

    /// @dev `who` bids `lots` at the lowest level and cancels, leaving a refund `claimQuote` will pay.
    function _cancelledBid(Reentry memory r, address who, uint128 lots) internal {
        vm.prank(who);
        r.l.market.bid(r.id, lots, 0);
        vm.prank(who);
        r.l.market.cancelBid(r.id);
    }

    function _raw(address to, bytes memory data) private view returns (bytes memory out) {
        bool ok;
        (ok, out) = to.staticcall(data);
        require(ok, "snapshot read failed");
    }

    /// @dev Everything the market keeps or holds for the round and its three actors, as one hash: the
    /// round struct, every order struct, both ledgers, the order counter, both lists, and all balances.
    function _fingerprint(Reentry memory r) internal view returns (bytes32 h) {
        SecondaryMarket m = r.l.market;
        h = keccak256(
            abi.encode(
                _raw(address(m), abi.encodeWithSelector(m.rounds.selector, r.id)),
                m.quoteIn(r.id),
                m.sharesIn(r.id),
                m.nextOrderId(),
                m.roundSellers(r.id),
                m.roundBuyers(r.id),
                r.l.shares.balanceOf(address(m)),
                r.q.balanceOf(address(m))
            )
        );
        address[3] memory who = [RS, RB, address(r.q)];
        for (uint256 i; i < 3; ++i) {
            h = keccak256(
                abi.encode(
                    h,
                    _raw(address(m), abi.encodeWithSelector(m.sells.selector, r.id, who[i])),
                    _raw(address(m), abi.encodeWithSelector(m.bids.selector, r.id, who[i])),
                    r.l.shares.balanceOf(who[i]),
                    r.q.balanceOf(who[i])
                )
            );
        }
    }

    function _claimOrNothing(Reentry memory r, address who) internal {
        try r.l.market.claimShares(r.id, who) {}
        catch (bytes memory e) {
            assertEq(bytes4(e), SecondaryMarket.NothingToClaim.selector, "only an empty claim may refuse");
        }
        try r.l.market.claimQuote(r.id, who) {}
        catch (bytes memory e) {
            assertEq(bytes4(e), SecondaryMarket.NothingToClaim.selector, "only an empty claim may refuse");
        }
    }

    /// @dev The honest ending: settle if nobody did, then every actor claims whatever is owed.
    function _finishHonestly(Reentry memory r) internal {
        (,,,, uint64 closesAt,,,,, bool settled,) = r.l.market.rounds(r.id);
        if (block.timestamp < closesAt) vm.warp(closesAt);
        if (!settled) r.l.market.settle(r.id);
        _claimOrNothing(r, RS);
        _claimOrNothing(r, RB);
        _claimOrNothing(r, address(r.q));
    }

    /// @dev Run the prepared scenario's one `claimQuote(outerWho)` twice from the same state: once plain,
    /// once with the quote armed to re-enter with `nested`. The nested call must be refused with
    /// `Reentrancy`, leave the same state as the plain run, and leave the round able to pay out honestly.
    function _assertRefused(Reentry memory r, bytes memory nested, address outerWho) internal {
        uint256 shares0 = r.l.shares.balanceOf(RS) + r.l.shares.balanceOf(RB) + r.l.shares.balanceOf(address(r.q))
            + r.l.shares.balanceOf(address(r.l.market));
        uint256 quote0 =
            r.q.balanceOf(RS) + r.q.balanceOf(RB) + r.q.balanceOf(address(r.q)) + r.q.balanceOf(address(r.l.market));
        uint256 snap = vm.snapshotState();
        vm.prank(STANDIN);
        r.l.market.claimQuote(r.id, outerWho);
        bytes32 plain = _fingerprint(r);
        assertTrue(vm.revertToState(snap));

        r.q.arm(address(r.l.market), nested);
        vm.prank(STANDIN);
        r.l.market.claimQuote(r.id, outerWho);
        assertEq(r.q.pokes(), 1, "the payout called back into the market exactly once");
        assertFalse(r.q.lastOk(), "the nested call did not go through");
        assertEq(r.q.lastRevert(), SecondaryMarket.Reentrancy.selector, "and it was the guard that refused it");
        assertEq(_fingerprint(r), plain, "the refused call left every ledger, order and balance as the plain run");

        _finishHonestly(r);
        assertEq(r.l.market.quoteIn(r.id), 0, "the quote ledger paid out to zero");
        assertEq(r.l.market.sharesIn(r.id), 0, "the Shares ledger paid out to zero");
        assertEq(r.l.shares.balanceOf(address(r.l.market)), 0, "no Shares left in the market");
        assertEq(r.q.balanceOf(address(r.l.market)), 0, "no quote left in the market");
        assertEq(
            r.l.shares.balanceOf(RS) + r.l.shares.balanceOf(RB) + r.l.shares.balanceOf(address(r.q)),
            shares0,
            "Shares were only moved, never made or lost"
        );
        assertEq(
            r.q.balanceOf(RS) + r.q.balanceOf(RB) + r.q.balanceOf(address(r.q)),
            quote0,
            "quote was only moved, never made or lost"
        );
    }

    function test_reentry_into_sell_is_refused() public {
        Reentry memory r = _reentryLaunch();
        _cancelledBid(r, RB, 3);
        _assertRefused(r, abi.encodeCall(SecondaryMarket.sell, (r.id, 1, 0)), RB);
    }

    function test_reentry_into_bid_is_refused() public {
        Reentry memory r = _reentryLaunch();
        _cancelledBid(r, RB, 3);
        _assertRefused(r, abi.encodeCall(SecondaryMarket.bid, (r.id, 1, 0)), RB);
    }

    function test_reentry_into_cancelSell_is_refused() public {
        Reentry memory r = _reentryLaunch();
        vm.prank(address(r.q));
        r.l.market.sell(r.id, 1, 0);
        _cancelledBid(r, RB, 3);
        _assertRefused(r, abi.encodeCall(SecondaryMarket.cancelSell, (r.id)), RB);
    }

    function test_reentry_into_cancelBid_is_refused() public {
        Reentry memory r = _reentryLaunch();
        vm.prank(address(r.q));
        r.l.market.bid(r.id, 1, 0);
        _cancelledBid(r, RB, 3);
        _assertRefused(r, abi.encodeCall(SecondaryMarket.cancelBid, (r.id)), RB);
    }

    /// @dev Past the close and before anyone settled, so a nested `settle` is otherwise valid.
    function test_reentry_into_settle_is_refused() public {
        Reentry memory r = _reentryLaunch();
        vm.prank(RS);
        r.l.market.sell(r.id, 5, 0);
        vm.prank(address(r.q));
        r.l.market.bid(r.id, 5, 0);
        _cancelledBid(r, RB, 3);
        _toSettle(r.l, r.id);
        _assertRefused(r, abi.encodeCall(SecondaryMarket.settle, (r.id)), RB);
        assertEq(r.l.shares.balanceOf(address(r.q)), 10e18 + 5e18, "the buyer side still got its five lots");
    }

    /// @dev A settled round with a buyer owed Shares, so a nested `claimShares` is otherwise valid.
    function test_reentry_into_claimShares_is_refused() public {
        Reentry memory r = _reentryLaunch();
        vm.prank(RS);
        r.l.market.sell(r.id, 5, 0);
        vm.prank(RB);
        r.l.market.bid(r.id, 5, 0);
        _toSettle(r.l, r.id);
        r.l.market.settle(r.id);
        uint256 sellerQuote = r.q.balanceOf(RS);
        _assertRefused(r, abi.encodeCall(SecondaryMarket.claimShares, (r.id, RB)), RS);
        assertEq(r.l.shares.balanceOf(RB), 5e18, "the buyer received its five lots exactly once");
        assertEq(r.q.balanceOf(RS) - sellerQuote, uint256(5) * 1_600, "the seller was paid exactly once");
    }

    /// @dev A second party's refund is claimable, so a nested `claimQuote` for them is otherwise valid.
    function test_reentry_into_claimQuote_is_refused() public {
        Reentry memory r = _reentryLaunch();
        _cancelledBid(r, address(r.q), 2);
        _cancelledBid(r, RB, 3);
        _assertRefused(r, abi.encodeCall(SecondaryMarket.claimQuote, (r.id, address(r.q))), RB);
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

/// @notice The cases against the stood-in policy (fast, and the only place the mock's own books are read).
contract SecondaryMarketAdversary is SecondaryMarketAdversaryCases {}

/// @notice The same cases against a real `ContributorKitV2` launch and the real `ActivationVoting` hooks.
contract SecondaryMarketAdversaryReal is SecondaryMarketAdversaryCases {
    function _useRealKit() internal pure override returns (bool) {
        return true;
    }
}
