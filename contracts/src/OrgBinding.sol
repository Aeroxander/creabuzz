// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Call, Moloch, Summoner} from "majeur/src/Moloch.sol";

/// @title OrgBinding — onchain record keeper for the NIP-ORG "Opt-in onchain
/// binding" of a community org root to a Moloch-family DAO.
///
/// @notice One call summons a majeur DAO with an initial member set and
/// records the binding under the org root's 32-byte Nostr event id
/// (`bytes32 rootId`). The binding record mirrors the signed kind:37010
/// update the CLI republishes with `content.onchain = {chain, dao, boundAt}`
/// (docs/nips/NIP-ORG.md). Per the NIP-LP rule ("the chain is the ledger;
/// Nostr is the record"): the 37010 event is the coordination record, this
/// contract's event log is the onchain ledger of what was bound, and clients
/// verify one against the other when money is at stake.
///
/// INTEGRATION SURFACE (vendored majeur, gitlink 7d7a36b):
/// - `lib/majeur/src/Moloch.sol` — `Summoner` (CREATE2 factory; deploys the
///   `Moloch` implementation in its constructor; `summon()` clones + `init()`s
///   a DAO, mints `initShares` to `initHolders`, then executes `initCalls`).
/// - `lib/majeur/src/peripheral/SafeSummoner.sol` — NOT used here: its
///   singletons (`SUMMONER`, `MOLOCH_IMPL`, `RENDERER`) are hardcoded to the
///   canonical CREATE2/3 addresses of supported chains, which do not exist on
///   a dev chain. We therefore deploy a fresh `Summoner` in this contract's
///   constructor. The preset governance defaults `summonFast` builds
///   (proposalThreshold = 1% of initial supply, 3-day TTL, 1-day timelock,
///   500 bps quorum, ragequit enabled) are reproduced via [[SummonParams]]
///   and PRODUCTION-SAFE VALUES ARE ENFORCED — see `summonAndBind`.
/// - `lib/majeur/src/peripheral/MolochViewHelper.sol` — offchain read helper
///   for the DAO this contract binds; not needed onchain here.
///
/// DELIBERATE SIMPLIFICATIONS (dev-first, all documented):
/// - `bindDao`/`summonAndBind` are RECORDERS with a first-writer owner: the
///   FIRST caller for a `rootId` becomes its recorded `binderOf`, and from then
///   on only that binder OR the currently recorded DAO (acting through its own
///   governance, so a DAO can re-point itself) may rebind the root
///   (`NotBinder` otherwise). Before this, both functions were permissionless
///   last-write-wins: a stranger could overwrite any org's binding — and the
///   indexer-visible `DaoBound` — with one call. Residual limit, by design: the
///   contract cannot prove the first caller speaks for the org root (that
///   authority lives in the signed 37010 update the CLI verifies), so a
///   front-runner can still claim a root nobody has bound yet; readers must
///   confirm a binding against the signed 37010 head before trusting it.
/// - The governance knobs (proposalThreshold/proposalTTL/timelockDelay) are
///   set at summon time via `initCalls` against the PREDICTED clone address —
///   the only channel that works, because the setters are `onlyDAO`
///   (`msg.sender == address(this)`) and `Moloch.init` executes `initCalls`
///   from the DAO's own context. Production-safe values are ENFORCED, not
///   accepted: `NonProductionGovernance` unless threshold > 0, TTL > 0,
///   timelock > 0, and TTL > timelock (the KF#11 criteria). After the
///   summon the three values are read back off the clone and the tx reverts
///   (`GovernanceNotApplied`) on any mismatch — a wrong `molochImpl` would
///   otherwise make the init calls silently no-op (calls to empty targets
///   return success) and re-create the threshold-less default.
/// - Re-binding the same `rootId` (by its binder or its DAO, above)
///   overwrites the record and emits a fresh `DaoBound` — matching NIP-33
///   last-write-wins semantics of the 37010 head it mirrors. Indexers must
///   treat the latest event per `rootId` as the live binding.
/// - Transferring `OrgAllowance` ownership to the DAO is orchestrated by the
///   deploy script (current owner calls `setOwner(dao)` after summon). The
///   production path is a governance proposal through the DAO; the atomic
///   tightening would pass the `setOwner` call as a `Summoner.summon`
///   `initCall`, which `Moloch.init` executes from the DAO's own context
///   before returning the dao address.
interface IMolochMetadata {
    function contractURI() external view returns (string memory);
}

