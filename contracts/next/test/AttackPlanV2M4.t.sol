// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Platform} from "./helpers/Platform.sol";
import {IAuctionTest} from "./helpers/UniswapTest.sol";
import {Rounds} from "../src/Rounds.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice Plan version 2, milestone 4, from the attacker's side: backing rounds, the refund, the held Shares and the wind-down.
/// `test_fixed_*` was a defect the attacker found (it failed at 802c5d690) and passes since the fix. `test_pinned_*` is a defect
/// whose fix is the owner's decision: it pins today's measured effect. The `test_probe_*` tests are attacks the code withstood.
contract AttackPlanV2M4Test is RoundsBase {
    /// @dev FIXED (finding M4A-1). The plan: "After a market opens the refund continues for Shares still held for you; Shares YOU
    /// take out to sell end that part of it", and "nobody else ... changes your number". `Rounds.refund` covers only Shares not
    /// yet claimed, and `Vester.claimHeld(round, backer)` could be called by anyone: any stranger (the founder's bot, or a helper
    /// job that delivers Shares) could take a backer's released Shares out for them and so end their refund for those Shares,
    /// moving that money to the project (at 802c5d690: alice's refund fell from 6,634.34 to 3,362.61). Now only the backer may
    /// take out their own held Shares, and this test passes because the stranger's call is refused.
    ///
    /// Scenario: alice backs 10,000; the founder goes quiet after the round (13 active days counted), the market opens on day
    /// 100 (its first money opens one 14-day window), and 180 days into the market the founder's bot claims alice's released
    /// Shares for her.
    function test_fixed_aStrangerCannotEndABackersRefundByClaimingForThem() public {
        uint256 id = _round(alice, 10_000 * DOLLAR);
        vm.warp(_now() + 100 days); // the founder does not check in
        _sale(7500 * DOLLAR); // the market opens; the Vester's clock starts
        vm.warp(_now() + 180 days); // still quiet
        uint256 before = rd.refundable(id, alice);
        (uint256 total,) = v.heldGrants(id, alice);

        // today the stranger's call works and takes out every released Share; a fix may refuse it
        uint256 taken;
        vm.prank(stranger); // nobody alice knows
        try v.claimHeld(id, alice) returns (uint256 x) {
            taken = x;
        } catch {}
        uint256 afterClaim = rd.refundable(id, alice);

        // what the Shares forced on alice are worth if she hands them all back at once, at today's floor
        uint256 slice = t.melting() * taken / t.countingSupply();
        uint256 atFloor = slice - (slice * 500 + 9999) / 10_000;

        // alice refunds what is left; the founder then checks in again for 26 weeks and the round pays out
        _refund(id, alice);
        _live(182 days);
        rd.release(id);
        uint256 toProject = rd.roundOf(id).paidOut;
        // had alice refunded everything before the stranger's call, the project would have had only the released part
        uint256 releasedPart = 8200 * DOLLAR * 27 days / 182 days;

        emit log_named_decimal_uint("alice's refund before the stranger's claim", before, 6);
        emit log_named_decimal_uint("alice's refund after it", afterClaim, 6);
        emit log_named_decimal_uint("refund taken from alice by a stranger", before - afterClaim, 6);
        emit log_named_decimal_uint("Shares forced on her (millions)", taken / 1e6, 18);
        emit log_named_decimal_uint("those Shares handed back at once at the floor", atFloor, 6);
        emit log_named_decimal_uint("round money that reached the project", toProject, 6);
        emit log_named_decimal_uint(
            "of it, more than the released part (founder side's gain)", toProject - releasedPart, 6
        );
        emit log_named_decimal_uint("Shares released to her by then (millions)", total * 180 days / 365 days / 1e6, 18);
        assertEq(afterClaim, before, "nobody but alice can end alice's refund");
    }

    /// @dev PINNED, OWNER DECISION (finding M4A-2). After a wind-down the release stops for good and backers take back their
    /// unreleased money, but only for Shares still in the Vester. The unreleased money behind Shares the backer already took out
    /// can then never be released to the project nor refunded: it stays in the Rounds for ever with no one able to take it. A
    /// runner may wind down before a market, which includes after "no market", when the held Shares are releasing (and after a
    /// market a Council may, from milestone 9). The plan says "payments stop for good" and "Shares you take out end that part of
    /// it", so neither side is owed this money; who gets it (the project, or the floor for holders) is the owner's choice. This
    /// test pins today's measured effect: 152.285715 dollars without an owner on a 1,000-dollar backing.
    function test_pinned_aWindDownStrandsTheHeldMoneyOfClaimedShares() public {
        uint256 id = _round(alice, 1000 * DOLLAR); // 820 held; the founder goes quiet: 13 active days counted
        vm.warp(rd.firstMoneyAt() + 365 days);
        vm.prank(founder);
        launcher.declareNoMarket(key); // the Vester's clock starts
        vm.warp(_now() + 73 days);
        vm.prank(alice);
        v.claimHeld(id, alice); // a fifth released; alice takes it out
        vm.prank(founder);
        launcher.windDown(key);
        _refund(id, alice); // the four fifths still held, less the platform's 1
        rd.release(id);
        vm.warp(_now() + 3650 days);
        rd.release(id);
        uint256 stuck = usd.balanceOf(rounds) - rd.platformOwed();
        emit log_named_decimal_uint("dollars in the Rounds nobody can ever take", stuck, 6);
        assertEq(rd.releasable(id), 0);
        assertEq(stuck, 152_285_715, "pinned: the money behind the claimed fifth has no owner (owner decision)");
    }

    /// @dev PROBE. A founder's second account asks big, lowers in hour 11, withdraws, re-asks at the last second, from 20 more
    /// accounts: everyone is scaled back by the same percent, the dollars balance to the raw unit, and refunding at once returns
    /// exactly the plan's 77.9 of each 100 accepted, less rounding.
    function test_probe_scaleBackGamesFromManyAccounts() public {
        _checkIn();
        uint256 id = _openRound();
        _ask(id, alice, 1000 * DOLLAR); // the honest backer
        address sock = makeAddr("sock");
        _ask(id, sock, 90_000 * DOLLAR);
        vm.warp(_now() + 11 hours);
        vm.prank(sock);
        rd.lower(id, 0);
        vm.warp(_now() + 1 hours - 1);
        vm.prank(sock);
        vm.expectRevert(Rounds.BadAmount.selector);
        rd.lower(id, 0); // nothing left to lower
        vm.warp(rd.roundOf(id).openedAt + 1 days - 1);
        address[] memory socks = new address[](20);
        for (uint256 i; i < 20; ++i) {
            socks[i] = makeAddr(string(abi.encode("sock", i)));
            _ask(id, socks[i], 4999 * DOLLAR + i);
        }
        _close(id);
        rd.settle(id, alice);
        rd.settleMany(id, socks);
        Rounds.Round memory r = rd.roundOf(id);
        uint256 a = rd.positionOf(id, alice).bought / rd.SHARES_PER_RAW_DOLLAR();
        assertApproxEqAbs(a * r.asked, 1000 * DOLLAR * r.accepted, r.asked, "alice gets the same percent as everyone");
        uint256 back;
        for (uint256 i; i < 20; ++i) {
            back += _refund(id, socks[i]);
        }
        uint256 accSocks;
        for (uint256 i; i < 20; ++i) {
            accSocks += rd.positionOf(id, socks[i]).bought / rd.SHARES_PER_RAW_DOLLAR();
        }
        assertLe(back, accSocks * 779 / 1000, "the socks never get back more than 77.9 of each 100 accepted");
        assertApproxEqAbs(back, accSocks * 779 / 1000, 40, "and lose exactly the plan's 22.1");
    }

    /// @dev PROBE. A stranger cannot make another backer's refund smaller by refunding, releasing, settling or syncing around it,
    /// before the market (the claim route above is the only one found).
    function test_probe_nobodyElsesCallMovesARefundBeforeTheMarket() public {
        _checkIn();
        uint256 id = _openRound();
        _ask(id, alice, 3000 * DOLLAR);
        _ask(id, bob, 3000 * DOLLAR);
        _close(id);
        rd.settle(id, alice);
        vm.warp(_now() + 5 days);
        uint256 a = rd.refundable(id, alice);
        vm.startPrank(stranger);
        rd.settle(id, bob);
        rd.release(id);
        rd.sync();
        t.release();
        vm.stopPrank();
        _refund(id, bob);
        rd.release(id);
        assertEq(rd.refundable(id, alice), a);
        vm.prank(alice);
        assertEq(v.claimHeld(id, alice), 0, "before the market nothing can be taken out");
    }
}

