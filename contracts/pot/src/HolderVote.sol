// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "oz5/utils/math/Math.sol";
import {HolderPause} from "./HolderPause.sol";
import {ICouncilVote, IHolderVote, ITreasuryRunner, IVoteLauncher, IVoteTreasury} from "./Interfaces.sol";

/// @title HolderVote
/// @notice The holders' pause of one project **and** the project's ballots (docs/next-version/COUNCIL-PLAN.md, section 2).
/// It is the pause (`HolderVote is HolderPause`): the Treasury asks it `paused()` and tells it `poke()` exactly as before, and
/// nothing new is added to the Treasury for counting. On top of the custody it holds two kinds of ballot:
///
///  - a **replace vote**: whether the runner seat moves to a new Council of five accounts (opened by a parked holder, with a
///    list of its own in the same call);
///  - a **seat election**: which two accounts take the two Council seats that have come up (opened by anyone when the Council
///    says they are due).
///
/// **Votes count only Shares parked here, and only from the second the ballot opened.** For each account the contract keeps the
/// fewest Shares it had parked at any moment since the snapshot, in one slot: parking raises the balance but never the fewest, and
/// an unpark lowers it. There is no history array and no loop over voters. The `park`/`unpark` hooks the parent calls lower a
/// weighted vote the same moment Shares leave custody, so a Share that leaves stops counting at once; the hook stops at `voteEnd`,
/// so the tallies freeze and the result stands.
///
/// Every number is a named constant (section 2.4), so a reader can carry it to the app and no screen types a number. A won
/// result changes nothing until `effectiveAt` (the vote's end plus the Treasury's longest task notice, read at opening); anyone
/// may then carry it out, and if nobody does it lapses two time units later. The contract holds no dollars, has no owner, no
/// upgrade and no payable function, and never slows `unpark` or `leave` (a Take out).
/// @dev A clone per project, made by the Launcher in the launch transaction, when the deployment's Council switch is on (the
/// clone is the project's `pauseGate`). `bindProject` records the Treasury, the project's key and the Launcher; only the
/// Launcher calls it, once.
contract HolderVote is HolderPause {
    // ================================================== constants =====================================================

    /// @notice Names may be put forward for this many days after a ballot opens (a day is `unit / 7`).
    uint256 public constant STAND_DAYS = 1;
    /// @notice Voting runs for this many days after the stand window closes.
    uint256 public constant VOTE_DAYS = 3;
    /// @notice To stand (a person, or a list) an account needs this share of the Shares at the snapshot: 1 in 1,000.
    uint256 public constant STAND_DIVISOR = 1000;
    /// @notice To open a replace vote the Shares parked in all must be this share of the Shares at the snapshot: 1 in 20.
    uint256 public constant OPEN_DIVISOR = 20;
    /// @notice The smallest weight that can be cast (and the smallest tally that can take a seat): one whole Share.
    uint256 public constant MIN_VOTE = 1e18;
    /// @notice The most lists a replace ballot offers (besides "keep").
    uint8 public constant MAX_LISTS = 4;
    /// @notice The most people a seat ballot offers (besides "keep").
    uint8 public constant MAX_PEOPLE = 12;
    /// @notice A replace vote that ended "kept" with the floor met holds the door for this many time units (28 days at 7).
    uint256 public constant COOLDOWN_UNITS = 4;
    /// @notice A won result nobody carries out lapses this many time units after it was due.
    uint256 public constant LAPSE_UNITS = 2;

    /// @notice A replace vote: whether the runner seat moves, and to which list.
    uint8 public constant KIND_REPLACE = 1;
    /// @notice A seat election: which two accounts take the two seats that came up.
    uint8 public constant KIND_SEATS = 2;

    /// @notice No result yet.
    uint8 public constant OUTCOME_OPEN = 0;
    /// @notice Turnout was under the floor; nothing changes.
    uint8 public constant OUTCOME_SHORT = 1;
    /// @notice The floor was met and no list took more than half of the cast Shares; nothing changes.
    uint8 public constant OUTCOME_KEPT = 2;
    /// @notice The floor was met and a list took more than half of the cast Shares.
    uint8 public constant OUTCOME_MOVED = 3;
    /// @notice The floor was met and at least one person beat "keep"; the seat(s) move after the wait.
    uint8 public constant OUTCOME_SEATED = 4;
    /// @notice The floor was met and nobody beat "keep"; nothing changes.
    uint8 public constant OUTCOME_UNCHANGED = 5;

    /// @dev An option's kind: "keep" is option 0 in every ballot.
    uint8 private constant OPTION_KEEP = 0;
    uint8 private constant OPTION_LIST = 1;
    uint8 private constant OPTION_PERSON = 2;

    // ==================================================== state =======================================================

    /// @notice One ballot's numbers, all fixed at the second it opened.
    struct Ballot {
        uint8 kind; // KIND_REPLACE or KIND_SEATS
        uint8 outcome; // OUTCOME_*, once finished
        bool finished; // BallotFinished was said
        bool carried; // the result was put in
        bool lapsed; // a won result nobody carried out
        uint8 upA; // seats ballot: one of the two seats that came up
        uint8 upB; // seats ballot: the other
        uint8 winner; // replace: the list that took more than half; seats: the first winner (0 none)
        uint8 winnerB; // seats: the second winner (0 none)
        uint8 optionCount; // 1 ("keep") plus what stood
        uint64 openedAt;
        uint64 standEnd;
        uint64 voteEnd;
        uint64 effectiveAt;
        uint256 supply; // the backers' Shares at the snapshot
        uint256 floor; // the Shares that must be cast (a third of `supply`, rounded up)
        address council; // seats ballot: the Council whose seats came up
    }

    /// @notice One choice on a ballot: "keep" (option 0, empty), a list of five accounts, or one person.
    struct Option {
        uint8 kind;
        bytes32 recordHash; // the signed text's id (the chain keeps only the hash)
        address proposer;
        address[5] members;
    }

    /// @notice The project's Treasury (`bindProject`, once, by the Launcher).
    IVoteTreasury public treasury;
    /// @notice The Launcher, for the winning list's Council and the project's own accounts (`bindProject`).
    IVoteLauncher public launcher;
    /// @notice The project's key, for the Launcher's calls.
    bytes32 public key;
    /// @notice The ballot that is open or whose result is waiting; zero before the first (and never once one is settled).
    uint32 public current;
    /// @notice The number the next ballot gets; never reused.
    uint32 public nextBallot;
    /// @notice The second a replace vote may next open (the cooldown's end; zero when there is none).
    uint64 public nextReplaceAt;
    /// @notice Every ballot, by id.
    mapping(uint32 => Ballot) public ballots;

    mapping(uint32 => mapping(uint8 => Option)) private _options;
    mapping(uint32 => mapping(uint8 => uint256)) private _tally;
    mapping(uint32 => uint256) private _cast;
    /// @dev Per account: `(ballot id << 128) | low`, the fewest Shares parked since that ballot opened. One slot. The weight
    /// is 128 bits: an account can park up to `MAX_SHARES` (1e30 wei), which is over 2^96, and a narrower field would carry
    /// the low bits into the id.
    mapping(address => uint256) private _snap;
    /// @dev Per account: `(ballot id << 136) | (option << 128) | weight` of a vote cast, or zero. One slot.
    mapping(address => uint256) private _castOf;
    /// @dev The ballot an account stood in (as a person or as a list's proposer).
    mapping(address => uint32) private _stood;
    /// @dev The ballot an account was displaced from, so it may not stand again in that ballot.
    mapping(address => uint32) private _displaced;
    bool private transient _executing;

    // ==================================================== events =====================================================

    /// @notice The clone was bound to its project.
    event ProjectBound(address indexed treasury, bytes32 indexed key, address indexed launcher);
    /// @notice A ballot opened; every number a reader needs. `upA`/`upB` are the two seats of a seat election (0 otherwise).
    event BallotOpened(
        uint32 indexed id,
        uint8 kind,
        uint64 openedAt,
        uint64 standEnd,
        uint64 voteEnd,
        uint64 effectiveAt,
        uint256 supply,
        uint256 floor,
        uint8 upA,
        uint8 upB,
        address by
    );
    /// @notice A person or a list was put forward at `option`; `displaced` is the proposer whose place it took (zero when none).
    event Stood(
        uint32 indexed id,
        uint8 option,
        address indexed by,
        address[5] members,
        uint8 count,
        bytes32 recordHash,
        address displaced
    );
    /// @notice A voter's weight went to `option`; the tallies after are absolute. `fromOption` is 255 when the vote is new.
    event Voted(
        uint32 indexed id,
        address indexed who,
        uint8 option,
        uint256 weight,
        uint256 optionTally,
        uint256 castTotal,
        uint8 fromOption,
        uint256 fromTally
    );
    /// @notice A voter took Shares back during the vote and their weight fell to `weight`.
    event Fell(
        uint32 indexed id, address indexed who, uint8 option, uint256 weight, uint256 optionTally, uint256 castTotal
    );
    /// @notice The result, from the frozen tallies. `winner`/`winnerB` are option numbers (0 when none).
    event BallotFinished(uint32 indexed id, uint8 outcome, uint8 winner, uint8 winnerB, uint256 castTotal);
    /// @notice The result was put in. `council` is the new Council for a replace vote, zero for a seat election.
    event BallotCarriedOut(uint32 indexed id, address council);
    /// @notice A won result nobody carried out was let go.
    event BallotLapsed(uint32 indexed id);

    // ==================================================== errors =====================================================

    /// @notice The clone is already bound to a project (or the implementation).
    error AlreadyBound();
    /// @notice `bindProject` was called by something that is not the project's pause wiring, or for a Treasury that does not
    /// point at this contract.
    error BadProject();
    /// @notice The contract has not been bound to a project yet.
    error NotBound();
    /// @notice Another ballot is open, or a won result is still waiting to be carried out.
    error BallotLive();
    /// @notice No ballot has that id.
    error NoBallot();
    /// @notice This ballot does not take that kind of action.
    error BadKind();
    /// @notice The stand window is over (or has not opened).
    error StandingClosed();
    /// @notice Voting is not open yet (or is over).
    error VotingClosed();
    /// @notice The caller's weight is under the stake this action needs.
    error NotEligible();
    /// @notice This account already stood in this ballot (or was displaced from it).
    error AlreadyStood();
    /// @notice Every place is taken and the caller's stake does not beat the smallest.
    error NoRoom();
    /// @notice A list is not five distinct non-zero accounts that can act.
    error BadMembers();
    /// @notice One of the project's own accounts cannot be a seat.
    error ProjectAccount();
    /// @notice That option is not on this ballot.
    error BadOption();
    /// @notice An account that holds a seat which is not up cannot stand for a seat.
    error HoldsSeat();
    /// @notice A replace vote reopened too soon after a "kept" result that met the floor.
    error Cooldown(uint64 at);
    /// @notice The ballot has not reached that point yet.
    error TooEarly(uint64 at);
    /// @notice The result is not recorded yet (or was already).
    error NotFinished();
    /// @notice This ballot was already finished.
    error AlreadyFinished();
    /// @notice There is nothing to carry out or let go.
    error NothingToDo();
    /// @notice The project was wound down (or the Council that voted is no longer the runner).
    error WoundDown();
    /// @notice A won result is not late enough to lapse (and the project still runs).
    error NotLapsable();
    /// @notice A won result's time to be carried out is over (two time units after it was due).
    error TooLate(uint64 at);
    /// @notice A call is already running.
    error Reentrancy();
    /// @notice The ballot is already settled.
    error Settled();

    modifier nonReentrant() {
        if (_executing) revert Reentrancy();
        _executing = true;
        _;
        _executing = false;
    }

    // ================================================== setup ========================================================

    /// @notice Bind this clone to its project: the Treasury, the project's key and the Launcher. Only the Launcher, once, in
    /// the launch transaction (the same transaction that made the clone and bound it as the project's pause).
    /// @param treasury_ The project's Treasury.
    /// @param key_ The project's key.
    function bindProject(ITreasuryRunner treasury_, bytes32 key_) external {
        if (address(treasury) != address(0)) revert AlreadyBound();
        if (address(treasury_) == address(0) || msg.sender == address(0)) revert BadProject();
        if (treasury_.pauseGate() != address(this)) revert BadProject();
        treasury = IVoteTreasury(address(treasury_));
        launcher = IVoteLauncher(msg.sender);
        key = key_;
        emit ProjectBound(address(treasury_), key_, msg.sender);
    }

    /// @notice True: this is the vote contract (the Launcher checks it before it binds a Council beside a plain pause).
    function isVote() external pure returns (bool) {
        return true;
    }

    // ============================================ the pause's hooks ==================================================

    /// @inheritdoc HolderPause
    /// @dev Only while a ballot is live: the first touch of an account writes the Shares it had parked at the snapshot. After
    /// `voteEnd` it writes nothing (the tallies are frozen).
    function _beforeChange(address who) internal override {
        uint32 id = _liveVote();
        if (id == 0) return;
        if (uint32(_snap[who] >> 128) != id) _snap[who] = (uint256(id) << 128) | parkedOf[who];
    }

    /// @inheritdoc HolderPause
    /// @dev Only while a ballot is live: the fewest-since-snapshot falls, and a vote cast above it falls with it, the tally
    /// lowered in the same slot. No external call, no loop, no allocation: it cannot slow a Take out.
    function _afterUnpark(address who, uint256 newParked) internal override {
        uint32 id = _liveVote();
        if (id == 0) return;
        uint256 s = _snap[who];
        if (uint32(s >> 128) != id) return;
        uint256 low = uint128(s);
        if (newParked < low) {
            low = newParked;
            _snap[who] = (uint256(id) << 128) | low;
        }
        uint256 c = _castOf[who];
        if (uint32(c >> 136) != id) return;
        uint256 w = uint128(c);
        if (w <= low) return;
        uint8 option = uint8(c >> 128);
        uint256 fall = w - low;
        _cast[id] -= fall;
        _tally[id][option] -= fall;
        _castOf[who] = (uint256(id) << 136) | (uint256(option) << 128) | low;
        emit Fell(id, who, option, low, _tally[id][option], _cast[id]);
    }

    // ================================================== standings ===================================================

    /// @notice Stand yourself for a seat that came up. The account stands, its own text's hash is recorded, and only the
    /// ballot's two seats can be contested. Needs a thousandth of the Shares at the snapshot parked when the ballot opened.
    /// @param recordHash The id of the signed candidacy record (its text is off the chain; only the hash is here).
    /// @return option The option number the account got.
    function stand(bytes32 recordHash) external returns (uint8 option) {
        uint32 id = _liveVote();
        if (id == 0) revert VotingClosed();
        Ballot storage b = ballots[id];
        if (b.kind != KIND_SEATS) revert BadKind();
        if (block.timestamp >= b.standEnd) revert StandingClosed();
        if (_stood[msg.sender] == id || _displaced[msg.sender] == id) revert AlreadyStood();
        uint256 w = _weightNow(id, msg.sender);
        if (w * STAND_DIVISOR < b.supply) revert NotEligible();
        if (_holdsSeatNotUp(b, msg.sender)) revert HoldsSeat();
        if (launcher.isProjectAccount(key, msg.sender)) revert ProjectAccount();
        address displaced = address(0);
        if (b.optionCount - 1 < MAX_PEOPLE) {
            option = b.optionCount++;
        } else {
            // every person place is taken: a strictly larger stake takes the smallest one's place, as a list does
            option = 255;
            uint256 smallest = type(uint256).max;
            for (uint8 i = 1; i < b.optionCount; ++i) {
                if (_options[id][i].kind != OPTION_PERSON) continue;
                uint256 other = _weightNow(id, _options[id][i].proposer);
                if (other < smallest) {
                    smallest = other;
                    option = i;
                }
            }
            if (w <= smallest) revert NoRoom();
            displaced = _options[id][option].proposer;
            _displaced[displaced] = id;
        }
        _stood[msg.sender] = id;
        Option storage o = _options[id][option];
        o.kind = OPTION_PERSON;
        o.proposer = msg.sender;
        o.members[0] = msg.sender;
        o.recordHash = recordHash;
        address[5] memory ms;
        ms[0] = msg.sender;
        emit Stood(id, option, msg.sender, ms, 1, recordHash, displaced);
    }

    /// @notice Stand a list of five accounts for a replace vote, with the hash of its signed text. Needs a thousandth of the
    /// Shares at the snapshot parked when the ballot opened. When every place is taken a strictly larger stake takes the
    /// smallest one's place.
    /// @param members The five accounts the list would seat (distinct, non-zero, none of the project's own).
    /// @param recordHash The id of the signed candidacy record.
    /// @return option The option number the list got.
    function standList(address[5] calldata members, bytes32 recordHash) external returns (uint8 option) {
        uint32 id = _liveVote();
        if (id == 0) revert VotingClosed();
        Ballot storage b = ballots[id];
        if (b.kind != KIND_REPLACE) revert BadKind();
        if (block.timestamp >= b.standEnd) revert StandingClosed();
        return _standList(id, b, members, recordHash, msg.sender);
    }

    // =================================================== opening =====================================================

    /// @notice Open the seat election that is due. Anyone may; the helper does. The Council says which two seats come up and
    /// moves the next date on; the ballot's snapshot, floor and wait are fixed here.
    /// @return id The ballot's id.
    function openSeats() external nonReentrant returns (uint32 id) {
        _finishDue(current);
        if (!_free()) revert BallotLive();
        address runner = treasury.runner();
        if (launcher.runnerKindOf(runner) != 2) revert BadKind();
        ICouncilVote council = ICouncilVote(runner);
        if (council.vote() != address(this)) revert BadProject();
        if (block.timestamp < council.nextElection()) revert TooEarly(council.nextElection());
        (uint8 upA, uint8 upB) = council.openElection();
        id = _open(KIND_SEATS, runner, upA, upB, msg.sender);
    }

    /// @notice Open a replace vote, with the caller's own list in the same call. A parked holder does it: the Shares parked
    /// in all must be a twentieth of the Shares at the snapshot, the caller's own weight a thousandth, and no ballot may be
    /// live (and no cooldown may be running).
    /// @param members The five accounts the caller proposes to run the project (distinct, non-zero, none of the project's own).
    /// @param recordHash The id of the signed candidacy record for the list.
    /// @return id The ballot's id.
    function openReplace(address[5] calldata members, bytes32 recordHash) external nonReentrant returns (uint32 id) {
        if (address(treasury) == address(0)) revert NotBound();
        _finishDue(current);
        if (!_free()) revert BallotLive();
        if (block.timestamp < nextReplaceAt) revert Cooldown(nextReplaceAt);
        if (treasury.windDownKind() != 0) revert WoundDown();
        uint256 supply = shares.totalSupply();
        if (parkedTotal * OPEN_DIVISOR < supply) revert NotEligible();
        if (parkedOf[msg.sender] * STAND_DIVISOR < supply) revert NotEligible();
        id = _open(KIND_REPLACE, address(0), 0, 0, msg.sender);
        _standList(id, ballots[id], members, recordHash, msg.sender);
    }

    // ==================================================== voting =====================================================

    /// @notice Put all your eligible weight on one option, or move it to another until the vote ends. Only Shares parked here
    /// from the snapshot count. Needs one whole Share of weight.
    /// @param option The option (0 is always "keep").
    function castVote(uint8 option) external {
        uint32 id = _liveVote();
        if (id == 0) revert VotingClosed();
        Ballot storage b = ballots[id];
        if (block.timestamp < b.standEnd) revert VotingClosed();
        if (option >= b.optionCount) revert BadOption();
        uint256 w = _weightNow(id, msg.sender);
        if (w < MIN_VOTE) revert NotEligible();
        uint256 c = _castOf[msg.sender];
        uint8 fromOption = 255;
        uint256 fromTally;
        if (uint32(c >> 136) == id) {
            fromOption = uint8(c >> 128);
            uint256 old = uint128(c);
            fromTally = _tally[id][fromOption] - old;
            _tally[id][fromOption] = fromTally;
            _cast[id] -= old;
        }
        uint256 t = _tally[id][option] + w;
        _tally[id][option] = t;
        _cast[id] += w;
        _castOf[msg.sender] = (uint256(id) << 136) | (uint256(option) << 128) | w;
        emit Voted(id, msg.sender, option, w, t, _cast[id], fromOption, fromTally);
    }

    // =================================================== results =====================================================

    /// @notice Record the result of a ballot whose vote has ended. Anyone, once. Later openings and carry-outs do it first.
    /// @param id The ballot.
    function finish(uint32 id) external {
        Ballot storage b = ballots[id];
        if (b.openedAt == 0) revert NoBallot();
        if (block.timestamp < b.voteEnd) revert TooEarly(b.voteEnd);
        if (b.finished) revert AlreadyFinished();
        _finish(id);
    }

    /// @notice Carry out a won result once its wait is over. Anyone may, from any wallet. For a replace vote this makes the
    /// Council and seats it; for a seat election it puts the winners in the two seats. Atomic: either it all happens or nothing.
    /// @param id The ballot.
    function carryOut(uint32 id) external nonReentrant {
        Ballot storage b = ballots[id];
        if (b.openedAt == 0) revert NoBallot();
        if (b.carried || b.lapsed) revert Settled();
        if (block.timestamp < b.effectiveAt) revert TooEarly(b.effectiveAt);
        uint64 lapseAt = uint64(uint256(b.effectiveAt) + LAPSE_UNITS * _unit());
        if (block.timestamp > lapseAt) revert TooLate(lapseAt);
        if (!b.finished) _finish(id);
        uint8 o = b.outcome;
        if (o != OUTCOME_MOVED && o != OUTCOME_SEATED) revert NothingToDo();
        if (treasury.windDownKind() != 0) revert WoundDown();
        b.carried = true; // reverted with the whole call if anything below fails
        if (b.kind == KIND_REPLACE) {
            address council = launcher.councilByVote(key, _options[id][b.winner].members, id);
            treasury.seatByVote(council);
            emit BallotCarriedOut(id, council);
        } else {
            if (!_councilIsRunner(b.council)) revert WoundDown();
            ICouncilVote(b.council).seat(b.upA, b.upB, _seatWinner(id, b.winner), _seatWinner(id, b.winnerB));
            emit BallotCarriedOut(id, address(0));
        }
    }

    /// @notice Let go of a won result nobody carried out: two time units after it was due, or once the project is wound down,
    /// or (for a seat election) once the Council that voted is no longer the runner. Anyone may. The old runner simply stays.
    /// @param id The ballot.
    function lapse(uint32 id) external {
        Ballot storage b = ballots[id];
        if (b.openedAt == 0) revert NoBallot();
        if (b.carried || b.lapsed) revert Settled();
        if (block.timestamp < b.voteEnd) revert TooEarly(b.voteEnd);
        if (!b.finished) _finish(id);
        uint8 o = b.outcome;
        if (o != OUTCOME_MOVED && o != OUTCOME_SEATED) revert NothingToDo();
        bool late = block.timestamp > uint256(b.effectiveAt) + LAPSE_UNITS * _unit();
        bool wound = treasury.windDownKind() != 0;
        bool councilGone = b.kind == KIND_SEATS && !_councilIsRunner(b.council);
        if (!late && !wound && !councilGone) revert NotLapsable();
        b.lapsed = true;
        emit BallotLapsed(id);
    }

    // ==================================================== views ======================================================

    /// @notice True when a replace vote may open now (no ballot live, no cooldown, the project runs).
    function canOpenReplace() external view returns (bool) {
        if (current != 0 && !_freeSettled(current)) return false;
        if (block.timestamp < nextReplaceAt) return false;
        if (address(treasury) == address(0) || treasury.windDownKind() != 0) return false;
        uint256 supply = shares.totalSupply();
        return parkedTotal * OPEN_DIVISOR >= supply;
    }

    /// @notice True when a seat election may open now (a Council is the runner and says it is due, no ballot live).
    function canOpenSeats() external view returns (bool) {
        if (current != 0 && !_freeSettled(current)) return false;
        address runner = treasury.runner();
        if (launcher.runnerKindOf(runner) != 2) return false;
        ICouncilVote council = ICouncilVote(runner);
        return council.vote() == address(this) && block.timestamp >= council.nextElection();
    }

    /// @notice True when `id`'s won result may be carried out now.
    function canCarryOut(uint32 id) external view returns (bool) {
        Ballot storage b = ballots[id];
        if (b.openedAt == 0 || b.carried || b.lapsed) return false;
        if (block.timestamp < b.effectiveAt) return false;
        if (block.timestamp > uint256(b.effectiveAt) + LAPSE_UNITS * _unit()) return false;
        uint8 o = b.finished ? b.outcome : _result(id);
        if (o != OUTCOME_MOVED && o != OUTCOME_SEATED) return false;
        if (treasury.windDownKind() != 0) return false;
        if (b.kind == KIND_SEATS) return _councilIsRunner(b.council);
        return true;
    }

    /// @notice The weight `who` may vote with now: the fewest Shares parked since the ballot opened, or what is parked when
    /// the ballot has not touched the account.
    function weightOf(address who) public view returns (uint256) {
        uint32 id = _liveVote();
        if (id == 0) return parkedOf[who];
        return _weightNow(id, who);
    }

    /// @notice What `who` did in the ballot open now: its id, the option, the weight cast and the eligible weight.
    function ballotOf(address who) external view returns (uint32 id, uint8 option, uint256 weight, uint256 eligible) {
        id = _liveVote();
        if (id == 0) return (0, 0, 0, 0);
        uint256 c = _castOf[who];
        if (uint32(c >> 136) == id) {
            option = uint8(c >> 128);
            weight = uint128(c);
        }
        eligible = _weightNow(id, who);
    }

    /// @notice One option of a ballot: its kind, the five accounts (one, for a person), the proposer and the signed text's hash,
    /// and its tally.
    function optionOf(uint32 id, uint8 i) external view returns (Option memory option, uint256 tally) {
        option = _options[id][i];
        tally = _tally[id][i];
    }

    /// @notice One ballot, whole.
    function ballot(uint32 id) external view returns (Ballot memory) {
        return ballots[id];
    }

    /// @notice The number of options on a ballot (including "keep").
    function optionCount(uint32 id) external view returns (uint8) {
        return ballots[id].optionCount;
    }

    /// @notice The Shares cast on a ballot.
    function castOf(uint32 id) external view returns (uint256) {
        return _cast[id];
    }

    /// @notice The result `id` has (or would have) from its frozen tallies.
    function resultOf(uint32 id) external view returns (uint8 outcome, uint8 winner, uint8 winnerB) {
        Ballot storage b = ballots[id];
        if (b.openedAt == 0) revert NoBallot();
        if (b.finished) return (b.outcome, b.winner, b.winnerB);
        if (block.timestamp < b.voteEnd) revert TooEarly(b.voteEnd);
        (outcome, winner, winnerB) = _compute(id);
    }

    // ================================================== plumbing ====================================================

    /// @dev The ballot whose vote is running (zero when none): the hooks and `castVote` stop at `voteEnd`.
    function _liveVote() private view returns (uint32 id) {
        id = current;
        if (id != 0 && block.timestamp >= ballots[id].voteEnd) return 0;
    }

    /// @dev The time unit N (a day is N / 7).
    function _unit() private view returns (uint256) {
        return uint256(day) * 7;
    }

    /// @dev The weight `who` has in ballot `id`: the fewest Shares parked since it opened, or the balance when the ballot never
    /// touched the account (nothing could have changed it, or the hook would have stamped it).
    function _weightNow(uint32 id, address who) private view returns (uint256) {
        uint256 s = _snap[who];
        if (uint32(s >> 128) == id) return uint128(s);
        return parkedOf[who];
    }

    /// @dev True when no ballot blocks a new one: none is open, none is waiting to be carried out, and none can still be.
    function _free() private view returns (bool) {
        if (current == 0) return true;
        return _freeSettled(current);
    }

    function _freeSettled(uint32 id) private view returns (bool) {
        Ballot storage b = ballots[id];
        if (block.timestamp < b.voteEnd) return false;
        if (b.carried || b.lapsed) return true;
        uint8 o = b.finished ? b.outcome : _result(id);
        if (o != OUTCOME_MOVED && o != OUTCOME_SEATED) return true;
        if (b.kind == KIND_SEATS && !_councilIsRunner(b.council)) return true;
        if (treasury.windDownKind() != 0) return true;
        return block.timestamp > uint256(b.effectiveAt) + LAPSE_UNITS * _unit();
    }

    /// @dev Open a ballot: fix its snapshot, floor, stand window, vote window and effective date from the chain's own numbers.
    function _open(uint8 kind, address council, uint8 upA, uint8 upB, address by) private returns (uint32 id) {
        if (address(treasury) == address(0)) revert NotBound();
        id = ++nextBallot;
        current = id;
        uint256 supply = shares.totalSupply();
        uint256 floor = Math.ceilDiv(supply, LINE_DIVISOR);
        uint64 openedAt = uint64(block.timestamp);
        uint64 standEnd = uint64(block.timestamp + STAND_DAYS * uint256(day));
        uint64 voteEnd = uint64(uint256(standEnd) + VOTE_DAYS * uint256(day));
        (uint256 wait,,) = treasury.noticeFor(500);
        uint64 effectiveAt = uint64(uint256(voteEnd) + wait);
        Ballot storage b = ballots[id];
        b.kind = kind;
        b.outcome = OUTCOME_OPEN;
        b.upA = upA;
        b.upB = upB;
        b.optionCount = 1;
        b.openedAt = openedAt;
        b.standEnd = standEnd;
        b.voteEnd = voteEnd;
        b.effectiveAt = effectiveAt;
        b.supply = supply;
        b.floor = floor;
        b.council = council;
        emit BallotOpened(id, kind, openedAt, standEnd, voteEnd, effectiveAt, supply, floor, upA, upB, by);
    }

    /// @dev Add a list (a replace vote's opener's own list, or a later one), with the place rule of the plan.
    function _standList(uint32 id, Ballot storage b, address[5] calldata members, bytes32 recordHash, address proposer)
        private
        returns (uint8 option)
    {
        if (_stood[proposer] == id || _displaced[proposer] == id) revert AlreadyStood();
        _checkMembers(members);
        uint256 w = _weightNow(id, proposer);
        if (w * STAND_DIVISOR < b.supply) revert NotEligible();
        address displaced = address(0);
        if (b.optionCount - 1 < MAX_LISTS) {
            option = b.optionCount++;
        } else {
            // every place is taken: a strictly larger stake takes the smallest one's place; an equal stake never displaces
            option = 255;
            uint256 smallest = type(uint256).max;
            uint8 smallestAt;
            for (uint8 i = 1; i < b.optionCount; ++i) {
                if (_options[id][i].kind != OPTION_LIST) continue;
                uint256 s = _weightNow(id, _options[id][i].proposer);
                if (s < smallest) {
                    smallest = s;
                    smallestAt = i;
                }
            }
            if (w <= smallest) revert NoRoom();
            option = smallestAt;
            displaced = _options[id][option].proposer;
            _displaced[displaced] = id;
        }
        Option storage o = _options[id][option];
        o.kind = OPTION_LIST;
        o.proposer = proposer;
        o.members = members;
        o.recordHash = recordHash;
        _stood[proposer] = id;
        emit Stood(id, option, proposer, members, 5, recordHash, displaced);
    }

    /// @dev The five accounts of a list must be distinct, non-zero and none of the project's own contracts.
    function _checkMembers(address[5] calldata members) private view {
        for (uint256 i; i < 5; ++i) {
            if (members[i] == address(0)) revert BadMembers();
            if (launcher.isProjectAccount(key, members[i])) revert ProjectAccount();
            for (uint256 j = i + 1; j < 5; ++j) {
                if (members[i] == members[j]) revert BadMembers();
            }
        }
    }

    /// @dev True when `who` holds a seat of `b.council` that is not one of the two that came up.
    function _holdsSeatNotUp(Ballot storage b, address who) private view returns (bool) {
        if (b.council == address(0)) return false;
        ICouncilVote c = ICouncilVote(b.council);
        for (uint8 i; i < 5; ++i) {
            (address holder,,) = c.seatOf(i);
            if (holder == who && i != b.upA && i != b.upB) return true;
        }
    }

    /// @dev True when `council` is the project's runner and was made as a Council.
    function _councilIsRunner(address council) private view returns (bool) {
        return council != address(0) && launcher.runnerKindOf(council) == 2 && treasury.runner() == council;
    }

    /// @dev The address a seat option names (zero for "no winner").
    function _seatWinner(uint32 id, uint8 option) private view returns (address) {
        if (option == 0) return address(0);
        return _options[id][option].members[0];
    }

    /// @dev Finish a ballot whose vote ended, if it is not finished: record the result, say it, and start the cooldown a "kept"
    /// replace result that met the floor earns.
    function _finishDue(uint32 id) private {
        if (id == 0) return;
        Ballot storage b = ballots[id];
        if (b.finished || block.timestamp < b.voteEnd) return;
        _finish(id);
    }

    function _finish(uint32 id) private {
        Ballot storage b = ballots[id];
        (uint8 o, uint8 w, uint8 wb) = _compute(id);
        b.outcome = o;
        b.winner = w;
        b.winnerB = wb;
        b.finished = true;
        if (b.kind == KIND_REPLACE && o == OUTCOME_KEPT && _cast[id] >= b.floor) {
            uint64 until = uint64(uint256(b.voteEnd) + COOLDOWN_UNITS * _unit());
            if (until > nextReplaceAt) nextReplaceAt = until;
        }
        emit BallotFinished(id, o, w, wb, _cast[id]);
    }

    /// @dev The result a ballot's frozen tallies give (section 2.6).
    function _compute(uint32 id) private view returns (uint8 outcome, uint8 winner, uint8 winnerB) {
        Ballot storage b = ballots[id];
        uint256 cast = _cast[id];
        if (cast < b.floor) return (OUTCOME_SHORT, 0, 0);
        if (b.kind == KIND_REPLACE) {
            for (uint8 i = 1; i < b.optionCount; ++i) {
                if (_tally[id][i] * 2 > cast) return (OUTCOME_MOVED, i, 0);
            }
            return (OUTCOME_KEPT, 0, 0);
        }
        uint256 keep = _tally[id][0];
        uint256 best;
        uint8 bestAt;
        uint256 second;
        uint8 secondAt;
        for (uint8 i = 1; i < b.optionCount; ++i) {
            uint256 t = _tally[id][i];
            if (t < MIN_VOTE || t <= keep) continue;
            if (bestAt == 0 || t > best) {
                (second, secondAt) = (best, bestAt);
                (best, bestAt) = (t, i);
            } else if (secondAt == 0 || t > second) {
                (second, secondAt) = (t, i);
            }
        }
        if (bestAt == 0) return (OUTCOME_UNCHANGED, 0, 0);
        if (secondAt == 0) return (OUTCOME_SEATED, bestAt, 0);
        // a tie for the last seat leaves that seat as it is: the second place must be strictly alone. A tie with the *first*
        // place is fine, because then the two tied are the top two.
        for (uint8 i = 1; i < b.optionCount; ++i) {
            if (i == bestAt || i == secondAt) continue;
            uint256 t = _tally[id][i];
            if (t >= MIN_VOTE && t > keep && t == second) return (OUTCOME_SEATED, bestAt, 0);
        }
        return (OUTCOME_SEATED, bestAt, secondAt);
    }

    /// @dev The derived result, for the blocking rules (no stored outcome yet).
    function _result(uint32 id) private view returns (uint8 outcome) {
        (outcome,,) = _compute(id);
    }
}
