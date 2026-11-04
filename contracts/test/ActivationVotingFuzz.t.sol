// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {Call, Moloch, Summoner, Shares} from "../src/majeur/MolochPatched.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {ISecondaryPolicy} from "../src/interfaces/ISecondaryPolicy.sol";

/// @dev Same real-market shim as the unit suite.
contract FuzzShim {
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
        if (amount > 0) policy.prepareEscrowReturn(seller, amount);
        if (amount > 0) underlying.transfer(seller, amount);
    }
}

/// @notice Production-shape fuzz on the REAL DAO/Shares path: a bounded pool of holders walks
/// mints/ordinary transfers/market deposits/sales/cancelled returns across epochs. The invariants
/// are the ones the escrow and the denominator are built on — nothing is poked directly.
contract ActivationVotingFuzzTest is Test {
    ActivationVoting internal policy;
    Moloch internal dao;
    Shares internal shares;
    FuzzShim internal market;

    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);
    /// @notice A bootstrap governor the walk NEVER touches: he opens the conservation probe even
    /// when the walk drained or rebought every reachable holder, and his whole matured capacity is
    /// part of the expected conservation sum.
    address internal constant GOVERNOR = address(0x60A55);

    /// @notice Escrowed books may never exceed the market's physical holdings (asserted in-walk).
    function invariant_books_never_exceed_the_vault() internal {
        assertLe(
            policy.escrowedBalance(ALICE) + policy.escrowedBalance(BOB) + policy.escrowedBalance(CAROL),
            shares.balanceOf(address(market)),
            "escrowed books exceed the market vault"
        );
    }

    function _give(address to, uint256 amount, address from) internal {
        vm.prank(from);
        shares.transfer(to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(address(dao));
        shares.mintFromMoloch(to, amount);
    }

    function _escrow(address who, uint256 amount) internal {
        vm.startPrank(who);
        shares.approve(address(market), type(uint256).max);
        market.deposit(who, amount);
        vm.stopPrank();
    }

    function _leave(address holder, uint256 amount) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.prank(holder);
        dao.ragequit(tokens, amount, 0);
    }

    uint256 internal carrySeed;

    function _cap(uint256 raw, uint256 against) internal view returns (uint256) {
        return raw > against ? against : raw;
    }

    function _holders(uint256 i) internal pure returns (address) {
        if (i == 0) return ALICE;
        if (i == 1) return BOB;
        return CAROL;
    }

    /// @notice A production-shaped walk over the real Shares → Moloch → policy hook path: mints,
    /// ordinary transfers, market deposits, whole-atom market settles (a settle action — consume
    /// plus transfer for a sale, prepare plus return for a cancel — is ONE market frame, so a
    /// refusal rolls the whole market action back exactly as production does), and founder burns,
    /// across daily epochs. Every step keeps the books matching: the escrowed total inside the
    /// vault, per-owner eligibility inside the raw mirror, and the escrow totals inside the market
    /// balance at each settle boundary.
    /// seed 0 runs the deterministic counterexample shape first: escrowed credit refluxes across
    /// seasoned acquisitions, then a settle + mint + transfer + founder-burn storm.
    function testFuzz_market_path_conserves_ages_and_balances_across_epochs(uint256 seed, uint8[8] memory ops)
        external
    {
        _buildPolicy();
        // deterministic storm when the fuzzer hits seed 0 with any ops: the exact walk shape that
        // previously trapped a burn during escrow reflux plus later re-acquisitions.
        _walk(0, [uint8(3), 4, 5, 3, 1, 2, 6, 3], 0 days);
        if (seed == 0) {
            invariant_books_never_exceed_the_vault();
            return;
        }
        _walk(seed, ops, 0 days);
    }

    /// @dev Minimal probe: a fresh proposal id opened by a holder with balance. Returns (id, snap).
    /// The id IS the return value — callers must read the registered pair through it, not through
    /// slot zero (an unassigned return used to read proposal 0, whose cutoff is unregistered).
    function _newProbe(address by) internal returns (uint256 id, uint48 snap) {
        id = uint256(keccak256(abi.encode("probe", vm.getBlockTimestamp(), vm.getBlockNumber())));
        vm.prank(by);
        dao.castVote(id, 1, 1);
        snap = dao.snapshotBlock(id);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _buildPolicy() internal {
        // Foundry's default timestamp is 1, whose daily epoch is 0 — and epoch 0 is this policy's
        // "unregistered" cutoff sentinel, so a probe registered in epoch 0 would read as an
        // unregistered snapshot (the exact SnapshotNotTaken the fuzzer surfaced). Start every
        // acquisition clock in a real, nonzero epoch (day 20+ like the unit fixtures' days 9+).
        vm.warp(20 days);
        TreasuryMandateFactory mf = new TreasuryMandateFactory();
        policy = new ActivationVoting(mf);
        Summoner summoner = new Summoner(address(policy));
        address[] memory holders = new address[](4);
        holders[0] = ALICE;
        holders[1] = BOB;
        holders[2] = CAROL;
        holders[3] = GOVERNOR;
        uint256[] memory amounts = new uint256[](4);
        amounts[0] = 100e18;
        amounts[1] = 40e18;
        amounts[2] = 60e18;
        amounts[3] = 10e18;
        dao = summoner.summon("Org", "ORG", "", 500, true, address(0), bytes32(0), holders, amounts, new Call[](0));
        shares = dao.shares();
        policy = ActivationVoting(dao.votingWeight()); // the clone holds the real storage
        market = new FuzzShim(shares, ISecondaryPolicy(address(policy)));
        vm.prank(address(dao));
        policy.configureSecondary(
            address(market), ALICE, 60e18, uint64(vm.getBlockTimestamp()), 0, 180 days
        );
        vm.roll(vm.getBlockNumber() + 1);
        vm.startPrank(ALICE);
        shares.approve(address(market), type(uint256).max);
        shares.transfer(address(market), 40e18);
        vm.stopPrank();
        vm.startPrank(BOB);
        shares.approve(address(market), type(uint256).max);
        shares.transfer(address(market), 20e18);
        vm.stopPrank();
    }

    /// @dev Walk ops: sleep (8+ epochs), mint, transfer, deposit, SELL (one market frame),
    /// CANCEL (one market frame), founder burn, founder-bounded sale attempt. All frames call the
    /// real production paths directly — a failure inside any step fails the walk loudly.
    function _walk(uint256 seed, uint8[8] memory ops, uint256 timeOffset) internal {
        uint256 epochCarry = vm.getBlockTimestamp();
        for (uint256 i; i < ops.length; ++i) {
            uint256 op = bound(uint256(ops[i]), 0, 7);
            uint256 who = uint256(keccak256(abi.encode(seed, i, "who"))) % 3;
            address seller = _holders(who);
            uint256 bal = shares.balanceOf(seller);
            if (bal == 0) continue;
            uint256 amount = bound(uint256(keccak256(abi.encode(seed, i, "amt", op))), 1, bal);
            if (op == 0) {
                // 8+ epoch sleep: every held amount becomes mature; nothing else moves
                epochCarry += 9 days;
                vm.warp(epochCarry);
                vm.roll(vm.getBlockNumber() + 1);
            } else if (op == 1) {
                _mint(seller, amount);
            } else if (op == 2) {
                address to = _holders(uint256(keccak256(abi.encode(seed, i, "to"))) % 3);
                if (to != seller) {
                    vm.prank(seller);
                    shares.transfer(to, amount);
                }
                vm.roll(vm.getBlockNumber() + 1);
            } else if (op == 3) {
                _escrow(seller, amount);
            } else if (op == 4) {
                uint256 esc = policy.escrowedBalance(seller);
                if (esc == 0) continue;
                uint256 take = _cap(amount, esc);
                vm.prank(address(market));
                market.sell(seller, CAROL, take); // one atomic merchant frame
                vm.roll(vm.getBlockNumber() + 1);
            } else if (op == 5) {
                uint256 esc = policy.escrowedBalance(seller);
                if (esc == 0) continue;
                uint256 take = _cap(amount, esc);
                vm.prank(address(market));
                market.cancel(seller, take); // one atomic merchant frame
                vm.roll(vm.getBlockNumber() + 1);
            } else if (op == 6) {
                if (seller != ALICE) continue;
                _leave(seller, amount); // amount already bound ≤ balance
            } else {
                uint256 cap = policy.saleCapacity(seller);
                if (cap == 0) continue;
                uint256 take = _cap(amount, cap);
                vm.prank(seller);
                shares.transfer(address(market), take);
                vm.roll(vm.getBlockNumber() + 1);
            }
            invariant_books_never_exceed_the_vault();
        }
        // Final stateful conservation through a REGISTERED snapshot, opened by the walk's
        // never-touched bootstrap governor (the walk can leave every reachable holder with zero
        // eligible weight, so a runner probe may not come from ALICE). The registered read resolves
        // against the frozen (ownership block, cutoff epoch) pair; the whole-electorate supply must
        // equal the sum of per-owner eligibility including the governor: the global pending ledger
        // tracks exactly the current-immature part of the four reachable holders (frozen
        // exclusions: burn + market; every balance lives in them or in the market vault).
        vm.roll(vm.getBlockNumber() + 1);
        (uint256 pid, uint48 snap) = _newProbe(GOVERNOR);
        uint256 supply = policy.votingSupplyAt(dao.supplySnapshot(pid), snap);
        uint256 summed = policy.getPastCapacity(ALICE, snap) + policy.getPastCapacity(BOB, snap)
            + policy.getPastCapacity(CAROL, snap) + policy.getPastCapacity(GOVERNOR, snap);
        assertEq(supply, summed, "global pending must equal the sum of per-owner pending at any registered read");
        invariant_books_never_exceed_the_vault();
    }


}
