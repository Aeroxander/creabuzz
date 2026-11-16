// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {IShares, IVester, MAX_SPLIT_PART} from "./Interfaces.sol";
import {RollingCap} from "./RollingCap.sol";

/// @title Treasury
/// @notice One project's money and Shares. It holds the dollars in four buckets and the project's work pot and reserve
/// of Shares, and it is the only place a holder can hand Shares back.
///
/// Dollars (the "quote token", any standard 6-decimal ERC-20) sit in four buckets that always add up to no more than
/// the balance:
///  - `spendable`: the founder (and agents inside daily limits) may send it anywhere;
///  - `melting`: the melting floor, 60 of every 75 settled; it moves to `spendable` evenly over 365 active days;
///  - `permanentFloor`: money added as "Share revenue"; it never melts;
///  - `feesOwed`: the platform's cut of exits, waiting to be swept (so a blocked platform address cannot block exits).
///
/// Nobody, the founder included, can move floor money anywhere except to an exiting holder or, through the daily
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
        address founder; // the person who runs the project
        address platform; // receives the platform's part of exit fees
        address opener; // may say the pool is proven, once (a stub until milestone 3)
        address salePath; // may take the reserve out for a public sale (a stub until milestone 3)
        uint16 exitFeeBps; // total exit fee, in ten-thousandths
        uint16 platformFeeBps; // the part of the exit fee that goes to the platform
        uint16 spendableParts; // settle: parts of fresh money that go to `spendable` (15)
        uint16 floorParts; // settle: parts of fresh money that go to the melting floor (60)
        uint128 agentUsd; // default daily dollar limit of an agent
        uint128 agentShares; // default daily Share limit of an agent
        uint256 workPot; // Shares the founder may give for work (the rest of the Shares held here are the reserve)
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
    /// @notice Gifts after the pool opens: at most this many ten-thousandths of all Shares in any 30 days.
    uint256 public constant GIFT_CAP_BPS = 100;
    uint256 private constant BPS = 10_000;
    uint256 private constant DAY = 1 days;
    uint256 private constant DAY_PARTS = 6; // an agent's used amount counts for 24 to 28 hours
    uint256 private constant MONTH = 30 days;
    uint256 private constant MONTH_PARTS = 10; // a gift counts for 30 to 33 days

    // ---- fixed at birth
    IERC20 public quote;
    IShares public shares;
    IVester public vester;
    address public founder;
    address public platform;
    address public opener;
    address public salePath;
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
    bool public poolOpen; // a pool is proven (a stub flag until milestone 3)
    bool public settled; // sale money has been split at least once
    bool public saleClosed; // the sale's last finish step is done: unsold Shares are back here (a stub flag until milestone 3)
    uint256 public workPot; // Shares still available for Give Shares

    mapping(address => Agent) public agents;
    mapping(address => RollingCap.Ring) private _agentUsd;
    mapping(address => RollingCap.Ring) private _agentShares;
    RollingCap.Ring private _gifts;
    bool private transient _locked;

    /// @notice Sale money was split. `toSpendable + toFloor == amount`.
    event Settled(uint256 amount, uint256 toSpendable, uint256 toFloor);
    /// @notice The daily release moved melting floor to spendable.
    event Released(uint256 amount);
    /// @notice The founder or an agent checked in; the release accrues for 14 days from now.
    event CheckedIn(address indexed by);
    /// @notice Dollars were sent from `spendable`.
    event Spent(address indexed by, address indexed to, uint256 amount);
    /// @notice Shares were given from the work pot; `vested` says they went to the Vester.
    event SharesGiven(address indexed by, address indexed to, uint256 amount, bool vested);
    /// @notice A holder handed Shares back for their slice of the floor.
    event HandedBack(address indexed holder, uint256 shares, uint256 paid, uint256 toPlatform, uint256 stays);
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
    /// @notice The sale's finish is complete; exits are open from now (once sale money has been split).
    event SaleClosed(uint256 time);
    /// @notice Reserve Shares left through the sale path.
    event ReserveReleased(address indexed to, uint256 amount);

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
    /// @notice The quote token moved a different amount than it was asked to.
    error TokenMisbehaved();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor() {
        founder = address(1); // locks the implementation the clones point at
    }

    /// @notice Set up the clone, once. The Launcher calls it in the transaction that creates the clone, so nobody can
    /// get in first.
    function initialize(Setup calldata s) external {
        if (founder != address(0)) revert BadSetup();
        if (
            s.founder == address(0) || s.platform == address(0) || s.opener == address(0) || s.salePath == address(0)
                || address(s.quote) == address(0) || address(s.vester) == address(0) || address(s.shares) == address(0)
                || s.exitFeeBps >= BPS || s.platformFeeBps > s.exitFeeBps || s.spendableParts == 0 || s.floorParts == 0
                || s.spendableParts > MAX_SPLIT_PART || s.floorParts > MAX_SPLIT_PART
                || s.shares.balanceOf(address(this)) < s.workPot
        ) revert BadSetup();
        (quote, shares, vester, founder, platform) = (s.quote, s.shares, s.vester, s.founder, s.platform);
        (opener, salePath, workPot) = (s.opener, s.salePath, s.workPot);
        (exitFeeBps, platformFeeBps, spendableParts, floorParts) =
            (s.exitFeeBps, s.platformFeeBps, s.spendableParts, s.floorParts);
        (defaultAgentUsd, defaultAgentShares) = (s.agentUsd, s.agentShares);
    }

    // ================================================ money coming in ================================================

    /// @notice Say that the project's pool is proven open, once, and start the Vester's clock. Stub until milestone 3:
    /// only the `opener` the Launcher named may call it.
    function markPoolOpen() external nonReentrant {
        if (msg.sender != opener) revert NotAllowed();
        if (poolOpen) revert PoolAlreadyOpen();
        poolOpen = true;
        vester.startNow();
        emit PoolOpened(block.timestamp);
    }

    /// @notice Say that the sale's finish is complete, once: the unsold Shares have been swept back to this treasury, so
    /// every Share outside the treasury and the Vester is in a person's hands. Exits open only after this. Stub until
    /// milestone 3: only the `opener` the Launcher named may call it, and only after the pool is proven. Milestone 3's
    /// version must be something any stranger can trigger by finishing the sweep, so exits can never wait on one person.
    function markSaleClosed() external nonReentrant {
        if (msg.sender != opener) revert NotAllowed();
        if (!poolOpen) revert NoPool();
        if (saleClosed) revert SaleAlreadyClosed();
        saleClosed = true;
        emit SaleClosed(block.timestamp);
    }

    /// @notice Split sale money that has arrived: `spendableParts : floorParts` (15 : 60 of each 75 that reach the
    /// treasury, which is 15 and 60 of each 100 raised; the other 25 are the platform's 3 and the pool's 22, handled
    /// before the money gets here). Anyone may call it. Refused until a pool is proven, so a sale whose pool step failed
    /// is not split. `amount` is capped by the dollars that arrived and are not in a bucket, so a caller cannot invent
    /// money; the ratio is fixed at birth, so a caller cannot choose it. The first call starts the check-in window.
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
        uint256 m = melting;
        meltRemaining = m == 0 ? RELEASE_PERIOD : (m * meltRemaining + toFloor * RELEASE_PERIOD) / (m + toFloor);
        melting = m + toFloor;
        spendable += toSpendable;
        if (!settled) {
            (settled, accruedUpTo, lastCheckIn) = (true, block.timestamp, block.timestamp);
        }
        emit Settled(amount, toSpendable, toFloor);
    }

    /// @notice Add dollars to `spendable` (for example, fees a platform project pays itself).
    function topUp(uint256 amount) external nonReentrant {
        uint256 got = _pull(amount);
        spendable += got;
        emit ToppedUp(msg.sender, got);
    }

    /// @notice Add dollars to the permanent floor ("Share revenue"). It never melts and belongs to holders only through
    /// the exit right.
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

    /// @notice Press check-in. The founder or an agent calls it; the daily release then accrues for 14 days. Time that
    /// passed outside a window is never paid back.
    function checkIn() external nonReentrant {
        if (msg.sender != founder && !agents[msg.sender].active) revert NotAllowed();
        _accrue();
        lastCheckIn = block.timestamp;
        emit CheckedIn(msg.sender);
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
        uint256 end = lastCheckIn + CHECK_IN_WINDOW;
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

    /// @notice Send dollars out of `spendable`. The founder may send any amount; an agent only inside its daily limit.
    function spend(address to, uint256 amount) external nonReentrant {
        if (to == address(0) || amount == 0) revert BadInput();
        if (msg.sender != founder) {
            Agent memory a = agents[msg.sender];
            if (!a.active) revert NotAllowed();
            _agentUsd[msg.sender].consume(DAY, DAY_PARTS, a.usdCap, amount);
        }
        _accrue();
        if (amount > spendable) revert TooMuch(amount, spendable);
        spendable -= amount;
        _pay(to, amount);
        emit Spent(msg.sender, to, amount);
    }

    /// @notice Give Shares from the work pot to a person, in one call. The founder may give any amount the pot has; an
    /// agent only inside its daily Share limit. Before the pool opens the Shares go to the Vester and follow its
    /// 365-day release; after it they go straight to `to`, at most 1% of all Shares in any 30 days for the whole project.
    function giveShares(address to, uint256 amount) external nonReentrant {
        if (to == address(0) || to == address(this) || to == address(vester) || to == address(shares) || amount == 0) {
            revert BadInput();
        }
        if (msg.sender != founder) {
            Agent memory a = agents[msg.sender];
            if (!a.active) revert NotAllowed();
            _agentShares[msg.sender].consume(DAY, DAY_PARTS, a.shareCap, amount);
        }
        if (amount > workPot) revert WorkPotShort(amount, workPot);
        workPot -= amount;
        if (poolOpen) {
            _gifts.consume(MONTH, MONTH_PARTS, shares.totalSupply() * GIFT_CAP_BPS / BPS, amount);
            _sendShares(to, amount);
        } else {
            _sendShares(address(vester), amount);
            vester.grant(to, amount);
        }
        emit SharesGiven(msg.sender, to, amount, !poolOpen);
    }

    /// @notice Take reserve Shares out for a public sale. Only the sale path the Launcher named may call it (a stub
    /// until milestone 3); the reserve is the Shares held here beyond the work pot.
    function releaseReserve(address to, uint256 amount) external nonReentrant {
        if (msg.sender != salePath) revert NotAllowed();
        uint256 left = reserve();
        if (to == address(0) || amount == 0) revert BadInput();
        if (amount > left) revert TooMuch(amount, left);
        _sendShares(to, amount);
        emit ReserveReleased(to, amount);
    }

    /// @notice Shares held here that are not the work pot: the 10% reserve, plus any Shares returned by the pool step or
    /// donated. They leave only through `releaseReserve`.
    function reserve() public view returns (uint256) {
        return shares.balanceOf(address(this)) - workPot;
    }

    // ================================================== agents =======================================================

    /// @notice Let an account act as an agent with the default daily limits (25 dollars and 0.1% of all Shares).
    function authoriseAgent(address agent) external {
        setAgent(agent, defaultAgentUsd, defaultAgentShares);
    }

    /// @notice Let an account act as an agent with chosen daily limits, or change them. Only the founder. What the agent
    /// already used still counts, so switching an agent off and on again does not reset its limit.
    function setAgent(address agent, uint128 usdCap, uint128 shareCap) public {
        if (msg.sender != founder) revert NotAllowed();
        if (agent == address(0)) revert BadInput();
        agents[agent] = Agent({active: true, usdCap: usdCap, shareCap: shareCap});
        emit AgentSet(agent, true, usdCap, shareCap);
    }

    /// @notice Switch an agent off. Only the founder.
    function revokeAgent(address agent) external {
        if (msg.sender != founder) revert NotAllowed();
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

    /// @notice Shares given after the pool opened that still count against the 1% in 30 days.
    function giftsUsed() external view returns (uint256) {
        return _gifts.used(MONTH, MONTH_PARTS);
    }

    // ================================================== the exit =====================================================

    /// @notice Shares in people's hands for the exit right: all Shares minus those held here and those the Vester has not
    /// released yet. Released Shares count whether or not their owner has pressed claim, so no stranger's claim can
    /// move anyone's price. Read each time; no caller supplies it.
    function countingSupply() public view returns (uint256) {
        return shares.totalSupply() - shares.balanceOf(address(this)) - vester.unreleased();
    }

    /// @notice Hand Shares back: burn your own (approve this contract first) and receive your slice of the floor, less
    /// the exit fee. Slice = (melting + permanent floor) * burned / countingSupply, worked out after today's release. Only
    /// the floor is reachable, never `spendable`. Refused until sale money has been split and the sale's finish is
    /// complete (so unsold Shares are not counted as held by people). The fee is 5% of the slice:
    /// 4% stays in the floor for those who remain and 1% is owed to the platform. The last holder pays it too: the 4%
    /// then stays in the floor for whoever holds Shares next.
    /// @param amount Shares to burn.
    /// @return paid Dollars sent to the caller.
    function handBack(uint256 amount) external nonReentrant returns (uint256 paid) {
        if (!settled) revert NotSettled();
        if (!saleClosed) revert SaleNotClosed();
        if (amount == 0) revert BadInput();
        _accrue();
        uint256 counting = countingSupply();
        if (amount > counting) revert TooMuch(amount, counting);
        uint256 floorTotal = melting + permanentFloor;
        uint256 slice = floorTotal * amount / counting;
        paid = slice - (slice * exitFeeBps + BPS - 1) / BPS; // the fee rounds up, so the holder never pays less than it
        if (paid == 0) revert NothingToPay();
        uint256 toPlatform = slice * platformFeeBps / BPS;
        uint256 leaves = paid + toPlatform; // the rest of the fee never leaves the floor
        uint256 fromPermanent = leaves * permanentFloor / floorTotal;
        permanentFloor -= fromPermanent;
        melting -= leaves - fromPermanent;
        feesOwed += toPlatform;
        shares.burnFrom(msg.sender, amount);
        _pay(msg.sender, paid);
        emit HandedBack(msg.sender, amount, paid, toPlatform, slice - leaves);
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
