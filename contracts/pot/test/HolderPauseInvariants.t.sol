// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PauseBase} from "./helpers/PauseBase.sol";
import {PauseHandler} from "./helpers/PauseHandler.sol";

/// @notice Stateful invariants of the holder pause, run through the real stack by `PauseHandler` (six actors; joins, leaves,
/// park, un-park, poke, draw, announce, time). After every step: what the contract says is parked equals the sum of what each
/// holder parked and is held in custody; parked never passes the backer Shares; an armed clock always has the line reached
/// (the join hook's invariant: no unseen dip); `paused()` is never true when the line is not reached; and the handler's own
/// before-and-after rules hold (no dollar moves because of park, un-park or poke; the two gated calls refuse exactly while
/// paused).
contract HolderPauseInvariantsTest is PauseBase {
    PauseHandler internal h;
    address[] internal who;

    function setUp() public override {
        super.setUp();
        h = new PauseHandler(usd, t, shares, pause, founder);
        who = h.actorsList();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](13);
        sel[0] = h.join.selector;
        sel[1] = h.join.selector;
        sel[2] = h.leave.selector;
        sel[3] = h.park.selector;
        sel[4] = h.parkToLine.selector;
        sel[5] = h.parkToLine.selector;
        sel[6] = h.unpark.selector;
        sel[7] = h.poke.selector;
        sel[8] = h.warp.selector;
        sel[9] = h.warp.selector;
        sel[10] = h.draw.selector;
        sel[11] = h.announce.selector;
        sel[12] = h.leave.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_parkedTotalIsTheSumOfWhatEachHolderParked() public view {
        uint256 sum;
        for (uint256 i; i < who.length; ++i) {
            sum += pause.parkedOf(who[i]);
        }
        assertEq(pause.parkedTotal(), sum);
    }

    function invariant_theContractHoldsAtLeastWhatIsParked() public view {
        assertGe(shares.balanceOf(address(pause)), pause.parkedTotal());
    }

    function invariant_parkedNeverPassesTheBackerShares() public view {
        assertLe(pause.parkedTotal(), shares.totalSupply());
    }

    /// @dev At the end of every transaction a clock that is armed has the line reached: nothing lowers the ratio without the
    /// pause seeing it (the join calls `poke`, un-park looks, and leaving only raises the ratio).
    function invariant_anArmedClockImpliesTheLineIsReached() public view {
        if (pause.armedAt() != 0) {
            assertGt(shares.totalSupply(), 0);
            assertGe(pause.parkedTotal() * 3, shares.totalSupply(), "armed over a line that is not reached");
        }
    }

    function invariant_pausedNeverWhenUnderTheLine() public view {
        if (pause.paused()) {
            assertGe(pause.parkedTotal() * 3, shares.totalSupply());
            assertGt(shares.totalSupply(), 0);
        }
    }

    /// @dev The Treasury holds at least what it owes: the pause cannot have taken a dollar.
    function invariant_theTreasuryStillCoversEveryBucket() public view {
        uint256 owed = t.pot() + t.box() + t.arriving() + t.feesOwed() + t.locked() + t.notesOwed();
        assertGe(usd.balanceOf(address(t)), owed);
        assertEq(usd.balanceOf(address(pause)), 0, "the pause never holds a dollar");
    }

    function invariant_theHandlersOwnRulesHeld() public view {
        assertEq(bytes(h.violation()).length, 0, h.violation());
    }

    function afterInvariant() public {
        emit log_named_uint("steps", h.steps());
        emit log_named_uint("steps that began paused", h.pausedSeen());
        emit log_named_uint("steps that began armed", h.armedSeen());
        emit log_named_uint("gated calls refused for the pause", h.refusals());
        emit log_named_uint("gated calls that went through", h.allowed());
    }
}
