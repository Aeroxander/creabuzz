// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ContributorKit} from "../src/ContributorKit.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {ContributorKitV2Base} from "./ContributorKitV2.t.sol";

/// @title ContributorKitV2 single-fault guards
/// @dev Each case breaks exactly one thing and expects the kit's own typed refusal, so a guard that
/// is removed fails here and in `scripts/contracts-mutation-check.mjs`. Every case goes through the
/// production `launch`, never a helper that skips the check.
contract ContributorKitV2GuardsTest is ContributorKitV2Base {
    address internal constant WRONG = address(0xBAD);

    // ---- the market terms ------------------------------------------------------------------------------------------

    function _refused(ContributorKitV2.LaunchParams memory p) internal {
        vm.prank(FOUNDER);
        vm.expectRevert(ContributorKit.InvalidTerms.selector);
        kit.launch(p);
    }

    function test_a_quote_with_no_code_is_refused() public {
        ContributorKitV2.LaunchParams memory p = _params("noCodeQuote");
        p.quote = address(0xC0DE);
        _refused(p);
    }

    function test_a_lot_size_of_zero_is_refused() public {
        ContributorKitV2.LaunchParams memory p = _params("zeroLot");
        p.lotSize = 0;
        _refused(p);
    }

    function test_a_lot_size_past_the_bound_is_refused_by_the_kit_itself() public {
        ContributorKitV2.LaunchParams memory p = _params("hugeLot");
        p.lotSize = (uint256(1) << 128) + 1;
        _refused(p);
    }

    function test_a_sale_schedule_with_no_length_is_refused() public {
        ContributorKitV2.LaunchParams memory p = _params("noLength");
        p.saleCliff = 0;
        p.saleDuration = 0;
        _refused(p);
    }

    function test_a_sale_cliff_longer_than_the_schedule_is_refused() public {
        ContributorKitV2.LaunchParams memory p = _params("longCliff");
        p.saleCliff = p.saleDuration + 1;
        _refused(p);
    }

    function test_a_sale_that_starts_in_the_past_is_refused() public {
        ContributorKitV2.LaunchParams memory p = _params("pastStart");
        p.saleStart = now64() - 1;
        _refused(p);
    }

    function test_a_sale_schedule_that_runs_off_the_64_bit_clock_is_refused() public {
        ContributorKitV2.LaunchParams memory p = _params("offClock");
        p.saleStart = type(uint64).max - 100;
        p.saleCliff = 50;
        p.saleDuration = 51;
        _refused(p);
    }

    // ---- the read-backs of the Shares the launch just made -----------------------------------------------------------

    /// @dev The launch reads the born Shares back and refuses if live state disagrees with what it set up.
    /// Each case answers exactly one of those reads wrongly (the kit calls the predicted Shares clone, so
    /// the answer reaches the real `launch` check) and expects the kit's typed refusal. The control
    /// launch below, with the same terms and no mock, proves the refusal is that one read.
    function _readBackRefuses(bytes32 salt, bytes memory call_, bytes memory wrongAnswer) internal {
        ContributorKitV2.LaunchParams memory p = _params(salt);
        (, address sharesAddr,,) = kit.predictLaunch(FOUNDER, p.base.founderShares, p.base.salt, p.quote, p.lotSize);
        vm.mockCall(sharesAddr, call_, wrongAnswer);
        // Mocking an address with no code puts a placeholder byte there, which the clone's own CREATE2 would
        // collide with; clear it so the real Shares is born there, with the mock still answering its calls.
        vm.etch(sharesAddr, "");
        vm.prank(FOUNDER);
        vm.expectRevert(ContributorKit.SetupNotApplied.selector);
        kit.launch(p);
        vm.clearMockedCalls();
    }

    /// @dev A read the launch makes more than once before its own read-back (the factory and the market read
    /// it too): the first `honestReads` answers are the truth, the next one is wrong, so only the kit's own,
    /// last read can see the lie. A control launch's trace has exactly that many earlier reads.
    function _lastReadBackRefuses(
        bytes32 salt,
        bytes memory call_,
        bytes memory truth,
        bytes memory lie,
        uint256 honestReads
    ) internal {
        ContributorKitV2.LaunchParams memory p = _params(salt);
        (, address sharesAddr,,) = kit.predictLaunch(FOUNDER, p.base.founderShares, p.base.salt, p.quote, p.lotSize);
        bytes[] memory answers = new bytes[](honestReads + 1);
        for (uint256 i; i < honestReads; ++i) {
            answers[i] = truth;
        }
        answers[honestReads] = lie;
        vm.mockCalls(sharesAddr, call_, answers);
        vm.etch(sharesAddr, "");
        vm.prank(FOUNDER);
        vm.expectRevert(ContributorKit.SetupNotApplied.selector);
        kit.launch(p);
        vm.clearMockedCalls();
    }

    /// @dev The token's own DAO is read by the factory, then the market, then the kit.
    function test_shares_that_name_another_dao_at_the_kits_read_refuse_the_launch() public {
        ContributorKitV2.LaunchParams memory p = _params("dao");
        (address dao,,,) = kit.predictLaunch(FOUNDER, p.base.founderShares, p.base.salt, p.quote, p.lotSize);
        _lastReadBackRefuses("dao", abi.encodeWithSignature("DAO()"), abi.encode(dao), abi.encode(WRONG), 2);
    }

    /// @dev The exempt endpoint is read by the market, then the factory, then the kit.
    function test_a_changed_exempt_endpoint_at_the_kits_read_refuses_the_launch() public {
        ContributorKitV2.LaunchParams memory p = _params("exempt");
        (,,, address market) = kit.predictLaunch(FOUNDER, p.base.founderShares, p.base.salt, p.quote, p.lotSize);
        _lastReadBackRefuses(
            "exempt", abi.encodeWithSignature("transferExempt()"), abi.encode(market), abi.encode(WRONG), 2
        );
    }

    function test_the_control_launch_with_no_mock_reads_back_clean() public {
        _launch(_params("control"));
    }

    function test_a_transfer_lock_that_did_not_apply_refuses_the_launch() public {
        _readBackRefuses("lock", abi.encodeWithSignature("transfersLocked()"), abi.encode(false));
    }

    function test_an_unlock_notice_that_did_not_apply_refuses_the_launch() public {
        _readBackRefuses("notice", abi.encodeWithSignature("unlockNoticeRequired()"), abi.encode(false));
    }

    function test_a_lock_guard_that_is_not_empty_refuses_the_launch() public {
        // The budget's panel reads the guard too and asks it about tranches, so the stand-in guard answers (0).
        vm.mockCall(WRONG, bytes(""), abi.encode(uint256(0)));
        _readBackRefuses("guardSet", abi.encodeWithSignature("lockGuard()"), abi.encode(WRONG));
    }

    function test_a_lock_guard_that_is_not_sealed_refuses_the_launch() public {
        _readBackRefuses("guardSeal", abi.encodeWithSignature("lockGuardSet()"), abi.encode(false));
    }

    function test_a_sale_policy_that_is_not_the_born_policy_refuses_the_launch() public {
        _readBackRefuses("policy", abi.encodeWithSignature("salePolicy()"), abi.encode(WRONG));
    }

    function test_a_sale_policy_that_is_not_sealed_refuses_the_launch() public {
        _readBackRefuses("policySeal", abi.encodeWithSignature("salePolicyChosen()"), abi.encode(false));
    }

    function test_a_sale_policy_version_that_is_not_one_refuses_the_launch() public {
        _readBackRefuses(
            "version", abi.encodeWithSignature("saleEligibleOf(address)", FOUNDER), abi.encode(uint256(0), uint8(2))
        );
    }

    function test_a_founder_who_starts_with_something_to_sell_refuses_the_launch() public {
        _readBackRefuses(
            "eligible", abi.encodeWithSignature("saleEligibleOf(address)", FOUNDER), abi.encode(uint256(1), uint8(1))
        );
    }

    function test_issuance_that_is_not_awards_only_refuses_the_launch() public {
        _readBackRefuses("awards", abi.encodeWithSignature("awardsOnly()"), abi.encode(false));
    }

    function test_an_issuance_cap_that_is_not_the_open_one_refuses_the_launch() public {
        _readBackRefuses("cap", abi.encodeWithSignature("issuanceCapBps()"), abi.encode(uint16(0)));
    }
}
