// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CouncilBase} from "./helpers/CouncilBase.sol";
import {MockPair} from "./helpers/Mocks.sol";
import {Council} from "../src/Council.sol";
import {Treasury} from "../src/Treasury.sol";
import {Launcher} from "../src/Launcher.sol";

/// @notice What a Council may do, against what the Treasury's own built interface says it could ask for. Every state-changing
/// function of the Treasury is classified here (a new one makes the first test fail until it is placed): on the list and
/// working through three seats, off the list because only a Pair may do it, or not a runner call at all.
contract CouncilAccessTest is CouncilBase {
    address internal worker = makeAddr("worker");
    address internal dave2 = makeAddr("member");
    bytes32 internal constant WHAT = keccak256("a task a council plans");

    function setUp() public override {
        super.setUp();
        _join(alice, 100_000e6);
        _join(bob, 50_000e6);
        _makeCouncil();
        _warp(2 days);
        _councilCheckIn();
    }

    /// @dev The names of the functions in a built ABI that change state (the filter syntax of the JSON cheatcodes cannot
    /// select them, so the entries are read one at a time).
    function _stateChanging(string memory path) internal view returns (string[] memory names) {
        string memory json = vm.readFile(path);
        string[] memory all = new string[](200);
        uint256 n;
        for (uint256 i;; ++i) {
            string memory at = string.concat(".abi[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, at)) break;
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(at, ".type")))) != keccak256("function")) {
                continue;
            }
            string memory m = vm.parseJsonString(json, string.concat(at, ".stateMutability"));
            if (keccak256(bytes(m)) == keccak256("view") || keccak256(bytes(m)) == keccak256("pure")) continue;
            all[n++] = vm.parseJsonString(json, string.concat(at, ".name"));
        }
        names = new string[](n);
        for (uint256 i; i < n; ++i) {
            names[i] = all[i];
        }
    }

    /// @dev The runner calls a Council may make: 15 of the Treasury's functions.
    function _listed() internal pure returns (string[15] memory l) {
        l = [
            "acceptTask",
            "announceTask",
            "authoriseAgent",
            "cancelTask",
            "checkIn",
            "draw",
            "grantTeam",
            "handOver",
            "proposeRate",
            "rejectTask",
            "revokeAgent",
            "setAgent",
            "setDoor",
            "setRate",
            "windDown"
        ];
    }

    /// @dev Everything else that changes state: the one runner call only a Pair may make, and the calls nobody runs through
    /// the runner seat at all (anyone's, the Launcher's, the Vester's, the vote's, birth).
    function _others() internal pure returns (string[20] memory o) {
        o = [
            "announceForfeit",
            "addRevenue",
            "applyRate",
            "bindPause",
            "burnAfterWindDown",
            "claimNote",
            "collectFees",
            "forfeitAnnounced",
            "forfeitBurn",
            "initialize",
            "join",
            "leave",
            "leaveTeam",
            "markWoundDown",
            "onTransferReceived",
            "returnTask",
            "seatByVote",
            "settle",
            "takeSeat",
            "takeTask"
        ];
    }

    function _has(string memory name, string[] memory abiNames) internal pure returns (bool) {
        for (uint256 i; i < abiNames.length; ++i) {
            if (keccak256(bytes(abiNames[i])) == keccak256(bytes(name))) return true;
        }
        return false;
    }

    function test_everyStateChangingFunctionOfTheTreasuryIsClassified() public view {
        string[] memory abiNames = _stateChanging("out/Treasury.sol/Treasury.json");
        string[15] memory l = _listed();
        string[20] memory o = _others();
        assertEq(abiNames.length, l.length + o.length, "a state-changing function was added or removed: classify it");
        for (uint256 i; i < l.length; ++i) {
            assertTrue(_has(l[i], abiNames), l[i]);
        }
        for (uint256 i; i < o.length; ++i) {
            assertTrue(_has(o[i], abiNames), o[i]);
        }
    }

    function test_theListIsExactlyTheClassifiedOnesAndEveryOtherSelectorIsRefusedAtPropose() public {
        string[] memory sigs = vm.parseJsonKeys(vm.readFile("out/Treasury.sol/Treasury.json"), ".methodIdentifiers");
        string[15] memory l = _listed();
        uint256 listedFound;
        for (uint256 i; i < sigs.length; ++i) {
            bytes4 sel = bytes4(keccak256(bytes(sigs[i])));
            bytes memory data = abi.encodePacked(sel, new bytes(64));
            bool isListed = false;
            for (uint256 k; k < l.length; ++k) {
                string memory sg = sigs[i];
                // the name is what comes before the bracket
                bytes memory b = bytes(sg);
                uint256 cut;
                while (cut < b.length && b[cut] != "(") ++cut;
                bytes memory nm = new bytes(cut);
                for (uint256 q; q < cut; ++q) {
                    nm[q] = b[q];
                }
                if (keccak256(nm) == keccak256(bytes(l[k]))) isListed = true;
            }
            assertEq(council.listed(address(t), data), isListed, sigs[i]);
            if (isListed) {
                ++listedFound;
                uint256 n = council.nonce();
                _propRaw(s1, address(t), data);
                assertEq(council.nonce(), n + 1, "it can be proposed");
            } else {
                vm.expectRevert(Council.BadCall.selector);
                _propRaw(s1, address(t), data);
            }
        }
        assertEq(listedFound, 15);
    }

    // ---- every listed call, through three seats

    function test_drawCheckInAndTheRate() public {
        _warp(1 days);
        t.settle();
        uint256 amount = t.box() / 2;
        _run(abi.encodeCall(Treasury.draw, (worker, amount)));
        assertEq(usd.balanceOf(worker), amount, "draw");
        uint64 before = t.lastCheckIn();
        _warp(1 days);
        _councilCheckIn();
        assertGt(t.lastCheckIn(), before, "check in");
        _run(abi.encodeCall(Treasury.setRate, (500)));
        assertEq(t.ratePpm(), 500, "set a lower rate at once");
        _run(abi.encodeCall(Treasury.proposeRate, (900)));
        assertEq(t.pendingRatePpm(), 900, "propose a higher rate");
        _warp(UNIT);
        _councilCheckIn();
        t.applyRate();
        assertEq(t.ratePpm(), 900, "the proposed rate applies after a unit");
    }

    function test_theDoor() public {
        assertTrue(t.doorFlag());
        _run(abi.encodeCall(Treasury.setDoor, (false)));
        assertFalse(t.doorFlag());
        _run(abi.encodeCall(Treasury.setDoor, (true)));
        assertTrue(t.doorFlag());
    }

    function test_grantTeamSharesAndTheAgents() public {
        _run(abi.encodeCall(Treasury.grantTeam, (dave2, 1000e18)));
        assertEq(v.grantCount(), 1, "grant");
        _run(abi.encodeCall(Treasury.setAgent, (worker, 5e6, 7e18)));
        (bool active, uint128 usdCap, uint128 shareCap) = t.agents(worker);
        assertTrue(active);
        assertEq(usdCap, 5e6);
        assertEq(shareCap, 7e18);
        _run(abi.encodeCall(Treasury.revokeAgent, (worker)));
        (active,,) = t.agents(worker);
        assertFalse(active);
        _run(abi.encodeCall(Treasury.authoriseAgent, (worker)));
        (active, usdCap,) = t.agents(worker);
        assertTrue(active);
        assertEq(usdCap, 25e6, "the default limit");
    }

    function test_aTaskIsPlannedTakenAndPaidInPartThroughThreeSeats() public {
        _run(abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 2000e6, 100)));
        uint64 serial = _book().nextSerial() - 1;
        _warpAlive(_book().taskOf(serial).noticeEnd - clock);
        vm.prank(worker);
        t.takeTask(serial, 0);
        _run(abi.encodeCall(Treasury.acceptTask, (serial, 400e6)));
        assertEq(usd.balanceOf(worker), 400e6, "accept pays the taker");
    }

    function test_aTaskCanBeRejectedOrCancelledThroughThreeSeats() public {
        _run(abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 2000e6, 100)));
        uint64 serial = _book().nextSerial() - 1;
        _run(abi.encodeCall(Treasury.cancelTask, (serial)));
        _run(abi.encodeCall(Treasury.announceTask, (WHAT, address(0), 2000e6, 100)));
        uint64 serial2 = _book().nextSerial() - 1;
        _warpAlive(_book().taskOf(serial2).noticeEnd - clock);
        vm.prank(worker);
        t.takeTask(serial2, 0);
        uint256 potBefore = t.pot();
        _run(abi.encodeCall(Treasury.rejectTask, (serial2)));
        assertGe(t.pot(), potBefore, "the money set aside came back");
    }

    function test_theSeatCanBeHandedOnWithoutTrimmingAndTheProjectWoundDown() public {
        _run(abi.encodeCall(Treasury.handOver, (s6, false)));
        assertEq(t.pendingRunner(), s6);
        assertFalse(t.pendingTrim());
        vm.prank(s6);
        t.takeSeat();
        assertEq(t.runner(), s6, "a Council can hand the seat on");
    }

    function test_theCouncilWindsTheProjectDownByChoice() public {
        _run(abi.encodeCall(Treasury.windDown, ()));
        assertEq(t.windDownKind(), 1);
    }

    // ---- what a Council cannot do

    function test_aForfeitAndATrimAreRefusedAtProposeAndNothingIsStored() public {
        uint256 stored = council.nonce();
        vm.expectRevert(Council.BadCall.selector);
        _propRaw(s1, address(t), abi.encodeCall(Treasury.announceForfeit, (0)));
        vm.expectRevert(Council.BadCall.selector);
        _propRaw(s1, address(t), abi.encodeCall(Treasury.handOver, (s6, true)));
        assertEq(council.nonce(), stored);
    }

    // ---- the Treasury refuses on its own

    /// @dev A stand-in registered as a Council (kind 2) holds the runner seat and executes calls with `bothSigned` true: the
    /// Treasury must still refuse the two Pair-only powers, whatever the Council's own list says.
    function test_theTreasuryItselfRefusesAForfeitAndATrimFromAnyKindTwoRunner() public {
        _use(_launch(alice, "like", 1000, POOL));
        _grant(dave2, 5000e18); // grant 0 exists, so a forfeit would have something to announce
        MockPair like = new MockPair(alice, s6); // the project's founder is its first "signer"
        _register(address(like), 2);
        vm.prank(alice);
        t.handOver(address(like), false);
        like.exec(address(t), abi.encodeCall(Treasury.takeSeat, ()), false);
        assertEq(t.runner(), address(like));
        // a kind-2 runner that is not executing an agreed proposal is no runner at all
        (bool ok, bytes memory ret) = like.exec(address(t), abi.encodeCall(Treasury.setDoor, (false)), false);
        assertFalse(ok, "a Council-kind runner needs its seats' agreement for every runner call");
        assertEq(bytes4(ret), Treasury.NotAllowed.selector);
        assertTrue(t.doorFlag());
        // control: a plain hand-over is accepted from it
        (ok,) = like.exec(address(t), abi.encodeCall(Treasury.handOver, (s5, false)), true);
        assertTrue(ok, "a hand-over without a trim is a runner call");
        (ok, ret) = like.exec(address(t), abi.encodeCall(Treasury.announceForfeit, (0)), true);
        assertFalse(ok, "no forfeit from a kind-2 runner");
        assertEq(bytes4(ret), Treasury.NotAllowed.selector);
        (ok, ret) = like.exec(address(t), abi.encodeCall(Treasury.handOver, (s4, true)), true);
        assertFalse(ok, "no trim from a kind-2 runner, even one whose first signer is the founder");
        assertEq(bytes4(ret), Treasury.NotAllowed.selector);
    }

    function test_theCouncilAbiHasNoSeatTransferAndNoMoneyMover() public view {
        string[] memory sigs = vm.parseJsonKeys(vm.readFile("out/Council.sol/Council.json"), ".methodIdentifiers");
        // the whole external surface of a Council, by name: nothing moves a token, an approval or a seat
        string[27] memory expected = [
            "PROPOSAL_TTL()",
            "PROPOSAL_UNITS()",
            "ELECTION_UNITS()",
            "SEATS()",
            "THRESHOLD()",
            "agree(address,bytes,uint256)",
            "agreedCount(bytes32)",
            "bothSigned()",
            "callId(address,bytes,uint256)",
            "generation()",
            "initialize(address,address,address[5],bool)",
            "isSeat(address)",
            "launcher()",
            "listed(address,bytes)",
            "nextElection()",
            "nonce()",
            "openElection()",
            "propose(address,bytes)",
            "proposals(bytes32)",
            "resign()",
            "seat(uint8,uint8,address,address)",
            "seatList()",
            "seatOf(uint8)",
            "treasury()",
            "unit()",
            "upNext()",
            "vote()"
        ];
        // withdraw(bytes32) is the 28th
        assertEq(sigs.length, expected.length + 1, "the Council has exactly the functions listed here and withdraw");
        for (uint256 i; i < expected.length; ++i) {
            bool found;
            for (uint256 j; j < sigs.length; ++j) {
                if (keccak256(bytes(sigs[j])) == keccak256(bytes(expected[i]))) found = true;
            }
            assertTrue(found, expected[i]);
        }
    }
}
