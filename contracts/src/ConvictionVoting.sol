// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {IVotingWeight} from "./VotingWeight.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "./TreasuryMandate.sol";

interface IConvictionShares {
    function balanceOf(address owner) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function delegates(address owner) external view returns (address);
}

interface IConvictionGovernor {
    function castingVote() external view returns (bool);
    function createdAt(uint256 id) external view returns (uint64);
    function snapshotBlock(uint256 id) external view returns (uint48);
    function executed(uint256 id) external view returns (bool);
    function resetConvictionQueue(uint256 id) external;
}

/// @notice Exclusive, movable Shares allocations with short conviction. Loot
/// does not vote. All executable actions use this one policy and ballot path.
/// @dev Withdrawal removes its conviction immediately. Added Shares start at
/// zero; changing sides never carries accumulated support to the other side.
contract ConvictionVoting is IVotingWeight {
    uint256 private constant WAD = 1e18;
    // floor(exp(-ln(2)/43200) * 1e18), a twelve-hour half-life.
    uint256 public constant DECAY_PER_SECOND = 999983955055097432;
    uint256 public constant HALF_LIFE = 12 hours;
    uint256 public constant MAX_ALLOCATIONS = 16;
    TreasuryMandateFactory public immutable mandateFactory;
    address public dao;
    IConvictionShares public shares;
    uint96 public totalCapacity;
    mapping(address => uint96) public capacity;
    mapping(address => address) public delegateOf;

    struct Checkpoint {
        uint48 blockNumber;
        uint96 capacity;
    }

    struct Position {
        uint96 amount;
        uint192 conviction;
        uint64 updatedAt;
        uint8 support;
    }

    struct Rules {
        uint96 quorum;
        uint96 currentYes;
        uint192 convictionYes;
        uint64 reviewEndsAt;
        uint64 expiresAt;
        uint64 delay;
        bool bounded;
    }

    struct Support {
        uint96 yes;
        uint96 no;
        uint96 abstain;
        uint192 yesConviction;
        uint192 noConviction;
        uint192 abstainConviction;
        uint64 updatedAt;
    }

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
    event AllocationChanged(
        uint256 indexed proposalId, address indexed owner, address indexed caller, uint8 side, uint96 amount
    );
    event AllocationDelegateChanged(address indexed owner, address indexed delegate);

    modifier onlyDAO() {
        if (msg.sender != dao) revert Unauthorized();
        _;
    }

    constructor(TreasuryMandateFactory factory) {
        if (address(factory).code.length == 0) revert InvalidInitialization();
        mandateFactory = factory;
    }

    /// @notice Bootstrap every initial Shares holder before proposals open.
    function initialize(address shares_, address[] calldata holders) external {
        if (dao != address(0) || shares_.code.length == 0 || holders.length > 256) revert InvalidInitialization();
        dao = msg.sender;
        shares = IConvictionShares(shares_);
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

    /// @notice Only factory-authenticated project approvals use bounded rules.
    /// Other selectors, value transfers and unknown targets stay unrestricted.
    function boundedAction(uint8 op, address target, uint256 value, bytes calldata data) external view returns (bool) {
        return op == 0 && value == 0 && data.length >= 4 && bytes4(data[:4]) == TreasuryMandate.approveProject.selector
            && mandateFactory.daos(target) == dao;
    }

    /// @notice Capture supply, approval floors, notice, expiry and execution delay.
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
        uint64 review = bounded ? uint64(24 hours) : uint64(48 hours);
        if (
            IConvictionGovernor(dao).createdAt(id) != block.timestamp || proposals[id].expiresAt != 0 || supply == 0
                || bps > 10_000 || ttl <= review + delay || delay == 0
        ) revert InvalidProposal();
        uint256 currentFloor = bounded ? (supply * 2000 + 9999) / 10_000 : supply / 2 + 1;
        if (minYes > currentFloor) currentFloor = minYes;
        uint256 quorum = (supply * bps + 9999) / 10_000;
        uint256 floorQuorum = (supply * (bounded ? 2000 : 5000) + 9999) / 10_000;
        if (floorQuorum > quorum) quorum = floorQuorum;
        if (absolute > quorum) quorum = absolute;
        if (quorum > type(uint96).max || currentFloor > type(uint96).max) revert CapacityExceeded();
        proposals[id] = Rules(
            uint96(quorum),
            uint96(currentFloor),
            uint192(supply * (bounded ? 1000 : 2500) * WAD / 10_000),
            uint64(block.timestamp) + review,
            uint64(block.timestamp) + ttl,
            delay,
            bounded
        );
        support[id].updatedAt = uint64(block.timestamp);
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

    /// @notice Sum live positions; terminal proposals release Shares lazily.
    function allocated(address owner) public view returns (uint256 amount) {
        uint256[] storage ids = ownerProposals[owner];
        for (uint256 i; i < ids.length; ++i) {
            if (_live(ids[i])) amount += positions[ids[i]][owner].amount;
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

    /// @inheritdoc IVotingWeight
    function weightFor(bytes32 proposalId, address owner, uint48 snapshot) public view returns (uint256) {
        uint256 id = uint256(proposalId);
        if (owner == dao || (proposals[id].expiresAt != 0 && !_live(id))) return 0;
        uint256 availableHere = available(owner) + positions[id][owner].amount;
        uint256 eligible = getPastCapacity(owner, snapshot);
        return availableHere < eligible ? availableHere : eligible;
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
            !IConvictionGovernor(dao).castingVote() || owner == dao
                || (caller != owner && (delegateOf[owner] == address(0) || caller != delegateOf[owner]))
        ) revert Unauthorized();
        if (snapshot != IConvictionGovernor(dao).snapshotBlock(id)) revert BadSnapshot();
        if (!_live(id) || side > 2) revert InvalidProposal();
        _prune(owner);
        uint256 eligible = weightFor(proposalId, owner, snapshot);
        if (amount == type(uint256).max) amount = eligible;
        if (amount > eligible || (amount == 0 && positions[id][owner].amount == 0)) revert InsufficientShares();
        if (ownerIndex[id][owner] == 0 && amount != 0) {
            if (ownerProposals[owner].length >= MAX_ALLOCATIONS) revert TooManyAllocations();
            ownerProposals[owner].push(id);
            ownerIndex[id][owner] = ownerProposals[owner].length;
        }
        _replace(id, owner, side, uint96(amount));
        if (amount == 0) _removeIndex(owner, id);
        _invalidateIfNeeded(id);
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
        if (from != address(0)) _trim(from);
        _checkpoint(from);
        if (to != address(0)) _checkpoint(to);
    }

    /// @notice Current and matured FOR/AGAINST/ABSTAIN allocations. Current support uses Shares wei;
    /// conviction retains 18 extra fractional decimals to avoid tiny-supply deadlocks.
    function proposalSupport(uint256 id)
        public
        view
        returns (
            uint96 yes,
            uint96 no,
            uint96 abstain,
            uint192 convictionYes,
            uint192 convictionNo,
            uint192 convictionAbstain
        )
    {
        Support storage s = support[id];
        uint256 end = proposals[id].expiresAt;
        uint256 timestamp = end != 0 && block.timestamp > end ? end : block.timestamp;
        uint256 elapsed = timestamp - s.updatedAt;
        return (
            s.yes,
            s.no,
            s.abstain,
            _accrued(s.yesConviction, s.yes, elapsed),
            _accrued(s.noConviction, s.no, elapsed),
            _accrued(s.abstainConviction, s.abstain, elapsed)
        );
    }

    /// @notice Approval requires current backing and conviction on the same ballot.
    function qualifies(uint256 id) public view returns (bool) {
        Rules storage p = proposals[id];
        if (p.expiresAt == 0 || block.timestamp < p.reviewEndsAt || block.timestamp >= p.expiresAt) return false;
        (uint96 yes, uint96 no, uint96 abstain, uint192 cy,,) = proposalSupport(id);
        return
            yes >= p.currentYes && yes > no && cy >= p.convictionYes
                && uint256(yes) + no + abstain >= p.quorum;
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

    function _live(uint256 id) private view returns (bool) {
        return proposals[id].expiresAt != 0 && block.timestamp < proposals[id].expiresAt
            && !IConvictionGovernor(dao).executed(id);
    }

    function _accrued(uint192 conviction, uint96 amount, uint256 elapsed) private pure returns (uint192) {
        uint256 decay = FixedPointMathLib.rpow(DECAY_PER_SECOND, elapsed, WAD);
        uint256 result = uint256(conviction) * decay / WAD + uint256(amount) * (WAD - decay);
        uint256 ceiling = uint256(amount) * WAD;
        return uint192(result < ceiling ? result : ceiling);
    }

    function _settle(uint256 id) private {
        Support storage s = support[id];
        uint256 elapsed = block.timestamp - s.updatedAt;
        s.yesConviction = _accrued(s.yesConviction, s.yes, elapsed);
        s.noConviction = _accrued(s.noConviction, s.no, elapsed);
        s.abstainConviction = _accrued(s.abstainConviction, s.abstain, elapsed);
        s.updatedAt = uint64(block.timestamp);
    }

    function _replace(uint256 id, address owner, uint8 side, uint96 amount) private {
        _settle(id);
        Position storage pos = positions[id][owner];
        uint192 oldConviction = _accrued(pos.conviction, pos.amount, block.timestamp - pos.updatedAt);
        uint192 newConviction;
        if (side == pos.support && pos.amount != 0) {
            newConviction = amount < pos.amount ? uint192(uint256(oldConviction) * amount / pos.amount) : oldConviction;
        }
        _changeSupport(id, pos.support, pos.amount, oldConviction, false);
        _changeSupport(id, side, amount, newConviction, true);
        pos.amount = amount;
        pos.support = side;
        pos.conviction = newConviction;
        pos.updatedAt = uint64(block.timestamp);
    }

    function _changeSupport(uint256 id, uint8 side, uint96 amount, uint192 conviction, bool adding) private {
        Support storage s = support[id];
        uint96 raw = side == 1 ? s.yes : side == 0 ? s.no : s.abstain;
        uint192 mature = side == 1 ? s.yesConviction : side == 0 ? s.noConviction : s.abstainConviction;
        raw = adding ? raw + amount : raw - amount;
        // Different aggregate/position settlement schedules can differ by a
        // fractional wei. Retire that dust conservatively; never mint it.
        mature = adding ? mature + conviction : mature > conviction ? mature - conviction : 0;
        uint192 ceiling = uint192(uint256(raw) * WAD);
        if (mature > ceiling) mature = ceiling;
        if (side == 1) {
            s.yes = raw;
            s.yesConviction = mature;
        } else if (side == 0) {
            s.no = raw;
            s.noConviction = mature;
        } else {
            s.abstain = raw;
            s.abstainConviction = mature;
        }
    }

    function _trim(address owner) private {
        _prune(owner);
        uint256 used = allocated(owner);
        uint256 balance = capacity[owner];
        if (used <= balance) return;
        uint256[] storage ids = ownerProposals[owner];
        uint256 i;
        while (i < ids.length) {
            uint256 id = ids[i];
            Position storage pos = positions[id][owner];
            uint96 amount = uint96(uint256(pos.amount) * balance / used);
            _replace(id, owner, pos.support, amount);
            _invalidateIfNeeded(id);
            emit AllocationChanged(id, owner, owner, pos.support, amount);
            if (amount == 0) _removeIndex(owner, id);
            else ++i;
        }
    }

    function _invalidateIfNeeded(uint256 id) private {
        if (!qualifies(id)) IConvictionGovernor(dao).resetConvictionQueue(id);
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