contract OrgBinding {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    /// @notice Recorded binding for one org root.
    struct Binding {
        /// Bound majeur DAO (Moloch clone).
        address dao;
        /// Unix seconds when the binding was recorded.
        uint64 boundAt;
    }

    /// @notice Summon parameters, mirroring the tail of
    /// `Summoner.summon` (lib/majeur/src/Moloch.sol). `renderer` is pinned
    /// to `address(0)` (Moloch.init skips zero renderers) and `initCalls`
    /// is built by this wrapper from the governance fields below — a thin
    /// wrapper should not take on arbitrary governance calls.
    struct SummonParams {
        string name;
        string symbol;
        string uri;
        /// Turnout quorum in bps (500 = 5%, the `summonFast` default).
        uint16 quorumBps;
        /// Exit right: members can ragequit with their treasury share.
        bool ragequittable;
        /// Minimum votes to open a proposal — `summonFast` preset:
        /// 1% of the total initial shares, floored at 1. Must be > 0
        /// (`NonProductionGovernance`).
        uint96 proposalThreshold;
        /// Proposal expiry in seconds — `summonFast` preset: 3 days.
        /// Must be > 0 and greater than `timelockDelay`.
        uint64 proposalTTL;
        /// Delay in seconds between a proposal succeeding and its
        /// execution — `summonFast` preset: 1 day. Must be > 0.
        uint64 timelockDelay;
        /// The Moloch implementation the Summoner clones: the CREATE2
        /// implementation target baked into the clone initcode used to
        /// predict the DAO address for `initCalls`. `Summoner` keeps it in
        /// an unexported immutable (no getter), so the CALLER derives it —
        /// see `summonAndBind` and the deploy scripts (NewDAO log or the
        /// CREATE2 mirror of the Summoner constructor's `new Moloch`).
        address molochImpl;
        /// CREATE2 salt (composed with holders+shares by the factory).
        bytes32 salt;
        /// Initial human/agent seat holders (the 37010 root `holders`).
        address[] holders;
        /// Initial shares minted 1:1 (or weighted) onto `holders`.
        uint256[] shares;
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /// @notice The majeur Summoner factory this contract summons through.
    /// Freshly deployed per OrgBinding (see NatSpec: why not SafeSummoner).
    Summoner public immutable summoner;

    /// @notice rootId (the org root's 32-byte Nostr event id) => binding.
    mapping(bytes32 rootId => Binding) public bindingOf;

    /// @notice rootId => the address that first bound it (the only non-DAO
    /// address that may rebind it). Kept beside `bindingOf` so that getter's
    /// `(dao, boundAt)` shape stays stable for indexers.
    mapping(bytes32 rootId => address) public binderOf;

    // ------------------------------------------------------------------
    // Events / Errors
    // ------------------------------------------------------------------

    /// @notice A DAO binding was recorded for org root `rootId`. The `uri` is
    ///         the DAO's `dao.json` document URL (ERC-4824 `DAOURIRegistered`
    ///         parity) — empty when the DAO predates the field or exposes
    ///         none; readers MUST treat empty as "unknown", never as a value.
    event DaoBound(bytes32 indexed rootId, address indexed dao, uint64 boundAt, string uri);

    /// @notice Emitted once per root, when its first caller becomes its binder.
    event BinderSet(bytes32 indexed rootId, address indexed binder);

    error EmptyHolders();
    error HoldersSharesMismatch();
    /// @notice The requested governance config is not production-safe:
    ///         threshold, TTL, and timelock must all be > 0 and
    ///         TTL must exceed timelock (the KF#11 criteria).
    error NonProductionGovernance();
    /// @notice The summoned clone did not take the requested governance
    ///         values (e.g. `molochImpl` names the wrong implementation and
    ///         the init calls silently no-op'd). The tx reverts instead of
    ///         recording a binding to an unconfigured DAO.
    error GovernanceNotApplied();
    /// @notice A binding for this root exists and the caller is neither its
    /// recorded binder nor its recorded DAO.
    error NotBinder(bytes32 rootId, address caller);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor() {
        summoner = new Summoner();
    }

    // ------------------------------------------------------------------
    // Binding
    // ------------------------------------------------------------------

    /// @dev The first caller for `rootId` becomes its binder; afterwards only that
    /// binder or the recorded DAO may rebind.
    function _authorizeBind(bytes32 rootId) internal {
        address binder = binderOf[rootId];
        if (binder == address(0)) {
            binderOf[rootId] = msg.sender;
            emit BinderSet(rootId, msg.sender);
            return;
        }
        if (msg.sender != binder && msg.sender != bindingOf[rootId].dao) {
            revert NotBinder(rootId, msg.sender);
        }
    }

    /// @notice Summon a majeur DAO with the initial member set and record it
    /// as the binding of org root `rootId`, atomically in one transaction.
    /// The governance knobs in `p` are applied at summon time via `initCalls`
    /// against the predicted clone address (the setters are `onlyDAO`, so
    /// this is the only channel that does not need a passed proposal) and
    /// read back afterwards — see the contract-level notes.
    /// @return dao The summoned Moloch clone (shares minted to `p.holders`).
    function summonAndBind(bytes32 rootId, SummonParams calldata p) external returns (address dao) {
        if (p.holders.length == 0) revert EmptyHolders();
        if (p.holders.length != p.shares.length) revert HoldersSharesMismatch();
        // Production governance is enforced, not accepted: the Moloch
        // defaults (threshold 0, no TTL/timelock) are exactly the defect
        // this wrapper must never re-create.
        bool productionGovernance = p.proposalThreshold > 0
            && p.proposalTTL > 0
            && p.timelockDelay > 0
            && p.proposalTTL > p.timelockDelay;
        if (!productionGovernance) revert NonProductionGovernance();
        _authorizeBind(rootId);

        // Predict the clone exactly like SafeSummoner._predictDAO /
        // Summoner.summon: CREATE2 over the minimal-proxy initcode with
        // `molochImpl` as its implementation target, salt =
        // keccak256(abi.encode(holders, shares, salt)), deployed by OUR
        // summoner. The initcode constants are copied verbatim from
        // SafeSummoner (lib/majeur/src/peripheral/SafeSummoner.sol).
        bytes32 create2Salt = keccak256(abi.encode(p.holders, p.shares, p.salt));
        bytes memory creationCode = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73",
            p.molochImpl,
            hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        address predicted = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), address(summoner), create2Salt, keccak256(creationCode)
                        )
                    )
                )
            )
        );

        // `summonFast` preset values, mirrored. `Moloch.init` executes these
        // from the DAO's own context, which is what `onlyDAO` accepts.
        Call[] memory initCalls = new Call[](3);
        initCalls[0] =
            Call(predicted, 0, abi.encodeCall(Moloch.setProposalThreshold, (p.proposalThreshold)));
        initCalls[1] = Call(predicted, 0, abi.encodeCall(Moloch.setProposalTTL, (p.proposalTTL)));
        initCalls[2] = Call(predicted, 0, abi.encodeCall(Moloch.setTimelockDelay, (p.timelockDelay)));

        dao = address(
            summoner.summon(
                p.name,
                p.symbol,
                p.uri,
                p.quorumBps,
                p.ragequittable,
                address(0), // renderer: Moloch.init skips zero — SVG metadata is optional
                p.salt,
                p.holders,
                p.shares,
                initCalls
            )
        );

        // A call to a wrong target (bad `molochImpl` prediction) returns
        // success without doing anything — read the values back so an
        // unconfigured DAO can never be recorded as bound.
        Moloch configured = Moloch(payable(dao));
        if (
            configured.proposalThreshold() != p.proposalThreshold
                || configured.proposalTTL() != p.proposalTTL
                || configured.timelockDelay() != p.timelockDelay
        ) revert GovernanceNotApplied();

        Binding memory b = Binding({dao: dao, boundAt: uint64(block.timestamp)});
        bindingOf[rootId] = b;
        emit DaoBound(rootId, dao, b.boundAt, p.uri);
    }

    /// @notice Record an EXISTING DAO as the binding of org root `rootId` —
    /// e.g. one summoned directly through the canonical Summoner on a
    /// supported chain, or through a governance proposal. Recording-only by
    /// design; see the contract-level simplification notes.
    function bindDao(bytes32 rootId, address dao) external {
        _authorizeBind(rootId);
        Binding memory b = Binding({dao: dao, boundAt: uint64(block.timestamp)});
        bindingOf[rootId] = b;
        // Best-effort read of the existing DAO's own metadata. The
        // `code.length` gate matters: Solidity's "non-contract return" check
        // is NOT catchable by try/catch (it fires in THIS frame), so EOAs
        // must skip the call entirely. A griefing *contract* target can only
        // revert calls that name it — self-harm on a recording-only path.
        string memory uri = "";
        if (dao.code.length > 0) {
            try IMolochMetadata(dao).contractURI() returns (string memory u) {
                uri = u;
            } catch {}
        }
        emit DaoBound(rootId, dao, b.boundAt, uri);
    }
}
