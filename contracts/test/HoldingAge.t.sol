// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";

/// @notice How long each holder has held their Shares: one weighted-average acquisition time per holder, fed by the
/// same callback that keeps the vote ledger in step with the token.
contract HoldingAgeTest is VotingFixture {
    uint256 internal start;

    function setUp() public override {
        super.setUp();
        start = vm.getBlockTimestamp();
    }

    function _age(address who) internal view returns (uint256 balance, uint256 age) {
        return ledger.holdingAge(who);
    }

    // ---- where age starts -------------------------------------------------------------------

    function test_the_first_holders_start_when_the_dao_is_made() public {
        vm.warp(start + 10 days);
        (uint256 balance, uint256 age) = _age(ALICE);
        assertEq(balance, 100e18);
        assertEq(ledger.heldSince(ALICE), start, "the DAO was made in setUp");
        assertEq(age, 10 days, "counted from the summon");
    }

    function test_someone_with_no_shares_has_no_age() public view {
        (uint256 balance, uint256 age) = _age(CAROL);
        assertEq(balance, 0);
        assertEq(age, 0);
        assertEq(ledger.heldSince(CAROL), 0);
    }

    function test_loot_is_not_counted() public {
        mintLoot(CAROL, 50e18);
        vm.warp(start + 5 days);
        (uint256 balance, uint256 age) = _age(CAROL);
        assertEq(balance, 0, "Loot carries no vote and no reputation");
        assertEq(age, 0);
    }

    function test_new_shares_start_now() public {
        vm.warp(start + 30 days);
        vm.prank(address(dao));
        shares.mintFromMoloch(CAROL, 10e18);
        vm.warp(start + 32 days);
        (uint256 balance, uint256 age) = _age(CAROL);
        assertEq(balance, 10e18);
        assertEq(age, 2 days);
    }

    // ---- receiving moves the age, sending does not -------------------------------------------

    function test_receiving_more_blends_the_age_by_amount() public {
        vm.prank(ALICE);
        shares.transfer(BOB, 50e18);
        vm.warp(start + 10 days);
        vm.prank(ALICE);
        shares.transfer(BOB, 50e18);
        (uint256 balance, uint256 age) = _age(BOB);
        assertEq(balance, 100e18);
        assertEq(age, 5 days, "half held for ten days, half just arrived");
    }

    function test_a_small_top_up_barely_moves_a_long_holding() public {
        vm.warp(start + 100 days);
        uint256 before = ledger.heldSince(ALICE);
        vm.prank(address(dao));
        shares.mintFromMoloch(ALICE, 1e18);
        uint256 expected = (100e18 * before + 1e18 * block.timestamp) / 101e18;
        assertEq(ledger.heldSince(ALICE), expected);
        (, uint256 age) = _age(ALICE);
        assertGt(age, 99 days, "100 Shares held 100 days plus one new Share is still about 99 days");
        assertLt(age, 100 days);
    }

    function test_sending_does_not_change_the_senders_age() public {
        vm.warp(start + 20 days);
        uint256 since = ledger.heldSince(ALICE);
        vm.prank(ALICE);
        shares.transfer(BOB, 40e18);
        assertEq(ledger.heldSince(ALICE), since, "what is left was held just as long");
        (uint256 balance, uint256 age) = _age(ALICE);
        assertEq(balance, 60e18);
        assertEq(age, 20 days);
    }

    // ---- age cannot be moved to another wallet ----------------------------------------------

    function test_a_fresh_wallet_does_not_inherit_the_senders_age() public {
        vm.warp(start + 365 days);
        vm.prank(ALICE);
        shares.transfer(CAROL, 100e18);
        (uint256 balance, uint256 age) = _age(CAROL);
        assertEq(balance, 100e18);
        assertEq(age, 0, "a year of holding did not travel with the Shares");
    }

    function test_selling_everything_ends_the_holding_and_buying_back_starts_over() public {
        vm.warp(start + 200 days);
        vm.prank(ALICE);
        shares.transfer(BOB, 100e18);
        (uint256 balance, uint256 age) = _age(ALICE);
        assertEq(balance, 0);
        assertEq(age, 0);
        assertEq(ledger.heldSince(ALICE), 0, "the record is cleared");
        vm.warp(start + 210 days);
        vm.prank(BOB);
        shares.transfer(ALICE, 100e18);
        (, age) = _age(ALICE);
        assertEq(age, 0, "buying the same Shares back is a new holding");
    }

    function test_selling_part_and_buying_it_back_lowers_the_age() public {
        vm.warp(start + 100 days);
        vm.prank(ALICE);
        shares.transfer(BOB, 50e18);
        vm.warp(start + 110 days);
        vm.prank(BOB);
        shares.transfer(ALICE, 50e18);
        (uint256 balance, uint256 age) = _age(ALICE);
        assertEq(balance, 100e18);
        // 50 Shares held 110 days, 50 held 0 days.
        assertEq(age, 55 days);
    }

    function test_burning_everything_clears_the_age_and_a_partial_burn_keeps_it() public {
        vm.warp(start + 40 days);
        _leave(ALICE, 30e18);
        (uint256 balance, uint256 age) = _age(ALICE);
        assertEq(balance, 70e18);
        assertEq(age, 40 days);
        _leave(ALICE, 70e18);
        (balance, age) = _age(ALICE);
        assertEq(balance, 0);
        assertEq(age, 0);
        assertEq(ledger.heldSince(ALICE), 0);
    }

    // ---- nobody can write it ----------------------------------------------------------------

    function test_only_the_dao_can_report_an_ownership_change() public {
        vm.expectRevert();
        ledger.ownershipChanged(false, ALICE, CAROL, 1e18);
        assertEq(ledger.heldSince(CAROL), 0);
    }

    // ---- properties -------------------------------------------------------------------------

    /// @dev Receiving can only lower a holder's age (apart from the second lost to rounding), sending never changes
    /// it, and a holder with no Shares has no record: whatever the order of transfers and waits.
    function testFuzz_receiving_never_raises_age_and_sending_never_changes_it(
        uint8[24] memory who,
        uint16[24] memory howMuch,
        uint32[24] memory wait
    ) public {
        address[3] memory people = [ALICE, BOB, CAROL];
        for (uint256 i; i < 24; ++i) {
            vm.warp(vm.getBlockTimestamp() + uint256(wait[i]) % 30 days);
            address from = people[who[i] % 3];
            address to = people[(who[i] / 3) % 3];
            uint256 bal = shares.balanceOf(from);
            if (from == to || bal == 0) continue;
            uint256 amount = (uint256(howMuch[i]) % bal) + 1;
            (uint256 fromBalBefore, uint256 fromAgeBefore) = _age(from);
            (uint256 toBalBefore, uint256 toAgeBefore) = _age(to);
            vm.prank(from);
            shares.transfer(to, amount);
            (uint256 fromBalAfter, uint256 fromAgeAfter) = _age(from);
            (, uint256 toAgeAfter) = _age(to);
            assertEq(fromBalAfter, fromBalBefore - amount);
            if (fromBalAfter == 0) {
                assertEq(ledger.heldSince(from), 0, "an empty wallet has no record");
            } else {
                assertEq(fromAgeAfter, fromAgeBefore, "sending leaves the rest as old as it was");
            }
            if (toBalBefore != 0) {
                assertLe(toAgeAfter, toAgeBefore + 1, "receiving never makes a holding older");
            } else {
                assertEq(toAgeAfter, 0, "a wallet that held nothing starts at zero");
            }
        }
        // No holding is older than the DAO.
        for (uint256 i; i < 3; ++i) {
            (uint256 b, uint256 a) = _age(people[i]);
            if (b != 0) assertLe(a, vm.getBlockTimestamp() - start);
        }
    }

    /// @dev Shares burn only when their owner leaves (D73), so a test that needs fewer Shares has the holder leave.
    function _leave(address holder, uint256 amount) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(holder);
        dao.ragequit(tokens, amount, 0);
    }
}
