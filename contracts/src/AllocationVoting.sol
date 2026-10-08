// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IVotingWeight} from "./VotingWeight.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "./TreasuryMandate.sol";

interface IAllocationShares {
    function balanceOf(address owner) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function delegates(address owner) external view returns (address);
}

interface IAllocationGovernor {
    function castingVote() external view returns (bool);
    function createdAt(uint256 id) external view returns (uint64);
    function snapshotBlock(uint256 id) external view returns (uint48);
    function executed(uint256 id) external view returns (bool);
    function resetApprovalQueue(uint256 id) external;
}

/// @notice Movable Shares allocations. Loot does not vote. Every executable action uses this one
/// policy and one ballot path.
///
/// BACKING is exclusive: Shares that back one proposal (FOR) or count toward its quorum (ABSTAIN) are
/// not available to back another, so a holder must choose priorities. OPPOSITION is free: an AGAINST
/// allocation can sit on every proposal at full weight. Otherwise a majority busy backing its own
/// priorities could not also oppose a hostile one, and relative thresholds would let a minority
/// through unopposed. Opposition is a brake, not a budget.
///
/// How a proposal is approved. Requirements are captured when it opens and never change after:
///  - QUORUM  yes + no + abstain >= a share of VOTING supply (see below);
///  - APPROVAL yes >= approvalBps of (yes + no), and yes > no;
///  - HOLD    the two conditions above must have held continuously for `hold` seconds;
///  - REVIEW  nothing is approvable before `reviewEndsAt`;
///  - DELAY   the governor's queue then waits `delay`, and any loss of support restarts it.
/// Two lanes carry different bars: the unrestricted lane (treasury-scale actions) and the bounded
/// lane (an approval inside a finite, factory-made `TreasuryMandate`, whose cap and reviewers bound
/// the loss). Lane numbers are parameters, not constants, and change only for future proposals.
///
/// VOTING supply is total Shares supply at the snapshot minus Shares that can never vote: the DAO's
/// own balance, the burn address and any address the DAO excludes (an unsold sale tranche, an AMM
/// core, a vesting vault). Without that, treasury-held or lost Shares raise every bar forever.
///
/// "Support must hold" replaces the earlier accruing-conviction arithmetic: the study showed the
/// review period dominates any half-life, and a hold time is the same protection against a late
/// swing, enforceable in two lines and readable by anyone. Accruing conviction belongs on funding
/// requests competing for one pool, which is a different contract.
contract AllocationVoting is IVotingWeight {
    uint256 public constant MAX_ALLOCATIONS = 16;
    uint256 public constant MAX_EXCLUDED = 16;
    /// @notice Shares at the burn address can never vote and are never part of voting supply.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    TreasuryMandateFactory public immutable mandateFactory;
    address public dao;
    IAllocationShares public shares;
    uint96 public totalCapacity;
    mapping(address => uint96) public capacity;
    mapping(address => address) public delegateOf;

    struct Checkpoint {
        uint48 blockNumber;
        uint96 capacity;
    }

    struct Position {
        uint96 amount;
        uint8 support;
    }

    /// @dev One lane's bars. `quorumBps` is of voting supply; `approvalBps` is of votes cast for or against.
    struct Lane {
        uint16 quorumBps;
        uint16 approvalBps;
        uint64 review;
        uint64 hold;
    }

    struct Rules {
        uint96 votingSupply;
        uint96 quorum;
        uint96 minYes;
        uint16 approvalBps;
        uint64 reviewEndsAt;
        uint64 expiresAt;
        uint64 delay;
        uint64 hold;
        bool bounded;
    }

    struct Support {
        uint96 yes;
        uint96 no;
        uint96 abstain;
        /// @dev Since when quorum and approval have held without a break; zero while they do not.
        uint64 qualifiedSince;
    }

    /// @notice [0] unrestricted lane, [1] bounded lane.
    Lane[2] public lanes;
    address[] private excluded;
    mapping(address => bool) public isExcluded;

    mapping(address => Checkpoint[]) private history;
    mapping(address => uint256[]) private ownerProposals;
    mapping(uint256 => mapping(address => uint256)) private ownerIndex;
    mapping(uint256 => mapping(address => Position)) public positions;
    mapping(uint256 => Rules) public proposals;
    mapping(uint256 => Support) private support;

    error Unauthorized();
    error InvalidInitialization();
    error CapacityExceeded();
    error InsufficientShares();
    error BadSnapshot();
    error InvalidProposal();
    error TooManyAllocations();
    error InvalidLane();
    error TooManyExcluded();
    event AllocationChanged(
        uint256 indexed proposalId, address indexed owner, address indexed caller, uint8 side, uint96 amount
    );
    event AllocationDelegateChanged(address indexed owner, address indexed delegate);
    event LaneSet(bool indexed bounded, uint16 quorumBps, uint16 approvalBps, uint64 review, uint64 hold);
    event ExclusionSet(address indexed holder, bool excluded);

    modifier onlyDAO() {
        if (msg.sender != dao) revert Unauthorized();
        _;
    }

    constructor(TreasuryMandateFactory factory) {
        if (address(factory).code.length == 0) revert InvalidInitialization();
        mandateFactory = factory;
    }

    /// @notice Bootstrap every initial Shares holder before proposals open, and set the starting lanes.
    function initialize(address shares_, address[] calldata holders) external {
        if (dao != address(0) || shares_.code.length == 0 || holders.length > 256) revert InvalidInitialization();
        dao = msg.sender;
        shares = IAllocationShares(shares_);
        lanes[0] = Lane({quorumBps: 2000, approvalBps: 6600, review: 48 hours, hold: 12 hours});
        lanes[1] = Lane({quorumBps: 1000, approvalBps: 5500, review: 24 hours, hold: 6 hours});
        _setExcluded(BURN, true);
        for (uint256 i; i < holders.length; ++i) {
            address owner = holders[i];
            if (owner == address(0)) revert InvalidInitialization();
            if (history[owner].length != 0) continue;
            uint256 balance = shares.balanceOf(owner);
            if (balance > type(uint96).max || uint256(totalCapacity) + balance > type(uint96).max) {
                revert CapacityExceeded();
            }
            capacity[owner] = uint96(balance);
            totalCapacity += uint96(balance);
            _checkpoint(owner);
        }
        if (totalCapacity != shares.totalSupply()) revert InvalidInitialization();
    }

    // ------------------------------------------------------------------
    // Settings (DAO governance; they apply to proposals opened afterwards)
    // ------------------------------------------------------------------

    /// @notice Replace one lane's bars. The ranges keep governance able to act and able to repair itself:
    /// quorum 5% to 60% of voting supply, approval above half but at most 90% of votes cast, review one to
    /// fourteen days, and a hold no longer than the review or a week. (A DAO that sets a bar nobody can
    /// meet could never lower it again.)
    function setLane(bool bounded, uint16 quorumBps, uint16 approvalBps, uint64 review, uint64 hold)
        external
        onlyDAO
    {
        if (
            quorumBps < 500 || quorumBps > 6000 || approvalBps < 5001 || approvalBps > 9000 || review < 1 days
                || review > 14 days || hold > review || hold > 7 days
        ) revert InvalidLane();
        lanes[bounded ? 1 : 0] = Lane(quorumBps, approvalBps, review, hold);
        emit LaneSet(bounded, quorumBps, approvalBps, review, hold);
    }

    /// @notice Keep (or stop keeping) an address's Shares out of voting supply. For holders that can
    /// never vote: a sale tranche, an AMM core, a vesting vault. The DAO itself is always excluded.
    function setExcluded(address holder, bool on) external onlyDAO {
        _setExcluded(holder, on);
    }

    function excludedHolders() external view returns (address[] memory) {
        return excluded;
    }

    /// @notice Only factory-authenticated project approvals use the bounded lane.
    /// Other selectors, value transfers and unknown targets stay unrestricted.
    function boundedAction(uint8 op, address target, uint256 value, bytes calldata data) external view returns (bool) {
        return op == 0 && value == 0 && data.length >= 4 && bytes4(data[:4]) == TreasuryMandate.approveProject.selector
            && mandateFactory.daos(target) == dao;
    }

    /// @notice Capture voting supply, the lane's bars, notice, expiry and execution delay.
    /// `bps`, `absolute` and `minYes` are the governor's own settings; they can raise a bar, never lower it.
    function openProposal(
        uint256 id,
        uint256 supply,
        uint16 bps,
        uint96 absolute,
        uint96 minYes,
        uint64 ttl,
        uint64 delay,
        bool bounded
    ) external onlyDAO {
        Lane memory lane = lanes[bounded ? 1 : 0];
        if (
            IAllocationGovernor(dao).createdAt(id) != block.timestamp || proposals[id].expiresAt != 0 || bps > 10_000
                || delay == 0
        ) revert InvalidProposal();
        // The governor's TTL is a minimum lifetime. A lane whose review, hold and delay do not fit inside it
        // would otherwise refuse every proposal, and only a proposal can change the TTL.
        uint256 needed = uint256(lane.review) + lane.hold + delay + 1 days;
        if (ttl < needed) ttl = uint64(needed);
        uint256 votingSupply = _votingSupply(supply, IAllocationGovernor(dao).snapshotBlock(id));
        if (votingSupply == 0) revert InvalidProposal();
        uint256 quorum = _ceilBps(votingSupply, lane.quorumBps);
        uint256 governorQuorum = _ceilBps(votingSupply, bps);
        if (governorQuorum > quorum) quorum = governorQuorum;
        if (absolute > quorum) quorum = absolute;
        if (quorum > type(uint96).max || votingSupply > type(uint96).max || minYes > type(uint96).max) {
            revert CapacityExceeded();
        }
        proposals[id] = Rules({
            votingSupply: uint96(votingSupply),
            quorum: uint96(quorum),
            minYes: minYes,
            approvalBps: lane.approvalBps,
            reviewEndsAt: uint64(block.timestamp) + lane.review,
            expiresAt: uint64(block.timestamp) + ttl,
            delay: delay,
            hold: lane.hold,
            bounded: bounded
        });
    }

    /// @notice Total Shares that could vote on a proposal opened at `snapshot`.
    function votingSupplyAt(uint256 totalSupplyAtSnapshot, uint48 snapshot) external view returns (uint256) {
        return _votingSupply(totalSupplyAtSnapshot, snapshot);
    }

    /// @notice Snapshot eligibility uses owned Shares, independent of delegation.
    function getPastCapacity(address owner, uint48 snapshot) public view returns (uint96) {
        if (snapshot >= block.number) revert BadSnapshot();
        Checkpoint[] storage h = history[owner];
        uint256 low;
        uint256 high = h.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (h[mid].blockNumber > snapshot) high = mid;
            else low = mid + 1;
        }
        return low == 0 ? 0 : h[low - 1].capacity;
    }

    /// @notice Shares committed to backing (FOR) or quorum (ABSTAIN) on live proposals. AGAINST is free and not
    /// counted. Terminal proposals release their Shares lazily.
    function allocated(address owner) public view returns (uint256 amount) {
        uint256[] storage ids = ownerProposals[owner];
        for (uint256 i; i < ids.length; ++i) {
            Position storage pos = positions[ids[i]][owner];
            if (pos.support != 0 && _live(ids[i])) amount += pos.amount;
        }
    }

    /// @notice Unallocated owned Shares. There is no spending or refill ledger.
    function available(address owner) public view returns (uint256) {
        return capacity[owner] - allocated(owner);
    }

    /// @notice Bounded enumeration for client allocation management.
    function allocationsOf(address owner) external view returns (uint256[] memory) {
        return ownerProposals[owner];
    }

    /// @notice When a proposal's expiry passes (zero before it opens), without decoding `proposals`.
    function expiryOf(uint256 id) external view returns (uint64) {
        return proposals[id].expiresAt;
    }

    /// @inheritdoc IVotingWeight
    /// @dev The most Shares `owner` can put behind (FOR or ABSTAIN) this proposal: what is free, plus what already
    /// backs it, capped by the snapshot. An existing AGAINST position holds nothing back.
    function weightFor(bytes32 proposalId, address owner, uint48 snapshot) public view returns (uint256) {
        uint256 id = uint256(proposalId);
        if (owner == dao || (proposals[id].expiresAt != 0 && !_live(id))) return 0;
        Position storage pos = positions[id][owner];
        uint256 availableHere = available(owner) + (pos.support != 0 ? pos.amount : 0);
        uint256 eligible = getPastCapacity(owner, snapshot);
        return availableHere < eligible ? availableHere : eligible;
    }

    /// @notice The most Shares `owner` can set AGAINST this proposal: all of what they own, capped by the snapshot,
    /// whatever they back elsewhere.
    function opposeWeightFor(bytes32 proposalId, address owner, uint48 snapshot) public view returns (uint256) {
        uint256 id = uint256(proposalId);
        if (owner == dao || (proposals[id].expiresAt != 0 && !_live(id))) return 0;
        uint256 eligible = getPastCapacity(owner, snapshot);
        uint256 owned = capacity[owner];
        return owned < eligible ? owned : eligible;
    }

    /// @inheritdoc IVotingWeight
    function allocateWeight(
        bytes32 proposalId,
        address owner,
        address caller,
        uint48 snapshot,
        uint8 side,
        uint256 amount
    ) external onlyDAO returns (uint96) {
        uint256 id = uint256(proposalId);
        if (
            !IAllocationGovernor(dao).castingVote() || owner == dao
                || (caller != owner && (delegateOf[owner] == address(0) || caller != delegateOf[owner]))
        ) revert Unauthorized();
        if (snapshot != IAllocationGovernor(dao).snapshotBlock(id)) revert BadSnapshot();
        if (!_live(id) || side > 2) revert InvalidProposal();
        _prune(owner);
        uint256 eligible = side == 0 ? opposeWeightFor(proposalId, owner, snapshot) : weightFor(proposalId, owner, snapshot);
        if (amount == type(uint256).max) amount = eligible;
        if (amount > eligible || (amount == 0 && positions[id][owner].amount == 0)) revert InsufficientShares();
        if (ownerIndex[id][owner] == 0 && amount != 0) {
            if (ownerProposals[owner].length >= MAX_ALLOCATIONS) revert TooManyAllocations();
            ownerProposals[owner].push(id);
            ownerIndex[id][owner] = ownerProposals[owner].length;
        }
        _replace(id, owner, side, uint96(amount));
        if (amount == 0) _removeIndex(owner, id);
        _touch(id);
        emit AllocationChanged(id, owner, caller, side, uint96(amount));
        return uint96(amount);
    }

    /// @notice Native single delegation authorizes the owner's existing positions.
    function setDelegate(address owner, address delegate) external onlyDAO {
        if (shares.delegates(owner) != delegate) revert Unauthorized();
        delegateOf[owner] = delegate == owner ? address(0) : delegate;
        emit AllocationDelegateChanged(owner, delegate);
    }

    /// @notice Authentic token hooks update owned Shares and trim over-allocation.
    /// Loot transfers, burns and issuance have no governance effect.
    function ownershipChanged(bool isLoot, address from, address to, uint256 amount) external onlyDAO {
        if (isLoot || from == to || amount == 0) return;
        if (amount > type(uint96).max) revert CapacityExceeded();
        if (from != address(0)) {
            capacity[from] -= uint96(amount);
        } else {
            if (uint256(totalCapacity) + amount > type(uint96).max) revert CapacityExceeded();
            totalCapacity += uint96(amount);
        }
        if (to != address(0)) {
            if (uint256(capacity[to]) + amount > type(uint96).max) revert CapacityExceeded();
            capacity[to] += uint96(amount);
        } else {
            totalCapacity -= uint96(amount);
        }
        if (
            (from != address(0) && shares.balanceOf(from) != capacity[from])
                || (to != address(0) && shares.balanceOf(to) != capacity[to]) || shares.totalSupply() != totalCapacity
        ) revert CapacityExceeded();
        if (from != address(0)) {
            _trim(from);
            _checkpoint(from);
        }
        if (to != address(0)) _checkpoint(to);
    }

    /// @notice Current FOR, AGAINST and ABSTAIN allocations, and since when quorum and approval have held.
    function proposalSupport(uint256 id)
        public
        view
        returns (uint96 yes, uint96 no, uint96 abstain, uint64 qualifiedSince)
    {
        Support storage s = support[id];
        return (s.yes, s.no, s.abstain, s.qualifiedSince);
    }

    /// @notice The earliest moment a proposal can be approved given support as it stands (zero while
    /// quorum and approval are not both holding).
    function earliestApproval(uint256 id) public view returns (uint64) {
        uint64 since = support[id].qualifiedSince;
        if (since == 0) return 0;
        uint64 afterHold = since + proposals[id].hold;
        uint64 review = proposals[id].reviewEndsAt;
        return afterHold > review ? afterHold : review;
    }

    /// @notice Quorum and approval hold right now (ignores review, hold time and expiry).
    function thresholdsMet(uint256 id) public view returns (bool) {
        Rules storage p = proposals[id];
        if (p.expiresAt == 0) return false;
        Support storage s = support[id];
        uint256 decided = uint256(s.yes) + s.no;
        return uint256(s.yes) + s.no + s.abstain >= p.quorum && s.yes >= p.minYes && s.yes > s.no
            && uint256(s.yes) * 10_000 >= uint256(p.approvalBps) * decided;
    }

    /// @notice Approval requires quorum and approval to have held for the hold time, after review.
    function qualifies(uint256 id) public view returns (bool) {
        Rules storage p = proposals[id];
        if (p.expiresAt == 0 || block.timestamp >= p.expiresAt) return false;
        uint64 earliest = earliestApproval(id);
        return earliest != 0 && block.timestamp >= earliest && thresholdsMet(id);
    }

    /// @notice State in native Majeur enum order; support stays movable until execution.
    function proposalState(uint256 id, bool executed, uint64 queued) external view returns (uint8) {
        if (executed) return 6;
        Rules storage p = proposals[id];
        if (p.expiresAt == 0) return 0;
        if (block.timestamp >= p.expiresAt) return 5;
        if (!qualifies(id)) return 1;
        if (queued != 0 && block.timestamp < uint256(queued) + p.delay) return 2;
        return 3;
    }

    /// @notice A proposal's frozen execution delay.
    function executionDelay(uint256 id) external view returns (uint64) {
        return proposals[id].delay;
    }

    /// @inheritdoc IVotingWeight
    function mayExit(address) external pure returns (bool, uint256) {
        return (true, 0);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _votingSupply(uint256 totalSupplyAtSnapshot, uint48 snapshot) private view returns (uint256 supply) {
        supply = totalSupplyAtSnapshot;
        uint256 deducted = getPastCapacity(dao, snapshot);
        for (uint256 i; i < excluded.length; ++i) {
            deducted += getPastCapacity(excluded[i], snapshot);
        }
        supply = deducted >= supply ? 0 : supply - deducted;
    }

    function _setExcluded(address holder, bool on) private {
        if (holder == address(0) || holder == dao || isExcluded[holder] == on) return;
        if (on) {
            if (excluded.length >= MAX_EXCLUDED) revert TooManyExcluded();
            excluded.push(holder);
        } else {
            uint256 n = excluded.length;
            for (uint256 i; i < n; ++i) {
                if (excluded[i] == holder) {
                    excluded[i] = excluded[n - 1];
                    excluded.pop();
                    break;
                }
            }
        }
        isExcluded[holder] = on;
        emit ExclusionSet(holder, on);
    }

    function _ceilBps(uint256 value, uint256 bps) private pure returns (uint256) {
        return (value * bps + 9999) / 10_000;
    }

    function _live(uint256 id) private view returns (bool) {
        return proposals[id].expiresAt != 0 && block.timestamp < proposals[id].expiresAt
            && !IAllocationGovernor(dao).executed(id);
    }

    function _replace(uint256 id, address owner, uint8 side, uint96 amount) private {
        Position storage pos = positions[id][owner];
        _changeSupport(id, pos.support, pos.amount, false);
        _changeSupport(id, side, amount, true);
        pos.amount = amount;
        pos.support = side;
    }

    function _changeSupport(uint256 id, uint8 side, uint96 amount, bool adding) private {
        Support storage s = support[id];
        if (side == 1) s.yes = adding ? s.yes + amount : s.yes - amount;
        else if (side == 0) s.no = adding ? s.no + amount : s.no - amount;
        else s.abstain = adding ? s.abstain + amount : s.abstain - amount;
    }

    /// @dev After Shares leave an owner: scale their backing positions down proportionally if they now hold less than
    /// they have backed, and cap each AGAINST position at what they still hold.
    function _trim(address owner) private {
        _prune(owner);
        uint256 used = allocated(owner);
        uint256 balance = capacity[owner];
        bool scale = used > balance;
        uint256[] storage ids = ownerProposals[owner];
        uint256 i;
        while (i < ids.length) {
            uint256 id = ids[i];
            Position storage pos = positions[id][owner];
            uint256 current = pos.amount;
            uint256 target;
            if (pos.support == 0) target = current < balance ? current : balance;
            else target = scale ? current * balance / used : current;
            if (target != current) {
                uint8 side = pos.support;
                _replace(id, owner, side, uint96(target));
                _touch(id);
                emit AllocationChanged(id, owner, owner, side, uint96(target));
                if (target == 0) {
                    _removeIndex(owner, id);
                    continue;
                }
            }
            ++i;
        }
    }

    /// @dev After any change to a proposal's support: start the hold clock when quorum and approval
    /// begin to hold, and restart both it and the governor's queue the moment they stop.
    function _touch(uint256 id) private {
        Support storage s = support[id];
        if (thresholdsMet(id)) {
            if (s.qualifiedSince == 0) s.qualifiedSince = uint64(block.timestamp);
        } else if (s.qualifiedSince != 0) {
            s.qualifiedSince = 0;
            IAllocationGovernor(dao).resetApprovalQueue(id);
        }
    }

    function _prune(address owner) private {
        uint256 i;
        while (i < ownerProposals[owner].length) {
            uint256 id = ownerProposals[owner][i];
            if (!_live(id)) _removeIndex(owner, id);
            else ++i;
        }
    }

    function _removeIndex(address owner, uint256 id) private {
        uint256 index = ownerIndex[id][owner];
        if (index == 0) return;
        uint256[] storage ids = ownerProposals[owner];
        uint256 last = ids[ids.length - 1];
        ids[index - 1] = last;
        ownerIndex[last][owner] = index;
        ids.pop();
        delete ownerIndex[id][owner];
    }

    function _checkpoint(address owner) private {
        Checkpoint[] storage h = history[owner];
        uint48 n = uint48(block.number);
        if (h.length != 0 && h[h.length - 1].blockNumber == n) h[h.length - 1].capacity = capacity[owner];
        else h.push(Checkpoint(n, capacity[owner]));
    }
}
