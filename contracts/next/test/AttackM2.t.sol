// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./helpers/Base.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {ShareToken} from "../src/ShareToken.sol";
import {Vester} from "../src/Vester.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {IShares, IVester} from "../src/Interfaces.sol";
import {IQuoteHook} from "./mocks/QuoteToken.sol";

/// @notice Hostile-user tests for milestone 2 (money, caps, exits), written by someone who did not write the contracts. A test named
/// `test_defect_*` states what SHOULD hold and fails today; every other test is an attack that is expected to fail (the
/// contracts hold) and passes for that reason.
contract AttackM2Test is Base {
    // =========================================================================================================
    // 1. Fee evasion by exiting in pieces ("a burn between two exits", "1-unit exits repeated")
    // =========================================================================================================

    /// @dev One holder exits 400M Shares in 400 pieces instead of one. The plan says 4 of the 5 percent fee stays "for
    /// those who remain", but it also lifts the floor per Share of the leaver's own remaining Shares, so the leaver gets
    /// back part of their own fee. Returns what bob and the platform get from one exit and from 400, and what alice, the
    /// one holder left, gets afterwards.
    function _exitInPieces()
        internal
        returns (uint256 single, uint256 pieces, uint256 aliceSingle, uint256 alicePieces)
    {
        _world();
        uint256 snap = vm.snapshotState();
        single = _handBack(bob, 400_000_000 * SHARE);
        aliceSingle = _handBack(alice, 100_000_000 * SHARE);
        vm.revertToState(snap);
        for (uint256 i; i < 400; ++i) {
            pieces += _handBack(bob, 1_000_000 * SHARE);
        }
        alicePieces = _handBack(alice, 100_000_000 * SHARE);
        emit log_named_uint("bob, one exit        ", single);
        emit log_named_uint("bob, 400 exits       ", pieces);
        emit log_named_uint("alice after one exit ", aliceSingle);
        emit log_named_uint("alice after 400 exits", alicePieces);
    }

    /// @dev OWNER DECISION PENDING (the review's "the 4% that stays also lifts the leaver's own floor"). Every fix changes a
    /// money rule of the plan (the whole slice leaves and the fee is paid out, so nothing "stays for those who remain"; or
    /// the fee is burned or goes to the platform), so it is not made here. This test pins what the plan's rule does today
    /// so any change, a fix or a worse leak, shows: a holder of 80% exiting in 400 pieces is paid 4,670.84 instead of
    /// 4,560.00 (+2.43%, and never past the 0.95/0.96 limit of the floor) and the one holder left is paid 1,215.99 instead of 1,322.40 (-8.0%).
    function test_openDecision_exitingInPiecesPaysALargeHolderMoreThanOneExit() public {
        (uint256 single, uint256 pieces, uint256 aliceSingle, uint256 alicePieces) = _exitInPieces();
        assertGt(pieces, single, "the leak is there (if this fails, the exit rule changed: update the report)");
        assertLt(pieces * 1000, single * 1030, "the leak is more than the measured 2.43 percent");
        assertLt(alicePieces, aliceSingle, "the holder left behind is paid less");
        assertGt(alicePieces * 100, aliceSingle * 90, "the holder left behind loses more than the measured 8 percent");
    }

    /// @dev The property the review wants: pieces add up to no more than one exit and those who remain keep the 4%. Skipped
    /// until the owner decides how the fee should work; the pin above must then be turned round.
    function test_defect_exitingInPiecesPaysMoreThanOneExit() public {
        vm.skip(true, "owner decision pending: see test_openDecision_exitingInPiecesPaysALargeHolderMoreThanOneExit");
        (uint256 single, uint256 pieces, uint256 aliceSingle, uint256 alicePieces) = _exitInPieces();
        assertLe(pieces, single + 400, "the pieces pay the leaver more than the single exit");
        assertGe(alicePieces + 400, aliceSingle, "those who remain lose part of the 4% that was meant to stay for them");
    }

    /// Pieces so small that rounding dominates never beat one exit (the rounding all goes against the leaver).
    function testFuzz_attack_tinyExitsNeverBeatOneExit(uint8 count, uint64 chunkSeed) public {
        _world();
        uint256 n = bound(count, 2, 120);
        uint256 chunk = bound(chunkSeed, 1, 3_000_000_000_000_000_000_000); // up to 3,000 Shares
        uint256 snap = vm.snapshotState();
        uint256 single;
        vm.prank(alice);
        try t.handBack(n * chunk) returns (uint256 p) {
            single = p;
        } catch {}
        vm.revertToState(snap);
        uint256 pieces;
        t.release();
        for (uint256 i; i < n; ++i) {
            uint256 slice = (t.melting() + t.permanentFloor()) * chunk / t.countingSupply();
            vm.prank(alice);
            try t.handBack(chunk) returns (uint256 p) {
                pieces += p;
                // the fee is rounded up against the leaver, every time
                assertLe(p + (slice * 500 + 9999) / 10_000, slice, "a fee rounded down in the leaver's favour");
            } catch {}
        }
        // the staying 4% is worth at most 4% * f^2 / 2 of the floor to the leaver; allow double that plus one unit per piece
        uint256 counting = 500_000_000 * SHARE;
        uint256 f2 = (n * chunk) * (n * chunk) / counting; // Shares^2 / counting
        uint256 bound_ = (M * f2 / counting) * 4 / 100 + n;
        assertLe(pieces, single + bound_);
    }

    // =========================================================================================================
    // 1b. Released Shares that nobody has pressed "claim" for
    // =========================================================================================================

    /// @dev The plan (section 4) leaves out "Shares not yet released". The Treasury leaves out everything the Vester
    /// holds, which includes Shares that have already been released and only wait for someone to press `claim` (anyone may,
    /// for anyone). So the price of an exit depends on whether a stranger pressed a button that moves nothing but the
    /// beneficiary's own Shares into their own hands. A holder who exits just before the press is paid more per Share than
    /// one who exits just after, and whoever holds the unclaimed Shares (the founder, or anyone given Shares before the
    /// pool) can choose which side of the press the others land on.
    function test_defect_theExitPriceDependsOnWhetherReleasedSharesWereClaimed() public {
        _world();
        _runFor(180 days);
        assertGt(v.claimable(founder), 90_000_000 * SHARE, "about half the founder's Shares are released and unclaimed");
        uint256 snap = vm.snapshotState();
        uint256 beforePress = _handBack(alice, 100_000_000 * SHARE);
        vm.revertToState(snap);
        v.claim(founder); // a stranger presses it; no money and nobody's holdings change but the founder's own Shares
        uint256 afterPress = _handBack(alice, 100_000_000 * SHARE);
        emit log_named_uint("alice paid before the press", beforePress);
        emit log_named_uint("alice paid after the press ", afterPress);
        assertApproxEqRel(beforePress, afterPress, 1e15, "the price moved because released Shares were claimed");
    }

    /// @dev Who pays for the press. The founder and an accomplice who holds 80% of the counting Shares arrange the order:
    /// the accomplice exits first (while the founder's released Shares are still in the Vester), then the founder claims
    /// and exits. Against the order where the claim comes first, the pair is paid more and the one honest holder (20%)
    /// is paid less. The honest holder's loss is asserted to stay under 1%.
    function test_defect_theFounderChoosesWhichSideOfThePressTheOtherHoldersLandOn() public {
        _world();
        _runFor(180 days);
        vm.prank(founder);
        shares.approve(address(t), type(uint256).max);
        uint256 snap = vm.snapshotState();

        // the order the founder prefers: the accomplice (bob) first, then the claim and the founder, then alice
        uint256 pairA = _handBack(bob, 400_000_000 * SHARE);
        v.claim(founder);
        pairA += _handBack(founder, shares.balanceOf(founder));
        uint256 aliceA = _handBack(alice, 100_000_000 * SHARE);

        vm.revertToState(snap);
        // the order where the claim is pressed first
        v.claim(founder);
        uint256 pairB = _handBack(bob, 400_000_000 * SHARE);
        pairB += _handBack(founder, shares.balanceOf(founder));
        uint256 aliceB = _handBack(alice, 100_000_000 * SHARE);

        emit log_named_uint("founder + accomplice, accomplice first", pairA);
        emit log_named_uint("founder + accomplice, claim first     ", pairB);
        emit log_named_uint("honest holder, accomplice first       ", aliceA);
        emit log_named_uint("honest holder, claim first            ", aliceB);
        assertGe(aliceA * 100, aliceB * 99, "the honest holder pays for the order the founder picked");
    }

    // =========================================================================================================
    // 2. The floor leaks through post-pool gifts (the work pot as a siphon)
    // =========================================================================================================

    /// @dev A founder who wants the "never melts" Share revenue money out: every 33 days he gives 1% of all Shares (the
    /// cap) to a fresh wallet, which hands them straight back. Nothing is vested, nobody votes, and the only cost is the
    /// 5% fee. Returns the permanent floor at the start and now, and what the fresh wallets took.
    function _drainThroughFreshWallets()
        internal
        returns (uint256 permanentStart, uint256 permanentNow, uint256 taken)
    {
        _world();
        usd.mint(carol, 100_000 * DOLLAR);
        vm.startPrank(carol);
        usd.approve(address(t), type(uint256).max);
        t.shareRevenue(100_000 * DOLLAR); // the project pays Share revenue into the floor that never melts
        vm.stopPrank();
        permanentStart = t.permanentFloor();
        for (uint256 i; i < 11; ++i) {
            vm.warp(_now() + 33 days);
            vm.prank(founder);
            t.checkIn();
            address sybil = makeAddr(string.concat("sybil", vm.toString(i)));
            uint256 gift = shares.totalSupply() / 100; // exactly the 1%-of-all-Shares cap
            vm.prank(founder);
            t.giveShares(sybil, gift);
            vm.startPrank(sybil);
            shares.approve(address(t), type(uint256).max);
            taken += t.handBack(shares.balanceOf(sybil));
            vm.stopPrank();
        }
        permanentNow = t.permanentFloor();
        emit log_named_uint("dollars the fresh wallets took in 11 gifts", taken);
        emit log_named_uint("permanent floor at the start          ", permanentStart);
        emit log_named_uint("permanent floor now                   ", permanentNow);
    }

    /// @dev OWNER DECISION PENDING (the review's "gifts let the founder drain the floor through fresh wallets"). Every fix
    /// changes a rule of the plan's section 3 ("Shares given after the pool opens are free at once"): post-pool gifts also
    /// vest, or the cap is measured on the Shares people hold, or gifted Shares cannot be handed back for a while. None is
    /// made here. This test pins what the plan's rule does today: in a year of such gifts the wallets take between a tenth
    /// and a quarter of the 100,000 dollars of Share revenue (measured here: 15.3 percent, 15,830 dollars; the review measured about 18 percent on the code before this round's fixes).
    function test_openDecision_postPoolGiftsToFreshWalletsTakeAShareOfTheFloor() public {
        (uint256 start, uint256 now_, uint256 taken) = _drainThroughFreshWallets();
        assertLt(now_ * 100, start * 90, "the drain is there (if this fails, the gift rule changed: update the report)");
        assertGt(now_ * 100, start * 75, "the drain is more than the measured 15 percent");
        assertGt(taken, 0);
    }

    /// @dev The property the review wants: gifts that are handed straight back take at most a tenth of the money that never
    /// melts. Skipped until the owner decides; the pin above must then be turned round.
    function test_defect_giftsLetTheFounderDrainTheFloorThroughFreshWallets() public {
        vm.skip(true, "owner decision pending: see test_openDecision_postPoolGiftsToFreshWalletsTakeAShareOfTheFloor");
        (uint256 start, uint256 now_,) = _drainThroughFreshWallets();
        assertGe(now_ * 100, start * 90, "gifts took more than a tenth of the money that never melts");
    }

    // =========================================================================================================
    // 3. A setting the Launcher accepts that makes every future sale unsplittable
    // =========================================================================================================

    // =========================================================================================================
    // 4. Exits sandwiched by every cheap lever: nobody nets more than an immediate exit
    // =========================================================================================================

    /// @dev A holder with 20% of the counting Shares tries, before exiting, any of: Share revenue, a donation that is
    /// then settled, calling the release after time passes, a top-up, a claim of the founder's vested Shares. Whatever it
    /// does, its dollars out minus dollars in never exceed what an exit at the same moment would have paid.
    function testFuzz_attack_sandwichingYourOwnExitNeverPays(uint8 op, uint32 amount, uint32 dt) public {
        _world();
        vm.warp(_now() + bound(dt, 0, 200 days));
        vm.prank(founder);
        t.checkIn();
        uint256 snap = vm.snapshotState();
        uint256 baseline = _handBack(alice, 100_000_000 * SHARE);
        vm.revertToState(snap);

        uint256 spent;
        uint256 x = bound(amount, 1, 2_000_000) * DOLLAR / 100;
        usd.mint(alice, 10 * x);
        vm.startPrank(alice);
        usd.approve(address(t), type(uint256).max);
        uint256 o = op % 5;
        if (o == 0) {
            t.shareRevenue(x);
            spent = x;
        } else if (o == 1) {
            usd.transfer(address(t), x);
            spent = x;
            t.settle(x);
        } else if (o == 2) {
            t.release();
        } else if (o == 3) {
            t.topUp(x);
            spent = x;
        } else {
            v.claim(founder); // dilutes the counting supply
        }
        uint256 got = t.handBack(100_000_000 * SHARE);
        vm.stopPrank();
        assertEq(shares.totalSupply(), SUPPLY - 100_000_000 * SHARE, "the handed-back Shares were not burned");
        assertLe(got, baseline + spent, "dollars out minus dollars in beat an exit at the same moment");
        if (spent > 0) assertLe(got + spent / 4, baseline + spent + 1, "a deposit came back above 76 percent");
    }

    // =========================================================================================================
    // 5. Counting supply: Shares sent to the Treasury, the Vester, the Launcher or burned never help the sender
    // =========================================================================================================

    function testFuzz_attack_changingTheCountingSupplyNeverPaysTheSender(uint8 where, uint64 amount) public {
        _world();
        uint256 snap = vm.snapshotState();
        uint256 aliceBase = _handBack(alice, 100_000_000 * SHARE);
        uint256 bobBase = _handBack(bob, 400_000_000 * SHARE);
        vm.revertToState(snap);

        uint256 a = bound(amount, 1, 100_000_000 * SHARE - 1);
        vm.startPrank(alice);
        uint256 w = where % 4;
        if (w == 0) shares.transfer(address(t), a);
        else if (w == 1) shares.transfer(address(v), a);
        else if (w == 2) shares.burn(a);
        else shares.transfer(address(launcher), a);
        uint256 aliceGot = t.handBack(shares.balanceOf(alice)); // hands back what she still holds
        vm.stopPrank();
        uint256 bobGot = _handBack(bob, 400_000_000 * SHARE);
        // the sender is never better off, and the others are never worse off, whatever the Shares did
        assertLe(aliceGot, aliceBase, "the sender gained by moving or burning Shares");
        // Shares burned or sent to the Treasury leave the count, so the others never lose. Shares sent to the Vester
        // by hand or to the Launcher still count and can never exit, so what the sender would have paid in fee on
        // them is missing from the floor: the others' price per Share is unchanged, they only miss that fee.
        if (w == 0 || w == 2) assertGe(bobGot + 1, bobBase, "the others lost");
    }

    // =========================================================================================================
    // 6. The check-in window cannot be griefed by strangers
    // =========================================================================================================

    /// @dev One world where a stranger calls `release()` at attacker-chosen seconds all year, one where nobody does. The
    /// founder checks in every 30 days in both, so the 14-day window lapses for half of every month: a stranger who could
    /// renew the window, or make it lapse sooner, would show up as a different amount. What the founder can spend differs
    /// by at most one unit per call (rounding).
    function testFuzz_attack_aStrangerCannotMakeTheFounderLoseRelease(uint32 s1, uint32 s2, uint32 s3, uint8 mod)
        public
    {
        _sale(7500 * DOLLAR);
        uint256 start = _now();
        uint256 snap = vm.snapshotState();

        uint256 calls;
        uint256 withStranger;
        {
            uint256[3] memory seeds = [uint256(s1), uint256(s2), uint256(s3)];
            for (uint256 day = 1; day <= 400; ++day) {
                vm.warp(start + day * 1 days);
                if (day % 30 == 0) {
                    vm.prank(founder);
                    t.checkIn();
                }
                // a stranger's call at the boundary of the 14-day window and at random seconds
                uint256 last = start + day * 1 days;
                for (uint256 k; k < 3; ++k) {
                    uint256 when_ = start + day * 1 days + (seeds[k] % (1 days));
                    if ((seeds[k] + day + mod) % 7 == 0 && when_ >= last) {
                        last = when_;
                        vm.warp(when_);
                        vm.prank(makeAddr("stranger"));
                        t.release();
                        ++calls;
                    }
                }
            }
            vm.warp(start + 401 days);
            vm.prank(founder);
            t.checkIn();
            t.release();
            withStranger = t.spendable() + t.melting();
        }
        uint256 spendWith = t.spendable();

        vm.revertToState(snap);
        for (uint256 day = 1; day <= 400; ++day) {
            vm.warp(start + day * 1 days);
            if (day % 30 == 0) {
                vm.prank(founder);
                t.checkIn();
            }
        }
        vm.warp(start + 401 days);
        vm.prank(founder);
        t.checkIn();
        t.release();
        assertEq(t.spendable() + t.melting(), withStranger, "no money is created or lost");
        assertLe(t.spendable() > spendWith ? t.spendable() - spendWith : spendWith - t.spendable(), calls + 2);
    }

    // =========================================================================================================
    // 7. Gift cap and agent caps, at every boundary second
    // =========================================================================================================

    /// @dev Calls are placed on and around the edges of the 3-day parts the cap is kept in. Every accepted gift is
    /// recorded here with its second; no 30-day stretch may hold more than 1% of the Shares (10M).
    function testFuzz_attack_giftsAtPartBoundariesNeverPassTheMonthlyCap(uint256 seed) public {
        _sale(7500 * DOLLAR);
        uint256[] memory times = new uint256[](60);
        uint256[] memory amts = new uint256[](60);
        uint256 n;
        uint256 cap = 10_000_000 * SHARE;
        for (uint256 i; i < 60; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 mode = seed % 6;
            uint256 now_ = _now();
            uint256 nextEdge = (now_ / 3 days + 1) * 3 days; // next part boundary
            if (mode == 0) vm.warp(nextEdge - 1);
            else if (mode == 1) vm.warp(nextEdge);
            else if (mode == 2) vm.warp(nextEdge + 1);
            else if (mode == 3) vm.warp(now_ + 3 days);
            else if (mode == 4) vm.warp(now_ + 30 days);
            else vm.warp(now_ + (seed >> 8) % 12 days);
            if (i % 5 == 0) {
                vm.prank(founder);
                t.checkIn();
            }
            uint256 amount = ((seed >> 40) % 12) * 1_000_000 * SHARE / 10 + 1; // 0.0 to 1.1 million
            if (seed % 3 == 0) amount = cap - t.giftsUsed(); // the largest the contract should accept
            if (amount == 0) continue;
            address to = address(uint160(0xA000 + (seed >> 90) % 5)); // a few recipients, some made contracts below
            if (to.code.length == 0 && (seed >> 100) % 2 == 0) vm.etch(to, hex"00");
            vm.prank(founder);
            try t.giveShares(to, amount) {
                times[n] = _now();
                amts[n] = amount;
                ++n;
            } catch {}
        }
        for (uint256 i; i < n; ++i) {
            uint256 sum;
            for (uint256 j; j <= i; ++j) {
                if (times[j] + 30 days > times[i]) sum += amts[j];
            }
            assertLe(sum, cap, "a 30-day stretch holds more than 1% of the Shares");
        }
        // and the cap is not stuck: 34 days of quiet frees all of it
        vm.warp(_now() + 34 days);
        assertEq(t.giftsUsed(), 0);
    }

    /// @dev The two extremes of the ring, by hand: a full month's gift made in the last second of a 3-day part is still
    /// counted 30 days later less one second (so nothing is let through early), and is free again within 33 days (so the
    /// cap does not stick).
    function test_attack_theMonthlyCapNeverExpiresEarlyAndNeverSticks() public {
        _sale(7500 * DOLLAR);
        uint256 edge = (_now() / 3 days + 2) * 3 days; // the start of a part, far enough ahead
        vm.warp(edge - 1); // the last second of the part before it
        uint256 cap = shares.totalSupply() / 100;
        vm.prank(founder);
        t.giveShares(alice, cap);
        uint256 usedAt = _now();
        vm.warp(usedAt + 30 days - 1);
        vm.prank(founder);
        vm.expectRevert();
        t.giveShares(bob, 1);
        vm.warp(usedAt + 33 days);
        vm.prank(founder);
        t.giveShares(bob, 1);
        // and from the first second of a part
        vm.warp((_now() / 3 days + 1) * 3 days);
        uint256 free = shares.totalSupply() / 100 - t.giftsUsed();
        vm.prank(founder);
        t.giveShares(carol, free);
        usedAt = _now();
        vm.warp(usedAt + 30 days - 1);
        vm.prank(founder);
        vm.expectRevert();
        t.giveShares(bob, 1);
        vm.warp(usedAt + 33 days);
        assertEq(t.giftsUsed(), 0);
    }

    function testFuzz_attack_agentCapsAtDayBoundaries(uint256 seed) public {
        _sale(7500 * DOLLAR);
        vm.prank(founder);
        t.setAgent(agent, uint128(10 * DOLLAR), uint128(1_000_000 * SHARE));
        _arrive(75_000 * DOLLAR); // plenty to spend: 15,000 dollars more land in `spendable`
        t.settle(75_000 * DOLLAR);
        uint256[] memory times = new uint256[](80);
        uint256[] memory amts = new uint256[](80);
        uint256 n;
        for (uint256 i; i < 80; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 now_ = _now();
            uint256 nextEdge = (now_ / 4 hours + 1) * 4 hours;
            uint256 mode = seed % 6;
            if (mode == 0) vm.warp(nextEdge - 1);
            else if (mode == 1) vm.warp(nextEdge);
            else if (mode == 2) vm.warp(nextEdge + 1);
            else if (mode == 3) vm.warp(now_ + 1 days);
            else if (mode == 4) vm.warp(now_ + 24 hours + 1);
            else vm.warp(now_ + (seed >> 8) % 9 hours);
            if (i % 4 == 0) {
                vm.prank(founder);
                t.checkIn();
            }
            uint256 amount = ((seed >> 40) % 11) * DOLLAR + 1;
            vm.prank(agent);
            try t.spend(address(0xBEEF), amount) {
                times[n] = _now();
                amts[n] = amount;
                ++n;
            } catch {}
        }
        for (uint256 i; i < n; ++i) {
            uint256 sum;
            for (uint256 j; j <= i; ++j) {
                if (times[j] + 1 days > times[i]) sum += amts[j];
            }
            assertLe(sum, 10 * DOLLAR, "an agent spent more than its daily cap in 24 hours");
        }
    }

    // =========================================================================================================
    // 8. Hostile quote token: a call-back tries every door
    // =========================================================================================================

    /// @dev The token calls back into the Treasury around every transfer (before and after balances move) and tries every
    /// state-changing function as the stranger, the holder and the founder's own address. None may work, and the books
    /// still add up.
    function test_attack_aCallBackTriesEveryDoor() public {
        _world();
        Prober p = new Prober(t, address(shares));
        usd.mint(address(p), 1000 * DOLLAR);
        usd.setHooked(address(p), true);
        vm.startPrank(address(p));
        usd.approve(address(t), type(uint256).max);
        t.shareRevenue(10 * DOLLAR);
        t.topUp(10 * DOLLAR);
        vm.stopPrank();
        assertGt(p.tries(), 0, "the call-back ran");
        assertEq(p.worked(), 0, "no door opened from inside a transfer");
        assertGe(usd.balanceOf(address(t)), _buckets());
        // the same, from the receiving side of an exit and of a spend
        Prober p2 = new Prober(t, address(shares));
        vm.prank(alice);
        shares.transfer(address(p2), 1_000_000 * SHARE);
        p2.approveTreasury();
        usd.setHooked(address(p2), true);
        p2.exit(500_000 * SHARE);
        assertGt(p2.tries(), 0, "the call-back on the receiving side ran");
        assertEq(p2.worked(), 0);
        assertGe(usd.balanceOf(address(t)), _buckets());
    }

    // =========================================================================================================
    // 9. Settle, release and exit across a year and for ever
    // =========================================================================================================

    function test_attack_noOverflowOrUnderflowAtAYearAndBeyond() public {
        _world();
        usd.mint(carol, 1000 * DOLLAR);
        vm.startPrank(carol);
        usd.approve(address(t), type(uint256).max);
        t.shareRevenue(1000 * DOLLAR);
        vm.stopPrank();
        for (uint256 i; i < 1100; ++i) {
            // three years of check-ins every 13 days, plus a settle of a little fresh money now and then
            vm.warp(_now() + 1 days);
            if (i % 13 == 0) {
                vm.prank(founder);
                t.checkIn();
            }
            if (i % 97 == 0) {
                usd.mint(address(t), 1000 * DOLLAR);
                t.settle(1000 * DOLLAR);
            }
            assertLe(t.meltRemaining(), 365 days);
            assertEq(usd.balanceOf(address(t)), _buckets());
        }
        // 80 years of silence: no revert, and nothing is released while nobody checks in
        vm.warp(_now() + 29_000 days);
        uint256 spendableBefore = t.spendable();
        uint256 meltingBefore = t.melting();
        t.release();
        assertEq(t.melting() + t.spendable(), meltingBefore + spendableBefore);
        vm.prank(founder);
        t.checkIn();
        vm.warp(_now() + 400 days);
        vm.prank(founder);
        t.checkIn();
        t.release();
        assertEq(usd.balanceOf(address(t)), _buckets());
        // the holders can still leave after all of it
        assertGt(_handBack(alice, 100_000_000 * SHARE), 0);
        assertGt(_handBack(bob, 400_000_000 * SHARE), 0);
        assertGe(usd.balanceOf(address(t)), _buckets());
    }

    // =========================================================================================================
    // 10. Vester: early, twice, someone else's, after the clock, new grants
    // =========================================================================================================

    // =========================================================================================================
    // 11. Launcher: id squatting, double launch, pre-funded addresses
    // =========================================================================================================

    // =========================================================================================================
    // 12. Dollars: dust donation then settle, and exit right after
    // =========================================================================================================

    /// A stranger's dust settle can be the first settle (it starts the check-in clock and opens the exit door early)
    /// but cannot take anything: the holder's exit then pays only what the floor holds.
    function test_attack_aDustSettleOpensTheDoorButPaysNothingExtra() public {
        _buy(alice, 100_000_000 * SHARE);
        _approveAll(alice);
        _openPool();
        usd.mint(address(t), 1);
        vm.prank(makeAddr("stranger"));
        t.settle(1);
        assertTrue(t.settled());
        _closeSale();
        vm.prank(alice);
        vm.expectRevert(Treasury.NothingToPay.selector);
        t.handBack(1_000_000 * SHARE); // there is nothing in the floor to pay
        assertGe(usd.balanceOf(address(t)), _buckets());
    }
}

