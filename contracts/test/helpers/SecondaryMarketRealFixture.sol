// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Moloch} from "../../src/majeur/MolochPatched.sol";
import {SecondaryMarket} from "../../src/SecondaryMarket.sol";
import {TreasuryMandate} from "../../src/TreasuryMandate.sol";
import {ClaimStake} from "../../src/ClaimStake.sol";
import {VerifierSet} from "../../src/VerifierSet.sol";
import {ContributorKitV2} from "../../src/ContributorKitV2.sol";
import {ContributorKitV2Base} from "../ContributorKitV2.t.sol";

/// @notice The real `ContributorKitV2` launch (real summoner, real `ActivationVoting` policy clone, real
/// `SecondaryMarketFactory`, real budget and panel), packaged so the market suites can run their
/// scenarios against the production composition and not only the stood-in policy. Composition rather
/// than inheritance: `ContributorKitV2Base` and `SecondaryMarketFixture` both own constants and
/// helpers with the same names, so the market suites hold one of these and call through it.
/// @dev Everything is the kit's own path. The founder sale schedule is the only parameter this changes
/// from the development defaults (a one-day linear release with no cliff, so a founder who waits a day
/// may sell the whole grant into a seeding round).
contract RealKitHarness is ContributorKitV2Base {
    /// @dev Launch one project through the kit, with `quoteToken` as the market's quote, a founder grant of
    /// `grant`, and a first project big enough that its award budget never limits a scenario.
    function launchReal(bytes32 salt, address quoteToken, uint256 grant)
        external
        returns (address dao, address budget, address policy, address market)
    {
        ContributorKitV2.LaunchParams memory p = _params(salt);
        p.quote = quoteToken;
        p.saleStart = 0;
        p.saleCliff = 0;
        p.saleDuration = 1 days;
        p.base.founderShares = grant;
        p.base.shareBudget = uint128(grant * 3);
        p.base.shareCap = uint128(grant * 3);
        p.base.projects[0].shares = uint128(grant);
        (Moloch d, TreasuryMandate b, address pol, SecondaryMarket m) = _launch(p);
        return (address(d), address(b), pol, address(m));
    }

    /// @dev The implementations the launch's clones delegate to (the DAO's, the Shares' and the policy's): a
    /// real transaction meets each of them cold, so gas measurements cool them too.
    function implementations() external view returns (address[3] memory impls) {
        impls[0] = kit.molochImplementation();
        impls[1] = marketFactory.sharesImplementation();
        impls[2] = kit.policyImplementation();
    }

    /// @dev The reviewed-claim path up to the day the claim can pay out: filed, funded and approved by
    /// both reviewers, then settled. Paying out needs the claim to have aged a week (`payAward`).
    function prepareAward(address budget, bytes32 claimId, address recipient) external {
        ClaimStake claims = TreasuryMandate(budget).claims();
        VerifierSet panel = TreasuryMandate(budget).verifiers();
        vm.startPrank(recipient);
        claims.submitClaim(claimId, 0, 0, keccak256("the docs"));
        claims.setCheck(claimId, CHECK);
        vm.stopPrank();
        vm.prank(FOUNDER);
        TreasuryMandate(budget).fundMilestone(PROJECT, claimId, recipient);
        vm.prank(R1);
        panel.attest(claimId, true);
        vm.prank(R2);
        panel.attest(claimId, true);
        claims.settle(claimId);
    }

    /// @dev The second half of an award: the claim pays out (a week after `prepareAward`) and the DAO's
    /// award decision mints `amount` Shares to `recipient` through the real policy hook, at today's clock.
    function payAward(address dao, address budget, bytes32 claimId, address recipient, uint96 amount) external {
        vm.prank(recipient);
        TreasuryMandate(budget).claims().payout(claimId);
        vm.prank(dao);
        Moloch(payable(dao)).awardContribution(budget, claimId, amount, false);
    }
}
