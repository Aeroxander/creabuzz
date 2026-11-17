// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Platform} from "./helpers/Platform.sol";
import {Rounds} from "../src/Rounds.sol";
import {Pair} from "../src/Pair.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {IShares} from "../src/Interfaces.sol";
import {Clones} from "oz5/proxy/Clones.sol";

/// @dev A contract that claims to be a Pair with the founder as a signer, but was not made by the Launcher.
contract FakePair {
    address public first;
    address public second;
    Treasury internal t;

    constructor(Treasury t_, address first_, address second_) {
        (t, first, second) = (t_, first_, second_);
    }

    function take() external {
        t.takeSeat();
    }

    function offer(address next, bool founderLeaves) external {
        t.handOver(next, founderLeaves);
    }
}

/// @notice The milestone 4 review fixes: only the founder can start the founder's trim (R1), the guards that no test caught (R2),
/// the scale-back dust (R3), and the Team rules not built yet, pinned at what they measure today (R4).
contract PlanV2M4FixesTest is RoundsBase {
    address internal hired = makeAddr("hired runner");
    address internal next2 = makeAddr("second successor");

    // ============================================ R1: only the founder starts the trim ===========================================

    /// @dev Day 30: the founder hands the seat to a hired runner without leaving. Day 60: the hired runner offers the seat on with
    /// the founder "leaving". Refused: only the founder can give up their own Shares. A plain hand-over still works and the
    /// founder's 200M stay whole.
    function test_trim_aSuccessorCannotStartTheFoundersTrim() public {
        vm.warp(_now() + 30 days);
        vm.prank(founder);
        t.handOver(hired, false);
        vm.prank(hired);
        t.takeSeat();
        vm.warp(_now() + 30 days);
        vm.prank(hired);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.handOver(next2, true);
        vm.prank(hired);
        t.handOver(next2, false);
        vm.prank(next2);
        t.takeSeat();
        (uint256 total,) = v.grants(founder);
        assertEq(total, 200_000_000 * SHARE, "the founder's grant is whole");
        assertFalse(v.trimmed());
        assertEq(t.workPot(), 200_000_000 * SHARE);
    }

    /// @dev A Pair the founder is not in (the hired runner and a friend) cannot trim the founder either.
    function test_trim_aPairWithoutTheFounderCannotStartIt() public {
        vm.prank(founder);
        t.handOver(hired, false);
        vm.prank(hired);
        t.takeSeat();
        address pa = launcher.pairAddress(key, hired, cosigner);
        vm.prank(hired);
        t.handOver(pa, false);
        vm.prank(cosigner);
        launcher.makePair(key, hired);
        _bothRefused(
            address(t),
            abi.encodeCall(Treasury.handOver, (next2, true)),
            abi.encodeWithSelector(Treasury.NotAllowed.selector)
        );
        _both(address(t), abi.encodeCall(Treasury.handOver, (next2, false)));
    }

    /// @dev A contract that says it is a Pair with the founder as a signer, but that the Launcher never made, is refused.
    function test_trim_aFakePairNamingTheFounderCannotStartIt() public {
        vm.prank(founder);
        t.handOver(hired, false);
        vm.prank(hired);
        t.takeSeat();
        FakePair fake = new FakePair(t, founder, hired);
        vm.prank(hired);
        t.handOver(address(fake), false);
        fake.take();
        vm.expectRevert(Treasury.NotAllowed.selector);
        fake.offer(next2, true);
    }

    /// @dev Team: the Pair of the founder and a second signer may trim the founder (both must agree, so the founder did). The
    /// founder leaves on day 73 and keeps 73/365 of 200M.
    function test_trim_theFoundersPairMayStartIt() public {
        _team();
        vm.warp(_now() + 73 days);
        _both(address(t), abi.encodeCall(Treasury.handOver, (next2, true)));
        vm.prank(next2);
        t.takeSeat();
        (uint256 total,) = v.grants(founder);
        assertEq(total, 40_000_000 * SHARE);
        assertEq(t.workPot(), 360_000_000 * SHARE);
    }

    /// @dev R2 (X3): the founder is trimmed once. Trimmed on day 73 to 40M; the seat comes back to them and they leave again on
    /// day 146: the second trim is refused and the 40M stay.
    function test_trim_onlyOnce() public {
        vm.warp(_now() + 73 days);
        vm.prank(founder);
        t.handOver(alice, true);
        vm.prank(alice);
        t.takeSeat();
        vm.prank(alice);
        t.handOver(founder, false);
        vm.prank(founder);
        t.takeSeat();
        vm.warp(_now() + 73 days);
        vm.prank(founder);
        t.handOver(bob, true);
        vm.prank(bob);
        vm.expectRevert(Vester.WrongPhase.selector);
        t.takeSeat();
        (uint256 total,) = v.grants(founder);
        assertEq(total, 40_000_000 * SHARE, "still the 40M of the first trim");
    }

    // ============================================ R2: guards no test caught ======================================================

    /// @dev X2: no "no market" while a round is open (its backers would get Shares on a clock that already runs, and the round
    /// would close after the sale phase ended).
    function test_noMarket_notWhileARoundIsOpen() public {
        vm.warp(_now() + 365 days);
        _checkIn();
        uint256 id = _openRound();
        vm.prank(founder);
        vm.expectRevert(Launcher.WrongStage.selector);
        launcher.declareNoMarket(key);
        _close(id);
        vm.prank(founder);
        launcher.declareNoMarket(key); // once the round closed (nothing asked: still counted from the launch)
    }

    /// @dev X4: no auction after a wind-down, even by a Pair before any market.
    function test_openAuction_notAfterAWindDown() public {
        _team();
        _both(address(launcher), abi.encodeCall(Launcher.windDown, (key)));
        _bothRefused(
            address(launcher),
            abi.encodeCall(Launcher.openAuction, (key)),
            abi.encodeWithSelector(Launcher.WrongStage.selector)
        );
    }

    /// @dev A refund once everything is released pays nothing, and must then not cancel the backer's held Shares.
    function test_refund_whenEverythingIsReleasedIsRefusedAndTheSharesStay() public {
        uint256 id = _round(alice, 1000 * DOLLAR);
        _live(26 weeks);
        assertEq(rd.refundable(id, alice), 0);
        vm.prank(alice);
        vm.expectRevert(Rounds.NothingToRefund.selector);
        rd.refund(id);
        (uint256 total,) = v.heldGrants(id, alice);
        assertEq(total, 3_000_000 * SHARE, "her Shares are still held for her");
    }

    /// @dev A Pair runs only calls one signer proposed: confirming a call nobody proposed is refused.
    function test_pair_confirmingACallNobodyProposedIsRefused() public {
        Pair pair = _team();
        bytes memory data = abi.encodeCall(Treasury.spend, (cosigner, 1000 * DOLLAR));
        vm.prank(cosigner);
        vm.expectRevert(Pair.UnknownCall.selector);
        pair.confirm(address(t), data, 0);
    }

    /// @dev A round that was never opened cannot be closed. Without this a stranger could close the next round's id before the
    /// Launcher opens it: that round would then take asks for 24 hours but could never be closed, and its backers' dollars could
    /// never be settled or returned.
    function test_close_aRoundNeverOpenedIsRefused() public {
        vm.warp(_now() + 2 days);
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.close(1);
        uint256 id = _openRound();
        vm.expectRevert(Rounds.WrongPhase.selector);
        rd.close(id + 1);
    }

    /// @dev A dollar token that takes more from the Rounds than it sends is refused (the books would no longer match the money).
    function test_send_aTokenThatTakesMoreFromTheRoundsThanItSendsIsRefused() public {
        uint256 id = _openRound();
        _ask(id, alice, 100 * DOLLAR);
        usd.setFees(0, 100); // 1% charged to the sender on top
        vm.prank(alice);
        vm.expectRevert(Rounds.TokenMisbehaved.selector);
        rd.lower(id, 40 * DOLLAR);
    }

    /// @dev A Pair needs two real signers: a seat offered to the Pair of nobody and the cosigner cannot be taken.
    function test_pair_aSignerMayNotBeNobody() public {
        address pa = launcher.pairAddress(key, address(0), cosigner);
        vm.prank(founder);
        t.handOver(pa, false);
        vm.prank(cosigner);
        vm.expectRevert(Pair.BadSetup.selector);
        launcher.makePair(key, address(0));
        assertEq(t.runner(), founder);
    }

    /// @dev The Vester refuses a backer grant to nobody, even from the Rounds.
    function test_vester_aBackerGrantToNobodyIsRefused() public {
        vm.prank(rounds);
        vm.expectRevert(Vester.BadGrant.selector);
        v.grantHeld(1, address(0), 1);
    }

    /// @dev A Vester cannot be set up with nobody as the founder.
    function test_vester_aFounderGrantToNobodyIsRefused() public {
        Vester fresh = Vester(Clones.clone(launcher.vesterImpl()));
        vm.expectRevert(Vester.BadGrant.selector);
        fresh.initialize(IShares(address(shares)), address(this), address(this), address(this), address(0), 1);
    }

    // ============================================ R3: the scale-back dust ========================================================

    /// @dev Three backers asking 1 raw unit over a third of a 10,000 round each: the scale-back dust (accepted less the sum of the
    /// accepted parts) goes back to the backers with the rest of their asks; `raised` and `RoundClosed.accepted` count it, the
    /// sum of `Settled.accepted` does not, and the dust's Shares stay set aside.
    function test_scaleBackDust_goesBackToTheBackers_raisedCountsIt() public {
        _checkIn();
        uint256 id = _openRound();
        address[] memory who = new address[](3);
        (who[0], who[1], who[2]) = (alice, bob, carol);
        uint256 ask = 3_333_333_334 + 1_000_000; // 3,334.333334 dollars each
        for (uint256 i; i < 3; ++i) {
            _ask(id, who[i], ask);
        }
        _close(id);
        rd.settleMany(id, who);
        uint256 sumAcc;
        uint256 back;
        for (uint256 i; i < 3; ++i) {
            sumAcc += rd.positionOf(id, who[i]).bought / rd.SHARES_PER_RAW_DOLLAR();
            back += usd.balanceOf(who[i]);
        }
        uint256 dust = 10_000 * DOLLAR - sumAcc;
        emit log_named_uint("scale-back dust (raw dollar units)", dust);
        assertGt(dust, 0, "this example has dust");
        assertLt(dust, 3, "under one raw unit per backer");
        assertEq(back, 3 * ask - sumAcc, "the dust went back to the backers");
        assertEq(rd.raised(), sumAcc + dust, "raised = the sum of Settled.accepted plus the dust");
        assertEq(rd.roundOf(id).accepted, rd.raised());
        assertEq(rd.reserved(), dust * rd.SHARES_PER_RAW_DOLLAR(), "the dust's Shares stay set aside");
    }

    // ============================================ R4: Team rules not built (pinned) =============================================

    /// @dev PINNED (R4, not built: the plan says "500 a week for any one signer, agents included"). The Pair's agents keep the
    /// Treasury's own daily caps: with three default agents, one signer's key and the agents' keys spend 950 dollars in 7 days
    /// (each agent's 25 a day counts for 24 to 28 hours, so 6 spends each), almost twice the plan's bound. Building it is listed for the owner (milestone 7, Team in the app).
    function test_pinned_aPairsAgentsSpendOutsideTheSignersWeeklyLimit() public {
        _sale(75_000 * DOLLAR); // 15,000 spendable
        Pair pair = _team();
        address[3] memory agents = [makeAddr("agent 1"), makeAddr("agent 2"), makeAddr("agent 3")];
        for (uint256 i; i < 3; ++i) {
            _both(address(t), abi.encodeCall(Treasury.authoriseAgent, (agents[i])));
        }
        uint256 start = _now();
        uint256 out;
        vm.prank(founder);
        pair.spend(stranger, 500 * DOLLAR);
        out += 500 * DOLLAR;
        // each agent spends its 25 whenever its daily limit lets it, inside the same 7 days
        for (uint256 step; _now() + 1 hours <= start + 7 days; ++step) {
            for (uint256 i; i < 3; ++i) {
                if (t.agentUsdUsed(agents[i]) + 25 * DOLLAR <= 25 * DOLLAR) {
                    vm.prank(agents[i]);
                    t.spend(stranger, 25 * DOLLAR);
                    out += 25 * DOLLAR;
                }
            }
            vm.warp(_now() + 1 hours);
        }
        emit log_named_decimal_uint("spent in 7 days by one signer's key and three agents' keys", out, 6);
        assertEq(usd.balanceOf(stranger), out);
        assertEq(
            out, 950 * DOLLAR, "pinned: 500 alone plus 450 by three agents, against the plan's 500 agents included"
        );
    }

    /// @dev PINNED (R4, not built: "after 28 silent days at Team the second signer takes over"). The founder goes silent for 60
    /// days: the second signer can still check in and spend 500 a week, but every raise, hand-over and wind-down needs the
    /// silent founder's confirmation, and their own confirmation is refused.
    function test_pinned_aSilentFounderLeavesTheSecondSignerWithoutRaises() public {
        _sale(7500 * DOLLAR);
        Pair pair = _team();
        vm.warp(_now() + 60 days);
        vm.prank(cosigner);
        pair.checkIn();
        vm.prank(cosigner);
        pair.spend(stranger, 500 * DOLLAR);
        bytes memory data = abi.encodeCall(Launcher.windDown, (key));
        vm.prank(cosigner);
        pair.propose(address(launcher), data);
        uint256 n = pair.nonce() - 1;
        vm.prank(cosigner);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.confirm(address(launcher), data, n);
        assertEq(t.runner(), address(pair), "no takeover: the seat stays with both");
    }
}

