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
    /// @dev Cached in `setUp` — fixture builders must not make external
    /// calls (a `binding.summoner()` getter call inside a `vm.expectRevert`
    /// window steals the expectation).
    address internal molochImpl;

    function _holders() internal view returns (address[] memory h) {
        h = new address[](3);
        h[0] = ownerAddr;
        h[1] = holderB;
        h[2] = holderC;
    }

    /// @dev SafeSummoner._defaultThreshold's exact formula: 1% of the total
    /// initial shares, floored at 1.
    function _thresholdOf(uint256 totalShares) internal pure returns (uint96) {
        uint256 t = totalShares / 100;
        if (t == 0) t = 1;
        return uint96(t);
    }

    /// @dev The Moloch implementation `b.summoner()` clones. `Summoner` keeps
    /// it in an unexported immutable (no getter), so mirror the Summoner
    /// constructor's `new Moloch{salt: bytes32(0)}()`: CREATE2(salt = 0) from
    /// the summoner over Moloch's creation code.
    function _molochImplOf(OrgBinding b) internal view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(b.summoner()),
                            bytes32(0),
                            keccak256(type(Moloch).creationCode)
                        )
                    )
                )
            )
        );
    }

    function setUp() public {
        vm.prank(ownerAddr);
        allowance = new OrgAllowance();

        binding = new OrgBinding();
        molochImpl = _molochImplOf(binding);

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
                proposalThreshold: _thresholdOf(4e18), // 1% of the 4e18 total
                proposalTTL: 3 days,
                timelockDelay: 1 days,
                molochImpl: molochImpl,
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
                proposalThreshold: _thresholdOf(1e18),
                proposalTTL: 3 days,
                timelockDelay: 1 days,
                molochImpl: molochImpl,
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
        // The governance knobs ride on the summon's `initCalls` now — the
        // summonFast preset values, read back off the clone (P2 fix; the
        // Moloch default `proposalThreshold = 0` can never be summoned here).
        assertEq(m.proposalThreshold(), 4e16, "1% of the 4e18 initial supply");
    }

    /// The summoned DAO really carries the summonFast preset governance —
    /// asserted against the CLONE's own state, not the wrapper's inputs.
    function test_GovernanceDefaultsMatchSummonFastPreset() public view {
        Moloch m = Moloch(payable(dao));
        assertEq(m.proposalThreshold(), _thresholdOf(4e18), "1% threshold");
        assertEq(m.proposalTTL(), 3 days, "summonFast TTL");
        assertEq(m.timelockDelay(), 1 days, "summonFast timelock");
    }

    /// The insecure Moloch defaults are hard-rejected forever: zero
    /// threshold, missing TTL/timelock, and TTL <= timelock all revert
    /// before anything is summoned or recorded (the P2 blocker).
    function test_NonProductionGovernanceReverts() public {
        bytes32 root = keccak256("gov-guard");
        // Moloch's own defaults: threshold 0, no TTL, no timelock.
        vm.expectRevert(OrgBinding.NonProductionGovernance.selector);
        binding.summonAndBind(root, _govParams(keccak256("g1"), 0, 0, 0));
        // Thresholdless.
        vm.expectRevert(OrgBinding.NonProductionGovernance.selector);
        binding.summonAndBind(root, _govParams(keccak256("g2"), 0, 3 days, 1 days));
        // No TTL / no timelock.
        vm.expectRevert(OrgBinding.NonProductionGovernance.selector);
        binding.summonAndBind(root, _govParams(keccak256("g3"), 1e16, 0, 1 days));
        vm.expectRevert(OrgBinding.NonProductionGovernance.selector);
        binding.summonAndBind(root, _govParams(keccak256("g4"), 1e16, 3 days, 0));
        // TTL <= timelock.
        vm.expectRevert(OrgBinding.NonProductionGovernance.selector);
        binding.summonAndBind(root, _govParams(keccak256("g5"), 1e16, 1 days, 3 days));
        vm.expectRevert(OrgBinding.NonProductionGovernance.selector);
        binding.summonAndBind(root, _govParams(keccak256("g6"), 1e16, 3 days, 3 days));
        assertEq(binding.binderOf(root), address(0), "nothing was summoned or recorded");
    }

    /// The read-back guard: a `molochImpl` that is not the clone's real
    /// implementation makes the init calls target the wrong predicted
    /// address and silently no-op (calls to empty targets succeed) — the
    /// summon must revert instead of recording an unconfigured DAO.
    function test_WrongMolochImplReverts() public {
        OrgBinding.SummonParams memory p = _summonParams(keccak256("bad-impl"));
        p.molochImpl = address(0xDEAD);
        vm.expectRevert(OrgBinding.GovernanceNotApplied.selector);
        binding.summonAndBind(keccak256("bad-impl-root"), p);
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
                proposalThreshold: _thresholdOf(1e18),
                proposalTTL: 3 days,
                timelockDelay: 1 days,
                molochImpl: molochImpl,
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
                proposalThreshold: _thresholdOf(0),
                proposalTTL: 3 days,
                timelockDelay: 1 days,
                molochImpl: molochImpl,
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
                proposalThreshold: _thresholdOf(1e18),
                proposalTTL: 3 days,
                timelockDelay: 1 days,
                molochImpl: molochImpl,
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
            proposalThreshold: _thresholdOf(1e18),
            proposalTTL: 3 days,
            timelockDelay: 1 days,
            molochImpl: molochImpl,
            salt: salt,
            holders: h,
            shares: s
        });
    }

    /// `_summonParams` with the governance knobs overridden — for the
    /// production-guard cases.
    function _govParams(bytes32 salt, uint96 threshold, uint64 ttl, uint64 timelock)
        internal view
        returns (OrgBinding.SummonParams memory p)
    {
        p = _summonParams(salt);
        p.proposalThreshold = threshold;
        p.proposalTTL = ttl;
        p.timelockDelay = timelock;
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
