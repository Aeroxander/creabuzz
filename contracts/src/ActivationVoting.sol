// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AllocationVoting, IAllocationGovernor} from "./AllocationVoting.sol";
import {TreasuryMandateFactory} from "./TreasuryMandate.sol";

/// @notice The new kit's opt-in variant of `AllocationVoting`: per-acquired-amount voting maturity
/// plus the founder sale schedule. Legacy `AllocationVoting` deployments keep their exact
/// semantics — nothing here changes them; this contract only consumes the seams the base opened
/// (`getPastCapacity`, `votingSupplyAt`, `_votingSupply`, `_liveCapacity`, `_setExcluded`,
/// `_excludedSet`, and the `initialize` / `ownershipChanged` / `openProposal` overrides).
///
/// OPT-IN: only the new kit wires a DAO to this policy, and each kit calls `configureSecondary`
/// inside the DAO's own initialization block (among the `initCalls`, right after `initialize`),
/// exactly once, before any proposal has opened. The whole configuration surface is this one
/// frozen call — no later reconfiguration, no general admin replace.
///
/// MATURITY (candidate terms, disclosed): every acquired amount starts a delay in the daily epoch
/// it arrived in and becomes vote-eligible `MATURITY_EPOCHS` = 8 epochs later, i.e. after 7–8 full
/// days. Wallet age never confers anything; a same-wallet rebuy starts a fresh delay. Bootstrap
/// holders (`initialize`) start fully mature from birth so governance cannot deadlock on its own
/// founders. `mayExit` stays inherited — (true, 0) always; there is no ragequit/withdrawal lock.
///
/// SNAPSHOT TUPLE: a proposal's snapshot is the explicit pair (ownership at block B−1, maturity
/// cutoff at the daily epoch the proposal opened in). `openProposal` freezes the cutoff once per
/// snapshot block; per-holder numerators and the quorum denominator BOTH then resolve against the
/// same frozen (block, cutoff) pair forever, never the current clock. Two proposals opening in the
/// same block share a cutoff by construction — the epoch is a function of the block, not a drift.
/// An unregistered snapshot errors instead of quietly reading today's maturity.
///
/// TOKEN ACCOUNTING (all through the inherited `ownershipChanged` bookkeeping, mirrored here):
///  - Buyers of every kind receive fresh receipt ages — nothing inherits a seller's history.
///  - The market's own raw balance leaves the denominator entirely (an excluded holder, like the
///    DAO and the burn address): deducted full and raw via the base ledger, never double-counted,
///    and the global pending ledger never tracks it.
///  - A deposit into the market records the seller's escrow with the units' ORIGINAL ages. The
///    deposit peels the seller oldest-first (their mature-owned lump, then the oldest pending
///    tags), so what the escrow holds is the seller's most-aged credit.
///  - Sold units consume that credit via `consumeSoldEscrow` (market-only, at settle); unsold
///    units return to the ORIGINAL seller only via `prepareEscrowReturn` plus the next
///    same-transaction market→seller token hook, which consumes the prepared context exactly and
///    restores those units' original ages (mature parts as owned-mature; still-immature parts
///    back into the seller's pending histogram at the original tags). No phantom age: an
///    unprepared or replayed market→seller transfer is just a fresh receipt, and one context is
///    never reusable for another call. Lineages that mature while stored migrate into the
///    escrow's owned-mature part, so no preserve is silently lost.
///  - The market may not escape `total escrowed ≤ its raw balance`: every market-touching token
///    change re-checks, so an un-consumed sale or any leak between books and vault reverts the
///    whole transfer.
///
/// FOUNDER GRANT: only the founder's ORIGINAL grant is sale-locked. `saleCapacity` is their
/// balance minus the still-locked remainder, `locked(t) = max(0, initialGrant − vested(t) −
/// burnedLocked)`, schedule installed at `configureSecondary` (candidate: cliff 0, duration 180
/// days). `vested` derives purely from tracked schedule state, never from the token balance, and
/// `soldSoFar` is NOT a term: sold units were released only by the schedule itself, so
/// subtracting them again would let the founder sell the same tranche twice at one clock. A
/// genuine founder burn adds `min(amount, lockedBeforeBurn)` to `burnedLocked` — the PRE-burn
/// tracked capacity, since the formula never reads the balance. Later awards or mints to the
/// founder are unrestricted and never shift the grant. Sale eligibility only — not financial
/// vesting, not a withdrawal lock — and NO token-level guard enforces it in this deploy: the
/// guard's wiring lives in the kit/Shares lane that reads `saleCapacity`/`lockedAt` here.
///
/// @dev Layout note: `ISecondaryPolicy` is implemented by ABI identity rather than inheritance —
/// `AllocationVoting`'s public `dao` state variable and this contract's own method set give the
/// pinned interface shape, and Solidity cannot bridge a state variable of one base to an
/// interface function of a sibling base in one linearization. Runtime `ISecondaryPolicy` calls
/// resolve against the exact same selectors.
contract ActivationVoting is AllocationVoting {
    /// @notice Interface version of this secondary policy (1 = the pinned `ISecondaryPolicy`).
    uint8 public constant SECONDARY_POLICY_VERSION = 1;

    /// @notice The same version under the readable name the task pinned (`secondaryPolicyVersion()`
    /// == 1); kept next to the constant so both the kit's typed read and any caller that goes
    /// through the interface identity answer the same number.
    function secondaryPolicyVersion() external pure returns (uint8) {
        return SECONDARY_POLICY_VERSION;
    }

    /// @notice One daily epoch; bucket tags and cutoffs are absolute counts of these since genesis.
    uint64 public constant EPOCH = 1 days;
    /// @notice Amounts mature 8 epochs after their arrival epoch — a 7–8 day delay, disclosed.
    uint256 public constant MATURITY_EPOCHS = 8;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error AlreadyConfigured();
    error NotInCreationBlock();
    error InvalidSaleSchedule();
    error SnapshotNotTaken();
    error MarketOnly();
    error MintToMarket();
    error MarketInventoryShort();
    error PreparedReturnMismatch();
    error ExclusionsFrozen();
    error LedgerCorrupt();

    event SecondaryConfigured(
        address indexed market,
        address indexed founder,
        uint256 initialGrant,
        uint64 start,
        uint64 cliff,
        uint64 duration
    );
    event SoldEscrowConsumed(address indexed seller, uint256 amount);
    event EscrowReturnPrepared(address indexed seller, uint256 amount);

    // ------------------------------------------------------------------
    // Pending histograms
    // ------------------------------------------------------------------

    /// @dev Eight slots, one per distinct immature epoch a holder acquired into. Absolute epoch
    /// `tags`; a slot is free when `amts` is zero. The immature window at cutoff C spans exactly
    /// the 8 epochs C−7..C and same-tag amounts merge into one slot, so eight slots can hold any
    /// state this ledger can reach — overflow is impossible by pigeonhole (fuzz-asserted).
    struct Histogram {
        uint64[8] tags;
        uint96[8] amts;
    }

    /// @dev A copied histogram snapshot used to answer historical reads.
    struct Copy {
        uint48 blockNumber;
        uint64[8] tags;
        uint96[8] amts;
    }

    /// @notice Per-owner pending snapshots, coalesced per block exactly like the base's own
    /// checkpoints, so an ownership receipt at block B is absent from a B−1 ownership read.
    mapping(address => Copy[]) private hist;
    /// @notice Global pending over every NON-excluded, non-market, non-DAO holder. The quorum
    /// denominator subtracts this ONCE — the whole immature part of every reachable voter — so
    /// the supply can never dip below maturely reachable amounts and no read ever loops over
    /// unknown holders. Coalesced per block like `hist`.
    Copy[] private globalHist;

    /// @notice Live pending histogram of a holder; snapshot reads use `hist` copies only. The
    /// market, the DAO and every other excluded holder are never tracked: their whole raw balance
    /// is the denominator's own never-voting deduction, so tracking them would double-count.
    mapping(address => Histogram) private live;
    mapping(address => bool) private liveSet;

    // ------------------------------------------------------------------
    // Secondary configuration (frozen once, at creation, by the DAO)
    // ------------------------------------------------------------------

    address private market_;
    address private founder;
    uint256 private grantAmount;
    uint64 private saleStart;
    uint64 private saleCliff;
    uint64 private saleDuration;
    uint256 private burnedLockedAlready;
    uint48 private initBlock;
    bool private initialized;
    bool private configured;
    bool private proposalOpened;
    /// @notice Set once at `configureSecondary`. The variant's exclusion list is creation-binding
    /// only: the base's burn-address default (set during `initialize`) and this one market binding.
    bool private exclusionsFrozen;

    /// @notice proposal snapshot block => frozen maturity cutoff epoch. Zero is unregistered.
    mapping(uint48 => uint64) private cutoffOf;

    // ------------------------------------------------------------------
    // Escrow (per original seller; the market holds its inventory physically)
    // ------------------------------------------------------------------

    /// @notice Still-immature units escrowed for a seller, carrying their ORIGINAL arrival tags —
    /// the only preserved part of a seller's credit across a round.
    mapping(address => Histogram) private escrowPend;
    /// @notice Escrowed units whose original age had already matured when deposited (or matured
    /// while stored; migrated from the pend stack whenever the escrow is touched).
    mapping(address => uint96) private escrowMatureOwned;
    /// @notice The seller's currently-prepared (one same-transaction) return amount.
    mapping(address => uint256) private preparedReturnAmount;
    /// @notice Global escrow totals so `total escrowed ≤ market raw balance` is one compare.
    uint256 private escrowTotalMature;
    uint256 private escrowTotalPending;

    /// @dev A (tag, amount) pair peeled from a histogram.
    struct Lineage {
        uint64 tag;
        uint96 amt;
    }

    constructor(TreasuryMandateFactory factory) AllocationVoting(factory) {}

    // ------------------------------------------------------------------
    // ISecondaryPolicy surface (pinned; parent integration freezes on these)
    // The inherited `address public dao` already satisfies `ISecondaryPolicy.dao()`;
    // redeclaring it here would shadow the state variable out of scope.
    // ------------------------------------------------------------------

    /// @notice The single creation-bound market, set only by `configureSecondary`.
    /// (The DAO this policy belongs to is the base's own `dao`; the inherited getter is the pinned
    /// `ISecondaryPolicy.dao()`.)
    function market() external view returns (address) {
        return market_;
    }

    /// @notice Whether `configureSecondary` has run.
    function isConfigured() external view returns (bool) {
        return configured;
    }

    /// @notice The frozen configuration, for the kit's post-launch read-back.
    function secondaryConfiguration()
        external
        view
        returns (address marketAddr, address founderAddr, uint256 grant, uint64 start, uint64 cliff, uint64 duration)
    {
        return (market_, founder, grantAmount, saleStart, saleCliff, saleDuration);
    }

    /// @notice An existing `holder`'s offerable-now ceiling, independent of voting maturity. For
    /// the founder: balance minus the still-locked remaining grant. For anyone else there is no
    /// sale restriction at all and this is simply the balance. (The token-level guard enforcing
    /// this lives in the kit/Shares lane; this policy only supplies the number.)
    function saleCapacity(address holder) external view returns (uint256) {
        uint256 bal = capacity[holder];
        if (holder != founder || !configured) return bal;
        return bal - min(_lockedAt(uint64(block.timestamp)), bal);
    }

    /// @notice Units still locked inside the founder's ORIGINAL grant at `t`. Purely tracked
    /// schedule state — never the token balance — so a token-level guard sees one stable answer
    /// before and after any balance change it is evaluating.
    function lockedAt(uint64 t) external view returns (uint256) {
        return _lockedAt(t);
    }

    /// @notice `holder`'s deposited Shares whose original acquisition history is still held for
    /// return.
    function escrowedBalance(address holder) external view returns (uint256) {
        return uint256(escrowMatureOwned[holder]) + _histSum(escrowPend[holder]);
    }

    // ------------------------------------------------------------------
    // Init-time configuration
    // ------------------------------------------------------------------

    /// @notice Bootstrap every initial Shares holder at FULL maturity (no pending histogram at
    /// all) and set the starting lanes exactly as the base does. A kit's founder and early
    /// recipients govern from birth; proposals never wait on them.
    function initialize(address shares_, address[] calldata holders) public override {
        super.initialize(shares_, holders);
        if (!initialized) {
            initialized = true;
            initBlock = uint48(block.number);
        }
    }

    /// @notice The one-time, one-way registration of the market and the founder sale schedule.
    /// Callable only in the same block as `initialize` (the kit's `initCalls`), by the DAO itself,
    /// before any proposal has opened. The market address may have no code yet: the kit creates it
    /// later in the same atomic launch transaction, and the kit's read-back verifies the actual
    /// market. No later call re-runs or replaces any of it.
    function configureSecondary(
        address marketAddr,
        address founderAddr,
        uint256 initialGrant,
        uint64 start,
        uint64 cliff,
        uint64 duration
    ) external onlyDAO {
        if (configured) revert AlreadyConfigured();
        if (!initialized || initBlock == 0 || block.number != initBlock) revert NotInCreationBlock();
        if (proposalOpened) revert InvalidInitialization();
        if (marketAddr == address(0) || founderAddr == address(0) || marketAddr == dao || founderAddr == dao) {
            revert InvalidInitialization();
        }
        if (
            initialGrant == 0 || initialGrant > type(uint96).max || cliff > duration || duration == 0
                || start < block.timestamp
                || uint256(start) + uint256(cliff) + uint256(duration) > type(uint64).max
        ) revert InvalidSaleSchedule();
        configured = true;
        market_ = marketAddr;
        founder = founderAddr;
        grantAmount = initialGrant;
        saleStart = start;
        saleCliff = cliff;
        saleDuration = duration;
        // The market holds the entire sale inventory; none of it is ever reachable voting supply,
        // and its whole raw balance is deducted by the supply path exactly once.
        _setExcluded(marketAddr, true);
        // Birth-binding complete: the variant freezes its exclusion list here — no later
        // `setExcluded` (add, remove, or the market's own un-exclude) can change the denominator's
        // deduction set after creation, so no holder geometry can be laundered in or out.
        exclusionsFrozen = true;
        emit SecondaryConfigured(marketAddr, founderAddr, initialGrant, start, cliff, duration);
    }

    // ------------------------------------------------------------------
    // Snapshot tuple
    // ------------------------------------------------------------------

    /// @notice Freeze this proposal's maturity cutoff into the snapshot pair BEFORE capturing
    /// supply and bars, so both the numerators (via the `getPastCapacity` override) and the quorum
    /// denominator (via the `_votingSupply` override inside `super.openProposal`) resolve against
    /// the same frozen pair forever.
    function openProposal(
        uint256 id,
        uint256 supply,
        uint16 bps,
        uint96 absolute,
        uint96 minYes,
        uint64 ttl,
        uint64 delay,
        bool bounded
    ) public override onlyDAO {
        uint48 snapshot = IAllocationGovernor(dao).snapshotBlock(id);
        if (cutoffOf[snapshot] == 0) cutoffOf[snapshot] = epochOf(uint64(block.timestamp));
        proposalOpened = true;
        super.openProposal(id, supply, bps, absolute, minYes, ttl, delay, bounded);
    }

    /// @notice The absolute daily epoch a timestamp falls in.
    function epochOf(uint64 timestamp) public pure returns (uint64) {
        return timestamp / EPOCH;
    }

    /// @notice Snapshot eligibility of `owner` against a registered proposal snapshot: the raw
    /// balance at the block minus what was still immature at the frozen cutoff. Unknown snapshots
    /// revert; there is no current-clock fallback.
    function getPastCapacity(address owner, uint48 snapshot) public view override returns (uint96) {
        _assertRegistered(snapshot);
        return _eligibleAt(owner, snapshot, cutoffOf[snapshot]);
    }

    /// @notice Named preview with an EXPLICIT cutoff: the same math as `getPastCapacity`, but the
    /// caller says which epoch they mean instead of asking the clock for one.
    function eligibleAt(address owner, uint48 snapshotBlock, uint64 cutoffEpoch) public view returns (uint96) {
        if (snapshotBlock >= block.number) revert BadSnapshot();
        return _eligibleAt(owner, snapshotBlock, cutoffEpoch);
    }

    /// @notice Total Shares that could vote on a proposal opened at `snapshot`, resolving against
    /// that snapshot's own frozen cutoff. Unknown snapshots revert; the base's generic preview is
    /// overridden rather than approximated.
    function votingSupplyAt(uint256 totalSupplyAtSnapshot, uint48 snapshot) public view override returns (uint256) {
        _assertRegistered(snapshot);
        return _supplyAt(totalSupplyAtSnapshot, snapshot, cutoffOf[snapshot]);
    }

    /// @notice Named preview: eligible supply for an explicit (ownership block, cutoff) pair.
    function eligibleVotingSupplyAt(uint256 totalSupplyAtSnapshot, uint48 snapshotBlock, uint64 cutoffEpoch)
        public
        view
        returns (uint256)
    {
        if (snapshotBlock >= block.number) revert BadSnapshot();
        return _supplyAt(totalSupplyAtSnapshot, snapshotBlock, cutoffEpoch);
    }

    function _assertRegistered(uint48 snapshot) internal view {
        if (snapshot >= block.number) revert BadSnapshot();
        if (cutoffOf[snapshot] == 0) revert SnapshotNotTaken();
    }

    /// @dev The base's proposal-opening supply hook, overridden with the SAME private math this
    /// policy's previews use, against the registered (frozen) cutoff of that snapshot.
    function _votingSupply(uint256 totalSupplyAtSnapshot, uint48 snapshot) internal view override returns (uint256) {
        if (cutoffOf[snapshot] == 0) revert SnapshotNotTaken();
        return _supplyAt(totalSupplyAtSnapshot, snapshot, cutoffOf[snapshot]);
    }

    /// @dev Raw balance at the snapshot (the base ledger's mirror) minus pending-at-cutoff,
    /// taken from the copy stored for that block so a later acquisition can never leak in.
    function _eligibleAt(address owner, uint48 snapshotBlock, uint64 cutoff) internal view returns (uint96) {
        uint96 raw = super.getPastCapacity(owner, snapshotBlock);
        uint96 pending = uint96(_copyPending(hist[owner], snapshotBlock, cutoff));
        return pending >= raw ? 0 : raw - pending;
    }

    /// @dev The quorum denominator: everything at the snapshot that was maturely reachable. The
    /// DAO, the burn address and every excluded holder (the market included) are deducted at their
    /// FULL raw balances — they can never be voters, and full-raw keeps the denominator from
    /// dipping below what a whole-electorate vote could reach. On top, the immature part of every
    /// OTHER holder is subtracted exactly once via the global ledger.
    function _supplyAt(uint256 totalSupplyAtSnapshot, uint48 snapshot, uint64 cutoff) internal view returns (uint256) {
        uint256 deducted = super.getPastCapacity(dao, snapshot);
        address[] memory ex = _excludedSet();
        unchecked {
            for (uint256 i; i < ex.length; ++i) {
                deducted += super.getPastCapacity(ex[i], snapshot);
            }
            uint256 pending = _copyPending(globalHist, snapshot, cutoff);
            deducted += pending;
        }
        return deducted >= totalSupplyAtSnapshot ? 0 : totalSupplyAtSnapshot - deducted;
    }

    function _copyPending(Copy[] storage copies, uint48 snapshotBlock, uint64 cutoff)
        internal
        view
        returns (uint256 pending)
    {
        uint256 low;
        uint256 high = copies.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (copies[mid].blockNumber > snapshotBlock) high = mid;
            else low = mid + 1;
        }
        if (low == 0) return 0;
        for (uint256 i; i < MATURITY_EPOCHS; ++i) {
            uint96 amt = copies[low - 1].amts[i];
            if (amt != 0 && cutoff < uint256(copies[low - 1].tags[i]) + MATURITY_EPOCHS) pending += amt;
        }
    }

    // ------------------------------------------------------------------
    // Governance ledger
    // ------------------------------------------------------------------

    /// @notice Post-creation exclusions are frozen: the only bindings this variant ever had are
    /// the burn address (set by `initialize` before the freeze) and the registered market (its own
    /// `configureSecondary` call, which freezes on its way out). A later DAO vote — add, remove, or
    /// the market's own un-exclude — is refused, because a denominator deduction set that could
    /// change after creation would let holders be excluded into supply or laundered out of it.
    function _setExcluded(address holder, bool on) internal override {
        if (exclusionsFrozen) revert ExclusionsFrozen();
        super._setExcluded(holder, on);
    }

    /// @dev Whether `tag` is still immature at (i.e. before the end of) the current epoch.
    function _stillImmature(uint64 tag, uint64 nowEpoch) internal pure returns (bool) {
        return tag + MATURITY_EPOCHS > nowEpoch;
    }

    /// @notice The token hook, extended in place — same `onlyDAO` authentication (via the base's
    /// external entrypoint) and raw-balance invariants as the base. Every branch keeps
    /// `pending ≤ raw balance` per holder, `pending ≤ supply` for the global ledger, and
    /// `total escrowed ≤ market raw balance`.
    function _ownershipChanged(bool isLoot, address from, address to, uint256 amount) internal override {
        if (isLoot || from == to || amount == 0) {
            super._ownershipChanged(isLoot, from, to, amount);
            return;
        }
        if (!configured) {
            super._ownershipChanged(isLoot, from, to, amount);
            _receiverInflow(to, amount);
            _pushHistories(from, to);
            return;
        }

        // --- classify before any state change ---------------------------------------------
        bool founderBurn = from == founder && to == address(0);
        bool marketOutflow = from == market_ && to != address(0);
        uint256 prepared = marketOutflow ? preparedReturnAmount[to] : 0;
        bool escrowReturn = marketOutflow && prepared != 0;
        if (to == market_ && from == address(0)) revert MintToMarket();

        // --- bookkeeping that must read PRE-change schedule/escrow/peel state ----------------
        if (founderBurn) {
            // Hook the grant schedule down by the units it actually releases. `_lockedAt` reads
            // schedule state only — never the token balance — so this is the PRE-burn tracked
            // capacity even though the ledger has not moved yet.
            burnedLockedAlready += min(amount, _lockedAt(uint64(block.timestamp)));
        }
        if (marketOutflow) {
            if (escrowReturn) {
                // The prepared same-transaction return to the ORIGINAL seller: consume the
                // context exactly and restore those units' original ages.
                if (amount != prepared) revert PreparedReturnMismatch();
                preparedReturnAmount[to] = 0;
                _unsettleReturn(to, amount);
            } else {
                // A plain market→X transfer (an actual sale): the buyer gets a fresh receipt, and
                // `consumeSoldEscrow` has already or will already have released the seller's
                // credit — the inventory check below refuses a sale whose vault shrank without
                // its books shrinking first.
                _receiverInflow(to, amount);
            }
        } else if (to == market_) {
            // A deposit into the market: peel the SELLER oldest-first (their most-aged units
            // leave first), store the exact original ages in the escrow, and drop the peeled
            // pending out of the global voting ledger (the units are now an excluded balance).
            _escrowDeposit(from, amount);
        } else {
            // Ordinary flow: outbound then inbound. The sender's pending leaves
            // newest-tags-first, and any receiver gains fresh pending at the current epoch.
            // Buyers never inherit — this is the whole point of amount-specific maturity.
            Lineage[8] memory freed;
            uint256 n = _peel(live[from], amount, false, freed);
            for (uint256 i; i < n; ++i) {
                // the global ledger tracks CURRENT-immature tags only: a freed tag that has
                // meanwhile matured was already irrelevant (or flood-evictable) there, and its
                // leaving is pure raw-balance now, so only still-immature quantities mirror out
                if (_stillImmature(freed[i].tag, epochOf(uint64(block.timestamp)))) {
                    _histRemove(_globalLive(), freed[i].tag, freed[i].amt);
                }
            }
            _receiverInflow(to, amount);
        }

        // --- token-state bookkeeping (balances, checkpoints, trim, delegation) ---------------
        super._ownershipChanged(isLoot, from, to, amount);

        // After the vault actually changed hands, the books may not claim more than it holds.
        if ((marketOutflow || to == market_) && escrowTotalMature + escrowTotalPending > capacity[market_]) {
            revert MarketInventoryShort();
        }
        _pushHistories(from, to);
    }

    /// @dev Fresh receipt: `to`'s live histogram and the global ledger both gain `amount` at the
    /// current epoch. The market, the DAO and any other excluded holder are never tracked — their
    /// whole raw balance is the supply path's own never-voting deduction.
    function _receiverInflow(address to, uint256 amount) internal {
        if (to == address(0) || to == dao || isExcluded[to]) return;
        uint64 e = epochOf(uint64(block.timestamp));
        _histAdd(live[to], e, amount);
        liveSet[to] = true;
        _histAdd(_globalLive(), e, amount);
    }

    // ------------------------------------------------------------------
    // Escrow
    // ------------------------------------------------------------------

    /// @dev Records a deposit's escrow from a seller's live histogram with the ORIGINAL ages.
    /// Mature-owned leaves first (it needs no tag), then the seller's oldest pending tags. A
    /// lineage that meanwhile expired (tag+8 ≤ now) lands in the owned-mature escrow part.
    /// The mature chunk is what the histogram does not hold at all (`capacity − histSum`), never
    /// `capacity − current-immature`: the hist keeps matured-tag slot entries for units that
    /// matured while held, and charging them to the mature chunk AND the oldest-first peel would
    /// surrender the same units twice — draining raw below the hist and underflowing a later
    /// `_liveCapacity`. This way the hist is given up exactly once, by the peel, and its matured
    /// lineages are routed by the `tag+8 ≤ e` branch below (owned-mature; the live ones keep tags).
    function _escrowDeposit(address seller, uint256 amount) internal {
        // Migrate lineages that matured while held first (O(8)), so the split below reads only
        // this seller's still-immature composition.
        _migrateEscrow(seller);
        uint64 e = epochOf(uint64(block.timestamp));
        uint256 tracked = liveSet[seller] ? _histSum(live[seller]) : 0;
        uint256 matureOwned = capacity[seller] - min(tracked, capacity[seller]);
        uint256 maturePart = min(amount, matureOwned);
        if (maturePart != 0) {
            escrowMatureOwned[seller] += uint96(maturePart);
            escrowTotalMature += maturePart;
        }
        uint256 pendingPart = amount - maturePart;
        if (pendingPart == 0) return;
        Lineage[8] memory freed;
        uint256 n = _peel(live[seller], pendingPart, true, freed);
        for (uint256 i; i < n; ++i) {
            if (uint256(freed[i].tag) + MATURITY_EPOCHS <= e) {
                // matured while still held: owned-mature escrow, no preserve needed
                escrowMatureOwned[seller] += freed[i].amt;
                escrowTotalMature += freed[i].amt;
            } else {
                // still immature: the escrow holds the lineage, and the global ledger loses
                // exactly this quantity (the units are now an excluded market balance)
                _histRemove(_globalLive(), freed[i].tag, freed[i].amt);
                _histAdd(escrowPend[seller], freed[i].tag, freed[i].amt);
                escrowTotalPending += freed[i].amt;
            }
        }
    }

    /// @dev Moves every escrowed lineage whose tag has meanwhile matured from the pending stack
    /// into the owned-mature escrow part, keeping `escrowTotalPending == Σ escroPend slots` and
    /// `escrowedBalance == mature + pending` exact. Bounded by the 8 fixed slots (O(8) per touch):
    /// no lineage can be silently lost to a later mature-slot eviction, and every read below
    /// splits on genuinely current-immature quantities only.
    function _migrateEscrow(address seller) internal {
        uint64 e = epochOf(uint64(block.timestamp));
        for (uint256 i; i < MATURITY_EPOCHS; ++i) {
            uint96 amt = escrowPend[seller].amts[i];
            if (amt == 0) continue;
            if (uint256(escrowPend[seller].tags[i]) + MATURITY_EPOCHS > e) continue;
            escrowPend[seller].amts[i] = 0;
            escrowMatureOwned[seller] += amt;
            escrowTotalPending -= amt;
            escrowTotalMature += amt;
        }
    }

    /// @dev Unsettles a prepared return: peel `amount` from the escrow newest-first (fresh
    /// immature lineage first, then the mature part), then restore the seller's own ages — still
    /// immature ones re-enter the seller's pending histogram at their original tags (and the
    /// global ledger), already-mature ones just become whole owned-mature again.
    function _unsettleReturn(address seller, uint256 amount) internal {
        _migrateEscrow(seller);
        uint256 pendSum = _histSum(escrowPend[seller]);
        uint256 immaturePart = min(amount, pendSum);
        uint256 maturePart = amount - immaturePart;
        if (maturePart != 0) {
            escrowMatureOwned[seller] -= uint96(maturePart);
            escrowTotalMature -= maturePart;
        }
        if (immaturePart == 0) return;
        uint64 e = epochOf(uint64(block.timestamp));
        Lineage[8] memory freed;
        uint256 n = _peel(escrowPend[seller], immaturePart, false, freed);
        for (uint256 i; i < n; ++i) {
            escrowTotalPending -= freed[i].amt;
            if (uint256(freed[i].tag) + MATURITY_EPOCHS > e) {
                _histAdd(live[seller], freed[i].tag, freed[i].amt);
                _histAdd(_globalLive(), freed[i].tag, freed[i].amt);
            }
        }
    }

    /// @notice Market only. Consume `amount` of `seller`'s escrow credit for SOLD units. Peeled
    /// newest-first (fresh lineage first), leaving the seller's OLDEST credit in reserve for the
    /// next round's cancellation. Only the escrow stacks move — sold units already left the
    /// voting side when they were deposited.
    function consumeSoldEscrow(address seller, uint256 amount) external {
        _assertConfiguredMarket();
        _migrateEscrow(seller);
        uint256 pendSum = _histSum(escrowPend[seller]);
        uint256 matureOwned = escrowMatureOwned[seller];
        if (amount > pendSum + matureOwned) revert MarketInventoryShort();
        uint256 immaturePart = min(amount, pendSum);
        Lineage[8] memory freed;
        uint256 n = _peel(escrowPend[seller], immaturePart, false, freed);
        uint256 freedSum;
        for (uint256 i; i < n; ++i) {
            freedSum += freed[i].amt;
            escrowTotalPending -= freed[i].amt;
        }
        uint256 maturePart = amount - immaturePart;
        if (maturePart != 0) {
            escrowMatureOwned[seller] -= uint96(maturePart);
            escrowTotalMature -= maturePart;
        }
        emit SoldEscrowConsumed(seller, amount);
    }

    /// @notice Market only. Prepare ONE same-transaction return to the ORIGINAL `seller`. The
    /// very next market→seller token hook in the same transaction consumes this context exactly
    /// and restores `amount` units at their original ages to `seller`; anything else is a fresh
    /// receipt and can never draw on escrow credit, and no context is reusable for another call.
    /// (A later prepare to the same seller simply overwrites — deterministic, and the market that
    /// prepared it is the custodian of its own context.)
    function prepareEscrowReturn(address seller, uint256 amount) external {
        _assertConfiguredMarket();
        if (seller == address(0) || amount == 0) revert PreparedReturnMismatch();
        if (amount > escrowMatureOwned[seller] + _histSum(escrowPend[seller])) revert MarketInventoryShort();
        preparedReturnAmount[seller] = amount;
        emit EscrowReturnPrepared(seller, amount);
    }

    // ------------------------------------------------------------------
    // Founder schedule
    // ------------------------------------------------------------------

    /// @dev `max(0, initialGrant − vested(t) − burnedLocked)`. Pure schedule state in — never the
    /// token balance — so this is always the PRE-change tracked capacity for burn hooking.
    function _lockedAt(uint64 t) internal view returns (uint256) {
        if (grantAmount == 0) return 0;
        uint256 alreadyBurned = min(burnedLockedAlready, grantAmount);
        if (t < saleStart + saleCliff) return grantAmount - alreadyBurned;
        uint256 vested = min(grantAmount, (t - saleStart - saleCliff) * grantAmount / saleDuration);
        uint256 rest = grantAmount - vested;
        return alreadyBurned >= rest ? 0 : rest - alreadyBurned;
    }

    // ------------------------------------------------------------------
    // Live support cap (the only place where live ≠ raw, per `_liveCapacity`)
    // ------------------------------------------------------------------

    /// @notice What `owner` can still move NOW: the raw balance minus what is still immature
    /// against today's clock, so replacement immature purchases cannot back departed votes. The
    /// DAO, burn and excluded holdings use the raw balance — they were never reachable voters.
    function _liveCapacity(address owner) internal view override returns (uint256) {
        if (owner == dao || isExcluded[owner] || !liveSet[owner]) return capacity[owner];
        uint64 e = epochOf(uint64(block.timestamp));
        return capacity[owner] - _livePending(live[owner], e);
    }

    // ------------------------------------------------------------------
    // Histogram primitives
    // ------------------------------------------------------------------

    /// @dev Global live histogram.
    function _globalLive() internal view returns (Histogram storage) {
        return liveGlobalHist;
    }

    Histogram private liveGlobalHist;

    /// @dev Live pending of a holder still immature at `cutoff`.
    function _livePending(Histogram storage h, uint64 cutoff) internal view returns (uint96 pending) {
        for (uint256 i; i < MATURITY_EPOCHS; ++i) {
            if (h.amts[i] != 0 && cutoff < uint256(h.tags[i]) + MATURITY_EPOCHS) pending += h.amts[i];
        }
    }

    function _histSum(Histogram storage h) internal view returns (uint96 sum) {
        for (uint256 i; i < MATURITY_EPOCHS; ++i) {
            sum += h.amts[i];
        }
    }

    /// @dev Adds `amount` at tag `e`: merge into an existing same-tag slot, else a free slot, else
    /// the oldest slot that already matured at `e`. Immature-pending overflow is impossible by the
    /// 8-slot window argument (and the fuzz asserts it stays unreachable).
    function _histAdd(Histogram storage h, uint64 e, uint256 amount) internal {
        for (uint256 i; i < MATURITY_EPOCHS; ++i) {
            if (h.tags[i] == e && h.amts[i] != 0) {
                h.amts[i] += uint96(amount);
                return;
            }
        }
        for (uint256 i; i < MATURITY_EPOCHS; ++i) {
            if (h.amts[i] == 0) {
                h.tags[i] = e;
                h.amts[i] = uint96(amount);
                return;
            }
        }
        uint256 victim;
        uint64 bestTag = type(uint64).max;
        for (uint256 i; i < MATURITY_EPOCHS; ++i) {
            if (uint256(h.tags[i]) + MATURITY_EPOCHS <= e && h.tags[i] < bestTag) {
                bestTag = h.tags[i];
                victim = i;
            }
        }
        if (bestTag == type(uint64).max) revert LedgerCorrupt();
        h.tags[victim] = e;
        h.amts[victim] = uint96(amount);
    }

    /// @dev Removes exactly `take` from slot with tag `tag`. Corrupts nothing; the caller's fuzz
    /// exercises every path this reaches.
    function _histRemove(Histogram storage h, uint64 tag, uint96 take) internal {
        for (uint256 i; i < MATURITY_EPOCHS; ++i) {
            if (h.tags[i] == tag && h.amts[i] >= take) {
                h.amts[i] -= take;
                return;
            }
        }
        revert LedgerCorrupt();
    }

    /// @dev Peel `amount` out of `h` (oldest-tag-first when `oldest`, else newest), stamping at
    /// most 8 (tag, amt) pairs into `out`. The caller decides what each freed lineage means.
    /// Never peels past the stack's content — pending is always ≤ balance, and callers that took a
    /// mature-part remainder handle it separately (the escrow paths do exactly that).
    function _peel(Histogram storage h, uint256 amount, bool oldest, Lineage[8] memory out)
        internal
        returns (uint256 n)
    {
        while (amount != 0) {
            uint256 victim = type(uint256).max;
            uint64 bestTag;
            {
                uint64 seed = oldest ? type(uint64).max : 0;
                for (uint256 i; i < MATURITY_EPOCHS; ++i) {
                    if (h.amts[i] == 0) continue;
                    bool better = oldest ? h.tags[i] < seed : h.tags[i] > seed;
                    if (better) {
                        seed = h.tags[i];
                        victim = i;
                    }
                }
                bestTag = seed;
            }
            if (victim == type(uint256).max) break; // nothing pending left in the stack
            uint96 amt = h.amts[victim];
            uint96 take = amt < uint96(amount) ? amt : uint96(amount);
            out[n] = Lineage({tag: bestTag, amt: take});
            ++n;
            h.amts[victim] -= take;
            amount -= take;
        }
    }

    // ------------------------------------------------------------------
    // History pushes (copy-on-change, block-coalesced — matching the base's per-block rule)
    // ------------------------------------------------------------------

    function _pushHistories(address from, address to) internal {
        _pushOne(from);
        _pushOne(to);
        _pushGlobal();
    }

    function _pushOne(address who) internal {
        // Holders whose pending this ledger never tracks (the DAO, the market, every other
        // excluded holder, nothing) always read as zero pending; nothing to snapshot.
        if (who == address(0) || who == dao || isExcluded[who]) return;
        if (!liveSet[who]) return;
        uint48 n = uint48(block.number);
        Copy[] storage c = hist[who];
        if (c.length != 0 && c[c.length - 1].blockNumber == n) {
            c[c.length - 1] = _copyOf(live[who]);
        } else {
            c.push(_copyOf(live[who]));
        }
    }

    function _pushGlobal() internal {
        uint48 n = uint48(block.number);
        Copy[] storage c = globalHist;
        if (c.length != 0 && c[c.length - 1].blockNumber == n) {
            c[c.length - 1] = _copyOf(_globalLive());
        } else {
            c.push(_copyOf(_globalLive()));
        }
    }

    function _copyOf(Histogram storage h) internal view returns (Copy memory m) {
        m.blockNumber = uint48(block.number);
        for (uint256 i; i < MATURITY_EPOCHS; ++i) {
            m.tags[i] = h.tags[i];
            m.amts[i] = h.amts[i];
        }
        return m;
    }

    // ------------------------------------------------------------------
    // Access
    // ------------------------------------------------------------------

    function _assertConfiguredMarket() internal view {
        if (!configured || msg.sender != market_) revert MarketOnly();
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
