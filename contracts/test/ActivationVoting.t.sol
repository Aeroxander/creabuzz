// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {Call, Moloch, Summoner, Shares, Loot} from "../src/majeur/MolochPatched.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {ISecondaryPolicy} from "../src/interfaces/ISecondaryPolicy.sol";

/// @dev A minimal market shim moving actual Shares through the policy's registered market
/// identity, so every token hook this suite exercises runs the production path — Shares transfer →
/// Moloch.onOwnershipChanged → ActivationVoting._ownershipChanged — never a direct ledger poke.
/// The shim performs one hook call per step, which keeps these unit cases small and exact. It does
/// NOT reproduce the real `SecondaryMarket.settle` ordering (consume per seller when anything sold,
/// then prepare and return the unsold remainder, each skipped at a zero amount), and a regression in
/// that ordering passes every case here. The real market against this real policy is covered in
/// `SecondaryMarketRealPolicy.t.sol` (call order, ages, void rounds, gas) and by the real-market
/// walk `ActivationVotingRealMarketFuzz` in `ActivationVotingFuzz.t.sol` (escrow books against the
/// market's balance and the quorum denominator at registered snapshots, at every step).
contract SecondaryShim {
    Shares public immutable underlying;
    ISecondaryPolicy public immutable policy;

    constructor(Shares underlying_, ISecondaryPolicy policy_) {
        underlying = underlying_;
        policy = policy_;
    }

    function deposit(address seller, uint256 amount) external {
        underlying.transferFrom(seller, address(this), amount);
    }

    function sell(address seller, address buyer, uint256 amount) external {
        policy.consumeSoldEscrow(seller, amount);
        underlying.transfer(buyer, amount);
    }

    function cancel(address seller, uint256 amount) external {
        policy.prepareEscrowReturn(seller, amount);
        underlying.transfer(seller, amount);
    }
}

