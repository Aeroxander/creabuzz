// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OpenBounty} from "../../src/OpenBounty.sol";
import {MandateCurrency} from "../TreasuryMandate.t.sol";

/// @notice Drives two bounties on posts through random orders of money in, claims, backing, starts, payments, refunds
/// and time, keeping a ledger of what each call actually moved and flagging anything the spec forbids.
contract OpenBountyHandler is Test {
    OpenBounty public bounty;
    MandateCurrency public usd;
    address[] public actors;
    uint256[] public ids;

    mapping(uint256 => uint256) public funded;
    mapping(uint256 => uint256) public paid;
    mapping(uint256 => uint256) public refunded;
    /// @notice Something the spec forbids happened (a reason is logged).
    bool public broken;
    uint256 public pays;
    uint256 public refunds;
    uint256 public runs;

    constructor(OpenBounty bounty_, MandateCurrency usd_, address[] memory actors_, uint256[] memory ids_) {
        bounty = bounty_;
        usd = usd_;
        actors = actors_;
        ids = ids_;
        for (uint256 i; i < ids_.length; ++i) {
            (,,,,,, uint128 total,,,,,,) = bounty_.bounties(ids_[i]);
            funded[ids_[i]] = total;
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function _flag(string memory why) internal {
        console.log("forbidden:", why);
        broken = true;
    }

    function _runOf(uint256 id) internal view returns (uint32 runClaim, uint64 runSince) {
        (,,,,,,,,,, runClaim, runSince,) = bounty.bounties(id);
    }

    function _claimCount(uint256 id) internal view returns (uint32 count) {
        (,,,,,,,,, count,,,) = bounty.bounties(id);
    }

    function fund(uint256 bSeed, uint256 aSeed, uint256 amount) external {
        uint256 id = ids[bSeed % ids.length];
        address who = actors[aSeed % actors.length];
        amount = bound(amount, 1, 50e6);
        (uint32 runBefore,) = _runOf(id);
        usd.mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(bounty), amount);
        try bounty.fund(id, amount) {
            funded[id] += amount;
            if (runBefore != 0) _flag("money came in during a run");
        } catch {}
        vm.stopPrank();
    }

    function file(uint256 bSeed, uint256 aSeed) external {
        uint256 id = ids[bSeed % ids.length];
        vm.prank(actors[aSeed % actors.length]);
        try bounty.fileClaim(id, "evidence") {} catch {}
    }

    function withdraw(uint256 bSeed, uint256 aSeed) external {
        uint256 id = ids[bSeed % ids.length];
        vm.prank(actors[aSeed % actors.length]);
        try bounty.withdrawClaim(id) {} catch {}
    }

    function back(uint256 bSeed, uint256 aSeed, uint256 cSeed) external {
        uint256 id = ids[bSeed % ids.length];
        uint32 count = _claimCount(id);
        if (count == 0) return;
        (uint32 runBefore,) = _runOf(id);
        vm.prank(actors[aSeed % actors.length]);
        try bounty.back(id, uint32(1 + cSeed % count)) {
            (uint32 runAfter,) = _runOf(id);
            if (runAfter != 0 && runAfter != runBefore) ++runs;
        } catch {}
    }

    function unback(uint256 bSeed, uint256 aSeed) external {
        uint256 id = ids[bSeed % ids.length];
        vm.prank(actors[aSeed % actors.length]);
        try bounty.unback(id) {} catch {}
    }

    function start(uint256 bSeed, uint256 cSeed) external {
        uint256 id = ids[bSeed % ids.length];
        uint32 count = _claimCount(id);
        if (count == 0) return;
        try bounty.start(id, uint32(1 + cSeed % count)) {
            ++runs;
        } catch {}
    }

    function pay(uint256 bSeed) external {
        uint256 id = ids[bSeed % ids.length];
        (uint32 runClaim, uint64 runSince) = _runOf(id);
        (,,, uint64 refundsFrom,,, uint128 total,,,,,,) = bounty.bounties(id);
        try bounty.pay(id) {
            paid[id] = total;
            ++pays;
            if (runClaim == 0) _flag("paid with no run");
            if (block.timestamp < runSince + bounty.RUN()) _flag("paid before the run was nine days old");
            if (block.timestamp >= refundsFrom) _flag("paid at or after refundsFrom");
            if (refunded[id] != 0) _flag("paid after a refund");
        } catch {}
    }

    function refund(uint256 bSeed, uint256 aSeed) external {
        uint256 id = ids[bSeed % ids.length];
        address who = actors[aSeed % actors.length];
        uint256 owed = bounty.funded(id, who);
        try bounty.refund(id, who) {
            refunded[id] += owed;
            ++refunds;
            if (paid[id] != 0) _flag("refunded after a payment");
        } catch {}
    }

    function wait(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 hours, 6 days));
    }

    /// @dev Let a run age out and try to pay it, so payments are reached often, not only when the dice line up.
    function waitAndPay(uint256 bSeed) external {
        uint256 id = ids[bSeed % ids.length];
        (uint32 runClaim, uint64 runSince) = _runOf(id);
        if (runClaim == 0) return;
        uint64 payableAt = runSince + bounty.RUN();
        if (block.timestamp < payableAt) vm.warp(payableAt);
        this.pay(bSeed);
    }
}

