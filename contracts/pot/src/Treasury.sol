// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {IERC1363Receiver} from "oz5/interfaces/IERC1363Receiver.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {Math} from "oz5/utils/math/Math.sol";
import {IShares, IVester, ILauncherPairs, IPairSigners, IPair} from "./Interfaces.sol";
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
///  - `locked` and `notesOwed`: reserved for step 2 (tasks), always zero now.
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
    /// @notice Reserved for step 2 (money locked for a taken task). Always zero now; counted in `unaccounted()`.
    uint256 public locked;
    /// @notice Reserved for step 2 (exit notes owed). Always zero now; counted in `unaccounted()`.
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
    uint256 public agentEpoch;
    mapping(address => uint256) public agentEpochOf;
    mapping(address => Agent) public agents;
    mapping(address => RollingCap.Ring) private _agentUsdRing;
    mapping(address => RollingCap.Ring) private _agentTeamRing;

    // Step 2 appends its fields (task counter, open count, takes, the task mapping, the note mapping) after this line.

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
    /// @notice A holder took money out. `note` is zero until step 2.
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
    /// @notice A Team Share holder took money out. `note` is zero until step 2.
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
        ) revert BadSetup();
        (quote, shares, team, vester) = (s.quote, s.shares, s.team, s.vester);
        (founder, platform, salePath, runner) = (s.founder, s.platform, s.salePath, s.founder);
        (unit, feeBps, ratePpm, agentUsd, agentTeam) = (s.unit, s.feeBps, s.ratePpm, s.agentUsd, s.agentTeam);
        (lastSettle, lastCheckIn, doorFlag) = (uint64(block.timestamp), uint64(block.timestamp), true);
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
    /// them out at once would give, money set aside for tasks (always zero until step 2), and outside money still arriving.
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
        lockedLine = locked;
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
        cash = PotMath.cash(n, pot, paidIn, b, team.totalSupply());
        if (cash == 0) revert NothingToPay();
        if (cash < minCash) revert TooLittleCash(minCash, cash);
        paidIn -= PotMath.paidInCut(paidIn, n, b);
        pot -= cash;
        shares.burnFor(msg.sender, n);
        _pay(to, cash);
        emit Left(msg.sender, to, n, cash, 0, pot, paidIn, b - n);
    }

    /// @notice What taking out `n` Shares of `holder` would give right now: the cash, a note (always zero until step 2), and
    /// how much of the outside money still arriving would be left behind for those who stay. Zeros when `holder` does not
    /// hold `n`.
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
        cash = PotMath.teamCash(n, pot, paidIn, shares.totalSupply(), g);
        if (cash == 0) revert NothingToPay();
        if (cash < minCash) revert TooLittleCash(minCash, cash);
        pot -= cash;
        team.burnFor(msg.sender, n);
        _pay(to, cash);
        emit TeamLeft(msg.sender, to, n, cash, 0, pot, g - n);
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

    /// @notice True when a join would be accepted this second: the founder's switch is on, the project is not wound down,
    /// and the last check-in is under 2 time units old.
    function doorOpenNow() public view returns (bool) {
        return doorFlag && windDownKind == 0 && block.timestamp < activeEnd();
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
    /// a leaver is paid on what has arrived. Anyone, also after a wind-down.
    function addRevenue(uint256 amount) external nonReentrant {
        if (amount < MIN_REVENUE) revert BelowMinimum(MIN_REVENUE, amount);
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

    /// @notice Offer the runner seat to `next`. Only the runner (with a Pair: both signers). With `founderLeaves`, taking the
    /// seat also trims the founder's grants as an own exit; only the founder may offer that, in person or through a Pair
    /// the Launcher made with the founder as a signer.
    function handOver(address next, bool founderLeaves) external onlyRunner {
        if (next == address(0) || next == runner) revert BadInput();
        if (founderLeaves && !_founderAgrees()) revert NotAllowed();
        (pendingRunner, pendingTrim) = (next, founderLeaves);
        emit SeatOffered(msg.sender, next, founderLeaves);
    }

    /// @notice Take the runner seat that was offered to the caller. Agents set by earlier runners stop working.
    function takeSeat() external {
        if (msg.sender != pendingRunner || msg.sender == address(0)) revert NotAllowed();
        bool trim = pendingTrim;
        address from = runner;
        (runner, pendingRunner, pendingTrim) = (msg.sender, address(0), false);
        ++agentEpoch;
        emit RunnerChanged(from, msg.sender);
        if (trim) IVester(vester).exitAll(founder);
    }

    // =================================================== plumbing ====================================================

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
        (uint256 num, uint256 den) = PotMath.quote(s.pot, s.arriving, paidIn, b, ge);
        n = PotMath.sharesFor(m, num, den);
        credit = PotMath.credit(m, n, paidIn, b, s.pot, s.arriving, ge);
    }

    function _join(address payer, uint256 a, uint256 minShares, address to) private returns (uint256 n) {
        Snap memory s = Snap(pot, box, arriving, 0, 0, 0, 0, 0); // settled just before by the caller
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
            uint256 until = arrivalEnd;
            s.released = t >= until ? s.arriving : Math.mulDiv(s.arriving, t - last, until - last);
            s.arriving -= s.released;
            s.pot += s.released;
        }
        s.active = activeSeconds + s.dt;
    }

    function _settle() private {
        Snap memory s = _settled();
        (pot, box, arriving, activeSeconds, lastSettle) = (s.pot, s.box, s.arriving, s.active, uint64(block.timestamp));
        if (s.dt != 0 || s.toBox != 0 || s.back != 0 || s.released != 0) {
            emit Settled(s.toBox, s.back, s.released, s.pot, s.box, s.arriving, s.active, uint64(block.timestamp));
            if (s.released != 0) emit RevenueReleased(s.released, s.arriving);
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
