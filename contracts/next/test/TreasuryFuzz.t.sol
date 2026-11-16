// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./helpers/Base.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice Fuzz tests of the money paths (1000 runs each, set in `foundry.toml`; the heavier ones ask for more).
contract TreasuryFuzzTest is Base {
    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_settleSplitsExactlyAndNeverCreatesMoney(uint256 amount) public {
        amount = bound(amount, 1, 1e24);
        _arrive(amount);
        _openPool();
        t.settle(amount);
        assertEq(t.spendable(), amount * 15 / 75);
        assertEq(t.spendable() + t.melting(), amount);
        assertEq(usd.balanceOf(address(t)), _buckets());
        // the floor part is never less than four times the spendable part less rounding
        assertGe(t.melting() + 3, 4 * t.spendable());
    }

    /// forge-config: default.fuzz.runs = 3000
    function testFuzz_anExitNeverPaysMoreThanItsSliceAndConservesMoney(
        uint256 raised,
        uint256 holding,
        uint256 revenue,
        uint256 elapsed,
        uint256 amount,
        bool checkedIn
    ) public {
        raised = bound(raised, 1_000_000, 1e21);
        holding = bound(holding, 1, 500_000_000 * SHARE);
        revenue = bound(revenue, 0, 1e18);
        elapsed = bound(elapsed, 0, 400 days);
        _sale(raised);
        _buy(alice, holding);
        _buy(bob, 500_000_000 * SHARE - holding);
        _approveAll(alice);
        if (revenue > 0) {
            usd.mint(carol, revenue);
            vm.startPrank(carol);
            usd.approve(address(t), revenue);
            t.shareRevenue(revenue);
            vm.stopPrank();
        }
        if (checkedIn) _runFor(elapsed);
        else vm.warp(_now() + elapsed);
        t.release();
        amount = bound(amount, 1, holding);

        uint256 floorBefore = t.melting() + t.permanentFloor();
        uint256 countingBefore = t.countingSupply();
        uint256 spendableBefore = t.spendable();
        uint256 balanceBefore = usd.balanceOf(address(t));
        uint256 supplyBefore = shares.totalSupply();
        vm.prank(alice);
        try t.handBack(amount) returns (uint256 paid) {
            uint256 slice = floorBefore * amount / countingBefore;
            assertLe(paid, slice, "never more than its slice");
            assertGe(paid + (slice * 500 + 9999) / 10_000, slice, "never less than the slice less the 5 percent fee");
            assertLe(paid + t.feesOwed(), slice, "the holder and the platform together get under the slice");
            assertEq(t.spendable(), spendableBefore, "spendable untouched");
            assertEq(usd.balanceOf(address(t)), balanceBefore - paid, "exactly what was paid left the balance");
            assertEq(shares.totalSupply(), supplyBefore - amount);
            assertEq(usd.balanceOf(address(t)), _buckets() + t.unaccounted());
            assertEq(t.unaccounted(), 0);
            // the floor per Share of the others did not fall
            assertGe((t.melting() + t.permanentFloor()) * countingBefore, floorBefore * t.countingSupply());
        } catch (bytes memory err) {
            assertEq(bytes4(err), Treasury.NothingToPay.selector, "the only refusal here is a slice too small to pay");
            assertEq(shares.totalSupply(), supplyBefore, "and nothing was burned");
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_aSequenceOfExitsPaysEachHolderTheirOwnSliceOnly(uint256 seed) public {
        _world();
        uint256 totalPaid;
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address who = seed % 2 == 0 ? alice : bob;
            uint256 bal = shares.balanceOf(who);
            if (bal == 0) continue;
            uint256 amount = bound(seed >> 8, 1, bal);
            uint256 slice = (t.melting() + t.permanentFloor()) * amount / t.countingSupply();
            vm.prank(who);
            try t.handBack(amount) returns (uint256 paid) {
                assertLe(paid, slice);
                totalPaid += paid;
            } catch {}
        }
        // the 4% an exit leaves goes to those who remain, so later exits recover some of it; nobody gets past the floor
        assertLe(totalPaid + t.feesOwed(), M, "all exits and the platform's part together cannot pass the floor");
        assertLe(totalPaid, M * 99 / 100, "and the platform's 1% of every slice is never paid out");
        assertEq(t.spendable(), S);
        assertEq(usd.balanceOf(address(t)), _buckets());
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_theDailyReleaseDoesNotDependOnHowOftenItIsAsked(uint256 raised, uint256 seed, uint8 count)
        public
    {
        raised = bound(raised, 1_000_000, 1e21);
        uint256 n = bound(count, 1, 12);
        _sale(raised);
        uint256 start = _now();
        uint256 snapshot = vm.snapshotState();
        // asked at n moments inside the 14 day window
        uint256 time = start;
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            time += seed % (14 days / n + 1);
            vm.warp(time);
            t.release();
        }
        uint256 oftenSpendable = t.spendable();
        vm.revertToState(snapshot);
        vm.warp(time);
        t.release(); // asked once, at the end
        assertApproxEqAbs(
            oftenSpendable, t.spendable(), n + 1, "the same release, up to one unit of rounding per request"
        );
        assertLe(t.spendable() - raised * 15 / 75, raised * 60 / 75, "never more than the floor");
        assertEq(t.spendable() + t.melting(), raised);
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_theFounderCanNeverSpendMoreThanSpendablePlusWhatIsOwed(
        uint256 raised,
        uint256 elapsed,
        uint256 ask
    ) public {
        raised = bound(raised, 1_000_000, 1e21);
        elapsed = bound(elapsed, 0, 300 days);
        _sale(raised);
        _runFor(elapsed);
        uint256 available = t.spendable() + t.pendingRelease();
        uint256 floorBefore = t.melting() - t.pendingRelease();
        ask = bound(ask, 0, available * 2 + 1);
        vm.prank(founder);
        if (ask == 0) {
            vm.expectRevert(Treasury.BadInput.selector);
        } else if (ask > available) {
            vm.expectRevert();
        }
        t.spend(carol, ask);
        assertEq(usd.balanceOf(carol), ask > available ? 0 : ask);
        assertEq(t.melting(), floorBefore, "the floor is untouched by spending");
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_giftsAfterThePoolNeverPassOnePercentInAnyThirtyDays(uint256 seed, uint8 count) public {
        _openPool();
        uint256 n = bound(count, 1, 30);
        uint256[] memory at = new uint256[](n);
        uint256[] memory amt = new uint256[](n);
        uint256 accepted;
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(_now() + seed % (6 days));
            uint256 a = bound(seed >> 32, 1, 6_000_000 * SHARE);
            vm.prank(founder);
            try t.giveShares(address(uint160(0x7000 + i)), a) {
                at[accepted] = _now();
                amt[accepted] = a;
                accepted++;
            } catch {}
        }
        for (uint256 i; i < accepted; ++i) {
            uint256 sum;
            for (uint256 j; j <= i; ++j) {
                if (at[j] + 30 days > at[i]) sum += amt[j];
            }
            assertLe(sum, 10_000_000 * SHARE);
        }
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzz_anAgentNeverPassesItsDailyDollarCapInAnyTwentyFourHours(uint256 seed, uint8 count) public {
        _sale(7500 * DOLLAR);
        vm.prank(founder);
        t.setAgent(agent, uint128(10 * DOLLAR), 0);
        uint256 n = bound(count, 1, 40);
        uint256[] memory at = new uint256[](n);
        uint256[] memory amt = new uint256[](n);
        uint256 accepted;
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(_now() + seed % (7 hours));
            uint256 a = bound(seed >> 32, 1, 6 * DOLLAR);
            vm.prank(agent);
            try t.spend(carol, a) {
                at[accepted] = _now();
                amt[accepted] = a;
                accepted++;
            } catch {}
        }
        uint256 total;
        for (uint256 i; i < accepted; ++i) {
            uint256 sum;
            for (uint256 j; j <= i; ++j) {
                if (at[j] + 1 days > at[i]) sum += amt[j];
            }
            assertLe(sum, 10 * DOLLAR);
            total += amt[i];
        }
        assertEq(usd.balanceOf(carol), total);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_blendingSalesKeepsTheClockBetweenTheOldRemainderAndAYear(
        uint256 first,
        uint256 second,
        uint256 gap
    ) public {
        first = bound(first, 1_000_000, 1e20);
        second = bound(second, 1_000_000, 1e20);
        gap = bound(gap, 0, 12 days);
        _sale(first);
        vm.warp(_now() + gap);
        t.release();
        uint256 old = t.meltRemaining();
        uint256 oldMoney = t.melting();
        _arrive(second);
        t.settle(second);
        assertGe(t.meltRemaining(), old);
        assertLe(t.meltRemaining(), 365 days);
        assertEq(t.melting(), oldMoney + second - second * 15 / 75);
        assertEq(usd.balanceOf(address(t)), _buckets());
    }
}
