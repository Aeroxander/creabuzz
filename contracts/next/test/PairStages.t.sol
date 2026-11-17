// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RoundsBase} from "./helpers/RoundsBase.sol";
import {Rounds} from "../src/Rounds.sol";
import {Pair} from "../src/Pair.sol";
import {Launcher} from "../src/Launcher.sol";
import {Treasury} from "../src/Treasury.sol";
import {Vester} from "../src/Vester.sol";
import {RollingCap} from "../src/RollingCap.sol";
import {ITreasuryRunner} from "../src/Interfaces.sol";

/// @notice The Team runner: two signers, 500 dollars a week alone, both for anything more; becoming Team in two transactions.
contract PairTest is RoundsBase {
    Pair internal pair;

    function setUp() public override {
        super.setUp();
        _sale(7500 * DOLLAR); // 1,500 spendable to spend
        pair = _team();
    }

    function test_makePair_twoTransactionsNoWait_theSeatMovesToThePredictedPair() public view {
        assertEq(address(pair), launcher.pairAddress(key, founder, cosigner));
        assertEq(t.runner(), address(pair));
        assertTrue(launcher.isPair(address(pair)));
        assertEq(pair.first(), founder);
        assertEq(pair.second(), cosigner);
        assertEq(uint256(launcher.stageOf(key)), uint256(Launcher.Stage.Team));
        assertEq(launcher.capOf(address(pair)), 50_000 * DOLLAR);
    }

    function test_makePair_needsTheSeatToBeOffered() public {
        bytes32 k2 = launcher.keyOf(alice, keccak256("two"));
        _launch(alice, keccak256("two"));
        vm.prank(bob);
        vm.expectRevert(Treasury.NotAllowed.selector);
        launcher.makePair(k2, alice); // alice never offered the seat
        // and an offer to one Pair is not an offer to another
        Launcher.Project memory p2 = launcher.projectByKey(k2);
        address pa = launcher.pairAddress(k2, alice, bob);
        vm.prank(alice);
        Treasury(p2.treasury).handOver(pa, false);
        vm.prank(carol);
        vm.expectRevert(Treasury.NotAllowed.selector);
        launcher.makePair(k2, alice);
        vm.prank(bob);
        launcher.makePair(k2, alice);
    }

    function test_initialize_onceOnlyAndNotOnTheImplementation() public {
        vm.expectRevert(Pair.BadSetup.selector);
        pair.initialize(ITreasuryRunner(address(t)), address(launcher), alice, bob);
        Pair impl = Pair(launcher.pairImpl());
        vm.prank(address(launcher));
        vm.expectRevert(Pair.BadSetup.selector);
        impl.initialize(ITreasuryRunner(address(t)), address(launcher), alice, bob);
        // the same person twice is refused (the Launcher makes the clone, so only its call can reach this)
        bytes32 k3 = launcher.keyOf(alice, keccak256("three"));
        _launch(alice, keccak256("three"));
        vm.prank(alice);
        vm.expectRevert(Pair.BadSetup.selector);
        launcher.makePair(k3, alice);
    }

    function test_spendAlone_upTo500InAny7Days_perSigner() public {
        vm.prank(founder);
        pair.spend(carol, 500 * DOLLAR);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.CapExceeded.selector, 500 * DOLLAR, 1, 500 * DOLLAR));
        pair.spend(carol, 1);
        vm.prank(cosigner);
        pair.spend(carol, 500 * DOLLAR); // the other signer has their own 500
        assertEq(usd.balanceOf(carol), 1000 * DOLLAR);
        assertEq(pair.spentAlone(founder), 500 * DOLLAR);
        vm.warp(_now() + 8 days);
        vm.prank(founder);
        pair.spend(carol, 400 * DOLLAR); // a week later the limit is free again
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.spend(carol, 1);
    }

    function test_spendAlone_501InAWeekIsRefused_evenInPieces() public {
        vm.prank(founder);
        pair.spend(carol, 250 * DOLLAR);
        vm.warp(_now() + 3 days);
        vm.prank(founder);
        pair.spend(carol, 250 * DOLLAR);
        vm.warp(_now() + 3 days);
        vm.prank(founder);
        vm.expectRevert();
        pair.spend(carol, 1 * DOLLAR); // 501 within 6 days
        vm.prank(founder);
        vm.expectRevert();
        pair.spend(carol, 501 * DOLLAR);
    }

    function test_bothSigners_spendMore() public {
        bytes memory data = abi.encodeCall(Treasury.spend, (carol, 1200 * DOLLAR));
        vm.prank(founder);
        bytes32 id = pair.propose(address(t), data);
        assertEq(pair.proposer(id), founder);
        vm.prank(founder);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.confirm(address(t), data, 0); // not your own proposal
        vm.prank(cosigner);
        pair.confirm(address(t), data, 0);
        assertEq(usd.balanceOf(carol), 1200 * DOLLAR);
        vm.prank(cosigner);
        vm.expectRevert(Pair.UnknownCall.selector);
        pair.confirm(address(t), data, 0); // once
    }

    function test_propose_onlySigners_onlyTheTreasuryOrTheLauncher_andCancel() public {
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.propose(address(t), "");
        vm.prank(founder);
        vm.expectRevert(Pair.BadTarget.selector);
        pair.propose(address(usd), abi.encodeWithSignature("transfer(address,uint256)", founder, 1));
        vm.prank(founder);
        bytes32 id = pair.propose(address(t), abi.encodeCall(Treasury.spend, (carol, 1)));
        vm.prank(cosigner);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.cancel(id);
        vm.prank(founder);
        pair.cancel(id);
        vm.prank(cosigner);
        vm.expectRevert(Pair.UnknownCall.selector);
        pair.confirm(address(t), abi.encodeCall(Treasury.spend, (carol, 1)), 0);
    }

    function test_confirm_aFailingCallRevertsWithItsOwnErrorAndStaysPending() public {
        bytes memory data = abi.encodeCall(Treasury.spend, (carol, 1_000_000 * DOLLAR));
        vm.prank(founder);
        bytes32 id = pair.propose(address(t), data);
        vm.prank(cosigner);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, 1_000_000 * DOLLAR, 1500 * DOLLAR));
        pair.confirm(address(t), data, 0);
        assertEq(pair.proposer(id), founder);
    }

    function test_aRaiseNeedsBoth_oneSignerAloneCannotOpenARoundOrTheAuction() public {
        vm.prank(founder);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.openRound(key);
        vm.prank(cosigner);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.openAuction(key);
        // the Pair alone is the runner, and it moves only when both agree
        vm.prank(founder);
        pair.propose(address(launcher), abi.encodeCall(Launcher.openRound, (key)));
        assertFalse(Rounds(rounds).isOpen(), "a proposal opens nothing");
    }

    function test_checkIn_eitherSigner_notAStranger_notTheFounderDirectly() public {
        vm.prank(cosigner);
        pair.checkIn();
        assertEq(t.lastCheckIn(), _now());
        vm.prank(stranger);
        vm.expectRevert(Pair.NotAllowed.selector);
        pair.checkIn();
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.checkIn(); // the founder is a signer now, not the runner
    }

    function test_handOnward_bothSignersCanHandTheSeatToACouncil() public {
        address council = makeAddr("council");
        vm.prank(councilMaker);
        launcher.registerCouncil(council);
        _both(address(t), abi.encodeCall(Treasury.handOver, (council, false)));
        vm.prank(council);
        t.takeSeat();
        assertEq(t.runner(), council);
        assertEq(uint256(launcher.runnerKind(council)), uint256(Launcher.RunnerKind.Council));
    }
}

