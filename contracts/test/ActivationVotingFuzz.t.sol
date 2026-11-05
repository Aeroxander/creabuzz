// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {Call, Moloch, Summoner, Shares} from "../src/majeur/MolochPatched.sol";
import {AllocationVoting} from "../src/AllocationVoting.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {ISecondaryPolicy} from "../src/interfaces/ISecondaryPolicy.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFlowsFixture} from "./helpers/SecondaryMarketFlowsFixture.sol";

/// @dev Same market shim as the unit suite: a stand-in that performs the flows the pinned escrow semantics
/// define, one hook call per step. It does NOT reproduce the real market's settle ordering (consume, then
/// prepare, then transfer, with each hook skipped at a zero amount); `ActivationVotingRealMarketFuzz` below
/// drives the same invariants through the real `SecondaryMarket` instead.
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

/// @notice The same invariants as the walk above, driven through the REAL `SecondaryMarket` and a real
/// `ContributorKitV2` launch instead of a shim: sells and bids, cancels, settles, void rounds, claims by
/// anyone, ragequits and unattributed donations, across days. The shim's one-call-per-step sales cannot reach
/// the real ordering (consume per seller when something sold, prepare then return when something is unsold),
/// partial fills across several sellers, a buyer who is also a seller, or a claim on a void round.
/// @dev Per step: the policy's escrow books never exceed what the market physically holds; no policy hook ever
/// reverts inside a market action (`MarketInventoryShort`, `PreparedReturnMismatch`, `LedgerCorrupt`,
/// `MarketOnly` would wedge a round to void). That is enforced by an allowlist, not a denylist: a market action
/// may only end in one of the market's own named refusals, so a Panic (an arithmetic underflow in a hook) or an
/// empty revert fails the walk exactly like a wedge does. A holder's ragequit must always succeed, and ghost
/// counters prove the walk reaches the hard shapes (see `Stats`). At registered snapshots the quorum denominator equals the
/// sum of every holder's eligible amount. At the end every round is resolved and claimed and the market holds
/// exactly the donations, with the same amount left in the donors' escrow credit.
contract ActivationVotingRealMarketFuzz is SecondaryMarketFlowsFixture {
    function _useRealKit() internal pure override returns (bool) {
        return true;
    }

    uint256 private _pid;
    mapping(address => uint256) private _donated;
    uint256 private _donatedTotal;

    /// @dev What one walk actually exercised. Read out of the walk in memory, because the fixed-script test
    /// rewinds storage between seeds.
    /// `filledLots`: lots sold across every round. `partialAcrossSellers`: rounds where two or more sellers
    /// sold something and at least one sold less than it offered. `voidClaims`: claims that paid out of a round
    /// nobody settled. `ragequitsWithEscrow`: exits by a holder who also had Shares in the market's escrow.
    /// `donations`: unattributed transfers into the market.
    struct Stats {
        uint256 filledLots;
        uint256 partialAcrossSellers;
        uint256 voidClaims;
        uint256 ragequitsWithEscrow;
        uint256 donations;
    }

    uint256 private _voidClaims;
    uint256 private _ragequitsWithEscrow;
    uint256 private _donations;

    function _who(uint256 r) internal pure returns (address) {
        uint256 k = r % 6;
        if (k == 0) return S1;
        if (k == 1) return S2;
        if (k == 2) return S3;
        if (k == 3) return B1;
        if (k == 4) return B2;
        return B3;
    }

    function _everyone() internal pure returns (address[] memory all) {
        all = new address[](7);
        all[0] = KIT_FOUNDER;
        all[1] = S1;
        all[2] = S2;
        all[3] = S3;
        all[4] = B1;
        all[5] = B2;
        all[6] = B3;
    }

    /// @dev The market's own named refusals: a closed or not-yet-open round, an order already placed, no
    /// capacity, a bad size, nothing to claim, no order, a full list, a disabled listing, or a repeat. Anything
    /// else (a policy or ledger error, a Panic, an empty revert, a token error) is a defect, never a refusal.
    function _isMarketRefusal(bytes4 sel) internal pure returns (bool) {
        return sel == SecondaryMarket.BiddingOver.selector || sel == SecondaryMarket.OneOrderPerSide.selector
            || sel == SecondaryMarket.NoCapacity.selector || sel == SecondaryMarket.BadLots.selector
            || sel == SecondaryMarket.NothingToClaim.selector || sel == SecondaryMarket.NoOrder.selector
            || sel == SecondaryMarket.TooManySellers.selector || sel == SecondaryMarket.TooManyBuyers.selector
            || sel == SecondaryMarket.ListingNotEnabled.selector || sel == SecondaryMarket.TooSoon.selector
            || sel == SecondaryMarket.BiddingOpen.selector || sel == SecondaryMarket.SettleOver.selector
            || sel == SecondaryMarket.AlreadySettled.selector;
    }

    /// @dev One market action as `caller`. A named market refusal is fine (a closed round, no order, no funds);
    /// every other failure is a defect: the policy's own books refusing would wedge the round, and a Panic or an
    /// empty revert is an arithmetic or ledger bug that only some sequences reach.
    function _act(address caller, bytes memory data) internal returns (bool ok) {
        vm.prank(caller);
        bytes memory ret;
        (ok, ret) = address(l.market).call(data);
        if (ok) return true;
        assertGe(ret.length, 4, "a market action reverted with empty data");
        bytes4 sel = bytes4(ret);
        assertTrue(sel != bytes4(0x4e487b71), "a market action panicked");
        assertTrue(_isMarketRefusal(sel), "a market action failed with something other than a named market refusal");
    }

    /// @dev Both claims for `who` in round `id`, counting a payout out of a round nobody settled.
    function _claimBoth(uint256 id, address who) internal {
        (,,,,, uint64 deadline,,,, bool settled,) = l.market.rounds(id);
        bool isVoid = !settled && vm.getBlockTimestamp() >= deadline;
        bool a = _act(STANDIN, abi.encodeCall(SecondaryMarket.claimShares, (id, who)));
        bool b = _act(STANDIN, abi.encodeCall(SecondaryMarket.claimQuote, (id, who)));
        if (isVoid && (a || b)) ++_voidClaims;
    }

    function _books() internal view {
        address[] memory all = _everyone();
        uint256 escrowed;
        for (uint256 i; i < all.length; ++i) {
            escrowed += l.policy.escrowedBalance(all[i]);
        }
        assertLe(escrowed, l.shares.balanceOf(address(l.market)), "escrowed books exceed the market vault");
    }

    function _denominator() internal {
        vm.roll(vm.getBlockNumber() + 1);
        uint256 pid = ++_pid;
        vm.prank(KIT_FOUNDER);
        l.dao.openProposal(pid);
        uint48 snap = l.dao.snapshotBlock(pid);
        vm.roll(vm.getBlockNumber() + 1);
        ActivationVoting policy = ActivationVoting(address(l.policy));
        address[] memory all = _everyone();
        uint256 summed;
        for (uint256 i; i < all.length; ++i) {
            summed += policy.getPastCapacity(all[i], snap);
        }
        assertEq(
            policy.votingSupplyAt(l.dao.supplySnapshot(pid), snap),
            summed,
            "the quorum denominator is the sum of every holder's eligible amount"
        );
    }

    function _resolveAndClaimAll() internal {
        uint256 rounds = l.market.roundCount();
        for (uint256 id = 1; id <= rounds; ++id) {
            (,,,, uint64 closesAt, uint64 deadline,,,, bool settled,) = l.market.rounds(id);
            if (!settled && vm.getBlockTimestamp() < deadline) {
                if (vm.getBlockTimestamp() < closesAt) vm.warp(closesAt);
                l.market.settle(id);
            }
            address[] memory all = _everyone();
            for (uint256 i; i < all.length; ++i) {
                _claimBoth(id, all[i]);
            }
        }
    }

    function testFuzz_the_real_market_path_keeps_books_ages_and_the_denominator(uint256 seed, uint8[14] memory ops)
        external
    {
        _walk(seed, ops);
    }

    /// @dev The walk must really trade, or its invariants hold vacuously: across a few seeds of fixed scripts
    /// (the market's own full cycle, then one that leaves a round unsettled so it goes void) the walk fills
    /// lots through the production market, fills several sellers partially, pays claims out of a void round,
    /// lets a holder with Shares in escrow ragequit, and takes donations. Each ghost counter must be non-zero
    /// across the seeds, so a change that makes the walk skip one of these shapes fails here.
    function test_the_walk_really_trades() public {
        uint8[14][2] memory scripts = [
            [0, 1, 1, 1, 3, 3, 3, 7, 8, 8, 9, 10, 0, 11],
            [0, 1, 1, 1, 3, 3, 9, 9, 11, 10, 10, 8, 0, 9]
        ];
        Stats memory total;
        for (uint256 k; k < scripts.length; ++k) {
            for (uint256 seed; seed < 12; ++seed) {
                uint256 snap = vm.snapshotState();
                Stats memory st = _walk(seed, scripts[k]);
                total.filledLots += st.filledLots;
                total.partialAcrossSellers += st.partialAcrossSellers;
                total.voidClaims += st.voidClaims;
                total.ragequitsWithEscrow += st.ragequitsWithEscrow;
                total.donations += st.donations;
                assertTrue(vm.revertToState(snap));
            }
        }
        assertGt(total.filledLots, 0, "some seed fills lots through the real market");
        assertGt(total.partialAcrossSellers, 0, "some seed fills several sellers, one of them partially");
        assertGt(total.voidClaims, 0, "some seed pays a claim out of a void round");
        assertGt(total.ragequitsWithEscrow, 0, "some seed ragequits a holder who has Shares in escrow");
        assertGt(total.donations, 0, "some seed donates into the market");
    }

    /// @dev The strict walk's first catch, pinned: this input has a bidder cancel twice, and the second
    /// `cancelBid` used to panic on `wanted -= lots` instead of being refused as `NoOrder`.
    function test_the_walk_input_that_cancelled_a_bid_twice_stays_green() public {
        uint8[14] memory ops = [252, 0, 25, 3, 6, 1, 6, 51, 9, 154, 230, 162, 1, 0];
        _walk(9049122748650351464038, ops);
    }

    /// @dev Returns what the walk exercised across every round it ran.
    function _walk(uint256 seed, uint8[14] memory ops) internal returns (Stats memory st) {
        _mintQuote(S1, 1_000_000e6);
        _mintQuote(S2, 1_000_000e6);
        _mintQuote(S3, 1_000_000e6);
        _enableListing(l);
        for (uint256 i; i < ops.length; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i, ops[i])));
            uint256 id = l.market.roundCount();
            address a = _who(r >> 8);
            uint256 op = ops[i] % 12;
            uint256 lots = 1 + (r >> 16) % 12;
            uint16 step = uint16((r >> 40) % 9);
            if (op == 0) {
                // Block time only moves forward: wait for the cadence if it has not elapsed yet.
                uint256 due = l.market.lastOpenAt() + WEEK + (r >> 60) % 2 days;
                if (due > vm.getBlockTimestamp()) vm.warp(due);
                _act(STANDIN, abi.encodeCall(SecondaryMarket.openRound, ()));
            } else if (op == 1 || op == 2) {
                uint256 held = l.shares.balanceOf(a) / LOT_SIZE;
                if (held != 0 && id != 0) {
                    _act(a, abi.encodeCall(SecondaryMarket.sell, (id, uint128(lots > held ? held : lots), step)));
                }
            } else if (op == 3 || op == 4) {
                if (id != 0) _act(a, abi.encodeCall(SecondaryMarket.bid, (id, uint128(lots), step)));
            } else if (op == 5) {
                if (id != 0) _act(a, abi.encodeCall(SecondaryMarket.cancelSell, (id)));
            } else if (op == 6) {
                if (id != 0) _act(a, abi.encodeCall(SecondaryMarket.cancelBid, (id)));
            } else if (op == 7) {
                if (id != 0) {
                    (,,,, uint64 closesAt,,,,,,) = l.market.rounds(id);
                    if (vm.getBlockTimestamp() < closesAt) vm.warp(closesAt);
                    _act(STANDIN, abi.encodeCall(SecondaryMarket.settle, (id)));
                }
            } else if (op == 8) {
                if (id != 0) {
                    _claimBoth(id, a);
                }
            } else if (op == 9) {
                uint256 bal = l.shares.balanceOf(a);
                if (bal != 0) {
                    address[] memory tokens = new address[](1);
                    bool escrowed = l.policy.escrowedBalance(a) != 0;
                    // An exit of any size up to the balance must always work: a revert here (a Panic in the
                    // sender-side hook, say) is a financial exit stuck, so it is not caught.
                    vm.prank(a);
                    l.dao.ragequit(tokens, 1 + (r >> 20) % bal, 0);
                    if (escrowed) ++_ragequitsWithEscrow;
                }
            } else if (op == 10) {
                vm.warp(vm.getBlockTimestamp() + 1 days + (r >> 20) % 3 days);
            } else {
                uint256 bal = l.shares.balanceOf(a);
                if (bal >= 1e18) {
                    vm.prank(a);
                    l.shares.transfer(address(l.market), 1e18);
                    _donated[a] += 1e18;
                    _donatedTotal += 1e18;
                    ++_donations;
                }
            }
            vm.roll(vm.getBlockNumber() + 1);
            _books();
            if (i % 5 == 4) _denominator();
        }

        // Let every round run out its window, then pay everything: only donations may remain.
        vm.warp(vm.getBlockTimestamp() + 3 days);
        _resolveAndClaimAll();
        vm.warp(vm.getBlockTimestamp() + 3 days);
        _resolveAndClaimAll();
        address[] memory all = _everyone();
        for (uint256 i; i < all.length; ++i) {
            assertEq(l.policy.escrowedBalance(all[i]), _donated[all[i]], "only a donor's own donation stays in escrow");
        }
        assertEq(l.shares.balanceOf(address(l.market)), _donatedTotal, "the market holds exactly the donations");
        assertEq(l.quote.balanceOf(address(l.market)), 0, "no quote is stranded");
        _denominator();
        for (uint256 id = 1; id <= l.market.roundCount(); ++id) {
            address[] memory sellers = l.market.roundSellers(id);
            uint256 sellersThatSold;
            bool someoneSoldLess;
            for (uint256 i; i < sellers.length; ++i) {
                (uint128 offered,, uint128 filled,,,) = l.market.sells(id, sellers[i]);
                st.filledLots += filled;
                if (filled != 0) ++sellersThatSold;
                if (filled != 0 && filled < offered) someoneSoldLess = true;
            }
            if (sellersThatSold >= 2 && someoneSoldLess) ++st.partialAcrossSellers;
        }
        st.voidClaims = _voidClaims;
        st.ragequitsWithEscrow = _ragequitsWithEscrow;
        st.donations = _donations;
    }
}
