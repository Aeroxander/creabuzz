// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {VotingFixture} from "./helpers/VotingFixture.sol";
import {Shares} from "../src/majeur/MolochPatched.sol";

/// @dev The Limit Break creator-token interface (`ICreatorToken`): its ERC-165 id is 0xad0d7f6c.
interface ICreatorTokenLike {
    event TransferValidatorUpdated(address oldValidator, address newValidator);

    function getTransferValidator() external view returns (address validator);
    function setTransferValidator(address validator) external;
    function getTransferValidationFunction() external view returns (bytes4 functionSignature, bool isViewFunction);
}

/// @dev A validator that records what it was asked and refuses what it is told to.
contract RecordingValidator {
    struct Call {
        address caller;
        address from;
        address to;
        uint256 tokenId;
        uint256 amount;
    }

    Call[] public calls;
    address public refuseTo;
    bool public refuseAll;
    address public registeredCollection;
    uint16 public registeredType;
    bool public refuseRegistration;

    error Refused();

    function refuseTransfersTo(address to) external {
        refuseTo = to;
    }

    function setRefuseAll(bool on) external {
        refuseAll = on;
    }

    function setRefuseRegistration(bool on) external {
        refuseRegistration = on;
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function validateTransfer(address caller, address from, address to, uint256 tokenId, uint256 amount) external {
        calls.push(Call(caller, from, to, tokenId, amount));
        if (refuseAll || (refuseTo != address(0) && to == refuseTo)) revert Refused();
    }

    function setTokenTypeOfCollection(address collection, uint16 tokenType) external {
        if (refuseRegistration) revert Refused();
        registeredCollection = collection;
        registeredType = tokenType;
    }
}

/// @dev A lock guard with settable locked amounts.
contract FixedLocks {
    mapping(address => uint256) public lockedOf;
    /// @dev The sum of `lockedOf`, as a real lock keeps it (D72).
    uint256 public totalLocked;

    function set(address holder, uint256 amount) external {
        totalLocked = totalLocked - lockedOf[holder] + amount;
        lockedOf[holder] = amount;
    }
}

/// @notice Can the DAO's Shares be an apptoken (ERC-20C) without breaking governance or the exit?
contract SharesCreatorTokenTest is VotingFixture {
    RecordingValidator internal validator;
    FixedLocks internal locks;
    address internal constant DAVE = address(0xDA7E);

    function setUp() public override {
        super.setUp();
        validator = new RecordingValidator();
        locks = new FixedLocks();
        vm.deal(address(dao), 10 ether);
    }

    function _setValidator(address v) internal {
        vm.prank(address(dao));
        shares.setTransferValidator(v);
    }

    function _setGuard(address g) internal {
        vm.prank(address(dao));
        shares.setLockGuard(g);
    }

    function _ragequit(address who, uint256 amount) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(who);
        dao.ragequit(tokens, amount, 0);
    }

    // ---- the ERC-20C surface ---------------------------------------------------------------------------

    function test_shares_present_the_creator_token_interface() public view {
        assertEq(type(ICreatorTokenLike).interfaceId, bytes4(0xad0d7f6c), "the id the standard defines");
        assertTrue(shares.supportsInterface(type(ICreatorTokenLike).interfaceId));
        assertTrue(shares.supportsInterface(0x01ffc9a7), "and ERC-165 itself");
        assertFalse(shares.supportsInterface(0xdeadbeef));
        assertEq(shares.owner(), address(dao), "the DAO is the collection admin a validator checks");
        (bytes4 selector, bool isView) = shares.getTransferValidationFunction();
        assertEq(selector, bytes4(keccak256("validateTransfer(address,address,address,uint256,uint256)")));
        assertFalse(isView);
        assertEq(shares.getTransferValidator(), address(0), "no validator until the DAO chooses one");
    }

    function test_only_the_dao_sets_a_validator_and_it_must_be_a_contract() public {
        vm.prank(ALICE);
        vm.expectRevert();
        shares.setTransferValidator(address(validator));
        vm.prank(address(dao));
        vm.expectRevert();
        shares.setTransferValidator(address(0x1234)); // no code there
        vm.expectEmit(address(shares));
        emit ICreatorTokenLike.TransferValidatorUpdated(address(0), address(validator));
        _setValidator(address(validator));
        assertEq(shares.getTransferValidator(), address(validator));
        assertEq(validator.registeredCollection(), address(shares), "the validator is told which token it guards");
        assertEq(validator.registeredType(), 20, "and that it is an ERC-20");
        _setValidator(address(0));
        assertEq(shares.getTransferValidator(), address(0), "the DAO can always take it away");
    }

    function test_a_validator_that_does_not_take_registration_is_still_accepted() public {
        validator.setRefuseRegistration(true);
        _setValidator(address(validator));
        assertEq(shares.getTransferValidator(), address(validator));
    }

    // ---- transfers go through the validator, exits do not ---------------------------------------------

    function test_plain_transfers_ask_the_validator_with_the_real_caller() public {
        _setValidator(address(validator));
        vm.prank(ALICE);
        shares.transfer(CAROL, 10e18);
        (address caller, address from, address to, uint256 tokenId, uint256 amount) = validator.calls(0);
        assertEq(caller, ALICE);
        assertEq(from, ALICE);
        assertEq(to, CAROL);
        assertEq(tokenId, 0);
        assertEq(amount, 10e18);

        // A router moving Shares for someone else is the caller: that is what a whitelist of operators needs.
        address router = address(0xB0B0);
        vm.prank(ALICE);
        shares.approve(router, 5e18);
        vm.prank(router);
        shares.transferFrom(ALICE, DAVE, 5e18);
        (caller, from, to,, amount) = validator.calls(1);
        assertEq(caller, router);
        assertEq(from, ALICE);
        assertEq(to, DAVE);
        assertEq(amount, 5e18);
    }

    function test_a_validator_can_block_a_transfer() public {
        _setValidator(address(validator));
        validator.refuseTransfersTo(DAVE);
        vm.prank(ALICE);
        vm.expectRevert(RecordingValidator.Refused.selector);
        shares.transfer(DAVE, 1e18);
        assertEq(shares.balanceOf(DAVE), 0);
        vm.prank(ALICE);
        shares.transfer(CAROL, 1e18); // others are fine
        assertEq(shares.balanceOf(CAROL), 1e18);
    }

    function test_the_validator_never_sees_a_mint_or_a_burn_so_it_cannot_block_an_exit() public {
        _setValidator(address(validator));
        validator.setRefuseAll(true); // a hostile or broken validator
        // Ragequit burns Shares: it works.
        uint256 before = ALICE.balance;
        _ragequit(ALICE, 40e18);
        assertEq(shares.balanceOf(ALICE), 60e18);
        assertGt(ALICE.balance, before, "and pays out");
        // The DAO can still mint (an award or a sale).
        vm.prank(address(dao));
        shares.mintFromMoloch(DAVE, 5e18);
        assertEq(shares.balanceOf(DAVE), 5e18);
        assertEq(validator.callCount(), 0, "none of that reached the validator");
        // And plain transfers are blocked, until the DAO takes the validator away.
        vm.prank(ALICE);
        vm.expectRevert(RecordingValidator.Refused.selector);
        shares.transfer(CAROL, 1e18);
        _setValidator(address(0));
        vm.prank(ALICE);
        shares.transfer(CAROL, 1e18);
    }

    function test_governance_accounting_still_follows_a_validated_transfer() public {
        _setValidator(address(validator));
        vm.prank(ALICE);
        shares.delegate(CAROL);
        vm.roll(block.number + 1);
        vm.prank(ALICE);
        shares.transfer(DAVE, 30e18);
        assertEq(ledger.capacity(ALICE), 70e18, "the ledger heard about the move");
        assertEq(ledger.capacity(DAVE), 30e18);
        assertEq(shares.delegates(ALICE), CAROL, "delegation is untouched");
        assertEq(shares.getVotes(CAROL), 70e18, "votes follow the delegation");
        assertEq(shares.getVotes(DAVE), 30e18);
    }

    // ---- the lock: vote with it, but neither sell it nor ragequit it -----------------------------------

    function test_locked_shares_vote_but_cannot_be_sold() public {
        locks.set(ALICE, 60e18);
        _setGuard(address(locks));
        // 40 are free, 60 are locked.
        vm.prank(ALICE);
        shares.transfer(CAROL, 40e18);
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transfer(CAROL, 1);
        // The router path is the same wall.
        vm.prank(ALICE);
        shares.approve(address(this), type(uint256).max);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transferFrom(ALICE, DAVE, 1);
        // Locked Shares still vote: the whole 60 is her capacity.
        assertEq(ledger.capacity(ALICE), 60e18);
        assertEq(shares.getVotes(ALICE), 60e18);
    }

    function test_locked_shares_cannot_be_ragequit_only_the_unlocked_part_can() public {
        locks.set(ALICE, 60e18);
        _setGuard(address(locks));
        _ragequit(ALICE, 40e18); // exactly her unlocked part
        assertEq(shares.balanceOf(ALICE), 60e18);
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        dao.ragequit(tokens, 1, 0);
        assertEq(shares.balanceOf(ALICE), 60e18, "nothing moved");
    }

    function test_earning_a_milestone_unlocks_the_share_it_covers() public {
        locks.set(ALICE, 60e18);
        _setGuard(address(locks));
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transfer(CAROL, 41e18);
        locks.set(ALICE, 30e18); // a milestone covering 30 is reached
        vm.prank(ALICE);
        shares.transfer(CAROL, 70e18);
        assertEq(shares.balanceOf(ALICE), 30e18);
        // What is still locked still cannot leave through the exit.
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        dao.ragequit(tokens, 1, 0);
    }

    function test_the_daos_own_shares_and_unlocked_holders_are_never_held_by_the_lock() public {
        locks.set(address(dao), 1000e18); // even a nonsense lock on the DAO changes nothing
        _setGuard(address(locks));
        vm.prank(address(dao));
        shares.mintFromMoloch(address(dao), 10e18);
        vm.prank(address(dao));
        shares.transfer(DAVE, 10e18);
        assertEq(shares.balanceOf(DAVE), 10e18);
        vm.prank(BOB); // holds only Loot: no Shares, no lock
        vm.expectRevert();
        shares.transfer(DAVE, 1);
    }

    function test_the_guard_is_set_once_so_no_vote_can_take_it_off_or_swap_it() public {
        locks.set(ALICE, 100e18);
        _setGuard(address(locks));
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transfer(CAROL, 1);
        // Only the DAO could ever change it, and the DAO cannot: not to nothing, not to a friendlier guard.
        vm.prank(ALICE);
        vm.expectRevert();
        shares.setLockGuard(address(0));
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        shares.setLockGuard(address(0));
        address friendlier = address(new FixedLocks()); // made first: a prank covers only the next call
        vm.prank(address(dao));
        vm.expectRevert(Shares.LockGuardSet.selector);
        shares.setLockGuard(friendlier);
        assertEq(shares.lockGuard(), address(locks));
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        shares.transfer(CAROL, 1);
    }

    // ---- size ------------------------------------------------------------------------------------------

    function test_the_patch_fits_in_the_token_and_leaves_the_governor_alone() public view {
        assertLe(address(shares).code.length, 24_576);
        assertLe(address(dao).code.length, 24_576);
        // The governor's headroom is what the whole design guards: this patch did not touch it.
        assertGe(24_576 - address(dao).code.length, 40);
    }
}
