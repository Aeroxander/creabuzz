// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CouncilBase} from "./CouncilBase.sol";
import {HolderVote} from "../../src/HolderVote.sol";

/// @notice The stack of `CouncilBase` (the Council switch ON: a `HolderVote` pause and a bound `Council`) with the small
/// actions every vote test needs: parking, opening a ballot, standing, voting, and moving to a phase. Holder accounts are
/// `alice`, `bob`, `carol` and `dave` (they back the default project); `s1` to `s5` are the Council's seats and the usual list.
abstract contract VoteBase is CouncilBase {
    HolderVote internal vote;
    uint256 internal constant WHOLE = 1e18;

    function setUp() public virtual override {
        super.setUp();
        vote = HolderVote(address(t.pauseGate()));
        _join(alice, 200_000e6);
        _join(bob, 100_000e6);
        _join(carol, 60_000e6);
        _join(dave, 40_000e6);
        _join(stranger, 100_000e6);
    }

    // ------------------------------------------------------------- accounts

    function _list() internal view returns (address[5] memory m) {
        m = [s1, s2, s3, s4, s5];
    }

    function _listB() internal view returns (address[5] memory m) {
        m = [alice, bob, carol, dave, stranger];
    }

    // ------------------------------------------------------- park and unpark

    function _park(address who, uint256 n) internal {
        vm.startPrank(who);
        shares.approve(address(vote), n);
        vote.park(n);
        vm.stopPrank();
    }

    function _unpark(address who, uint256 n) internal {
        vm.prank(who);
        vote.unpark(n);
    }

    // --------------------------------------------------------------- opening

    function _openReplace(address by, address[5] memory m) internal returns (uint32 id) {
        vm.prank(by);
        id = vote.openReplace(m, keccak256("list text"));
        assertEq(vote.current(), id, "the ballot is current");
    }

    function _openSeats() internal returns (uint32 id) {
        id = vote.openSeats();
        assertEq(vote.current(), id, "the ballot is current");
    }

    // -------------------------------------------------------------- standing

    function _standList(address by, address[5] memory m) internal returns (uint8 option) {
        vm.prank(by);
        option = vote.standList(m, keccak256("list text"));
    }

    function _stand(address by) internal returns (uint8 option) {
        vm.prank(by);
        option = vote.stand(keccak256("person text"));
    }

    // ---------------------------------------------------------------- voting

    function _cast(address who, uint8 option) internal {
        vm.prank(who);
        vote.castVote(option);
    }

    // ----------------------------------------------------------------- times

    function _ballotAt(uint32 id) internal view returns (HolderVote.Ballot memory b) {
        b = vote.ballot(id);
    }

    /// @dev Move to the first second of voting (the stand window is over).
    function _toStandEnd(uint32 id) internal {
        HolderVote.Ballot memory b = _ballotAt(id);
        _warpTo(uint256(b.standEnd));
    }

    /// @dev Move to the first second of the wait (the vote is over, the tallies are frozen).
    function _toVoteEnd(uint32 id) internal {
        HolderVote.Ballot memory b = _ballotAt(id);
        _warpTo(uint256(b.voteEnd));
    }

    /// @dev Move to the second a won result may be carried out.
    function _toEffective(uint32 id) internal {
        HolderVote.Ballot memory b = _ballotAt(id);
        _warpTo(uint256(b.effectiveAt));
    }

    // ------------------------------------------------------------ one ballot

    /// @dev Park `by` enough to open, open a replace vote for the list `m`, and return the id.
    function _replaceVote(address by, address[5] memory m) internal returns (uint32 id) {
        uint256 have = vote.parkedOf(by);
        if (have < 10_000_000e18) _park(by, 10_000_000e18 - have);
        id = _openReplace(by, m);
    }
}
