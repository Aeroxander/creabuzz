// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {Call, Moloch, Summoner, Shares, Loot, newSummoner} from "../../src/majeur/MolochPatched.sol";
import {ConvictionVoting} from "../../src/ConvictionVoting.sol";

abstract contract VotingFixture is Test {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);
    Moloch internal dao;
    ConvictionVoting internal ledger;
    Shares internal shares;
    Loot internal loot;

    function setUp() public virtual {
        vm.warp(1 days);
        Summoner summoner = newSummoner();
        address[] memory holders = new address[](1);
        holders[0] = ALICE;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100e18;
        dao = summoner.summon("Org", "ORG", "", 5000, true, address(0), bytes32(0), holders, amounts, new Call[](0));
        ledger = ConvictionVoting(dao.votingWeight());
        shares = dao.shares();
        loot = dao.loot();
        vm.prank(address(dao));
        loot.mintFromMoloch(BOB, 100e18);
        vm.prank(address(dao));
        dao.setProposalTTL(14 days);
        vm.prank(address(dao));
        dao.setTimelockDelay(1 days);
        vm.roll(block.number + 1);
    }

    function vote(address owner, uint256 id, uint256 amount) internal {
        vm.prank(owner);
        dao.castVote(id, 1, amount);
    }

    function mintLoot(address owner, uint256 amount) internal {
        vm.prank(address(dao));
        loot.mintFromMoloch(owner, amount);
    }
}
