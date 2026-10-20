// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {Shares} from "../src/majeur/MolochPatched.sol";

/// @dev Read through an interface so the test compiles (and fails) against a DAO without them.
interface IExitFlags {
    function leaving() external view returns (bool);
    function lockGuardSet() external view returns (bool);
}

/// @dev A lock guard a vote might try to install after birth: it would refuse every exit.
contract RefusingGuard {
    function lockedOf(address) external pure returns (uint256) {
        revert("no exit");
    }
}

/// D73 and D76 (docs/v3-review/TOKENOMICS-CONTRACT-CHANGES.md §2, §2a): nothing a vote passes can switch leaving off or
/// take a holder's exit away, and the DAO's own share sale, permits and allowances are gone.
contract ExitProtectionsTest is VotingFixture {
    address[] internal ether_;

    function setUp() public override {
        super.setUp();
        ether_.push(address(0));
        vm.deal(address(dao), 100 ether);
    }

    function test_no_vote_can_switch_leaving_off() public {
        vm.prank(address(dao));
        (bool ok,) = address(dao).call(abi.encodeWithSignature("setRagequittable(bool)", false));
        assertFalse(ok, "the switch is gone");
        assertTrue(dao.ragequittable());
        vm.prank(ALICE);
        dao.ragequit(ether_, 10e18, 0);
        assertGt(ALICE.balance, 0);
    }

    function test_the_daos_own_share_sale_is_gone() public {
        vm.prank(address(dao));
        (bool opened,) = address(dao).call(
            abi.encodeWithSignature(
                "setSale(address,uint256,uint256,bool,bool,bool)", address(0), uint256(1), uint256(0), true, true, false
            )
        );
        vm.deal(CAROL, 1 ether);
        vm.prank(CAROL);
        (bool bought,) = address(dao).call{value: 1e18}(
            abi.encodeWithSignature("buyShares(address,uint256,uint256)", address(0), uint256(1e18), uint256(0))
        );
        assertFalse(opened, "no sale can be opened");
        assertFalse(bought, "no Shares can be bought from the DAO");
        assertEq(shares.balanceOf(CAROL), 0);
    }

    function test_permits_cannot_run_calls_later() public {
        vm.prank(address(dao));
        (bool granted,) = address(dao).call(
            abi.encodeWithSignature(
                "setPermit(uint8,address,uint256,bytes,bytes32,address,uint256)",
                uint8(0),
                CAROL,
                uint256(1 ether),
                bytes(""),
                bytes32(0),
                CAROL,
                uint256(1)
            )
        );
        vm.prank(CAROL);
        (bool spent,) = address(dao).call(
            abi.encodeWithSignature(
                "spendPermit(uint8,address,uint256,bytes,bytes32)", uint8(0), CAROL, uint256(1 ether), bytes(""), bytes32(0)
            )
        );
        assertFalse(granted, "no permit can be granted");
        assertFalse(spent, "no permit can be spent");
        assertEq(CAROL.balance, 0);
    }

    function test_allowances_cannot_pay_out_of_the_treasury() public {
        vm.prank(address(dao));
        (bool granted,) = address(dao).call(
            abi.encodeWithSignature("setAllowance(address,address,uint256)", CAROL, address(0), uint256(1 ether))
        );
        vm.prank(CAROL);
        (bool spent,) =
            address(dao).call(abi.encodeWithSignature("spendAllowance(address,uint256)", address(0), uint256(1 ether)));
        assertFalse(granted, "no allowance can be granted");
        assertFalse(spent, "no allowance can be spent");
        assertEq(CAROL.balance, 0);
    }

    function test_no_vote_can_burn_a_holders_shares() public {
        vm.prank(address(dao));
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        shares.burnFromMoloch(ALICE, 1e18);
        assertEq(shares.balanceOf(ALICE), 100e18);
    }

    function test_no_vote_can_burn_a_holders_loot() public {
        vm.prank(address(dao));
        vm.expectRevert();
        loot.burnFromMoloch(BOB, 1e18);
        assertEq(loot.balanceOf(BOB), 100e18);
    }

    function test_leaving_still_burns_shares_and_loot() public {
        vm.prank(ALICE);
        dao.ragequit(ether_, 50e18, 0);
        vm.prank(BOB);
        dao.ragequit(ether_, 0, 50e18);
        assertEq(shares.balanceOf(ALICE), 50e18);
        assertEq(loot.balanceOf(BOB), 50e18);
        // 200 units, a quarter each: 25 ether, then a third of the remaining 75.
        assertEq(ALICE.balance, 25 ether);
        assertEq(BOB.balance, 25 ether);
        assertFalse(IExitFlags(address(dao)).leaving(), "the flag is cleared after the exit");
    }

    function test_choosing_no_lock_guard_is_final() public {
        vm.prank(address(dao));
        shares.setLockGuard(address(0));
        assertTrue(IExitFlags(address(shares)).lockGuardSet());
        address refusing = address(new RefusingGuard());
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        shares.setLockGuard(refusing);
        vm.prank(ALICE);
        dao.ragequit(ether_, 10e18, 0);
        assertGt(ALICE.balance, 0);
    }

    function test_a_lock_guard_is_final_once_set() public {
        address first = address(new RefusingGuard());
        address refusing = address(new RefusingGuard());
        vm.prank(address(dao));
        shares.setLockGuard(first);
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        shares.setLockGuard(refusing);
    }
}
