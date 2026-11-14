// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {Moloch} from "../src/majeur/MolochPatched.sol";
import {ContributorKitV2Base} from "./ContributorKitV2.t.sol";

/// @dev Every other trading test stands the DAO in for the vote with `vm.prank(dao)`. This one publishes the listing
/// the way a project does: a member opens the proposal, votes, the review and delay pass, and the proposal executes
/// `configureListing` on the market. Time moves with `vm.getBlockTimestamp()`, never `block.timestamp`, which the
/// via-IR build can read once and reuse across a `vm.warp`.
contract SecondaryListingVoteTest is ContributorKitV2Base {
    function test_a_listing_goes_live_through_a_real_vote() public {
        (Moloch dao,,, SecondaryMarket market) = _launchV2(_params("vote"));
        vm.roll(block.number + 2);
        vm.warp(vm.getBlockTimestamp() + 1);

        (bool enabledBefore,,,) = market.listing();
        assertFalse(enabledBefore, "trading is off until the DAO decides");
        vm.expectRevert(SecondaryMarket.ListingNotEnabled.selector);
        market.openRound();

        bytes memory data = abi.encodeCall(SecondaryMarket.configureListing, (true, 100e18, 400e18, 3));
        bytes32 nonce = bytes32("list-it");

        vm.prank(FOUNDER);
        uint256 id = dao.openProposalWithAction(0, address(market), 0, data, nonce);
        vm.prank(FOUNDER);
        dao.castVote(id, 1, 200e18);

        // Still inside the two-day review: the vote alone does not publish anything.
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert();
        dao.queue(id);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.queue(id);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dao.executeByVotes(0, address(market), 0, data, nonce);

        (bool enabled, uint128 lo, uint128 hi, uint32 levels) = market.listing();
        assertTrue(enabled, "the vote published the listing");
        assertEq(lo, 100e18);
        assertEq(hi, 400e18);
        assertEq(levels, 3);
        assertEq(market.openRound(), 1, "and anyone can open the week's round");
    }

    function test_nobody_but_a_passed_vote_publishes_a_listing() public {
        (Moloch dao,,, SecondaryMarket market) = _launchV2(_params("no-vote"));
        vm.roll(block.number + 2);
        vm.warp(vm.getBlockTimestamp() + 1);

        // The founder holds every Share, and still cannot publish one by calling the market.
        vm.prank(FOUNDER);
        vm.expectRevert(SecondaryMarket.NotDao.selector);
        market.configureListing(true, 100e18, 400e18, 3);

        // A proposal that nobody has voted for is not a decision.
        bytes memory data = abi.encodeCall(SecondaryMarket.configureListing, (true, 100e18, 400e18, 3));
        vm.prank(FOUNDER);
        dao.openProposalWithAction(0, address(market), 0, data, bytes32("unvoted"));
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.expectRevert();
        dao.executeByVotes(0, address(market), 0, data, bytes32("unvoted"));
        (bool enabled,,,) = market.listing();
        assertFalse(enabled);
    }
}
