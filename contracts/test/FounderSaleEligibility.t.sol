// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {Call, Locked, Moloch, Shares, Summoner} from "../src/majeur/MolochPatched.sol";
import {TreasuryMandate} from "../src/TreasuryMandate.sol";
import {ContributorKitV2Base} from "./ContributorKitV2.t.sol";

/// @dev Founder-sale-guard tests, token side (the transactionary ends of the founder schedule):
/// the ceiling lives in one policy with one clock, these capacities and ceilings never depend on
/// balances, and no exemption endpoint, general unlock or self-move can dodge it.
contract FounderSaleEligibilityTest is ContributorKitV2Base {
    /// @dev A later award to the founder is acquired fresh: instantly eligible on top of the still-
    /// locked grant, and never re-locked into the birth schedule.
    function test_a_later_award_to_the_founder_becomes_eligible_now() public {
        (Moloch dao, TreasuryMandate budget, ActivationVoting variant, SecondaryMarket market) =
            _launchV2(_params("award"));
        Shares tokens = dao.shares();

        uint64 burnDay = now64AfterLaunch(); // still fully inside the cliff
        _award(dao, budget, keccak256("founder-award"), FOUNDER, 10e18);
        assertEq(tokens.balanceOf(FOUNDER), 210e18, "the award minted on top");
        (, uint256 vested) = vestedAt(burnDay, variant);
        assertEq(vested, 0, "inside the cliff, the schedule has vested nothing");
        assertEq(variant.lockedAt(burnDay), 200e18, "the grant is still the grant, not 210");
        assertEq(variant.saleCapacity(FOUNDER), 10e18, "the award alone is eligible");
        // The award can move at once, through the exempt market endpoint, and one more unit beyond
        // it cannot: the grant is untouched by the award.
        vm.prank(FOUNDER);
        tokens.approve(address(market), type(uint256).max);
        vm.prank(address(market));
        tokens.transferFrom(FOUNDER, address(market), 10e18);
        assertEq(variant.saleCapacity(FOUNDER), 0, "and the schedule has no more to give with the award gone");
        vm.prank(address(market));
        vm.expectRevert(Shares.LockedShares.selector);
        tokens.transferFrom(FOUNDER, address(market), 1);
    }

    /// @dev The one creation choice is sealed on its own, even when the later "no lock guard"
    /// decision never comes: nobody can add a founder schedule to a DAO that declined one.
    function test_a_declined_sale_policy_seals_events_without_any_lock_guard() public {
        ContributorKitV2.LaunchParams memory p = _params("decline");
        (address dao_, address sharesAddr, address policy, address market) =
            kit.predictLaunch(FOUNDER, p.base.founderShares, p.base.salt, p.quote, p.lotSize);
        market;
        address[] memory holders = new address[](1);
        holders[0] = FOUNDER;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = p.base.founderShares;
        Call[] memory setup = new Call[](1);
        setup[0] = Call(sharesAddr, 0, abi.encodeCall(Shares.setSalePolicy, (address(0))));
        bytes32 scoped = keccak256(abi.encode(FOUNDER, p.base.salt));
        vm.prank(FOUNDER);
        Moloch dao = Moloch(payable(Summoner(summoner).summon(p.base.name, p.base.symbol, "", 500, true, address(0), scoped, holders, amounts, setup)));
        assertEq(address(dao), dao_);
        Shares tokens = dao.shares();
        assertEq(tokens.salePolicy(), address(0), "the DAO declined a founder schedule at birth");
        assertTrue(tokens.salePolicyChosen(), "and that decline is a made choice");
        assertFalse(tokens.lockGuardSet(), "the lock-guard decision never happened");
        vm.prank(address(dao));
        vm.expectRevert(Shares.SalePolicySealed.selector);
        tokens.setSalePolicy(policy);
    }

        // Nothing but the DAO's own actual voting policy may become the sale ceiling: pointing
    /// anywhere else (an untrusted admin module, the token itself) refuses the whole summon
    /// atomically at creation, before anything else exists.
    function test_only_the_daos_own_policy_may_bind_at_creation() public {
        ContributorKitV2.LaunchParams memory p = _params("bind");
        (, address sharesAddr, address policy, address market) =
            kit.predictLaunch(FOUNDER, p.base.founderShares, p.base.salt, p.quote, p.lotSize);
        policy;
        address[] memory holders = new address[](1);
        holders[0] = FOUNDER;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = p.base.founderShares;
        address[] memory wrong = new address[](2);
        wrong[0] = address(quote); // an unrelated admin-ish module
        wrong[1] = market; // a token destination address, still not the DAO's own policy
        for (uint256 i; i < wrong.length; ++i) {
            Call[] memory setup = new Call[](1);
            setup[0] = Call(sharesAddr, 0, abi.encodeCall(Shares.setSalePolicy, (wrong[i])));
            vm.prank(FOUNDER);
            vm.expectRevert();
            Summoner(summoner).summon(
                p.base.name, p.base.symbol, "", 500, true, address(0), keccak256(abi.encode(FOUNDER, p.base.salt)), holders, amounts, setup
            );
        }
    }

    /// @dev The ceiling tracks the policy's schedule even as burns and the clock interact: a burn
    /// consumes only what it actually held, then the remaining schedule keeps reading exactly right.
    function test_the_ceiling_stays_the_one_schedule_across_burns_and_time() public {
        (Moloch dao, , ActivationVoting variant, SecondaryMarket market) = _launchV2(_params("one-clock"));
        Shares tokens = dao.shares();

        // Empty the free side through/partly before the cliff with a partial burn of the grant.
        vm.warp(uint256(SALE_START) + 10 days);
        uint64 burnDay = uint64(SALE_START + 10 days);
        address[] memory quoteTokens = new address[](1);
        quoteTokens[0] = address(quote);
        vm.prank(FOUNDER);
        dao.ragequit(quoteTokens, 20e18, 0);
        assertEq(variant.lockedAt(burnDay), 180e18, "the burn consumed 20 exactly once");
        (uint256 grant, uint256 vested) = vestedAt(burnDay, variant);
        assertEq(grant, 200e18);
        assertEq(vested, 0);

        // At the cliff's end the sale clock starts from the grant, net of the burn.
        vm.warp(uint256(CLIFF_END) + 45 days);
        uint64 later = uint64(CLIFF_END + 45 days);
        assertEq(now64(), later, "the later clock");
        (, uint256 vestedThen) = vestedAt(later, variant);
        assertEq(vestedThen, 50e18, "the schedule computes exactly");
        uint256 expectedLocked = grant - vestedThen - 20e18;
        assertEq(variant.lockedAt(later), expectedLocked, "the remaining locked is exact");
        assertEq(variant.saleCapacity(FOUNDER), 200e18 - 20e18 - expectedLocked, "and so is the ceiling");
        vm.prank(FOUNDER);
        tokens.approve(address(market), type(uint256).max);
        vm.prank(address(market));
        tokens.transferFrom(FOUNDER, address(market), 200e18 - 20e18 - expectedLocked);
        assertEq(variant.saleCapacity(FOUNDER), 0, "after moving everything eligible, there is nothing free");
        vm.prank(address(market));
        vm.expectRevert(Shares.LockedShares.selector);
        tokens.transferFrom(FOUNDER, address(market), 1);
    }
}