/// @notice The milestone 4 guards that need the real auction (the local Uniswap stack): nothing that ends the project's sale
/// phase while the auction runs.
contract PlanV2M4FixesAuctionTest is Platform {
    function setUp() public {
        _setUpPlatform(false);
    }

    function _bothRefused(Proj memory p, address target, bytes memory data, bytes memory err) internal {
        Pair pair = Pair(p.treasury.runner());
        vm.prank(pair.first());
        pair.propose(target, data);
        uint256 n = pair.nonce() - 1;
        vm.prank(pair.second());
        vm.expectRevert(err);
        pair.confirm(target, data, n);
    }

    /// @dev X1: no wind-down while the auction runs (else it could graduate into a market for a project already wound down, and
    /// only a Council may wind down after a market).
    function test_windDown_notWhileTheAuctionRuns() public {
        Proj memory p = _launch(founder, keccak256("wind down in the sale"));
        _open(p);
        _bothRefused(
            p,
            address(launcher),
            abi.encodeCall(Launcher.windDown, (p.key)),
            abi.encodeWithSelector(Launcher.WrongStage.selector)
        );
        assertFalse(p.treasury.woundDown());
    }

    /// @dev No "no market" while the auction runs, even 365 days after the launch.
    function test_noMarket_notWhileTheAuctionRuns() public {
        Proj memory p = _launch(founder, keccak256("no market in the sale"));
        vm.warp(_now() + 365 days);
        _open(p);
        _bothRefused(
            p,
            address(launcher),
            abi.encodeCall(Launcher.declareNoMarket, (p.key)),
            abi.encodeWithSelector(Launcher.WrongStage.selector)
        );
        assertFalse(p.treasury.noMarket());
    }
}
