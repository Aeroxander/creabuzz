// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {VoteBase} from "./helpers/VoteBase.sol";
import {Proj} from "./helpers/StackBase.sol";
import {Council} from "../src/Council.sol";
import {EarlierGrants} from "../src/EarlierGrants.sol";
import {HolderPause} from "../src/HolderPause.sol";
import {HolderVote} from "../src/HolderVote.sol";
import {Launcher} from "../src/Launcher.sol";
import {Pair} from "../src/Pair.sol";
import {Treasury} from "../src/Treasury.sol";

/// @dev The Launcher's platform settings as the struct `settingsHash` encodes.
function platformOfV(Launcher l) view returns (Launcher.Platform memory p) {
    (p.quote, p.platform, p.feeBps, p.unit, p.agentUsd) = l.platform();
}

/// @dev A bound pause implementation that has code and says "no": the Launcher's vote check must refuse it.
contract NotAVote {
    function isVote() external pure returns (bool) {
        return false;
    }
}

/// @notice The Launcher's side of the vote path (COUNCIL-PLAN 2.8 and 4.2): `councilByVote` is the project's pause gate's alone, the
/// vote path's address space (key, the five accounts, the ballot's id, and never a hand-over salt), the same five elected twice
/// and elected after a hand-over Council of the same five already exists, the Council made by vote is registered kind 2 and is
/// seated by `Treasury.seatByVote` (one end-to-end through `HolderVote.carryOut`, and the direct refusals), `bindCouncil` refuses
/// a plain pause and accepts a `HolderVote`, `launch` binds the project in the launch transaction, and the fourth `settingsHash`
/// form when both claims and a Council are bound.
contract LauncherVoteTest is VoteBase {
    address internal puppet = makeAddr("puppet signer");
    address internal voter = makeAddr("voter");

    // ---------------------------------------------------------------- helpers

    /// @dev The address the vote path must give: `(key, "council-vote", members, ballotId)` as the clone's salt.
    function _voteAddress(address[5] memory m, uint256 ballotId) internal view returns (address) {
        return Clones.predictDeterministicAddress(
            address(councilImpl), keccak256(abi.encode(key, "council-vote", m, ballotId)), address(launcher)
        );
    }

    /// @dev Make the Council the project's own pause contract (the gate) would make for a won ballot `ballotId`.
    function _makeByVote(address[5] memory m, uint256 ballotId) internal returns (Council c) {
        vm.prank(address(vote));
        c = Council(launcher.councilByVote(key, m, ballotId));
    }

    /// @dev Launch a project on `l` as `who`.
    function _launchOn(Launcher l, address who, bytes32 id) internal returns (Treasury tr) {
        bytes32 h = l.settingsHash();
        vm.prank(who);
        (,, address treasury,) = l.launch(id, "Project", "PRJ", Launcher.Terms({ratePpm: 1000, teamPool: POOL}), h);
        tr = Treasury(treasury);
    }

    /// @dev Vote the parked holders (`alice`, `bob`, `carol`) all onto `option`, end the vote and carry it out.
    function _win(uint32 id, uint8 option) internal {
        _toStandEnd(id);
        _cast(alice, option);
        _cast(bob, option);
        _cast(carol, option);
        _toVoteEnd(id);
        _toEffective(id);
        vote.carryOut(id);
    }

    // ------------------------------------------------ who may call it, and for what

    function test_councilByVoteIsOnlyCallableByTheProjectsPauseGate() public {
        address[5] memory m = _five();
        address[6] memory others = [founder, admin, stranger, alice, address(launcher), s1];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(Launcher.NotVoteCaller.selector);
            launcher.councilByVote(key, m, 1);
        }
        // the Treasury, the pause itself is the gate, but another project's gate on this Launcher is not
        Proj memory q = _launch(bob, "other", 500, POOL);
        address otherGate = q.t.pauseGate();
        assertTrue(otherGate != address(0) && otherGate != address(vote), "a second project has its own vote contract");
        vm.prank(otherGate);
        vm.expectRevert(Launcher.NotVoteCaller.selector);
        launcher.councilByVote(key, m, 1);
        // and a key that is not the gate's own project is refused too
        vm.prank(address(vote));
        vm.expectRevert(Launcher.NotVoteCaller.selector);
        launcher.councilByVote(q.key, m, 1);
        // the gate of the other project may make its own
        vm.prank(otherGate);
        address c2 = launcher.councilByVote(q.key, m, 1);
        assertEq(launcher.runnerKindOf(c2), 2, "a Council of the other project");
        // the project's own gate works, and the vote path does not take the seat by itself
        Council c = _makeByVote(m, 1);
        assertEq(address(c), _voteAddress(m, 1));
        assertEq(launcher.runnerKindOf(address(c)), 2);
        assertTrue(launcher.isCouncil(address(c)));
        assertEq(t.runner(), founder, "the vote path makes the Council; the vote contract seats it");
    }

    function test_withTheCouncilSwitchOffCouncilByVoteIsRefused() public {
        // a Launcher with the pause (a HolderVote) bound and no Council: its projects have a vote and no switch
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        l.bindPause(address(new HolderVote()));
        assertFalse(l.councilBound());
        Treasury tr = _launchOn(l, alice, "off");
        bytes32 k = l.keyOf(alice, "off");
        address[5] memory m = _five();
        vm.prank(tr.pauseGate());
        vm.expectRevert(Launcher.NoCouncil.selector);
        l.councilByVote(k, m, 1);
    }

    function test_aProjectAccountInTheFiveIsRefused() public {
        address[8] memory bad = [
            address(t),
            address(v),
            address(shares),
            address(team),
            address(t.tasks()),
            address(launcher),
            address(vote),
            address(councilImpl)
        ];
        for (uint256 i; i < bad.length; ++i) {
            assertTrue(launcher.isProjectAccount(key, bad[i]), "the view agrees with the refusal");
            address[5] memory m = _five();
            m[2] = bad[i];
            vm.prank(address(vote));
            vm.expectRevert(abi.encodeWithSelector(Launcher.BadSeatHolder.selector, bad[i]));
            launcher.councilByVote(key, m, 1);
        }
        // a runner contract this Launcher already made can never be a seat either
        Council hand = _makeCouncil();
        address[5] memory m = _five();
        m[0] = address(hand);
        vm.prank(address(vote));
        vm.expectRevert(abi.encodeWithSelector(Launcher.BadSeatHolder.selector, address(hand)));
        launcher.councilByVote(key, m, 2);
        // the zero address has no code to check and is refused by the Council itself
        m = _five();
        m[3] = address(0);
        vm.prank(address(vote));
        vm.expectRevert(Council.BadSetup.selector);
        launcher.councilByVote(key, m, 2);
        // a plain account and a contract that is none of the project's own stay allowed
        address smart = address(new QuoteHolder());
        assertFalse(launcher.isProjectAccount(key, smart));
        address[5] memory ok = [smart, s2, s3, s4, s5];
        Council c = _makeByVote(ok, 3);
        assertEq(launcher.runnerKindOf(address(c)), 2);
    }

    // --------------------------------------------------------- the address space

    function test_theVotePathAddressCommitsToTheKeyTheFiveAndTheBallotAndNoHandOverSaltCanProduceIt() public {
        address[5] memory m = _five();
        Council c1 = _makeByVote(m, 1);
        assertEq(address(c1), _voteAddress(m, 1), "the salt is the tag, the five accounts and the ballot");
        assertEq(Council(address(c1)).vote(), address(vote), "born with this vote contract");
        assertEq(address(Council(address(c1)).treasury()), address(t));
        // the same five accounts in another ballot are another address (so they can win twice)
        Council c2 = _makeByVote(m, 2);
        assertTrue(address(c2) != address(c1), "another ballot is another Council");
        // the same ballot once only: the address is taken
        vm.prank(address(vote));
        vm.expectRevert();
        launcher.councilByVote(key, m, 1);
        // another five, and another project's key, are other addresses
        address[5] memory other = [s1, s2, s3, s4, s6];
        assertTrue(address(_makeByVote(other, 1)) != address(c1), "another account is another Council");
        Treasury tr = _launchOn(launcher, voter, "another");
        bytes32 otherKey = launcher.keyOf(voter, "another");
        vm.prank(tr.pauseGate());
        assertTrue(launcher.councilByVote(otherKey, m, 1) != address(c1), "another project");
        // no hand-over salt can produce it, not even the salt equal to the ballot's own number
        bytes32[5] memory salts = [
            bytes32(0), bytes32(uint256(1)), bytes32(uint256(2)), keccak256("a salt"), keccak256(abi.encode(uint256(1)))
        ];
        for (uint256 i; i < salts.length; ++i) {
            assertTrue(launcher.councilAddress(key, m, salts[i]) != address(c1), "a hand-over salt made it");
        }
        // the two preimages differ by the tag (and the salt is a bytes32 where the ballot is a uint256)
        assertTrue(
            keccak256(abi.encode(key, "council-vote", m, uint256(1)))
                != keccak256(abi.encode(key, "council", m, bytes32(uint256(1)))),
            "the vote path has its own tag"
        );
    }

    // ------------------------------------------------- one end to end, and twice

    function test_oneFullEndToEndThroughCarryOutSeatsTheCouncilTheVoteMade() public {
        _park(alice, 10_000_000e18);
        _park(bob, 6_000_000e18);
        _park(carol, 4_000_000e18);
        uint32 id = _openReplace(alice, _five());
        // what the old runner leaves behind must not reach the new one
        vm.prank(founder);
        t.handOver(puppet, false);
        vm.prank(founder);
        t.proposeRate(1800);
        address expected = _voteAddress(_five(), id);
        assertEq(t.runner(), founder, "the founder still runs the project during the wait");

        vm.recordLogs();
        _win(id, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 carried;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vote) && logs[i].topics[0] == HolderVote.BallotCarriedOut.selector) {
                ++carried;
                assertEq(abi.decode(logs[i].data, (address)), expected, "the carried-out Council");
            }
            if (logs[i].emitter == address(launcher) && logs[i].topics[0] == Launcher.CouncilMade.selector) {
                (bool byVote) = abi.decode(logs[i].data, (bool));
                assertTrue(byVote, "made by the vote path, not a hand-over");
            }
        }
        assertEq(carried, 1, "one BallotCarriedOut");
        assertEq(t.runner(), expected, "the seat moved to the Council the vote made");
        assertEq(launcher.runnerKindOf(expected), 2, "registered kind 2");
        assertTrue(launcher.isCouncil(expected));
        assertEq(Council(expected).vote(), address(vote));
        (address[5] memory seats,) = Council(expected).seatList();
        address[5] memory five = _five();
        for (uint256 i; i < 5; ++i) {
            assertEq(seats[i], five[i], "the five the ballot chose, in order");
        }
        assertEq(t.pendingRunner(), address(0), "the offer the old runner made is cleared");
        assertEq(t.pendingRatePpm(), 0, "the rate it proposed is cleared");
    }

    function test_theSameFiveCanBeElectedTwiceAndAfterAHandOverCouncilOfTheSameFive() public {
        Council hand = _makeCouncil(); // a hand-over Council of the same five exists first
        assertEq(t.runner(), address(hand));
        _park(alice, 10_000_000e18);
        _park(bob, 6_000_000e18);
        _park(carol, 4_000_000e18);
        // ballot one: the same five win by vote, at an address no hand-over salt can be
        uint32 id1 = _openReplace(alice, _five());
        address first = _voteAddress(_five(), id1);
        assertTrue(first != address(hand), "the vote path is a different address space from the hand-over");
        _win(id1, 1);
        assertEq(t.runner(), first);
        // ballot two, after the seat moved: the same five again, another ballot id, another Council
        uint32 id2 = _openReplace(alice, _five());
        address second = _voteAddress(_five(), id2);
        assertTrue(second != first && second != address(hand));
        _win(id2, 1);
        assertEq(t.runner(), second, "the same five run the project through a second Council of their own");
        assertEq(launcher.runnerKindOf(address(hand)), 2);
        assertEq(launcher.runnerKindOf(first), 2);
        assertEq(launcher.runnerKindOf(second), 2);
        assertEq(vote.nextReplaceAt(), 0, "no cooldown after a result that moved the seat");
    }

    // ------------------------------------------------- the direct refusals

    function test_seatByVoteRefusesEveryoneButTheGateAndEveryAddressThatIsNotAKindTwoCouncil() public {
        Council c = _makeByVote(_five(), 1); // kind 2, not seated
        address[4] memory nobody = [founder, admin, stranger, address(launcher)];
        for (uint256 i; i < nobody.length; ++i) {
            vm.prank(nobody[i]);
            vm.expectRevert(Treasury.NotAllowed.selector);
            t.seatByVote(address(c));
        }
        // the gate itself may not seat what the Launcher did not make a Council
        vm.prank(address(vote));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.seatByVote(stranger);
        vm.prank(address(vote));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.seatByVote(address(0));
        // a Pair is kind 1
        Pair pair = _makePair(bob);
        vm.prank(address(vote));
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.seatByVote(address(pair));
        // and the gate seats the Council the vote made
        vm.prank(address(vote));
        t.seatByVote(address(c));
        assertEq(t.runner(), address(c));
    }

    function test_aProjectWithNoGateCannotBeSeatedByAVote() public {
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        Treasury tr = _launchOn(l, alice, "gate-less");
        assertEq(tr.pauseGate(), address(0));
        address[5] memory m = [alice, bob, carol, dave, stranger];
        address predicted = l.councilAddress(l.keyOf(alice, "gate-less"), m, bytes32(0));
        vm.prank(address(vote));
        vm.expectRevert(Treasury.NotAllowed.selector);
        tr.seatByVote(predicted);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        tr.seatByVote(stranger);
    }

    // ------------------------------------------------------------ binding

    function test_bindCouncilRefusesAPlainHolderPauseAndAcceptsAHolderVote() public {
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        l.bindPause(address(new HolderPause()));
        address councilImpl_ = address(new Council());
        vm.expectRevert(Launcher.NotVote.selector);
        l.bindCouncil(councilImpl_);
        assertEq(l.councilImpl(), address(0));
        assertFalse(l.councilBound());
        // a bound implementation with code that says it is not a vote is refused too
        Launcher l2 = new Launcher(admin, _platform(UNIT), parts);
        l2.bindPause(address(new NotAVote()));
        vm.expectRevert(Launcher.NotVote.selector);
        l2.bindCouncil(councilImpl_);
        // a HolderVote is accepted, once, with its code hash in the event
        Launcher l3 = new Launcher(admin, _platform(UNIT), parts);
        l3.bindPause(address(new HolderVote()));
        vm.recordLogs();
        l3.bindCouncil(councilImpl_);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], Launcher.CouncilBound.selector);
        (address impl, bytes32 h) = abi.decode(logs[0].data, (address, bytes32));
        assertEq(impl, councilImpl_);
        assertEq(h, councilImpl_.codehash);
        assertTrue(l3.councilBound());
        assertEq(l3.councilImpl(), councilImpl_);
    }

    // ---------------------------------------------------- the launch transaction

    function test_launchWithTheSwitchOnBindsTheProjectInTheSameTransaction() public {
        vm.recordLogs();
        Proj memory p = _launch(bob, "voted", 1000, POOL);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address gateAddr = p.t.pauseGate();
        uint256 bound;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == gateAddr && logs[i].topics[0] == HolderVote.ProjectBound.selector) {
                ++bound;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(p.t));
                assertEq(logs[i].topics[2], p.key);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), address(launcher));
            }
        }
        assertEq(bound, 1, "one ProjectBound, in the launch's own transaction");
        HolderVote gate = HolderVote(p.t.pauseGate());
        assertTrue(gate.isVote());
        assertEq(address(gate.treasury()), address(p.t), "the clone knows its Treasury");
        assertEq(gate.key(), p.key, "and its project's key");
        assertEq(address(gate.launcher()), address(launcher), "and the Launcher");
        assertEq(gate.day(), UNIT / 7);
        // the project is born with a clone of the vote contract as its pause, and the settings hash covers the switch
        assertTrue(launcher.holderPauseImpl() != address(0), "the deployment's pause switch is on");
        assertTrue(p.t.pauseGate() != launcher.holderPauseImpl(), "the project's own clone, not the implementation");
        assertEq(
            launcher.settingsHash(),
            keccak256(abi.encode(platformOfV(launcher), launcher.holderPauseImpl(), address(0), address(councilImpl))),
            "a launch on this deployment agrees to the Council switch"
        );
    }

    // ------------------------------------------------------- the settings hash

    function test_theFourthSettingsHashFormIsUsedWhenBothClaimsAndACouncilAreBoundAndTheCouncilTestComesFirst() public {
        Launcher l = new Launcher(admin, _platform(UNIT), parts);
        EarlierGrants e =
            new EarlierGrants(address(l), keccak256("root"), keccak256("text"), 1000e18, 4, l.keyOf(founder, "zero"));
        l.bindEarlier(address(e));
        address pauseImpl_ = address(new HolderVote());
        l.bindPause(pauseImpl_);
        address councilImpl_ = address(new Council());
        l.bindCouncil(councilImpl_);
        Launcher.Platform memory pf = platformOfV(l);
        assertEq(
            l.settingsHash(),
            keccak256(abi.encode(pf, pauseImpl_, address(e), councilImpl_)),
            "the four-part form: platform, pause, claims, Council"
        );
        assertTrue(
            l.settingsHash() != keccak256(abi.encode(pf, pauseImpl_, address(e))),
            "the Council test comes before the claims branch"
        );
        assertTrue(
            l.settingsHash() != keccak256(abi.encode(pf, pauseImpl_, address(0), councilImpl_)),
            "and the claim contract is in it"
        );
        assertTrue(l.settingsHash() != keccak256(abi.encode(pf, pauseImpl_)), "and the Council is in it");
    }
}

/// @dev A contract that is none of a project's own accounts (a smart account): allowed as a seat.
contract QuoteHolder {
    uint256 public x;
}
