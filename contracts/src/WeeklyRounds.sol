// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IRoundDao {
    function shares() external view returns (address);
    function loot() external view returns (address);
    function votingWeight() external view returns (address);
    function ragequit(address[] calldata tokens, uint256 sharesToBurn, uint256 lootToBurn) external;
}

interface IRoundPolicy {
    function mandateFactory() external view returns (address);
}

interface IRoundFactory {
    function fundingTerms() external view returns (address);
}

/// @notice The DAO's funding terms (D133, `FundingTerms`): what a funding round sells, and who creates the units.
interface IRoundFunding {
    function reserve(address dao) external returns (uint256 units, uint256 leastPrice, address token);
    function settle(address dao, uint256 sold) external;
    function deliver(address dao, address to, uint256 units) external;
}

interface IRoundShares {
    function exitExchange() external view returns (address);
    function lockGuard() external view returns (address);
}

interface IRoundLockGuard {
    function totalLocked() external view returns (uint256);
}

/// @title WeeklyRounds
/// @notice Weekly rounds between a DAO's holders and new buyers (docs/v3-review/WEEKLY-ROUNDS.md), for test networks: a
/// holder who wants out is matched with someone who wants in, so the treasury keeps the money leaving would have taken.
///
/// A round is opened by anyone, a week after the DAO's last one. Its floor is what leaving pays per unit in this
/// contract's currency at that moment (a lower bound: leaving can also pay other assets), and prices are steps of 1% of
/// it (or `minStep` while the treasury is empty). For three days sellers put Shares in with a lowest step and buyers put
/// money in with a highest step; either can take theirs out again until bidding ends. Then, within two days, anyone
/// names the price and this contract checks it: the highest step at which bids still want at least what is offered at
/// that step, or the step above when that trades more. Everyone past the price fills whole; the longer side at the price
/// shares what is left, in proportion. Each person then claims their own Shares and money; nothing loops over orders.
/// A round nobody settles in time is void, and everyone takes back exactly what they put in.
///
/// A fifth of each seller's gain above the floor goes to the DAO. A DAO without the issuance rule may sell Shares it
/// holds, at least two steps above the floor, and pays no cut; both kits set that rule (D76), so their DAOs cannot, and
/// funding a project needs terms of its own (docs/v3-review/FUNDING-TERMS.md). Units move as they are: buyers get Shares.
///
/// Leaving is never taken away: a seller can cancel during bidding, and anyone with units to collect can collect them
/// by leaving instead (`cancelSell` or `claimAndLeave` with the tokens to leave with), which works even if the DAO stops
/// naming this contract as its exchange. Shares move only because the DAO named this contract as its exit exchange, 30
/// days ahead; every other check of the Shares still applies, so locked team Shares cannot enter a round. No admin, no
/// pause.
///
/// Funding rounds (D133) sell a tranche the DAO's funding terms authorised, beside the holders' rounds: the tranche is the
/// only offer, at no less than its least price and two steps above the floor; buyers bid as in any round; and at each
/// buyer's claim the units are created for them (Loot, or Shares if the terms chose them) and what they paid goes to the
/// treasury, with no cut. A funding round settles only at two steps above what leaving pays at that moment. A void one
/// gives the tranche back.
contract WeeklyRounds {
    using SafeERC20 for IERC20;

    /// @notice How long a round takes orders.
    uint64 public constant BIDDING = 3 days;
    /// @notice How long after bidding anyone can settle a round; after that it is void.
    uint64 public constant SETTLE_WINDOW = 2 days;
    /// @notice The least time between the openings of one DAO's rounds.
    uint64 public constant EVERY = 7 days;
    /// @notice Price steps in a round (a power of two: the size of each round's trees).
    uint256 public constant STEPS = 1024;
    /// @notice One price step, as a share of the floor.
    uint256 public constant STEP_BPS = 100;
    /// @notice The part of a seller's gain above the floor that goes to the DAO.
    uint256 public constant CUT_BPS = 2000;
    /// @notice How many steps above the floor the DAO must sell at.
    uint256 public constant DAO_MIN_STEPS = 2;
    uint256 internal constant UNIT = 1e18;

    /// @notice What every price is paid in.
    IERC20 public immutable currency;
    /// @notice The smallest price step, per whole unit, used while 1% of the floor is smaller (an empty treasury).
    uint256 public immutable minStep;

    struct Round {
        address dao;
        address shares;
        uint64 opensAt;
        uint64 closesAt;
        /// @dev Price per whole unit at step 0, and per step.
        uint128 floor;
        uint128 step;
        /// @dev Units offered and units bid, in all.
        uint256 asked;
        uint256 wanted;
        bool settled;
        /// @dev True when sellers at the price are the side that shares; false when buyers are.
        bool sellersShare;
        uint16 price;
        uint256 volume;
        /// @dev At the price, the sharing side's units in all, what they get in all, and how much of it was claimed.
        uint256 marginTotal;
        uint256 marginGets;
        uint256 marginClaimed;
        /// @dev A funding round (D133): the funding-terms contract that holds the tranche, and whether its count is in.
        bool funding;
        bool fundingDone;
        address terms;
    }

    struct Order {
        uint128 amount;
        uint16 step;
        bool claimed;
    }

    uint256 public roundCount;
    mapping(uint256 => Round) public rounds;
    /// @notice Each DAO's latest round between holders, and its latest funding round, or 0.
    mapping(address => uint256) public lastRound;
    mapping(address => uint256) public lastFunding;
    mapping(uint256 => mapping(address => Order)) public sells;
    mapping(uint256 => mapping(address => Order)) public bids;
    /// @dev Per round, units offered and bid by step, as trees of running totals.
    mapping(uint256 => mapping(uint256 => uint256)) private askTree;
    mapping(uint256 => mapping(uint256 => uint256)) private bidTree;
    bool private entered;

    error InvalidSetup();
    error Reentrancy();
    error NotNamed();
    error TooSoon(uint64 at);
    error NobodyCanLeave();
    error UnknownRound(uint256 id);
    error BiddingOver(uint256 id);
    error BiddingOpen(uint256 id);
    error SettleOver(uint256 id);
    error AlreadySettled(uint256 id);
    error BadStep(uint256 step);
    error BadAmount();
    error AlreadyOrdered();
    error NoOrder();
    error WrongPrice(uint256 step);
    error NotYet(uint64 at);
    error NothingToClaim();
    error ShortTransfer(uint256 expected, uint256 received);
    error BadToken(address token);
    error NotForFunding();
    error BelowFloor(uint256 floor);

    event RoundOpened(uint256 indexed id, address indexed dao, uint256 floor, uint256 step, uint64 closesAt);
    event SellPlaced(uint256 indexed id, address indexed seller, uint256 amount, uint256 step);
    event BidPlaced(uint256 indexed id, address indexed buyer, uint256 amount, uint256 step, uint256 escrow);
    event SellCancelled(uint256 indexed id, address indexed seller, bool left);
    event BidCancelled(uint256 indexed id, address indexed buyer);
    event Settled(uint256 indexed id, uint256 step, uint256 price, uint256 volume, bool sellersShare);
    event Claimed(uint256 indexed id, address indexed who, uint256 units, uint256 money, uint256 cut, bool left);

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(IERC20 currency_, uint256 minStep_) {
        if (address(currency_).code.length == 0 || minStep_ == 0 || minStep_ > type(uint64).max) {
            revert InvalidSetup();
        }
        currency = currency_;
        minStep = minStep_;
    }

    // ---- opening -------------------------------------------------------------------------------------------------

    /// @notice Open `dao`'s next round, a week after its last one opened. Anyone may call it.
    function open(address dao) external nonReentrant returns (uint256 id) {
        address shares = IRoundDao(dao).shares();
        if (IRoundShares(shares).exitExchange() != address(this)) revert NotNamed();
        uint256 last = lastRound[dao];
        if (last != 0) {
            uint64 at = rounds[last].opensAt + EVERY;
            if (block.timestamp < at) revert TooSoon(at);
        }
        id = _openRound(dao, shares);
        lastRound[dao] = id;
    }

    /// @notice Open a funding round for `dao`: what is left of the tranche its funding terms authorised, offered at no
    /// less than the tranche's least price and two steps above the floor. A week after its last funding round opened;
    /// anyone may call it.
    function openFunding(address dao) external nonReentrant returns (uint256 id) {
        if (IRoundShares(IRoundDao(dao).shares()).exitExchange() != address(this)) revert NotNamed();
        uint256 last = lastFunding[dao];
        if (last != 0) {
            Round storage prev = rounds[last];
            uint64 at = prev.opensAt + EVERY;
            if (block.timestamp < at) revert TooSoon(at);
            // A void earlier round gives its tranche back first.
            _finishFunding(prev);
        }
        address terms = IRoundFactory(IRoundPolicy(IRoundDao(dao).votingWeight()).mandateFactory()).fundingTerms();
        (uint256 units, uint256 least, address token) = IRoundFunding(terms).reserve(dao);
        id = _openRound(dao, token);
        lastFunding[dao] = id;
        Round storage r = rounds[id];
        r.funding = true;
        r.terms = terms;
        uint256 lowest = DAO_MIN_STEPS;
        if (least > r.floor) {
            uint256 atLeast = (least - r.floor + r.step - 1) / r.step;
            if (atLeast > lowest) lowest = atLeast;
        }
        if (lowest >= STEPS || units > type(uint128).max) revert BadStep(lowest);
        sells[id][terms] = Order(uint128(units), uint16(lowest), false);
        r.asked = units;
        _add(askTree[id], lowest, units);
        emit SellPlaced(id, terms, units, lowest);
    }

    function _openRound(address dao, address token) private returns (uint256 id) {
        uint256 floor = floorOf(dao);
        uint256 step = floor * STEP_BPS / 10_000;
        if (step < minStep) step = minStep;
        if (floor > type(uint128).max || step > type(uint64).max) revert InvalidSetup();
        id = ++roundCount;
        Round storage r = rounds[id];
        r.dao = dao;
        r.shares = token;
        r.opensAt = uint64(block.timestamp);
        r.closesAt = uint64(block.timestamp) + BIDDING;
        r.floor = uint128(floor);
        r.step = uint128(step);
        emit RoundOpened(id, dao, floor, step, r.closesAt);
    }

    /// @notice What leaving `dao` pays per whole unit in this contract's currency now: the treasury's balance over the
    /// units that can leave (all Shares and Loot, less the DAO's own and those a milestone lock holds back).
    function floorOf(address dao) public view returns (uint256) {
        IERC20 shares = IERC20(IRoundDao(dao).shares());
        IERC20 loot = IERC20(IRoundDao(dao).loot());
        uint256 units = shares.totalSupply() + loot.totalSupply() - shares.balanceOf(dao) - loot.balanceOf(dao);
        address guard = IRoundShares(address(shares)).lockGuard();
        if (guard != address(0)) units -= IRoundLockGuard(guard).totalLocked();
        if (units == 0) revert NobodyCanLeave();
        return currency.balanceOf(dao) * UNIT / units;
    }

    // ---- orders ----------------------------------------------------------------------------------------------------

    /// @notice Offer `amount` of your Shares in round `id`, at no less than price step `lowest`. The Shares are held here
    /// until you cancel (during bidding) or claim.
    function sell(uint256 id, uint256 amount, uint256 lowest) external nonReentrant {
        Round storage r = _bidding(id);
        if (r.funding) revert NotForFunding();
        if (amount == 0 || amount > type(uint128).max) revert BadAmount();
        if (lowest >= STEPS || (msg.sender == r.dao && lowest < DAO_MIN_STEPS)) revert BadStep(lowest);
        Order storage o = sells[id][msg.sender];
        if (o.amount != 0) revert AlreadyOrdered();
        o.amount = uint128(amount);
        o.step = uint16(lowest);
        r.asked += amount;
        _add(askTree[id], lowest, amount);
        emit SellPlaced(id, msg.sender, amount, lowest);
        IERC20 shares = IERC20(r.shares);
        uint256 before = shares.balanceOf(address(this));
        shares.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = shares.balanceOf(address(this)) - before;
        if (received != amount) revert ShortTransfer(amount, received);
    }

    /// @notice Bid for `amount` units in round `id`, at no more than price step `highest`. The money for all of it at
    /// that price is held here until you cancel (during bidding) or claim.
    function bid(uint256 id, uint256 amount, uint256 highest) external nonReentrant {
        Round storage r = _bidding(id);
        if (amount == 0 || amount > type(uint128).max) revert BadAmount();
        if (highest >= STEPS) revert BadStep(highest);
        uint256 escrow = _up(amount * priceAt(id, highest), UNIT);
        if (escrow == 0) revert BadStep(highest);
        Order storage o = bids[id][msg.sender];
        if (o.amount != 0) revert AlreadyOrdered();
        o.amount = uint128(amount);
        o.step = uint16(highest);
        r.wanted += amount;
        _add(bidTree[id], highest, amount);
        emit BidPlaced(id, msg.sender, amount, highest, escrow);
        uint256 before = currency.balanceOf(address(this));
        currency.safeTransferFrom(msg.sender, address(this), escrow);
        uint256 received = currency.balanceOf(address(this)) - before;
        if (received != escrow) revert ShortTransfer(escrow, received);
    }

    /// @notice Take your offer out of round `id` while bidding is open: the Shares come back, or with `leaveWith` naming
    /// tokens, you leave the DAO with them at once, as leaving pays.
    function cancelSell(uint256 id, address[] calldata leaveWith) external nonReentrant {
        Round storage r = _bidding(id);
        if (r.funding) revert NotForFunding();
        Order storage o = sells[id][msg.sender];
        uint256 amount = o.amount;
        if (amount == 0) revert NoOrder();
        r.asked -= amount;
        _sub(askTree[id], o.step, amount);
        delete sells[id][msg.sender];
        emit SellCancelled(id, msg.sender, leaveWith.length != 0);
        _giveUnits(r, msg.sender, amount, leaveWith);
    }

    /// @notice Take your bid out of round `id` while bidding is open; its money comes back.
    function cancelBid(uint256 id) external nonReentrant {
        Round storage r = _bidding(id);
        Order storage o = bids[id][msg.sender];
        uint256 amount = o.amount;
        if (amount == 0) revert NoOrder();
        uint256 escrow = _up(amount * priceAt(id, o.step), UNIT);
        r.wanted -= amount;
        _sub(bidTree[id], o.step, amount);
        delete bids[id][msg.sender];
        emit BidCancelled(id, msg.sender);
        currency.safeTransfer(msg.sender, escrow);
    }

    // ---- settling --------------------------------------------------------------------------------------------------

    /// @notice Settle round `id` at price step `step`, within `SETTLE_WINDOW` after bidding. Anyone may call it; the step
    /// is checked, and only the right one is accepted (`clearingStep` finds it).
    function settle(uint256 id, uint256 step) external nonReentrant {
        Round storage r = _round(id);
        if (block.timestamp < r.closesAt) revert BiddingOpen(id);
        if (block.timestamp >= uint256(r.closesAt) + SETTLE_WINDOW) revert SettleOver(id);
        if (r.settled) revert AlreadySettled(id);
        if (step >= STEPS) revert BadStep(step);
        if (r.funding) {
            // Units are created only at two steps above what leaving pays now, so a sale never lowers it.
            uint256 floorNow = floorOf(r.dao);
            if (priceAt(id, step) * 10_000 < floorNow * (10_000 + STEP_BPS * DAO_MIN_STEPS)) revert BelowFloor(floorNow);
        }
        uint256 supply = supplyAt(id, step);
        uint256 demand = demandAt(id, step);
        if (demand >= supply) {
            // The highest step at which bids cover what is offered, and the step above trades no more.
            uint256 demandUp;
            if (step + 1 < STEPS) {
                demandUp = demandAt(id, step + 1);
                if (demandUp >= supplyAt(id, step + 1) || demandUp > supply) revert WrongPrice(step);
            }
            r.volume = supply;
            r.marginTotal = demand - demandUp;
            r.marginGets = supply - demandUp;
        } else {
            // One step above the highest step at which bids cover what is offered, because it trades more.
            uint256 supplyDown;
            if (step != 0) {
                supplyDown = supplyAt(id, step - 1);
                if (demandAt(id, step - 1) < supplyDown || demand <= supplyDown) revert WrongPrice(step);
            }
            r.volume = demand;
            r.sellersShare = true;
            r.marginTotal = supply - supplyDown;
            r.marginGets = demand - supplyDown;
        }
        r.settled = true;
        r.price = uint16(step);
        emit Settled(id, step, priceAt(id, step), r.volume, r.sellersShare);
        _finishFunding(r);
    }

    // ---- claiming --------------------------------------------------------------------------------------------------

    /// @notice Pay `who` what round `id` owes them: money from what they sold, Shares they bought, and whatever did not
    /// fill. After the round is settled, or once it is void. Anyone may call it; it only pays `who`.
    function claim(uint256 id, address who) external nonReentrant {
        _claim(id, who, new address[](0));
    }

    /// @notice Claim your part of round `id`, leaving the DAO with the units you would collect (unsold Shares, or Shares
    /// you bought) instead of taking them: you get what leaving pays in `leaveWith`'s tokens.
    function claimAndLeave(uint256 id, address[] calldata leaveWith) external nonReentrant {
        if (leaveWith.length == 0) revert BadToken(address(0));
        _claim(id, msg.sender, leaveWith);
    }

    // ---- reads -----------------------------------------------------------------------------------------------------

    /// @notice The price of step `step` in round `id`, per whole unit.
    function priceAt(uint256 id, uint256 step) public view returns (uint256) {
        Round storage r = rounds[id];
        return uint256(r.floor) + step * r.step;
    }

    /// @notice Units offered at step `step` or below.
    function supplyAt(uint256 id, uint256 step) public view returns (uint256) {
        return _prefix(askTree[id], step);
    }

    /// @notice Units bid at step `step` or above.
    function demandAt(uint256 id, uint256 step) public view returns (uint256) {
        uint256 below = step == 0 ? 0 : _prefix(bidTree[id], step - 1);
        return rounds[id].wanted - below;
    }

    /// @notice The step `settle` accepts for round `id` as its orders stand, how much it trades, and whether sellers at
    /// that step are the side that shares.
    function clearingStep(uint256 id) external view returns (uint256 step, uint256 volume, bool sellersShare) {
        // The highest step at which bids cover what is offered: true up to a point, then false.
        uint256 lo;
        uint256 hi = STEPS;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (demandAt(id, mid) >= supplyAt(id, mid)) lo = mid + 1;
            else hi = mid;
        }
        if (lo == 0) return (0, demandAt(id, 0), true);
        uint256 highest = lo - 1;
        uint256 covered = supplyAt(id, highest);
        uint256 above = highest + 1 < STEPS ? demandAt(id, highest + 1) : 0;
        return above > covered ? (highest + 1, above, true) : (highest, covered, false);
    }

    /// @notice Whether round `id` is void: bidding ended, nobody settled it in time, and everyone takes back theirs.
    function isVoid(uint256 id) public view returns (bool) {
        Round storage r = rounds[id];
        return r.dao != address(0) && !r.settled && block.timestamp >= uint256(r.closesAt) + SETTLE_WINDOW;
    }

    // ---- inside ----------------------------------------------------------------------------------------------------

    function _round(uint256 id) private view returns (Round storage r) {
        r = rounds[id];
        if (r.dao == address(0)) revert UnknownRound(id);
    }

    function _bidding(uint256 id) private view returns (Round storage r) {
        r = _round(id);
        if (block.timestamp >= r.closesAt) revert BiddingOver(id);
    }

    function _claim(uint256 id, address who, address[] memory leaveWith) private {
        Round storage r = _round(id);
        bool void_ = !r.settled;
        if (void_ && block.timestamp < uint256(r.closesAt) + SETTLE_WINDOW) {
            revert NotYet(r.closesAt + SETTLE_WINDOW);
        }
        uint256 price = priceAt(id, r.price);
        uint256 units;
        uint256 money;
        uint256 cut;
        uint256 toTreasury;
        bool any;
        if (r.funding) {
            if (leaveWith.length != 0) revert NotForFunding();
            _finishFunding(r);
        }
        Order storage s = sells[id][who];
        // A funding round's only offer is the tranche, which nobody claims: its units are created at the buyers' claims.
        if (!r.funding && s.amount != 0 && !s.claimed) {
            any = true;
            s.claimed = true;
            uint256 filled = void_ ? 0 : _sellFilled(r, s);
            units += s.amount - filled;
            if (filled != 0) {
                uint256 value = filled * price / UNIT;
                if (who != r.dao) cut = filled * (price - r.floor) * CUT_BPS / (UNIT * 10_000);
                money += value - cut;
            }
        }
        Order storage b = bids[id][who];
        if (b.amount != 0 && !b.claimed) {
            any = true;
            b.claimed = true;
            uint256 escrow = _up(uint256(b.amount) * priceAt(id, b.step), UNIT);
            uint256 filled = void_ ? 0 : _bidFilled(r, b);
            uint256 cost = _up(filled * price, UNIT);
            units += filled;
            money += escrow - cost;
            if (r.funding) toTreasury = cost;
        }
        if (!any) revert NothingToClaim();
        emit Claimed(id, who, units, money, r.funding ? toTreasury : cut, leaveWith.length != 0);
        if (cut != 0) currency.safeTransfer(r.dao, cut);
        if (toTreasury != 0) currency.safeTransfer(r.dao, toTreasury);
        if (money != 0) currency.safeTransfer(who, money);
        if (units == 0) return;
        if (r.funding) IRoundFunding(r.terms).deliver(r.dao, who, units);
        else _giveUnits(r, who, units, leaveWith);
    }

    /// @dev Tell the funding terms how much of a funding round's tranche sold, once: at settling, or when a void round is
    /// next touched. Not before a round is settled or void.
    function _finishFunding(Round storage r) private {
        if (!r.funding || r.fundingDone) return;
        if (!r.settled && block.timestamp < uint256(r.closesAt) + SETTLE_WINDOW) return;
        r.fundingDone = true;
        IRoundFunding(r.terms).settle(r.dao, r.settled ? r.volume : 0);
    }

    /// @dev Units a sell order sold: all of it below the price, a share of what is left at the price when sellers are the
    /// side that shares, none above.
    function _sellFilled(Round storage r, Order storage s) private returns (uint256) {
        if (s.step < r.price) return s.amount;
        if (s.step > r.price) return 0;
        return r.sellersShare ? _margin(r, s.amount) : s.amount;
    }

    /// @dev Units a bid bought: all of it above the price, a share of what is left at the price when buyers are the side
    /// that shares, none below.
    function _bidFilled(Round storage r, Order storage b) private returns (uint256) {
        if (b.step > r.price) return b.amount;
        if (b.step < r.price) return 0;
        return r.sellersShare ? b.amount : _margin(r, b.amount);
    }

    /// @dev One order's share at the price, by the running total of what that side has claimed, so the shares always
    /// add up to exactly what that side gets, and none exceeds its order.
    function _margin(Round storage r, uint256 amount) private returns (uint256) {
        uint256 claimedBefore = r.marginClaimed;
        uint256 claimedAfter = claimedBefore + amount;
        r.marginClaimed = claimedAfter;
        return claimedAfter * r.marginGets / r.marginTotal - claimedBefore * r.marginGets / r.marginTotal;
    }

    /// @dev Hand `who` their units: as Shares, or, with `leaveWith`, by leaving the DAO with them and passing on what
    /// leaving pays. Leaving needs nothing from the Shares' transfer rules, so it works even if the DAO stops naming this
    /// contract as its exchange.
    function _giveUnits(Round storage r, address who, uint256 units, address[] memory leaveWith) private {
        if (leaveWith.length == 0) {
            IERC20(r.shares).safeTransfer(who, units);
            return;
        }
        uint256[] memory before = new uint256[](leaveWith.length);
        for (uint256 i; i < leaveWith.length; ++i) {
            address token = leaveWith[i];
            if (token == address(0) || token == r.shares) revert BadToken(token);
            before[i] = IERC20(token).balanceOf(address(this));
        }
        IRoundDao(r.dao).ragequit(leaveWith, units, 0);
        for (uint256 i; i < leaveWith.length; ++i) {
            uint256 got = IERC20(leaveWith[i]).balanceOf(address(this)) - before[i];
            if (got != 0) IERC20(leaveWith[i]).safeTransfer(who, got);
        }
    }

    function _add(mapping(uint256 => uint256) storage tree, uint256 step, uint256 amount) private {
        for (uint256 i = step + 1; i <= STEPS; i += i & (~i + 1)) {
            tree[i] += amount;
        }
    }

    function _sub(mapping(uint256 => uint256) storage tree, uint256 step, uint256 amount) private {
        for (uint256 i = step + 1; i <= STEPS; i += i & (~i + 1)) {
            tree[i] -= amount;
        }
    }

    function _prefix(mapping(uint256 => uint256) storage tree, uint256 step) private view returns (uint256 sum) {
        for (uint256 i = step + 1; i != 0; i -= i & (~i + 1)) {
            sum += tree[i];
        }
    }

    function _up(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