/// @notice The stage rules the Launcher keeps: the caps, who may open the auction, "no market", wind down, the hand-over and the
/// founder's trim, the stake, the check-in by a person, the council seam.
contract StagesTest is RoundsBase {
    function test_solo_capIs10000InTotal_andRoundsFollowWithNoWait() public {
        assertEq(uint256(launcher.stageOf(key)), uint256(Launcher.Stage.Solo));
        uint256 id = _round(alice, 2500 * DOLLAR);
        assertEq(uint256(launcher.stageOf(key)), uint256(Launcher.Stage.Backed), "Backed once a round took money");
        uint256 id2 = _openRound(); // the next round opens at once
        assertEq(rd.roundOf(id2).size, 7500 * DOLLAR, "whatever is left under the 10,000 cap");
        _ask(id2, bob, 20_000 * DOLLAR);
        _close(id2);
        assertEq(rd.raised(), 10_000 * DOLLAR);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.CapReached.selector, 10_000 * DOLLAR));
        launcher.openRound(key);
        // a refund does not reopen the cap
        rd.settle(id2, bob);
        _refund(id, alice);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.CapReached.selector, 10_000 * DOLLAR));
        launcher.openRound(key);
    }

    function test_team_capIs50000InTotal() public {
        _round(alice, 10_000 * DOLLAR);
        _team();
        uint256 id = _openRound();
        assertEq(rd.roundOf(id).size, 40_000 * DOLLAR);
        _ask(id, bob, 40_000 * DOLLAR);
        _close(id);
        rd.settle(id, bob);
        assertEq(rd.unsold(), 0, "all 150M backing Shares are sold");
        _bothRefused(
            address(launcher),
            abi.encodeCall(Launcher.openRound, (key)),
            abi.encodeWithSelector(Launcher.CapReached.selector, 50_000 * DOLLAR)
        );
    }

    function test_openRound_onlyTheRunner_neverAfterAMarketOrAWindDown() public {
        vm.prank(stranger);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.openRound(key);
        vm.expectRevert(Launcher.UnknownProject.selector);
        launcher.openRound(bytes32(uint256(1)));
        _market();
        vm.prank(founder);
        vm.expectRevert(Launcher.WrongStage.selector);
        launcher.openRound(key);
    }

    function test_openAuction_aSingleFounderCannot() public {
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.WrongRunner.selector, Launcher.RunnerKind.Pair));
        launcher.openAuction(key);
    }

    function test_openAuction_notWhileARoundIsOpen_notAfterAMarket() public {
        _team();
        _openRound();
        _bothRefused(
            address(launcher),
            abi.encodeCall(Launcher.openAuction, (key)),
            abi.encodeWithSelector(Launcher.WrongStage.selector)
        );
    }

    /// @dev D230: on every network but a local chain and Sepolia the auction needs a Council runner.
    function test_requireCouncilForAuction_trueOnEveryNetworkButLocalAndSepolia() public {
        assertFalse(launcher.requireCouncilForAuction(), "local");
        uint256[4] memory chains = [uint256(11_155_111), 1, 8453, 31_337];
        bool[4] memory want = [false, true, true, false];
        for (uint256 i; i < 4; ++i) {
            vm.chainId(chains[i]);
            Launcher l = _deployLauncher(admin, _settings());
            assertEq(l.requireCouncilForAuction(), want[i]);
        }
    }

    function test_requireCouncilForAuction_aPairIsRefusedACouncilPassesTheRunnerCheck() public {
        vm.chainId(1);
        Launcher l = _deployLauncher(admin, _settings());
        bytes32 h = l.settingsHash();
        vm.prank(founder);
        (,, address tr) = l.launch(PROJECT, "M", "M", h);
        tr; // the Vester; the Treasury is read back below
        bytes32 k = l.keyOf(founder, PROJECT);
        Treasury tt = Treasury(l.projectByKey(k).treasury);
        address pa = l.pairAddress(k, founder, cosigner);
        vm.prank(founder);
        tt.handOver(pa, false);
        vm.prank(cosigner);
        Pair p = Pair(l.makePair(k, founder));
        bytes memory data = abi.encodeCall(Launcher.openAuction, (k));
        vm.prank(founder);
        p.propose(address(l), data);
        vm.prank(cosigner);
        vm.expectRevert(abi.encodeWithSelector(Launcher.WrongRunner.selector, Launcher.RunnerKind.Council));
        p.confirm(address(l), data, 0);
        // the full sale with a Council runner on a real stack is in `AuctionV2.t.sol`; here only the runner check
        assertEq(uint256(l.runnerKind(address(p))), uint256(Launcher.RunnerKind.Pair));
    }

    function test_noMarket_onlyAfter365DaysFromTheFirstMoneyRound_thenTheClockStartsAndTheAuctionIsClosed() public {
        vm.warp(_now() + 200 days);
        _round(alice, 1000 * DOLLAR);
        uint256 first = rd.firstMoneyAt();
        vm.warp(first + 365 days - 1);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.TooEarly.selector, first + 365 days));
        launcher.declareNoMarket(key);
        vm.warp(first + 365 days);
        vm.prank(stranger);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.declareNoMarket(key);
        vm.prank(founder);
        launcher.declareNoMarket(key);
        assertTrue(t.noMarket());
        assertEq(v.start(), _now(), "held Shares start their 365 days now");
        assertEq(v.unreleased(), v.granted(), "nothing released yet");
        assertEq(t.reserve(), 100_000_000 * SHARE, "no stake without a market");
        vm.prank(founder);
        vm.expectRevert(Launcher.WrongStage.selector);
        launcher.openRound(key);
        _team();
        bytes memory wrong = abi.encodeWithSelector(Launcher.WrongStage.selector);
        _bothRefused(address(launcher), abi.encodeCall(Launcher.openAuction, (key)), wrong);
        _bothRefused(address(launcher), abi.encodeCall(Launcher.declareNoMarket, (key)), wrong); // once
    }

    function test_noMarket_withNoRoundCountsFromTheLaunch() public {
        vm.warp(_now() + 365 days);
        vm.prank(founder);
        launcher.declareNoMarket(key);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.markNoMarket(); // only through the Launcher
    }

    function test_windDown_theRunnerBeforeAMarket_onlyACouncilAfter() public {
        vm.prank(stranger);
        vm.expectRevert(Launcher.NotRunner.selector);
        launcher.windDown(key);
        uint256 snap = vm.snapshotState();
        vm.prank(founder);
        launcher.windDown(key);
        assertTrue(t.woundDown());
        assertEq(t.activeEnd(), 0, "payments stop for good");
        vm.prank(founder);
        vm.expectRevert(Treasury.AlreadyWoundDown.selector);
        launcher.windDown(key);
        vm.revertToState(snap);
        _sale(7500 * DOLLAR); // a market opened
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.WrongRunner.selector, Launcher.RunnerKind.Council));
        launcher.windDown(key);
        address council = makeAddr("council");
        vm.prank(councilMaker);
        launcher.registerCouncil(council);
        vm.prank(founder);
        t.handOver(council, false);
        vm.prank(council);
        t.takeSeat();
        vm.prank(council);
        launcher.windDown(key);
        // after a wind-down the exit fee is the platform's 1% only
        _buy(alice, 100_000_000 * SHARE);
        _approveAll(alice);
        uint256 slice = t.melting() * 100_000_000 * SHARE / t.countingSupply();
        uint256 paid = _handBack(alice, 100_000_000 * SHARE);
        assertEq(paid, slice - (slice + 99) / 100);
        assertEq(t.feesOwed(), (slice + 99) / 100);
    }

    function test_windDown_notWhileARoundIsOpen() public {
        _openRound();
        vm.prank(founder);
        vm.expectRevert(Launcher.WrongStage.selector);
        launcher.windDown(key);
    }

    function test_handOver_twoSteps_onlyTheRunnerOffers_onlyTheNamedTakes() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.handOver(stranger, false);
        vm.prank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.handOver(founder, false);
        vm.prank(founder);
        t.handOver(alice, false);
        assertEq(t.runner(), founder, "nothing moves on the offer");
        vm.prank(bob);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.takeSeat();
        vm.prank(alice);
        t.takeSeat();
        assertEq(t.runner(), alice);
        assertEq(t.pendingRunner(), address(0));
        vm.prank(alice);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.takeSeat();
    }

    /// @dev The founder leaves 73 days after launch: they keep 73/365 of their 200M (40M), the rest returns to the work pot.
    function test_handOver_aLeavingFounderKeepsTheDaysServed_theRestReturnsToTheWorkPot() public {
        vm.warp(_now() + 73 days);
        vm.prank(founder);
        t.handOver(alice, true);
        vm.prank(alice);
        t.takeSeat();
        (uint256 total,) = v.grants(founder);
        assertEq(total, 40_000_000 * SHARE);
        assertEq(t.workPot(), 360_000_000 * SHARE);
        assertEq(v.granted(), 40_000_000 * SHARE);
        assertEq(shares.balanceOf(address(v)), 40_000_000 * SHARE);
        assertTrue(v.trimmed());
    }

    function test_handOver_aTrimAfterTheMarketIsRefused_andTheSeatStaysPut() public {
        _sale(7500 * DOLLAR);
        vm.prank(founder);
        t.handOver(alice, true);
        vm.prank(alice);
        vm.expectRevert(Vester.WrongPhase.selector);
        t.takeSeat();
        assertEq(t.runner(), founder);
        vm.prank(founder);
        t.handOver(alice, false); // a hand-over without the trim still works
        vm.prank(alice);
        t.takeSeat();
    }

    function test_trim_onlyTheTreasury() public {
        vm.expectRevert(Vester.NotAllowed.selector);
        v.trimFounder();
    }

    function test_agents_cannotCheckIn_andAHandOverSwitchesThemOff() public {
        _sale(7500 * DOLLAR);
        vm.prank(founder);
        t.authoriseAgent(agent);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.checkIn();
        vm.prank(agent);
        t.spend(carol, 5 * DOLLAR); // it can still spend inside its cap
        vm.prank(founder);
        t.handOver(alice, false);
        vm.prank(alice);
        t.takeSeat();
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.spend(carol, 5 * DOLLAR);
        vm.prank(alice);
        t.authoriseAgent(agent); // the new runner may set it again
        vm.prank(agent);
        t.spend(carol, 5 * DOLLAR);
    }

    function test_stake_20MHeldSharesFromTheReserveWhenTheMarketOpens() public {
        _market();
        (uint256 total,) = v.grants(stakeHolder);
        assertEq(total, 20_000_000 * SHARE);
        assertEq(t.reserve(), 80_000_000 * SHARE);
        assertEq(v.claimable(stakeHolder), 0, "held like everyone's");
        vm.warp(_now() + 365 days);
        assertEq(v.claim(stakeHolder), 20_000_000 * SHARE, "released over 365 days");
    }

    function test_councilSeam_onlyTheCouncilMaker() public {
        vm.prank(founder);
        vm.expectRevert(Launcher.NotCouncilMaker.selector);
        launcher.registerCouncil(founder);
        vm.prank(councilMaker);
        vm.expectRevert(Launcher.NotCouncilMaker.selector);
        launcher.registerCouncil(address(0));
        vm.prank(councilMaker);
        launcher.registerCouncil(alice);
        assertTrue(launcher.isCouncil(alice));
    }

    function test_reserveSale_onlyACouncil_onlyAfterAMarket() public {
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Launcher.WrongRunner.selector, Launcher.RunnerKind.Council));
        launcher.openReserveSale(key, 1000 * SHARE);
        address council = makeAddr("council");
        vm.prank(councilMaker);
        launcher.registerCouncil(council);
        vm.prank(founder);
        t.handOver(council, false);
        vm.prank(council);
        t.takeSeat();
        vm.prank(council);
        vm.expectRevert(Launcher.WrongStage.selector);
        launcher.openReserveSale(key, 1000 * SHARE); // no market: the Finisher never sold
        vm.expectRevert(Launcher.WrongStage.selector);
        launcher.finishReserveSale(key); // none running
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.settleReserveSale(1);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.closeReserveSale();
    }
}