/// @notice Launcher, Vester and set-up attacks (split from the money tests to keep each contract under the size limit).
contract AttackM2LaunchTest is Base {
    /// @dev The review found that `Launcher._set` and `Treasury.initialize` accepted any nonzero 15/60 parts while `settle`
    /// added the two as uint16: parts 40000 and 40000 passed every check and then made `settle` revert for ever, with the
    /// sale money stuck. Both now refuse a part above 10,000, so the sum can never overflow (20,000 at most).
    function test_attack_aSplitWhoseSumOverflowsIsRefusedAtTheLauncherAndAtTheTreasury() public {
        Launcher.Settings memory s = _settings();
        s.spendableParts = 40_000;
        s.floorParts = 40_000;
        vm.expectRevert(Launcher.BadSettings.selector);
        _deployLauncher(admin, s);
        vm.prank(admin);
        vm.expectRevert(Launcher.BadSettings.selector);
        launcher.setSettings(s);
    }

    function test_attack_vesterClaimsEarlyTwiceAndForOthers() public {
        // before the clock: nothing, however often
        assertEq(v.claim(founder), 0);
        _sale(7500 * DOLLAR); // pool open: clock starts
        assertEq(v.claim(founder), 0, "same second as the start");
        vm.warp(_now() + 1 days);
        uint256 first = v.claim(founder); // a stranger triggers it
        assertEq(shares.balanceOf(founder), first);
        assertEq(first, 200_000_000 * SHARE / 365);
        assertEq(v.claim(founder), 0, "twice in the same second");
        vm.warp(_now() + 1 days);
        assertEq(v.claim(founder) + first, 2 * 200_000_000 * SHARE / 365, "no rounding loss over two claims");
        // grants are closed
        vm.expectRevert(Vester.NotAllowed.selector);
        v.grant(alice, 1);
        vm.prank(address(t));
        vm.expectRevert(Vester.WrongPhase.selector);
        v.grant(alice, 1);
        // the founder cannot restart or move the clock
        vm.prank(founder);
        vm.expectRevert(Vester.NotAllowed.selector);
        v.startNow();
        // far past the end: exactly the grant and no more
        vm.warp(_now() + 4000 days);
        v.claim(founder);
        assertEq(shares.balanceOf(founder), 200_000_000 * SHARE);
        assertEq(v.claim(founder), 0);
        assertEq(shares.balanceOf(address(v)), 0);
    }

    function test_attack_launcherIdsAreTheFoundersOwn() public {
        address attacker = makeAddr("attacker");
        bytes32 h = launcher.settingsHash();
        // the attacker takes the id first; the founder's id is unaffected
        vm.prank(attacker);
        launcher.launch(keccak256("p2"), "A", "A", h);
        vm.prank(founder);
        launcher.launch(keccak256("p2"), "B", "B", h);
        assertTrue(
            launcher.project(founder, keccak256("p2")).treasury != launcher.project(attacker, keccak256("p2")).treasury
        );
        // the same founder cannot start two projects with one id
        vm.prank(founder);
        vm.expectRevert(Launcher.ProjectExists.selector);
        launcher.launch(keccak256("p2"), "C", "C", h);
        // nobody can launch "as" the founder: the key is the caller
        assertEq(launcher.project(attacker, PROJECT).treasury, address(0));
    }

    function test_attack_aPreFundedPredictedAddressChangesNothing() public {
        bytes32 id = keccak256("predicted");
        bytes32 key = launcher.keyOf(founder, id);
        address predictedT = Clones.predictDeterministicAddress(
            launcher.treasuryImpl(), keccak256(abi.encode(key, "treasury")), address(launcher)
        );
        address predictedV = Clones.predictDeterministicAddress(
            launcher.vesterImpl(), keccak256(abi.encode(key, "vester")), address(launcher)
        );
        usd.mint(predictedT, 1000 * DOLLAR);
        vm.deal(predictedT, 1 ether);
        vm.deal(predictedV, 1 ether);
        (address s, address tr, address ve) = _launch(founder, id);
        assertEq(tr, predictedT);
        assertEq(ve, predictedV);
        // the pre-funded dollars are a donation: no bucket, and a settle (once a pool is proven) is the only way in
        assertEq(Treasury(tr).unaccounted(), 1000 * DOLLAR);
        assertEq(Treasury(tr).spendable() + Treasury(tr).melting(), 0);
        assertEq(ShareToken(s).totalSupply(), SUPPLY);
    }

    function test_attack_noOneCanInitialiseTheImplementationsOrTheClones() public {
        Treasury.Setup memory st;
        st.quote = IERC20(address(usd));
        st.shares = IShares(address(shares));
        st.vester = IVester(address(v));
        st.founder = address(this);
        st.platform = address(this);
        st.opener = address(this);
        st.salePath = address(this);
        st.exitFeeBps = 500;
        st.platformFeeBps = 100;
        st.spendableParts = 15;
        st.floorParts = 60;
        Treasury tImpl = Treasury(launcher.treasuryImpl());
        Vester vImpl = Vester(launcher.vesterImpl());
        ShareToken sImpl = ShareToken(launcher.shareImpl());
        vm.expectRevert(Treasury.BadSetup.selector);
        t.initialize(st);
        vm.expectRevert(Treasury.BadSetup.selector);
        tImpl.initialize(st);
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        v.initialize(IShares(address(shares)), address(this), address(this), address(this), 1);
        vm.expectRevert(Vester.AlreadyInitialized.selector);
        vImpl.initialize(IShares(address(shares)), address(this), address(this), address(this), 1);
        address[] memory to = new address[](1);
        uint256[] memory am = new uint256[](1);
        to[0] = address(this);
        am[0] = SUPPLY;
        vm.expectRevert(ShareToken.BadBirth.selector);
        shares.initialize("x", "x", to, am);
        vm.expectRevert(ShareToken.BadBirth.selector);
        sImpl.initialize("x", "x", to, am);
    }

    /// @dev The owner's rule for milestone 2 is "the Launcher must refuse to open a sale with no pool guard". The review
    /// found the stub took both the strategy and the hook from the caller, so a contract the founder wrote, answering with
    /// the strategy the founder named, passed. Now the strategy and the guard are the platform's, fixed at construction,
    /// and `openSale` takes only the project id: the old three-argument entry point does not exist, and a Launcher whose
    /// platform guard is not the guard for its strategy refuses (see `LauncherTest`).
    function test_attack_aFakeGuardNamedByTheFounderCannotPassTheLaunchersGuardCheck() public {
        address strategy = makeAddr("founders own strategy");
        FakeGuard fake = new FakeGuard(strategy);
        vm.prank(founder);
        (bool ok, bytes memory ret) = address(launcher)
            .call(abi.encodeWithSignature("openSale(bytes32,address,address)", PROJECT, strategy, address(fake)));
        assertFalse(ok, "no entry point takes a founder's guard");
        assertEq(ret.length, 0, "no function matches");
        assertTrue(launcher.strategy() != strategy);
        assertTrue(launcher.poolGuard() != address(fake));
    }

    /// @dev The admin can change the settings (the opener, the sale path, the quote token, the fees) in the block before a
    /// launch. The review's point: a founder's launch signed against the old settings must not land on the new ones.
    /// `launch` now takes the settings hash the founder saw. What stays true, and is documented until milestone 3 makes
    /// `opener` and `salePath` contracts the Launcher derives: a founder who reads the NEW settings and commits to them
    /// gets exactly those.
    function test_attack_theAdminCanChangeTheSettingsInTheBlockBeforeALaunch() public {
        bytes32 seen = launcher.settingsHash();
        Launcher.Settings memory s = _settings();
        s.opener = makeAddr("evil opener");
        s.exitFeeBps = 1000;
        vm.prank(admin);
        launcher.setSettings(s);
        vm.prank(founder);
        vm.expectRevert(Launcher.SettingsMoved.selector);
        launcher.launch(keccak256("late"), "Late", "LT", seen);
        (, address tr,) = _launch(founder, keccak256("late")); // the founder reads the new settings and commits to them
        assertEq(Treasury(tr).opener(), s.opener, "a founder who commits to the new settings gets them");
        assertEq(Treasury(tr).exitFeeBps(), 1000);
    }

    /// @dev Donated Shares make the reserve bigger but never the work pot: the founder cannot give them as work.
    function test_attack_donatedSharesAreReserveNotWorkPot() public {
        _world();
        vm.prank(alice);
        shares.transfer(address(t), 1_000_000 * SHARE);
        vm.prank(founder);
        t.giveShares(carol, 10_000_000 * SHARE);
        uint256 left = t.workPot();
        vm.warp(_now() + 40 days);
        vm.prank(founder);
        t.checkIn();
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Treasury.WorkPotShort.selector, left + 1, left));
        t.giveShares(carol, left + 1);
    }
}

