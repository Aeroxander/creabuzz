// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Council} from "../src/Council.sol";
import {CouncilHandler} from "./helpers/CouncilHandler.sol";

/// @notice Random proposals, agreements, withdrawals, resignations, elections and time against a bare Council. The ghost
/// counters live in the handler and do not read the Council's own counters (the generation, the nonce, the number of
/// executions), so each invariant compares two independent counts.
contract CouncilInvariantsTest is Test {
    CouncilHandler internal h;
    Council internal c;

    function setUp() public {
        Council impl = new Council();
        h = new CouncilHandler(impl, address(0xA11CE), 1_700_000_000);
        c = h.c();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](6);
        sel[0] = CouncilHandler.propose.selector;
        sel[1] = CouncilHandler.agree.selector;
        sel[2] = CouncilHandler.withdraw.selector;
        sel[3] = CouncilHandler.resign.selector;
        sel[4] = CouncilHandler.election.selector;
        sel[5] = CouncilHandler.pass.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_noAccountHoldsTwoSeatsAndTheZeroAddressNone() public view {
        (address[5] memory s,) = c.seatList();
        for (uint256 i; i < 5; ++i) {
            for (uint256 j = i + 1; j < 5; ++j) {
                assertTrue(s[i] == address(0) || s[i] != s[j], "one account on two seats");
            }
            assertEq(c.isSeat(s[i]), s[i] != address(0), "a seat holder is a seat, an open seat is nobody");
        }
        assertFalse(c.isSeat(address(0)));
    }

    function invariant_theGenerationCountsSeatChangesAndNothingElse() public view {
        assertEq(c.generation(), h.ghostGeneration());
    }

    function invariant_theNonceCountsProposals() public view {
        assertEq(c.nonce(), h.ghostProposals());
    }

    function invariant_aCallRunsOnceAndOnlyOnTheThirdAgreement() public view {
        assertEq(h.fake().draws(), h.ghostExecuted(), "every execution is one the handler saw");
        assertFalse(h.doubleRun(), "a call ran twice");
        assertFalse(h.executedUnderTwo(), "a call ran without exactly two agreements before the third");
    }

    function invariant_noPendingRecordHoldsThreeAgreements() public view {
        for (uint256 i; i < h.pendCount(); ++i) {
            (bytes32 id,,) = h.pendAt(i);
            assertLe(c.agreedCount(id), 2, "three agreements run the call and delete the record");
        }
    }

    function invariant_theCouncilHoldsNothingAndIsNeverLeftExecuting() public view {
        assertEq(address(c).balance, 0);
        assertFalse(c.bothSigned());
    }

    function invariant_theNextElectionOnlyMovesForwardAndIsExactlyTwentySixUnitsAfterTheOneBefore() public view {
        assertGe(c.nextElection(), 1_700_000_000 + 26 * 7 days);
        assertEq(c.nextElection(), h.maxNextElection());
        assertFalse(h.nextElectionWrong());
    }

    function invariant_seatTimesAreHonest() public view {
        (address[5] memory s, uint64[5] memory at) = c.seatList();
        for (uint256 i; i < 5; ++i) {
            (,, uint64 lastUp) = c.seatOf(uint8(i));
            assertLe(at[i], block.timestamp);
            assertLe(lastUp, block.timestamp);
            if (s[i] == address(0)) assertEq(at[i], 0, "an open seat has no date");
        }
    }
}
