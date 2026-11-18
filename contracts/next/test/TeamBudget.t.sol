// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EarlierBase} from "./helpers/EarlierBase.sol";
import {Treasury} from "../src/Treasury.sol";
import {RollingCap} from "../src/RollingCap.sol";
import {IShares, IVester} from "../src/Interfaces.sol";
import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {Clones} from "oz5/proxy/Clones.sol";

/// @notice Project zero's team budget (plan decision 7, the owner's decision 5 of 18 November 2026): its founder's slice
/// left after the earlier backers' cut, 52,989,393.67 Shares (5.30%) at S1, sits in the Treasury, earmarked and public
/// (`teamBudget`), and the runner pays it out over time with the gift rules (`payTeam`): held 365 days from the market
/// opening when paid before it, free at once after it, under the 1%-in-30-days gift cap every gift shares. The teammate is
/// paid from the work pot with Give Shares, up front or monthly. Amounts and addresses are made up.
contract TeamBudgetTest is EarlierBase {
    uint256 internal constant TEAM = 52_989_393_666_666_700_000_000_000;
    /// @dev The old Ambassadors line: 2.4M of the old 110M, as Shares of 1,000,000,000.
    uint256 internal constant TEAMMATE = 21_818_182e18;
    address internal teamWallet = makeAddr("made-up team member's wallet");
    address internal teammate = makeAddr("made-up teammate");

    function test_budget_isPublicAndApart() public view {
        assertEq(t.teamBudget(), TEAM);
        assertEq(t.reserve(), 100_000_000e18, "the reserve leaves the team budget out");
        assertEq(t.workPot(), 200_000_000e18);
        assertEq(shares.balanceOf(address(t)), t.reserve() + t.workPot() + t.teamBudget());
    }

    function test_payTeam_onlyTheRunner_neverAnAgent() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.payTeam(teamWallet, 1e18);
        vm.prank(founder);
        t.setAgent(agent, 1e6, type(uint128).max);
        vm.prank(agent);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.payTeam(teamWallet, 1e18);
        vm.prank(agent);
        t.giveShares(teammate, 1e18); // an agent may still give from the work pot inside its limit
    }

    function test_payTeam_notMoreThanTheBudget() public {
        vm.warp(_now() + t.TEAM_PAY_SPAN()); // the whole budget has accrued
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TeamBudgetShort.selector, TEAM + 1, TEAM));
        t.payTeam(teamWallet, TEAM + 1);
        vm.prank(founder);
        t.payTeam(teamWallet, TEAM);
        assertEq(t.teamBudget(), 0);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TeamBudgetShort.selector, 1, 0));
        t.payTeam(teamWallet, 1);
        assertEq(t.workPot(), 200_000_000e18, "never the work pot");
        assertEq(t.reserve(), 100_000_000e18, "never the reserve");
    }

    function test_payTeam_badInputs() public {
        address[5] memory bad = [address(0), address(t), address(v), address(shares), address(eb)];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(founder);
            vm.expectRevert(Treasury.BadInput.selector);
            t.payTeam(bad[i], 1e18);
        }
        vm.prank(founder);
        vm.expectRevert(Treasury.BadInput.selector);
        t.payTeam(teamWallet, 0);
    }

    /// Before the market: held in the Vester, released evenly over 365 days from the market opening.
    function test_payTeam_beforeTheMarket_heldOnTheClock() public {
        vm.warp(_now() + 30 days); // a month of team pay has accrued
        vm.expectEmit(true, true, false, true, address(t));
        emit Treasury.SharesGiven(founder, teamWallet, 1_000_000e18, true);
        vm.expectEmit(true, false, false, true, address(t));
        emit Treasury.TeamPaid(teamWallet, 1_000_000e18, TEAM - 1_000_000e18);
        vm.prank(founder);
        t.payTeam(teamWallet, 1_000_000e18);
        (uint256 g,) = v.grants(teamWallet);
        assertEq(g, 1_000_000e18);
        assertEq(shares.balanceOf(teamWallet), 0);
        vm.warp(_now() + 200 days);
        assertEq(v.claimable(teamWallet), 0, "nothing before the market");
        _market();
        vm.warp(_now() + 365 days / 2);
        assertEq(v.claimable(teamWallet), 500_000e18);
        vm.warp(_now() + 365 days);
        v.claim(teamWallet);
        assertEq(shares.balanceOf(teamWallet), 1_000_000e18);
    }

    /// After the market: free at once, inside the one gift cap that the work pot's gifts share.
    function test_payTeam_afterTheMarket_underTheSharedGiftCap() public {
        vm.warp(_now() + 60 days); // two months of team pay have accrued
        _market();
        _buy(alice, 350_000_000e18);
        assertEq(t.countingSupply() / 100, 3_500_000e18, "1% of the Shares in people's hands");
        vm.prank(founder);
        t.giveShares(teammate, 1_000_000e18); // counted from now: the cap is 1% of 351M
        vm.prank(founder);
        t.payTeam(teamWallet, 2_510_000e18); // fills it exactly
        assertEq(shares.balanceOf(teamWallet), 2_510_000e18, "free at once");
        uint256 cap = t.countingSupply() / 100;
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(RollingCap.CapExceeded.selector, 3_510_000e18, 1_000_000e18, cap));
        t.payTeam(teamWallet, 1_000_000e18);
        vm.warp(_now() + 33 days);
        vm.prank(founder);
        t.payTeam(teamWallet, 1_000_000e18);
    }

    /// The manager's keys as a Pair (central management): both sign each payment.
    function test_payTeam_byAPairRunner() public {
        vm.warp(_now() + 30 days);
        _team();
        _both(address(t), abi.encodeCall(Treasury.payTeam, (teamWallet, 2_000_000e18)));
        assertEq(t.teamBudget(), TEAM - 2_000_000e18);
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.payTeam(teamWallet, 1); // one signer alone cannot
    }

    /// The manager's plan: paid monthly for 30 months (2.5 years), each paid at the end of its month (in arrears): 12
    /// before the market (held) at a 30-day step, then 18 after it (free) at a 33-day step, the step at which one month's
    /// gifts have left the cap's memory; the teammate is paid alongside from the work pot. The pace (`teamPayable`, the
    /// budget over 730 days) never stops a monthly payment. The budget is used up exactly; the work pot falls by the
    /// teammate's pay only; the reserve, the auction and the pool match never move.
    function test_monthlyPay_s1_thirtyMonths() public {
        uint256 months = 30;
        uint256 perMonth = TEAM / months;
        uint256 mate = TEAMMATE / months;
        for (uint256 m; m < months; ++m) {
            vm.warp(_now() + (m < 12 ? 30 days : 33 days)); // the month is worked, then paid
            if (m == 12) {
                _market();
                _buy(alice, 350_000_000e18);
                _consentAll();
            }
            if (m > 12) eb.deliverMany(_ids()); // the server's daily job, here monthly
            uint256 pay = m + 1 == months ? t.teamBudget() : perMonth;
            uint256 mPay = m + 1 == months ? TEAMMATE - mate * (months - 1) : mate;
            vm.prank(founder);
            t.payTeam(teamWallet, pay);
            vm.prank(founder);
            t.giveShares(teammate, mPay);
        }
        assertEq(t.teamBudget(), 0, "used up");
        assertEq(t.workPot(), 200_000_000e18 - TEAMMATE);
        assertEq(t.reserve(), 100_000_000e18);
        (uint256 heldOwner,) = v.grants(teamWallet);
        (uint256 heldMate,) = v.grants(teammate);
        assertEq(heldOwner, perMonth * 12, "12 months held");
        assertEq(heldMate, mate * 12);
        vm.warp(_now() + 365 days);
        v.claim(teamWallet);
        v.claim(teammate);
        assertEq(shares.balanceOf(teamWallet), TEAM, "the whole team budget, 5.30%");
        assertEq(shares.balanceOf(teammate), TEAMMATE, "the teammate's 2.18%");
    }

    /// A strict 30-day step after the market counts two months at once (the cap remembers a gift for 30 to 33 days): at
    /// this size the second month's pay would pass the cap. Pay on a 33-day step, or pay at most half the cap a month.
    function test_monthlyPay_thirtyDayStepCountsTwoMonths() public {
        vm.warp(_now() + 90 days); // enough team pay has accrued for both months
        _market();
        _buy(alice, 350_000_000e18);
        uint256 pay = TEAM / 24 + TEAMMATE / 24; // 2 years: 3.12M a month
        vm.prank(founder);
        t.payTeam(teamWallet, pay);
        vm.warp(_now() + 30 days);
        vm.prank(founder);
        vm.expectRevert(); // CapExceeded: the first month still counts
        t.payTeam(teamWallet, pay);
        vm.warp(_now() + 3 days);
        vm.prank(founder);
        t.payTeam(teamWallet, pay);
    }

    /// The teammate, the other way: one gift from the work pot before the market, held on the same clock.
    function test_teammate_upFront_heldOnTheClock() public {
        vm.prank(founder);
        t.giveShares(teammate, TEAMMATE);
        assertEq(t.teamBudget(), TEAM, "the team budget is not touched");
        assertEq(t.workPot(), 200_000_000e18 - TEAMMATE);
        _market();
        vm.warp(_now() + 365 days / 4);
        assertApproxEqAbs(v.claimable(teammate), TEAMMATE / 4, 1e18);
    }

    /// The reserve can never take the team budget: a reserve sale of more than the reserve is refused.
    function test_reserveSale_cannotTakeTheTeamBudget() public {
        uint256 r = t.reserve();
        vm.prank(address(launcher));
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooMuch.selector, r + 1, r));
        t.releaseReserve(alice, r + 1);
    }

    /// A new runner (a successor or, later, a Council) pays the rest of the budget; it is not lost with the seat.
    function test_budget_followsTheSeat() public {
        vm.warp(_now() + 30 days);
        vm.prank(founder);
        t.handOver(carol, false);
        vm.prank(carol);
        t.takeSeat();
        vm.prank(founder);
        vm.expectRevert(Treasury.NotAllowed.selector);
        t.payTeam(teamWallet, 1e18);
        vm.prank(carol);
        t.payTeam(teamWallet, 1e18);
        assertEq(t.teamBudget(), TEAM - 1e18);
    }

    /// Review fix R3/F3: the team budget accrues evenly over 730 days from the launch and `payTeam` never pays more than
    /// has accrued and not been paid (in arrears; catching up is always allowed). Nothing on launch day.
    function test_pace_teamPayAccruesOverTwoYears() public {
        assertEq(t.teamBudgetAtLaunch(), TEAM);
        assertEq(t.teamPayable(), 0, "nothing accrued on launch day");
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TeamPayTooFast.selector, 1, 0));
        t.payTeam(teamWallet, 1);
        vm.warp(_now() + 73 days); // a tenth of the span
        uint256 tenth = TEAM / 10;
        assertEq(t.teamPayable(), tenth);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TeamPayTooFast.selector, tenth + 1, tenth));
        t.payTeam(teamWallet, tenth + 1);
        vm.prank(founder);
        t.payTeam(teamWallet, tenth / 2);
        assertEq(t.teamPayable(), tenth - tenth / 2);
        vm.warp(_now() + 292 days); // half the span: a missed month is caught up in one payment
        vm.prank(founder);
        t.payTeam(teamWallet, TEAM / 2 - tenth / 2);
        assertEq(t.teamPayable(), 0);
        vm.warp(_now() + 365 days); // the whole span; never more than the budget
        assertEq(t.teamPayable(), t.teamBudget());
        vm.warp(_now() + 365 days);
        assertEq(t.teamPayable(), t.teamBudget());
        uint256 rest = t.teamBudget(); // read first: a prank applies to the next call
        vm.prank(founder);
        t.payTeam(teamWallet, rest);
        assertEq(t.teamBudget(), 0);
        assertEq(t.teamPayable(), 0);
    }

    /// Review fix R3/F3: a founder who leaves early holds the team pay for the days served only (what an ordinary
    /// founder's trim keeps), and the rest stays in the budget for the next runner.
    function test_pace_aLeaverHoldsTheDaysServedOnly() public {
        vm.warp(_now() + 146 days); // a fifth of the span
        uint256 served = t.teamPayable();
        assertEq(served, TEAM / 5);
        vm.prank(founder);
        vm.expectRevert(abi.encodeWithSelector(Treasury.TeamPayTooFast.selector, TEAM, served));
        t.payTeam(founder, TEAM);
        vm.prank(founder);
        t.payTeam(founder, served);
        vm.prank(founder);
        t.handOver(carol, true);
        vm.prank(carol);
        t.takeSeat();
        (uint256 held,) = v.grants(founder);
        assertEq(held, served);
        assertEq(t.teamBudget(), TEAM - served, "the rest waits for the next runner");
    }

    /// The Treasury refuses a setup whose Shares do not cover the work pot and the team budget together.
    function test_init_theTeamBudgetMustBeHeld() public {
        Treasury fresh = Treasury(Clones.clone(launcher.treasuryImpl()));
        vm.prank(finisher);
        shares.transfer(address(fresh), 2e18);
        Treasury.Setup memory st = Treasury.Setup({
            quote: IERC20(address(usd)),
            shares: IShares(address(shares)),
            vester: IVester(address(v)),
            rounds: rounds,
            founder: founder,
            platform: platform,
            opener: finisher,
            salePath: address(launcher),
            stake: address(0),
            stakeAmount: 0,
            exitFeeBps: 500,
            platformFeeBps: 100,
            spendableParts: 15,
            floorParts: 60,
            agentUsd: 0,
            agentShares: 0,
            workPot: 1e18,
            earlier: address(0),
            teamBudget: 1e18 + 1
        });
        vm.expectRevert(Treasury.BadSetup.selector);
        fresh.initialize(st);
        st.teamBudget = 1e18;
        fresh.initialize(st);
        assertEq(fresh.teamBudget(), 1e18);
        assertEq(fresh.reserve(), 0);
    }
}
