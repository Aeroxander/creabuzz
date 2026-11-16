// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./helpers/Base.sol";
import {TreasuryHandler} from "./helpers/TreasuryHandler.sol";

/// @notice The three written rules of milestone 2, and the rest of the list, checked after random sequences of everything
/// a person can do: founder, agents, holders, strangers, the opener and the sale path, with time passing.
///
///  Rule 1: the buckets equal the balance (never more than it; equal when nobody sent a stray transfer).
///  Rule 2: an exit never pays more than its slice.
///  Rule 3: project-held and unreleased Shares never count.
contract TreasuryInvariantsTest is Base {
    TreasuryHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new TreasuryHandler(launcher, t, shares, v, usd, founder);
        targetContract(address(h));
    }

    // ------------------------------------------------------------------------------------------------------ rule 1

    /// The four buckets never add up to more than the dollars held.
    function invariant_rule1_bucketsNeverExceedTheBalance() public view {
        assertGe(usd.balanceOf(address(t)), _buckets());
    }

    /// ... and equal them exactly when nothing was sent by hand: the difference is precisely the donations and the sale
    /// money nobody has split yet, as the handler counted them.
    function invariant_rule1_bucketsPlusStrayEqualTheBalance() public view {
        assertEq(usd.balanceOf(address(t)), _buckets() + h.stray());
        assertEq(t.unaccounted(), h.stray());
    }

    // ------------------------------------------------------------------------------------------------------ rule 2

    function invariant_rule2_anExitNeverPaysMoreThanItsSlice() public view {
        assertFalse(h.exitOverpaid());
    }

    function invariant_rule2_anExitNeverLowersTheFloorPerShareOfThoseWhoRemain() public view {
        assertFalse(h.perShareFell());
    }

    function invariant_rule2_anExitNeverTouchesSpendable() public view {
        assertFalse(h.exitTookSpendable());
        assertFalse(h.spendableTouched(), "only `spend` ever lowers spendable");
    }

    // ------------------------------------------------------------------------------------------------------ rule 3

    function invariant_rule3_theCountingSupplyLeavesOutTheTreasuryAndTheVester() public view {
        assertFalse(h.denominatorWrong());
        assertEq(t.countingSupply(), shares.totalSupply() - shares.balanceOf(address(t)) - shares.balanceOf(address(v)));
    }

    function invariant_rule3_theVesterAlwaysHoldsEveryUnreleasedShare() public view {
        assertGe(shares.balanceOf(address(v)), v.committed());
        address[5] memory who = [founder, h.holders(0), h.holders(1), h.holders(2), h.holders(3)];
        for (uint256 i; i < who.length; ++i) {
            (, uint256 claimed) = v.grants(who[i]);
            assertLe(claimed, v.released(who[i]), "nobody has claimed past the schedule");
        }
    }

    // --------------------------------------------------------------------------------------------------- the rest

    function invariant_sharesAreConservedAcrossVestGiftAndExit() public view {
        assertEq(shares.totalSupply(), SUPPLY - h.burned());
        uint256 sum = shares.balanceOf(address(launcher)) + shares.balanceOf(address(v)) + shares.balanceOf(address(t))
            + shares.balanceOf(founder);
        for (uint256 i; i < 4; ++i) {
            sum += shares.balanceOf(h.holders(i));
        }
        // gifts made before the pool opened sit in the Vester under their beneficiary's name; the payees of gifts are holders
        assertEq(sum, shares.totalSupply());
    }

    function invariant_theFounderAndAgentsNeverSpendMoreThanSpendable() public view {
        assertFalse(h.spentTooMuch());
    }

    function invariant_theWorkPotAndReserveStayBacked() public view {
        assertGe(shares.balanceOf(address(t)), t.workPot());
        assertEq(t.reserve(), 100_000_000 * SHARE + h.sharesDonatedToTreasury() - h.reserveReleased());
    }

    function invariant_theMeltingClockNeverPassesAYear() public view {
        assertLe(t.meltRemaining(), 365 days);
    }

    function invariant_giftsAfterThePoolNeverPassOnePercentInAnyThirtyDays() public view {
        uint256 n = h.giftCount();
        for (uint256 i; i < n; ++i) {
            TreasuryHandler.Use memory gi = h.gift(i);
            uint256 sum;
            for (uint256 j; j <= i; ++j) {
                TreasuryHandler.Use memory gj = h.gift(j);
                if (gj.time + 30 days > gi.time) sum += gj.amount;
            }
            assertLe(sum, gi.cap);
        }
    }

    function invariant_anAgentNeverPassesItsDailyCapInAnyTwentyFourHours() public view {
        for (uint256 a; a < 2; ++a) {
            address who = h.agents(a);
            uint256 n = h.agentSpendCount(who);
            for (uint256 i; i < n; ++i) {
                TreasuryHandler.Use memory ui = h.agentSpend(who, i);
                uint256 sum;
                for (uint256 j; j <= i; ++j) {
                    TreasuryHandler.Use memory uj = h.agentSpend(who, j);
                    if (uj.time + 1 days > ui.time) sum += uj.amount;
                }
                assertLe(sum, ui.cap);
            }
            n = h.agentGiveCount(who);
            for (uint256 i; i < n; ++i) {
                TreasuryHandler.Use memory ui = h.agentGive(who, i);
                uint256 sum;
                for (uint256 j; j <= i; ++j) {
                    TreasuryHandler.Use memory uj = h.agentGive(who, j);
                    if (uj.time + 1 days > ui.time) sum += uj.amount;
                }
                assertLe(sum, ui.cap);
            }
        }
    }

    // ---------------------------------------------------------------- the handler itself is not standing still

    /// After each run, when the file system may be written (set `FOUNDRY_FS_PERMISSIONS` to allow `./cache`), one line says
    /// how many of each action went through, so the report can say how deep the random sequences reach.
    function afterInvariant() public {
        try vm.writeLine(
            "cache/invariant-metrics.txt",
            string.concat(
                "exits=",
                vm.toString(h.exits()),
                " gifts=",
                vm.toString(h.giftsMade()),
                " spends=",
                vm.toString(h.spends()),
                " settles=",
                vm.toString(h.settles()),
                " claims=",
                vm.toString(h.claims()),
                " poolOpen=",
                t.poolOpen() ? "1" : "0"
            )
        ) {}
            catch {}
    }

    /// A scripted run through the handler, to show that its actions really reach the interesting states (an exit that
    /// pays, a gift after the pool, an agent spend, a vest claim); a handler whose calls all revert would prove nothing.
    function test_handlerReachesTheStatesTheInvariantsAreAbout() public {
        h.openPool();
        h.arrive(75_000_000_000); // 75,000 dollars
        h.settle(75_000_000_000);
        assertGt(h.settles(), 0);
        h.distribute(0, 100_000_000 * SHARE);
        h.distribute(1, 400_000_000 * SHARE);
        h.handBack(0, 10_000_000 * SHARE);
        assertEq(h.exits(), 1);
        h.giveShares(0, 2, 5_000_000 * SHARE);
        h.giveShares(1, 3, 100_000 * SHARE);
        assertEq(h.giftsMade(), 2);
        assertEq(h.giftCount(), 2);
        h.spend(0, 1_000_000);
        h.spend(1, 1_000_000);
        assertEq(h.spends(), 2);
        h.warp(40 days);
        h.claimVest(4);
        assertGt(h.claims(), 0);
        assertFalse(h.exitOverpaid());
    }
}
