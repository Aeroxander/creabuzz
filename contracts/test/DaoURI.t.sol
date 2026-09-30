// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {OrgBinding} from "../src/OrgBinding.sol";
import {DaoURIAdapter} from "../src/DaoURIAdapter.sol";
import {Call, Moloch, Summoner} from "majeur/src/Moloch.sol";

/// @notice Phase 3 acceptance (OA.md/OAv2): the half-built `contractURI()`
///         field becomes the ERC-4824 `daoURI()`, the summon carries it, and
///         — the DUNA category-error guard — a named uri OVERRIDES majeur's
///         nonprofit default so no commercial AO inherits a stranger's
///         charter (OAv2 §4.8: the adapter is required, not optional).
/// Stand-in for majeur's DUNA operating-charter renderer: what a DAO's
/// `contractURI()` falls through to when no uri was named.
contract DunaRendererMock {
    string internal constant DUNA = "data:application/json,{\"name\":\"a stranger's Wyoming nonprofit charter\"}";

    function daoContractURI(Moloch) external pure returns (string memory) {
        return DUNA;
    }
    function daoTokenURI(Moloch, uint256) external pure returns (string memory) {
        return "";
    }
    function badgeTokenURI(Moloch, uint256) external pure returns (string memory) {
        return "";
    }
}

contract DaoURIAdapterTest is Test {
    address internal treasury = makeAddr("treasury");

    struct HolderSetup {
        address[] holders;
        uint256[] shares;
    }

    function _summon(string memory uri) internal returns (Moloch dao, OrgBinding binding) {
        binding = new OrgBinding();
        HolderSetup memory h;
        h.holders = new address[](1);
        h.shares = new uint256[](1);
        h.holders[0] = treasury;
        h.shares[0] = 1e18;
        address daoAddr = binding.summonAndBind(
            bytes32(uint256(1)),
            OrgBinding.SummonParams({
                name: "Cafe AO",
                symbol: "CAFE",
                uri: uri,
                quorumBps: 500,
                ragequittable: true,
                salt: keccak256("dao-uri"),
                holders: h.holders,
                shares: h.shares
            })
        );
        dao = Moloch(payable(daoAddr));
    }

    /// The shape upgrade: the summon's uri lands in `contractURI()` and the
    /// adapter exposes it as `daoURI()` — ERC-4824's entry point.
    function test_summonUriBecomesTheDaoURI() public {
        string memory uri = "https://relay.example/dao.json";
        (Moloch dao, ) = _summon(uri);
        DaoURIAdapter adapter = new DaoURIAdapter(address(dao));

        assertEq(dao.contractURI(), uri, "the half-built field, upgraded");
        assertEq(adapter.daoURI(), uri, "ERC-4824 entry point");
    }

    /// OrgBinding summons with NO renderer, so an empty uri reads back as the
    /// empty string — "unknown", which the DaoBound docs tell readers never to
    /// treat as a value. It is never a stranger's charter.
    function test_emptyUri_withoutARenderer_readsBackEmpty() public {
        (Moloch dao, ) = _summon("");
        assertEq(bytes(dao.contractURI()).length, 0, "no uri, no renderer: nothing is claimed");
        DaoURIAdapter adapter = new DaoURIAdapter(address(dao));
        assertEq(bytes(adapter.daoURI()).length, 0, "the adapter exposes unknown as unknown");
    }

    /// The DUNA guard (OAv2 §4.8): if a renderer IS set, an EMPTY uri falls
    /// through to the renderer's default — a stranger's charter presented as the
    /// org's own metadata — and a NAMED uri overrides it. The adapter forwards
    /// whatever `contractURI()` says, so a bound org must name its own document.
    function test_emptyUri_fallsThroughToTheRenderer_andANamedUriOverridesIt() public {
        DunaRendererMock renderer = new DunaRendererMock();
        Summoner summoner = new Summoner();
        address[] memory holders = new address[](1);
        uint256[] memory shares = new uint256[](1);
        holders[0] = treasury;
        shares[0] = 1e18;

        Moloch unnamed = summoner.summon(
            "Cafe AO", "CAFE", "", 500, true, address(renderer), keccak256("unnamed"),
            holders, shares, new Call[](0)
        );
        Moloch named = summoner.summon(
            "Cafe AO", "CAFE", "https://relay.example/dao.json", 500, true, address(renderer),
            keccak256("named"), holders, shares, new Call[](0)
        );

        string memory fallbackUri = unnamed.contractURI();
        assertEq(fallbackUri, renderer.daoContractURI(unnamed), "an empty uri IS the renderer default");
        assertEq(
            new DaoURIAdapter(address(unnamed)).daoURI(),
            fallbackUri,
            "the adapter launders nothing: it exposes the fall-through as-is"
        );
        assertEq(named.contractURI(), "https://relay.example/dao.json", "a named uri wins");
        assertTrue(
            keccak256(bytes(named.contractURI())) != keccak256(bytes(fallbackUri)),
            "the org's document is not the renderer's charter"
        );
    }

    /// DAOURIRegistered parity: DaoBound carries the uri (empty = unknown).
    function test_DaoBoundCarriesTheUri() public {
        vm.recordLogs();
        (, OrgBinding binding) = _summon("https://relay.example/dao.json");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(binding) && logs[i].topics[0] == OrgBinding.DaoBound.selector) {
                (uint64 boundAt, string memory uri) = abi.decode(logs[i].data, (uint64, string));
                assertEq(boundAt, uint64(block.timestamp));
                assertEq(uri, "https://relay.example/dao.json", "DaoBound carries the document url");
                found = true;
            }
        }
        assertTrue(found, "DaoBound not emitted");
    }

    /// The indexer ping is advisory and open (the bytes are recomputable —
    /// this event is a hint, never a trust anchor).
    function test_notifyUpdateIsOpenAndAdvisory() public {
        (Moloch dao, ) = _summon("https://relay.example/dao.json");
        DaoURIAdapter adapter = new DaoURIAdapter(address(dao));
        vm.expectEmit(true, true, true, true);
        emit DaoURIAdapter.DAOURIUpdate("https://relay.example/dao.json");
        adapter.notifyUpdate("https://relay.example/dao.json");
    }

    /// The acceptance's LWW rule: a re-summoned org updates BOTH sides under
    /// the same last-write-wins semantics — the binding points at the newest
    /// DAO and its adapter exposes that DAO's document.
    function test_resummonUpdatesBothSides_LWW() public {
        bytes32 rid = keccak256("lww-root");
        OrgBinding binding = new OrgBinding();
        (Moloch first, ) = _summon("https://relay.example/first.json");
        binding.bindDao(rid, address(first));
        DaoURIAdapter firstAdapter = new DaoURIAdapter(address(first));

        // The re-summon (second DAO, second document).
        (Moloch second, ) = _summon("https://relay.example/second.json");
        binding.bindDao(rid, address(second));
        DaoURIAdapter secondAdapter = new DaoURIAdapter(address(second));

        (address boundDao, ) = binding.bindingOf(rid);
        assertEq(boundDao, address(second), "LWW: the newest binding wins");
        assertEq(secondAdapter.daoURI(), "https://relay.example/second.json", "new side updated");
        // And the OLD side still serves its own document (no aliasing, no
        // silent rewrite of history).
        assertEq(firstAdapter.daoURI(), "https://relay.example/first.json", "old side untouched");
    }
}
