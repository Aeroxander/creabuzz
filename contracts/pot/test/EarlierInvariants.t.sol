// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EarlierBase, Row} from "./helpers/EarlierBase.sol";
import {EarlierHandler} from "./helpers/EarlierHandler.sol";
import {Vester} from "../src/Vester.sol";

/// @notice Stateful invariants of the earlier grants through the real stack, driven by `EarlierHandler` (claims by the right and
/// the wrong accounts, the runner filling listed accounts' ordinary slots, payouts, Team take-outs, joins, revenue, time and a
/// wind-down with the burn after it). The list is invented: twelve rows over three accounts, one of them with ten rows (more
/// than the eight a member may hold), so the cap is reached.
///  - the Vester holds at least what is promised plus the reserve, and the reserve plus what was claimed is exactly the pool;
///  - the claim contract never passes its pool, and its counters equal the rows marked;
///  - the protected grants add up to exactly what was claimed, and none changed after the claim;
///  - nobody holds more than 8 ordinary and 8 earlier grants (the hand-over trim stays bounded);
///  - the Team supply never grows after birth.
contract EarlierInvariantsTest is EarlierBase {
    EarlierHandler internal h;
    address[] internal accts;

    function setUp() public override {
        accts.push(row1);
        accts.push(row2);
        accts.push(row3);
        Row[] memory list = new Row[](12);
        for (uint256 i; i < 12; ++i) {
            // row1 has ten rows, row2 and row3 one each
            address a = i < 10 ? row1 : (i == 10 ? row2 : row3);
            list[i] = Row(i, a, (i % 3 + 1) * 10e18 + (i == 11 ? 0.9e18 : 0));
        }
        _setupWith(list, 0);
        bytes32[][] memory proofs = new bytes32[][](12);
        for (uint256 i; i < 12; ++i) {
            proofs[i] = _proofOf(list, i);
        }
        h = new EarlierHandler(usd, t, team, shares, v, earlier, founder, list, proofs, accts, clock);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](11);
        sel[0] = h.claim.selector;
        sel[1] = h.claim.selector;
        sel[2] = h.claimAsOther.selector;
        sel[3] = h.grantOrdinary.selector;
        sel[4] = h.payOut.selector;
        sel[5] = h.warp.selector;
        sel[6] = h.join.selector;
        sel[7] = h.revenue.selector;
        sel[8] = h.leaveTeam.selector;
        sel[9] = h.windDown.selector;
        sel[10] = h.burnAfterWindDown.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_theVesterAlwaysHoldsWhatIsPromisedPlusTheReserve() public view {
        assertGe(team.balanceOf(address(v)), v.committed() + v.earlierReserve());
    }

    function invariant_reservePlusClaimedIsThePool() public view {
        assertEq(v.earlierReserve() + earlier.claimedTotal(), earlier.total());
    }

    function invariant_theClaimContractNeverPassesItsPool() public view {
        assertLe(earlier.claimedTotal(), earlier.total());
    }

    function invariant_theCountersEqualTheRowsMarked() public view {
        uint256 rows_ = h.rowCount();
        uint256 marked;
        uint256 sum;
        for (uint256 i; i < rows_; ++i) {
            if (earlier.isClaimed(i)) {
                ++marked;
                sum += h.rowAt(i).amount;
            }
        }
        assertEq(uint256(earlier.claimedRows()), marked);
        assertEq(earlier.claimedTotal(), sum);
    }

    function invariant_protectedGrantsAddUpToWhatWasClaimed() public view {
        uint256 sum;
        uint256 n = v.grantCount();
        for (uint256 i; i < n; ++i) {
            Vester.Grant memory g = v.grantOf(i);
            if (g.protected_) sum += g.total;
        }
        assertEq(sum, earlier.claimedTotal(), "a protected grant never changes after it is made");
    }

    function invariant_nobodyHoldsMoreThanEightOfEachKind() public view {
        for (uint256 a; a < accts.length; ++a) {
            uint256[] memory ids = v.idsOf(accts[a]);
            uint256 prot;
            for (uint256 i; i < ids.length; ++i) {
                if (v.grantOf(ids[i]).protected_) ++prot;
            }
            assertLe(prot, 8, "earlier grants");
            assertLe(ids.length - prot, 8, "ordinary grants");
            assertLe(ids.length, 16, "the hand-over trim is bounded");
        }
    }

    function invariant_theTeamSupplyNeverGrowsAfterBirth() public view {
        assertLe(team.totalSupply(), POOL + poolTotal);
    }

    function invariant_aProtectedGrantStaysLiveAndProtectedWhateverHappens() public view {
        uint256 n = v.grantCount();
        for (uint256 i; i < n; ++i) {
            Vester.Grant memory g = v.grantOf(i);
            if (g.protected_) {
                assertEq(uint8(g.state), uint8(Vester.State.Live), "never announced, closed or burned");
                assertEq(g.start, v.earlierStart());
            }
        }
    }
}
