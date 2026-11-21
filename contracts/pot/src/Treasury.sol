// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {IERC1363Receiver} from "oz5/interfaces/IERC1363Receiver.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {IShares, IVester, ILauncherPairs, IPairSigners, IPair, ITaskBook, IHolderPause} from "./Interfaces.sol";
import {PotMath} from "./PotMath.sol";
import {RollingCap} from "./RollingCap.sol";

/// @title Treasury
/// @notice One project's pot. People back the project (`join`) and take their slice out (`leave`) any day; the team
/// reaches the money only through a small daily allowance (`draw`). See docs/next-version/JOIN-LEAVE-DESIGN.md.
///
/// Dollars (6 decimals) sit in buckets that always add up to no more than the balance:
///  - `pot` (P): cash leavers can reach;
///  - `box`: the allowance the team may draw, at most 7 days of accrual;
///  - `arriving`: outside money released into the pot evenly over one time unit N;
///  - `feesOwed`: the platform's 2% waiting to be collected (so a blocked platform address cannot block join or leave);
///  - `locked` and `notesOwed`: money set aside for tasks that were taken. `locked` is the sum of the stayers' claims on
///    those tasks (what a joiner's price counts at face); `notesOwed` is what is held for exit notes against them, and, once
///    a task has ended, for the notes still to be claimed. Dollars sit in exactly one of the buckets.
/// Backer Shares (B) and Team Shares (G) are the supplies of the two ShareTokens; nothing else stores them.
///
/// `_settled()` is the one internal view that works out the allowance, the box cap and the arriving release up to now.
/// Quotes, joins, leaves and every other action read it, so a quote cannot differ from the action.
/// @dev One copy per project, a minimal clone created and initialised by the Launcher in one transaction.
contract Treasury {
    using SafeERC20 for IERC20;
    using RollingCap for RollingCap.Ring;

    /// @notice Everything fixed at birth. The Launcher copies its settings here.
    struct Setup {
        IERC20 quote; // the dollar token (6 decimals)
        IShares shares; // backer Shares; this Treasury is its controller
        IShares team; // Team Shares; this Treasury is its controller; the whole pool sits in the Vester
        address vester; // the project's Vester
        address founder; // the person who started the project, and its first runner
        address platform; // receives the platform fee
        address salePath; // the Launcher: pair registry and wind-down forwarder
        uint32 unit; // the time unit N in seconds; a multiple of 168
        uint32 ratePpm; // the founder's allowance rate at birth, parts per million of the pot a day
        uint16 feeBps; // the platform fee on joins, ten-thousandths; at most 500
        uint128 agentUsd; // default daily dollar limit of an agent
        uint128 agentTeam; // default daily Team Share limit of an agent (pool / 1000)
        ITaskBook tasks; // the project's task queue; its Treasury is this one
    }

    /// @notice What an agent account may do, and its daily limits.
    struct Agent {
        bool active;
        uint128 usdCap;
        uint128 shareCap;
    }

    /// @notice The numbers after the allowance and the release have been worked out up to now.
    struct Snap {
        uint256 pot;
        uint256 box;
        uint256 arriving;
        uint256 active; // active seconds in total, with the slice since the last settle
        uint256 toBox; // moved from the pot into the box
        uint256 back; // moved from the box back into the pot (above the cap)
        uint256 released; // moved from arriving into the pot
        uint256 dt; // active seconds since the last settle
        uint256 stay; // the stayers' claim on taken tasks, after any task that has run out came back
        uint256 expC; // moved from locked into the pot because a task ran out
    }

    uint256 public constant PPM = 1e6;
    uint256 public constant BPS = 1e4;
    /// @notice The allowance never exceeds 0.20% of the pot a day.
    uint32 public constant MAX_RATE_PPM = 2000;
    /// @notice The platform fee never exceeds 5%.
    uint16 public constant MAX_FEE_BPS = 500;
    /// @notice The smallest join, on the gross amount: 1 dollar.
    uint256 public constant MIN_JOIN = 1e6;
    /// @notice The smallest outside payment: 1 dollar (a spam guard).
    uint256 public constant MIN_REVENUE = 1e6;
    /// @notice Backer Shares after any join stay at or under this many wei (1e12 Shares).
    uint256 public constant MAX_SHARES = 1e30;
    /// @notice The most one outside payment may be: 1e30 dollar units (a trillion trillion... of dollars, far above any real
    /// dollar's supply). It keeps every price product far below 2^256, so no state can wedge a join.
    uint256 public constant MAX_REVENUE = 1e30;
    /// @notice A seat offer lasts this many time units.
    uint256 public constant SEAT_OFFER_MULT = 2;
    /// @notice The check-in window is this many time units.
    uint256 public constant CHECK_IN_MULT = 2;
    /// @notice Anyone may wind a quiet project down after this many time units without a check-in.
    uint256 public constant WIND_MULT = 26;
    /// @dev An agent's daily limit counts for 24 to 28 hours (the day is cut into six parts).
    uint256 private constant DAY_PARTS = 6;

    // ---- fixed at birth
    IERC20 public quote;
    IShares public shares;
    IShares public team;
    address public vester;
    address public founder;
    address public platform;
    address public salePath;
    uint32 public unit;
    uint16 public feeBps;
    uint128 public agentUsd;
    uint128 public agentTeam;

    // ---- the buckets (dollar units, 1e-6)
    uint256 public pot;
    uint256 public paidIn;
    uint256 public box;
    uint256 public arriving;
    uint64 public arrivalEnd;
    uint256 public feesOwed;
    /// @notice The sum of the stayers' claims on taken tasks: the money set aside that a joiner's price counts at face. Counted
    /// in `unaccounted()`.
    uint256 public locked;
    /// @notice Dollars held for exit notes: the face of the notes against open tasks, and what is left to claim on tasks that
    /// ended. Counted in `unaccounted()`.
    uint256 public notesOwed;

    // ---- clock and rate
    uint32 public ratePpm;
    uint32 public pendingRatePpm;
    uint64 public pendingAt;
    uint64 public lastSettle;
    uint64 public lastCheckIn;
    uint256 public activeSeconds;
    bool public doorFlag;
    uint64 public windDownAt;
    uint8 public windDownKind;
    /// @notice Z: Team Shares announced to burn. Still counted in G (a leave pays on all of them), but a join is priced as
    /// if they were already gone.
    uint256 public Z;

    // ---- who runs the project
    address public runner;
    address public pendingRunner;
    bool public pendingTrim;
    /// @notice When the pending seat offer was made (zero when there is none).
    uint64 public pendingSeatAt;
    uint256 public agentEpoch;
    mapping(address => uint256) public agentEpochOf;
    mapping(address => Agent) public agents;
    mapping(address => RollingCap.Ring) private _agentUsdRing;
    mapping(address => RollingCap.Ring) private _agentTeamRing;

    // ---- step 2: tasks and the arriving stream (appended after the step 1 fields; none of those moved)
    /// @notice The project's task queue (see TaskBook).
    ITaskBook public tasks;
    /// @notice The earliest second a task runs out (the end of a take window or a deadline); zero when none is open.
    uint64 public nextExpiry;
    /// @notice When the current stream of outside money started arriving; with `arrivalTotal` it makes what has been
    /// released by now one rounding of one formula, however often `settle` is called.
    uint64 public arrivalStart;
    /// @notice The size of the current stream; released so far is `arrivalTotal - arriving`.
    uint256 public arrivalTotal;

    // ---- step 4: the holder pause (appended after the step 2 fields; none of those moved)
    /// @notice The project's holder pause (see HolderPause); zero when the deployment's switch was off at launch. When set,
    /// `draw` and `announceTask` refuse while it says paused, and every join tells it to look at the ratio.
    address public pauseGate;

    bool private transient _locked;

    /// @notice Someone backed the project. `paid` includes the platform `fee`; `shares` were minted to `to`; `credit` counts as
    /// paid-in. The price is `(paid - fee) / shares`.
    event Joined(
        address indexed who,
        address indexed to,
        uint256 paid,
        uint256 fee,
        uint256 shares,
        uint256 credit,
        uint256 potAfter,
        uint256 paidInAfter,
        uint256 sharesAfter
    );
    /// @notice A holder took money out. `note` is the face of the exit note they were given against the money set aside for
    /// taken tasks (zero when none was set aside).
    event Left(
        address indexed who,
        address indexed to,
        uint256 shares,
        uint256 cash,
        uint256 note,
        uint256 potAfter,
        uint256 paidInAfter,
        uint256 sharesAfter
    );
    /// @notice A Team Share holder took money out. `note` is the face of the exit note they were given, as in `Left`.
    event TeamLeft(
        address indexed who,
        address indexed to,
        uint256 shares,
        uint256 cash,
        uint256 note,
        uint256 potAfter,
        uint256 teamAfter
    );
    /// @notice Dollars left the box.
    event AllowanceDrawn(address indexed by, address indexed to, uint256 amount, uint256 boxAfter);
    /// @notice A higher allowance rate was proposed; anyone may apply it from `applicableAt`.
    event RateProposed(uint32 ppm, uint64 applicableAt);
    /// @notice The allowance rate changed.
    event RateSet(uint32 ppm, uint32 previousPpm, bool raised);
    /// @notice The runner checked in with the hash of the signed weekly record.
    event CheckedIn(address indexed by, bytes32 recordHash, uint64 time);
    /// @notice Outside money started arriving.
    event RevenueAdded(address indexed from, uint256 amount, uint256 arrivingAfter, uint64 arrivalEnd);
    /// @notice Outside money moved into the pot.
    event RevenueReleased(uint256 amount, uint256 arrivingAfter);
    /// @notice The founder's door switch was set.
    event DoorSet(bool open);
    /// @notice The project was wound down: `kind` 1 by choice, 2 after 26 quiet time units.
    event WoundDown(uint8 kind, address indexed by, uint64 time, uint256 boxReturned);
    /// @notice The allowance and the release were worked out up to `time`. Everything needed to rebuild the pot, the box, the
    /// arriving bucket and active time without redoing the math.
    event Settled(
        uint256 toBox,
        uint256 backToPot,
        uint256 released,
        uint256 potAfter,
        uint256 boxAfter,
        uint256 arrivingAfter,
        uint256 activeSecondsAfter,
        uint64 time
    );
    /// @notice The project's task queue, once, at birth.
    event TasksReady(address book);
    /// @notice The project's holder pause, once, in the launch transaction (only when the deployment's switch is on).
    event PauseReady(address gate);
    /// @notice Money moved between the pot and the money set aside for tasks. `kind`: 1 a task was taken (`amount` is what
    /// was set aside, `who` the taker), 2 a task was paid (`amount` the payment, `who` the worker), 3 a task was rejected
    /// (`amount` came back to the pot), 4 tasks ran out or were returned by a wind-down (`serial` 0, `amount` back to the
    /// pot), 5 a leaver was given exit notes (`serial` 0, `who` the leaver, `amount` moved from `locked` to `notesOwed`),
    /// 6 a note was claimed (`who` the holder, `amount` paid to them; `potAfter` already includes any rounding that went
    /// to the pot). Always with the three buckets after the move.
    event TaskMoney(
        uint8 kind,
        uint64 indexed serial,
        address who,
        uint256 amount,
        uint256 potAfter,
        uint256 lockedAfter,
        uint256 notesOwedAfter
    );
    /// @notice The platform's owed fees were sent.
    event FeesCollected(address indexed to, uint256 amount);
    /// @notice The runner offered the seat to `next`.
    event SeatOffered(address indexed by, address indexed next, bool founderLeaves);
    /// @notice A new runner took the seat. Agents set before it are switched off.
    event RunnerChanged(address indexed from, address indexed to);
    /// @notice An agent was set, or switched off with `active == false`.
    event AgentSet(address indexed agent, bool active, uint256 usdCap, uint256 shareCap);
    /// @notice The Vester announced `amount` Team Shares to burn.
    event BurnAnnounced(uint256 amount, uint256 zAfter);

    error BadSetup();
    error NotAllowed();
    error Reentrancy();
    error BadInput();
    error DoorShut();
    error BelowMinimum(uint256 min, uint256 got);
    error ZeroMint();
    error TooFewShares(uint256 min, uint256 got);
    error TooLittleCash(uint256 min, uint256 got);
    error TooManyShares();
    error NothingToPay();
    error TooMuch(uint256 amount, uint256 available);
    error TokenMisbehaved();
    error AlreadyWoundDown();
    error NotYet(uint256 readyAt);
    error OfferExpired();
    error NoOwner();
    /// @notice The check-in window is closed (or the project is wound down): no new task can be announced or taken.
    error ProjectQuiet();
    /// @notice The book returned something that does not add up (fails closed).
    error Inconsistent();
    /// @notice The holders' pause is on: the team cannot draw its allowance or announce a task until fewer than a third of
    /// the backers' Shares are parked.
    error Paused();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    /// @dev The runner seat for a call that moves money or changes a rule. When the runner is a Pair the Launcher made, the
    /// Pair must be in the middle of executing a proposal both signers agreed to (defence in depth: the Pair itself has no
    /// one-signer way here either). `checkIn` does not use this: either signer may check in.
    modifier onlyRunner() {
        if (!_isRunnerBothSigned()) revert NotAllowed();
        _;
    }

    modifier onlyVester() {
        if (msg.sender != vester) revert NotAllowed();
        _;
    }

    constructor() {
        founder = address(1); // locks the implementation the clones point at
    }

    /// @notice Set up the clone, once. The Launcher calls it in the transaction that creates the clone.
    function initialize(Setup calldata s) external {
        if (founder != address(0)) revert BadSetup();
        if (
            s.founder == address(0) || s.platform == address(0) || s.salePath == address(0) || s.vester == address(0)
                || address(s.quote) == address(0) || address(s.shares) == address(0) || address(s.team) == address(0)
                || s.unit == 0 || s.unit % 168 != 0 || s.ratePpm > MAX_RATE_PPM || s.feeBps > MAX_FEE_BPS
                || s.shares.controller() != address(this) || s.team.controller() != address(this)
                || address(s.tasks) == address(0) || s.tasks.treasury() != address(this) || s.tasks.unit() != s.unit
        ) revert BadSetup();
        (quote, shares, team, vester) = (s.quote, s.shares, s.team, s.vester);
        (founder, platform, salePath, runner) = (s.founder, s.platform, s.salePath, s.founder);
        (unit, feeBps, ratePpm, agentUsd, agentTeam) = (s.unit, s.feeBps, s.ratePpm, s.agentUsd, s.agentTeam);
        (lastSettle, lastCheckIn, doorFlag) = (uint64(block.timestamp), uint64(block.timestamp), true);
        tasks = s.tasks;
        emit TasksReady(address(s.tasks));
    }

    /// @notice Tie the project's holder pause to it, once. Only the Launcher (`salePath`), in the launch transaction, and
    /// only when the deployment's switch is on. A project is born with a pause or without one and keeps it.
    /// @param gate The project's `HolderPause` clone.
    function bindPause(address gate) external {
        if (msg.sender != salePath) revert NotAllowed();
        if (pauseGate != address(0) || gate == address(0)) revert BadInput();
        pauseGate = gate;
        emit PauseReady(gate);
    }

    // ================================================= join and leave ================================================

    /// @notice Back the project: pay `amount` dollars (approve first), get Shares at the price the money in the project
    /// sets this second. Reverts when the door is shut, below 1 dollar, when the Shares would be fewer than `minShares`,
    /// or when they would round to zero.
    /// @param amount Dollars to pay, platform fee included.
    /// @param minShares The least number of Shares you accept.
    /// @param to Who gets the Shares.
    function join(uint256 amount, uint256 minShares, address to) external nonReentrant returns (uint256 n) {
        _settle();
        _gate(amount);
        n = _join(msg.sender, _pull(amount), minShares, to);
    }

    /// @notice The one-signature join: the project's dollar calls this after `transferAndCall` has delivered `value` dollars.
    /// `data` is `abi.encode(minShares, to)`; `to` of zero means the payer. Only the project's dollar may call it, and only
    /// for the sender's own money (`operator == from`).
    function onTransferReceived(address operator, address from, uint256 value, bytes calldata data)
        external
        nonReentrant
        returns (bytes4)
    {
        if (msg.sender != address(quote) || operator != from || data.length != 64) revert NotAllowed();
        if (unaccounted() < value) revert TokenMisbehaved();
        _settle();
        _gate(value);
        (uint256 minShares, address to) = abi.decode(data, (uint256, address));
        _join(from, value, minShares, to == address(0) ? from : to);
        return IERC1363Receiver.onTransferReceived.selector;
    }

    /// @notice What backing with `amount` would do right now, exactly as `join` would: the Shares you get, what taking
    /// them out at once would give, money set aside for tasks (counted at face in the price), and outside money still arriving.
    function quoteBack(uint256 amount)
        external
        view
        returns (uint256 sharesOut, uint256 takeOutNow, uint256 lockedLine, uint256 arrivingLine)
    {
        Snap memory s = _settled();
        (, uint256 m, uint256 n, uint256 credit) = _price(s, amount);
        sharesOut = n;
        arrivingLine = s.arriving;
        if (n != 0) {
            uint256 b = shares.totalSupply();
            takeOutNow = PotMath.cash(n, s.pot + m, paidIn + credit, b + n, team.totalSupply());
        }
        lockedLine = s.stay;
    }

    /// @notice The platform fee on a payment of `amount`.
    function feeFor(uint256 amount) external view returns (uint256) {
        return PotMath.fee(amount, feeBps);
    }

    /// @notice Take your slice out: burn `n` of your own Shares for cash, one asset, no fee, no vote, no wait, whatever the
    /// state of the door. Paid on the pot only: not the allowance box, not outside money still arriving, not fees owed.
    /// @param n Shares to hand back.
    /// @param minCash The least cash you accept.
    /// @param to Who gets the cash.
    function leave(uint256 n, uint256 minCash, address to) external nonReentrant returns (uint256 cash) {
        _settle();
        uint256 b = shares.totalSupply();
        if (n == 0 || n > b) revert BadInput();
        uint256 g = team.totalSupply();
        cash = PotMath.cash(n, pot, paidIn, b, g);
        if (cash == 0) revert NothingToPay();
        if (cash < minCash) revert TooLittleCash(minCash, cash);
        uint256 note = _noteFull(false, n, cash, pot, locked, b, g);
        paidIn -= PotMath.paidInCut(paidIn, n, b);
        pot -= cash;
        shares.burnFor(msg.sender, n);
        note = _giveNotes(msg.sender, note);
        _pay(to, cash);
        emit Left(msg.sender, to, n, cash, note, pot, paidIn, b - n);
    }

    /// @notice What taking out `n` Shares of `holder` would give right now: the cash; the exit note, the face of what is set
    /// aside for taken tasks that would be written down to them (to be claimed when the money comes back, never more than
    /// comes back for it; exactly what `leave` would give); and how much of the outside money still arriving would be left
    /// behind for those who stay. Zeros when `holder` does not hold `n`.
    function quoteTakeOut(address holder, uint256 n)
        external
        view
        returns (uint256 cashNow, uint256 note, uint256 arrivingLeftBehind)
    {
        uint256 b = shares.totalSupply();
        if (n == 0 || n > shares.balanceOf(holder)) return (0, 0, 0);
        Snap memory s = _settled();
        uint256 g = team.totalSupply();
        cashNow = PotMath.cash(n, s.pot, paidIn, b, g);
        arrivingLeftBehind = PotMath.cash(n, s.pot + s.arriving, paidIn, b, g) - cashNow;
        if (cashNow != 0) note = tasks.spreadSum(_noteFull(false, n, cashNow, s.pot, s.stay, b, g), s.stay);
    }

    /// @notice Take out `n` of your own Team Shares: only what is in the pot above what backers put in is shared with
    /// them, so a backer's money is never reachable this way. Only Shares already in your hands (vested and claimed).
    /// @param n Team Shares to hand back.
    /// @param minCash The least cash you accept.
    /// @param to Who gets the cash.
    function leaveTeam(uint256 n, uint256 minCash, address to) external nonReentrant returns (uint256 cash) {
        _settle();
        uint256 g = team.totalSupply();
        if (n == 0 || n > g) revert BadInput();
        uint256 b = shares.totalSupply();
        cash = PotMath.teamCash(n, pot, paidIn, b, g);
        if (cash == 0) revert NothingToPay();
        if (cash < minCash) revert TooLittleCash(minCash, cash);
        uint256 note = _noteFull(true, n, cash, pot, locked, b, g);
        pot -= cash;
        team.burnFor(msg.sender, n);
        note = _giveNotes(msg.sender, note);
        _pay(to, cash);
        emit TeamLeft(msg.sender, to, n, cash, note, pot, g - n);
    }

    /// @notice What `n` backer Shares would get in cash right now, per 1e18 (one whole Share), on the settled pot.
    function leaveValue() external view returns (uint256) {
        uint256 b = shares.totalSupply();
        if (b == 0) return 0;
        return PotMath.cash(1e18, _settled().pot, paidIn, b, team.totalSupply());
    }

    /// @notice What one whole Team Share would get in cash right now.
    function teamValue() external view returns (uint256) {
        uint256 g = team.totalSupply();
        if (g == 0) return 0;
        return PotMath.teamCash(1e18, _settled().pot, paidIn, shares.totalSupply(), g);
    }

    // ============================================== allowance and the clock ==========================================

    /// @notice Work out the allowance, the box cap and the arriving release up to now. Anyone may call it; every action
    /// does it first.
    function settle() external nonReentrant {
        _settle();
    }

    /// @notice The end of the active window right now: the last check-in plus 2 time units, or zero once wound down.
    function activeEnd() public view returns (uint256) {
        if (windDownKind != 0) return 0;
        return uint256(lastCheckIn) + CHECK_IN_MULT * unit;
    }

    /// @notice Active seconds so far, counting the slice since the last settle. The Vester's vesting clock.
    function activeNow() external view returns (uint256) {
        return _settled().active;
    }

    /// @notice True when a join would be accepted this second: the founder's switch is on and the last check-in is under 2
    /// time units old. A wound-down project has no active end (`activeEnd` is zero), so its door is shut too.
    function doorOpenNow() public view returns (bool) {
        return doorFlag && block.timestamp < activeEnd();
    }

    /// @notice The most the box can hold: 7 days of accrual on the money in the pot and the box together, as of the next settle.
    function boxCap() external view returns (uint256) {
        Snap memory s = _settled();
        return Math.mulDiv(s.pot + s.box, uint256(ratePpm) * 7, PPM);
    }

    /// @notice Dollars held that no bucket accounts for: a donation, or money about to be joined.
    function unaccounted() public view returns (uint256) {
        uint256 held = quote.balanceOf(address(this));
        uint256 accounted = pot + box + arriving + feesOwed + locked + notesOwed;
        return held > accounted ? held - accounted : 0;
    }

    /// @notice The runner's weekly check-in with the hash of the signed record. The runner, or a Pair through either signer.
    /// Settles FIRST, so the time counted is only the time inside the old window: a project that lapsed 60 days and then
    /// checks in gets nothing for the lapse.
    function checkIn(bytes32 recordHash) external nonReentrant {
        if (msg.sender != runner) revert NotAllowed();
        if (windDownKind != 0) revert AlreadyWoundDown();
        _settle();
        lastCheckIn = uint64(block.timestamp);
        emit CheckedIn(msg.sender, recordHash, uint64(block.timestamp));
    }

    /// @notice Send `amount` dollars out of the box. The runner (with a Pair: both signers), or an agent inside its own daily
    /// dollar limit. Agents draw from the same box: they never add to the allowance.
    function draw(address to, uint256 amount) external nonReentrant {
        bool byAgent = msg.sender != runner;
        Agent memory a;
        if (byAgent) a = _liveAgent(msg.sender);
        else if (!_isRunnerBothSigned()) revert NotAllowed();
        _settle();
        _notPaused();
        if (
            to == address(0) || to == address(this) || to == address(quote) || to == address(shares)
                || to == address(team) || to == vester
        ) {
            revert BadInput();
        }
        if (amount == 0) revert BadInput();
        if (amount > box) revert TooMuch(amount, box);
        if (byAgent) _agentUsdRing[msg.sender].consume(unit / 7, DAY_PARTS, a.usdCap, amount);
        box -= amount;
        _pay(to, amount);
        emit AllowanceDrawn(msg.sender, to, amount, box);
    }

    /// @notice Propose a higher allowance rate. It waits one time unit before anyone may apply it, and a new proposal
    /// restarts the wait.
    function proposeRate(uint32 ppm) external nonReentrant onlyRunner {
        if (windDownKind != 0) revert AlreadyWoundDown();
        _settle();
        if (ppm <= ratePpm || ppm > MAX_RATE_PPM) revert BadInput();
        (pendingRatePpm, pendingAt) = (ppm, uint64(block.timestamp));
        emit RateProposed(ppm, uint64(block.timestamp) + unit);
    }

    /// @notice Apply the proposed rate once a time unit has passed. Anyone. Settles FIRST at the old rate.
    function applyRate() external nonReentrant {
        if (windDownKind != 0) revert AlreadyWoundDown();
        _settle();
        uint64 proposedAt = pendingAt;
        if (proposedAt == 0) revert BadInput();
        if (block.timestamp < uint256(proposedAt) + unit) revert NotYet(uint256(proposedAt) + unit);
        uint32 previous = ratePpm;
        ratePpm = pendingRatePpm;
        (pendingRatePpm, pendingAt) = (0, 0);
        emit RateSet(ratePpm, previous, true);
    }

    /// @notice Lower the allowance rate, at once. Clears a pending raise. Settles FIRST at the old rate.
    function setRate(uint32 ppm) external nonReentrant onlyRunner {
        if (windDownKind != 0) revert AlreadyWoundDown();
        _settle();
        uint32 previous = ratePpm;
        if (ppm >= previous) revert BadInput();
        ratePpm = ppm;
        (pendingRatePpm, pendingAt) = (0, 0);
        emit RateSet(ppm, previous, false);
    }

    /// @notice Open or shut the door to new backers. Closing hurts nobody: leaving is never gated.
    function setDoor(bool open) external onlyRunner {
        doorFlag = open;
        emit DoorSet(open);
    }

    // ================================================ outside money, fees ============================================

    /// @notice Add outside money (approve first). It arrives in the pot evenly over one time unit; a joiner pays it at face,
    /// a leaver is paid on what has arrived. Anyone, also after a wind-down. Refused while nobody holds any Share or Team
    /// Share (the money would belong to no one and go to the first backer for one dollar), and above `MAX_REVENUE`.
    function addRevenue(uint256 amount) external nonReentrant {
        if (amount < MIN_REVENUE) revert BelowMinimum(MIN_REVENUE, amount);
        if (amount > MAX_REVENUE) revert TooMuch(amount, MAX_REVENUE);
        if (shares.totalSupply() == 0 && team.totalSupply() == 0) revert NoOwner();
        _settle();
        uint256 x = _pull(amount);
        uint256 t = block.timestamp;
        uint256 old = arriving;
        if (old == 0) {
            arrivalEnd = uint64(t + unit);
        } else {
            uint256 rem = uint256(arrivalEnd) - t;
            arrivalEnd = uint64(t + Math.ceilDiv(old * rem + x * unit, old + x));
        }
        // a new stream starts now with what has not arrived yet and `x`; what arrives by any later second is one rounding of one
        // formula, however often `settle` is called in between
        (arrivalStart, arrivalTotal) = (uint64(t), old + x);
        arriving = old + x;
        emit RevenueAdded(msg.sender, x, arriving, arrivalEnd);
    }

    /// @notice Send the platform its owed fees. Anyone.
    function collectFees() external nonReentrant {
        uint256 owed = feesOwed;
        if (owed == 0) revert NothingToPay();
        feesOwed = 0;
        _pay(platform, owed);
        emit FeesCollected(platform, owed);
    }

    // ===================================================== tasks =====================================================

    /// @notice Announce a task: `what` (the hash of the signed task record), who is paid (`payee`, or zero for whoever takes it
    /// first), the most it may cost in dollars and the share of the pot it may ask for, 1 to 500 ten-thousandths (5% a task).
    /// Nothing moves: holders get a notice of 14 days plus 12 hours for every 1% asked (`noticeFor`), then the task can be
    /// taken for one more time unit. Only the runner (with a Pair: both signers); not once the check-in window is closed or
    /// after a wind-down. The payee may not be a signer, a contract of the project or the runner.
    /// @return serial The task's number, never reused.
    function announceTask(bytes32 what, address payee, uint256 maxDollars, uint16 shareBps)
        external
        nonReentrant
        onlyRunner
        returns (uint64 serial)
    {
        _settle();
        _openWindow();
        _notPaused();
        if (
            payee == address(this) || payee == address(quote) || payee == address(shares) || payee == address(team)
                || payee == vester || payee == address(tasks)
        ) {
            revert BadInput();
        }
        if (payee != address(0) && _isTeamSeat(payee)) revert NotAllowed();
        (serial, nextExpiry) = tasks.announce(what, payee, maxDollars, shareBps);
    }

    /// @notice Take a task whose notice is over. Only the named payee, or anyone when the task is open (the first taker is
    /// then the one paid); never the runner or a Pair signer. Only now does money move: the smaller of the stated dollars
    /// and the stated share of the pot as it is this second, out of the pot into the task. A take that would pass 10% of
    /// the pot in any 28 days reverts.
    /// @param serial The task.
    /// @param minAmount The least you accept to have set aside.
    /// @return amount The dollars set aside.
    function takeTask(uint64 serial, uint256 minAmount) external nonReentrant returns (uint256 amount) {
        _settle();
        _openWindow();
        if (_isTeamSeat(msg.sender)) revert NotAllowed();
        uint64 next;
        (amount, next) = tasks.take(serial, msg.sender, pot, minAmount);
        (pot, locked, nextExpiry) = (pot - amount, locked + amount, next);
        _taskMoney(1, serial, msg.sender, amount);
    }

    /// @notice Pay `payDollars` of a taken task's money to whoever took it, and nobody else. A part payment pays the worker
    /// first and what is left comes back at one ratio to the pot and to the exit notes. Only the runner (with a Pair: both
    /// signers), and not when the taker has since become a signer.
    function acceptTask(uint64 serial, uint256 payDollars) external nonReentrant onlyRunner {
        _settle();
        ITaskBook.Resolved memory r = tasks.accept(serial, payDollars);
        if (_isTeamSeat(r.to)) revert NotAllowed();
        _book(2, serial, r);
        _pay(r.to, r.pay);
    }

    /// @notice Send a taken task's money back at once: nothing is paid. Only the runner (with a Pair: both signers).
    function rejectTask(uint64 serial) external nonReentrant onlyRunner {
        _settle();
        _book(3, serial, tasks.reject(serial));
    }

    /// @notice Withdraw a task nobody has taken. Only the runner (with a Pair: both signers).
    function cancelTask(uint64 serial) external nonReentrant onlyRunner {
        _settle();
        nextExpiry = tasks.cancel(serial);
    }

    /// @notice Make sure a task that ran out is back. Anyone. Every action settles first and that already returns a task
    /// whose time is up, so this is only a named call for a keeper and the app; it reverts while the task is still open.
    function returnTask(uint64 serial) external nonReentrant {
        _settle();
        tasks.requireReturned(serial);
    }

    /// @notice Settle `holder`'s exit note against task `serial`, once the task has ended with money returned: the holder is
    /// paid their share of what came back for notes, at the same ratio as the stayers' share. Anyone may call; the money goes
    /// to `holder` only. A task that was paid in full has no claimable note (the worker was paid the notes' money). Settles
    /// first, so a task that has run out is returned in the same call.
    /// @return paid The dollars sent to `holder`.
    function claimNote(uint64 serial, address holder) external nonReentrant returns (uint256 paid) {
        _settle();
        uint256 dust;
        (paid, dust) = tasks.claim(serial, holder);
        notesOwed -= paid + dust;
        pot += dust;
        _taskMoney(6, serial, holder, paid);
        if (paid != 0) _pay(holder, paid);
    }

    /// @notice The notice a task of `shareBps` gets, the time it can then be taken, and how long after the take it is due.
    function noticeFor(uint16 shareBps)
        external
        view
        returns (uint256 noticeSecs, uint256 takeWindowSecs, uint256 dueSecs)
    {
        return tasks.noticeFor(shareBps);
    }

    // ================================================== wind-down ====================================================

    /// @notice Wind the project down, for good. The runner by choice (with a Pair: both signers), or anyone after 26 time
    /// units without a check-in. The box returns to the pot, the door shuts, the allowance and vesting stop; leaving,
    /// outside money and fee collection go on.
    function windDown() external nonReentrant {
        uint8 kind;
        if (msg.sender == runner && _isRunnerBothSigned()) kind = 1;
        else if (block.timestamp >= uint256(lastCheckIn) + WIND_MULT * unit) kind = 2;
        else revert NotAllowed();
        _windDown(kind);
    }

    /// @notice The Launcher's wind-down by choice (it has checked that the caller is the runner).
    function markWoundDown() external nonReentrant {
        if (msg.sender != salePath) revert NotAllowed();
        _windDown(1);
    }

    function _windDown(uint8 kind) private {
        if (windDownKind != 0) revert AlreadyWoundDown();
        _settle();
        uint256 returned = box;
        pot += returned;
        box = 0;
        (windDownKind, windDownAt) = (kind, uint64(block.timestamp));
        emit WoundDown(kind, msg.sender, uint64(block.timestamp), returned);
        // open tasks are ended: announced ones cancelled, taken ones return their money (design 2.6)
        uint256 back = tasks.sweepAll();
        nextExpiry = 0;
        if (back != 0) {
            (locked, pot) = (locked - back, pot + back);
            _taskMoney(4, 0, address(0), back);
        }
    }

    // ============================================== Team Share burn hooks ============================================

    /// @notice The Vester announces that `amount` Team Shares will burn: joiners are priced as if they were gone already.
    /// Only the Vester.
    function forfeitAnnounced(uint256 amount) external nonReentrant onlyVester {
        _settle();
        uint256 z = Z + amount;
        if (z > team.totalSupply()) revert BadInput();
        Z = z;
        emit BurnAnnounced(amount, z);
    }

    /// @notice The Vester burns `amount` announced Team Shares it holds. Only the Vester.
    function forfeitBurn(uint256 amount) external nonReentrant onlyVester {
        _settle();
        if (amount > Z) revert BadInput();
        Z -= amount;
        team.burnFor(msg.sender, amount);
    }

    /// @notice The Vester burns `amount` Team Shares it holds that were never announced, after a wind-down. Only the Vester.
    function burnAfterWindDown(uint256 amount) external nonReentrant onlyVester {
        if (windDownKind == 0) revert NotAllowed();
        _settle();
        team.burnFor(msg.sender, amount);
    }

    // ============================================== Team Share grants ================================================

    /// @notice Grant `amount` Team Shares from the pool to `member`, on a clock of their own (see the Vester). The runner
    /// (with a Pair: both signers), or an agent inside its daily Team Share limit (1/1000 of the pool). The grants of one
    /// project can never pass the pool set at birth. Not after a wind-down.
    /// @return id The grant's id in the Vester.
    function grantTeam(address member, uint256 amount) external nonReentrant returns (uint256 id) {
        if (windDownKind != 0) revert AlreadyWoundDown();
        if (
            member == address(0) || member == address(this) || member == vester || member == address(team)
                || member == address(shares) || member == address(quote)
        ) {
            revert BadInput();
        }
        if (msg.sender == runner) {
            if (!_isRunnerBothSigned()) revert NotAllowed();
        } else {
            Agent memory a = _liveAgent(msg.sender);
            _agentTeamRing[msg.sender].consume(unit / 7, DAY_PARTS, a.shareCap, amount);
        }
        id = IVester(vester).grant(member, amount, false);
    }

    /// @notice Announce the forfeit of grant `id` without the member's say: only both signers of a Pair runner. A single
    /// runner, an agent or a stranger cannot (a member can always announce their own exit in the Vester). The unvested
    /// part is announced to burn and burns after one time unit.
    /// @dev Not `nonReentrant`: the Vester calls back into `forfeitAnnounced`. It changes no state of its own.
    function announceForfeit(uint256 id) external {
        if (!_isRunnerBothSigned() || !ILauncherPairs(salePath).isPair(msg.sender)) revert NotAllowed();
        IVester(vester).announceByRunner(id);
    }

    // ===================================================== agents ====================================================

    /// @notice Let an account act as an agent with chosen daily limits, or change them: `usdCap` dollar units a day out of
    /// the box, `shareCap` Team Share wei a day granted. Only the runner (with a Pair: both signers). What the agent
    /// already used still counts, so switching an agent off and on again does not reset its limit. An agent works only
    /// under the runner that set it: a hand-over switches every agent off.
    function setAgent(address agent, uint128 usdCap, uint128 shareCap) public onlyRunner {
        if (agent == address(0)) revert BadInput();
        agents[agent] = Agent({active: true, usdCap: usdCap, shareCap: shareCap});
        agentEpochOf[agent] = agentEpoch;
        emit AgentSet(agent, true, usdCap, shareCap);
    }

    /// @notice Let an account act as an agent with the default daily limits (the platform's dollars, 1/1000 of the pool).
    function authoriseAgent(address agent) external {
        setAgent(agent, agentUsd, agentTeam);
    }

    /// @notice Switch an agent off. Only the runner (with a Pair: both signers).
    function revokeAgent(address agent) external onlyRunner {
        Agent storage a = agents[agent];
        a.active = false;
        emit AgentSet(agent, false, a.usdCap, a.shareCap);
    }

    /// @notice Dollars an agent has drawn inside the current daily limit.
    function agentUsdUsed(address agent) external view returns (uint256) {
        return _agentUsdRing[agent].used(unit / 7, DAY_PARTS);
    }

    /// @notice Team Share wei an agent has granted inside the current daily limit.
    function agentTeamUsed(address agent) external view returns (uint256) {
        return _agentTeamRing[agent].used(unit / 7, DAY_PARTS);
    }

    // ================================================== the seat =====================================================

    /// @notice Offer the runner seat to `next`, for 2 time units. Only the runner (with a Pair: both signers). A new offer
    /// replaces the old one; `next` of zero withdraws it. With `founderLeaves`, taking the seat also trims the founder's
    /// grants as an own exit; only the founder may offer that, in person or through a Pair the Launcher made with the
    /// founder as a signer.
    function handOver(address next, bool founderLeaves) external onlyRunner {
        if (next == runner) revert BadInput();
        if (next == address(0)) {
            (pendingRunner, pendingTrim, pendingSeatAt) = (address(0), false, 0);
        } else {
            if (founderLeaves && !_founderAgrees()) revert NotAllowed();
            (pendingRunner, pendingTrim, pendingSeatAt) = (next, founderLeaves, uint64(block.timestamp));
        }
        emit SeatOffered(msg.sender, next, founderLeaves);
    }

    /// @notice Take the runner seat that was offered to the caller, within 2 time units of the offer. Agents set by earlier
    /// runners stop working.
    function takeSeat() external {
        if (msg.sender != pendingRunner || msg.sender == address(0)) revert NotAllowed();
        if (block.timestamp > uint256(pendingSeatAt) + SEAT_OFFER_MULT * unit) revert OfferExpired();
        bool trim = pendingTrim;
        address from = runner;
        (runner, pendingRunner, pendingTrim, pendingSeatAt) = (msg.sender, address(0), false, 0);
        ++agentEpoch;
        emit RunnerChanged(from, msg.sender);
        if (trim) IVester(vester).exitAll(founder);
    }

    // =================================================== plumbing ====================================================

    /// @dev Refuses while the holders' pause is on. Fails closed: a gate that reverts stops the call (and, because a join
    /// calls `poke`, joins), never leaving.
    function _notPaused() private view {
        address g = pauseGate;
        if (g != address(0) && IHolderPause(g).paused()) revert Paused();
    }

    function _gate(uint256 amount) private view {
        if (!doorOpenNow()) revert DoorShut();
        if (amount < MIN_JOIN) revert BelowMinimum(MIN_JOIN, amount);
    }

    /// @dev The price and the numbers of a join of `a` dollars on the settled state `s`. Used by quotes and by the join.
    function _price(Snap memory s, uint256 a) private view returns (uint256 fee, uint256 m, uint256 n, uint256 credit) {
        fee = PotMath.fee(a, feeBps);
        if (fee >= a) return (fee, 0, 0, 0);
        m = a - fee;
        uint256 b = shares.totalSupply();
        uint256 ge = team.totalSupply() - Z;
        // outside money still arriving and money set aside for taken tasks both count at face, so a joiner pays for work
        // already funded and what comes back is no windfall to them
        (uint256 num, uint256 den) = PotMath.quote(s.pot, s.arriving + s.stay, paidIn, b, ge);
        n = PotMath.sharesFor(m, num, den);
        credit = PotMath.credit(m, n, paidIn, b, s.pot, s.arriving + s.stay, ge);
    }

    function _join(address payer, uint256 a, uint256 minShares, address to) private returns (uint256 n) {
        Snap memory s = Snap(pot, box, arriving, 0, 0, 0, 0, 0, locked, 0); // settled just before by the caller
        (uint256 fee, uint256 m, uint256 n_, uint256 credit) = _price(s, a);
        n = n_;
        if (m == 0 || n == 0) revert ZeroMint();
        if (n < minShares) revert TooFewShares(minShares, n);
        uint256 b = shares.totalSupply();
        if (b + n > MAX_SHARES) revert TooManyShares();
        feesOwed += fee;
        pot += m;
        paidIn += credit;
        shares.mint(to, n);
        emit Joined(payer, to, a, fee, n, credit, pot, paidIn, b + n);
        // the one place backer Shares are minted: tell the pause to look, so a join that lowers the parked share is seen
        if (pauseGate != address(0)) IHolderPause(pauseGate).poke();
    }

    /// @dev Work out the allowance, the box cap and the arriving release up to now, without writing.
    function _settled() private view returns (Snap memory s) {
        uint256 t = block.timestamp;
        uint256 last = lastSettle;
        s.pot = pot;
        s.box = box;
        s.arriving = arriving;
        uint256 end = activeEnd();
        uint256 upto = t < end ? t : end;
        if (upto > last) s.dt = upto - last;
        uint256 rate = ratePpm;
        // The cap is seven days of accrual on the money in the pot and the box together. That total does not change when
        // money moves between the two, so a second settle in the same second moves nothing.
        uint256 cap = Math.mulDiv(s.pot + s.box, rate * 7, PPM);
        if (s.dt != 0 && rate != 0) {
            // at most 2.8% of the pot: dt is under two time units and the rate under 0.20% a day
            s.toBox = Math.mulDiv(s.pot, rate * s.dt, PPM * (unit / 7));
            s.box += s.toBox;
            s.pot -= s.toBox;
        }
        if (s.box > cap) {
            s.back = s.box - cap;
            s.box = cap;
            s.pot += s.back;
        }
        if (s.arriving != 0) {
            // what has arrived by now is one rounding of one formula on the stream's own start, so calling settle often cannot
            // hold money back
            uint256 until = arrivalEnd;
            uint256 total = arrivalTotal;
            uint256 target = t >= until ? total : Math.mulDiv(total, t - arrivalStart, until - arrivalStart);
            uint256 done = total - s.arriving;
            s.released = target > done ? target - done : 0;
            s.arriving -= s.released;
            s.pot += s.released;
        }
        s.active = activeSeconds + s.dt;
        // tasks that have run out come back LAST: the returned money is not charged allowance for time it was not in the pot
        s.stay = locked;
        uint256 nx = nextExpiry;
        if (nx != 0 && t >= nx) {
            s.expC = tasks.dueC(t);
            s.stay -= s.expC;
            s.pot += s.expC;
        }
    }

    function _settle() private {
        Snap memory s = _settled();
        (pot, box, arriving, activeSeconds, lastSettle) = (s.pot, s.box, s.arriving, s.active, uint64(block.timestamp));
        if (s.dt != 0 || s.toBox != 0 || s.back != 0 || s.released != 0 || s.expC != 0) {
            emit Settled(s.toBox, s.back, s.released, s.pot, s.box, s.arriving, s.active, uint64(block.timestamp));
            if (s.released != 0) emit RevenueReleased(s.released, s.arriving);
        }
        if (nextExpiry != 0 && block.timestamp >= nextExpiry) {
            (uint256 sumC, uint64 next) = tasks.expireDue();
            if (sumC != s.expC) revert Inconsistent();
            (locked, nextExpiry) = (s.stay, next);
            if (sumC != 0) _taskMoney(4, 0, address(0), sumC);
        }
    }

    /// @dev True when the caller is the runner and, if the runner is a Pair the Launcher made, that Pair is executing a
    /// proposal both signers agreed to.
    function _isRunnerBothSigned() private view returns (bool) {
        address r = runner;
        if (msg.sender != r) return false;
        if (!ILauncherPairs(salePath).isPair(r)) return true;
        return IPair(r).bothSigned();
    }

    /// @dev New tasks need an open check-in window and a project that is not wound down.
    function _openWindow() private view {
        if (windDownKind != 0) revert AlreadyWoundDown();
        if (block.timestamp >= activeEnd()) revert ProjectQuiet();
    }

    /// @dev The runner or, when the runner is a Pair the Launcher made, one of its two signers.
    function _isTeamSeat(address a) private view returns (bool) {
        address r = runner;
        if (a == r) return true;
        if (!ILauncherPairs(salePath).isPair(r)) return false;
        return IPairSigners(r).first() == a || IPairSigners(r).second() == a;
    }

    /// @dev Book the end of a task: its stayers' claim leaves `locked`, its notes' face leaves `notesOwed` and what is still
    /// owed to them stays there, and the rest of what came back goes to the pot. The payment, if any, is made by the caller.
    function _book(uint8 kind, uint64 serial, ITaskBook.Resolved memory r) private {
        locked -= r.c;
        notesOwed = notesOwed - r.n + r.np;
        pot += r.pp;
        nextExpiry = r.next;
        _taskMoney(kind, serial, r.to, kind == 2 ? r.pay : r.pp);
    }

    /// @dev The face of the exit note a leaver of `n` Shares is owed while `lk` dollars sit set aside for taken tasks: what
    /// they would be paid with that money back in the pot, less the cash they are paid now, never more than `lk`. `cashNow`
    /// is their cash on `p`. All numbers are the state before the leave. Team Shares use the Team formula.
    function _noteFull(bool isTeam, uint256 n, uint256 cashNow, uint256 p, uint256 lk, uint256 b, uint256 g)
        private
        view
        returns (uint256)
    {
        if (lk == 0) return 0;
        uint256 withLocked = isTeam ? PotMath.teamCash(n, p + lk, paidIn, b, g) : PotMath.cash(n, p + lk, paidIn, b, g);
        return Math.min(withLocked - cashNow, lk);
    }

    /// @dev Write `note` dollars of the stayers' claim down as exit notes of `who` (the book spreads them over the taken tasks
    /// and reports what it wrote; the few units its floors leave stay with the stayers). Moves the dollars from `locked` to
    /// `notesOwed` and returns what was written.
    function _giveNotes(address who, uint256 note) private returns (uint256 minted) {
        if (note == 0) return 0;
        minted = tasks.mintNotes(who, note, locked);
        if (minted == 0) return 0;
        (locked, notesOwed) = (locked - minted, notesOwed + minted);
        _taskMoney(5, 0, who, minted);
    }

    /// @dev Say that `amount` moved between the pot and the money set aside, with the three buckets as they now stand.
    function _taskMoney(uint8 kind, uint64 serial, address who, uint256 amount) private {
        emit TaskMoney(kind, serial, who, amount, pot, locked, notesOwed);
    }

    /// @dev An agent the current runner switched on and has not switched off since a hand-over.
    function _liveAgent(address who) private view returns (Agent memory a) {
        a = agents[who];
        if (!a.active || agentEpochOf[who] != agentEpoch) revert NotAllowed();
    }

    function _founderAgrees() private view returns (bool) {
        if (msg.sender == founder) return true;
        if (!ILauncherPairs(salePath).isPair(msg.sender)) return false;
        return IPairSigners(msg.sender).first() == founder || IPairSigners(msg.sender).second() == founder;
    }

    /// @dev Pull dollars from the caller and return what actually arrived (a token that keeps a fee delivers less).
    function _pull(uint256 amount) private returns (uint256 got) {
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), amount);
        got = quote.balanceOf(address(this)) - before;
        if (got == 0) revert TokenMisbehaved();
        if (got > amount) got = amount;
    }

    /// @dev Send dollars out and insist that exactly that much left the balance, so a token that charges the sender a fee
    /// cannot make the buckets add up to more than the balance.
    function _pay(address to, uint256 amount) private {
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransfer(to, amount);
        uint256 afterBal = quote.balanceOf(address(this));
        if (afterBal > before || before - afterBal != amount) revert TokenMisbehaved();
    }
}
