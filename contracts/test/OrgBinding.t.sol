// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import {OrgAllowance} from "../src/OrgAllowance.sol";
import {OrgBinding} from "../src/OrgBinding.sol";
import {Call, Moloch, Shares, Summoner} from "majeur/src/Moloch.sol";

/// @dev Phase 8 tests: summon works, shares land on the holders, and the
/// OrgAllowance ledger is controllable ONLY by the DAO after the handover.
///
/// GOVERNANCE EXECUTION NOTE (documented): `vm.prank(dao)` stands in for
/// "the DAO executed a proposal". Majeur proposals execute from the Moloch
/// contract's own context (`onlyDAO` requires `msg.sender ==
/// address(this)`), so the DAO address IS the executor identity a passed
/// proposal would present; running a full propose/vote/execute cycle here
/// would test majeur's governance, not our binding. Every assertion below
/// holds for the proposal-executed call with the same msg.sender.
contract OrgBindingTest is Test {
    OrgBinding internal binding;
    OrgAllowance internal allowance;

    address internal ownerAddr = makeAddr("communityOwner");
    address internal holderB = makeAddr("holderB");
    address internal holderC = makeAddr("holderC");
    address internal attacker = makeAddr("attacker");
    address internal token = makeAddr("usdc");

    // A plausible org root event id (32-byte Nostr event id), used verbatim.
    bytes32 internal rootId = 0xabcDEF0123abcdefABCDEF0123abcdefABCDEF0123abcdefABCDEF0123abcdEF;

    address internal dao;
    address internal shares;

    function _holders() internal view returns (address[] memory h) {
        h = new address[](3);
        h[0] = ownerAddr;
        h[1] = holderB;
        h[2] = holderC;
    }

    function setUp() public {
        vm.prank(ownerAddr);
        allowance = new OrgAllowance();

        binding = new OrgBinding();

        address[] memory h = _holders();
        uint256[] memory s = new uint256[](3);
        s[0] = 2e18;
        s[1] = 1e18;
        s[2] = 1e18;

        dao = binding.summonAndBind(
            rootId,
            OrgBinding.SummonParams({
                name: "Buzz Org",
                symbol: "BUZZ",
                uri: "",
                quorumBps: 500,
                ragequittable: true,
                salt: keccak256("phase8"),
                holders: h,
                shares: s
            })
        );
        shares = address(Moloch(payable(dao)).shares());

        // The Phase 8 handover (deploy-script step; dev simplification of a
        // governance proposal — see contract NatSpec).
        vm.prank(ownerAddr);
        allowance.setOwner(dao);
    }

    // ------------------------------------------------------------- summon

    function test_SummonRecordsBinding() public view {
        (address boundDao, uint64 boundAt) = binding.bindingOf(rootId);
        assertEq(boundDao, dao);
        assertEq(boundAt, block.timestamp);
        assertNotEq(dao, address(0));
    }

    function test_DaoBoundEventEmitted() public {
        bytes32 other = keccak256("other-root");
        address[] memory h = new address[](1);
        h[0] = ownerAddr;
        uint256[] memory s = new uint256[](1);
        s[0] = 1e18;

        vm.recordLogs();
        address returned = binding.summonAndBind(
            other,
            OrgBinding.SummonParams({
                name: "Second",
                symbol: "SEC",
                uri: "",
                quorumBps: 500,
                ragequittable: true,
                salt: keccak256("two"),
                holders: h,
                shares: s
            })
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(binding) && logs[i].topics[0] == OrgBinding.DaoBound.selector) {
                found = true;
                assertEq(logs[i].topics[1], bytes32(other)); // rootId
                assertEq(address(uint160(uint256(logs[i].topics[2]))), returned); // dao
                (uint64 at) = abi.decode(logs[i].data, (uint64));
                assertEq(at, block.timestamp); // boundAt
            }
        }
        assertTrue(found, "DaoBound event not emitted");
    }

    function test_SummonUsesTheContractFactory() public view {
        // The DAO must be a clone of the Summoner this contract deployed —
        // not the hardcoded SafeSummoner singletons (which don't exist on a
        // dev chain).
        Summoner s = binding.summoner();
        assertGt(address(s).code.length, 0);
        assertEq(s.getDAOCount(), 1);
    }

    // ------------------------------------------------------------- shares

    function test_SharesLandOnHolders() public view {
        Shares sh = Shares(shares);
        assertEq(sh.balanceOf(ownerAddr), 2e18);
        assertEq(sh.balanceOf(holderB), 1e18);
        assertEq(sh.balanceOf(holderC), 1e18);
        assertEq(sh.totalSupply(), 4e18);
    }

    function test_DaoIsInitialized() public view {
        Moloch m = Moloch(payable(dao));
        assertEq(address(m.shares()), shares);
        assertEq(m.quorumBps(), 500);
        assertTrue(m.ragequittable()); // the NIP-ORG exit right
        // Documented thin-wrapper tradeoff: with `initCalls` pinned empty,
        // governance knobs stay at Moloch defaults — proposalThreshold is 0
        // (summonFast's >0 default, KF#11, rides on an initCall we do not
        // emit; see OrgBinding NatSpec). A real deployment sets it via the
        // preset initCalls or a follow-up governance proposal.
        assertEq(m.proposalThreshold(), 0);
    }

    // -------------------------------------------------- allowance handover

    function test_OwnerIsTransferredToTheDao() public view {
        assertEq(allowance.owner(), dao);
    }

    function test_OnlyTheDaoCanSetAllowanceAndSpender() public {
        bytes32 subject = 0xd1a7d9d1a2f0e13a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a;

        // The DAO (as proposal executor — see contract header) administers.
        vm.prank(dao);
        allowance.setSpender(subject, attacker);
        assertEq(allowance.spenderOf(subject), attacker);

        vm.prank(dao);
        allowance.setAllowance(subject, token, 1, 100e18);
        assertEq(allowance.allowanceOf(subject, token, 1), 100e18);

        // And can hand the ledger on again (e.g. to a fresh governance).
        vm.prank(dao);
        allowance.setOwner(holderB);
        assertEq(allowance.owner(), holderB);
    }

    function test_OldOwnerIsLockedOut() public {
        bytes32 subject = 0xd1a7d9d1a2f0e13a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a;

        vm.startPrank(ownerAddr);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, ownerAddr));
        allowance.setAllowance(subject, token, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, ownerAddr));
        allowance.setSpender(subject, attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, ownerAddr));
        allowance.setOwner(ownerAddr); // no self-regrab
        vm.stopPrank();
        assertEq(allowance.owner(), dao);
    }

    function test_StrangerIsLockedOutToo() public {
        bytes32 strangerSubject = 0x1111111111111111111111111111111111111111111111111111111111111111;
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgAllowance.NotOwner.selector, attacker));
        allowance.setAllowance(strangerSubject, token, 1, 1);
    }

    // ------------------------------------------------------------ re-bind

    function test_RebindOverwritesAndEmitsAgain() public {
        address[] memory h = new address[](1);
        h[0] = ownerAddr;
        uint256[] memory s = new uint256[](1);
        s[0] = 1e18;

        address dao2 = binding.summonAndBind(
            rootId, // same root — NIP-33 LWW: latest binding is live
            OrgBinding.SummonParams({
                name: "V2",
                symbol: "BUZZ2",
                uri: "",
                quorumBps: 500,
                ragequittable: true,
                salt: keccak256("v2"),
                holders: h,
                shares: s
            })
        );
        (address boundDao,) = binding.bindingOf(rootId);
        assertEq(boundDao, dao2);
        assertNotEq(boundDao, dao);
    }

    // ------------------------------------------------------------ validation

    function test_EmptyHoldersReverts() public {
        address[] memory h = new address[](0);
        uint256[] memory s = new uint256[](0);
        vm.expectRevert(OrgBinding.EmptyHolders.selector);
        binding.summonAndBind(
            keccak256("empty"),
            OrgBinding.SummonParams({
                name: "X",
                symbol: "X",
                uri: "",
                quorumBps: 500,
                ragequittable: true,
                salt: keccak256("x"),
                holders: h,
                shares: s
            })
        );
    }

    function test_HoldersSharesMismatchReverts() public {
        address[] memory h = new address[](1);
        h[0] = ownerAddr;
        uint256[] memory s = new uint256[](2);
        vm.expectRevert(OrgBinding.HoldersSharesMismatch.selector);
        binding.summonAndBind(
            keccak256("mismatch"),
            OrgBinding.SummonParams({
                name: "X",
                symbol: "X",
                uri: "",
                quorumBps: 500,
                ragequittable: true,
                salt: keccak256("y"),
                holders: h,
                shares: s
            })
        );
    }

    function test_BindDaoRecordsExistingDao() public {
        bytes32 rid = keccak256("canonical");
        vm.expectEmit(true, true, true, true, address(binding));
        emit OrgBinding.DaoBound(rid, attacker, uint64(block.timestamp), "");
        binding.bindDao(rid, attacker);
        (address boundDao, uint64 at) = binding.bindingOf(rid);
        assertEq(boundDao, attacker);
        assertEq(at, block.timestamp);
    }
    // ------------------------------------------------- who may (re)bind

    function _summonParams(bytes32 salt) internal view returns (OrgBinding.SummonParams memory) {
        address[] memory h = new address[](1);
        h[0] = ownerAddr;
        uint256[] memory s = new uint256[](1);
        s[0] = 1e18;
        return OrgBinding.SummonParams({
            name: "X",
            symbol: "X",
            uri: "",
            quorumBps: 500,
            ragequittable: true,
            salt: salt,
            holders: h,
            shares: s
        });
    }

    /// The exploit: both binders were permissionless last-write-wins, so any
    /// address could overwrite any org's binding with one call. Removing
    /// `_authorizeBind` makes both halves of this test fail.
    function test_StrangerCannotRebindAnExistingRoot() public {
        (address before_,) = binding.bindingOf(rootId);
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgBinding.NotBinder.selector, rootId, attacker));
        binding.bindDao(rootId, attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgBinding.NotBinder.selector, rootId, attacker));
        binding.summonAndBind(rootId, _summonParams(keccak256("hijack")));
        vm.stopPrank();
        (address after_,) = binding.bindingOf(rootId);
        assertEq(after_, before_, "the binding was not overwritten");
        assertEq(after_, dao);
    }

    function test_FirstCallerBecomesTheBinder() public {
        assertEq(binding.binderOf(rootId), address(this), "setUp's caller is the recorded binder");
        bytes32 fresh = keccak256("fresh-root");
        assertEq(binding.binderOf(fresh), address(0));
        vm.expectEmit(true, true, false, false, address(binding));
        emit OrgBinding.BinderSet(fresh, attacker);
        vm.prank(attacker);
        binding.bindDao(fresh, address(0xD40));
        assertEq(binding.binderOf(fresh), attacker);
        // The first caller of one root owns nothing of another.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OrgBinding.NotBinder.selector, rootId, attacker));
        binding.bindDao(rootId, attacker);
    }

    function test_TheRecordedBinderMayRebind() public {
        binding.bindDao(rootId, address(0xBEEF)); // this == the binder
        (address boundDao,) = binding.bindingOf(rootId);
        assertEq(boundDao, address(0xBEEF));
        assertEq(binding.binderOf(rootId), address(this), "rebinding does not change the binder");
    }

    /// The DAO itself (acting through governance) may re-point its own root even
    /// though it is not the recorded binder — and once it does, the OLD dao no
    /// longer counts, only the new recorded one.
    function test_TheRecordedDaoMayRebind_AndOnlyTheCurrentOne() public {
        address newDao = address(0xDA02);
        vm.prank(dao);
        binding.bindDao(rootId, newDao);
        (address boundDao,) = binding.bindingOf(rootId);
        assertEq(boundDao, newDao);

        vm.prank(dao); // the superseded DAO
        vm.expectRevert(abi.encodeWithSelector(OrgBinding.NotBinder.selector, rootId, dao));
        binding.bindDao(rootId, dao);
        vm.prank(newDao);
        binding.bindDao(rootId, address(0xDA03));
    }
}
