// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Call, Moloch, Summoner, newSummoner} from "../src/majeur/MolochPatched.sol";

/// @notice Regression for the bricked-DAO finding: the web Summon dialog sends `summon(...)` with
/// no initCalls. Every other fixture sets the proposal TTL and timelock by pranking the DAO, which
/// production cannot do, so none of them ever saw a DAO that was born unable to govern itself.
/// Nothing here pranks the DAO: it only calls what a stranger's wallet could call.
contract SummonDefaultsTest is Test {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    function _bareSummon() internal returns (Moloch dao) {
        vm.warp(1 days);
        Summoner summoner = newSummoner();
        address[] memory holders = new address[](2);
        holders[0] = ALICE;
        holders[1] = BOB;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 60e18;
        amounts[1] = 40e18;
        // Exactly what web/src/features/projects/lib/summon-composer.ts sends.
        dao = summoner.summon("Org", "ORG", "", 500, true, address(0), bytes32(0), holders, amounts, new Call[](0));
        vm.roll(block.number + 1);
    }

    function test_a_bare_summon_is_born_able_to_open_a_proposal() public {
        Moloch dao = _bareSummon();
        assertEq(dao.proposalTTL(), 14 days, "default TTL");
        assertEq(dao.timelockDelay(), 1 days, "default timelock");
        bytes memory data = abi.encodeCall(Moloch.setQuorumBps, (uint16(1000)));
        uint256 id = dao.proposalId(0, address(dao), 0, data, bytes32("n"));
        vm.prank(ALICE);
        dao.castVote(id, 1, 60e18);
        assertEq(dao.createdAt(id), uint64(block.timestamp), "the first ballot opened it");
    }

    function test_a_bare_summoned_dao_can_change_its_own_rules_end_to_end() public {
        Moloch dao = _bareSummon();
        bytes memory data = abi.encodeCall(Moloch.setProposalThreshold, (uint96(5e18)));
        bytes32 nonce = bytes32("raise the bar");
        uint256 id = dao.proposalId(0, address(dao), 0, data, nonce);
        vm.prank(ALICE);
        dao.castVote(id, 1, 60e18);
        vm.warp(block.timestamp + 48 hours);
        dao.queue(id);
        vm.warp(block.timestamp + 1 days);
        dao.executeByVotes(0, address(dao), 0, data, nonce);
        assertEq(dao.proposalThreshold(), 5e18, "the DAO governed itself with no prank and no initCalls");
    }

    function test_init_calls_can_still_replace_the_defaults() public {
        vm.warp(1 days);
        Summoner summoner = newSummoner();
        address[] memory holders = new address[](1);
        holders[0] = ALICE;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100e18;
        // Lower the delay first: the TTL must exceed 48h plus the current delay.
        // The DAO address is predictable, but a summon's initCalls run from the DAO itself, so
        // target the predicted clone exactly as OrgBinding does.
        bytes32 salt = bytes32(uint256(7));
        address predicted = _predict(summoner, holders, amounts, salt);
        Call[] memory calls = new Call[](2);
        calls[0] = Call(predicted, 0, abi.encodeCall(Moloch.setTimelockDelay, (uint64(12 hours))));
        calls[1] = Call(predicted, 0, abi.encodeCall(Moloch.setProposalTTL, (uint64(4 days))));
        Moloch dao = summoner.summon("Org", "ORG", "", 500, true, address(0), salt, holders, amounts, calls);
        assertEq(address(dao), predicted);
        assertEq(dao.timelockDelay(), 12 hours);
        assertEq(dao.proposalTTL(), 4 days);
    }

    /// @dev The Summoner's CREATE2 clone address, mirroring OrgBinding's prediction.
    function _predict(Summoner summoner, address[] memory holders, uint256[] memory amounts, bytes32 salt)
        internal
        view
        returns (address)
    {
        bytes32 create2Salt = keccak256(abi.encode(holders, amounts, salt));
        bytes memory creationCode = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", summoner.getImplementation(), hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(summoner), create2Salt, keccak256(creationCode)))))
        );
    }
}
