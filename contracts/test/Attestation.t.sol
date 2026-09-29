// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {ClaimStake} from "../src/ClaimStake.sol";

contract MockUSD {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "mock insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "mock allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "mock insufficient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract AttestationTest is Test {
    address treasury = address(0xBEEF);
    address verifierA = address(0xA11CE1);
    address verifierB = address(0xB0B);
    address contributor = address(0xC0FFEE);
    address other = address(0xD00D);
    address stranger = address(0x57A9);
    MockUSD usd;
    VerifierSet verifiers;
    ClaimStake stake;

    bytes32 constant CLAIM = keccak256("milestone-1");
    bytes32 constant CLAIM2 = keccak256("milestone-2");

    function setUp() public {
        usd = new MockUSD();
        verifiers = new VerifierSet(treasury, 2); // quorum 2 of 2
        stake = new ClaimStake(verifiers, treasury, address(usd));
        vm.startPrank(treasury);
        verifiers.acceptVerifier(verifierA);
        verifiers.acceptVerifier(verifierB);
        usd.mint(treasury, 10_000e6);
        usd.approve(address(stake), 10_000e6);
        vm.stopPrank();

        // Contributors mint + approve the stake the claim pulls from THEM.
        usd.mint(contributor, 1_000e6);
        vm.prank(contributor);
        usd.approve(address(stake), 1_000e6);
        usd.mint(other, 1_000e6);
        vm.prank(other);
        usd.approve(address(stake), 1_000e6);
    }

    function _submit(bytes32 id, address who, uint256 amount, uint256 stakeAmt, bytes32 evidence) internal {
        vm.prank(who);
        stake.submitClaim(id, amount, stakeAmt, evidence);
    }

    function _fund(bytes32 id, uint256 amount) internal {
        vm.prank(treasury);
        stake.fund(id, amount);
    }

    function _attestBoth(bytes32 id, bool approve) internal {
        vm.prank(verifierA);
        verifiers.attest(id, approve);
        vm.prank(verifierB);
        verifiers.attest(id, approve);
    }

    // ------------------------------------------------------------- release

    function test_release_only_on_quorum() public {
        _submit(CLAIM, contributor, 500e6, 50e6, keccak256("evidence"));
        _fund(CLAIM, 500e6);
        // No quorum yet: cannot settle.
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.settle(CLAIM);
        // One approval: still no quorum.
        vm.prank(verifierA);
        verifiers.attest(CLAIM, true);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.settle(CLAIM);
        // Second approval: quorum reached, release happens; contributor can
        // pull payout + stake.
        vm.prank(verifierB);
        verifiers.attest(CLAIM, true);
        stake.settle(CLAIM);
        vm.prank(contributor);
        stake.payout(CLAIM);
        assertEq(usd.balanceOf(contributor), 1_500e6, "payout + stake returned (1000 minted - 50 stake + 550 payout)");
        assertEq(uint256(_status(CLAIM)), uint256(ClaimStake.Status.Paid), "claim is paid");
        assertEq(usd.balanceOf(address(stake)), 0, "nothing left in the escrow");
    }

    // --------------------------------------------------------------- slash

    /// The "slash" used to only flip a status flag: the stake sat in the
    /// contract forever. Removing the transfer in `settle` fails this test.
    function test_objection_quorum_slashes_the_stake_to_the_treasury() public {
        _submit(CLAIM, contributor, 500e6, 50e6, keccak256("spam"));
        _fund(CLAIM, 500e6);
        uint256 treasuryBefore = usd.balanceOf(treasury); // 9_500e6 after the reserve
        _attestBoth(CLAIM, false);
        stake.settle(CLAIM);
        assertEq(uint256(_status(CLAIM)), uint256(ClaimStake.Status.Rejected), "spam claim rejected");
        // 50e6 stake + the 500e6 reserved for the rejected claim both go home.
        assertEq(usd.balanceOf(treasury), treasuryBefore + 550e6, "stake slashed + reserve recovered");
        assertEq(usd.balanceOf(address(stake)), 0, "nothing stranded in the escrow");
        assertEq(usd.balanceOf(contributor), 950e6, "the contributor lost the stake");
        (, , uint256 stakeLeft, , ) = stake.claims(CLAIM);
        assertEq(stakeLeft, 0, "the slashed stake is zeroed");
        assertEq(stake.funded(CLAIM), 0);
        // The contributor cannot pull anything from a rejected claim.
        vm.prank(contributor);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.payout(CLAIM);
    }

    function test_rejected_claim_with_no_stake_and_no_reserve_settles_without_a_transfer() public {
        _submit(CLAIM, contributor, 500e6, 0, keccak256("spam"));
        _attestBoth(CLAIM, false);
        stake.settle(CLAIM);
        assertEq(uint256(_status(CLAIM)), uint256(ClaimStake.Status.Rejected));
    }

    // ---------------------------------------------------------------- fund

    /// `fund(from, amount)` used to let the treasury pull ANY allowance a
    /// contributor had granted the escrow (the contributor approved it for their
    /// own stake). Funding is now pulled from `msg.sender` only, and only the
    /// treasury may call it.
    function test_fund_pulls_only_from_the_treasury_never_a_contributors_allowance() public {
        _submit(CLAIM, contributor, 500e6, 50e6, keccak256("evidence"));
        uint256 contributorBefore = usd.balanceOf(contributor);
        uint256 allowanceBefore = usd.allowance(contributor, address(stake));

        _fund(CLAIM, 500e6);
        assertEq(usd.balanceOf(contributor), contributorBefore, "the contributor's balance is untouched");
        assertEq(usd.allowance(contributor, address(stake)), allowanceBefore, "so is their allowance");
        assertEq(usd.balanceOf(treasury), 9_500e6, "the treasury paid");

        // A stranger cannot fund (nor pull a contributor's allowance by naming it).
        vm.prank(stranger);
        vm.expectRevert(ClaimStake.NotTreasury.selector);
        stake.fund(CLAIM, 1);
        // Not even the contributor themselves.
        vm.prank(contributor);
        vm.expectRevert(ClaimStake.NotTreasury.selector);
        stake.fund(CLAIM, 1);
    }

    function test_fund_is_per_claim_capped_and_state_checked() public {
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.UnknownClaim.selector, CLAIM));
        stake.fund(CLAIM, 1);

        _submit(CLAIM, contributor, 500e6, 0, keccak256("evidence"));
        _fund(CLAIM, 300e6);
        vm.prank(treasury);
        vm.expectRevert(
            abi.encodeWithSelector(ClaimStake.OverFunded.selector, CLAIM, 300e6, 300e6, 500e6)
        );
        stake.fund(CLAIM, 300e6);
        _fund(CLAIM, 200e6);
        assertEq(stake.funded(CLAIM), 500e6);

        // A frozen (or otherwise closed) claim takes no more money.
        vm.prank(treasury);
        stake.freeze(CLAIM);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.ClaimClosed.selector, CLAIM));
        stake.fund(CLAIM, 0);
    }

    // ------------------------------------------- per-claim reservation / drain

    /// `amount` is self-declared. A contributor claiming 1,000e6 against a
    /// contract that holds someone else's stake used to be paid out of it. Now a
    /// payout only ever comes out of the claim's own reservation.
    function test_a_payout_cannot_drain_another_contributors_stake() public {
        // `other` stakes 500e6 on a small claim (this is the money at risk).
        _submit(CLAIM2, other, 10e6, 500e6, keccak256("victim"));
        // `contributor` self-declares a huge claim that the treasury never funded.
        _submit(CLAIM, contributor, 1_000e6, 0, keccak256("greedy"));
        assertEq(usd.balanceOf(address(stake)), 500e6, "only the victim's stake is escrowed");

        _attestBoth(CLAIM, true);
        stake.settle(CLAIM);
        vm.prank(contributor);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.Underfunded.selector, CLAIM, 0, 1_000e6));
        stake.payout(CLAIM);
        assertEq(usd.balanceOf(address(stake)), 500e6, "the victim's stake is untouched");

        // A partial reservation still does not pay a full claim.
        _fund(CLAIM, 400e6);
        vm.prank(contributor);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.Underfunded.selector, CLAIM, 400e6, 1_000e6));
        stake.payout(CLAIM);
        assertEq(usd.balanceOf(address(stake)), 900e6);
    }

    function test_each_claim_is_paid_only_from_its_own_reservation() public {
        _submit(CLAIM, contributor, 500e6, 50e6, keccak256("a"));
        _submit(CLAIM2, other, 500e6, 50e6, keccak256("b"));
        _fund(CLAIM, 500e6); // only claim A is reserved
        _attestBoth(CLAIM, true);
        _attestBoth(CLAIM2, true);
        stake.settle(CLAIM);
        stake.settle(CLAIM2);

        // B is approved but unfunded: it cannot borrow A's reservation.
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.Underfunded.selector, CLAIM2, 0, 500e6));
        stake.payout(CLAIM2);

        vm.prank(contributor);
        stake.payout(CLAIM);
        assertEq(usd.balanceOf(contributor), 1_500e6);
        // B's stake is still fully backed after A's payout.
        assertEq(usd.balanceOf(address(stake)), 50e6, "exactly B's stake remains");
        // The treasury funds B late; B is then paid in full.
        _fund(CLAIM2, 500e6);
        vm.prank(other);
        stake.payout(CLAIM2);
        assertEq(usd.balanceOf(other), 1_500e6);
        assertEq(usd.balanceOf(address(stake)), 0);
    }

    // ------------------------------------------------------------- freeze

    function test_freeze_stops_payout() public {
        _submit(CLAIM, contributor, 500e6, 50e6, keccak256("evidence"));
        vm.prank(treasury);
        stake.freeze(CLAIM);
        assertEq(uint256(_status(CLAIM)), uint256(ClaimStake.Status.Frozen), "frozen");
        // Verifier approval after a freeze cannot release it.
        _attestBoth(CLAIM, true);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.AlreadySettled.selector, CLAIM));
        stake.settle(CLAIM);
    }

    /// A frozen claim used to strand its escrow (stake + reserved payout) for
    /// good. `resolveFrozen` returns the treasury's reserve to the treasury and
    /// the contributor's stake to the contributor — a freeze is a suspension,
    /// not a verdict, so the treasury cannot seize the stake.
    function test_frozen_claim_funds_are_recoverable() public {
        _submit(CLAIM, contributor, 500e6, 50e6, keccak256("evidence"));
        _fund(CLAIM, 500e6);
        vm.prank(treasury);
        stake.freeze(CLAIM);
        assertEq(usd.balanceOf(address(stake)), 550e6, "stranded without resolveFrozen");

        vm.prank(stranger);
        vm.expectRevert(ClaimStake.NotTreasury.selector);
        stake.resolveFrozen(CLAIM);

        vm.prank(treasury);
        stake.resolveFrozen(CLAIM);
        assertEq(usd.balanceOf(treasury), 10_000e6, "the treasury got its reserve back");
        assertEq(usd.balanceOf(contributor), 1_000e6, "the contributor got their stake back");
        assertEq(usd.balanceOf(address(stake)), 0, "nothing stranded");
        assertEq(uint256(_status(CLAIM)), uint256(ClaimStake.Status.Recovered));

        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotFrozen.selector, CLAIM));
        stake.resolveFrozen(CLAIM);
        vm.prank(contributor);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.payout(CLAIM);
    }

    function test_resolve_requires_a_frozen_claim_and_freeze_only_takes_live_claims() public {
        _submit(CLAIM, contributor, 500e6, 0, keccak256("evidence"));
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotFrozen.selector, CLAIM));
        stake.resolveFrozen(CLAIM); // still Open

        // A slashed (Rejected) claim can no longer be frozen back to life.
        _attestBoth(CLAIM, false);
        stake.settle(CLAIM);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.AlreadySettled.selector, CLAIM));
        stake.freeze(CLAIM);

        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.UnknownClaim.selector, CLAIM2));
        stake.freeze(CLAIM2);
    }

    // ------------------------------------------------------------- quorum

    /// With quorum 0 `approvals >= quorum` held for every claim, so anyone could
    /// `settle` a claim nobody attested. Both entry points now refuse 0.
    function test_quorum_must_be_at_least_one() public {
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.BadQuorum.selector, 0));
        new VerifierSet(treasury, 0);

        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.BadQuorum.selector, 0));
        verifiers.setQuorum(0);
        assertEq(verifiers.quorum(), 2, "quorum unchanged");

        vm.prank(treasury);
        verifiers.setQuorum(1);
        assertEq(verifiers.quorum(), 1);
    }

    function test_nobody_can_settle_an_unattested_claim() public {
        _submit(CLAIM, contributor, 500e6, 50e6, keccak256("evidence"));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.settle(CLAIM);
        // Nor a claim that does not exist.
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.UnknownClaim.selector, CLAIM2));
        stake.settle(CLAIM2);
    }

    // ------------------------------------------------------------ binding

    /// `attest` binds only a claimId. Without the submit-time snapshot, verifiers
    /// who attested an id BEFORE the claim existed would approve whoever
    /// registered the id first — an attacker front-running the contributor with a
    /// different payee and amount. Post-submit counting makes the id worthless
    /// until verifiers attest the claim as it actually sits on chain.
    function test_attestations_made_before_the_claim_exists_do_not_count() public {
        // Verifiers approve the id off the contributor's off-chain claim event.
        _attestBoth(CLAIM, true);
        // An attacker front-runs the contributor's submit with their own payee.
        _submit(CLAIM, other, 999e6, 0, keccak256("attacker-evidence"));
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.NotOpen.selector, CLAIM));
        stake.settle(CLAIM);
        assertEq(stake.approvalsAtSubmit(CLAIM), 2, "the stale approvals are snapshotted out");
        // Verifiers who cannot attest twice cannot resurrect it either.
        vm.prank(verifierA);
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.AlreadyAttested.selector, CLAIM, verifierA));
        verifiers.attest(CLAIM, true);
    }

    function test_a_claim_needs_a_nonzero_evidence_hash_so_ids_cannot_be_overwritten() public {
        vm.prank(contributor);
        vm.expectRevert(ClaimStake.NoEvidence.selector);
        stake.submitClaim(CLAIM, 500e6, 50e6, bytes32(0));
    }

    function test_single_claim_per_evidence_hash() public {
        _submit(CLAIM, contributor, 500e6, 50e6, keccak256("evidence"));
        vm.expectRevert(abi.encodeWithSelector(ClaimStake.AlreadySettled.selector, CLAIM));
        stake.submitClaim(CLAIM, 500e6, 50e6, keccak256("evidence2"));
    }

    function test_verifier_slash_is_treasury_only() public {
        vm.expectRevert(abi.encodeWithSelector(VerifierSet.OnlyOwner.selector, verifierA));
        vm.prank(verifierA);
        verifiers.slash(verifierB, 100);
    }

    function _status(bytes32 id) internal view returns (ClaimStake.Status) {
        (, , , ClaimStake.Status status, ) = stake.claims(id);
        return status;
    }
}