/// @notice The books and the rules of a bounty on a post (docs/v3-review/OPEN-BOUNTY-STATES.md, invariants 1-8) hold
/// after every call of every random sequence.
///
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 150
/// forge-config: default.invariant.fail-on-revert = true
contract OpenBountyInvariantTest is Test {
    OpenBountyHandler internal handler;
    OpenBounty internal bounty;
    MandateCurrency internal usd;

    function setUp() public {
        vm.warp(100 days);
        usd = new MandateCurrency();
        bounty = new OpenBounty(IERC20(address(usd)));
        address[] memory actors = new address[](4);
        for (uint256 i; i < actors.length; ++i) {
            actors[i] = address(uint160(0xA001 + i));
        }
        uint256[] memory ids = new uint256[](2);
        usd.mint(actors[0], 100e6);
        vm.startPrank(actors[0]);
        usd.approve(address(bounty), type(uint256).max);
        ids[0] = bounty.open(keccak256("post one"), "words one", uint64(block.timestamp + 20 days), 40e6);
        ids[1] = bounty.open(keccak256("post two"), "words two", uint64(block.timestamp + 45 days), 40e6);
        vm.stopPrank();
        handler = new OpenBountyHandler(bounty, usd, actors, ids);
        targetContract(address(handler));
    }

    function _b(uint256 id) internal view returns (OpenBounty.Bounty memory b) {
        (
            b.creator,
            b.openedAt,
            b.deadline,
            b.refundsFrom,
            b.post,
            b.wordsHash,
            b.total,
            b.refunded,
            b.counting,
            b.claimCount,
            b.runClaim,
            b.runSince,
            b.paidClaim
        ) = bounty.bounties(id);
    }

    /// @dev Totals across a run, printed with -vv: a run where nothing paid or refunded tests little.
    function afterInvariant() public view {
        console.log("runs", handler.runs(), "pays", handler.pays());
        console.log("refunds", handler.refunds());
    }

    /// Invariant 1: the contract holds exactly what the unpaid bounties still owe, as its books and as the ledger say.
    function invariant_the_contract_holds_exactly_what_is_still_owed() public view {
        uint256 owed;
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            OpenBounty.Bounty memory b = _b(id);
            uint256 ledger = handler.funded(id) - handler.paid(id) - handler.refunded(id);
            assertEq(bounty.held(id), ledger);
            assertEq(b.paidClaim == 0 ? b.total - b.refunded : 0, ledger);
            owed += ledger;
        }
        assertEq(usd.balanceOf(address(bounty)), owed);
    }

    /// Invariants 2 and 8: paid or refunded, never both; a payment is the whole pot.
    function invariant_a_bounty_pays_its_whole_pot_or_refunds_never_both() public view {
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            assertTrue(handler.paid(id) == 0 || handler.refunded(id) == 0);
            assertTrue(handler.paid(id) == 0 || handler.paid(id) == handler.funded(id));
        }
    }

    /// Invariant 3: the count and every claim's backing are exactly the sums they stand for.
    function invariant_the_count_and_each_backing_are_the_sums_they_stand_for() public view {
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            OpenBounty.Bounty memory b = _b(id);
            uint256 counting;
            for (uint256 a; a < handler.actorCount(); ++a) {
                address who = handler.actors(a);
                if (bounty.openClaim(id, who) == 0) counting += bounty.funded(id, who);
            }
            assertEq(b.counting, counting);
            for (uint32 c = 1; c <= b.claimCount; ++c) {
                uint256 backing;
                for (uint256 a; a < handler.actorCount(); ++a) {
                    address who = handler.actors(a);
                    if (bounty.backs(id, who) == c) backing += bounty.funded(id, who);
                }
                (,, uint128 recorded,) = bounty.claims(id, c);
                assertEq(recorded, backing);
            }
        }
    }

    /// Invariants 4 and 5: at most one open claim has a majority, and a run's claim always has one.
    function invariant_at_most_one_majority_and_a_run_always_has_it() public view {
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            OpenBounty.Bounty memory b = _b(id);
            uint256 majorities;
            for (uint32 c = 1; c <= b.claimCount; ++c) {
                if (bounty.qualifies(id, c)) ++majorities;
            }
            assertLe(majorities, 1);
            if (b.runClaim != 0 && b.paidClaim == 0) {
                assertTrue(bounty.qualifies(id, b.runClaim));
                assertLt(b.runSince, b.deadline);
            }
        }
    }

    /// Invariants 6 and 7: no payment before nine days or after refundsFrom, none after a refund, no money during a run.
    function invariant_nothing_the_spec_forbids_happened() public view {
        assertFalse(handler.broken());
    }
}
