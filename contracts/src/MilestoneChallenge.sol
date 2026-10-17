// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MilestoneBadge} from "./MilestoneBadge.sol";

interface IChallengeDao {
    function shares() external view returns (address);
    function votingWeight() external view returns (address);
}

interface IChallengeShares {
    function burnForfeited(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @dev The DAO's voting policy keeps, for each owner, the Shares they owned as of each block, independent of whom they
/// delegated to. That is the only history a milestone vote may count: delegated votes can be filled with Shares bought after
/// the objection, or with the same Shares passed between wallets that each hold a delegation.
interface IChallengePolicy {
    function getPastCapacity(address owner, uint48 snapshot) external view returns (uint96);
}

/// @title MilestoneChallenge
/// @notice The founders' lock where a milestone is reached unless the holders object. Same job as `MilestoneLock` (the
/// DAO's lock guard: the part of each team member's Shares a milestone covers cannot be sold or ragequit until it is
/// reached), different way of reaching a milestone: nobody has to approve it.
///
///  1. A team member publishes evidence for a milestone (its hash goes with the call) and posts a bond. Milestones are
///     published in order: one can be published only once the one before it has stood, so the tranches still ahead are
///     locked while an earlier milestone can still be objected to late.
///  2. A public window opens. It is longer for a big tranche and doubles after each rejected attempt.
///  3. No objection: anyone can finish it once the window has passed, and the tranche unlocks for the whole team, each
///     member getting the soulbound badge.
///  4. An objection by a holder who is not on the team (with a deposit) goes to a vote of holders. Team Shares do not
///     count, and a holder's weight is the Shares they owned just before the objection (never the votes delegated to
///     them), capped by what they hold now. It is upheld only if the rejecting weight is larger than the accepting weight and at least a small share
///     of what could vote; anything else, including nobody voting, lets the milestone stand.
///  5. For a while after an unlock, a holder can object once more. If that is upheld, every team member's remaining
///     locked Shares are burned and the bond is forfeited. What already unlocked stays unlocked.
///
/// Nothing here can free locked Shares except a milestone that stood. A vote cannot undo the lock, `forfeit` burns
/// rather than frees, and the lock guard on the Shares is set once, as before.
contract MilestoneChallenge {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_TRANCHES = 8;
    uint256 public constant MAX_TEAM = 16;
    uint256 internal constant BPS = 10_000;
    uint64 public constant MAX_WINDOW = 60 days;

    /// @param window        How long a milestone waits for objections (at least a day), before the size and retry scaling.
    /// @param votePeriod    How long a vote on an objection runs.
    /// @param clawback      How long after an unlock one more objection may be raised (zero for none).
    /// @param minRejectBps  Least rejecting weight, in basis points of what could vote, for an objection to be upheld.
    /// @param earliestBlock The first block a milestone may be submitted in (the sale's claim block).
    /// @param bondToken     What the bond and deposit are paid in (the sale currency).
    /// @param bond          What a team member posts with a submission; zero for none.
    /// @param deposit       What an objector posts; zero for none.
    struct Terms {
        uint64 window;
        uint64 votePeriod;
        uint64 clawback;
        uint16 minRejectBps;
        uint64 earliestBlock;
        address bondToken;
        uint128 bond;
        uint128 deposit;
    }

    struct Tranche {
        bytes32 checkHash;
        uint96 amount;
        bool unlocked;
        bool forfeited;
    }

    enum Phase {
        None,
        Pending,
        Voting,
        Stood
    }

    struct Milestone {
        Phase phase;
        bool lateObjected;
        uint8 attempts;
        address submitter;
        bytes32 evidence;
        uint64 windowEnds;
        uint64 unlockedAt;
        uint128 bond;
    }

    struct Objection {
        bool open;
        bool late;
        address objector;
        uint48 snapshot;
        uint64 voteEnds;
        uint128 deposit;
        uint256 eligible;
        uint256 rejectWeight;
        uint256 acceptWeight;
    }

    address public immutable dao;
    MilestoneBadge public immutable badge;
    uint64 public immutable window;
    uint64 public immutable votePeriod;
    uint64 public immutable clawback;
    uint16 public immutable minRejectBps;
    uint64 public immutable earliestBlock;
    address public immutable bondToken;
    uint128 public immutable bond;
    uint128 public immutable deposit;

    address[] internal _team;
    mapping(address => bool) public isTeam;
    bytes32[] internal _checks;
    uint16[] internal _bps;
    mapping(address beneficiary => Tranche[]) private _tranches;

    mapping(uint256 index => Milestone) public milestone;
    mapping(uint256 index => Objection) public objection;
    mapping(uint256 index => uint256) private _round;
    mapping(uint256 index => mapping(uint256 round => mapping(address voter => bool))) private _voted;

    uint256 private _entered = 1;

    event Submitted(uint256 indexed index, address indexed submitter, bytes32 evidence, uint64 windowEnds, uint128 bond);
    event Objected(
        uint256 indexed index, address indexed objector, bool late, uint48 snapshot, uint64 voteEnds, uint256 eligible
    );
    event Voted(uint256 indexed index, address indexed voter, bool reject, uint256 weight);
    event Resolved(uint256 indexed index, bool late, bool upheld, uint256 rejectWeight, uint256 acceptWeight);
    event Stands(uint256 indexed index, uint64 unlockedAt);
    event Unlocked(address indexed beneficiary, uint256 indexed index, uint96 amount, uint256 badgeId);
    event ClawedBack(uint256 indexed index, uint96 burned);
    event BondReleased(uint256 indexed index, address indexed to, uint128 amount);
    event Forfeited(address indexed beneficiary, uint96 amount);

    error OnlyDao();
    error BadSchedule();
    error BadTerms();
    error UnknownMilestone();
    error NotTeam();
    error OutOfOrder();
    error TooEarly();
    error WrongPhase();
    error WindowOpen();
    error WindowClosed();
    error VoteOpen();
    error VoteClosed();
    error AlreadyVoted();
    error NoWeight();
    error ClawbackOver();
    error BondHeld();
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @param beneficiaries The wallets whose Shares are locked.
    /// @param totals        Each wallet's whole allocation, in Share base units.
    /// @param checks        The acceptance check of each milestone, in order (shared by every beneficiary).
    /// @param bps           The part of the allocation each milestone unlocks (at most 10,000 together; the rest is
    ///                      not locked at all).
    constructor(
        address dao_,
        address[] memory beneficiaries,
        uint256[] memory totals,
        bytes32[] memory checks,
        uint16[] memory bps,
        Terms memory t
    ) {
        if (
            dao_ == address(0) || beneficiaries.length == 0 || beneficiaries.length > MAX_TEAM
                || beneficiaries.length != totals.length || checks.length == 0 || checks.length > MAX_TRANCHES
                || checks.length != bps.length
        ) revert BadSchedule();
        uint256 sum;
        for (uint256 i; i < bps.length; ++i) {
            if (bps[i] == 0 || checks[i] == bytes32(0)) revert BadSchedule();
            sum += bps[i];
            for (uint256 j; j < i; ++j) {
                if (checks[j] == checks[i]) revert BadSchedule(); // one check, one milestone
            }
        }
        if (sum > BPS) revert BadSchedule();
        if (
            t.window < 1 days || t.window > 30 days || t.votePeriod < 1 days || t.votePeriod > 30 days
                || t.clawback > 180 days || t.minRejectBps == 0 || t.minRejectBps > 5000
                || ((t.bond != 0 || t.deposit != 0) && t.bondToken.code.length == 0)
        ) revert BadTerms();

        dao = dao_;
        window = t.window;
        votePeriod = t.votePeriod;
        clawback = t.clawback;
        minRejectBps = t.minRejectBps;
        earliestBlock = t.earliestBlock;
        bondToken = t.bondToken;
        bond = t.bond;
        deposit = t.deposit;
        badge = new MilestoneBadge(address(this));
        _checks = checks;
        _bps = bps;
        for (uint256 b; b < beneficiaries.length; ++b) {
            address who = beneficiaries[b];
            if (who == address(0) || isTeam[who] || totals[b] > type(uint96).max) revert BadSchedule();
            isTeam[who] = true;
            _team.push(who);
            for (uint256 i; i < checks.length; ++i) {
                uint256 amount = (totals[b] * bps[i]) / BPS;
                if (amount == 0) revert BadSchedule();
                _tranches[who].push(Tranche(checks[i], uint96(amount), false, false));
            }
        }
    }

    // ---- what the Shares contract asks --------------------------------------------------------------

    /// @notice How many of `holder`'s Shares cannot leave yet: the tranches neither unlocked nor forfeited.
    function lockedOf(address holder) external view returns (uint256 locked) {
        Tranche[] storage t = _tranches[holder];
        for (uint256 i; i < t.length; ++i) {
            if (!t[i].unlocked && !t[i].forfeited) locked += t[i].amount;
        }
    }

    function trancheCount(address beneficiary) external view returns (uint256) {
        return _tranches[beneficiary].length;
    }

    function trancheOf(address beneficiary, uint256 index) external view returns (Tranche memory) {
        if (index >= _tranches[beneficiary].length) revert UnknownMilestone();
        return _tranches[beneficiary][index];
    }

    function team() external view returns (address[] memory) {
        return _team;
    }

    function milestoneCount() external view returns (uint256) {
        return _checks.length;
    }

    function checkOf(uint256 index) external view returns (bytes32) {
        if (index >= _checks.length) revert UnknownMilestone();
        return _checks[index];
    }

    function shareOf(uint256 index) external view returns (uint16) {
        if (index >= _bps.length) revert UnknownMilestone();
        return _bps[index];
    }

    /// @notice How long the next submission of milestone `index` will wait for objections.
    function windowFor(uint256 index) public view returns (uint64) {
        if (index >= _bps.length) revert UnknownMilestone();
        uint256 w = window;
        uint16 share = _bps[index];
        if (share >= 5000) w *= 3;
        else if (share >= 2500) w *= 2;
        uint8 tries = milestone[index].attempts;
        w <<= tries > 3 ? 3 : tries;
        return w > MAX_WINDOW ? MAX_WINDOW : uint64(w);
    }

    /// @notice What `who`'s vote would count for on milestone `index`: against its open objection, or, with none open,
    /// against an objection raised now. Zero for the team, the DAO and anyone with nothing to vote with.
    function voteWeight(uint256 index, address who) external view returns (uint256) {
        Objection storage o = objection[index];
        return _weight(who, o.open ? o.snapshot : uint48(block.number - 1));
    }

    /// @notice Whether `who` has already voted (the objector counts) on the latest objection to milestone `index`.
    function hasVoted(uint256 index, address who) external view returns (bool) {
        return _voted[index][_round[index]][who];
    }

    /// @notice What could vote on an objection raised now: everything that exists, less the DAO's own Shares and the
    /// team's.
    function eligibleSupply() public view returns (uint256 eligible) {
        IChallengeShares s = IChallengeShares(IChallengeDao(dao).shares());
        eligible = s.totalSupply();
        eligible -= _min(s.balanceOf(dao), eligible);
        for (uint256 i; i < _team.length; ++i) {
            eligible -= _min(s.balanceOf(_team[i]), eligible);
        }
    }

    // ---- reaching a milestone -----------------------------------------------------------------------

    /// @notice A team member publishes evidence for milestone `index` and posts the bond. The hash is of the evidence the
    /// team publishes alongside (the words it is judged against, and what shows it).
    function submit(uint256 index, bytes32 evidence) external nonReentrant {
        if (!isTeam[msg.sender]) revert NotTeam();
        if (index >= _checks.length) revert UnknownMilestone();
        if (block.number < earliestBlock) revert TooEarly();
        Milestone storage m = milestone[index];
        if (m.phase != Phase.None || evidence == bytes32(0) || !_openFor(index)) revert WrongPhase();
        // In order: the tranches still ahead stay locked while an earlier milestone can still be objected to late.
        if (index != 0 && milestone[index - 1].phase != Phase.Stood) revert OutOfOrder();
        uint64 ends = uint64(block.timestamp) + windowFor(index);
        m.phase = Phase.Pending;
        m.submitter = msg.sender;
        m.evidence = evidence;
        m.windowEnds = ends;
        m.bond = bond;
        if (bond != 0) IERC20(bondToken).safeTransferFrom(msg.sender, address(this), bond);
        emit Submitted(index, msg.sender, evidence, ends, bond);
    }

    /// @notice Finish a milestone nobody objected to, once its window has passed. Anyone may call it.
    function finish(uint256 index) external nonReentrant {
        Milestone storage m = milestone[index];
        if (m.phase != Phase.Pending) revert WrongPhase();
        if (block.timestamp < m.windowEnds) revert WindowOpen();
        _stand(index, m);
    }

    /// @notice A holder who is not on the team objects: to a milestone still in its window, or, once, to one that
    /// unlocked within the clawback period. Posts the deposit and opens a vote.
    function object(uint256 index) external nonReentrant {
        Milestone storage m = milestone[index];
        Objection storage o = objection[index];
        if (o.open) revert VoteOpen();
        bool late;
        uint64 ends;
        if (m.phase == Phase.Pending) {
            if (block.timestamp >= m.windowEnds) revert WindowClosed();
            // The window is never shortened: the vote ends no sooner than it would have.
            ends = uint64(block.timestamp) + votePeriod;
            if (ends < m.windowEnds) ends = m.windowEnds;
        } else if (m.phase == Phase.Stood) {
            if (m.lateObjected || block.timestamp >= m.unlockedAt + clawback) revert ClawbackOver();
            late = true;
            ends = uint64(block.timestamp) + votePeriod;
        } else {
            revert WrongPhase();
        }
        uint48 snapshot = uint48(block.number - 1);
        uint256 weight = _weight(msg.sender, snapshot);
        if (weight == 0) revert NoWeight();

        if (late) m.lateObjected = true;
        else m.phase = Phase.Voting;
        uint256 round = ++_round[index];
        o.open = true;
        o.late = late;
        o.objector = msg.sender;
        o.snapshot = snapshot;
        o.voteEnds = ends;
        o.deposit = deposit;
        o.eligible = eligibleSupply();
        o.rejectWeight = weight;
        o.acceptWeight = 0;
        _voted[index][round][msg.sender] = true;
        if (deposit != 0) IERC20(bondToken).safeTransferFrom(msg.sender, address(this), deposit);
        emit Objected(index, msg.sender, late, snapshot, ends, o.eligible);
        emit Voted(index, msg.sender, true, weight);
    }

    /// @notice Vote on an open objection. A team member cannot. The weight is the smaller of the Shares the wallet owned at
    /// the block before the objection and the Shares it holds now: buying after the objection counts for nothing, and
    /// votes delegated in cannot be used (delegation neither adds to nor takes from what a holder owns).
    function vote(uint256 index, bool reject) external {
        Objection storage o = objection[index];
        if (!o.open) revert WrongPhase();
        if (block.timestamp >= o.voteEnds) revert VoteClosed();
        uint256 round = _round[index];
        if (_voted[index][round][msg.sender]) revert AlreadyVoted();
        uint256 weight = _weight(msg.sender, o.snapshot);
        if (weight == 0) revert NoWeight();
        _voted[index][round][msg.sender] = true;
        if (reject) o.rejectWeight += weight;
        else o.acceptWeight += weight;
        emit Voted(index, msg.sender, reject, weight);
    }

    /// @notice Settle a vote once it has ended. Anyone may call it. Upheld means the rejecting weight beat the
    /// accepting weight and reached the minimum; anything else lets the milestone stand.
    function resolve(uint256 index) external nonReentrant {
        Milestone storage m = milestone[index];
        Objection storage o = objection[index];
        if (!o.open) revert WrongPhase();
        if (block.timestamp < o.voteEnds) revert VoteOpen();
        o.open = false;
        bool upheld = o.rejectWeight > o.acceptWeight && o.rejectWeight * BPS >= o.eligible * minRejectBps;
        emit Resolved(index, o.late, upheld, o.rejectWeight, o.acceptWeight);
        address objector = o.objector;
        uint128 dep = o.deposit;
        if (!o.late) {
            if (upheld) {
                // The milestone goes back to be tried again, with a longer window; the bond is forfeited, half to the
                // objector (who gets the deposit back) and half to the DAO.
                uint128 held = m.bond;
                m.phase = Phase.None;
                m.bond = 0;
                m.submitter = address(0);
                m.evidence = bytes32(0);
                if (m.attempts < type(uint8).max) ++m.attempts;
                _pay(objector, dep + held / 2);
                _pay(dao, held - held / 2);
            } else {
                _pay(dao, dep);
                _stand(index, m);
            }
        } else if (upheld) {
            uint128 held = m.bond;
            m.bond = 0;
            _pay(objector, dep + held / 2);
            _pay(dao, held - held / 2);
            _clawBack(index);
        } else {
            _pay(dao, dep);
        }
    }

    /// @notice Return the bond to whoever posted it once the clawback period is over and nothing is open against it.
    function releaseBond(uint256 index) external nonReentrant {
        Milestone storage m = milestone[index];
        if (m.phase != Phase.Stood || m.bond == 0) revert WrongPhase();
        if (objection[index].open || block.timestamp < m.unlockedAt + clawback) revert BondHeld();
        uint128 held = m.bond;
        m.bond = 0;
        _pay(m.submitter, held);
        emit BondReleased(index, m.submitter, held);
    }

    // ---- the DAO ------------------------------------------------------------------------------------

    /// @notice The DAO gives up on `beneficiary`'s remaining tranches (a founder who left): those Shares are burned, never
    /// freed. Returns the amount burned.
    function forfeit(address beneficiary) external returns (uint96 total) {
        if (msg.sender != dao) revert OnlyDao();
        total = _forfeit(beneficiary);
    }

    // ---- internals ----------------------------------------------------------------------------------

    function _stand(uint256 index, Milestone storage m) private {
        m.phase = Phase.Stood;
        m.unlockedAt = uint64(block.timestamp);
        emit Stands(index, m.unlockedAt);
        for (uint256 b; b < _team.length; ++b) {
            Tranche storage t = _tranches[_team[b]][index];
            if (t.unlocked || t.forfeited) continue;
            t.unlocked = true;
            uint256 id = badge.mint(_team[b], t.checkHash, uint16(index), t.amount);
            emit Unlocked(_team[b], index, t.amount, id);
        }
    }

    function _clawBack(uint256 index) private {
        uint96 burned;
        for (uint256 b; b < _team.length; ++b) {
            burned += _forfeit(_team[b]);
        }
        emit ClawedBack(index, burned);
    }

    function _forfeit(address beneficiary) private returns (uint96 total) {
        Tranche[] storage t = _tranches[beneficiary];
        for (uint256 i; i < t.length; ++i) {
            if (!t[i].unlocked && !t[i].forfeited) {
                t[i].forfeited = true;
                total += t[i].amount;
            }
        }
        if (total != 0) IChallengeShares(IChallengeDao(dao).shares()).burnForfeited(beneficiary, total);
        emit Forfeited(beneficiary, total);
    }

    /// @dev Whether any team member still has milestone `index` to reach.
    function _openFor(uint256 index) private view returns (bool) {
        for (uint256 b; b < _team.length; ++b) {
            Tranche storage t = _tranches[_team[b]][index];
            if (!t.unlocked && !t.forfeited) return true;
        }
        return false;
    }

    function _weight(address who, uint48 snapshot) private view returns (uint256) {
        if (who == dao || isTeam[who]) return 0;
        return _min(
            IChallengePolicy(IChallengeDao(dao).votingWeight()).getPastCapacity(who, snapshot),
            IChallengeShares(IChallengeDao(dao).shares()).balanceOf(who)
        );
    }

    function _pay(address to, uint256 amount) private {
        if (amount != 0) IERC20(bondToken).safeTransfer(to, amount);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
