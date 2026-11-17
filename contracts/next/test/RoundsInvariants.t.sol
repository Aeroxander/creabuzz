// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./helpers/Base.sol";
import {RoundsHandler} from "./helpers/RoundsHandler.sol";
import {Rounds} from "../src/Rounds.sol";

/// @notice The written rules of plan version 2's backing rounds, checked after random sequences of rounds, asks, settles,
/// refunds, gifts, releases, check-in lapses, pauses, the market opening and exits:
///  - dollars are conserved: every dollar a backer sent is with a backer, in the Treasury, with the platform, or in the Rounds,
///    and what the Rounds hold is exactly what their books say they owe;
///  - Shares are conserved;
///  - a refund never pays more than the backer's own unreleased money less the fee, and never moves anyone else's number;
///  - held Shares never count in the exit denominator;
///  - the stage caps never pass;
///  - the platform never receives more than its fees.
contract RoundsInvariantsTest is Base {
    RoundsHandler internal h;
    Rounds internal rd;

    function setUp() public override {
        super.setUp();
        rd = Rounds(rounds);
        h = new RoundsHandler(launcher, launcher.keyOf(founder, PROJECT), founder, councilMaker, usd);
        vm.prank(founder);
        t.checkIn(); // the window starts open; the handler's check-ins keep it so, or not
        targetContract(address(h));
    }

    function invariant_dollarsAreConserved() public view {
        uint256 withBackers;
        for (uint256 i; i < 6; ++i) {
            withBackers += usd.balanceOf(h.backers(i));
        }
        // the platform receives dollars only from the Rounds' sweep in this world (nobody sweeps the Treasury's fees)
        assertEq(
            usd.balanceOf(rounds) + withBackers + h.toTreasury() + usd.balanceOf(platform),
            h.minted(),
            "a dollar was made or lost"
        );
    }

    function invariant_theRoundsHoldExactlyWhatTheirBooksOwe() public view {
        uint256 owed = rd.platformOwed();
        for (uint256 id = 1; id <= rd.count(); ++id) {
            Rounds.Round memory r = rd.roundOf(id);
            owed += r.held + r.frozen - r.paidOut;
            for (uint256 i; i < 6; ++i) {
                Rounds.Position memory p = rd.positionOf(id, h.backers(i));
                if (!p.settled) owed += p.ask;
            }
            assertLe(r.paidOut, r.held + r.frozen, "a round paid out more than it held");
        }
        assertEq(usd.balanceOf(rounds), owed, "the Rounds' balance is not what they owe");
    }

    function invariant_sharesAreConserved() public view {
        assertEq(shares.totalSupply(), SUPPLY - h.burned());
        uint256 sum = shares.balanceOf(address(t)) + shares.balanceOf(address(v)) + shares.balanceOf(rounds)
            + shares.balanceOf(finisher) + shares.balanceOf(founder);
        for (uint256 i; i < 6; ++i) {
            sum += shares.balanceOf(h.backers(i));
        }
        for (uint256 i; i < 3; ++i) {
            sum += shares.balanceOf(h.holders(i));
        }
        assertEq(sum, shares.totalSupply());
        assertGe(shares.balanceOf(rounds), rd.reserved(), "the Shares owed to accepted asks are still there");
        assertGe(shares.balanceOf(address(v)), v.committed(), "the Vester holds every Share it owes");
        assertLe(v.unreleased(), v.committed(), "nothing unreleased is missing");
    }

    function invariant_aRefundIsPersonalAndBounded() public view {
        assertFalse(h.refundOverpaid(), "a refund paid more than the backer's own unreleased money less 5%");
        assertFalse(h.refundMovedOthers(), "a refund moved another backer's number");
    }

    /// Held Shares (founder, gifts before the market, backers, the stake) never count: the exit denominator leaves out the
    /// Treasury, the Rounds, the Finisher and everything the Vester has not released, and before a market nothing has.
    function invariant_heldSharesNeverCount() public view {
        assertEq(
            t.countingSupply(),
            shares.totalSupply() - shares.balanceOf(address(t)) - shares.balanceOf(rounds) - shares.balanceOf(finisher)
                - v.unreleased()
        );
        if (v.start() == 0) {
            assertEq(v.unreleased(), v.granted(), "before the clock nothing is released");
            uint256 free;
            for (uint256 i; i < 6; ++i) {
                free += shares.balanceOf(h.backers(i));
            }
            assertEq(free, 0, "no backer holds a Share before the clock starts");
        }
    }

    function invariant_theStageCapsNeverPass() public view {
        assertLe(rd.raised(), 50_000 * DOLLAR);
        if (!h.everPair()) assertLe(rd.raised(), 10_000 * DOLLAR, "one person never raised past 10,000");
        assertLe(rd.raised() * 3e15, 150_000_000 * SHARE);
    }

    function invariant_thePlatformNeverReceivesMoreThanItsFees() public view {
        assertFalse(h.platformOvercharged());
        // 3 of each accepted 100 and at most 1 of each 100 taken back (5 of 100 after a wind-down, capped below by the 82)
        assertLe(usd.balanceOf(platform) + rd.platformOwed(), rd.raised() * 3 / 100 + rd.raised() * 82 / 100 / 100 + 6);
    }

    /// A scripted run through the handler, to show its actions reach the states the invariants are about.
    function test_handlerReachesTheStates() public {
        h.openRound();
        h.ask(0, 3000 * DOLLAR);
        h.ask(1, 9000 * DOLLAR);
        h.warp(1 days);
        h.close();
        h.settle(0, 0);
        h.settle(1, 0);
        assertEq(h.settles(), 2);
        h.warp(10 days);
        h.checkIn();
        h.release(0);
        h.refund(0, 0);
        assertEq(h.refunds(), 1);
        h.team();
        h.openRound();
        assertEq(rd.count(), 2);
        h.warp(1 days);
        h.close();
        h.market();
        h.warp(10 days);
        h.claimHeld(1, 0);
        assertGt(h.claims(), 0);
        h.give(0, 1000 * SHARE);
        assertEq(h.gifts(), 1);
        h.handBack(2, 1_000_000 * SHARE);
        assertEq(h.exits(), 1);
        h.refund(1, 0); // after the market, for the Shares still held
        assertEq(h.refunds(), 2);
        invariant_dollarsAreConserved();
        invariant_theRoundsHoldExactlyWhatTheirBooksOwe();
        invariant_sharesAreConserved();
        invariant_heldSharesNeverCount();
    }
}
