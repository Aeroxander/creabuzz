// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {StackBase} from "./helpers/StackBase.sol";
import {PotHandler} from "./helpers/PotHandler.sol";
import {Vester} from "../src/Vester.sol";

/// @notice Stateful invariants of one project run through the real stack by `PotHandler`: many actors, joins, leaves,
/// Team leaves, outside payments arriving, forfeits, vesting, draws, rate changes, check-ins, lapses and a wind-down.
/// The handler also records, step by step, the rules that need a before and an after (price never falls on a join, no step
/// but a spend or a fee lowers a Share's worth, the Team never reaches paid-in money, a full exit pays everyone the same per
/// Share and never more than the pot); the last invariant here reads that record.
contract PotInvariantsTest is StackBase {
    PotHandler internal h;
    address[] internal who;

    function setUp() public override {
        super.setUp();
        h = new PotHandler(usd, t, shares, team, v, founder, POOL);
        who = h.actorsList();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](21);
        sel[0] = h.join.selector;
        sel[1] = h.leave.selector;
        sel[2] = h.leaveTeam.selector;
        sel[3] = h.revenue.selector;
        sel[4] = h.warp.selector;
        sel[5] = h.checkIn.selector;
        sel[6] = h.draw.selector;
        sel[7] = h.lowerRate.selector;
        sel[8] = h.proposeRate.selector;
        sel[9] = h.applyRate.selector;
        sel[10] = h.grant.selector;
        sel[11] = h.claim.selector;
        sel[12] = h.ownExit.selector;
        sel[13] = h.executeForfeit.selector;
        sel[14] = h.collectFees.selector;
        sel[15] = h.toggleDoor.selector;
        sel[16] = h.windDown.selector;
        sel[17] = h.probeFullExit.selector;
        sel[18] = h.join.selector; // joins twice as likely as most steps: nothing else happens without money
        sel[19] = h.teamPath.selector;
        sel[20] = h.leaveTeam.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// @dev The dollars the Treasury holds always cover every bucket it owes.
    function invariant_theTreasuryHoldsAtLeastWhatItOwes() public view {
        uint256 owed = t.pot() + t.box() + t.arriving() + t.feesOwed() + t.locked() + t.notesOwed();
        assertGe(usd.balanceOf(address(t)), owed, "the contract owes more dollars than it holds");
    }

    /// @dev With no donations, every dollar that went in and has not come out sits in exactly one bucket.
    function invariant_everyDollarIsInOneBucket() public view {
        uint256 owed = t.pot() + t.box() + t.arriving() + t.feesOwed();
        assertEq(usd.balanceOf(address(t)), h.cashIn() - h.cashOut(), "balance is dollars in less dollars out");
        assertEq(owed, h.cashIn() - h.cashOut(), "the buckets add up to dollars in less dollars out");
    }

    /// @dev Shares and Team Shares in anyone's hands add up to the token supplies the Treasury reads as B and G.
    function invariant_suppliesAreTheSumOfBalances() public view {
        uint256 b;
        uint256 g = team.balanceOf(address(v));
        for (uint256 i; i < who.length; ++i) {
            b += shares.balanceOf(who[i]);
            g += team.balanceOf(who[i]);
        }
        assertEq(b, shares.totalSupply(), "backer Shares in hands equal the supply");
        assertEq(g, team.totalSupply(), "Team Shares in hands and in the Vester equal the supply");
    }

    /// @dev Paid-in is zero with no backers, and never more than what joins put in net of fees.
    function invariant_paidInStaysInStep() public view {
        if (shares.totalSupply() == 0) assertEq(t.paidIn(), 0, "paid-in with no backers");
        assertLe(t.paidIn(), h.creditedMax(), "paid-in is more than was ever paid in");
    }

    /// @dev After a step the box is within seven days of accrual.
    function invariant_theBoxIsWithinItsCap() public view {
        assertLe(t.box(), t.boxCap(), "the box is over its cap");
    }

    /// @dev The burn queue is exactly the announced, unburned Team Shares, and is never more than all Team Shares.
    function invariant_theBurnQueueIsTheAnnouncedPart() public view {
        uint256 queued;
        uint256 owed;
        for (uint256 id; id < v.grantCount(); ++id) {
            Vester.Grant memory g = v.grantOf(id);
            owed += g.total - g.claimed + g.burn;
            if (g.state == Vester.State.Announced) queued += g.burn;
        }
        assertEq(t.Z(), queued, "Z is the announced part");
        assertLe(t.Z(), team.totalSupply(), "Z is within G");
        assertEq(v.committed(), owed, "committed is exactly what the grants are owed");
        assertGe(team.balanceOf(address(v)), v.committed(), "the Vester holds what it owes");
    }

    /// @dev Team Shares are made once, at birth.
    function invariant_teamSharesAreNeverCreatedAfterBirth() public view {
        assertLe(team.totalSupply(), POOL, "Team supply above the pool");
    }

    /// @dev The step rules the handler checks with a before and an after.
    function invariant_noStepBrokeARule() public view {
        assertEq(h.violation(), "", "a step broke a rule");
    }

    /// @dev Print how many steps of each kind a run made, so a green run can be seen to have done something.
    function afterInvariant() public {
        bytes32[] memory names = h.stepNames();
        for (uint256 i; i < names.length; ++i) {
            emit log_named_uint(string(abi.encodePacked(names[i])), h.count(names[i]));
        }
    }
}