/// @notice A reserve sale nobody bids in, on the local Uniswap stack: it must still finish, or exits would wait for ever.
contract AttackPlanV2M4ReserveTest is Platform {
    address internal council = makeAddr("council stand-in");

    function setUp() public {
        _setUpPlatform(false);
    }

    /// @dev PROBE. The Council opens a reserve sale and nobody bids: anyone finishes it, every Share comes back to the reserve,
    /// no dollar moves, and exits open again.
    function test_probe_aReserveSaleNobodyBidsInStillFinishesAndExitsReopen() public {
        Proj memory p = _launch(founder, keccak256("reserve, no bids"));
        Sale memory s = _open(p);
        vm.roll(s.startBlock);
        address[5] memory who = [alice, bob, carol, dave, erin];
        for (uint256 i; i < 5; ++i) {
            _bid(s, who[i], 30_000 * DOLLAR, 100);
        }
        _toEnd(s);
        _finish(p, s);
        for (uint256 i; i < 5; ++i) {
            _collectBid(s, i);
        }
        vm.prank(councilMaker);
        launcher.registerCouncil(council);
        _both(p, address(p.treasury), abi.encodeCall(Treasury.handOver, (council, false)));
        vm.prank(council);
        p.treasury.takeSeat();
        vm.roll(uint256(s.endBlock) + 201_600);
        uint256 reserve0 = p.treasury.reserve();
        uint256 melt0 = p.treasury.melting();
        vm.prank(council);
        address ra = launcher.openReserveSale(p.key, 10_000_000 * SHARE);
        IAuctionTest a = IAuctionTest(ra);
        Sale memory r = Sale(a, a.floorPrice(), a.tickSpacing(), a.startBlock(), a.endBlock());
        _toEnd(r);
        vm.roll(r.endBlock + 1);
        vm.prank(stranger);
        launcher.finishReserveSale(p.key);
        assertEq(p.treasury.reserve(), reserve0, "every Share is back in the reserve");
        assertEq(p.treasury.melting(), melt0, "no dollar moved");
        assertFalse(p.treasury.reserveSaleOpen());
        vm.startPrank(alice);
        p.shares.approve(address(p.treasury), type(uint256).max);
        assertGt(p.treasury.handBack(1000 * SHARE), 0, "exits are open again");
        vm.stopPrank();
        (, uint256 endPrice) = launcher.lastSale(p.key);
        assertEq(endPrice, r.floorQ96, "the next one starts where this one started");
    }
}