/// @notice The amount-specific maturity ledger: every acquired amount gates on eight daily epochs
/// of its own, snapshots freeze the tuple (ownership block, cutoff epoch) and never re-read the
/// clock, and the escrow paths conserve the seller's original ages exactly. All flows drive through
/// the REAL DAO/Shares paths.
contract ActivationVotingTest is Test {
    ActivationVoting internal policy;
    Moloch internal dao;
    Shares internal shares;
    Loot internal loot;
    SecondaryShim internal market;

    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);
    address internal constant DAVE = address(0xDA4E);

    uint256 internal nextId = 1;
    uint256 internal start;
    uint256 internal blk = 3;

    function _next() internal {
        blk += 2;
        vm.roll(blk);
    }

    function setUp() public virtual {
        // Start inside day 9 so every acquisition epoch is unambiguous daily math. Alice receives
        // 100 bootstrap Shares in the same transaction that creates the DAO (see Summoner.init).
        vm.warp(9 days);
        start = vm.getBlockTimestamp();
        TreasuryMandateFactory mf = new TreasuryMandateFactory();
        policy = new ActivationVoting(mf);
        Summoner summoner = new Summoner(address(policy));
        address[] memory holders = new address[](1);
        holders[0] = ALICE;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100e18;
        dao = summoner.summon("Org", "ORG", "", 500, true, address(0), bytes32(0), holders, amounts, new Call[](0));
        shares = dao.shares();
        loot = dao.loot();
        policy = ActivationVoting(dao.votingWeight()); // the clone holds the real storage
        market = new SecondaryShim(shares, ISecondaryPolicy(address(policy)));
        // The one-time configuration: same block as creation, founder ALICE, grant 60 of her 100,
        // zero cliff, 180 day release (the candidate terms the spec calls for).
        vm.prank(address(dao));
        policy.configureSecondary(address(market), ALICE, 60e18, uint64(start), 0, 180 days);
        vm.prank(address(dao));
        dao.setProposalTTL(30 days);
        vm.prank(address(dao));
        dao.setTimelockDelay(1 days);
        _next();
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _give(address to, uint256 amount, address from) internal {
        vm.prank(from);
        shares.transfer(to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(address(dao));
        shares.mintFromMoloch(to, amount);
    }

    /// @dev A fresh proposal opened by `by` (the threshold is zero by summon). `amount` is a probe
    /// sized inside whatever the proposal's eligible weight is; keep it small.
    function _newProposal(address by, uint256 amount) internal returns (uint256 id, uint48 snap) {
        id = nextId++;
        // every cast lands on its own fresh block; the snapshot reads after it need a past block
        vm.roll(block.number + 2);
        vm.prank(by);
        dao.castVote(id, 1, amount);
        snap = dao.snapshotBlock(id);
        vm.roll(block.number + 2);
    }

    function _vote(address who, uint256 amount, uint256 id) internal {
        vm.prank(who);
        dao.castVote(id, 1, amount);
    }

    function _against(address who, uint256 amount, uint256 id) internal {
        vm.prank(who);
        dao.castVote(id, 0, amount);
    }

    function _escrow(address seller, uint256 amount) internal {
        vm.startPrank(seller);
        shares.approve(address(market), type(uint256).max);
        market.deposit(seller, amount);
        vm.stopPrank();
    }

    function _leave(address holder, uint256 amount) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(holder);
        dao.ragequit(tokens, amount, 0);
    }

    // ------------------------------------------------------------------
    // Bootstrap and the maturity window
    // ------------------------------------------------------------------

    function test_bootstrap_holders_are_fully_mature_from_birth() public {
        _mint(BOB, 30e18); // epoch 9 (start+9d): Bob's own clock starts; matures epoch 17.
        _next();
        (uint256 id, uint48 snap) = _newProposal(ALICE, 1e18);
        _next();
        assertEq(policy.getPastCapacity(ALICE, snap), 100e18, "the bootstrap founder never waits for anything");
        assertEq(policy.getPastCapacity(BOB, snap), 0e18, "Bob's fresh acquisition waits eight epochs");
        vm.warp(start + 9 days); // epoch 18 ≥ 17: Bob is whole.
        _next();
        (id, snap) = _newProposal(ALICE, 1e18);
        assertEq(policy.getPastCapacity(BOB, snap), 30e18, "one window later the amount is whole");
    }

    function test_the_delay_is_seven_to_eight_days_rounded_to_daily_epochs() public {
        _give(BOB, 30e18, ALICE);
        _next();
        uint48 snap = uint48(block.number - 1);
        uint64 e = policy.epochOf(uint64(start)); // the acquisition epoch
        assertEq(policy.eligibleAt(BOB, snap, e + 7), 0e18, "seven epochs: still inside the window");
        assertEq(policy.eligibleAt(BOB, snap, e + 8), 30e18, "eight epochs: fully eligible");
    }

    function test_a_same_wallet_rebuy_starts_a_fresh_delay() public {
        _mint(BOB, 30e18);
        vm.warp(start + 10 days); // Bob's 30 matured by now.
        _next();
        (uint256 id, uint48 snap) = _newProposal(ALICE, 1e18);
        assertEq(policy.getPastCapacity(BOB, snap), 30e18);
        vm.prank(BOB);
        shares.transfer(DAVE, 30e18);
        _mint(BOB, 30e18); // a same-wallet rebuy of the same size
        _next();
        (id, snap) = _newProposal(ALICE, 1e18);
        assertEq(policy.getPastCapacity(BOB, snap), 0e18, "the rebuy restarts the clock from zero");
        assertEq(policy.getPastCapacity(DAVE, snap), 0e18, "the buyer acquired fresh too");
    }

    function test_a_small_top_up_does_not_jump_a_holders_immature_window() public {
        _give(BOB, 99e18, ALICE); // the 99 leave Alice's mature hands into Bob's fresh window
        vm.warp(start + 2 days);
        _next();
        _give(BOB, 1e18, ALICE); // one fresh unit at epoch 11 (matures epoch 19 = start+10d)
        vm.warp(start + 8 days); // epoch 17 >= 17: the 99 matured; the fresh unit still waits
        _next();
        (uint256 id, uint48 snap) = _newProposal(BOB, 1);
        assertEq(policy.getPastCapacity(BOB, snap), 99e18, "exactly the 99 matured units vote whole");
        vm.warp(start + 10 days); // epoch 19 >= 19: the one fresh unit matured on its own clock
        _next();
        (uint256 id2, uint48 snap2) = _newProposal(BOB, 1);
        assertEq(
            policy.getPastCapacity(BOB, snap2), 100e18, "the blended wallet age conferred nothing sooner or slower"
        );
    }

    // ------------------------------------------------------------------
    // Snapshot tuple: frozen (ownership block, cutoff epoch), no clock fallback
    // ------------------------------------------------------------------

    function test_quorum_denominator_excludes_immature_supply() public {
        _mint(BOB, 30e18);
        _mint(CAROL, 10e18);
        _next();
        (uint256 id, uint48 snap) = _newProposal(ALICE, 1e18);
        // Total 140 = Alice 100 + Bob 30 (immature) + Carol 10 (immature). Nothing is excluded
        // (the DAO and the market hold nothing yet), so the whole denominator is Alice's 100.
        (uint96 vs,,,,,,,,,) = dao.proposalVotingRules(id);
        assertEq(vs, 100e18, "immature amounts are outside the denominator");
    }

    function test_the_frozen_snapshot_never_changes_when_the_clock_moves() public {
        _mint(BOB, 30e18);
        _next();
        (uint256 id, uint48 snap) = _newProposal(ALICE, 1e18);
        uint256 frozen = policy.votingSupplyAt(shares.getPastTotalSupply(snap), snap);
        assertEq(frozen, 100e18);
        vm.warp(start + 40 days); // far past any maturity
        _next();
        // An already-registered snapshot NEVER matures in hindsight: its cutoff is the opening
        // epoch, and the read resolves against that frozen pair both today and in 40 days.
        assertEq(
            policy.votingSupplyAt(shares.getPastTotalSupply(snap), snap),
            frozen,
            "a registered snapshot does not silently re-mature with time"
        );
        (uint256 id2, uint48 snap2) = _newProposal(ALICE, 1e18);
        (uint96 s2,,,,,,,,,) = dao.proposalVotingRules(id2);
        assertEq(s2, 130e18, "a new snapshot's own cutoff sees Bob's mature units");
    }

    function test_market_and_excluded_holdings_leave_the_denominator() public {
        _mint(CAROL, 10e18);
        _next();
        // Escrow deposit: 20 from Alice (her whole balance is bootstrap-mature) into the market.
        _escrow(ALICE, 20e18);
        _next();
        (uint256 id, uint48 snap) = _newProposal(ALICE, 1e18);
        // Raw total 110 − market 20 (excluded holder, raw) − Carol's 10 immature (global ledger)
        // − Alice's 0 pending = 80, which is exactly Alice's remaining reachable supply.
        (uint96 vs1,,,,,,,,,) = dao.proposalVotingRules(id);
        assertEq(vs1, 80e18, "the market's inventory is excluded from quorum");
        vm.warp(start + 9 days);
        _next();
        (id, snap) = _newProposal(ALICE, 1e18);
        (uint96 vs2,,,,,,,,,) = dao.proposalVotingRules(id);
        assertEq(vs2, 90e18, "Carol's units matured into the denominator");
    }

    function test_an_unregistered_snapshot_errors_instead_of_using_the_clock() public {
        _mint(BOB, 30e18);
        (uint256 did,) = _newProposal(ALICE, 1e18);
        // one _next() later: the block after the helper's own advance - never a proposal snapshot
        uint48 unregistered = uint48(blk - 1);
        vm.expectRevert(ActivationVoting.SnapshotNotTaken.selector);
        policy.getPastCapacity(BOB, unregistered);
        vm.expectRevert(ActivationVoting.SnapshotNotTaken.selector);
        policy.votingSupplyAt(130e18, unregistered);
        // The named-epoch previews remain available (they say which epoch they mean).
        assertEq(
            policy.eligibleAt(BOB, uint48(block.number - 1), policy.epochOf(uint64(vm.getBlockTimestamp()))),
            0e18,
            "the preview still answers with the epoch it was given"
        );
    }

    // ------------------------------------------------------------------
    // Absolute-clock age conservation (the references are real timestamps,
    // never the base ledger's blended `holdingAge`)
    // ------------------------------------------------------------------

    /// @dev The daily epoch of an absolute day count.
    function _ep(uint256 ts) internal pure returns (uint64) {
        return uint64(ts / 1 days);
    }

    /// @dev 10 fresh units for Bob, bought at the exact daily instant.
    function _freshUnitsAt(address to, uint256 ts) internal returns (uint48) {
        vm.warp(ts);
        _mint(to, 10e18);
        (, uint48 snap) = _newProposal(ALICE, 1);
        return snap;
    }

    function test_the_delay_is_the_next_day_boundary_on_the_absolute_clock() public {
        // The purchase lands mid-day (9 days + 6 hours = day 9.25), so the absolute-time reads
        // name the real day boundaries: still pending at the 7-day boundary, whole at the 8th.
        uint256 bought = 40 days + 6 hours;
        uint48 snap = _freshUnitsAt(BOB, bought);
        uint64 acquiredE = policy.epochOf(uint64(bought));
        assertEq(acquiredE, _ep(40 days));
        // At every instant inside the matured day boundary the amount is exactly whole.
        assertEq(
            policy.eligibleAt(BOB, snap, _ep(47 days + 23 hours + 59 minutes + 59 seconds)),
            0e18,
            "e+7: inside the delay"
        );
        assertEq(policy.eligibleAt(BOB, snap, policy.epochOf(uint64(48 days))), 10e18, "e+8: whole on the day boundary");
        // and the same boundary arithmetic isolates the amount: earlier in that day, not yet.
        assertEq(policy.eligibleAt(BOB, snap, policy.epochOf(uint64(47 days))), 0e18);
        assertEq(
            policy.eligibleAt(BOB, snap, policy.epochOf(uint64(48 days)))
                - policy.eligibleAt(BOB, snap, policy.epochOf(uint64(47 days))),
            10e18
        );
    }

    function test_an_unsold_return_matures_on_the_original_absolute_clock_not_the_return_s() public {
        // original purchase at day 50.25; escrow at day 52; the market returns 4 of the 10 units
        // at day 55. If ages were averaged or restarted, the restored units would look ripe at
        // 55d+8d = day 63; they are actually whole at the ORIGINAL boundary, day 58.
        uint48 snap = _freshUnitsAt(BOB, 50 days + 6 hours);
        vm.warp(52 days);
        _escrow(BOB, 10e18);
        vm.warp(55 days);
        vm.prank(address(market));
        market.cancel(BOB, 4e18);
        (, uint48 snap2) = _newProposal(ALICE, 1);
        // The RESTORED units: neither the return clock (63d = 55d+8d) nor the clock-then-matured
        // mid-escrow reading applies. They mature exactly on day 58.
        assertEq(
            policy.eligibleAt(BOB, snap2, policy.epochOf(uint64(57 days + 23 hours))), 0e18, "still pending at 57d23h"
        );
        assertEq(policy.eligibleAt(BOB, snap2, policy.epochOf(uint64(58 days))), 4e18, "whole on the ORIGINAL boundary");
        assertEq(
            policy.eligibleAt(BOB, snap2, policy.epochOf(uint64(63 days))), 4e18, "the return clock never redefined it"
        );
        // and the units still in escrow were pending through every one of those cutoffs:
        assertEq(policy.getPastCapacity(BOB, snap2), 0e18, "at the proposal's cutoff the restored units still wait");
        assertEq(policy.escrowedBalance(BOB), 6e18, "the unsold remainder is still escrowed, ages intact");
    }

    function test_the_grant_unlocks_on_the_absolute_schedule_and_caps_do_not_shift_with_sales() public {
        // The setUp's own schedule: saleStart == start (9 days), cliff 0, duration 180 days.
        (,, uint256 grant, uint64 s, uint64 cliff, uint64 dur) = policy.secondaryConfiguration();
        assertEq(grant, 60e18);
        assertEq(cliff, 0);
        assertEq(dur, 180 days);
        assertEq(s, uint64(start));
        assertEq(policy.lockedAt(uint64(start)), 60e18);
        assertEq(policy.lockedAt(uint64(start + 90 days)), 30e18, "exactly linear on the absolute clock");
        assertEq(policy.lockedAt(uint64(start + 180 days)), 0e18, "the full schedule is out");
        assertGt(policy.lockedAt(uint64(start + 180 days) - 1), 0, "one second before the schedule is out");
    }

    function test_escrow_conserves_original_age_across_a_sale_round_absolute() public {
        // Bob buys 10 at day 33.25; deposits ALL at day 34; the market sells 6 of them to DAVE at
        // day 36 (DAVE gets a fresh receipt that is pending until 36+8 = day 44); at day 40 the
        // market cancels the remaining 4 back to Bob. THE SOLD 6 mature on the SELL clock (fresh
        // units, day 44); THE RETURNED 4 mature on the ORIGINAL day-41 boundary, never restarted.
        uint48 snap = _freshUnitsAt(BOB, 33 days + 6 hours);
        vm.warp(34 days);
        _escrow(BOB, 10e18);
        vm.warp(36 days);
        vm.prank(address(market));
        market.sell(BOB, DAVE, 6e18);
        (, uint48 sold) = _newProposal(ALICE, 1);
        assertEq(policy.eligibleAt(DAVE, sold, policy.epochOf(uint64(43 days))), 0e18, "the buyer waits its OWN 8 days");
        assertEq(
            policy.eligibleAt(DAVE, sold, policy.epochOf(uint64(44 days))),
            6e18,
            "whole on exactly the sell-day boundary"
        );
        assertEq(
            policy.eligibleAt(DAVE, sold, policy.epochOf(uint64(41 days))),
            0e18,
            "the seller's clock never passed with it"
        );
        vm.warp(40 days);
        vm.prank(address(market));
        market.cancel(BOB, 4e18);
        (, snap) = _newProposal(ALICE, 1);
        assertEq(
            policy.eligibleAt(BOB, snap, policy.epochOf(uint64(41 days))), 4e18, "the return kept the ORIGINAL clock"
        );
        assertEq(
            policy.eligibleAt(BOB, snap, policy.epochOf(uint64(44 days))), 4e18, "the SOLD clock never spread to it"
        );
        // the sold credit is consumed exactly once; nothing lingers in the escrowed books
        assertEq(policy.escrowedBalance(BOB), 0e18);
        assertEq(policy.escrowedBalance(DAVE), 0e18);
    }

    // ------------------------------------------------------------------
    // The released Shares sale-policy binding (the kit's exact birth block wiring)
    // ------------------------------------------------------------------

    /// @dev One `Shares.setSalePolicy` on the real token, in the kit's order (before `setLockGuard`
    /// seals the choice), then the real `_moveTokens` ceiling enforced by Shares itself.
    function _bindRealSalePolicy() internal returns (Shares tokens) {
        tokens = shares;
        vm.prank(address(dao));
        tokens.setSalePolicy(address(policy)); // creation-only, before the final zero guard
        vm.prank(address(dao));
        tokens.setLockGuard(address(0)); // the sealing decision the kit makes last
    }

    function test_the_real_shares_sale_policy_reads_the_policy_and_enforces_the_ceiling() public {
        Shares tokens = _bindRealSalePolicy();
        // The Shares read is the policy's own math: at birth the founder's 40 units OUTSIDE the
        // 60-unit grant are sellable (the kit's own launches grant the whole balance, reading 0).
        (uint256 eligible, uint8 version) = tokens.saleEligibleOf(ALICE);
        assertEq(version, 1);
        assertEq(eligible, 40e18);
        assertEq(eligible, policy.saleCapacity(ALICE), "the token read is the policy's own ceiling");
        // Non-founders are unrestricted.
        (uint256 carolEligible, uint8 carolVersion) = tokens.saleEligibleOf(CAROL);
        assertEq(carolEligible, 0e18, "Carol holds nothing, so there is nothing to offer");
        assertEq(carolVersion, 1);
        // Past the schedule start, the ceiling is the balance minus the still-locked remainder.
        vm.warp(start + 90 days); // 30 of 60 released: locked 30, balance 100, so 70 offerable
        (eligible, version) = tokens.saleEligibleOf(ALICE);
        assertEq(eligible, 70e18);
        assertEq(version, 1);
        // A founder transfer above the ceiling is refused BY THE TOKEN (not by this ledger).
        vm.prank(ALICE);
        vm.expectRevert(Shares.LockedShares.selector);
        tokens.transfer(BOB, 71e18);
        // And inside the ceiling it goes through the real moves (the policy's burn hook stays
        // out of transfers: no burnedLocked movement).
        uint256 burnedBefore = policy.lockedAt(uint64(block.timestamp));
        vm.prank(ALICE);
        tokens.transfer(BOB, 30e18);
        assertEq(policy.lockedAt(uint64(block.timestamp)), burnedBefore, "a transfer never shifts the schedule");
        assertEq(policy.escrowedBalance(BOB), 0e18, "no escrow side effects on a plain transfer");
        // The burn path stays exempt (never reaches _moveTokens) yet still books the grant down.
        _leave(ALICE, 10e18);
        assertEq(policy.escrowedBalance(ALICE), 0e18);
        assertEq(policy.lockedAt(uint64(block.timestamp)), 20e18, "the burn released exactly what it consumed");
    }

    // ------------------------------------------------------------------
    // Live support: immature purchases cannot back departed votes
    // ------------------------------------------------------------------

    function test_leaving_removes_ownership_bound_support_before_execution() public {
        _mint(BOB, 30e18);
        vm.warp(start + 9 days); // Bob's units matured.
        _next();
        (uint256 id,) = _newProposal(BOB, 30e18); // Bob opens P1 with his own full weight
        (uint96 yes,,,) = policy.proposalSupport(id);
        assertEq(yes, 30e18);
        // Bob sends everything into the market: ownership-bound support follows him out.
        _escrow(BOB, 30e18);
        (yes,,,) = policy.proposalSupport(id);
        assertEq(yes, 0e18, "a market deposit removes the live support that owned it");
        assertEq(policy.escrowedBalance(BOB), 30e18);
    }

    function test_a_replacement_immature_rebuy_cannot_recreate_departed_support() public {
        _mint(BOB, 60e18);
        vm.warp(start + 9 days);
        _next();
        (uint256 id,) = _newProposal(BOB, 60e18); // Bob votes his own full mature balance
        _escrow(BOB, 60e18); // everything leaves; the support trims to zero
        vm.warp(start + 10 days);
        _next();
        _mint(BOB, 60e18); // a fresh rebuy of the same size
        vm.roll(block.number + 2);
        (uint96 yes,,,) = policy.proposalSupport(id);
        assertEq(yes, 0e18, "an immature rebuy does not replace the support that left");
        // and a SECOND proposal (Alice's own probe vote opens it) sees the rebuy as fully
        // immature: the whole denominator is Alice's 100, and Bob can buy no vote into it.
        (uint256 id2,) = _newProposal(ALICE, 1);
        (uint96 supply2,,,,,,,,,) = dao.proposalVotingRules(id2);
        assertEq(supply2, 100e18, "the rebuy is outside P2's own denominator");
        vm.prank(BOB);
        vm.expectRevert(AllocationVoting.InsufficientShares.selector);
        dao.castVote(id2, 1, 60e18);
        (uint96 yes2,,,) = policy.proposalSupport(id2);
        assertEq(yes2, 1, "P2's yes is only Alice's probe of one wei: the rebuy bought no vote at all");
    }

    function test_an_immature_holder_cannot_vote_at_all_yet() public {
        _mint(BOB, 30e18);
        _next();
        (uint256 id,) = _newProposal(ALICE, 1);
        _next();
        vm.prank(BOB);
        vm.expectRevert(AllocationVoting.InsufficientShares.selector);
        dao.castVote(id, 1, 1e18);
    }

    function test_mayExit_is_never_locked() public {
        (bool ok, uint256 amount) = policy.mayExit(ALICE);
        assertTrue(ok);
        assertEq(amount, 0);
    }

    // ------------------------------------------------------------------
    // Founder grant: saleCapacity, schedule releases, exact burn accounting
    // ------------------------------------------------------------------

    function test_saleCapacity_is_balance_minus_still_locked_grant() public view {
        assertEq(policy.saleCapacity(ALICE), 40e18, "the founder offers only what is outside the locked grant");
        assertEq(policy.lockedAt(uint64(start)), 60e18);
    }

    function test_non_founders_have_no_sale_restriction() public {
        _mint(BOB, 30e18);
        assertEq(policy.saleCapacity(BOB), 30e18);
    }

    function test_sold_units_released_by_the_schedule_are_never_subtracted_twice() public {
        vm.warp(start + 9 days); // 3 of 60 vested out of 180 days
        assertEq(policy.lockedAt(uint64(vm.getBlockTimestamp())), 57e18);
        // the founder deposits 3 (all she has vested so far) into the market
        _escrow(ALICE, 3e18);
        assertEq(policy.lockedAt(uint64(vm.getBlockTimestamp())), 57e18, "the sold units do not lock her again");
        assertEq(policy.saleCapacity(ALICE), 40e18, "97 balance minus the same 57 is 40, not 43");
        assertEq(policy.escrowedBalance(ALICE), 3e18);
    }

    function test_a_founder_burn_releases_exactly_the_locked_units_it_ate() public {
        vm.warp(start + 9 days); // locked 57
        _escrow(ALICE, 3e18); // balance 97, saleCapacity 40
        uint256 capBefore = policy.saleCapacity(ALICE);
        _leave(ALICE, 10e18); // a genuine founder burn through the real ragequit path
        uint64 at = uint64(vm.getBlockTimestamp());
        assertEq(policy.lockedAt(at), 47e18, "the burn ate ten locked units exactly");
        assertEq(policy.saleCapacity(ALICE), capBefore, "a burn neither frees nor fiddles the ceiling");
    }

    function test_future_awards_to_the_founder_are_never_re_locked() public {
        vm.warp(start + 9 days); // locked 57, saleCapacity 43
        _mint(ALICE, 5e18);
        assertEq(policy.lockedAt(uint64(vm.getBlockTimestamp())), 57e18, "the grant did not grow");
        assertEq(policy.saleCapacity(ALICE), 48e18, "105 balance minus the same 57");
    }

    function test_configuration_is_one_way_and_frozen() public {
        assertTrue(policy.isConfigured());
        // nothing may re-run it, in this or any later block
        vm.prank(address(dao));
        vm.expectRevert(ActivationVoting.AlreadyConfigured.selector);
        policy.configureSecondary(address(0xEEEE), ALICE, 1e18, uint64(start), 0, 1 days);
    }

    // ------------------------------------------------------------------
    // Escrow: conservation, sell-credit consumption, returns to the ORIGINAL seller
    // ------------------------------------------------------------------

    function test_escrow_records_the_sellers_most_aged_units_and_sales_consume_the_credit_once() public {
        _mint(BOB, 30e18);
        vm.warp(start + 9 days); // Bob's 30 mature; he buys 20 fresh
        _next();
        _mint(BOB, 20e18);
        _next();
        (uint256 id,) = _newProposal(BOB, 1e18);
        // Bob deposits 25: mature-first — his most-aged units go into the escrow.
        _escrow(BOB, 25e18);
        assertEq(policy.escrowedBalance(BOB), 25e18, "his most-aged credit sits in the escrow");
        (uint96 yes,,,) = policy.proposalSupport(id);
        assertEq(yes, 1e18, "the immature remainder keeps the probe vote; the escrowed part left it");
        (,,, uint64 since) = policy.proposalSupport(id);
        assertTrue(since != 0 || yes == 1e18);
        // The market sells 20 of Bob's inventory: consume the credit, then the transfer.
        vm.prank(address(market));
        market.sell(BOB, CAROL, 20e18);
        assertEq(policy.escrowedBalance(BOB), 5e18, "the sold credit is consumed exactly once");
        assertEq(policy.saleCapacity(BOB), 25e18, "Bob still owns 25 and was never sale-restricted himself");
        (uint256 id2, uint48 snap2) = _newProposal(ALICE, 1);
        assertEq(policy.getPastCapacity(CAROL, snap2), 0e18, "the buyer did not inherit any of Bob's history");
    }

    /// @dev The runbook's first open question, settled: does a founder's sale ceiling follow a
    /// PARTIAL escrow return? The ceiling is `balance - still locked grant`, and escrowing lowers the
    /// balance, so it must fall with the escrow and come back by exactly what returns — not by the
    /// whole original escrow.
    function test_the_founders_sale_ceiling_follows_a_partial_escrow_return() public {
        uint256 before = policy.saleCapacity(ALICE);
        assertEq(before, 40e18, "the founder's opening ceiling: 97 balance minus the 57 still locked");
        _escrow(ALICE, 10e18);
        assertEq(policy.saleCapacity(ALICE), before - 10e18, "escrowed units leave the ceiling");
        vm.prank(address(market));
        market.cancel(ALICE, 4e18); // a partial return: four of the ten come back
        assertEq(policy.saleCapacity(ALICE), before - 6e18, "the returned part comes back exactly once");
        assertEq(policy.escrowedBalance(ALICE), 6e18, "six are still escrowed");
    }

    function test_unsold_units_return_to_the_original_seller_with_their_original_ages() public {
        // Bob's ONLY units are 10 bought fresh at epoch 9 (start+9d); he escrows the whole pot.
        _mint(BOB, 10e18);
        _escrow(BOB, 10e18);
        assertEq(policy.escrowedBalance(BOB), 10e18);
        vm.warp(start + 5 days); // before the original maturity (epoch 17 = start+8d)
        _next();
        vm.prank(address(market));
        market.cancel(BOB, 10e18); // a same-transaction prepared return of the whole lot
        assertEq(policy.escrowedBalance(BOB), 0e18, "the return consumed the whole escrow context");
        (uint256 id, uint48 snap) = _newProposal(ALICE, 1e18);
        assertEq(policy.getPastCapacity(BOB, snap), 0e18, "the returned units are still immature");
        // They mature on the ORIGINAL clock (epoch 17 = start+8d), not on the return's clock.
        vm.warp(start + 9 days); // epoch 18 >= 17
        _next();
        (id, snap) = _newProposal(ALICE, 1e18);
        assertEq(policy.getPastCapacity(BOB, snap), 10e18, "the return preserved the original maturity date");
    }

    function test_an_unprepared_market_transfer_refuses_to_strand_escrow() public {
        _mint(BOB, 10e18);
        _escrow(BOB, 10e18);
        // The market hands 5 units to someone without consuming any seller's credit: after the
        // vault changed, the escrowed books (10) would exceed what the vault holds (5).
        vm.prank(address(market));
        vm.expectRevert(ActivationVoting.MarketInventoryShort.selector);
        shares.transfer(CAROL, 5e18);
        _next();
        // a prepared return is the ONLY path for those units to leave escrow to Bob
        vm.prank(address(market));
        market.cancel(BOB, 5e18);
        assertEq(policy.escrowedBalance(BOB), 5e18);
        assertEq(shares.balanceOf(BOB), 5e18);
        // and the return happened one-shot: a replay (a second unprepared transfer) aborts
        vm.prank(address(market));
        vm.expectRevert(ActivationVoting.MarketInventoryShort.selector);
        shares.transfer(BOB, 5e18);
    }

    function test_replayed_context_is_never_reusable_and_others_cannot_touch_the_escrow() public {
        _mint(BOB, 10e18);
        _escrow(BOB, 10e18);
        // only the configured market may consume or prepare
        vm.prank(ALICE);
        vm.expectRevert(ActivationVoting.MarketOnly.selector);
        policy.consumeSoldEscrow(BOB, 1e18);
        vm.prank(ALICE);
        vm.expectRevert(ActivationVoting.MarketOnly.selector);
        policy.prepareEscrowReturn(BOB, 1e18);
        // a prepared context binds ONE exact amount; a quantity mismatch aborts atomically
        vm.prank(address(market));
        policy.prepareEscrowReturn(BOB, 3e18);
        vm.prank(address(market));
        vm.expectRevert(ActivationVoting.PreparedReturnMismatch.selector);
        shares.transfer(BOB, 2e18);
        _next();
        // and two sellers escrow disjointly: a sale of Alice's inventory never touches Bob's
        _escrow(ALICE, 4e18);
        _next();
        vm.prank(address(market));
        market.sell(ALICE, CAROL, 4e18);
        assertEq(policy.escrowedBalance(ALICE), 0e18);
        assertEq(policy.escrowedBalance(BOB), 10e18, "Bob's escrow was untouched by Alice's sale");
    }

    function test_partial_return_preserves_partial_ages() public {
        _mint(BOB, 10e18);
        _escrow(BOB, 10e18);
        vm.warp(start + 5 days); // the lineage is one tag from epoch 9; matures at start+8d
        _next();
        vm.prank(address(market));
        market.cancel(BOB, 4e18); // a partial return of the escrowed lineage
        assertEq(policy.escrowedBalance(BOB), 6e18);
        assertEq(shares.balanceOf(BOB), 4e18);
        (uint256 id, uint48 snap) = _newProposal(ALICE, 1e18);
        assertEq(policy.getPastCapacity(BOB, snap), 0e18, "the restored part is still immature");
        vm.warp(start + 9 days);
        _next();
        (id, snap) = _newProposal(ALICE, 1e18);
        assertEq(policy.getPastCapacity(BOB, snap), 4e18, "only the returned part matured on the original clock");
        // the market can sell the remaining 6 exactly once
        vm.prank(address(market));
        market.sell(BOB, DAVE, 6e18);
        assertEq(policy.escrowedBalance(BOB), 0e18);
        // a second sale of nothing fails honestly rather than double-consume
        vm.prank(address(market));
        vm.expectRevert(ActivationVoting.MarketInventoryShort.selector);
        market.sell(BOB, DAVE, 1);
    }

    function test_mint_straight_to_the_market_is_impossible() public {
        vm.prank(address(dao));
        vm.expectRevert(ActivationVoting.MintToMarket.selector);
        shares.mintFromMoloch(address(market), 1e18);
    }

    // ------------------------------------------------------------------
    // Previews declare the epoch they mean
    // ------------------------------------------------------------------

    function test_previews_name_their_epoch_and_match_registered_reads() public {
        _mint(BOB, 30e18);
        _next();
        (, uint48 snap) = _newProposal(ALICE, 1e18);
        uint64 cutoff = policy.epochOf(uint64(vm.getBlockTimestamp()));
        assertEq(policy.eligibleAt(BOB, snap, cutoff), policy.getPastCapacity(BOB, snap));
        assertEq(
            policy.eligibleVotingSupplyAt(shares.getPastTotalSupply(snap), snap, cutoff),
            policy.votingSupplyAt(shares.getPastTotalSupply(snap), snap)
        );
        vm.warp(start + 20 days);
        _next();
        // with the FROZEN cutoff, previews still mirror the registered snapshot after time
        assertEq(policy.eligibleAt(BOB, snap, cutoff), policy.getPastCapacity(BOB, snap));
        assertEq(
            policy.eligibleVotingSupplyAt(shares.getPastTotalSupply(snap), snap, cutoff),
            policy.votingSupplyAt(shares.getPastTotalSupply(snap), snap)
        );
        // with TODAY's cutoff the same block reads differently — reachable only via previews
        uint64 today = policy.epochOf(uint64(vm.getBlockTimestamp()));
        assertEq(policy.eligibleAt(BOB, snap, today), 30e18);
    }

    /// @dev Evict Bob's dormant day-10 tag from the GLOBAL eight-slot viewport, without touching
    /// his personal histogram. Nine distinct later receipts force eviction, not just a long sleep.
    function _evictDormantTag() internal returns (uint48 early, uint48 beforeMove) {
        vm.warp(10 days);
        _mint(BOB, 10e18);
        (, early) = _newProposal(ALICE, 1);
        assertEq(policy.getPastCapacity(BOB, early), 0);
        for (uint256 day = 20; day <= 28; ++day) {
            vm.warp(day * 1 days);
            vm.roll(vm.getBlockNumber() + 1);
            _mint(CAROL, 1e18);
        }
        (, beforeMove) = _newProposal(ALICE, 1);
        assertEq(policy.getPastCapacity(BOB, beforeMove), 10e18);
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(beforeMove), beforeMove), 111e18);
    }

    function _checkDormantConservation(uint48 early, uint48 beforeMove) internal {
        (, uint48 afterMove) = _newProposal(ALICE, 1);
        uint256 sum = uint256(policy.getPastCapacity(ALICE, afterMove))
            + policy.getPastCapacity(BOB, afterMove) + policy.getPastCapacity(CAROL, afterMove)
            + policy.getPastCapacity(DAVE, afterMove);
        assertEq(sum, 107e18);
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(afterMove), afterMove), sum);
        vm.warp(60 days);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(policy.getPastCapacity(BOB, early), 0, "early cutoff stays immature forever");
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(early), early), 100e18);
        assertEq(policy.getPastCapacity(BOB, beforeMove), 10e18);
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(beforeMove), beforeMove), 111e18);
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(afterMove), afterMove), sum);
    }

    function test_dormant_evicted_tag_can_transfer_with_conserved_frozen_quorum() public {
        (uint48 early, uint48 beforeMove) = _evictDormantTag();
        _give(DAVE, 4e18, BOB);
        assertEq(shares.balanceOf(BOB), 6e18);
        _checkDormantConservation(early, beforeMove);
    }

    function test_dormant_evicted_tag_can_exit_with_conserved_frozen_quorum() public {
        (uint48 early, uint48 beforeMove) = _evictDormantTag();
        _leave(BOB, 4e18);
        assertEq(shares.balanceOf(BOB), 6e18);
        _checkDormantConservation(early, beforeMove);
    }

    function test_dormant_evicted_tag_can_escrow_with_conserved_frozen_quorum() public {
        (uint48 early, uint48 beforeMove) = _evictDormantTag();
        _escrow(BOB, 4e18);
        assertEq(policy.escrowedBalance(BOB), 4e18);
        assertEq(shares.balanceOf(BOB), 6e18);
        _checkDormantConservation(early, beforeMove);
        market.cancel(BOB, 4e18);
        (, uint48 returned) = _newProposal(ALICE, 1);
        assertEq(policy.getPastCapacity(BOB, returned), 10e18, "mature return keeps original age");
        assertEq(policy.escrowedBalance(BOB), 0);
    }

    function test_deposit_peels_matured_and_immature_histogram_units_exactly_once() public {
        vm.warp(10 days);
        _mint(BOB, 10e18);
        vm.warp(20 days);
        vm.roll(vm.getBlockNumber() + 1);
        _mint(BOB, 10e18);
        // The old split counted the day-10 units as untracked mature, then peeled those same
        // slots again for the five pending units. _trim then underflowed pending > raw.
        _escrow(BOB, 15e18);
        assertEq(shares.balanceOf(BOB), 5e18);
        assertEq(policy.escrowedBalance(BOB), 15e18);
        (, uint48 deposited) = _newProposal(ALICE, 1);
        assertEq(policy.getPastCapacity(BOB, deposited), 0);
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(deposited), deposited), 100e18);
        market.cancel(BOB, 15e18);
        (, uint48 returned) = _newProposal(ALICE, 1);
        assertEq(policy.getPastCapacity(BOB, returned), 10e18, "only original mature units return eligible");
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(returned), returned), 110e18);
        vm.warp(28 days);
        (, uint48 matured) = _newProposal(ALICE, 1);
        assertEq(policy.getPastCapacity(BOB, matured), 20e18);
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(matured), matured), 120e18);
        assertEq(policy.getPastCapacity(BOB, returned), 10e18, "frozen cutoff never follows clock");
    }

    function test_frozen_exclusions_reject_add_remove_and_market_unexclude() public {
        _mint(BOB, 10e18);
        _escrow(ALICE, 20e18);
        (, uint48 snap) = _newProposal(ALICE, 1);
        address[] memory excluded = policy.excludedHolders();
        vm.startPrank(address(dao));
        vm.expectRevert(ActivationVoting.ExclusionsFrozen.selector);
        policy.setExcluded(BOB, true);
        vm.expectRevert(ActivationVoting.ExclusionsFrozen.selector);
        policy.setExcluded(excluded[0], false);
        vm.expectRevert(ActivationVoting.ExclusionsFrozen.selector);
        policy.setExcluded(address(market), false);
        vm.stopPrank();
        assertFalse(policy.isExcluded(BOB));
        assertTrue(policy.isExcluded(excluded[0]));
        assertTrue(policy.isExcluded(address(market)));
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(snap), snap), 80e18);
        (, uint48 later) = _newProposal(ALICE, 1);
        assertEq(policy.votingSupplyAt(shares.getPastTotalSupply(later), later), 80e18);
    }

    function _unconfiguredPolicy() internal returns (ActivationVoting fresh, Moloch freshDAO) {
        Summoner summoner = new Summoner(address(new ActivationVoting(policy.mandateFactory())));
        address[] memory holders = new address[](1);
        holders[0] = ALICE;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100e18;
        freshDAO = summoner.summon("Boundary", "BND", "", 500, true, address(0), bytes32(0), holders, amounts, new Call[](0));
        fresh = ActivationVoting(freshDAO.votingWeight());
    }

    /// @dev Before `configureSecondary` the policy must behave exactly like the legacy
    /// one-holder-one-raw-balance weight: no pending ledger is ever tracked, so an award minted
    /// to a holder never makes `pending > raw balance` and a later ragequit or transfer cannot
    /// underflow `capacity - pending` (a revert here would block a financial exit).
    function test_unconfigured_policy_award_then_ragequit_and_transfer_do_not_revert_or_track_pending() public {
        (ActivationVoting fresh, Moloch freshDAO) = _unconfiguredPolicy();
        Shares freshShares = freshDAO.shares();
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);

        // a reviewed award: minted by the DAO to a contributor who had nothing before
        vm.prank(address(freshDAO));
        freshShares.mintFromMoloch(BOB, 50e18);

        // legacy weight: the award counts in full the moment a proposal snapshot is taken
        _next();
        vm.prank(ALICE);
        freshDAO.castVote(1, 1, 1e18);
        uint48 snap = freshDAO.snapshotBlock(1);
        _next();
        assertEq(fresh.getPastCapacity(BOB, snap), 50e18, "the award is plain raw balance");
        assertEq(
            fresh.votingSupplyAt(freshShares.getPastTotalSupply(snap), snap),
            150e18,
            "no ghost pending shrinks the quorum denominator"
        );

        // a partial exit inside the maturity window (before the fix: Panic 0x11 in _liveCapacity)
        vm.prank(BOB);
        freshDAO.ragequit(tokens, 10e18, 0);
        assertEq(freshShares.balanceOf(BOB), 40e18);

        // a transfer out of the freshly awarded balance, and a full exit of the remainder
        vm.prank(BOB);
        freshShares.transfer(CAROL, 15e18);
        vm.prank(BOB);
        freshDAO.ragequit(tokens, 25e18, 0);
        assertEq(freshShares.balanceOf(BOB), 0);
        assertEq(freshShares.balanceOf(CAROL), 15e18);

        // the receiver's units are plain raw balance too: she can leave fully at once
        vm.prank(CAROL);
        freshDAO.ragequit(tokens, 15e18, 0);
        assertEq(freshShares.balanceOf(CAROL), 0);

        // after every flow the denominator is still the plain supply
        _next();
        vm.prank(ALICE);
        freshDAO.castVote(2, 1, 1e18);
        uint48 snap2 = freshDAO.snapshotBlock(2);
        _next();
        assertEq(fresh.votingSupplyAt(freshShares.getPastTotalSupply(snap2), snap2), 100e18);
    }

    /// @dev The exit-right half on its own: a fresh award, then ragequit inside the maturity
    /// window, partial and full (financial exit rights stay intact before configuration).
    function test_unconfigured_policy_ragequit_of_a_fresh_award_never_reverts() public {
        (, Moloch freshDAO) = _unconfiguredPolicy();
        Shares freshShares = freshDAO.shares();
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(address(freshDAO));
        freshShares.mintFromMoloch(BOB, 50e18);
        vm.prank(BOB);
        freshDAO.ragequit(tokens, 10e18, 0);
        assertEq(freshShares.balanceOf(BOB), 40e18);
        vm.prank(BOB);
        freshDAO.ragequit(tokens, 40e18, 0);
        assertEq(freshShares.balanceOf(BOB), 0);
    }

    function test_schedule_end_uint64_boundary_and_overflow_error_selector() public {
        (ActivationVoting fresh, Moloch freshDAO) = _unconfiguredPolicy();
        uint64 boundaryStart = type(uint64).max - 200;
        vm.startPrank(address(freshDAO));
        vm.expectRevert(ActivationVoting.InvalidSaleSchedule.selector);
        fresh.configureSecondary(address(market), ALICE, 60e18, boundaryStart + 1, 100, 100);
        fresh.configureSecondary(address(market), ALICE, 60e18, boundaryStart, 100, 100);
        vm.stopPrank();
        assertTrue(fresh.isConfigured());
        assertEq(fresh.lockedAt(type(uint64).max), 0);
        assertEq(fresh.lockedAt(type(uint64).max - 100), 60e18);
    }

    // ------------------------------------------------------------------
    // Pinned interface identity (the parent freezes on these exact getters)
    // ------------------------------------------------------------------

    function test_the_pinned_secondary_interface_matches_the_implementation() public view {
        ISecondaryPolicy pinned = ISecondaryPolicy(address(policy));
        assertEq(pinned.dao(), address(dao));
        assertEq(pinned.market(), address(market));
        assertEq(pinned.saleCapacity(ALICE), policy.saleCapacity(ALICE));
        assertEq(pinned.escrowedBalance(ALICE), policy.escrowedBalance(ALICE));
        (address m, address f, uint256 g, uint64 s, uint64 c, uint64 d) = policy.secondaryConfiguration();
        assertEq(m, address(market));
        assertEq(f, ALICE);
        assertEq(g, 60e18);
        assertEq(s, uint64(start));
        assertEq(c, 0);
        assertEq(d, 180 days);
        assertTrue(policy.isConfigured());
        assertEq(policy.SECONDARY_POLICY_VERSION(), 1);
    }
}
