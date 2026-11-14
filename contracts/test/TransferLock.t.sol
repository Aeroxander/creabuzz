// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {Shares} from "../src/majeur/MolochPatched.sol";

/// @dev The lock's surface, read through an interface so these tests compile (and fail) before it exists.
interface ITransferLock {
    function lockTransfersWithNotice(address exempt) external;
    function announceTransferUnlock() external;
    function cancelTransferUnlock() external;
    function transferExempt() external view returns (address);
    function unlockAnnouncedAt() external view returns (uint64);
}

/// D77 (docs/v3-review/TOKENOMICS-CONTRACT-CHANGES.md §5): Shares stay where they are except to and from one exempt
/// address (the auction), and lifting that lock takes effect only 30 days after it was announced.
contract TransferLockTest is VotingFixture {
    address internal constant AUCTION = address(0xA0C7);

    function setUp() public override {
        super.setUp();
        vm.prank(ALICE);
        shares.transfer(AUCTION, 40e18); // the auction holds Shares for its buyers
        _asDao(abi.encodeCall(ITransferLock.lockTransfersWithNotice, (AUCTION)));
    }

    function _asDao(bytes memory data) internal {
        vm.prank(address(dao));
        (bool ok, bytes memory ret) = address(shares).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function test_holders_cannot_send_shares_to_each_other() public {
        assertTrue(shares.transfersLocked());
        vm.prank(ALICE);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        shares.transfer(CAROL, 1e18);
    }

    function test_buyers_collect_from_the_auction_and_shares_can_go_to_it() public {
        assertEq(ITransferLock(address(shares)).transferExempt(), AUCTION);
        vm.prank(AUCTION);
        shares.transfer(CAROL, 10e18);
        assertEq(shares.balanceOf(CAROL), 10e18);
        vm.prank(ALICE);
        shares.transfer(AUCTION, 1e18);
        // And a buyer who collected cannot pass them on.
        vm.prank(CAROL);
        vm.expectRevert(bytes4(keccak256("Locked()")));
        shares.transfer(BOB, 1e18);
    }

    function test_lifting_the_lock_needs_thirty_days_notice() public {
        vm.prank(address(dao));
        vm.expectRevert();
        shares.setTransfersLocked(false);
        _asDao(abi.encodeCall(ITransferLock.announceTransferUnlock, ()));
        vm.warp(vm.getBlockTimestamp() + 30 days - 1);
        vm.prank(address(dao));
        vm.expectRevert();
        shares.setTransfersLocked(false);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(address(dao));
        shares.setTransfersLocked(false);
        vm.prank(ALICE);
        shares.transfer(CAROL, 1e18);
        assertEq(shares.balanceOf(CAROL), 1e18);
    }

    function test_through_the_dao_too() public {
        vm.prank(address(dao));
        vm.expectRevert();
        dao.setTransfersLocked(false, false);
    }

    function test_a_cancelled_notice_does_not_count_and_locking_again_is_immediate() public {
        _asDao(abi.encodeCall(ITransferLock.announceTransferUnlock, ()));
        _asDao(abi.encodeCall(ITransferLock.cancelTransferUnlock, ()));
        vm.warp(vm.getBlockTimestamp() + 31 days);
        vm.prank(address(dao));
        vm.expectRevert();
        shares.setTransfersLocked(false);
        _asDao(abi.encodeCall(ITransferLock.announceTransferUnlock, ()));
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(address(dao));
        shares.setTransfersLocked(false);
        vm.prank(address(dao));
        shares.setTransfersLocked(true);
        assertEq(ITransferLock(address(shares)).unlockAnnouncedAt(), 0, "a new unlock needs a new notice");
        vm.prank(address(dao));
        vm.expectRevert();
        shares.setTransfersLocked(false);
    }

    function test_the_exemption_and_the_notice_are_set_once() public {
        vm.prank(address(dao));
        vm.expectRevert();
        ITransferLock(address(shares)).lockTransfersWithNotice(CAROL);
        assertEq(ITransferLock(address(shares)).transferExempt(), AUCTION);
    }

    function test_leaving_and_awards_are_untouched_by_the_lock() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(ALICE);
        dao.ragequit(tokens, 10e18, 0);
        assertEq(shares.balanceOf(ALICE), 50e18);
    }

    /// @dev While locked, any holder sending any amount to anyone succeeds only when the exempt address is one side of it.
    function testFuzz_while_locked_shares_move_only_to_or_from_the_exempt_address(
        uint8 fromSeed,
        uint8 toSeed,
        uint96 amountSeed
    ) public {
        address[4] memory people = [ALICE, CAROL, AUCTION, address(0xBEEF)];
        address from = people[fromSeed % 4];
        address to = people[toSeed % 4];
        uint256 balance = shares.balanceOf(from);
        uint256 amount = balance == 0 ? 0 : bound(amountSeed, 1, balance);
        vm.prank(from);
        (bool ok,) = address(shares).call(abi.encodeCall(Shares.transfer, (to, amount)));
        bool exempt = from == AUCTION || to == AUCTION;
        if (!exempt) assertFalse(ok, "Shares moved between wallets while locked");
        if (exempt && amount <= balance) assertTrue(ok, "the auction could not move Shares");
    }
}
