// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Call, Moloch, Summoner, Shares, Loot, newSummoner} from "../../src/majeur/MolochPatched.sol";
import {AllocationVoting} from "../../src/AllocationVoting.sol";
import {FundingTerms} from "../../src/FundingTerms.sol";
import {MilestoneChallenge} from "../../src/MilestoneChallenge.sol";
import {MockUSDC} from "./MoneyPathsHandler.sol";
import {ExitPreview} from "./ExitPreview.sol";

/// @notice Leaving pays exactly what the exit screen shows (D51). For random DAOs (team Shares partly locked behind
/// milestones, Shares the DAO keeps, Loot, USDC and ETH in the treasury) the test reads what the screen reads, runs the
/// screen's own TypeScript (`web/src/features/launchpad/lib/ragequit-position.ts`, through `test/ffi/exit-preview.mjs`),
/// and then leaves on the chain: the free Shares the screen offers and the amounts it shows must be what `ragequit` burns
/// and pays, to the unit. It also holds the Solidity port in `ExitPreview.sol` (used by the invariant handler) to the
/// TypeScript, and checks that one Share more than the screen offers is refused.
///
/// Needs `node` (>= 22.6, the web's own runtime) on PATH; ffi is on in foundry.toml.
contract RagequitPreviewFfiTest is Test {
    address internal constant TEAM = address(0x7001);
    address internal constant BACKER = address(0xB001);
    address internal constant OTHER = address(0xB002);
    address internal constant ETH = address(0);

    struct Case {
        uint256 teamShares;
        uint256 backerShares;
        uint256 daoShares;
        uint256 exiterLoot;
        uint256 otherLoot;
        uint16 bps0;
        uint16 bps1;
        bool firstStood;
        uint256 poolUsdc;
        uint256 poolEth;
        uint256 lootSeed;
        bool teamExits;
        uint16 exitFeeBps;
        /// @dev The backer holds every unit that can leave and leaves with all of it (D136).
        bool lastOut;
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_exit_pays_exactly_what_the_screen_shows(Case memory c) public {
        c.teamShares = bound(c.teamShares, 1e6, 1e27);
        c.backerShares = bound(c.backerShares, 1, 1e27);
        c.daoShares = bound(c.daoShares, 0, 1e27);
        c.exiterLoot = bound(c.exiterLoot, 0, 1e27);
        c.otherLoot = bound(c.otherLoot, 0, 1e27);
        c.bps0 = uint16(bound(c.bps0, 1, 5000));
        c.bps1 = uint16(bound(c.bps1, 1, 5000));
        c.poolUsdc = bound(c.poolUsdc, 0, 1e15);
        c.poolEth = bound(c.poolEth, 0, 1e24);
        c.exitFeeBps = uint16(bound(c.exitFeeBps, 0, 500));
        if (c.lastOut) {
            // The team's Shares all locked, nobody else holding Loot: the backer's units are all that can leave.
            (c.teamExits, c.otherLoot, c.bps0, c.bps1, c.firstStood) = (false, 0, 5000, 5000, false);
            c.teamShares -= c.teamShares % 10_000; // so the two halves lock every one of them
        }

        (Moloch dao, MilestoneChallenge lock, MockUSDC usdc) = _launch(c);
        Shares shares = dao.shares();
        Loot loot = dao.loot();
        address exiter = c.teamExits ? TEAM : BACKER;

        uint256 sharesBalance = shares.balanceOf(exiter);
        uint256 locked = lock.lockedOf(exiter);
        uint256 lootBalance = loot.balanceOf(exiter);
        uint256 lootToBurn = c.lastOut ? lootBalance : bound(c.lootSeed, 0, lootBalance);
        uint256 sharesTotal = shares.totalSupply();
        uint256 lootTotal = loot.totalSupply();
        uint256 daoHeld = shares.balanceOf(address(dao)) + loot.balanceOf(address(dao));
        uint256 lockedTotal = lock.totalLocked();
        uint256 poolUsdc = usdc.balanceOf(address(dao));
        uint256 poolEth = address(dao).balance;

        uint256 fee = AllocationVoting(dao.votingWeight()).mandateFactory().fundingTerms().exitFeeOf(address(dao));
        assertEq(fee, c.exitFeeBps, "the terms' fee applies");
        (uint256 burnable, uint256 dueUsdc, uint256 dueEth) = _screen(
            [
                sharesBalance,
                locked,
                lootToBurn,
                lootBalance,
                sharesTotal,
                lootTotal,
                daoHeld,
                lockedTotal,
                poolUsdc,
                poolEth,
                fee
            ]
        );

        // The Solidity port the invariant handler uses says the same thing as the screen.
        assertEq(burnable, ExitPreview.burnable(sharesBalance, locked), "port: burnable");
        uint256 total = ExitPreview.denominator(sharesTotal, lootTotal, daoHeld, lockedTotal);
        uint256 charged = ExitPreview.feeFor(burnable + lootToBurn, total, fee);
        assertEq(
            dueUsdc,
            ExitPreview.afterFee(ExitPreview.due(poolUsdc, burnable + lootToBurn, total), charged),
            "port: USDC"
        );
        assertEq(
            dueEth, ExitPreview.afterFee(ExitPreview.due(poolEth, burnable + lootToBurn, total), charged), "port: ETH"
        );

        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (ETH, address(usdc));

        // One Share more than the screen offers must be refused while anything is locked.
        if (locked != 0 && burnable < sharesBalance) {
            vm.prank(exiter);
            vm.expectRevert(Shares.LockedShares.selector);
            dao.ragequit(tokens, burnable + 1, 0);
        }
        if (burnable + lootToBurn == 0) return;

        uint256 usdcBefore = usdc.balanceOf(exiter);
        uint256 ethBefore = exiter.balance;
        vm.prank(exiter);
        dao.ragequit(tokens, burnable, lootToBurn);
        assertEq(usdc.balanceOf(exiter) - usdcBefore, dueUsdc, "chain paid other USDC than the screen showed");
        assertEq(exiter.balance - ethBefore, dueEth, "chain paid other ETH than the screen showed");
        assertEq(shares.balanceOf(exiter), sharesBalance - burnable, "burned other Shares than offered");
        assertEq(shares.balanceOf(exiter), locked < sharesBalance ? locked : sharesBalance, "the locked Shares stay");
        if (burnable + lootToBurn == total) {
            assertEq(usdc.balanceOf(address(dao)), 0, "the last one out takes everything, fee or not");
        }
        if (c.lastOut) assertEq(burnable + lootToBurn, total, "the case is the last one out");
    }

    function _launch(Case memory c) internal returns (Moloch dao, MilestoneChallenge lock, MockUSDC usdc) {
        usdc = new MockUSDC();
        Summoner summoner = newSummoner();
        address[] memory holders = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (holders[0], amounts[0]) = (TEAM, c.teamShares);
        (holders[1], amounts[1]) = (BACKER, c.backerShares);
        dao = summoner.summon("P", "P", "", 500, true, address(0), bytes32(0), holders, amounts, new Call[](0));
        Shares sharesToken = dao.shares();
        Loot lootToken = dao.loot();
        vm.startPrank(address(dao));
        if (c.daoShares != 0) sharesToken.mintFromMoloch(address(dao), c.daoShares);
        if (c.exiterLoot != 0) lootToken.mintFromMoloch(c.teamExits ? TEAM : BACKER, c.exiterLoot);
        if (c.otherLoot != 0) lootToken.mintFromMoloch(OTHER, c.otherLoot);
        vm.stopPrank();

        address[] memory team = new address[](1);
        team[0] = TEAM;
        uint256[] memory totals = new uint256[](1);
        totals[0] = c.teamShares;
        bytes32[] memory checks = new bytes32[](2);
        (checks[0], checks[1]) = (keccak256("one"), keccak256("two"));
        uint16[] memory bps = new uint16[](2);
        (bps[0], bps[1]) = (c.bps0, c.bps1);
        lock = new MilestoneChallenge(
            address(dao),
            team,
            totals,
            checks,
            bps,
            MilestoneChallenge.Terms(1 days, 1 days, 0, 300, uint64(block.number), address(0), 0, 0)
        );
        Shares shares = dao.shares();
        vm.prank(address(dao));
        shares.setLockGuard(address(lock));
        if (c.firstStood) {
            vm.prank(TEAM);
            lock.submit(0, keccak256("evidence"));
            (,,,,, uint64 windowEnds,,) = lock.milestone(0);
            vm.warp(windowEnds);
            lock.finish(0);
        }
        usdc.mint(address(dao), c.poolUsdc);
        vm.deal(address(dao), c.poolEth);
        // Funding terms with the case's exit fee, past their notice, so the exit charges it (D135).
        FundingTerms terms = AllocationVoting(dao.votingWeight()).mandateFactory().fundingTerms();
        vm.prank(address(dao));
        terms.publish(false, 1, address(usdc), c.exitFeeBps);
        // (Read the clock through the cheatcode: via-IR may reuse a `block.timestamp` read from before the warp above.)
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.roll(block.number + 1);
    }

    function _screen(uint256[11] memory v) internal returns (uint256 burnable, uint256 dueUsdc, uint256 dueEth) {
        string[] memory cmd = new string[](14);
        cmd[0] = "node";
        cmd[1] = "--experimental-strip-types";
        cmd[2] = "test/ffi/exit-preview.mjs";
        for (uint256 i; i < 11; ++i) {
            cmd[3 + i] = vm.toString(v[i]);
        }
        (burnable, dueUsdc, dueEth) = abi.decode(vm.ffi(cmd), (uint256, uint256, uint256));
    }
}
