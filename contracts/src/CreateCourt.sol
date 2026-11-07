// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice What a contract that asks the court must answer: the final ruling of one of its cases (1 for, 2 against, 0
/// when the court refused or could not rule). The same shape as Kleros's arbitrables, so the court can be swapped.
interface IArbitrable {
    function rule(uint256 dispute, uint256 ruling) external;
}

/// @title CreateCourt
/// @notice The $CREATE court for test networks (N7, docs/v3-review/COURT.md): jurors stake $CREATE and are drawn by stake
/// to judge a case against words fixed in advance. Votes are sealed, then revealed; anyone can appeal a round's ruling
/// to a larger panel (3, then 7, then 15 seats); the last ruling stands. Jurors who voted with it share the round's fee
/// and the stake of those who did not (a juror who never reveals counts as against). Every step has a deadline and can be
/// moved on by anyone. A case that cannot find jurors times out: with no ruling if nobody judged it, and with the last
/// ruling if it was an appeal no panel could hear (whoever paid for that appeal is paid back).
///
/// A juror's stake is counted in seats of `seatStake`: each seat drawn locks one, so open cases never take more than a
/// juror staked, and only free seats can be drawn or taken out. Draws use a tree of free seats (bounded at
/// `MAX_JURORS` places), so each costs the same however many jurors there are. A place needs at least one seat's stake
/// and is given back when its juror's stake reaches zero, so small stakes cannot fill the court. Money owed is withdrawn
/// by each juror.
///
/// Settling never waits on the asking contract: if its `rule` fails, the case is still ruled and paid out, and anyone
/// can hand the ruling over again (`deliverRuling`).
///
/// Test-network only as written: the draw's randomness is the block's (`prevrandao`), which a block producer can bend;
/// a main network needs a random-number service, and the settings below would change only by a platform vote with
/// notice, never for an open case. No admin, no pause.
contract CreateCourt {
    using SafeERC20 for IERC20;

    enum Period {
        Evidence,
        Commit,
        Reveal,
        Appeal,
        Ruled
    }

    /// @notice How long the parties have to give evidence before the first draw.
    uint64 public constant EVIDENCE = 2 days;
    uint64 public constant COMMIT = 2 days;
    uint64 public constant REVEAL = 2 days;
    uint64 public constant APPEAL = 2 days;
    /// @notice How long a round may wait for enough free seats before the case times out with no ruling.
    uint64 public constant DRAW_TIMEOUT = 14 days;
    uint256 public constant FIRST_SEATS = 3;
    uint256 public constant MAX_ROUNDS = 3;
    /// @notice The most jurors the court can hold (a power of two: the draw tree's size).
    uint256 public constant MAX_JURORS = 1024;
    uint256 public constant MAX_TEXT = 1000;

    /// @notice What jurors stake ($CREATE).
    IERC20 public immutable stakeToken;
    /// @notice What cases are paid in.
    IERC20 public immutable feeToken;
    /// @notice The stake one seat locks; also the least a juror can be drawn with.
    uint256 public immutable seatStake;
    /// @notice The fee per seat per round.
    uint256 public immutable feePerSeat;

    struct Juror {
        uint128 staked;
        uint128 locked;
        /// @dev Place in the draw tree (1-based), 0 before the first stake.
        uint32 index;
        /// @dev Free seats as last written to the tree.
        uint32 seats;
    }

    struct Dispute {
        IArbitrable arbitrable;
        uint8 rounds;
        Period period;
        uint64 periodStart;
        /// @dev The current round's ruling once revealed; the final ruling once ruled.
        uint8 ruling;
    }

    struct Round {
        uint32 seats;
        uint32 committed;
        uint32 revealed;
        uint128 fee;
        uint32[3] counts;
        /// @dev The round's ruling once its votes are opened.
        uint8 ruling;
        /// @dev Who paid for this round, when it is an appeal.
        address appellant;
        address[] jurors;
    }

    struct Vote {
        uint32 seats;
        bytes32 commit;
        /// @dev 0 until revealed.
        uint8 choice;
    }

    mapping(address => Juror) public jurors;
    mapping(uint256 => address) public jurorAt;
    /// @notice Places in the draw tree handed out so far; given-back places are reused first.
    uint256 public jurorCount;
    uint32[] private freePlaces;
    /// @notice Every free seat across all jurors: what a draw picks from.
    uint256 public freeSeats;
    mapping(uint256 => uint256) private tree;

    uint256 public disputeCount;
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => mapping(uint256 => Round)) private rounds;
    mapping(uint256 => mapping(uint256 => mapping(address => Vote))) public votes;

    /// @notice Fees and stake owed to each juror, withdrawn by them.
    mapping(address => uint256) public owedFee;
    mapping(address => uint256) public owedStake;
    /// @notice What no juror earned (a round nobody judged well, a case that timed out, rounding): a tenth of each pool
    /// is added to every round that has jurors who voted with the ruling.
    uint256 public feePool;
    uint256 public stakePool;
    /// @notice Cases whose asking contract did not take the final ruling: `deliverRuling` hands it over again.
    mapping(uint256 => bool) public undelivered;

    bool private entered;

    error InvalidSetup();
    error Reentrancy();
    error ShortTransfer(uint256 expected, uint256 received);
    error Full();
    error NotFree(uint256 free);
    error OnlyTwoChoices();
    error UnknownDispute(uint256 id);
    error WrongPeriod(uint256 id, Period period);
    error TooEarly(uint256 id, uint64 at);
    error TooLate(uint256 id, uint64 at);
    error NotEnoughJurors(uint256 free, uint256 needed);
    error NotDrawn(uint256 id);
    error AlreadyCommitted(uint256 id);
    error BadCommit(uint256 id);
    error BadChoice(uint8 choice);
    error LastRound(uint256 id);
    error BadText();
    error NothingOwed();
    error NothingToStake();
    error BelowOneSeat(uint256 left);
    error NothingToDeliver(uint256 id);

    event Staked(address indexed juror, uint256 amount, uint256 staked);
    event Unstaked(address indexed juror, uint256 amount, uint256 staked);
    event DisputeCreated(uint256 indexed id, address indexed arbitrable, uint256 fee, bytes extraData);
    event Evidence(uint256 indexed id, address indexed party, string text);
    event Drawn(uint256 indexed id, uint256 round, address[] jurors);
    event Committed(uint256 indexed id, uint256 round, address indexed juror);
    event Revealed(uint256 indexed id, uint256 round, address indexed juror, uint8 choice);
    event PeriodChanged(uint256 indexed id, Period period, uint8 ruling);
    event Appealed(uint256 indexed id, uint256 round, address indexed by, uint256 fee);
    event Ruled(uint256 indexed id, uint256 ruling, bool timedOut);
    event Withdrawn(address indexed juror, uint256 fee, uint256 stake);
    event RulingUndelivered(uint256 indexed id, uint256 ruling);

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(IERC20 stakeToken_, IERC20 feeToken_, uint256 seatStake_, uint256 feePerSeat_) {
        if (
            address(stakeToken_).code.length == 0 || address(feeToken_).code.length == 0 || seatStake_ == 0
                || seatStake_ > type(uint96).max || feePerSeat_ == 0 || feePerSeat_ > type(uint64).max
        ) revert InvalidSetup();
        stakeToken = stakeToken_;
        feeToken = feeToken_;
        seatStake = seatStake_;
        feePerSeat = feePerSeat_;
    }

    // ---- jurors --------------------------------------------------------------------------------------------------

    /// @notice Stake `amount` of $CREATE to be drawn for cases: each `seatStake` of it is one seat. A first stake must
    /// be at least one seat.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > type(uint96).max) revert NothingToStake();
        Juror storage j = jurors[msg.sender];
        if (j.index == 0) {
            if (amount < seatStake) revert BelowOneSeat(amount);
            uint256 given = freePlaces.length;
            if (given != 0) {
                j.index = freePlaces[given - 1];
                freePlaces.pop();
            } else {
                if (jurorCount == MAX_JURORS) revert Full();
                j.index = uint32(++jurorCount);
            }
            jurorAt[j.index] = msg.sender;
        }
        _pull(stakeToken, amount);
        j.staked += uint128(amount);
        _sync(j);
        emit Staked(msg.sender, amount, j.staked);
    }

    /// @notice Take out `amount` of your stake that no case holds: all of it, or as much as leaves at least one seat.
    function unstake(uint256 amount) external nonReentrant {
        Juror storage j = jurors[msg.sender];
        uint256 free = j.staked - j.locked;
        if (amount == 0 || amount > free) revert NotFree(free);
        uint256 left = j.staked - amount;
        if (left != 0 && left < seatStake) revert BelowOneSeat(left);
        j.staked -= uint128(amount);
        _sync(j);
        _release(j);
        emit Unstaked(msg.sender, amount, j.staked);
        stakeToken.safeTransfer(msg.sender, amount);
    }

    /// @notice Take what the court owes you: your share of fees and of other jurors' stakes.
    function withdraw() external nonReentrant {
        uint256 fee = owedFee[msg.sender];
        uint256 stakeOwed = owedStake[msg.sender];
        if (fee == 0 && stakeOwed == 0) revert NothingOwed();
        owedFee[msg.sender] = 0;
        owedStake[msg.sender] = 0;
        emit Withdrawn(msg.sender, fee, stakeOwed);
        if (fee != 0) feeToken.safeTransfer(msg.sender, fee);
        if (stakeOwed != 0) stakeToken.safeTransfer(msg.sender, stakeOwed);
    }

    // ---- cases ---------------------------------------------------------------------------------------------------

    /// @notice What opening a case costs: the first round's three seats.
    function arbitrationCost() public view returns (uint256) {
        return FIRST_SEATS * feePerSeat;
    }

    /// @notice Open a case for the calling contract, paid by it. Two choices only: 1 for, 2 against.
    function createDispute(uint256 choices, bytes calldata extraData) external nonReentrant returns (uint256 id) {
        if (choices != 2) revert OnlyTwoChoices();
        uint256 fee = arbitrationCost();
        _pull(feeToken, fee);
        id = ++disputeCount;
        Dispute storage d = disputes[id];
        d.arbitrable = IArbitrable(msg.sender);
        d.rounds = 1;
        d.periodStart = uint64(block.timestamp);
        Round storage rd = rounds[id][0];
        rd.seats = uint32(FIRST_SEATS);
        rd.fee = uint128(fee);
        emit DisputeCreated(id, msg.sender, fee, extraData);
    }

    /// @notice Give evidence for case `id`: a short text or a link, kept in the event. Anyone, until it is ruled.
    function submitEvidence(uint256 id, string calldata text) external {
        Dispute storage d = _dispute(id);
        if (d.period == Period.Ruled) revert WrongPeriod(id, d.period);
        if (bytes(text).length == 0 || bytes(text).length > MAX_TEXT) revert BadText();
        emit Evidence(id, msg.sender, text);
    }

    /// @notice Draw the current round's jurors by stake, once the first round's evidence time is over (appeal rounds
    /// draw at once). Anyone may call it.
    function draw(uint256 id) external nonReentrant {
        Dispute storage d = _dispute(id);
        if (d.period != Period.Evidence) revert WrongPeriod(id, d.period);
        uint256 r = d.rounds - 1;
        uint64 from = _drawableFrom(d, r);
        if (block.timestamp < from) revert TooEarly(id, from);
        Round storage rd = rounds[id][r];
        uint256 need = rd.seats;
        if (freeSeats < need) revert NotEnoughJurors(freeSeats, need);
        bytes32 seed = keccak256(abi.encode(blockhash(block.number - 1), block.prevrandao, id, r));
        for (uint256 s; s < need; ++s) {
            address juror = jurorAt[_find(uint256(keccak256(abi.encode(seed, s))) % freeSeats)];
            Juror storage j = jurors[juror];
            j.locked += uint128(seatStake);
            _sync(j);
            Vote storage v = votes[id][r][juror];
            if (v.seats == 0) rd.jurors.push(juror);
            v.seats += 1;
        }
        _setPeriod(id, d, Period.Commit);
        emit Drawn(id, r, rd.jurors);
    }

    /// @notice Seal your vote: `hash` is keccak256(abi.encode(choice, salt, you, id, round)).
    function commit(uint256 id, bytes32 hash) external {
        Dispute storage d = _dispute(id);
        if (d.period != Period.Commit) revert WrongPeriod(id, d.period);
        if (block.timestamp >= d.periodStart + COMMIT) revert TooLate(id, d.periodStart + COMMIT);
        uint256 r = d.rounds - 1;
        Vote storage v = votes[id][r][msg.sender];
        if (v.seats == 0) revert NotDrawn(id);
        if (v.commit != bytes32(0)) revert AlreadyCommitted(id);
        if (hash == bytes32(0)) revert BadCommit(id);
        v.commit = hash;
        rounds[id][r].committed += 1;
        emit Committed(id, r, msg.sender);
    }

    /// @notice Open your sealed vote. Choice 1 is for, 2 against.
    function reveal(uint256 id, uint8 choice, bytes32 salt) external {
        Dispute storage d = _dispute(id);
        if (d.period != Period.Reveal) revert WrongPeriod(id, d.period);
        if (block.timestamp >= d.periodStart + REVEAL) revert TooLate(id, d.periodStart + REVEAL);
        if (choice != 1 && choice != 2) revert BadChoice(choice);
        uint256 r = d.rounds - 1;
        Vote storage v = votes[id][r][msg.sender];
        if (v.commit == bytes32(0) || v.choice != 0) revert BadCommit(id);
        if (keccak256(abi.encode(choice, salt, msg.sender, id, r)) != v.commit) revert BadCommit(id);
        v.choice = choice;
        Round storage rd = rounds[id][r];
        rd.counts[choice] += v.seats;
        rd.revealed += 1;
        emit Revealed(id, r, msg.sender, choice);
    }

    /// @notice Move case `id` on once its period is over, or early once every juror acted: sealing to opening, opening to
    /// the appeal time (the round's ruling is set then). Anyone may call it.
    function passPeriod(uint256 id) external {
        Dispute storage d = _dispute(id);
        Round storage rd = rounds[id][d.rounds - 1];
        uint256 drawn = rd.jurors.length;
        if (d.period == Period.Commit) {
            if (block.timestamp < d.periodStart + COMMIT && rd.committed < drawn) {
                revert TooEarly(id, d.periodStart + COMMIT);
            }
            _setPeriod(id, d, Period.Reveal);
        } else if (d.period == Period.Reveal) {
            if (block.timestamp < d.periodStart + REVEAL && rd.revealed < rd.committed) {
                revert TooEarly(id, d.periodStart + REVEAL);
            }
            d.ruling = rd.counts[1] > rd.counts[2] ? 1 : rd.counts[2] > rd.counts[1] ? 2 : 0;
            rd.ruling = d.ruling;
            _setPeriod(id, d, Period.Appeal);
        } else {
            revert WrongPeriod(id, d.period);
        }
    }

    /// @notice What appealing case `id` now costs: the next round's seats (twice as many, plus one).
    function appealCost(uint256 id) public view returns (uint256) {
        Dispute storage d = disputes[id];
        return (uint256(rounds[id][d.rounds - 1].seats) * 2 + 1) * feePerSeat;
    }

    /// @notice Appeal the round's ruling to a larger panel, paying its fee. Anyone, during the appeal time, until the
    /// last round.
    function appeal(uint256 id) external nonReentrant {
        Dispute storage d = _dispute(id);
        if (d.period != Period.Appeal) revert WrongPeriod(id, d.period);
        if (block.timestamp >= d.periodStart + APPEAL) revert TooLate(id, d.periodStart + APPEAL);
        if (d.rounds == MAX_ROUNDS) revert LastRound(id);
        uint256 fee = appealCost(id);
        _pull(feeToken, fee);
        uint256 seats = uint256(rounds[id][d.rounds - 1].seats) * 2 + 1;
        uint256 r = d.rounds++;
        Round storage rd = rounds[id][r];
        rd.seats = uint32(seats);
        rd.fee = uint128(fee);
        rd.appellant = msg.sender;
        d.ruling = 0;
        _setPeriod(id, d, Period.Evidence);
        emit Appealed(id, r, msg.sender, fee);
    }

    /// @notice Settle case `id` once the appeal time is over (at once after the last round): pay the jurors who voted
    /// with the ruling, take the stake of those who did not, and tell the asking contract. Anyone may call it.
    function execute(uint256 id) external nonReentrant {
        Dispute storage d = _dispute(id);
        if (d.period != Period.Appeal) revert WrongPeriod(id, d.period);
        if (d.rounds < MAX_ROUNDS && block.timestamp < d.periodStart + APPEAL) {
            revert TooEarly(id, d.periodStart + APPEAL);
        }
        _rule(id, d, d.ruling, d.rounds, false);
    }

    /// @notice End case `id` when a round could not find jurors within `DRAW_TIMEOUT`. If nobody judged it, the asking
    /// contract is told 0 (things stay as they were) and the fee joins the pool. If it was an appeal, the ruling appealed
    /// stands, earlier rounds are settled against it, and whoever paid for the appeal is paid back: an appeal into a
    /// court too small to hear it cannot undo a ruling.
    function timeout(uint256 id) external nonReentrant {
        Dispute storage d = _dispute(id);
        if (d.period != Period.Evidence) revert WrongPeriod(id, d.period);
        uint256 r = d.rounds - 1;
        uint64 at = _drawableFrom(d, r) + DRAW_TIMEOUT;
        if (block.timestamp < at) revert TooEarly(id, at);
        Round storage unheard = rounds[id][r];
        if (r == 0) {
            feePool += unheard.fee;
            _rule(id, d, 0, 0, true);
        } else {
            owedFee[unheard.appellant] += unheard.fee;
            _rule(id, d, rounds[id][r - 1].ruling, r, true);
        }
    }

    /// @notice Hand case `id`'s final ruling to the asking contract again, after it failed to take it. Anyone may call
    /// it; it reverts if the asking contract refuses again.
    function deliverRuling(uint256 id) external nonReentrant {
        Dispute storage d = _dispute(id);
        if (!undelivered[id]) revert NothingToDeliver(id);
        undelivered[id] = false;
        d.arbitrable.rule(id, d.ruling);
    }

    // ---- reads ---------------------------------------------------------------------------------------------------

    /// @notice One round of a case: its seats, fee, how many jurors sealed and opened their votes, the seats for each
    /// choice (index 1 for, 2 against), and who was drawn.
    function roundOf(uint256 id, uint256 r)
        external
        view
        returns (
            uint256 seats,
            uint256 fee,
            uint256 committed,
            uint256 revealed,
            uint256 forSeats,
            uint256 againstSeats,
            address[] memory drawn
        )
    {
        Round storage rd = rounds[id][r];
        return (rd.seats, rd.fee, rd.committed, rd.revealed, rd.counts[1], rd.counts[2], rd.jurors);
    }

    /// @notice A juror's seats that no case holds.
    function freeSeatsOf(address juror) external view returns (uint256) {
        Juror storage j = jurors[juror];
        return (j.staked - j.locked) / seatStake;
    }

    // ---- inside --------------------------------------------------------------------------------------------------

    function _dispute(uint256 id) private view returns (Dispute storage d) {
        d = disputes[id];
        if (address(d.arbitrable) == address(0)) revert UnknownDispute(id);
    }

    /// @dev The first round waits for evidence; an appeal round can be drawn at once.
    function _drawableFrom(Dispute storage d, uint256 r) private view returns (uint64) {
        return r == 0 ? d.periodStart + EVIDENCE : d.periodStart;
    }

    function _setPeriod(uint256 id, Dispute storage d, Period period) private {
        d.period = period;
        d.periodStart = uint64(block.timestamp);
        emit PeriodChanged(id, period, d.ruling);
    }

    function _rule(uint256 id, Dispute storage d, uint8 ruling, uint256 settledRounds, bool timedOut) private {
        for (uint256 r; r < settledRounds; ++r) {
            _settle(id, r, ruling);
        }
        d.ruling = ruling;
        _setPeriod(id, d, Period.Ruled);
        emit Ruled(id, ruling, timedOut);
        // A plain call that copies nothing back: an asking contract that reverts, burns the gas or answers with a flood of
        // data cannot stop its jurors being paid or freed. It can take the ruling later.
        bytes memory data = abi.encodeCall(IArbitrable.rule, (id, uint256(ruling)));
        address asker = address(d.arbitrable);
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), asker, 0, add(data, 0x20), mload(data), 0, 0)
        }
        if (!ok) {
            undelivered[id] = true;
            emit RulingUndelivered(id, ruling);
        }
    }

    /// @dev A juror who opened a vote matching the ruling (any opened vote when there is no ruling) keeps their stake and
    /// shares the round's fee and the stake of the others, by seats, with a tenth of each pool. Rounding stays in the pool.
    function _settle(uint256 id, uint256 r, uint8 ruling) private {
        Round storage rd = rounds[id][r];
        uint256 n = rd.jurors.length;
        uint256 coherent;
        uint256 slashed;
        for (uint256 i; i < n; ++i) {
            address juror = rd.jurors[i];
            Vote storage v = votes[id][r][juror];
            Juror storage j = jurors[juror];
            uint128 held = uint128(uint256(v.seats) * seatStake);
            j.locked -= held;
            if (_coherent(v, ruling)) {
                coherent += v.seats;
            } else {
                j.staked -= held;
                slashed += held;
            }
            _sync(j);
            _release(j);
        }
        if (coherent == 0) {
            feePool += rd.fee;
            stakePool += slashed;
            return;
        }
        uint256 fees = rd.fee + feePool / 10;
        uint256 stakes = slashed + stakePool / 10;
        feePool -= feePool / 10;
        stakePool -= stakePool / 10;
        uint256 paidFees;
        uint256 paidStakes;
        for (uint256 i; i < n; ++i) {
            address juror = rd.jurors[i];
            Vote storage v = votes[id][r][juror];
            if (!_coherent(v, ruling)) continue;
            uint256 f = fees * v.seats / coherent;
            uint256 s = stakes * v.seats / coherent;
            owedFee[juror] += f;
            owedStake[juror] += s;
            paidFees += f;
            paidStakes += s;
        }
        feePool += fees - paidFees;
        stakePool += stakes - paidStakes;
    }

    function _coherent(Vote storage v, uint8 ruling) private view returns (bool) {
        return v.choice != 0 && (ruling == 0 || v.choice == ruling);
    }

    function _pull(IERC20 token, uint256 amount) private {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert ShortTransfer(amount, received);
    }

    /// @dev Write a juror's free seats to the draw tree.
    function _sync(Juror storage j) private {
        uint256 seats = (uint256(j.staked) - j.locked) / seatStake;
        uint256 was = j.seats;
        if (seats == was) return;
        j.seats = uint32(seats);
        if (seats > was) {
            uint256 add = seats - was;
            freeSeats += add;
            for (uint256 i = j.index; i <= MAX_JURORS; i += i & (~i + 1)) {
                tree[i] += add;
            }
        } else {
            uint256 sub = was - seats;
            freeSeats -= sub;
            for (uint256 i = j.index; i <= MAX_JURORS; i += i & (~i + 1)) {
                tree[i] -= sub;
            }
        }
    }

    /// @dev Give a juror's place in the draw tree back once nothing of theirs is staked (their seats there are then zero
    /// and no case holds them), for the next new juror.
    function _release(Juror storage j) private {
        if (j.staked != 0) return;
        freePlaces.push(j.index);
        jurorAt[j.index] = address(0);
        j.index = 0;
    }

    /// @dev The juror holding free seat number `pick` (counting from 0 across all jurors in order).
    function _find(uint256 pick) internal view returns (uint256 index) {
        for (uint256 step = MAX_JURORS; step != 0; step >>= 1) {
            uint256 next = index + step;
            if (next <= MAX_JURORS && tree[next] <= pick) {
                index = next;
                pick -= tree[next];
            }
        }
        return index + 1;
    }
}
