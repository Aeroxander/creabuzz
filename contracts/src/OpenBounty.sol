// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice The court a bounty's claimant can appeal to (`CreateCourt`, or any arbitrator of the same shape).
interface IArbitrator {
    function feeToken() external view returns (IERC20);
    function arbitrationCost() external view returns (uint256);
    function createDispute(uint256 choices, bytes calldata extraData) external returns (uint256);
}

/// @title OpenBounty
/// @notice A bounty on a post (N2, specified in docs/v3-review/OPEN-BOUNTY-STATES.md). Anyone opens one with fixed words
/// for what "done" looks like, a deadline and money; anyone adds money until the deadline; anyone files a claim with
/// evidence. Each funder backs at most one claim with all the money they put in. A claim whose backing is more than
/// half of the counting money (what funders with no open claim put in) starts a run; if it keeps that majority for
/// `RUN` without a break, anyone can pay it the whole pot. A dip ends the run. No money comes in while a run is on.
/// After the deadline nothing new starts; once no run is on, or at `refundsFrom` whatever happens, each funder takes
/// back their own money.
///
/// Why one count for everyone: if a claimant's money were left out only of their own claim, each claim would have its
/// own count and two claims could both have a majority. Here a wallet with an open claim has no weight at all, so with
/// one claim per funder at most one claim can ever qualify.
///
/// The two endings cannot overlap: `pay` needs a run and `block.timestamp < refundsFrom`; `refund` needs
/// `block.timestamp >= refundsFrom`, or the deadline passed with no run on, and no run can start after the deadline.
///
/// The words and each claim's evidence are kept in this contract's events (their hashes in storage), so the page needs
/// nothing but the chain to read them. Every action is constant time. No admin, no pause, no fee, no deposit.
///
/// Appeals (N7, when a `court` is named): once the deadline has passed and no run is on, a claimant may take their claim
/// to the court within `APPEAL_WINDOW`, paying its fee; refunds wait for that window (unless nobody filed a claim). While
/// the appeal is open nothing
/// can be refunded. If the court upholds the claim, anyone can pay it the whole pot within `PAY_GRACE` of the ruling;
/// any other ruling (against, none, or a timeout) leaves the bounty as it was, and refunds open. One appeal per bounty.
contract OpenBounty {
    using SafeERC20 for IERC20;

    /// @notice How long a claim must keep its majority before it can be paid: two days agreeing and a seven-day hold.
    uint64 public constant RUN = 9 days;
    /// @notice The first part of a run, worded "agreeing" on the page. The contract makes no difference.
    uint64 public constant AGREE = 2 days;
    /// @notice After the latest a run could become payable, how long it can still be paid before refunds open anyway.
    uint64 public constant PAY_GRACE = 14 days;
    /// @notice The furthest a deadline can be from the bounty's opening.
    uint64 public constant MAX_LENGTH = 365 days;
    /// @notice The longest words or evidence, in bytes.
    uint256 public constant MAX_TEXT = 1000;
    /// @notice How long after the deadline (or after a later run ended) a claimant can appeal, before refunds open.
    uint64 public constant APPEAL_WINDOW = 3 days;

    uint8 internal constant APPEAL_OPEN = 1;
    uint8 internal constant APPEAL_UPHELD = 2;
    uint8 internal constant APPEAL_REFUSED = 3;

    IERC20 public immutable currency;
    /// @notice Where claimants appeal; the zero address means no appeals.
    IArbitrator public immutable court;

    struct Bounty {
        address creator;
        uint64 openedAt;
        uint64 deadline;
        uint64 refundsFrom;
        /// @dev The post it was opened on (the post's event id).
        bytes32 post;
        bytes32 wordsHash;
        uint128 total;
        uint128 refunded;
        /// @dev What funders with no open claim put in and have not taken back.
        uint128 counting;
        uint32 claimCount;
        /// @dev The claim whose run is on, or 0.
        uint32 runClaim;
        uint64 runSince;
        /// @dev The claim that was paid, or 0.
        uint32 paidClaim;
    }

    /// @dev Kept apart from `Bounty` so its reads keep their shape.
    struct Appeal {
        /// @dev When the last run ended, so an appeal window can follow a run that ended after the deadline.
        uint64 runEndedAt;
        /// @dev 0 none, 1 open, 2 upheld, 3 refused (any ruling but "for").
        uint8 state;
        uint32 claim;
        uint64 ruledAt;
    }

    struct Claim {
        address claimant;
        bool open;
        uint128 backing;
        bytes32 evidenceHash;
    }

    uint256 public bountyCount;
    mapping(uint256 => Bounty) public bounties;
    mapping(uint256 => mapping(uint32 => Claim)) public claims;
    mapping(uint256 => mapping(address => uint128)) public funded;
    mapping(uint256 => mapping(address => uint32)) public backs;
    mapping(uint256 => mapping(address => uint32)) public openClaim;
    mapping(uint256 => Appeal) public appeals;
    /// @notice The bounty each court case is about.
    mapping(uint256 => uint256) public bountyOfDispute;
    bool private entered;

    error InvalidSetup();
    error BadText();
    error BadDeadline(uint64 deadline);
    error NothingToFund();
    error UnknownBounty(uint256 id);
    error AlreadyPaid(uint256 id);
    error PastDeadline(uint256 id);
    error RunOn(uint256 id);
    error ShortTransfer(uint256 expected, uint256 received);
    error HasOpenClaim(uint256 id, uint32 claim);
    error NoOpenClaim(uint256 id);
    error NotOpen(uint256 id, uint32 claim);
    error NoWeight(uint256 id);
    error AlreadyBacking(uint256 id, uint32 claim);
    error NotBacking(uint256 id);
    error NotQualified(uint256 id, uint32 claim);
    error NoRun(uint256 id);
    error NotPayableYet(uint256 id, uint64 payableAt);
    error PayTooLate(uint256 id, uint64 refundsFrom);
    error RefundsNotOpen(uint256 id);
    error NothingToRefund(uint256 id, address funder);
    error Reentrancy();
    error NoCourt();
    error NotAppealTime(uint256 id);
    error AlreadyAppealed(uint256 id);
    error AppealOpen(uint256 id);
    error NotCourt();
    error UnknownDispute(uint256 dispute);

    event BountyOpened(
        uint256 indexed id,
        bytes32 indexed post,
        address indexed creator,
        bytes32 wordsHash,
        uint64 deadline,
        uint64 refundsFrom,
        string words
    );
    event Funded(uint256 indexed id, address indexed funder, uint256 amount, uint256 total);
    event ClaimFiled(
        uint256 indexed id, uint32 indexed claim, address indexed claimant, bytes32 evidenceHash, string evidence
    );
    event ClaimWithdrawn(uint256 indexed id, uint32 indexed claim);
    event Backed(uint256 indexed id, address indexed funder, uint32 indexed claim, uint256 amount);
    event Unbacked(uint256 indexed id, address indexed funder, uint32 indexed claim, uint256 amount);
    event RunStarted(uint256 indexed id, uint32 indexed claim, uint64 since);
    event RunEnded(uint256 indexed id, uint32 indexed claim);
    event BountyPaid(uint256 indexed id, uint32 indexed claim, address indexed claimant, uint256 amount);
    event Refunded(uint256 indexed id, address indexed funder, uint256 amount);
    event Appealed(uint256 indexed id, uint32 indexed claim, address indexed claimant, uint256 dispute);
    event AppealRuled(uint256 indexed id, uint32 indexed claim, uint256 ruling);

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(IERC20 currency_, IArbitrator court_) {
        if (address(currency_).code.length == 0) revert InvalidSetup();
        if (address(court_) != address(0) && address(court_).code.length == 0) revert InvalidSetup();
        currency = currency_;
        court = court_;
    }

    // ---- opening and money in ------------------------------------------------------------------------------------

    /// @notice Open a bounty on `post` with these `words`, a `deadline` within `MAX_LENGTH`, and `amount` from the sender.
    function open(bytes32 post, string calldata words, uint64 deadline, uint256 amount)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (bytes(words).length == 0 || bytes(words).length > MAX_TEXT) revert BadText();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_LENGTH) revert BadDeadline(deadline);
        if (amount == 0) revert NothingToFund();
        id = ++bountyCount;
        Bounty storage b = bounties[id];
        b.creator = msg.sender;
        b.openedAt = uint64(block.timestamp);
        b.deadline = deadline;
        b.refundsFrom = deadline + RUN + PAY_GRACE;
        b.post = post;
        b.wordsHash = keccak256(bytes(words));
        emit BountyOpened(id, post, msg.sender, b.wordsHash, deadline, b.refundsFrom, words);
        _fund(id, b, amount);
    }

    /// @notice Add `amount`: before the deadline, while no run is on, and before it paid.
    function fund(uint256 id, uint256 amount) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != 0) revert AlreadyPaid(id);
        if (block.timestamp >= b.deadline) revert PastDeadline(id);
        if (b.runClaim != 0) revert RunOn(id);
        if (amount == 0) revert NothingToFund();
        _fund(id, b, amount);
    }

    // ---- claims --------------------------------------------------------------------------------------------------

    /// @notice File a claim with its `evidence`, before the deadline; one open claim per wallet. A funder who files has no
    /// weight while the claim is open, and the backing they gave is withdrawn.
    function fileClaim(uint256 id, string calldata evidence) external nonReentrant returns (uint32 claim) {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != 0) revert AlreadyPaid(id);
        if (block.timestamp >= b.deadline) revert PastDeadline(id);
        if (openClaim[id][msg.sender] != 0) revert HasOpenClaim(id, openClaim[id][msg.sender]);
        if (bytes(evidence).length == 0 || bytes(evidence).length > MAX_TEXT) revert BadText();
        claim = ++b.claimCount;
        bytes32 evidenceHash = keccak256(bytes(evidence));
        claims[id][claim] = Claim({claimant: msg.sender, open: true, backing: 0, evidenceHash: evidenceHash});
        openClaim[id][msg.sender] = claim;
        uint128 weight = funded[id][msg.sender];
        if (weight != 0) {
            b.counting -= weight;
            _unback(id, msg.sender, weight);
        }
        emit ClaimFiled(id, claim, msg.sender, evidenceHash, evidence);
        _check(id, b);
    }

    /// @notice Withdraw your open claim. If its run was on, the run ends; your money counts again.
    function withdrawClaim(uint256 id) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != 0) revert AlreadyPaid(id);
        uint32 claim = openClaim[id][msg.sender];
        if (claim == 0) revert NoOpenClaim(id);
        if (appeals[id].state == APPEAL_OPEN && appeals[id].claim == claim) revert AppealOpen(id);
        claims[id][claim].open = false;
        openClaim[id][msg.sender] = 0;
        b.counting += funded[id][msg.sender];
        emit ClaimWithdrawn(id, claim);
        // A withdrawn claim no longer qualifies, so the run check ends its run if it had one.
        _check(id, b);
    }

    // ---- backing -------------------------------------------------------------------------------------------------

    /// @notice Back claim `claim` with all the money you put in, moving any backing you gave another claim. Before the
    /// deadline only, by a funder with no open claim. A majority this gives starts the claim's run.
    function back(uint256 id, uint32 claim) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != 0) revert AlreadyPaid(id);
        if (block.timestamp >= b.deadline) revert PastDeadline(id);
        if (claim == 0 || claim > b.claimCount || !claims[id][claim].open) revert NotOpen(id, claim);
        uint128 weight = funded[id][msg.sender];
        if (weight == 0) revert NoWeight(id);
        if (openClaim[id][msg.sender] != 0) revert HasOpenClaim(id, openClaim[id][msg.sender]);
        if (backs[id][msg.sender] == claim) revert AlreadyBacking(id, claim);
        _unback(id, msg.sender, weight);
        backs[id][msg.sender] = claim;
        claims[id][claim].backing += weight;
        emit Backed(id, msg.sender, claim, weight);
        _check(id, b);
        _tryStart(id, b, claim);
    }

    /// @notice Withdraw your backing, at any time before a payment. It can end a run.
    function unback(uint256 id) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != 0) revert AlreadyPaid(id);
        if (backs[id][msg.sender] == 0) revert NotBacking(id);
        _unback(id, msg.sender, funded[id][msg.sender]);
        _check(id, b);
    }

    // ---- runs, payment and refunds ---------------------------------------------------------------------------------

    /// @notice Start the run of `claim` when it has a majority that no backing started (a funder filing a claim lowers
    /// the count). Anyone may call it, before the deadline, while no run is on.
    function start(uint256 id, uint32 claim) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != 0) revert AlreadyPaid(id);
        if (b.runClaim != 0) revert RunOn(id);
        if (block.timestamp >= b.deadline) revert PastDeadline(id);
        if (!_qualifies(id, b, claim)) revert NotQualified(id, claim);
        _startRun(id, b, claim);
    }

    /// @notice Pay the run's claimant the whole pot, once the run is `RUN` old and before `refundsFrom`; or the claim the
    /// court upheld, within `PAY_GRACE` of the ruling. Anyone may call it. If the currency refuses the claimant, nothing
    /// changes and the funders are refunded once the time to pay is over.
    function pay(uint256 id) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != 0) revert AlreadyPaid(id);
        Appeal storage a = appeals[id];
        if (a.state == APPEAL_UPHELD) {
            uint64 until = a.ruledAt + PAY_GRACE;
            if (block.timestamp >= until) revert PayTooLate(id, until);
            _payClaim(id, b, a.claim);
            return;
        }
        uint32 claim = b.runClaim;
        if (claim == 0) revert NoRun(id);
        uint64 payableAt = b.runSince + RUN;
        if (block.timestamp < payableAt) revert NotPayableYet(id, payableAt);
        if (block.timestamp >= b.refundsFrom) revert PayTooLate(id, b.refundsFrom);
        _payClaim(id, b, claim);
    }

    // ---- appeals -------------------------------------------------------------------------------------------------

    /// @notice Take your open claim to the court, paying its fee: after the deadline, with no run on, within
    /// `APPEAL_WINDOW` of the deadline (or of a run that ended after it), before `refundsFrom` and before anything was
    /// refunded. One appeal per bounty.
    function appeal(uint256 id) external nonReentrant returns (uint256 dispute) {
        if (address(court) == address(0)) revert NoCourt();
        Bounty storage b = _bounty(id);
        if (b.paidClaim != 0) revert AlreadyPaid(id);
        uint32 claim = openClaim[id][msg.sender];
        if (claim == 0) revert NoOpenClaim(id);
        Appeal storage a = appeals[id];
        if (a.state != 0) revert AlreadyAppealed(id);
        if (b.runClaim != 0) revert RunOn(id);
        uint64 from = _quietSince(b, a);
        if (
            block.timestamp < b.deadline || block.timestamp >= from + APPEAL_WINDOW || block.timestamp >= b.refundsFrom
                || b.refunded != 0
        ) revert NotAppealTime(id);
        a.state = APPEAL_OPEN;
        a.claim = claim;
        IERC20 feeToken = court.feeToken();
        uint256 fee = court.arbitrationCost();
        uint256 before = feeToken.balanceOf(address(this));
        feeToken.safeTransferFrom(msg.sender, address(this), fee);
        uint256 received = feeToken.balanceOf(address(this)) - before;
        if (received != fee) revert ShortTransfer(fee, received);
        feeToken.forceApprove(address(court), fee);
        dispute = court.createDispute(2, abi.encode(id, claim));
        bountyOfDispute[dispute] = id;
        emit Appealed(id, claim, msg.sender, dispute);
    }

    /// @notice The court's final ruling on an appeal: 1 upholds the claim; anything else refuses it.
    function rule(uint256 dispute, uint256 ruling) external {
        if (msg.sender != address(court)) revert NotCourt();
        uint256 id = bountyOfDispute[dispute];
        Appeal storage a = appeals[id];
        if (id == 0 || a.state != APPEAL_OPEN) revert UnknownDispute(dispute);
        a.state = ruling == 1 ? APPEAL_UPHELD : APPEAL_REFUSED;
        a.ruledAt = uint64(block.timestamp);
        emit AppealRuled(id, a.claim, ruling);
    }

    /// @notice Send `funder` back everything they put in, once refunds are open: at `refundsFrom`, or once the deadline
    /// has passed with no run on. Anyone may call it; the money only ever goes to the funder.
    function refund(uint256 id, address funder) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paidClaim != 0) revert AlreadyPaid(id);
        if (!_refundsOpen(id, b)) revert RefundsNotOpen(id);
        uint128 weight = funded[id][funder];
        if (weight == 0) revert NothingToRefund(id, funder);
        funded[id][funder] = 0;
        b.refunded += weight;
        if (openClaim[id][funder] == 0) b.counting -= weight;
        _unback(id, funder, weight);
        emit Refunded(id, funder, weight);
        _check(id, b);
        currency.safeTransfer(funder, weight);
    }

    // ---- reads ---------------------------------------------------------------------------------------------------

    /// @notice Whether `claim` has more than half of the counting money behind it now.
    function qualifies(uint256 id, uint32 claim) external view returns (bool) {
        return _qualifies(id, bounties[id], claim);
    }

    /// @notice Whether funders can take their money back now.
    function refundsOpen(uint256 id) external view returns (bool) {
        Bounty storage b = bounties[id];
        return b.creator != address(0) && b.paidClaim == 0 && _refundsOpen(id, b);
    }

    /// @notice What bounty `id` still holds: its total less refunds until it pays; zero once paid.
    function held(uint256 id) external view returns (uint256) {
        Bounty storage b = bounties[id];
        return b.paidClaim != 0 ? 0 : b.total - b.refunded;
    }

    // ---- inside --------------------------------------------------------------------------------------------------

    function _bounty(uint256 id) private view returns (Bounty storage b) {
        b = bounties[id];
        if (b.creator == address(0)) revert UnknownBounty(id);
    }

    function _qualifies(uint256 id, Bounty storage b, uint32 claim) private view returns (bool) {
        if (claim == 0 || claim > b.claimCount) return false;
        Claim storage c = claims[id][claim];
        return c.open && uint256(c.backing) * 2 > b.counting;
    }

    function _refundsOpen(uint256 id, Bounty storage b) private view returns (bool) {
        Appeal storage a = appeals[id];
        if (a.state == APPEAL_OPEN) return false;
        if (a.state == APPEAL_UPHELD) return block.timestamp >= a.ruledAt + PAY_GRACE;
        if (block.timestamp >= b.refundsFrom) return true;
        if (block.timestamp < b.deadline || b.runClaim != 0) return false;
        // With a court, claimants get the appeal window first; with no claim, or a refused appeal, refunds open at once.
        return address(court) == address(0) || b.claimCount == 0 || a.state == APPEAL_REFUSED
            || block.timestamp >= _quietSince(b, a) + APPEAL_WINDOW;
    }

    /// @dev Since when the bounty has had no run after its deadline: the deadline, or a run that ended after it.
    function _quietSince(Bounty storage b, Appeal storage a) private view returns (uint64) {
        return a.runEndedAt > b.deadline ? a.runEndedAt : b.deadline;
    }

    function _payClaim(uint256 id, Bounty storage b, uint32 claim) private {
        b.paidClaim = claim;
        address claimant = claims[id][claim].claimant;
        uint256 amount = b.total;
        emit BountyPaid(id, claim, claimant, amount);
        currency.safeTransfer(claimant, amount);
    }

    function _fund(uint256 id, Bounty storage b, uint256 amount) private {
        if (amount > type(uint128).max) revert NothingToFund();
        uint256 before = currency.balanceOf(address(this));
        currency.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = currency.balanceOf(address(this)) - before;
        // A currency that keeps a fee would leave the books promising more than is held.
        if (received != amount) revert ShortTransfer(amount, received);
        uint128 added = uint128(amount);
        funded[id][msg.sender] += added;
        b.total += added;
        emit Funded(id, msg.sender, amount, b.total);
        if (openClaim[id][msg.sender] != 0) return;
        b.counting += added;
        uint32 backed = backs[id][msg.sender];
        if (backed != 0) {
            claims[id][backed].backing += added;
            _tryStart(id, b, backed);
        }
    }

    /// @dev Take `weight` off the claim `who` backs, if any, and clear their backing.
    function _unback(uint256 id, address who, uint128 weight) private {
        uint32 backed = backs[id][who];
        if (backed == 0) return;
        claims[id][backed].backing -= weight;
        backs[id][who] = 0;
        emit Unbacked(id, who, backed, weight);
    }

    /// @dev The run check: a run whose claim no longer has a majority ends.
    function _check(uint256 id, Bounty storage b) private {
        uint32 claim = b.runClaim;
        if (claim != 0 && !_qualifies(id, b, claim)) _endRun(id, b);
    }

    /// @dev Called only by `open`, `fund` and `back`, which all refuse after the deadline, so no run starts after it.
    function _tryStart(uint256 id, Bounty storage b, uint32 claim) private {
        if (b.runClaim == 0 && _qualifies(id, b, claim)) _startRun(id, b, claim);
    }

    function _startRun(uint256 id, Bounty storage b, uint32 claim) private {
        b.runClaim = claim;
        b.runSince = uint64(block.timestamp);
        emit RunStarted(id, claim, b.runSince);
    }

    function _endRun(uint256 id, Bounty storage b) private {
        emit RunEnded(id, b.runClaim);
        b.runClaim = 0;
        b.runSince = 0;
        appeals[id].runEndedAt = uint64(block.timestamp);
    }
}
