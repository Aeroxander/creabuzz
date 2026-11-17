// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Launcher} from "../../src/Launcher.sol";
import {ShareToken} from "../../src/ShareToken.sol";
import {Treasury} from "../../src/Treasury.sol";
import {Vester} from "../../src/Vester.sol";
import {QuoteToken} from "../mocks/QuoteToken.sol";

/// @notice The random user of one project for the invariant tests. Every public function is one thing a person (founder,
/// agent, holder, stranger, the platform's opener or sale path) can do; the invariant contract checks the rules after
/// each sequence. The handler keeps its own books ("ghosts") of what it did, so the rules are checked against numbers
/// the Treasury did not produce.
contract TreasuryHandler is Test {
    uint256 internal constant SHARE = 1e18;

    Launcher public launcher;
    Treasury public t;
    ShareToken public shares;
    Vester public v;
    QuoteToken public usd;
    address public founder;
    address public opener;
    address public salePath;
    address public platform;
    address[4] public holders;
    address[2] public agents;
    address public donor;
    address public stranger;

    // ---- the handler's own books
    uint256 public burned; // Shares burned by holders and exits
    uint256 public stray; // dollars that sit in the Treasury outside every bucket (donations, unsettled sale money)
    uint256 public sharesDonatedToTreasury;
    uint256 public reserveReleased;
    bool public exitOverpaid; // an exit paid more than floor * burned / counting
    bool public perShareFell; // an exit lowered the floor per Share of those who remain
    bool public denominatorWrong; // the Treasury's counting supply is not total - held by Treasury - unreleased in Vester
    bool public claimMovedCounting; // a Vester claim (by anyone, for anyone) changed the exit denominator
    bool public exitedBeforeClose; // an exit paid before the sale's finish was marked complete
    uint256 public grantedGhost = 200_000_000 * SHARE; // Shares ever granted in the Vester: the founder's, and pre-pool gifts
    uint256 public poolOpenedAt; // when the pool was proven open (0 before)
    bool public spendableTouched; // anything but `spend` lowered `spendable`
    bool public spentTooMuch; // `spend` sent more than spendable plus what the release owed
    bool public exitTookSpendable; // an exit lowered `spendable`, or added more to it than the fee's 4
    uint256 public stakeGranted; // the stake moved out of the reserve when the pool opened
    uint256 public exits;
    uint256 public spends;
    uint256 public giftsMade;
    uint256 public settles;
    uint256 public claims;

    struct Use {
        uint256 time;
        uint256 amount;
        uint256 cap;
    }

    Use[] internal _gifts;
    mapping(address => Use[]) internal _agentSpends;
    mapping(address => Use[]) internal _agentGives;

    constructor(Launcher launcher_, Treasury t_, ShareToken shares_, Vester v_, QuoteToken usd_, address founder_) {
        (launcher, t, shares, v, usd, founder) = (launcher_, t_, shares_, v_, usd_, founder_);
        opener = t_.opener();
        salePath = t_.salePath();
        platform = t_.platform();
        for (uint256 i; i < 4; ++i) {
            holders[i] = makeAddr(string.concat("holder", vm.toString(i)));
            vm.prank(holders[i]);
            shares.approve(address(t), type(uint256).max);
        }
        agents = [makeAddr("agent0"), makeAddr("agent1")];
        donor = makeAddr("donor");
        stranger = makeAddr("stranger");
        vm.startPrank(founder);
        t.authoriseAgent(agents[0]);
        t.setAgent(agents[1], uint128(5e6), uint128(100_000 * SHARE));
        vm.stopPrank();
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _giver(uint256 sel) internal view returns (address) {
        sel = sel % 3;
        return sel == 0 ? founder : agents[sel - 1];
    }

    function _holder(uint256 i) internal view returns (address) {
        return holders[i % 4];
    }

    // ================================================================================================== time and clock

    function warp(uint256 dt) external {
        vm.warp(_now() + bound(dt, 0, 40 days));
    }

    function checkIn(uint256 who) external {
        vm.prank(_giver(who));
        try t.checkIn() {} catch {}
    }

    function release() external {
        uint256 before = t.spendable();
        vm.prank(stranger);
        t.release();
        if (t.spendable() < before) spendableTouched = true;
    }

    // ===================================================================================================== sale money

    function openPool() external {
        uint256 reserveBefore = t.reserve();
        vm.prank(opener);
        try t.markPoolOpen() {
            poolOpenedAt = _now();
            stakeGranted = reserveBefore - t.reserve();
            grantedGhost += stakeGranted; // the stake is held in the Vester like every Share given before the market
        } catch {}
    }

    /// @dev The sale's finish is complete (the unsold Shares are swept in milestone 3); exits may open.
    function closeSale() external {
        vm.prank(opener);
        try t.markSaleClosed() {} catch {}
    }

    /// @dev What the exit denominator must be, from the handler's own books: all Shares, less the Treasury's, the Rounds' and the
    /// Finisher's, less the part of everything ever granted in the Vester that the 365-day schedule has not released, whoever
    /// claimed.
    function independentCounting() public view returns (uint256) {
        uint256 unreleased = grantedGhost;
        if (poolOpenedAt != 0) {
            uint256 elapsed = _now() - poolOpenedAt;
            unreleased = elapsed >= 365 days ? 0 : grantedGhost - grantedGhost * elapsed / 365 days;
        }
        return shares.totalSupply() - shares.balanceOf(address(t)) - shares.balanceOf(address(t.rounds()))
            - shares.balanceOf(opener) - unreleased;
    }

    /// @dev Sale money (or a donation) arrives at the Treasury without being split.
    function arrive(uint256 amount) external {
        amount = bound(amount, 1, 1e16);
        usd.mint(address(t), amount);
        stray += amount;
    }

    function settle(uint256 amount) external {
        uint256 arrived = t.unaccounted();
        amount = bound(amount, 0, arrived + 1);
        uint256 spendableBefore = t.spendable();
        vm.prank(stranger);
        try t.settle(amount) {
            stray -= amount;
            settles++;
        } catch {}
        // settle and its release only add to spendable
        if (t.spendable() < spendableBefore) spendableTouched = true;
    }

    function topUp(uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        usd.mint(donor, amount);
        vm.startPrank(donor);
        usd.approve(address(t), amount);
        t.topUp(amount);
        vm.stopPrank();
    }

    function shareRevenue(uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        usd.mint(donor, amount);
        vm.startPrank(donor);
        usd.approve(address(t), amount);
        t.shareRevenue(amount);
        vm.stopPrank();
    }

    // ===================================================================================================== Shares

    /// @dev The sale delivers Shares (from the project's Finisher, which is the opener).
    function distribute(uint256 to, uint256 amount) external {
        amount = bound(amount, 0, shares.balanceOf(opener));
        vm.prank(opener);
        shares.transfer(_holder(to), amount);
    }

    function holderTransfer(uint256 from, uint256 to, uint256 amount) external {
        address a = _holder(from);
        amount = bound(amount, 0, shares.balanceOf(a));
        vm.prank(a);
        shares.transfer(_holder(to), amount);
    }

    function burnOwn(uint256 who, uint256 amount) external {
        address a = _holder(who);
        amount = bound(amount, 0, shares.balanceOf(a));
        vm.prank(a);
        shares.burn(amount);
        burned += amount;
    }

    function donateShares(uint256 who, bool toTreasury, uint256 amount) external {
        address a = _holder(who);
        amount = bound(amount, 0, shares.balanceOf(a));
        vm.prank(a);
        shares.transfer(toTreasury ? address(t) : address(v), amount);
        if (toTreasury) sharesDonatedToTreasury += amount;
    }

    function giveShares(uint256 sel, uint256 to, uint256 amount) external {
        address giver = _giver(sel);
        amount = bound(amount, 0, 12_000_000 * SHARE);
        bool open = t.poolOpen();
        uint256 cap = t.countingSupply() * t.GIFT_CAP_BPS() / 10_000; // 1% of the Shares in people's hands
        vm.prank(giver);
        try t.giveShares(_holder(to), amount) {
            giftsMade++;
            if (!open) grantedGhost += amount;
            if (open) _gifts.push(Use(_now(), amount, cap));
            if (giver != founder) {
                (,, uint128 shareCap) = t.agents(giver);
                _agentGives[giver].push(Use(_now(), amount, shareCap));
            }
        } catch {}
    }

    function claimVest(uint256 who) external {
        address a = who % 5 == 4 ? founder : _holder(who);
        uint256 countingBefore = t.countingSupply();
        try v.claim(a) returns (uint256 got) {
            if (got > 0) claims++;
        } catch {}
        if (t.countingSupply() != countingBefore) claimMovedCounting = true;
    }

    function releaseReserve(uint256 to, uint256 amount) external {
        amount = bound(amount, 0, t.reserve());
        vm.prank(salePath);
        try t.releaseReserve(_holder(to), amount) {
            reserveReleased += amount;
        } catch {}
    }

    /// @dev The reserve sale is finished (the sale path says so); exits open again.
    function closeReserveSale() external {
        vm.prank(salePath);
        try t.closeReserveSale() {} catch {}
    }

    // ==================================================================================================== spending

    function spend(uint256 sel, uint256 amount) external {
        address who = _giver(sel);
        amount = bound(amount, 0, t.spendable() + t.pendingRelease() + 5);
        uint256 available = t.spendable() + t.pendingRelease();
        vm.prank(who);
        try t.spend(makeAddr("payee"), amount) {
            spends++;
            if (amount > available) spentTooMuch = true;
            if (who != founder) {
                (, uint128 usdCap,) = t.agents(who);
                _agentSpends[who].push(Use(_now(), amount, usdCap));
            }
        } catch {}
    }

    function setAgent(uint256 sel, uint128 usdCap, uint128 shareCap) external {
        vm.prank(founder);
        t.setAgent(agents[sel % 2], uint128(bound(usdCap, 0, 1e9)), uint128(bound(shareCap, 0, 20_000_000 * SHARE)));
    }

    function revokeAgent(uint256 sel) external {
        vm.prank(founder);
        t.revokeAgent(agents[sel % 2]);
    }

    function authoriseAgent(uint256 sel) external {
        vm.prank(founder);
        t.authoriseAgent(agents[sel % 2]);
    }

    // ================================================================================================== the exit

    function handBack(uint256 who, uint256 amount) external {
        address a = _holder(who);
        amount = bound(amount, 0, shares.balanceOf(a) + 3);
        // work out today's release first, so the numbers below are the ones the exit will use
        t.release();
        uint256 meltingBefore = t.melting();
        uint256 permanentBefore = t.permanentFloor();
        uint256 supplyBefore = shares.totalSupply();
        uint256 feesBefore = t.feesOwed();
        uint256 countingBefore = t.countingSupply();
        if (countingBefore != independentCounting()) denominatorWrong = true;
        bool closed = t.saleClosed();
        uint256 spendableBefore = t.spendable();
        vm.prank(a);
        try t.handBack(amount) returns (uint256 paid) {
            exits++;
            if (!closed) exitedBeforeClose = true;
            burned += amount;
            // the slice: melting by the Shares in hands, Share revenue by every Share that exists
            uint256 slice = meltingBefore * amount / countingBefore + permanentBefore * amount / supplyBefore;
            if (paid > slice) exitOverpaid = true;
            // the floor per Share of those who remain never falls, on either floor
            uint256 countingAfter = t.countingSupply();
            if (countingAfter > 0 && t.melting() * countingBefore < meltingBefore * countingAfter) perShareFell = true;
            if (t.permanentFloor() * supplyBefore < permanentBefore * shares.totalSupply()) perShareFell = true;
            // spendable gains exactly the fee's 4: the slice less what the holder and the platform got
            if (t.spendable() != spendableBefore + (slice - paid - (t.feesOwed() - feesBefore))) {
                exitTookSpendable = true;
            }
        } catch {}
    }

    function sweepFees() external {
        vm.prank(stranger);
        t.sweepFees();
    }

    // ================================================================================== books read by the invariants

    function giftCount() external view returns (uint256) {
        return _gifts.length;
    }

    function gift(uint256 i) external view returns (Use memory) {
        return _gifts[i];
    }

    function agentSpendCount(address a) external view returns (uint256) {
        return _agentSpends[a].length;
    }

    function agentSpend(address a, uint256 i) external view returns (Use memory) {
        return _agentSpends[a][i];
    }

    function agentGiveCount(address a) external view returns (uint256) {
        return _agentGives[a].length;
    }

    function agentGive(address a, uint256 i) external view returns (Use memory) {
        return _agentGives[a][i];
    }
}
