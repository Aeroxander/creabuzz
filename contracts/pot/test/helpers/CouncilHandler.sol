// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "oz5/proxy/Clones.sol";
import {Council} from "../../src/Council.sol";
import {FakeTreasury} from "./CouncilBase.sol";
import {ITreasuryRunner} from "../../src/Interfaces.sol";

/// @notice Drives a bare Council (a fake Treasury behind it, this handler as its vote contract) with random proposals,
/// agreements, withdrawals, resignations, elections and the passing of time, and keeps ghost counters that do not read the
/// Council's own counters, for the invariants to compare with.
contract CouncilHandler is Test {
    struct Pend {
        bytes data;
        uint256 n;
        bytes32 id;
    }

    uint256 internal constant UNIT = 7 days;
    Council public c;
    FakeTreasury public fake;
    address[8] public actors;
    Pend[] internal pend;
    uint256 public clock;
    // ghosts
    uint256 public ghostProposals;
    uint256 public ghostGeneration;
    uint256 public ghostExecuted;
    uint256 public ghostElections;
    uint64 public maxNextElection;
    bool public doubleRun;
    bool public executedUnderTwo;
    bool public nextElectionWrong;
    mapping(bytes32 => bool) public ran;

    constructor(Council impl, address launcherAddr, uint256 start) {
        clock = start;
        vm.warp(start);
        for (uint256 i; i < 8; ++i) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
        }
        fake = new FakeTreasury(uint32(UNIT), address(this));
        c = Council(Clones.clone(address(impl)));
        address[5] memory m = [actors[0], actors[1], actors[2], actors[3], actors[4]];
        vm.prank(launcherAddr);
        c.initialize(ITreasuryRunner(address(fake)), launcherAddr, m, false);
        fake.setCouncil(address(c));
        maxNextElection = c.nextElection();
    }

    function pendCount() external view returns (uint256) {
        return pend.length;
    }

    function pendAt(uint256 i) external view returns (bytes32 id, uint256 n, bytes memory data) {
        Pend storage p = pend[i];
        return (p.id, p.n, p.data);
    }

    function _who(uint256 seed) internal view returns (address) {
        return actors[seed % 8];
    }

    function _seatsNow() internal view returns (address[5] memory s) {
        (s,) = c.seatList();
    }

    function _differs(address[5] memory a, address[5] memory b) internal pure returns (bool) {
        for (uint256 i; i < 5; ++i) {
            if (a[i] != b[i]) return true;
        }
        return false;
    }

    function propose(uint256 seed) external {
        bytes memory data = abi.encodeCall(FakeTreasury.draw, (address(0xBEEF), 1 + seed % 1000));
        uint256 n = c.nonce();
        vm.prank(_who(seed));
        try c.propose(address(fake), data) {
            ++ghostProposals;
            pend.push(Pend(data, n, c.callId(address(fake), data, n)));
        } catch {}
    }

    function agree(uint256 seed, uint256 which) external {
        if (pend.length == 0) return;
        Pend memory p = pend[which % pend.length];
        (,, uint8 maskBefore) = c.proposals(p.id);
        uint256 drawsBefore = fake.draws();
        vm.prank(_who(seed));
        try c.agree(address(fake), p.data, p.n) {
            if (fake.draws() != drawsBefore) {
                ++ghostExecuted;
                if (ran[p.id]) doubleRun = true;
                ran[p.id] = true;
                if (_bits(maskBefore) != 2) executedUnderTwo = true;
            }
        } catch {}
    }

    function withdraw(uint256 seed, uint256 which) external {
        if (pend.length == 0) return;
        Pend memory p = pend[which % pend.length];
        vm.prank(_who(seed));
        try c.withdraw(p.id) {} catch {}
    }

    function resign(uint256 seed) external {
        vm.prank(_who(seed));
        try c.resign() {
            ++ghostGeneration;
        } catch {}
    }

    function pass(uint256 seed) external {
        clock += seed % (3 * UNIT);
        vm.warp(clock);
    }

    /// @dev Open the election when it is due (moving time there first when `jump`), then put random winners in.
    function election(uint256 seed, bool jump) external {
        if (jump && clock < c.nextElection()) {
            clock = c.nextElection();
            vm.warp(clock);
        }
        if (clock < c.nextElection()) return;
        uint8 a;
        uint8 b;
        try c.openElection() returns (uint8 a_, uint8 b_) {
            (a, b) = (a_, b_);
        } catch {
            return;
        }
        ++ghostElections;
        if (c.nextElection() != clock + 26 * UNIT) nextElectionWrong = true;
        if (c.nextElection() > maxNextElection) maxNextElection = c.nextElection();
        address[5] memory before = _seatsNow();
        // winners: any of the eight actors or nobody (seed picks)
        address w1 = seed % 9 == 8 ? address(0) : actors[seed % 9];
        address w2 = (seed / 9) % 9 == 8 ? address(0) : actors[(seed / 9) % 9];
        try c.seat(a, b, w1, w2) {
            if (_differs(before, _seatsNow())) ++ghostGeneration;
        } catch {}
    }

    function _bits(uint8 m) internal pure returns (uint256 n) {
        for (; m != 0; m &= m - 1) {
            ++n;
        }
    }
}
