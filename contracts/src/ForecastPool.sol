// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice What a pool reads from a bounty on a post: its record, its claims and whether refunds are open.
interface IOpenBountyView {
    function bounties(uint256 id)
        external
        view
        returns (
            address creator,
            uint64 openedAt,
            uint64 deadline,
            uint64 refundsFrom,
            bytes32 post,
            bytes32 wordsHash,
            uint128 total,
            uint128 refunded,
            uint128 counting,
            uint32 claimCount,
            uint32 runClaim,
            uint64 runSince,
            uint32 paidClaim
        );
    function openClaim(uint256 id, address who) external view returns (uint32);
    function refundsOpen(uint256 id) external view returns (bool);
}

/// @title ForecastPool
/// @notice Money forecasts (N8, docs/v3-review/MONEY-FORECASTS.md), an experiment on test networks: two pools of
/// people's own money on one question, "will this bounty on a post be paid?". Whoever was right shares the other pool in
/// proportion to what they put in. No market maker, no selling a position, no platform or DAO money, no reward for
/// accuracy beyond the pools.
///
/// Betting closes a day before the bounty's deadline, and while any run is on (work already winning it). The bounty's
/// creator and anyone with an open claim cannot bet that it will not be paid. Each wallet puts at most `CAP` on a
/// question. The question settles on the bounty itself: paid is yes; refunds open is no. If nobody was on the winning
/// side, everyone takes back what they put in. Anyone can settle, and anyone can send a bettor what they are owed; the
/// money only ever goes to the bettor. No admin, no pause, no fee.
contract ForecastPool {
    using SafeERC20 for IERC20;

    /// @notice The most one wallet puts on one question.
    uint256 public constant CAP = 1_000e6;
    /// @notice Betting closes this long before the bounty's deadline.
    uint64 public constant CLOSE_BEFORE = 1 days;

    uint8 internal constant OPEN = 0;
    uint8 internal constant YES = 1;
    uint8 internal constant NO = 2;
    uint8 internal constant VOID = 3;

    IERC20 public immutable currency;
    IOpenBountyView public immutable bounties;

    struct Pool {
        uint128 yes;
        uint128 no;
        /// @dev 0 open, 1 paid (yes), 2 not paid (no), 3 nobody on the winning side.
        uint8 outcome;
    }

    mapping(uint256 => Pool) public pools;
    mapping(uint256 => mapping(address => uint128)) public yesOf;
    mapping(uint256 => mapping(address => uint128)) public noOf;
    mapping(uint256 => mapping(address => bool)) public collected;
    bool private entered;

    error InvalidSetup();
    error Reentrancy();
    error UnknownBounty(uint256 id);
    error Closed(uint256 id);
    error Barred(uint256 id);
    error OverCap(uint256 id, uint256 room);
    error NothingToBet();
    error ShortTransfer(uint256 expected, uint256 received);
    error AlreadySettled(uint256 id);
    error NotSettled(uint256 id);
    error NothingOwed(uint256 id, address who);

    event Bet(uint256 indexed id, address indexed who, bool yes, uint256 amount, uint256 yesPool, uint256 noPool);
    event Settled(uint256 indexed id, uint8 outcome, uint256 yesPool, uint256 noPool);
    event Collected(uint256 indexed id, address indexed who, uint256 amount);

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(IERC20 currency_, IOpenBountyView bounties_) {
        if (address(currency_).code.length == 0 || address(bounties_).code.length == 0) revert InvalidSetup();
        currency = currency_;
        bounties = bounties_;
    }

    /// @notice Put `amount` on bounty `id` being paid (`yes`) or not. Until a day before its deadline, while no run is
    /// on; the bounty's creator and its claimants only on yes.
    function bet(uint256 id, bool yes, uint256 amount) external nonReentrant {
        if (amount == 0) revert NothingToBet();
        (address creator,, uint64 deadline,,,,,,,, uint32 runClaim,, uint32 paidClaim) = bounties.bounties(id);
        if (creator == address(0)) revert UnknownBounty(id);
        Pool storage p = pools[id];
        if (p.outcome != OPEN || paidClaim != 0 || runClaim != 0 || block.timestamp + CLOSE_BEFORE >= deadline) {
            revert Closed(id);
        }
        if (!yes && (msg.sender == creator || bounties.openClaim(id, msg.sender) != 0)) revert Barred(id);
        uint256 already = uint256(yesOf[id][msg.sender]) + noOf[id][msg.sender];
        if (already + amount > CAP) revert OverCap(id, CAP - already);
        uint256 before = currency.balanceOf(address(this));
        currency.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = currency.balanceOf(address(this)) - before;
        if (received != amount) revert ShortTransfer(amount, received);
        if (yes) {
            yesOf[id][msg.sender] += uint128(amount);
            p.yes += uint128(amount);
        } else {
            noOf[id][msg.sender] += uint128(amount);
            p.no += uint128(amount);
        }
        emit Bet(id, msg.sender, yes, amount, p.yes, p.no);
    }

    /// @notice Settle bounty `id`'s question once the bounty has paid (yes) or its refunds have opened (no). Anyone.
    function settle(uint256 id) external {
        Pool storage p = pools[id];
        if (p.outcome != OPEN) revert AlreadySettled(id);
        (address creator,,,,,,,,,,,, uint32 paidClaim) = bounties.bounties(id);
        if (creator == address(0)) revert UnknownBounty(id);
        uint8 outcome;
        if (paidClaim != 0) outcome = YES;
        else if (bounties.refundsOpen(id)) outcome = NO;
        else revert NotSettled(id);
        if ((outcome == YES ? p.yes : p.no) == 0) outcome = VOID;
        p.outcome = outcome;
        emit Settled(id, outcome, p.yes, p.no);
    }

    /// @notice What `who` collects from a settled question: their winning stake and its share of the losing pool, or
    /// everything they put in when nobody won.
    function owed(uint256 id, address who) public view returns (uint256) {
        Pool storage p = pools[id];
        if (p.outcome == OPEN || collected[id][who]) return 0;
        if (p.outcome == VOID) return uint256(yesOf[id][who]) + noOf[id][who];
        (uint256 mine, uint256 winners, uint256 losers) = p.outcome == YES
            ? (uint256(yesOf[id][who]), uint256(p.yes), uint256(p.no))
            : (uint256(noOf[id][who]), uint256(p.no), uint256(p.yes));
        if (mine == 0) return 0;
        return mine + losers * mine / winners;
    }

    /// @notice Send `who` what they are owed from question `id`. Anyone may call it; the money only goes to `who`.
    function collect(uint256 id, address who) external nonReentrant {
        if (pools[id].outcome == OPEN) revert NotSettled(id);
        uint256 amount = owed(id, who);
        if (amount == 0) revert NothingOwed(id, who);
        collected[id][who] = true;
        emit Collected(id, who, amount);
        currency.safeTransfer(who, amount);
    }
}
