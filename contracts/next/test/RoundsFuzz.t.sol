// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Rounds} from "../src/Rounds.sol";

/// @notice The money paths of a backing round under random use: random asks (some lowered or withdrawn in the first 12 hours),
/// random lapses of the check-in, random refunds at random times. Every dollar asked ends with the backer, the project, the
/// platform or still in the Rounds; no refund pays more than the backer's own unreleased money less 5%; nobody's refund moves
/// when another backer leaves; every Share bought is held for its backer.
contract RoundsFuzzTest is RoundsBase {
    function _backers(uint256 n) internal returns (address[] memory list) {
        list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = makeAddr(string.concat("backer", vm.toString(i)));
        }
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_aRoundConservesEveryDollar_andEachRefundIsPersonalAndBounded(uint256 seed, uint8 count) public {
        uint256 n = 1 + count % 12;
        address[] memory b = _backers(n);
        _checkIn();
        // the round's price: anywhere in the founder's range, today's lowest price a quarter of the time
        uint256 price = uint256(keccak256(abi.encode(seed, "price")));
        price = price % 4 == 0 ? 3e15 : 2e13 + (price >> 2) % (3e15 - 2e13 + 1);
        uint256 id = _openRoundAt(price); // 10,000 for a single founder
        uint256 asked;
        uint256 paidIn; // every dollar the backers sent (lowered asks come back to them)
        for (uint256 i; i < n; ++i) {
            uint256 a = DOLLAR + uint256(keccak256(abi.encode(seed, i))) % (6000 * DOLLAR);
            _ask(id, b[i], a);
            asked += a;
            paidIn += a;
        }
        // some lower or withdraw in the first 12 hours
        vm.warp(_now() + uint256(keccak256(abi.encode(seed, "t0"))) % 12 hours);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i, "lower")));
            if (r % 4 != 0) continue;
            uint256 old = rd.positionOf(id, b[i]).ask;
            uint256 to = r % 8 == 0 ? 0 : DOLLAR + (r >> 8) % old;
            if (to >= old) continue;
            vm.prank(b[i]);
            rd.lower(id, to);
            asked -= old - to;
        }
        _close(id);
        uint256 accepted = rd.roundOf(id).accepted;
        assertEq(accepted, asked < 10_000 * DOLLAR ? asked : 10_000 * DOLLAR);
        uint256 spend0 = t.spendable(); // read before anyone is settled
        uint256 boughtTotal;
        for (uint256 i; i < n; ++i) {
            if (rd.positionOf(id, b[i]).ask == 0) continue;
            rd.settle(id, b[i]);
            boughtTotal += rd.positionOf(id, b[i]).bought;
            (uint256 total,) = v.heldGrants(id, b[i]);
            assertEq(total, rd.positionOf(id, b[i]).bought, "every Share bought is held for its backer");
        }
        assertLe(boughtTotal, accepted * price);
        assertGe(boughtTotal + n * price, accepted * price, "under one raw dollar's Shares of dust per backer");
        // time passes with random check-in lapses; random backers leave at random moments
        for (uint256 step; step < 6; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step, "time")));
            vm.warp(_now() + r % 40 days);
            if (r % 3 != 0) _checkIn();
            if (r % 5 == 0) rd.release(id);
            uint256 i = (r >> 64) % n;
            if (rd.positionOf(id, b[i]).held == 0) continue;
            // the refund's bound, worked out here from the rule, and everyone else's number before
            uint256 held = rd.positionOf(id, b[i]).held;
            uint256 e = rd.activeNow() - rd.roundOf(id).activeAtClose;
            if (e > 182 days) e = 182 days;
            uint256 unreleased = held - held * e / 182 days;
            uint256[] memory others = new uint256[](n);
            for (uint256 j; j < n; ++j) {
                others[j] = rd.refundable(id, b[j]);
            }
            vm.prank(b[i]);
            try rd.refund(id) returns (uint256 paid) {
                assertLe(paid, unreleased - (unreleased * 5 + 99) / 100, "never more than the own unreleased less 5%");
                assertEq(paid, others[i], "exactly what it said before");
                for (uint256 j; j < n; ++j) {
                    if (j != i) assertEq(rd.refundable(id, b[j]), others[j], "nobody else's number moved");
                }
            } catch (bytes memory err) {
                assertEq(bytes4(err), Rounds.NothingToRefund.selector);
            }
        }
        _live(200 days);
        rd.release(id);
        rd.sweepFees();
        // every dollar asked: with the backers (returned or refunded), the project, the platform, or still in the Rounds
        uint256 withBackers;
        for (uint256 i; i < n; ++i) {
            withBackers += usd.balanceOf(b[i]);
        }
        assertEq(spend0, 0, "the project had no other money");
        assertEq(
            withBackers + t.spendable() + usd.balanceOf(platform) + usd.balanceOf(rounds),
            paidIn,
            "every dollar sent is accounted for"
        );
        assertEq(usd.balanceOf(rounds), 0, "after 26 active weeks everything has left the Rounds");
        assertLe(
            usd.balanceOf(platform),
            accepted * 3 / 100 + accepted * 82 / 100 / 100 + 1,
            "the platform: 3, and 1 of refunds"
        );
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzz_theReleaseDoesNotDependOnHowOftenItIsAsked(uint256 amount, uint8 calls, uint32 span) public {
        amount = bound(amount, DOLLAR, 10_000 * DOLLAR);
        uint256 id = _round(alice, amount);
        uint256 end = _now() + bound(span, 1 days, 300 days);
        uint256 snap = vm.snapshotState();
        _live(end - _now());
        uint256 once = rd.release(id);
        vm.revertToState(snap);
        uint256 many;
        uint256 k = 1 + calls % 20;
        while (_now() < end) {
            uint256 step = (end - _now()) / k + 1;
            if (step > 10 days) step = 10 days;
            if (_now() + step > end) step = end - _now();
            vm.warp(_now() + step);
            _checkIn();
            many += rd.release(id);
        }
        assertApproxEqAbs(
            many, once, 30, "asked once or many times: the same money (rounding of a few raw units per call)"
        );
        assertLe(many, once);
    }
}