/// @dev A "guard" any founder can write: it names whoever it was told to.
contract FakeGuard {
    address public authorized;

    constructor(address who) {
        authorized = who;
    }
}

/// @dev A token call-back that tries every Treasury function as the receiving or sending address.
contract Prober is IQuoteHook {
    Treasury internal immutable T;
    address internal immutable SH;
    uint256 public tries;
    uint256 public worked;
    bool internal inside;

    constructor(Treasury t_, address shares_) {
        (T, SH) = (t_, shares_);
    }

    function approveTreasury() external {
        (bool ok,) = SH.call(abi.encodeWithSignature("approve(address,uint256)", address(T), type(uint256).max));
        require(ok);
    }

    function exit(uint256 amount) external {
        T.handBack(amount);
    }

    function onQuoteTransfer(address, address, uint256, bool) external {
        if (inside) return;
        inside = true;
        bytes[11] memory calls = [
            abi.encodeCall(T.topUp, (1)),
            abi.encodeCall(T.shareRevenue, (1)),
            abi.encodeCall(T.settle, (1)),
            abi.encodeCall(T.spend, (address(this), 1)),
            abi.encodeCall(T.checkIn, ()),
            abi.encodeCall(T.release, ()),
            abi.encodeCall(T.handBack, (1)),
            abi.encodeCall(T.sweepFees, ()),
            abi.encodeCall(T.giveShares, (address(this), 1)),
            abi.encodeCall(T.markPoolOpen, ()),
            abi.encodeCall(T.releaseReserve, (address(this), 1))
        ];
        for (uint256 i; i < calls.length; ++i) {
            ++tries;
            (bool ok,) = address(T).call(calls[i]);
            if (ok) ++worked;
        }
        inside = false;
    }
}
