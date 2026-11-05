// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISecondaryPolicy} from "./interfaces/ISecondaryPolicy.sol";

/// @notice The bound Shares of a listed DAO, used for the two birth facts only. Types stay addresses so
/// the listing never imports, or depends on, the DAO's whole surface.
interface IMarketShareToken {
    function DAO() external view returns (address);
    function transferExempt() external view returns (address);
}

/// @title SecondaryMarket
/// @notice A per-DAO secondary listing (docs/v3-review/SECONDARY-LISTING-SPEC.md), created only by its
/// `SecondaryMarketFactory` for the kit that installed this market as the Shares' birth `transferExempt`
/// endpoint: holders offer existing Shares, buyers bid a fixed quote token, and a weekly round clears at
/// one price over an explicit frozen grid. A development candidate, not production terms.
///
/// What this market deliberately is NOT — the D179 regressions, mapped to shape:
/// - no funding, minting, DAO-inventory offer, or arbitrary-token `claimAndLeave` entrypoint: holders
///   sell only Shares they already hold; the DAO, the factory and this market can never sell inventory;
/// - no shared escrow: one market holds one DAO's tokens, and every payout is bounded by its own
///   order's wallet-validated escrow and the round ledger (`quoteIn`/`sharesIn`), so no round can touch
///   another market's, another round's or another order's money;
/// - no balance-delta or payout-module arithmetic: proceeds, refunds and returns are exact integers of
///   whole lots, and donations nobody ordered stay unattributed and uncollectable here;
/// - no treasury floor: each round freezes explicit per-lot prices; an empty treasury is irrelevant.
///
/// Round mechanics: the DAO decides once whether the listing exists and its terms (exact per-lot price
/// bounds, and a grid all of whose levels are integers). Anyone opens a round at least a week after the
/// last one; the round freezes bounds, grid, timing, lot size and its fixed zero fee before any order.
/// For three days sellers offer whole lots (escrowing exactly `lots * lotSize` Shares, measured against
/// this market's balance, only within `policy.saleCapacity`) at no less than a chosen grid level, and
/// buyers bid whole lots at no more than a chosen level, escrowing exactly `lots * limitPrice`. Anyone
/// settles within two days by the one deterministic result: the lowest grid level whose uniform price
/// matches the most lots. Every crossing order on the short side fills whole; all crossing orders on the
/// long side (including any strictly better than the price) share the matched amount pro rata in whole
/// lots, and leftover lots go to the lowest order ids, so the buyers' filled lots add up exactly to the
/// sellers'. Settle moves no Shares: it books the fills and tells the policy which escrow was sold. A
/// seller's unsold remainder then returns to the original seller by `claimShares` (`policy.prepareEscrowReturn`
/// then the transfer, one seller per transaction, callable by anyone, with no deadline), exactly as a void
/// round's whole offer does; buyers claim their Shares fresh (no inherited seller age) whenever; and every
/// quote payout — proceeds and refunds alike — is an order's own recorded right, payable by `claimQuote` on
/// demand. A refusing or paused quote token therefore never blocks collecting, settling, cancelling or any
/// Shares return, but `claimQuote` reverts, and quote payouts wait, until the token lets the transfer through.
///
/// Disabling the listing stops new rounds, offers and bids only. Settle, refunds, returns and claims
/// always stay available, even when the DAO clears or replaces `Shares.exitExchange`: the Shares pass
/// the transfer lock only by the birth fact `transferExempt == market`, set once by the provisioning
/// call — no approval is stored, no operator power exists, and nothing outside this market (nor the
/// DAO) moves these Shares except holders themselves. Force-sent ETH and unattributed token donations
/// have no exit path here, by the same deliberate asymmetry as every burn-paved surface in this kit.
contract SecondaryMarket {
    using SafeERC20 for IERC20;

    /// @notice The most grid levels a round has (the clearing pass is bounded by this).
    uint256 public constant MAX_LEVELS = 64;
    /// @notice The most active sellers one round accepts. Settle makes at most one policy call per seller
    /// (the sold-escrow hook) and no token transfer: measured against the real policy with 32 sellers, 32
    /// buyers and 64 levels, the heaviest legal settle costs about 3.6M gas (about 21% of 2**24 = 16,777,216),
    /// so it fits one transaction on chains that enforce the 2**24 per-transaction cap (EIP-7825). Each
    /// seller's unsold-return, the heavy part (about 0.5M to 0.7M gas), is that seller's own `claimShares`.
    uint256 public constant MAX_ACTIVE_SELLERS = 32;
    /// @notice The most active buyers one round accepts.
    uint256 public constant MAX_ACTIVE_BUYERS = 32;
    /// @notice How long a round takes orders.
    uint256 public constant BIDDING = 3 days;
    /// @notice How long after bidding anyone can settle a round; after that it is void.
    uint256 public constant SETTLE_WINDOW = 2 days;
    /// @notice The least time between this market's round openings.
    uint256 public constant EVERY = 7 days;
    /// @notice The most lots one order holds, so every lots-by-anything product stays far inside 2**256.
    uint256 public constant MAX_ORDER_LOTS = 1 << 96;
    /// @notice The most Shares base units one lot is, same reason. Terms stay integers end to end.
    uint256 public constant MAX_LOT_SIZE = 1 << 128;
    /// @notice The candidate fee: zero, fixed, and never a production promise.
    uint256 public constant FEE_BPS = 0;

    /// @notice The factory that created this market. It is this market's only provenance check, and it
    /// verifies the DAO, Shares, policy, quote and lot-size bindings before deploying.
    address public immutable factory;
    /// @notice The one DAO this market serves.
    address public immutable dao;
    /// @notice The one Shares token this market escrows and returns.
    address public immutable sharesToken;
    /// @notice The one policy this market measures sale capacity by, reports escrow flows to and
    /// preserves seller age through.
    ISecondaryPolicy public immutable policy;
    /// @notice What every price is paid in: one fixed ERC-20, validated by exact balance deltas.
    IERC20 public immutable quote;
    /// @notice How many raw Shares base units one lot is. Every price is quote base units per lot; no
    /// rounding drifts between a seller's and a buyer's arithmetic, only in whole lots.
    uint256 public immutable lotSize;

    /// @notice The listing's existence and terms, decided by the DAO. The grid's step is derived at open.
    struct Terms {
        bool enabled;
        uint128 minPrice;
        uint128 maxPrice;
        uint32 levels;
    }

    /// @notice One round, frozen at open: its bounds and grid, its times, and its matching result.
    struct Round {
        uint128 minPrice;
        uint128 step;
        uint32 levels;
        uint64 opensAt;
        uint64 closesAt;
        uint64 settleDeadline;
        uint256 asked;
        uint256 wanted;
        uint16 price;
        bool settled;
        bool sellersShare;
    }

    /// @notice One seller's offer in one round. `filled` is only ever written by settle. A cancelled
    /// offer is gone from the lists at once, and so never counts in clearing.
    struct SellOrder {
        uint128 lots;
        uint16 minStep;
        uint128 filled;
        uint64 orderId;
        bool escrowReturned;
        bool proceedsPaid;
    }

    /// @notice One buyer's bid in one round. A cancelled bid never counts in clearing and claims the
    /// same full escrow refund a void round pays, so cancelled credits stay withdrawable forever.
    struct BuyOrder {
        uint128 lots;
        uint16 maxStep;
        uint128 filled;
        uint64 orderId;
        bool cancelled;
        bool sharesPaid;
        bool refundDone;
    }

    Terms public listing;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => SellOrder)) public sells;
    mapping(uint256 => mapping(address => BuyOrder)) public bids;
    /// @dev The round's active sellers and buyers, in stable ascending order-id order (appended only,
    /// removals never reorder the rest), bounded by the caps.
    mapping(uint256 => address[]) internal _sellerList;
    mapping(uint256 => address[]) internal _buyerList;
    /// @notice Quote escrowed into round `id` and validated exactly, minus what was pushed out of it.
    mapping(uint256 => uint256) public quoteIn;
    /// @notice Shares escrowed into round `id` and validated exactly, minus returns and Share payouts.
    mapping(uint256 => uint256) public sharesIn;
    uint256 public roundCount;
    uint256 public lastOpenAt;
    uint256 public nextOrderId;
    bool private _entered;

    event ListingConfigured(bool enabled, uint128 minPrice, uint128 maxPrice, uint32 levels);
    event RoundOpened(uint256 indexed id, uint128 minPrice, uint128 maxPrice, uint32 levels, uint64 closesAt);
    event SharesOffered(uint256 indexed id, address indexed seller, uint128 lots, uint16 minStep, uint256 orderId);
    event BidPlaced(
        uint256 indexed id, address indexed buyer, uint128 lots, uint16 maxStep, uint256 escrow, uint256 orderId
    );
    event OfferCancelled(uint256 indexed id, address indexed seller, uint128 lots);
    event BidCancelled(uint256 indexed id, address indexed buyer, uint128 lots);
    event Settled(uint256 indexed id, uint256 price, uint256 lots, bool sellersShare);
    event SharesClaimed(uint256 indexed id, address indexed who, uint256 amount);
    event QuoteClaimed(uint256 indexed id, address indexed who, uint256 amount);

    error Reentrancy();
    error NotDao();
    error InvalidSetup();
    error InvalidTerms();
    error ListingNotEnabled();
    error DaoCannotSell();
    error TooSoon(uint256 at);
    error UnknownRound(uint256 id);
    error BiddingOver(uint256 id);
    error BiddingOpen(uint256 id);
    error SettleOver(uint256 id);
    error AlreadySettled(uint256 id);
    error BadLots();
    error BadStep(uint256 step);
    error BadAmount();
    error OneOrderPerSide();
    error TooManySellers();
    error TooManyBuyers();
    error NoCapacity();
    error NoOrder();
    error NothingToClaim();
    error LedgerShort();

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address dao_, address shares_, ISecondaryPolicy policy_, IERC20 quote_, uint256 lotSize_) {
        if (
            msg.sender.code.length == 0 || dao_.code.length == 0 || shares_.code.length == 0
                || address(quote_).code.length == 0
        ) revert InvalidSetup();
        if (lotSize_ == 0 || lotSize_ > MAX_LOT_SIZE) revert InvalidSetup();
        if (IMarketShareToken(shares_).DAO() != dao_) revert InvalidSetup();
        // The provisioning call installed this market at the Shares' birth, once and irreplaceable: every
        // escrow in and out moves by this one fact, not by any operator power.
        if (IMarketShareToken(shares_).transferExempt() != address(this)) revert InvalidSetup();
        if (policy_.dao() != dao_ || policy_.market() != address(this)) revert InvalidSetup();
        factory = msg.sender;
        dao = dao_;
        sharesToken = shares_;
        policy = policy_;
        quote = quote_;
        lotSize = lotSize_;
    }

    // ---- the listing --------------------------------------------------------------------------------------------

    /// @notice The DAO decides whether a listing exists and its terms: exact per-lot price bounds and
    /// a fully divisible grid, so every level is an integer and no seller- or buyer-side rounding drifts
    /// apart. Freezing happens per round at open, so no later change reaches a live round, and
    /// disabling can never reach settlement, refunds, returns or claims.
    function configureListing(bool enabled, uint128 minPrice, uint128 maxPrice, uint32 levels) external {
        if (msg.sender != dao) revert NotDao();
        if (!enabled) {
            listing = Terms(false, 0, 0, 0);
        } else {
            if (minPrice == 0 || maxPrice <= minPrice || levels == 0 || levels > MAX_LEVELS) revert InvalidTerms();
            uint128 span = maxPrice - minPrice;
            if (span % levels != 0) revert InvalidTerms();
            listing = Terms(true, minPrice, maxPrice, levels);
        }
        emit ListingConfigured(enabled, minPrice, maxPrice, levels);
    }

    /// @notice Open the next round from the current listing, at least `EVERY` after the last open.
    /// Anyone may call it; the round freezes its bounds, grid, lot size, timing and zero fee now.
    function openRound() external returns (uint256 id) {
        Terms memory t = listing;
        if (!t.enabled) revert ListingNotEnabled();
        uint64 at = uint64(block.timestamp);
        if (lastOpenAt != 0 && block.timestamp < lastOpenAt + EVERY) revert TooSoon(lastOpenAt + EVERY);
        lastOpenAt = uint256(at);
        id = ++roundCount;
        uint128 step = uint128((uint256(t.maxPrice) - uint256(t.minPrice)) / uint256(t.levels));
        rounds[id] = Round({
            minPrice: t.minPrice,
            step: step,
            levels: t.levels,
            opensAt: at,
            closesAt: at + uint64(BIDDING),
            settleDeadline: at + uint64(BIDDING + SETTLE_WINDOW),
            asked: 0,
            wanted: 0,
            price: 0,
            settled: false,
            sellersShare: false
        });
        emit RoundOpened(id, t.minPrice, t.maxPrice, t.levels, at + uint64(BIDDING));
    }

    // ---- orders ---------------------------------------------------------------------------------------------------

    /// @notice Offer `lots` whole lots in round `id` at no less than grid level `minStep`. The Shares —
    /// exactly `lots * lotSize`, measured against this market's balance — are held here until you cancel
    /// during bidding, the round settles, or it goes void. The DAO can never sell inventory, and the
    /// policy's `saleCapacity` bounds what any holder may offer.
    function sell(uint256 id, uint128 lots, uint16 minStep) external nonReentrant {
        if (!listing.enabled) revert ListingNotEnabled();
        Round storage r = _round(id);
        if (block.timestamp >= r.closesAt) revert BiddingOver(id);
        if (msg.sender == dao) revert DaoCannotSell();
        if (lots == 0 || lots > MAX_ORDER_LOTS) revert BadLots();
        if (minStep > r.levels) revert BadStep(minStep);
        if (sells[id][msg.sender].lots != 0) revert OneOrderPerSide();
        if (_sellerList[id].length >= MAX_ACTIVE_SELLERS) revert TooManySellers();
        uint256 amount = uint256(lots) * lotSize;
        if (policy.saleCapacity(msg.sender) < amount) revert NoCapacity();
        uint256 before = IERC20(sharesToken).balanceOf(address(this));
        IERC20(sharesToken).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(sharesToken).balanceOf(address(this));
        if (received != before + amount) revert BadAmount();
        uint256 oid = ++nextOrderId;
        sells[id][msg.sender] = SellOrder({
            lots: lots, minStep: minStep, filled: 0, orderId: uint64(oid), escrowReturned: false, proceedsPaid: false
        });
        r.asked += lots;
        sharesIn[id] += amount;
        _sellerList[id].push(msg.sender);
        emit SharesOffered(id, msg.sender, lots, minStep, oid);
    }

    /// @notice Bid for `lots` whole lots in round `id` at no more than grid level `maxStep`. The quote —
    /// exactly `lots * limitPrice` at that level, measured against this market's balance — is held here
    /// until you cancel during bidding (recording, then claiming, the refund), the round settles, or
    /// you claim what you bought.
    function bid(uint256 id, uint128 lots, uint16 maxStep) external nonReentrant {
        if (!listing.enabled) revert ListingNotEnabled();
        Round storage r = _round(id);
        if (block.timestamp >= r.closesAt) revert BiddingOver(id);
        if (lots == 0 || lots > MAX_ORDER_LOTS) revert BadLots();
        if (maxStep > r.levels) revert BadStep(maxStep);
        if (bids[id][msg.sender].lots != 0) revert OneOrderPerSide();
        if (_buyerList[id].length >= MAX_ACTIVE_BUYERS) revert TooManyBuyers();
        uint256 escrow = uint256(lots) * priceAt(id, maxStep);
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), escrow);
        uint256 received = quote.balanceOf(address(this));
        if (received != before + escrow) revert BadAmount();
        uint256 oid = ++nextOrderId;
        bids[id][msg.sender] = BuyOrder({
            lots: lots,
            maxStep: maxStep,
            filled: 0,
            orderId: uint64(oid),
            cancelled: false,
            sharesPaid: false,
            refundDone: false
        });
        r.wanted += lots;
        quoteIn[id] += escrow;
        _buyerList[id].push(msg.sender);
        emit BidPlaced(id, msg.sender, lots, maxStep, escrow, oid);
    }

    /// @notice Take your offer out of round `id` while bidding is open: the policy prepares the escrow
    /// return and the unsold Shares go back to you inside that same transaction. A cancelled offer
    /// immediately stops counting in the round and its clearing.
    function cancelSell(uint256 id) external nonReentrant {
        Round storage r = _round(id);
        if (block.timestamp >= r.closesAt) revert BiddingOver(id);
        SellOrder storage o = sells[id][msg.sender];
        uint128 lots = o.lots;
        if (lots == 0) revert NoOrder();
        r.asked -= lots;
        uint256 amount = uint256(lots) * lotSize;
        delete sells[id][msg.sender];
        _removeFromList(id, msg.sender, false);
        if (sharesIn[id] < amount) revert LedgerShort();
        sharesIn[id] -= amount;
        // Prepare then move, in the same transaction, so the policy's escrow book and the market's real
        // balance move together or the whole cancellation reverts.
        policy.prepareEscrowReturn(msg.sender, amount);
        IERC20(sharesToken).safeTransfer(msg.sender, amount);
        emit OfferCancelled(id, msg.sender, lots);
    }

    /// @notice Take your bid out of round `id` while bidding is open. The refund is recorded as your
    /// order's own right — not pushed right now — and `claimQuote(id, you)` pays it whenever the quote
    /// token lets it through, even after the round closes or the listing turns off.
    function cancelBid(uint256 id) external nonReentrant {
        Round storage r = _round(id);
        if (block.timestamp >= r.closesAt) revert BiddingOver(id);
        BuyOrder storage o = bids[id][msg.sender];
        uint128 lots = o.lots;
        if (lots == 0) revert NoOrder();
        r.wanted -= lots;
        o.cancelled = true;
        _removeFromList(id, msg.sender, true);
        emit BidCancelled(id, msg.sender, lots);
    }

    // ---- settling -------------------------------------------------------------------------------------------------

    /// @notice Settle round `id` within `SETTLE_WINDOW` after bidding, by the one deterministic result:
    /// the lowest grid level whose uniform price matches the most whole lots. Every crossing order on
    /// the short side fills whole; all crossing orders on the long side (including any strictly better
    /// than the price) share the matched amount pro rata, leftover lots going to the lowest order ids,
    /// so the buyers' filled lots add up exactly to the sellers'. Settle only does the bounded
    /// bookkeeping — clearing, the fills, and the policy's sold-escrow hook, with no token transfer — so it
    /// fits one transaction at the heaviest legal round; each seller's unsold remainder is returned by
    /// `claimShares`. Anyone may call it; nobody settling in time means the round is void instead and
    /// claims pay everything back.
    function settle(uint256 id) external nonReentrant {
        Round storage r = _round(id);
        if (r.settled) revert AlreadySettled(id);
        if (block.timestamp < r.closesAt) revert BiddingOpen(id);
        if (block.timestamp >= r.settleDeadline) revert SettleOver(id);
        r.settled = true;
        Orders memory m = _ordersOf(id);
        (uint256 level, uint256 matched, bool sellersShare) = _clearing(m, r.levels);
        r.price = uint16(level);
        r.sellersShare = sellersShare;
        (uint256[] memory sFill, uint256[] memory bFill) = _allocate(m, level, matched, sellersShare);
        for (uint256 i; i < m.sLots.length; ++i) {
            address seller = _sellerList[id][i];
            SellOrder storage o = sells[id][seller];
            o.filled = uint128(sFill[i]);
            if (sFill[i] != 0) policy.consumeSoldEscrow(seller, uint256(sFill[i]) * lotSize);
        }
        for (uint256 i; i < m.bLots.length; ++i) {
            bids[id][_buyerList[id][i]].filled = uint128(bFill[i]);
        }
        emit Settled(id, priceAt(id, level), matched, sellersShare);
    }

    // ---- claiming -------------------------------------------------------------------------------------------------

    /// @notice Deliver round `id`'s Shares to `who`: what they bought — fresh, with no inherited seller
    /// age — and the seller's own unsold remainder back: the whole offer when a round went void, or the
    /// lots a settled round did not sell. `policy.prepareEscrowReturn` is called immediately before that
    /// transfer in the same transaction. Settle never returns Shares itself (that keeps the
    /// heaviest settle inside one transaction), so a part-filled seller's remainder waits here as the order's
    /// standing right, with no deadline. Anyone may call it; it only ever pays `who` exactly what that one
    /// order owes, and repeats never pay twice. A blocked transfer ends the call and the right stands for
    /// a repeat call later by anyone.
    function claimShares(uint256 id, address who) external nonReentrant {
        Round storage r = _round(id);
        bool isVoid = !r.settled && block.timestamp >= r.settleDeadline;
        bool due;
        SellOrder storage s = sells[id][who];
        // A void round never filled anything, so `filled` is 0 and the whole offer is unsold; a settled
        // round's `filled` was written by settle. A seller sold out whole has no remainder and no flag.
        uint256 unsold = (r.settled || isVoid) && s.lots != 0 && !s.escrowReturned ? s.lots - s.filled : 0;
        if (unsold != 0) {
            uint256 amount = unsold * lotSize;
            s.escrowReturned = true;
            policy.prepareEscrowReturn(who, amount);
            IERC20(sharesToken).safeTransfer(who, amount);
            if (sharesIn[id] < amount) revert LedgerShort();
            sharesIn[id] -= amount;
            due = true;
            emit SharesClaimed(id, who, amount);
        }
        BuyOrder storage b = bids[id][who];
        if (r.settled && b.lots != 0 && !b.sharesPaid && b.filled != 0) {
            uint256 amount = uint256(b.filled) * lotSize;
            b.sharesPaid = true;
            IERC20(sharesToken).safeTransfer(who, amount);
            if (sharesIn[id] < amount) revert LedgerShort();
            sharesIn[id] -= amount;
            due = true;
            emit SharesClaimed(id, who, amount);
        }
        if (!due) revert NothingToClaim();
    }

    /// @notice Pay round `id`'s quote debts to `who`: a seller's proceeds at the clearing price, a
    /// buyer's refund of everything above the clearing price, and a cancelled or void bid's whole
    /// escrow. Anyone may call it; every amount is bounded by that one order's own validated escrow, so
    /// nothing but this round's own intake ever moves. The flags go first so a repeat call cannot pay
    /// twice, and a refused transfer leaves the right standing for a later call by anyone.
    function claimQuote(uint256 id, address who) external nonReentrant {
        Round storage r = _round(id);
        bool isVoid = !r.settled && block.timestamp >= r.settleDeadline;
        if (!r.settled && !isVoid && !bids[id][who].cancelled) revert NothingToClaim();
        SellOrder storage s = sells[id][who];
        BuyOrder storage b = bids[id][who];
        uint256 amount;
        uint256 price = priceAt(id, r.price);
        // A seller's proceeds exist only once the round has settled: before that `filled` is still 0, and
        // marking the order paid at zero would burn what settlement later owes it — permanently, because
        // the only other claim path then reverts `NothingToClaim` (review F1). The seller branch therefore
        // runs only when the round is settled or void; until then only a cancelled bid's refund is paid.
        if ((r.settled || isVoid) && s.lots != 0 && !s.proceedsPaid) {
            s.proceedsPaid = true;
            amount += uint256(s.filled) * price;
        }
        if (b.lots != 0 && !b.refundDone) {
            uint256 escrow = uint256(b.lots) * priceAt(id, b.maxStep);
            uint256 consumed = uint256(b.filled) * price;
            if (consumed > escrow) revert LedgerShort();
            b.refundDone = true;
            amount += escrow - consumed;
        }
        if (amount == 0) revert NothingToClaim();
        if (quoteIn[id] < amount) revert LedgerShort();
        quoteIn[id] -= amount;
        quote.safeTransfer(who, amount);
        emit QuoteClaimed(id, who, amount);
    }

    // ---- reads ----------------------------------------------------------------------------------------------------

    /// @notice The quote base units of grid level `level` in round `id`, per one lot.
    function priceAt(uint256 id, uint256 level) public view returns (uint256) {
        Round storage r = _round(id);
        return uint256(r.minPrice) + level * uint256(r.step);
    }

    /// @notice Whether round `id` is void: bidding ended, nobody settled in time, and everything is
    /// still claimable as if nothing had sold — the seller's Shares back, the buyer's escrow back.
    function voided(uint256 id) public view returns (bool isVoid) {
        Round storage r = _round(id);
        isVoid = !r.settled && block.timestamp >= r.settleDeadline;
    }

    function roundSellers(uint256 id) external view returns (address[] memory owners) {
        owners = _sellerList[id];
    }

    function roundBuyers(uint256 id) external view returns (address[] memory owners) {
        owners = _buyerList[id];
    }

    /// @notice The round's deterministic settlement result as its orders stand now: the price level, the
    /// whole lots it matches, and which side is the oversubscribed pro-rata one. The same bounded
    /// algorithm `settle` runs, so no preview can ever disagree with the outcome.
    function clearingOf(uint256 id) external view returns (uint256 level, uint256 matched, bool sellersShare) {
        Round storage r = _round(id);
        return _clearing(_ordersOf(id), r.levels);
    }

    // ---- inside ---------------------------------------------------------------------------------------------------

    /// @dev The bounded, memory-held snapshot of one round's open orders, in ascending order-id order.
    struct Orders {
        uint256[] sLots;
        uint16[] sStep;
        uint64[] sId;
        uint256[] bLots;
        uint16[] bStep;
        uint64[] bId;
    }

    function _ordersOf(uint256 id) private view returns (Orders memory m) {
        address[] memory sellerOwners = _sellerList[id];
        address[] memory buyerOwners = _buyerList[id];
        m.sLots = new uint256[](sellerOwners.length);
        m.sStep = new uint16[](sellerOwners.length);
        m.sId = new uint64[](sellerOwners.length);
        for (uint256 i; i < sellerOwners.length; ++i) {
            SellOrder storage o = sells[id][sellerOwners[i]];
            m.sLots[i] = o.lots;
            m.sStep[i] = o.minStep;
            m.sId[i] = o.orderId;
        }
        m.bLots = new uint256[](buyerOwners.length);
        m.bStep = new uint16[](buyerOwners.length);
        m.bId = new uint64[](buyerOwners.length);
        for (uint256 i; i < buyerOwners.length; ++i) {
            BuyOrder storage o = bids[id][buyerOwners[i]];
            m.bLots[i] = o.lots;
            m.bStep[i] = o.maxStep;
            m.bId[i] = o.orderId;
        }
    }

    function _round(uint256 id) private view returns (Round storage r) {
        r = rounds[id];
        if (r.opensAt == 0) revert UnknownRound(id);
    }

    /// @dev The deterministic clearing over the frozen bounded grid: the lowest level whose uniform
    /// price matches the most whole lots, and which side ends up the oversubscribed pro-rata one.
    /// The lowest-tie rule is also what keeps every remainder division inside the sharing side.
    function _clearing(Orders memory m, uint256 levels)
        private
        pure
        returns (uint256 level, uint256 matched, bool sellersShare)
    {
        for (uint256 l; l <= levels; ++l) {
            uint256 supplied;
            for (uint256 i; i < m.sLots.length; ++i) {
                if (m.sStep[i] <= l) supplied += m.sLots[i];
            }
            uint256 demanded;
            for (uint256 i; i < m.bLots.length; ++i) {
                if (m.bStep[i] >= l) demanded += m.bLots[i];
            }
            uint256 fill = supplied < demanded ? supplied : demanded;
            // Ties keep the earliest (lowest) price recorded so far.
            if (fill > matched) {
                matched = fill;
                level = l;
                sellersShare = supplied > demanded;
            }
        }
    }

    /// @dev Write every order's filled lots for a settled round: the short side's crossing orders
    /// fill whole, and the long side's crossing orders share the matched lots pro rata at the price.
    /// The long side is therefore exactly one bounded set of eligible orders (all crossing), each
    /// getting its integer share of the remainder with the leftover lots by ascending order id.
    function _allocate(Orders memory m, uint256 level, uint256 matched, bool sellersShare)
        private
        pure
        returns (uint256[] memory sFill, uint256[] memory bFill)
    {
        sFill = new uint256[](m.sLots.length);
        bFill = new uint256[](m.bLots.length);
        if (matched == 0) return (sFill, bFill);
        if (sellersShare) {
            // Sellers are the oversubscribed side: every crossing buyer fills whole.
            for (uint256 i; i < m.bLots.length; ++i) {
                if (m.bStep[i] >= level) bFill[i] = m.bLots[i];
            }
            // Sellers' crossing orders share what remains. Quota never exceeds the crossing total,
            // so the pro-rata arithmetic cannot underflow and every order's share stays whole.
            _prorata(m, true, level, sFill, matched);
        } else {
            for (uint256 i; i < m.sLots.length; ++i) {
                if (m.sStep[i] <= level) sFill[i] = m.sLots[i];
            }
            _prorata(m, false, level, bFill, matched);
        }
        uint256 sumS;
        for (uint256 i; i < sFill.length; ++i) {
            sumS += sFill[i];
        }
        uint256 sumB;
        for (uint256 i; i < bFill.length; ++i) {
            sumB += bFill[i];
        }
        if (sumS != matched || sumB != matched) revert LedgerShort();
    }

    /// @dev Whole-lot pro-rata for the one side's eligible (crossing) orders at the clearing price:
    /// each order first gets its integer share of `quota`, then the leftover lots go one by one in
    /// ascending order id (the arrays are already in that order), so the allocation is always exact
    /// and deterministic, and every order's share never exceeds its own offer.
    function _prorata(Orders memory m, bool sellers, uint256 level, uint256[] memory fill, uint256 quota) private pure {
        uint256[] memory lots = sellers ? m.sLots : m.bLots;
        uint16[] memory steps = sellers ? m.sStep : m.bStep;
        uint256 total;
        for (uint256 i; i < lots.length; ++i) {
            if (sellers ? steps[i] <= level : steps[i] >= level) total += lots[i];
        }
        if (quota == 0) return;
        if (quota > total) revert LedgerShort();
        uint256 distributed;
        for (uint256 i; i < lots.length; ++i) {
            bool eligible = sellers ? steps[i] <= level : steps[i] >= level;
            if (eligible) {
                uint256 base = lots[i] * quota / total;
                fill[i] = base;
                distributed += base;
            }
        }
        uint256 leftover = quota - distributed;
        for (uint256 i; i < lots.length && leftover != 0; ++i) {
            bool eligible = sellers ? steps[i] <= level : steps[i] >= level;
            if (eligible) {
                fill[i] += 1;
                leftover -= 1;
            }
        }
        if (leftover != 0) revert LedgerShort();
    }

    /// @dev Remove `who` from one side's bounded list by swapping with the last entry (the remainder of
    /// the array keeps its ascending order), called only for an order that must be in it.
    function _removeFromList(uint256 id, address who, bool buyers) private {
        address[] storage list = buyers ? _buyerList[id] : _sellerList[id];
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == who) {
                // Shift, never swap with the last entry: the leftover-lot rule hands the remainder to the
                // lowest order id, and a swap lets an early cancelled order pull a later order into its
                // slot (review F2). The list is bounded by MAX_SELLERS / MAX_BUYERS.
                for (uint256 j = i; j + 1 < n; ++j) list[j] = list[j + 1];
                list.pop();
                return;
            }
        }
        revert NoOrder();
    }
}
