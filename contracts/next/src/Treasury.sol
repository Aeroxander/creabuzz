// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {
    IShares,
    IVester,
    IRounds,
    ILauncherPairs,
    IPairSigners,
    IEarlierBackers,
    MAX_SPLIT_PART
} from "./Interfaces.sol";
import {RollingCap} from "./RollingCap.sol";

/// @title Treasury
/// @notice One project's money and Shares. It holds the dollars in four buckets and the project's work pot and reserve
/// of Shares, and it is the only place a holder can hand Shares back.
///
/// Dollars (the "quote token", any standard 6-decimal ERC-20) sit in four buckets that always add up to no more than
/// the balance:
///  - `spendable`: the runner (and agents inside daily limits) may send it anywhere;
///  - `melting`: the melting floor, 60 of every 75 settled from the auction and 82 of every 97 from a reserve sale; it moves
///    to `spendable` evenly over 365 active days;
///  - `permanentFloor`: money added as "Share revenue"; it never melts and is shared by every Share that exists;
///  - `feesOwed`: the platform's cut of exits, waiting to be swept (so a blocked platform address cannot block exits).
///
/// The runner is an address: the founder at birth, later a Pair (two signers), later a Council. Only the runner checks in,
/// spends, gives Shares and sets agents, and only the runner can hand the seat on (the next runner takes it in a second
/// transaction). Backing-round money is held by the project's Rounds, not here; the Rounds release it into `spendable` on
/// the same check-in window as the melting floor.
///
/// Nobody, the runner included, can move floor money anywhere except to an exiting holder or, through the daily
/// release, into `spendable`. Anything sent to this contract outside the functions below is never counted as money of
/// any bucket and never reaches anyone (it is a donation).
///
/// The quote token is chosen by the platform (one per network, a Launcher setting), never by a founder. The design
/// assumes it is a standard ERC-20 that may revert, return false, charge a fee on transfer or call back into the
/// sender or receiver; it does not assume it is honest about anything else. See the report for why that is enough.
/// @dev One copy per project, a minimal clone created and initialised by the Launcher in one transaction.
contract Treasury {
    using SafeERC20 for IERC20;
    using RollingCap for RollingCap.Ring;

    /// @notice Everything fixed at birth. The Launcher copies its settings here, so a later change of the Launcher's
    /// settings cannot reach a project that already exists.
    struct Setup {
        IERC20 quote; // the dollar token
        IShares shares; // the project's ShareToken
        IVester vester; // the project's Vester
        address rounds; // the project's Rounds (backing rounds); told before the active window changes
        address founder; // the person who started the project, and its first runner
        address platform; // receives the platform's part of exit fees
        address opener; // the project's Finisher: the only address that may say the pool is open, the sale closed, or abandoned
        address salePath; // the Launcher: reserve sales, "no market", wind down and the pauser
        address stake; // receives Creaton's stake as held Shares when the market opens
        uint256 stakeAmount; // the stake: 20,000,000 Shares from the reserve
        uint16 exitFeeBps; // total exit fee, in ten-thousandths
        uint16 platformFeeBps; // the part of the exit fee that goes to the platform
        uint16 spendableParts; // settle: parts of fresh money that go to `spendable` (15)
        uint16 floorParts; // settle: parts of fresh money that go to the melting floor (60)
        uint128 agentUsd; // default daily dollar limit of an agent
        uint128 agentShares; // default daily Share limit of an agent
        uint256 workPot; // Shares the founder may give for work (the rest of the Shares held here are the reserve)
        address earlier; // project zero's earlier backers' claim contract; zero for every other project
        uint256 teamBudget; // project zero's founder slice, paid out over time with `payTeam`; zero for every other project
    }

    /// @notice What an agent account may do, and its daily limits.
    struct Agent {
        bool active;
        uint128 usdCap;
        uint128 shareCap;
    }

    /// @notice Length of the melting floor's release, counted in active seconds.
    uint256 public constant RELEASE_PERIOD = 365 days;
    /// @notice How long after a check-in the daily release keeps accruing.
    uint256 public constant CHECK_IN_WINDOW = 14 days;
    /// @notice Gifts after the pool opens: at most this many ten-thousandths of the Shares in people's hands
    /// (`countingSupply`) in any 30 days.
    uint256 public constant GIFT_CAP_BPS = 100;
    /// @notice A reserve sale's money (after the platform's 3): 15 parts spendable, 82 parts melting floor.
    uint256 public constant RESERVE_SPENDABLE_PARTS = 15;
    /// @notice See `RESERVE_SPENDABLE_PARTS`.
    uint256 public constant RESERVE_FLOOR_PARTS = 82;
    /// @notice Project zero's team budget accrues evenly over this long from the launch: `payTeam` never pays more than
    /// the part accrued so far (paid in arrears, like monthly pay; catching up is always allowed).
    uint256 public constant TEAM_PAY_SPAN = 730 days;
    uint256 private constant BPS = 10_000;
    uint256 private constant DAY = 1 days;
    uint256 private constant DAY_PARTS = 6; // an agent's used amount counts for 24 to 28 hours
    uint256 private constant MONTH = 30 days;
    uint256 private constant MONTH_PARTS = 10; // a gift counts for 30 to 33 days

    // ---- fixed at birth
    IERC20 public quote;
    IShares public shares;
    IVester public vester;
    IRounds public rounds;
    address public founder;
    address public platform;
    address public opener;
    address public salePath;
    address public stake;
    uint256 public stakeAmount;
    /// @notice Project zero's earlier backers' claim contract (`EarlierBackers`); zero for every other project. Shares it has
    /// released but not delivered are not in anyone's hands (`countingSupply`).
    address public earlier;
    uint16 public exitFeeBps;
    uint16 public platformFeeBps;
    uint16 public spendableParts;
    uint16 public floorParts;
    uint128 public defaultAgentUsd;
    uint128 public defaultAgentShares;

    // ---- the four dollar buckets
    uint256 public spendable;
    uint256 public melting;
    uint256 public permanentFloor;
    uint256 public feesOwed;

    // ---- the melting floor's clock
    uint256 public meltRemaining; // active seconds left before `melting` is fully released
    uint256 public accruedUpTo; // time up to which the release has been worked out (0 before the first settle)
    uint256 public lastCheckIn; // the window of active time runs to this plus CHECK_IN_WINDOW

    // ---- state of the project
    bool public poolOpen; // the sale phase is over and the Vester's clock runs: a pool was proven open, or the sale was abandoned
    bool public abandoned; // the sale was abandoned: no pool was ever made (`poolOpen` is true too)
    bool public settled; // sale money has been split at least once
    bool public saleClosed; // the sale's last finish step is done: unsold Shares are back here
    bool public noMarket; // the project declared "no market": the clock runs, no auction ever opens (`poolOpen` is true too)
    bool public woundDown; // payments stopped for good; the exit fee is the platform's part only
    bool public paused; // the pauser stopped the release (backing rounds and the melting floor) until it says otherwise
    bool public reserveSaleOpen; // reserve Shares are out in a sale: exits wait until it is finished
    uint256 public workPot; // Shares still available for Give Shares
    /// @notice Project zero only: what is left of its team budget (its founder's slice, held here instead of in the Vester),
    /// which the runner pays out over time with `payTeam`, under the same rules as a gift. Zero for every other project.
    uint256 public teamBudget;
    /// @notice Project zero only: the team budget at the launch (what is left plus everything paid from it).
    uint256 public teamBudgetAtLaunch;
    /// @notice When the team budget started to accrue (the launch).
    uint256 public teamPayFrom;

    // ---- who runs the project
    address public runner; // the founder at birth, then whoever the runner hands the seat to
    address public pendingRunner; // the seat was offered to this address; it takes it with `takeSeat`
    bool public pendingTrim; // the hand-over on offer trims the founder's grant (the founder is leaving)
    address public pauser; // may pause the release (set by the Launcher; later the holders' vote)
    uint256 public agentEpoch; // agents set before the last hand-over are switched off
    mapping(address => uint256) public agentEpochOf;

    mapping(address => Agent) public agents;
    mapping(address => RollingCap.Ring) private _agentUsd;
    mapping(address => RollingCap.Ring) private _agentShares;
    RollingCap.Ring private _gifts;
    bool private transient _locked;

    /// @notice Sale money was split. `toSpendable + toFloor == amount`.
    event Settled(uint256 amount, uint256 toSpendable, uint256 toFloor);
    /// @notice The daily release moved melting floor to spendable.
    event Released(uint256 amount);
    /// @notice The runner checked in; the release accrues for 14 days from now.
    event CheckedIn(address indexed by);
    /// @notice Dollars were sent from `spendable`.
    event Spent(address indexed by, address indexed to, uint256 amount);
    /// @notice Shares were given from the work pot (or, with `TeamPaid` beside it, from the team budget); `vested` says they
    /// went to the Vester.
    event SharesGiven(address indexed by, address indexed to, uint256 amount, bool vested);
    /// @notice Project zero's runner paid `amount` Shares of the team budget to `to` (as a gift: `SharesGiven` beside it says
    /// whether they are held); `left` is what remains of the budget.
    event TeamPaid(address indexed to, uint256 amount, uint256 left);
    /// @notice A holder handed Shares back for their slice of the floor. The whole slice left the floor: `paid` to the holder,
    /// `toPlatform` owed to the platform and `toProject` added to `spendable`.
    event HandedBack(address indexed holder, uint256 shares, uint256 paid, uint256 toPlatform, uint256 toProject);
    /// @notice Dollars were added to the permanent floor.
    event ShareRevenue(address indexed from, uint256 amount);
    /// @notice Dollars were added to `spendable`.
    event ToppedUp(address indexed from, uint256 amount);
    /// @notice The platform's owed exit fees were sent.
    event FeesSwept(address indexed to, uint256 amount);
    /// @notice An agent was set, or switched off with `active == false`.
    event AgentSet(address indexed agent, bool active, uint256 usdCap, uint256 shareCap);
    /// @notice The pool was proven open and the Vester's clock started.
    event PoolOpened(uint256 time);
    /// @notice The sale was abandoned: no pool exists, the Vester's clock started, and the money meant for the pool goes to
    /// the floor.
    event SaleAbandoned(uint256 time);
    /// @notice The sale's finish is complete; exits are open from now (once sale money has been split).
    event SaleClosed(uint256 time);
    /// @notice Reserve Shares left through the sale path for a reserve sale; exits wait until it is finished.
    event ReserveReleased(address indexed to, uint256 amount);
    /// @notice The reserve sale finished; exits are open again.
    event ReserveSaleClosed(uint256 time);
    /// @notice A reserve sale's money was split: 15 parts spendable, 82 parts melting floor.
    event ReserveSaleSettled(uint256 amount, uint256 toSpendable, uint256 toFloor);
    /// @notice Creaton's stake was set aside in the Vester as held Shares when the market opened.
    event StakeGranted(address indexed stake, uint256 amount);
    /// @notice The runner offered the seat to `to`; `founderLeaves` trims the founder's grant when it is taken.
    event SeatOffered(address indexed from, address indexed to, bool founderLeaves);
    /// @notice `to` took the runner seat from `from`; `cut` Shares of the founder's grant went back to the work pot.
    event RunnerChanged(address indexed from, address indexed to, uint256 cut);
    /// @notice The address that may pause the release was set.
    event PauserSet(address indexed pauser);
    /// @notice The release was paused (`on`) or resumed.
    event Paused(bool on);
    /// @notice The project wound down: payments stopped for good, the exit fee is the platform's part only.
    event WoundDown(uint256 time);
    /// @notice The project declared "no market": the Vester's clock started and no auction will ever open.
    event NoMarketDeclared(uint256 time);

    /// @notice The clone was already set up, or the setup is not valid.
    error BadSetup();
    /// @notice The caller is not allowed to do this.
    error NotAllowed();
    /// @notice A call came back into the treasury while another was running.
    error Reentrancy();
    /// @notice The amount, or an address, is zero or otherwise not usable.
    error BadInput();
    /// @notice There is no proven pool, so sale money cannot be split.
    error NoPool();
    /// @notice The sale was not abandoned, so this is not allowed.
    error NotAbandoned();
    /// @notice The pool is already proven.
    error PoolAlreadyOpen();
    /// @notice The sale's finish is not complete (unsold Shares may still be outside the treasury), so nothing can be
    /// handed back yet.
    error SaleNotClosed();
    /// @notice The sale's finish was already marked complete.
    error SaleAlreadyClosed();
    /// @notice `amount` is more than the dollars that arrived and are not yet in a bucket.
    error NotArrived(uint256 amount, uint256 arrived);
    /// @notice No sale money has been split yet, so nothing can be handed back.
    error NotSettled();
    /// @notice The amount is more than the bucket holds.
    error TooMuch(uint256 amount, uint256 available);
    /// @notice The hand-back would pay nothing (the amount is too small for the floor).
    error NothingToPay();
    /// @notice The work pot has fewer Shares than asked.
    error WorkPotShort(uint256 amount, uint256 left);
    /// @notice The team budget has fewer Shares than asked.
    error TeamBudgetShort(uint256 amount, uint256 left);
    /// @notice Team pay faster than the budget accrues: only `open` Shares of it may be paid now.
    error TeamPayTooFast(uint256 amount, uint256 open);
    /// @notice The quote token moved a different amount than it was asked to.
    error TokenMisbehaved();
    /// @notice The project wound down already.
    error AlreadyWoundDown();
    /// @notice A reserve sale is open already, or none is.
    error ReserveSaleState();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor() {
        founder = address(1); // locks the implementation the clones point at
    }

    modifier onlyRunner() {
        if (msg.sender != runner) revert NotAllowed();
        _;
    }

    /// @notice Set up the clone, once. The Launcher calls it in the transaction that creates the clone, so nobody can
    /// get in first.
    function initialize(Setup calldata s) external {
        if (founder != address(0)) revert BadSetup();
        if (
            s.founder == address(0) || s.platform == address(0) || s.opener == address(0) || s.salePath == address(0)
                || s.rounds == address(0) || (s.stake == address(0) && s.stakeAmount != 0)
                || address(s.quote) == address(0) || address(s.vester) == address(0) || address(s.shares) == address(0)
                || s.exitFeeBps >= BPS || s.platformFeeBps > s.exitFeeBps || s.spendableParts == 0 || s.floorParts == 0
                || s.spendableParts > MAX_SPLIT_PART || s.floorParts > MAX_SPLIT_PART
                || s.shares.balanceOf(address(this)) < s.workPot + s.teamBudget
        ) revert BadSetup();
        (quote, shares, vester, founder, platform) = (s.quote, s.shares, s.vester, s.founder, s.platform);
        (opener, salePath, workPot, runner) = (s.opener, s.salePath, s.workPot, s.founder);
        (rounds, stake, stakeAmount, earlier, teamBudget) =
            (IRounds(s.rounds), s.stake, s.stakeAmount, s.earlier, s.teamBudget);
        (teamBudgetAtLaunch, teamPayFrom) = (s.teamBudget, block.timestamp);
        (exitFeeBps, platformFeeBps, spendableParts, floorParts) =
            (s.exitFeeBps, s.platformFeeBps, s.spendableParts, s.floorParts);
        (defaultAgentUsd, defaultAgentShares) = (s.agentUsd, s.agentShares);
    }

    // ================================================ money coming in ================================================

    /// @notice Say that the project's pool is proven open, once, and start the Vester's clock. Only the `opener` (the
    /// project's Finisher, which has read the pool at the guarded key) may call it. Creaton's stake (`stakeAmount` Shares, or
    /// the whole reserve if it ever held less) moves from the reserve into the Vester as held Shares in the same call, so it
    /// is on the same clock as everyone and exists only for a project whose market opened.
    function markPoolOpen() external nonReentrant {
        if (msg.sender != opener) revert NotAllowed();
        if (poolOpen) revert PoolAlreadyOpen();
        poolOpen = true;
        uint256 s = stakeAmount;
        uint256 left = reserve();
        if (s > left) s = left;
        if (s != 0) {
            _sendShares(address(vester), s);
            vester.grant(stake, s);
            emit StakeGranted(stake, s);
        }
        vester.startNow();
        emit PoolOpened(block.timestamp);
    }

    /// @notice Declare "no market", once, before any market: the Vester's clock starts (held Shares begin their 365-day
    /// release) and the Launcher never opens an auction for this project again. Only the `salePath` (the Launcher, which
    /// checks who asks and when).
    function markNoMarket() external nonReentrant {
        if (msg.sender != salePath) revert NotAllowed();
        if (poolOpen) revert PoolAlreadyOpen();
        (poolOpen, noMarket) = (true, true);
        vester.startNow();
        emit NoMarketDeclared(block.timestamp);
    }

    /// @notice Say that the sale was abandoned, once: seven days after it ended no pool exists. The Vester's clock starts
    /// (the founder's Shares must not stay locked for ever behind a pool that will never open), the project behaves as
    /// one whose sale phase is over, and the Finisher may then split the money with `settle` and `settleToFloor`. Only the
    /// `opener` may call it.
    function markAbandoned() external nonReentrant {
        if (msg.sender != opener) revert NotAllowed();
        if (poolOpen) revert PoolAlreadyOpen();
        (poolOpen, abandoned) = (true, true);
        vester.startNow();
        emit SaleAbandoned(block.timestamp);
    }

    /// @notice Say that the sale's finish is complete, once: the unsold Shares have been swept back to this treasury, so
    /// every Share outside the treasury and the Vester is in a person's hands. Exits open only after this. Only the `opener`
    /// (the project's Finisher) may call it, once, and only after the pool is proven or the sale abandoned; the Finisher's
    /// sweep is open to anyone, so exits never wait on one person.
    function markSaleClosed() external nonReentrant {
        if (msg.sender != opener) revert NotAllowed();
        if (!poolOpen) revert NoPool();
        if (saleClosed) revert SaleAlreadyClosed();
        saleClosed = true;
        emit SaleClosed(block.timestamp);
    }

    /// @notice Split sale money that has arrived: `spendableParts : floorParts` (15 : 60 of each 75 that reach the
    /// treasury, which is 15 and 60 of each 100 raised; the other 25 are the platform's 3 and the pool's 22, handled
    /// before the money gets here). Anyone may call it. Refused until the pool is proven (or the sale abandoned), and the
    /// Finisher moves the sale money here and proves the pool in one transaction, so no stranger can split a part first.
    /// `amount` is capped by the dollars that arrived and are not in a bucket, so a caller cannot invent money; the ratio
    /// is fixed at birth, so a caller cannot choose it. The first call starts the check-in window.
    /// @dev Several partial calls are fine: each part is split the same way and the floor's release time is blended by
    /// money (`meltRemaining` becomes the money-weighted mean of the old remainder and 365 days).
    function settle(uint256 amount) external nonReentrant {
        if (!poolOpen) revert NoPool();
        if (amount == 0) revert BadInput();
        uint256 arrived = unaccounted();
        if (amount > arrived) revert NotArrived(amount, arrived);
        _accrue();
        uint256 toSpendable = amount * spendableParts / (spendableParts + floorParts);
        uint256 toFloor = amount - toSpendable;
        spendable += toSpendable;
        _addMelting(toFloor);
        emit Settled(amount, toSpendable, toFloor);
    }

    /// @notice Put sale money wholly into the melting floor. Only after an abandoned sale, and only the `opener`: the 22
    /// of every 100 raised that was meant for a pool that never opened goes to the floor (so with the 15 : 60 split of the
    /// rest, 15 spendable : 82 floor of each 100 raised). Capped by the dollars that arrived and are in no bucket.
    function settleToFloor(uint256 amount) external nonReentrant {
        if (msg.sender != opener) revert NotAllowed();
        if (!abandoned) revert NotAbandoned();
        if (amount == 0) revert BadInput();
        uint256 arrived = unaccounted();
        if (amount > arrived) revert NotArrived(amount, arrived);
        _accrue();
        _addMelting(amount);
        emit Settled(amount, 0, amount);
    }

    /// @notice Split a reserve sale's money that has arrived: 15 parts spendable, 82 parts melting floor (the platform's 3 was
    /// taken by the auction). Only the `salePath`, which moves the money here and calls this in one transaction.
    function settleReserveSale(uint256 amount) external nonReentrant {
        if (msg.sender != salePath) revert NotAllowed();
        if (amount == 0) revert BadInput();
        uint256 arrived = unaccounted();
        if (amount > arrived) revert NotArrived(amount, arrived);
        _accrue();
        uint256 toSpendable = amount * RESERVE_SPENDABLE_PARTS / (RESERVE_SPENDABLE_PARTS + RESERVE_FLOOR_PARTS);
        spendable += toSpendable;
        _addMelting(amount - toSpendable);
        emit ReserveSaleSettled(amount, toSpendable, amount - toSpendable);
    }

    /// @dev Add to the melting floor, blending its release time by money, and open the check-in window on the first call.
    /// The Rounds' clock is worked out first, because opening the window changes it.
    function _addMelting(uint256 toFloor) private {
        uint256 m = melting;
        meltRemaining = m == 0 ? RELEASE_PERIOD : (m * meltRemaining + toFloor * RELEASE_PERIOD) / (m + toFloor);
        melting = m + toFloor;
        if (!settled) {
            rounds.sync();
            (settled, accruedUpTo, lastCheckIn) = (true, block.timestamp, block.timestamp);
        }
    }

    /// @notice Add dollars to `spendable` (for example, fees a platform project pays itself).
    function topUp(uint256 amount) external nonReentrant {
        uint256 got = _pull(amount);
        spendable += got;
        emit ToppedUp(msg.sender, got);
    }

    /// @notice Add dollars to the permanent floor ("Share revenue"). It never melts and belongs to holders only through
    /// the exit right, shared by every Share that exists (`handBack` pays `permanentFloor * burned / totalSupply`), so Shares
    /// that enter people's hands later (gifts, releases) never thin the claim of those already holding.
    function shareRevenue(uint256 amount) external nonReentrant {
        uint256 got = _pull(amount);
        permanentFloor += got;
        emit ShareRevenue(msg.sender, got);
    }

    /// @notice Dollars held that no bucket accounts for: sale money not yet settled, or a donation.
    function unaccounted() public view returns (uint256) {
        uint256 held = quote.balanceOf(address(this));
        uint256 accounted = spendable + melting + permanentFloor + feesOwed;
        return held > accounted ? held - accounted : 0;
    }

    // ============================================== the daily release ================================================

    /// @notice Press check-in. Only the runner (a person, or the Pair or Council contract a person signs for); an agent
    /// account may not. The daily release (here and in the backing rounds) then accrues for 14 days. Time that passed
    /// outside a window is never paid back.
    function checkIn() external nonReentrant {
        if (msg.sender != runner) revert NotAllowed();
        _sync();
        lastCheckIn = block.timestamp;
        emit CheckedIn(msg.sender);
    }

    /// @notice The end of the active window right now: the last check-in plus 14 days, or zero while the release is paused
    /// or after the project wound down. The melting floor and the backing rounds count release time only up to it.
    function activeEnd() public view returns (uint256) {
        if (paused || woundDown) return 0;
        return lastCheckIn + CHECK_IN_WINDOW;
    }

    // ============================================ the seam for later stages ==========================================

    /// @notice Offer the runner seat to `next` (a successor, a Pair, a Council). Only the runner. Nothing moves until `next`
    /// calls `takeSeat`. With `founderLeaves`, taking the seat also trims the founder's grant (before a market only): the
    /// founder keeps the days served since launch out of 365 and the rest returns to the work pot. Only the founder may offer
    /// that: as the runner in person, or through a Pair the Launcher made with the founder as one of its two signers (a Pair
    /// hands the seat over only when both agree). A later runner cannot cut the founder's grant. A new offer replaces the last.
    function handOver(address next, bool founderLeaves) external onlyRunner {
        if (next == address(0) || next == runner) revert BadInput();
        if (founderLeaves && !_founderAgrees()) revert NotAllowed();
        (pendingRunner, pendingTrim) = (next, founderLeaves);
        emit SeatOffered(msg.sender, next, founderLeaves);
    }

    /// @notice Take the runner seat that was offered to the caller. Agents set by earlier runners stop working.
    function takeSeat() external nonReentrant {
        if (msg.sender != pendingRunner || msg.sender == address(0)) revert NotAllowed();
        uint256 cut;
        if (pendingTrim) {
            cut = vester.trimFounder();
            workPot += cut;
        }
        address from = runner;
        (runner, pendingRunner, pendingTrim) = (msg.sender, address(0), false);
        ++agentEpoch;
        emit RunnerChanged(from, msg.sender, cut);
    }

    /// @notice Name the address that may pause the release. Only the `salePath` (the Launcher, for the holders' vote).
    function setPauser(address next) external {
        if (msg.sender != salePath) revert NotAllowed();
        pauser = next;
        emit PauserSet(next);
    }

    /// @notice Pause (`on`) or resume the release of the melting floor and of the backing rounds. Only the pauser. Paused
    /// time is never paid back, like time outside a check-in window.
    function setPaused(bool on) external nonReentrant {
        if (msg.sender != pauser || msg.sender == address(0)) revert NotAllowed();
        _sync();
        paused = on;
        emit Paused(on);
    }

    /// @notice Wind the project down, once, for good. Only the `salePath` (the Launcher checks who asks: the runner before
    /// a market, a Council after it). Payments stop for good (no more release here or in the backing rounds), the exit
    /// fee drops to the platform's part, and backers' refunds keep working with only that part as their fee. The floor
    /// stays for holders to hand back against; `spendable` stays the runner's.
    function markWoundDown() external nonReentrant {
        if (msg.sender != salePath) revert NotAllowed();
        if (woundDown) revert AlreadyWoundDown();
        _sync();
        woundDown = true;
        rounds.windDown();
        emit WoundDown(block.timestamp);
    }

    /// @dev Work out the release here and in the Rounds before the active window changes.
    function _sync() private {
        _accrue();
        rounds.sync();
    }

    /// @notice Work out the release up to now. Anyone may call it; every other function that reads `spendable` does it
    /// first, so nothing needs a bot.
    function release() external nonReentrant {
        _accrue();
    }

    /// @notice What `release` would move to `spendable` if called now.
    function pendingRelease() public view returns (uint256 amount) {
        (amount,) = _preview();
    }

    /// @dev The rule. Active time since the last working-out is the stretch between `accruedUpTo` and the earlier of now
    /// and the end of the check-in window (`lastCheckIn + 14 days`); time after the window is skipped for good. That much
    /// of the remaining active time is used, and the same share of the melting floor is released: `melting * s /
    /// meltRemaining`. Releasing a share of what is left (not of the original deposit) keeps the release even after
    /// holders have handed back part of the floor. The end date is therefore "365 active days after the money arrived",
    /// and each day outside a window pushes it one day later.
    function _preview() private view returns (uint256 amount, uint256 remaining) {
        uint256 from = accruedUpTo;
        remaining = meltRemaining;
        uint256 m = melting;
        if (from == 0 || m == 0) return (0, remaining);
        uint256 end = activeEnd();
        uint256 upto = block.timestamp < end ? block.timestamp : end;
        if (upto <= from) return (0, remaining);
        uint256 active = upto - from;
        if (active >= remaining) return (m, 0);
        return (m * active / remaining, remaining - active);
    }

    function _accrue() private {
        if (accruedUpTo == 0) return;
        (uint256 amount, uint256 remaining) = _preview();
        if (amount != 0) {
            melting -= amount;
            spendable += amount;
            emit Released(amount);
        }
        meltRemaining = remaining;
        accruedUpTo = block.timestamp;
    }

    // ============================================ spending and Shares out ============================================

    /// @notice Send dollars out of `spendable`. The runner may send any amount (a Pair limits each signer itself); an agent
    /// only inside its daily limit.
    function spend(address to, uint256 amount) external nonReentrant {
        if (to == address(0) || amount == 0) revert BadInput();
        if (msg.sender != runner) {
            Agent memory a = agents[msg.sender];
            if (!a.active || agentEpochOf[msg.sender] != agentEpoch) revert NotAllowed();
            _agentUsd[msg.sender].consume(DAY, DAY_PARTS, a.usdCap, amount);
        }
        _accrue();
        if (amount > spendable) revert TooMuch(amount, spendable);
        spendable -= amount;
        _pay(to, amount);
        emit Spent(msg.sender, to, amount);
    }

    /// @notice Give Shares from the work pot to a person, in one call. The runner may give any amount the pot has; an
    /// agent only inside its daily Share limit. Before the clock starts the Shares go to the Vester and follow its
    /// 365-day release; after it they go straight to `to`, at most 1% of the Shares in people's hands (`countingSupply`) in
    /// any 30 days for the whole project.
    function giveShares(address to, uint256 amount) external nonReentrant {
        _checkGift(to, amount);
        if (msg.sender != runner) {
            Agent memory a = agents[msg.sender];
            if (!a.active || agentEpochOf[msg.sender] != agentEpoch) revert NotAllowed();
            _agentShares[msg.sender].consume(DAY, DAY_PARTS, a.shareCap, amount);
        }
        if (amount > workPot) revert WorkPotShort(amount, workPot);
        workPot -= amount;
        _gift(to, amount);
    }

    /// @notice Project zero only: pay a team member from the team budget (its founder's slice, held here, earmarked and
    /// public: `teamBudget` is what is left). The rules are a gift's: before the market the Shares go to the Vester and
    /// release over 365 days from the market opening; after it they go straight to `to`, inside the same 1% of the Shares in
    /// people's hands in any 30 days that every gift shares. And never faster than the budget accrues (`teamPayable`):
    /// evenly over `TEAM_PAY_SPAN` from the launch, so a runner who leaves early has been paid for the days served only.
    /// Only the runner (never an agent); the work pot and the reserve are never touched.
    function payTeam(address to, uint256 amount) external nonReentrant onlyRunner {
        _checkGift(to, amount);
        uint256 left = teamBudget;
        if (amount > left) revert TeamBudgetShort(amount, left);
        uint256 open = teamPayable();
        if (amount > open) revert TeamPayTooFast(amount, open);
        teamBudget = left - amount;
        _gift(to, amount);
        emit TeamPaid(to, amount, left - amount);
    }

    /// @notice Project zero only: team pay accrued so far and not paid yet (the budget at launch times the time since the
    /// launch over `TEAM_PAY_SPAN`, at most all of it, less what was paid). Zero for every other project.
    function teamPayable() public view returns (uint256) {
        uint256 atLaunch = teamBudgetAtLaunch;
        uint256 elapsed = block.timestamp - teamPayFrom;
        uint256 accrued = elapsed >= TEAM_PAY_SPAN ? atLaunch : atLaunch * elapsed / TEAM_PAY_SPAN;
        return accrued - (atLaunch - teamBudget);
    }

    /// @dev A gift goes to a person: never to nobody, this contract, the Vester, the Shares or project zero's earlier
    /// backers' claim contract (a grant to it would block every consent: its grant must equal its list), and never of nothing.
    function _checkGift(address to, uint256 amount) private view {
        if (
            to == address(0) || to == address(this) || to == address(vester) || to == address(shares) || to == earlier
                || amount == 0
        ) {
            revert BadInput();
        }
    }

    /// @dev Deliver a gift: held in the Vester before the clock starts, straight to `to` after it under the monthly cap.
    function _gift(address to, uint256 amount) private {
        if (poolOpen) {
            _gifts.consume(MONTH, MONTH_PARTS, countingSupply() * GIFT_CAP_BPS / BPS, amount);
            _sendShares(to, amount);
        } else {
            _sendShares(address(vester), amount);
            vester.grant(to, amount);
        }
        emit SharesGiven(msg.sender, to, amount, !poolOpen);
    }

    /// @notice Take reserve Shares out for a reserve sale. Only the sale path (the Launcher); the reserve is the Shares held
    /// here beyond the work pot. Exits wait until `closeReserveSale`, so Shares out for sale never count as held by people.
    function releaseReserve(address to, uint256 amount) external nonReentrant {
        if (msg.sender != salePath) revert NotAllowed();
        if (reserveSaleOpen) revert ReserveSaleState();
        uint256 left = reserve();
        if (to == address(0) || amount == 0) revert BadInput();
        if (amount > left) revert TooMuch(amount, left);
        reserveSaleOpen = true;
        _sendShares(to, amount);
        emit ReserveReleased(to, amount);
    }

    /// @notice The reserve sale is finished and its unsold Shares are back: exits open again. Only the sale path.
    function closeReserveSale() external nonReentrant {
        if (msg.sender != salePath) revert NotAllowed();
        if (!reserveSaleOpen) revert ReserveSaleState();
        reserveSaleOpen = false;
        emit ReserveSaleClosed(block.timestamp);
    }

    /// @notice Shares held here that are not the work pot or project zero's team budget: the 10% reserve, plus any Shares
    /// returned by the pool step, the backing rounds (unsold or refunded) or donated. They leave only through
    /// `releaseReserve` and the stake.
    function reserve() public view returns (uint256) {
        return shares.balanceOf(address(this)) - workPot - teamBudget;
    }

    // ================================================== agents =======================================================

    /// @notice Let an account act as an agent with the default daily limits (25 dollars and 0.1% of all Shares).
    function authoriseAgent(address agent) external {
        setAgent(agent, defaultAgentUsd, defaultAgentShares);
    }

    /// @notice Let an account act as an agent with chosen daily limits, or change them. Only the runner. What the agent
    /// already used still counts, so switching an agent off and on again does not reset its limit. An agent works only
    /// under the runner that set it: a hand-over switches every agent off.
    function setAgent(address agent, uint128 usdCap, uint128 shareCap) public {
        if (msg.sender != runner) revert NotAllowed();
        if (agent == address(0)) revert BadInput();
        agents[agent] = Agent({active: true, usdCap: usdCap, shareCap: shareCap});
        agentEpochOf[agent] = agentEpoch;
        emit AgentSet(agent, true, usdCap, shareCap);
    }

    /// @notice Switch an agent off. Only the runner.
    function revokeAgent(address agent) external {
        if (msg.sender != runner) revert NotAllowed();
        agents[agent].active = false;
        emit AgentSet(agent, false, agents[agent].usdCap, agents[agent].shareCap);
    }

    /// @notice Dollars an agent has used inside the current limit window.
    function agentUsdUsed(address agent) external view returns (uint256) {
        return _agentUsd[agent].used(DAY, DAY_PARTS);
    }

    /// @notice Shares an agent has given inside the current limit window.
    function agentSharesUsed(address agent) external view returns (uint256) {
        return _agentShares[agent].used(DAY, DAY_PARTS);
    }

    /// @notice Shares given after the clock started that still count against the 1% in 30 days.
    function giftsUsed() external view returns (uint256) {
        return _gifts.used(MONTH, MONTH_PARTS);
    }

    // ================================================== the exit =====================================================

    /// @notice Shares in people's hands for the exit right: all Shares minus those held here, by the Rounds (unsold or
    /// bought and not yet set aside), by the Finisher (not yet sold) and those the Vester has not released yet. Released
    /// Shares count whether or not their owner has pressed claim, so no stranger's claim can move anyone's price. For
    /// project zero, Shares released to the earlier backers' claim contract but not yet delivered (entries not agreed to,
    /// in their challenge window or behind the lock-up gate) are left out too. Read each time; no caller supplies it.
    function countingSupply() public view returns (uint256) {
        uint256 held = earlier == address(0) ? 0 : IEarlierBackers(earlier).undelivered();
        return shares.totalSupply() - shares.balanceOf(address(this)) - shares.balanceOf(address(rounds))
            - shares.balanceOf(opener) - vester.unreleased() - held;
    }

    /// @notice Hand Shares back: burn your own (approve this contract first) and receive your slice of the floor, less
    /// the exit fee. Slice = melting * burned / countingSupply + permanentFloor * burned / totalSupply, worked out after
    /// today's release: the melting floor is shared by the Shares in people's hands, the Share revenue by every Share that
    /// exists. Only the floor is reachable, never `spendable`. Refused until sale money has been split and the sale's
    /// finish is complete, and while a reserve sale is out (so unsold Shares are never counted as held by people). The whole
    /// slice leaves the floor, so the floor per Share of those who remain never moves and leaving in pieces pays exactly
    /// what leaving at once pays: the fee is 5% of the slice (rounded up), 1% owed to the platform and 4% added to the
    /// project's `spendable`. After a wind-down the fee is the platform's 1% only.
    /// @param amount Shares to burn.
    /// @return paid Dollars sent to the caller.
    function handBack(uint256 amount) external nonReentrant returns (uint256 paid) {
        if (!settled) revert NotSettled();
        if (!saleClosed || reserveSaleOpen) revert SaleNotClosed();
        if (amount == 0) revert BadInput();
        _accrue();
        uint256 counting = countingSupply();
        if (amount > counting) revert TooMuch(amount, counting);
        uint256 fromMelting = melting * amount / counting;
        uint256 fromPermanent = permanentFloor * amount / shares.totalSupply();
        uint256 slice = fromMelting + fromPermanent;
        uint256 feeBps = woundDown ? platformFeeBps : exitFeeBps;
        paid = slice - (slice * feeBps + BPS - 1) / BPS; // the fee rounds up, so the holder never pays less than it
        if (paid == 0) revert NothingToPay();
        uint256 toPlatform = woundDown ? slice - paid : slice * platformFeeBps / BPS;
        uint256 toProject = slice - paid - toPlatform;
        permanentFloor -= fromPermanent;
        melting -= fromMelting;
        spendable += toProject;
        feesOwed += toPlatform;
        shares.burnFrom(msg.sender, amount);
        _pay(msg.sender, paid);
        emit HandedBack(msg.sender, amount, paid, toPlatform, toProject);
    }

    /// @notice Send the platform its owed exit fees. Anyone may call it.
    function sweepFees() external nonReentrant {
        uint256 owed = feesOwed;
        if (owed == 0) return;
        feesOwed = 0;
        _pay(platform, owed);
        emit FeesSwept(platform, owed);
    }

    // ================================================== plumbing =====================================================

    /// @dev The founder agrees to the runner's call: they are the runner, or the runner is a Pair made by the Launcher (the
    /// `salePath`) with the founder as a signer, which makes a call only when both signers agreed.
    function _founderAgrees() private view returns (bool) {
        if (msg.sender == founder) return true;
        if (!ILauncherPairs(salePath).isPair(msg.sender)) return false;
        return IPairSigners(msg.sender).first() == founder || IPairSigners(msg.sender).second() == founder;
    }

    function _sendShares(address to, uint256 amount) private {
        if (!shares.transfer(to, amount)) revert BadInput();
    }

    /// @dev Pull dollars from the caller and return what actually arrived (a token that keeps a fee delivers less).
    function _pull(uint256 amount) private returns (uint256 got) {
        if (amount == 0) revert BadInput();
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), amount);
        got = quote.balanceOf(address(this)) - before;
        if (got == 0) revert TokenMisbehaved();
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
