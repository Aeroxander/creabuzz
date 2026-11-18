// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {WeeklyRoundsTest} from "./WeeklyRounds.t.sol";
contract ZzScratchEscrowVote is WeeklyRoundsTest {
    function test_escrowedSharesCountInVotingSupply() public {
        uint256 id = rounds.open(address(dao));
        _sell(id, ANA, 50e18, 0);
        vm.roll(block.number + 2);
        uint48 snap = uint48(block.number - 1);
        uint256 total = shares.totalSupply();
        emit log_named_uint("totalSupply", total);
        emit log_named_uint("rounds capacity at snap", ledger.getPastCapacity(address(rounds), snap));
        emit log_named_uint("ANA capacity at snap", ledger.getPastCapacity(ANA, snap));
        emit log_named_uint("votingSupplyAt", ledger.votingSupplyAt(total, snap));
        emit log_named_uint("ANA weightFor", ledger.weightFor(bytes32(uint256(999)), ANA, snap));
        assertEq(ledger.getPastCapacity(address(rounds), snap), 50e18);
        assertEq(ledger.votingSupplyAt(total, snap), total - ledger.getPastCapacity(address(dao), snap) - ledger.getPastCapacity(address(0xdead), snap));
    }
}
