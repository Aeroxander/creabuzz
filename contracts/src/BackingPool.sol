// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BackingClaim} from "./BackingClaim.sol";

/// @notice What a pool uses of its opening round's auction (Uniswap's Continuous Clearing Auction, unchanged).
interface IRoundAuction {
    function token() external view returns (address);
    function currency() external view returns (address);
    function fundsRecipient() external view returns (address);
    function tokensRecipient() external view returns (address);
    function endBlock() external view returns (uint64);
    function claimBlock() external view returns (uint64);
    function isGraduated() external view returns (bool);
    function currencyRaised() external view returns (uint256);
    function clearingPrice() external view returns (uint256);
    function onTokensReceived() external;
    function checkpoint() external;
    function lastCheckpointedBlock() external view returns (uint64);
    function sweepCurrency() external;
    function sweepUnsoldTokens() external;
}

/// @title BackingPool
/// @notice Instant backing for one project (docs/v3-review/BACKING-POOL.md). Anyone buys the project's
/// backing units with the quote token at a price read from a curve, and sells them back to the same
/// curve at any time: no rounds, no seats, no keeper. Part of every buy stays here as the reserve that
/// pays sellers; the rest is the project's money, held here and released a tranche at a time as the
/// project posts milestones. At each milestone a backer can stay, or leave with their held money back.
/// If the project is abandoned, the backers who are still holding get back what was not released.
///
/// WHAT A BACKER HOLDS. Backing units are a ledger inside this contract: they are not the DAO's Shares,
/// carry no vote in the DAO, and cannot be moved between wallets. The DAO's Shares can only ever be
/// minted by a reviewed award (the issuance rule is sealed at the DAO's birth), so no pool could mint
/// them, and a pool that could would let anyone buy a majority of the votes in one transaction.
///
/// THE CURVE AND WHY SELLS ALWAYS CLEAR. A constant product with virtual reserves, run on the reserve
/// part only: with `x = virtualQuote + reserve` and `y = virtualUnits - totalSupply`, a buy that adds
/// `r` to the reserve mints `floor(y * r / (x + r))` units and a sale of `u` units pays
/// `floor(x * u / (y + u))` out of the reserve. Both round against the trader, so `x * y` never falls
/// below `virtualQuote * virtualUnits`. Since `y <= virtualUnits` always, `x >= virtualQuote` always:
/// the reserve never goes negative, whatever order holders sell in, and when the last unit is sold the
/// reserve has paid out at most what it held. The project money is accounted apart (`escrow`) and is
/// never used to pay a curve sale, so the pool's quote balance always covers
/// `reserve + escrow + treasuryOwed`.
///
/// THE PROJECT MONEY. A buy pays a fee (`feeBps`, owed to the DAO treasury at once and never to an
/// operator), then `projectBps` of the rest goes to the escrow and the remainder to the reserve. Each
/// backer's part of the escrow is tracked as a weight, priced like a vault share so a newcomer's weight
/// is worth exactly what they just put in: nobody can buy in late and take a part of money others left.
/// An ordinary sale gives up the part of the seller's weight that matches the units sold (by units, not
/// by what they cost); what it stood for stays in the escrow for those who remain. Money only ever
/// leaves the escrow to the DAO treasury or back to backers.
///
/// MILESTONES: STAY OR LEAVE. The founder (or the DAO) posts "milestone reached" with the id of the
/// public record event. The post fixes the tranche: `trancheBps` of the escrow as it stands at that
/// moment (`pending`), carried by the weight that exists at that moment (`staked`). For
/// `objectionWindow` after the post, a backer who held before it and has not bought since may `leave`:
/// all their units go back to the curve at the ordinary sale fee, and they get their whole part of the escrow,
/// their part of the tranche included. Nobody can stop a release and nobody is made to fund a milestone
/// they reject. When the window ends anyone resolves it and the tranche, less what the leavers took of
/// it, goes to the DAO treasury. Money that arrives after the post is not touched by that milestone: a
/// buyer's weight is priced on the escrow with the tranche already taken off. A milestone nobody
/// resolves within `resolveWindow` of its window's end can only be voided, and releases nothing.
///
/// ABANDONMENT. While any wallet holds a weight (round weight in claim tokens nobody has exchanged, and the
/// few base units of a round that can never be exchanged, are not a wallet), `abandonAfter` without a
/// release that paid anything makes the project abandoned: no vote and no call is needed, the next sale
/// makes the change itself. Backers
/// holding more than half the weight can also vote for it once `voteAfter` has passed without a
/// release. Buying and milestones stop for good; selling keeps working on the curve with no fee, and
/// each sale also pays the seller's part of the remaining escrow. Escrow nobody holds a weight for goes
/// to the DAO treasury, never to a later buyer.
///
/// THE FOUNDER'S ROLE. The founder named at creation stays one of the two addresses that may post a
/// milestone for the life of the pool; the DAO is the other, and nothing can change either. Posting is
/// the founder's only power: released money and fees go to the DAO and nowhere else.
///
/// A LIMIT ON THE ARITHMETIC. Every release lowers what a unit of weight is worth, so weights grow
/// against the escrow by a third per release at the default tranche. After about 300 releases (more
/// than twenty years at one a month) a buy could overflow and revert; sales, leaving and refunds divide
/// and never do.
///
/// THE OPENING ROUND (optional). A pool can be created waiting for a round: an auction (Uniswap's
/// Continuous Clearing Auction, as deployed, unchanged) sells a fixed supply of claim tokens for the quote
/// token, with this pool as the only address that can collect what it raised. Until the round is over
/// nothing can be bought here. If the auction did not reach its minimum, bidders take their money back
/// from the auction itself and this pool is closed for good. If it did, `seedFromAuction` (anyone may
/// call it) collects the raise and splits it exactly as a buy is split: fee to the treasury, project
/// part to the escrow, the rest to the reserve `R`. The claim tokens sold become `S` units, and the curve
/// is set to the state one buy of `R` from an empty curve would have left: `virtualQuote = R * (virtualUnits
/// - S) / S`, rounded down, which makes `x * y >= virtualQuote * virtualUnits` hold from the first second,
/// so the proof above applies unchanged. That curve opens at the AVERAGE price the round's buyers paid
/// (times `virtualUnits / (virtualUnits - S)`), not at the auction's last clearing price: bidders pay
/// different prices over a round, and a curve opened at the last one could owe sellers more than was
/// raised. A bidder collects claim tokens from the auction and `redeem`s them here for units one for one,
/// with the matching part of the round's escrow weight. Weight not yet redeemed counts as staying at a
/// milestone; to leave, redeem first. A redeem acquires weight like a buy does, so it withdraws a standing
/// abandon vote and restarts the wait before the wallet may vote (claim tokens are transferable, so the
/// wait counts from the redeem, not from the bid).
///
/// There is no owner, no admin, no pause and no upgrade; every parameter is fixed at creation.
contract BackingPool {
    using SafeERC20 for IERC20;

    /// @notice Everything a pool is created with. All of it is immutable afterwards.
    struct Params {
        /// Quote base units the curve starts with on paper; sets the opening price and how fast it moves.
        uint256 virtualQuote;
        /// Units the curve starts with on paper: the supply can approach this and never reach it.
        uint256 virtualUnits;
        /// The part of each buy, after the fee, that is the project's money (basis points).
        uint16 projectBps;
        /// The fee on each buy and each sale, owed to the DAO treasury at once (basis points).
        uint16 feeBps;
        /// The part of the escrow, as it stands when a milestone is posted, that the milestone releases.
        uint16 trancheBps;
        /// How long after a post backers may leave with their held money.
        uint32 objectionWindow;
        /// How long after that window a milestone can be resolved before it can only be voided.
        uint32 resolveWindow;
        /// The least time between two milestone posts (and between opening and the first one).
        uint32 claimInterval;
        /// How long, with money held, without a release before the project counts as abandoned.
        uint32 abandonAfter;
        /// How long after a wallet's last buy (or claim-token exchange) before it may vote the project abandoned.
        uint32 voteSeasoning;
        /// How long without a release before a vote of the backers can declare the project abandoned.
        uint32 voteAfter;
        /// How long after opening the per-wallet buy cap applies; zero for no cap.
        uint32 earlyWindow;
        /// The most quote one wallet may spend during `earlyWindow`; zero for no cap.
        uint256 earlyCap;
    }

    /// @notice Where a milestone post stands.
    enum MilestoneStatus {
        None,
        Open,
        Released,
        Void
    }

    /// @notice One milestone post.
    struct Milestone {
        bytes32 ref;
        uint64 postedAt;
        /// Until when backers may leave.
        uint64 windowEndsAt;
        /// Until when it can be resolved; after that it can only be voided.
        uint64 resolveBy;
        MilestoneStatus status;
        /// The escrow when it was posted.
        uint256 escrowAtPost;
        /// What leavers took out of the escrow during its window.
        uint256 leftWith;
        /// What it released to the treasury.
        uint256 released;
    }

    /// @notice Where a pool's opening round stands. `None`: the pool was opened without one.
    enum RoundState {
        None,
        Waiting,
        Live,
        Failed
    }

    /// @notice The opening round, for the app. Prices here are the auction's own: quote base units per
    /// base unit of claim token, times 2**96.
    struct RoundView {
        RoundState state;
        address auction;
        address claimToken;
        /// Claim tokens the round offers.
        uint256 supply;
        /// The round takes bids until this block; claim tokens can be collected from it too.
        uint64 endBlock;
        /// What the round has to raise, and what it has raised as of the auction's last checkpoint.
        uint256 minimumRaise;
        uint256 raised;
        /// The auction's clearing price: live while waiting, the final one once seeded.
        uint256 clearingPriceX96;
        /// Once live: what arrived here from the auction, the units it became, the curve price it opened
        /// at (see `price`), and when.
        uint256 received;
        uint256 unitsSold;
        uint256 openingPrice;
        uint64 liveAt;
        /// Units of the round nobody has redeemed yet.
        uint256 unredeemedUnits;
        /// Claim tokens the wallet holds: what it can redeem for units now (when live).
        uint256 holderClaimTokens;
    }

    /// @notice Everything the app shows about a pool and one wallet, in one call.
    struct Snapshot {
        uint256 price;
        uint256 buyPrice;
        uint256 reserve;
        uint256 escrow;
        uint256 released;
        uint256 refunded;
        uint256 feesTaken;
        uint256 treasuryOwed;
        uint256 totalSupply;
        uint256 totalWeight;
        bool abandoned;
        uint64 openedAt;
        uint64 nextClaimAt;
        uint64 abandonableAt;
        uint256 abandonVotes;
        uint256 milestoneId;
        Milestone milestone;
        uint256 pending;
        uint256 holderUnits;
        uint256 holderWeight;
        uint256 holderEscrow;
        uint256 holderSellValue;
        bool holderCanLeave;
        uint256 holderLeaveValue;
        bool holderVotedAbandon;
        uint256 holderEarlyLeft;
        RoundView round;
    }

    uint256 private constant BPS = 10_000;
    /// @dev The vault-share offset: a first backer's weight is their project money times this, and the
    /// "plus one" beside it keeps the price defined when the escrow holds money nobody has a weight for.
    /// The slice of the escrow that belongs to this offset belongs to no backer: it is released by
    /// milestones like the rest and goes to the treasury on abandonment.
    uint256 private constant WEIGHT_OFFSET = 1e12;
    /// @dev Prices are quote base units per whole unit (1e18 base units), times this.
    uint256 private constant PRICE_SCALE = 1e18;

    /// @notice Units have 18 decimals, like the DAO's Shares.
    uint8 public constant decimals = 18;

    /// @notice The contract that created this pool: its factory's deployer (`BackingPoolDeployer`), the only
    /// address that can bind an opening round. The registry of pools is `BackingPoolFactory.poolOf`.
    address public immutable factory;
    /// @notice The project's DAO: the treasury that fees and released tranches are paid to, and one of the
    /// two addresses that may post a milestone.
    address public immutable dao;
    /// @notice The founder, the other address that may post a milestone, for the life of the pool; zero
    /// when only the DAO may.
    address public immutable founder;
    /// @notice What backers pay in and are paid in.
    IERC20 public immutable quote;
    /// @notice When the pool opened.
    uint64 public immutable openedAt;

    /// @notice The curve's paper reserve: fixed at creation, or set once from the opening round's result.
    uint256 public virtualQuote;
    uint256 public immutable virtualUnits;
    uint16 public immutable projectBps;
    uint16 public immutable feeBps;
    uint16 public immutable trancheBps;
    uint32 public immutable objectionWindow;
    uint32 public immutable resolveWindow;
    uint32 public immutable claimInterval;
    uint32 public immutable abandonAfter;
    uint32 public immutable voteSeasoning;
    uint32 public immutable voteAfter;
    uint32 public immutable earlyWindow;
    uint256 public immutable earlyCap;

    /// @notice The opening round's claim token; zero when the pool was opened without a round.
    BackingClaim public immutable claimToken;
    /// @notice Claim tokens the opening round offers.
    uint256 public immutable roundSupply;
    /// @notice Where the opening round stands.
    RoundState public roundState;
    /// @notice The round's auction, once the factory has bound it.
    address public auction;
    /// @notice What the round has to raise (the auction holds the same number and enforces it).
    uint256 public minimumRaise;
    /// @notice Set when the round went live: the auction's final clearing price (times 2**96), what
    /// arrived here from it, the units it became, the curve price it opened at, and when.
    uint256 public clearingPriceX96;
    uint256 public roundReceived;
    uint256 public roundUnits;
    uint256 public openingPrice;
    uint64 public liveAt;
    /// @notice Units and escrow weight of the round that nobody has redeemed yet. They are counted in
    /// `totalSupply` and `totalWeight` and belong to whoever holds the claim tokens.
    uint256 public unredeemedUnits;
    uint256 public unredeemedWeight;

    /// @notice Units in existence.
    uint256 public totalSupply;
    /// @notice Units a wallet holds.
    mapping(address => uint256) public balanceOf;
    /// @notice Quote held to pay curve sales.
    uint256 public reserve;
    /// @notice Project money held here: not yet released, not yet handed back.
    uint256 public escrow;
    /// @notice Project money released to the DAO treasury so far (paid or still owed).
    uint256 public released;
    /// @notice Project money handed back to backers so far: to leavers, and after abandonment.
    uint256 public refunded;
    /// @notice Fees taken from trades so far (owed to the DAO treasury the moment they are taken).
    uint256 public feesTaken;
    /// @notice What the DAO treasury is owed and has not been sent yet: fees since the last payment, and
    /// released money a transfer did not deliver. `payTreasury` sends it; so does every release.
    uint256 public treasuryOwed;
    /// @notice The sum of every backer's weight in the escrow.
    uint256 public totalWeight;
    /// @notice A backer's weight in the escrow.
    mapping(address => uint256) public weightOf;

    /// @notice How many milestones have been posted; the latest one's id.
    uint256 public milestoneCount;
    /// @notice Each milestone post, by id (from 1).
    mapping(uint256 => Milestone) public milestones;
    /// @notice The open milestone's tranche: what it will release, less what leavers took of it. Zero
    /// when no milestone is open.
    uint256 public pending;
    /// @notice The weight that carries `pending`: the weight (and offset) at the post, less the leavers'.
    uint256 public staked;
    /// @notice When the latest milestone was posted (the opening time before the first).
    uint64 public lastClaimAt;
    /// @notice When the abandonment clocks last restarted: at opening, when a backer arrives while no
    /// wallet holds a weight, and at every release that paid something.
    uint64 public lastReleaseAt;
    /// @notice Weight currently voting to declare the project abandoned.
    uint256 public abandonVotes;

    /// @notice The milestone whose window a wallet bought during (it cannot leave on that one).
    mapping(address => uint256) public boughtDuring;
    /// @notice Whether a wallet is voting to declare the project abandoned.
    mapping(address => bool) public votedAbandon;
    /// @notice When a wallet last bought or redeemed claim tokens (the two ways to acquire weight).
    mapping(address => uint64) public lastBuyAt;
    /// @notice Quote a wallet spent during the early window.
    mapping(address => uint256) public earlySpent;

    /// @dev Set when the change to "abandoned" was written. `abandoned()` is true from the moment the
    /// clock runs out, before anyone has written it.
    bool private _abandonedWritten;
    bool private transient _entered;

    /// @notice A buy. `priceAfter` is the curve price after it (see `price`).
    event Bought(
        address indexed buyer,
        uint256 quoteIn,
        uint256 unitsOut,
        uint256 fee,
        uint256 toEscrow,
        uint256 priceAfter,
        uint256 supplyAfter,
        uint256 reserveAfter
    );
    /// @notice A sale. `refund` is the seller's part of the escrow, paid only after abandonment.
    event Sold(
        address indexed seller,
        uint256 unitsIn,
        uint256 quoteOut,
        uint256 fee,
        uint256 refund,
        uint256 priceAfter,
        uint256 supplyAfter,
        uint256 reserveAfter
    );
    /// @notice A backer left at a milestone: all their units sold (`fromCurve`, after the ordinary `fee`)
    /// and their whole part of the escrow handed back (`fromEscrow`). `quoteOut` is the two together.
    event Left(
        uint256 indexed id,
        address indexed backer,
        uint256 unitsIn,
        uint256 quoteOut,
        uint256 fromCurve,
        uint256 fromEscrow,
        uint256 fee,
        uint256 priceAfter,
        uint256 supplyAfter,
        uint256 reserveAfter
    );
    /// @notice A milestone was posted: backers may leave until `windowEndsAt`, and it can be resolved
    /// from then until `resolveBy`. `tranche` is what it releases if nobody leaves.
    event MilestonePosted(
        uint256 indexed id,
        bytes32 indexed ref,
        address indexed by,
        uint64 windowEndsAt,
        uint64 resolveBy,
        uint256 escrowAtPost,
        uint256 tranche
    );
    /// @notice A milestone was resolved: `wasReleased` with the `amount` that went to the treasury
    /// (which can be zero when everyone left), or voided with nothing released.
    event MilestoneResolved(uint256 indexed id, bool wasReleased, uint256 amount);
    /// @notice Money owed to the DAO treasury reached it.
    event TreasuryPaid(uint256 amount);
    /// @notice A backer voted to declare the project abandoned.
    event AbandonVoted(address indexed backer, uint256 weight);
    /// @notice The project became abandoned. `escrow` is what is left for backers; `orphaned` is escrow
    /// nobody had a weight for, which went to the treasury.
    event Abandoned(address indexed by, bool byVote, uint256 escrow, uint256 orphaned);
    /// @notice The opening round's auction was bound and given the claim tokens to sell.
    event RoundBound(address indexed auction, address indexed claimToken, uint256 supply, uint256 minimumRaise, uint64 endBlock);
    /// @notice The opening round reached its minimum and the pool went live: `received` arrived from the
    /// auction and was split into `fee`, `toEscrow` and the reserve; `unitsSold` units exist for the claim
    /// tokens sold; the curve opened at `openingPrice` (see `price`).
    event RoundSeeded(
        uint256 received,
        uint256 fee,
        uint256 toEscrow,
        uint256 toReserve,
        uint256 unitsSold,
        uint256 clearingPriceX96,
        uint256 openingPrice,
        uint256 virtualQuote
    );
    /// @notice The opening round did not reach its minimum: bidders take their money back from the
    /// auction, and this pool is closed for good.
    event RoundFailed(address indexed auction, uint256 raised, uint256 minimumRaise);
    /// @notice Claim tokens were exchanged for units, with their part of the round's escrow weight.
    event Redeemed(address indexed backer, uint256 units, uint256 weight);

    error InvalidParams();
    error Reentrancy();
    error Expired();
    error ZeroAmount();
    error InsufficientUnits();
    error Slippage();
    error IsAbandoned();
    error EarlyCapReached();
    error TooLarge();
    error BadQuoteTransfer();
    error NotClaimant();
    error MilestoneOpen();
    error NoOpenMilestone();
    error TooSoon(uint256 notBefore);
    error WindowOver();
    error WindowNotOver();
    error NoSay();
    error AlreadyDone();
    error NotAbandonable();
    error NothingOwed();
    error NotFactory();
    error RoundNotLive();
    error RoundNotWaiting();
    error RoundNotOver(uint256 endBlock);
    error BadAuction();

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    /// @param dao_ The project's DAO (the treasury).
    /// @param founder_ The founder who may post milestones, or zero.
    /// @param quote_ The quote token.
    /// @param p The pool's fixed terms.
    /// @param roundSupply_ Claim tokens an opening round will sell, or zero to open the curve at once.
    constructor(address dao_, address founder_, IERC20 quote_, Params memory p, uint256 roundSupply_) {
        if (dao_ == address(0) || dao_.code.length == 0 || address(quote_).code.length == 0) revert InvalidParams();
        if (
            p.virtualQuote == 0 || p.virtualQuote > type(uint112).max || p.virtualUnits < 1e18
                || p.virtualUnits > type(uint112).max || p.projectBps > 9000 || p.feeBps > 500 || p.trancheBps == 0
                || p.trancheBps > 5000 || p.objectionWindow < 1 days || p.objectionWindow > 30 days
                || p.resolveWindow < 1 days || p.resolveWindow > 30 days || p.claimInterval < p.objectionWindow
                || p.claimInterval > 365 days
                || p.abandonAfter <= uint256(p.claimInterval) + p.objectionWindow + p.resolveWindow
                || p.abandonAfter > 1460 days || p.voteSeasoning > 90 days || p.voteAfter > p.abandonAfter
                || p.earlyWindow > 30 days
        ) revert InvalidParams();
        factory = msg.sender;
        dao = dao_;
        founder = founder_;
        quote = quote_;
        openedAt = uint64(block.timestamp);
        lastClaimAt = uint64(block.timestamp);
        lastReleaseAt = uint64(block.timestamp);
        virtualQuote = p.virtualQuote;
        virtualUnits = p.virtualUnits;
        projectBps = p.projectBps;
        feeBps = p.feeBps;
        trancheBps = p.trancheBps;
        objectionWindow = p.objectionWindow;
        resolveWindow = p.resolveWindow;
        claimInterval = p.claimInterval;
        abandonAfter = p.abandonAfter;
        voteSeasoning = p.voteSeasoning;
        voteAfter = p.voteAfter;
        earlyWindow = p.earlyWindow;
        earlyCap = p.earlyCap;
        if (roundSupply_ != 0) {
            // At most half the curve: the seeded curve keeps a positive paper reserve whatever the round raised.
            if (roundSupply_ < 1e18 || roundSupply_ > p.virtualUnits / 2) revert InvalidParams();
            roundSupply = roundSupply_;
            claimToken = new BackingClaim(roundSupply_);
            roundState = RoundState.Waiting;
        }
    }

    // ---- the opening round ----------------------------------------------------------------------------------------

    /// @notice Bind the round's auction and hand it the claim tokens to sell. Only the factory, once,
    /// in the transaction that creates the pool. The auction must sell this pool's claim token for this
    /// pool's quote token and name this pool as the only address that can collect either.
    /// @param auction_ The auction.
    /// @param minimumRaise_ What the auction was created to require (kept here for the app to read).
    function bindRound(address auction_, uint256 minimumRaise_) external nonReentrant {
        if (msg.sender != factory) revert NotFactory();
        if (roundState != RoundState.Waiting || auction != address(0)) revert RoundNotWaiting();
        IRoundAuction a = IRoundAuction(auction_);
        if (
            auction_.code.length == 0 || a.token() != address(claimToken) || a.currency() != address(quote)
                || a.fundsRecipient() != address(this) || a.tokensRecipient() != address(this)
        ) revert BadAuction();
        auction = auction_;
        minimumRaise = minimumRaise_;
        claimToken.transfer(auction_, roundSupply);
        a.onTokensReceived();
        emit RoundBound(auction_, address(claimToken), roundSupply, minimumRaise_, a.endBlock());
    }

    /// @notice Settle the opening round once its auction is over; anyone may call, once. If the auction
    /// reached its minimum, collect what it raised, split it as a buy is split, and open the curve at the
    /// state one buy of the reserve part would have left. If it did not, close this pool for good (bidders
    /// are refunded by the auction). The pool also closes, with nothing refundable, when the minimum was
    /// reached but the auction's protocol fee left too little here to open a curve on (at most two base
    /// units, which go to the treasury).
    /// @return live Whether the pool went live.
    function seedFromAuction() external nonReentrant returns (bool live) {
        if (roundState != RoundState.Waiting || auction == address(0)) revert RoundNotWaiting();
        IRoundAuction a = IRoundAuction(auction);
        uint256 end = a.endBlock();
        // The raise at the end block does not exist until the auction is told to record it. That checkpoint is
        // also how the pool learns the round is over, on the auction's own clock (on Arbitrum and its Orbit
        // chains `block.number` is not the auction's): the last checkpoint is at the end block only once the
        // auction's block number has reached it. Before, it is earlier and this reverts, undoing the call.
        a.checkpoint();
        if (a.lastCheckpointedBlock() < end) revert RoundNotOver(end);
        if (!a.isGraduated()) {
            roundState = RoundState.Failed;
            emit RoundFailed(address(a), a.currencyRaised(), minimumRaise);
            return false;
        }
        // The final price is read plainly: the auction's `lbpInitializationParams` subtracts its protocol fee
        // from the raise without clamping and reverts when a fee controller reports more than was raised, while
        // `sweepCurrency` clamps. Seeding depends on the fee controller only through the sweep.
        uint256 finalPriceX96 = a.clearingPrice();

        // Only what this call moves counts: money or claim tokens sent here by anyone are not the round's.
        uint256 heldQuote = quote.balanceOf(address(this));
        uint256 heldClaim = claimToken.balanceOf(address(this));
        a.sweepCurrency();
        a.sweepUnsoldTokens();
        uint256 received = quote.balanceOf(address(this)) - heldQuote;
        uint256 sold = roundSupply - (claimToken.balanceOf(address(this)) - heldClaim);

        uint256 fee = _bpsUp(received, feeBps);
        uint256 toProject = _bpsUp(received - fee, projectBps);
        uint256 toReserve = received - fee - toProject;
        // A round whose raise reached the minimum but left nothing for a curve to open on: the auction's
        // protocol fee took the raise (the sweep clamps it to the raise, so `received` can be zero), which
        // leaves at most two base units here. The pool closes for good, as a round under its minimum does, and
        // the project may open another. Nothing is stranded: what the sweep delivered goes to the treasury.
        // (Bidders were filled, so there is no refund to take; the money was the protocol's.)
        if (sold == 0 || toReserve == 0) {
            roundState = RoundState.Failed;
            emit RoundFailed(address(a), a.currencyRaised(), minimumRaise);
            if (received != 0) _payTreasury(received);
            return false;
        }
        if (toReserve > type(uint128).max) revert BadAuction();
        // The paper reserve that puts (reserve, units sold) exactly on a curve from empty, rounded down so the
        // curve's product starts at or above its floor.
        uint256 paper = Math.mulDiv(toReserve, virtualUnits - sold, sold);
        if (paper == 0 || paper + toReserve > type(uint128).max) revert BadAuction();

        virtualQuote = paper;
        reserve = toReserve;
        totalSupply = sold;
        unredeemedUnits = sold;
        uint256 weight = toProject * WEIGHT_OFFSET;
        unredeemedWeight = weight;
        totalWeight = weight;
        escrow = toProject;
        feesTaken = fee;
        treasuryOwed += fee;
        lastClaimAt = uint64(block.timestamp);
        lastReleaseAt = uint64(block.timestamp);
        liveAt = uint64(block.timestamp);
        clearingPriceX96 = finalPriceX96;
        roundReceived = received;
        roundUnits = sold;
        openingPrice = price();
        roundState = RoundState.Live;
        emit RoundSeeded(received, fee, toProject, toReserve, sold, finalPriceX96, openingPrice, paper);
        return true;
    }

    /// @notice Exchange `amount` of the round's claim tokens for the same number of units, with the
    /// matching part of the round's escrow weight. The claim tokens are burned. Works for as long as the
    /// pool exists, abandoned or not. Like a buy, it withdraws a standing vote to declare the project
    /// abandoned and restarts the wait before the wallet may vote again.
    /// @param amount Claim tokens to exchange.
    /// @return weight The escrow weight that came with the units.
    function redeem(uint256 amount) external nonReentrant returns (uint256 weight) {
        if (roundState != RoundState.Live) revert RoundNotLive();
        if (amount == 0) revert ZeroAmount();
        uint256 left = unredeemedUnits;
        if (amount > left) revert InsufficientUnits();
        weight = amount == left ? unredeemedWeight : Math.mulDiv(unredeemedWeight, amount, left);
        unredeemedUnits = left - amount;
        unredeemedWeight -= weight;
        // Weight acquired here is treated as a buy treats it: a standing vote is withdrawn (it was cast with
        // the old weight and must not silently cover the new), so `abandonVotes` stays the sum of the weights
        // of the wallets that vote.
        uint256 weightBefore = weightOf[msg.sender];
        if (votedAbandon[msg.sender]) {
            votedAbandon[msg.sender] = false;
            abandonVotes -= weightBefore;
        }
        // And it restarts the wait before the wallet may vote, as a buy does: claim tokens are an ordinary
        // transferable token, so "when did this wallet last acquire weight" is the redeem, not the bid. A bidder
        // who redeems late only waits `voteSeasoning` from then.
        lastBuyAt[msg.sender] = uint64(block.timestamp);
        balanceOf[msg.sender] += amount;
        weightOf[msg.sender] = weightBefore + weight;
        claimToken.burn(msg.sender, amount);
        emit Redeemed(msg.sender, amount, weight);
    }

    // ---- trading --------------------------------------------------------------------------------------------------

    /// @notice Buy units with exactly `quoteIn` of the quote token (approve this pool first).
    /// @param quoteIn What you pay, fee included.
    /// @param minUnitsOut The fewest units you accept; the buy reverts below it.
    /// @param deadline The latest time this buy may happen.
    /// @return unitsOut The units you received.
    function buy(uint256 quoteIn, uint256 minUnitsOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 unitsOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (roundState == RoundState.Waiting || roundState == RoundState.Failed) revert RoundNotLive();
        if (abandoned()) revert IsAbandoned();
        if (earlyCap != 0 && block.timestamp < uint256(openedAt) + earlyWindow) {
            uint256 spent = earlySpent[msg.sender] + quoteIn;
            if (spent > earlyCap) revert EarlyCapReached();
            earlySpent[msg.sender] = spent;
        }
        uint256 fee;
        uint256 toProject;
        uint256 toReserve;
        (unitsOut, fee, toProject, toReserve) = _quoteBuy(quoteIn);
        if (unitsOut == 0) revert ZeroAmount();
        if (unitsOut < minUnitsOut) revert Slippage();

        // A wallet that buys while a window is running cannot leave on that milestone, and has to wait
        // again before it can vote the project abandoned.
        uint256 weightBefore = weightOf[msg.sender];
        uint256 id = _liveMilestone();
        if (id != 0 && boughtDuring[msg.sender] != id) boughtDuring[msg.sender] = id;
        if (votedAbandon[msg.sender]) {
            votedAbandon[msg.sender] = false;
            abandonVotes -= weightBefore;
        }
        lastBuyAt[msg.sender] = uint64(block.timestamp);
        // The clocks measure time with backers' money held: they start again with the first backer in. Weight
        // of the round nobody has redeemed is not a backer (see `_redeemableWeight`).
        if (_redeemableWeight() == 0) lastReleaseAt = uint64(block.timestamp);

        // The buyer's weight is priced before their money goes in and on the escrow with any open
        // tranche already taken off, so it is worth what they add and an open milestone does not touch it.
        uint256 weight = Math.mulDiv(toProject, totalWeight + WEIGHT_OFFSET, escrow - pending + 1);
        weightOf[msg.sender] = weightBefore + weight;
        totalWeight += weight;
        escrow += toProject;
        feesTaken += fee;
        treasuryOwed += fee;
        reserve += toReserve;
        totalSupply += unitsOut;
        balanceOf[msg.sender] += unitsOut;

        // Exactly what was asked must arrive: a token that keeps a part of a transfer is refused.
        uint256 held = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), quoteIn);
        if (quote.balanceOf(address(this)) != held + quoteIn) revert BadQuoteTransfer();

        emit Bought(msg.sender, quoteIn, unitsOut, fee, toProject, price(), totalSupply, reserve);
    }

    /// @notice Sell `unitsIn` units back to the curve. Before abandonment the sale pays the fee and the
    /// matching part of your weight stays with those who remain. Once the project is abandoned (this
    /// call makes the change itself if the clock has run out) there is no fee, and the sale also pays
    /// your part of the remaining escrow.
    /// @param unitsIn The units you sell.
    /// @param minQuoteOut The least quote you accept; the sale reverts below it.
    /// @param deadline The latest time this sale may happen.
    /// @return quoteOut The quote you received.
    function sell(uint256 unitsIn, uint256 minQuoteOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (unitsIn == 0) revert ZeroAmount();
        if (!_abandonedWritten && _clockRanOut()) _abandon(false);
        (uint256 gross, uint256 fee, uint256 refund, uint256 weight) =
            _quoteSell(msg.sender, unitsIn, _abandonedWritten, escrow);
        quoteOut = gross - fee + refund;
        if (quoteOut < minQuoteOut) revert Slippage();

        _burn(msg.sender, unitsIn, weight, gross);
        if (refund != 0) {
            escrow -= refund;
            refunded += refund;
        }
        if (fee != 0) {
            feesTaken += fee;
            treasuryOwed += fee;
        }

        quote.safeTransfer(msg.sender, quoteOut);
        emit Sold(msg.sender, unitsIn, quoteOut, fee, refund, price(), totalSupply, reserve);
    }

    /// @notice Leave at the open milestone: sell all your units to the curve, at the ordinary sale fee, and take back
    /// your whole part of the escrow, your part of the tranche included. Only while the milestone's
    /// window runs, and only for a wallet that held before the post and has not bought since.
    /// @param minQuoteOut The least quote you accept; the call reverts below it.
    /// @param deadline The latest time this may happen.
    /// @return quoteOut The quote you received.
    function leave(uint256 minQuoteOut, uint256 deadline) external nonReentrant returns (uint256 quoteOut) {
        if (block.timestamp > deadline) revert Expired();
        uint256 id = _liveMilestone();
        if (id == 0) revert WindowOver();
        uint256 units = balanceOf[msg.sender];
        if (units == 0 || boughtDuring[msg.sender] == id) revert NoSay();
        (uint256 gross, uint256 fromTranche, uint256 fromEscrow, uint256 weight) = _quoteLeave(msg.sender, units);
        uint256 fee = _bpsUp(gross, feeBps);
        quoteOut = gross - fee + fromEscrow;
        if (quoteOut < minQuoteOut) revert Slippage();

        _burn(msg.sender, units, weight, gross);
        // The leaver's weight stops carrying the tranche, and takes its part of the tranche with it.
        staked -= weight;
        pending -= fromTranche;
        escrow -= fromEscrow;
        refunded += fromEscrow;
        milestones[id].leftWith += fromEscrow;

        if (fee != 0) {
            feesTaken += fee;
            treasuryOwed += fee;
        }

        quote.safeTransfer(msg.sender, quoteOut);
        emit Left(id, msg.sender, units, quoteOut, gross - fee, fromEscrow, fee, price(), totalSupply, reserve);
    }

    // ---- milestones -----------------------------------------------------------------------------------------------

    /// @notice Post "milestone reached": the founder or the DAO names the public record event that
    /// shows it. The tranche is fixed now, from the escrow as it stands, and the window to leave opens.
    /// One post at a time, and no sooner than `claimInterval` after the last one (or after opening).
    /// @param ref The id of the public record event for this milestone.
    /// @return id The milestone's id.
    function postMilestone(bytes32 ref) external nonReentrant returns (uint256 id) {
        if (msg.sender != dao && (founder == address(0) || msg.sender != founder)) revert NotClaimant();
        if (roundState == RoundState.Waiting || roundState == RoundState.Failed) revert RoundNotLive();
        if (abandoned()) revert IsAbandoned();
        if (ref == bytes32(0)) revert ZeroAmount();
        if (milestones[milestoneCount].status == MilestoneStatus.Open) revert MilestoneOpen();
        uint256 notBefore = uint256(lastClaimAt) + claimInterval;
        if (block.timestamp < notBefore) revert TooSoon(notBefore);
        id = ++milestoneCount;
        uint64 ends = uint64(block.timestamp) + objectionWindow;
        uint256 tranche = escrow * trancheBps / BPS;
        milestones[id] = Milestone({
            ref: ref,
            postedAt: uint64(block.timestamp),
            windowEndsAt: ends,
            resolveBy: ends + resolveWindow,
            status: MilestoneStatus.Open,
            escrowAtPost: escrow,
            leftWith: 0,
            released: 0
        });
        pending = tranche;
        staked = totalWeight + WEIGHT_OFFSET;
        lastClaimAt = uint64(block.timestamp);
        emit MilestonePosted(id, ref, msg.sender, ends, ends + resolveWindow, escrow, tranche);
    }

    /// @notice Resolve the open milestone once its window is over; anyone may call. Until `resolveBy`
    /// the tranche fixed at the post, less what leavers took of it, goes to the DAO treasury; nothing
    /// that arrived after the post is taken. After `resolveBy` the milestone is voided and releases
    /// nothing.
    /// @return wasReleased Whether the milestone was released (false when voided).
    /// @return amount What went to the treasury (zero when voided, or when everyone left).
    function resolveMilestone() external nonReentrant returns (bool wasReleased, uint256 amount) {
        uint256 id = milestoneCount;
        Milestone storage m = milestones[id];
        if (m.status != MilestoneStatus.Open) revert NoOpenMilestone();
        if (block.timestamp < m.windowEndsAt) revert WindowNotOver();
        if (block.timestamp < m.resolveBy) {
            wasReleased = true;
            amount = pending;
            m.status = MilestoneStatus.Released;
            if (amount != 0) {
                m.released = amount;
                escrow -= amount;
                released += amount;
                lastReleaseAt = uint64(block.timestamp);
            }
        } else {
            m.status = MilestoneStatus.Void;
        }
        pending = 0;
        staked = 0;
        emit MilestoneResolved(id, wasReleased, amount);
        if (amount != 0) _payTreasury(amount);
    }

    /// @notice Send the DAO treasury what it is owed: the fees since the last payment, and any released
    /// money a transfer did not deliver. Anyone may call.
    function payTreasury() external nonReentrant {
        if (treasuryOwed == 0) revert NothingOwed();
        _payTreasury(0);
        if (treasuryOwed != 0) revert BadQuoteTransfer();
    }

    // ---- abandonment ----------------------------------------------------------------------------------------------

    /// @notice Vote, with all of your weight, to declare the project abandoned. A wallet may vote only
    /// `voteSeasoning` after its last buy or redeem; buying again (or redeeming claim tokens) withdraws the
    /// vote, selling shrinks it.
    function voteAbandon() external nonReentrant {
        if (abandoned()) revert IsAbandoned();
        uint256 weight = weightOf[msg.sender];
        if (weight == 0) revert NoSay();
        if (votedAbandon[msg.sender]) revert AlreadyDone();
        uint256 notBefore = uint256(lastBuyAt[msg.sender]) + voteSeasoning;
        if (block.timestamp < notBefore) revert TooSoon(notBefore);
        votedAbandon[msg.sender] = true;
        abandonVotes += weight;
        emit AbandonVoted(msg.sender, weight);
    }

    /// @notice Write the change to "abandoned"; anyone may call once either condition holds: no release
    /// for `voteAfter` and more than half the weight votes for it, or the clock has run out (a backer holding
    /// a weight and no release for `abandonAfter`; an open milestone is resolved or voided first). A sale makes
    /// the same change by itself when the clock has run out, so nobody has to call this for backers to
    /// get their money.
    function declareAbandoned() external nonReentrant {
        if (_abandonedWritten) revert IsAbandoned();
        bool byVote = totalWeight != 0 && abandonVotes > totalWeight / 2
            && block.timestamp >= uint256(lastReleaseAt) + voteAfter;
        if (!byVote && !_clockRanOut()) revert NotAbandonable();
        _abandon(byVote);
        if (treasuryOwed != 0) _payTreasury(0);
    }

    // ---- reads ----------------------------------------------------------------------------------------------------

    /// @notice Whether the project is abandoned: declared so, or its clock has run out (the next sale
    /// writes it). Final either way.
    function abandoned() public view returns (bool) {
        return _abandonedWritten || _clockRanOut();
    }

    /// @notice The curve price now, before the fee: quote base units per whole unit (1e18 base units),
    /// times 1e18. Divide by 1e18 and by ten to the quote token's decimals for a price in whole tokens.
    function price() public view returns (uint256) {
        return Math.mulDiv(virtualQuote + reserve, 1e18 * PRICE_SCALE, virtualUnits - totalSupply);
    }

    /// @notice What one whole unit costs to buy at the margin, with the project part and fee included,
    /// in the same fixed point as `price`.
    function buyPrice() public view returns (uint256) {
        return Math.mulDiv(price(), BPS * BPS, uint256(BPS - feeBps) * (BPS - projectBps), Math.Rounding.Ceil);
    }

    /// @notice What a buy of exactly `quoteIn` gives now.
    /// @return unitsOut Units received.
    /// @return fee The fee, owed to the DAO treasury.
    /// @return toEscrow The project part, held in the escrow.
    /// @return priceAfter The curve price after the buy (see `price`).
    function quoteBuy(uint256 quoteIn)
        external
        view
        returns (uint256 unitsOut, uint256 fee, uint256 toEscrow, uint256 priceAfter)
    {
        uint256 toReserve;
        (unitsOut, fee, toEscrow, toReserve) = _quoteBuy(quoteIn);
        priceAfter = Math.mulDiv(
            virtualQuote + reserve + toReserve, 1e18 * PRICE_SCALE, virtualUnits - totalSupply - unitsOut
        );
    }

    /// @notice What `holder` selling `unitsIn` gets now.
    /// @return quoteOut Quote received (fee taken, refund added).
    /// @return fee The fee, owed to the DAO treasury (zero once abandoned).
    /// @return refund The holder's part of the escrow paid with this sale (zero before abandonment).
    /// @return priceAfter The curve price after the sale (see `price`).
    function quoteSell(address holder, uint256 unitsIn)
        public
        view
        returns (uint256 quoteOut, uint256 fee, uint256 refund, uint256 priceAfter)
    {
        // A sale made now would first write the abandonment the clock has already decided.
        bool gone = abandoned();
        uint256 left = _abandonedWritten || !gone ? escrow : escrow - _orphaned();
        uint256 gross;
        (gross, fee, refund,) = _quoteSell(holder, unitsIn, gone, left);
        quoteOut = gross - fee + refund;
        priceAfter =
            Math.mulDiv(virtualQuote + reserve - gross, 1e18 * PRICE_SCALE, virtualUnits - totalSupply + unitsIn);
    }

    /// @notice Whether `holder` may leave now: a milestone's window is running, and they hold units they
    /// had before it was posted and have not bought since.
    function canLeave(address holder) public view returns (bool) {
        uint256 id = _liveMilestone();
        return id != 0 && balanceOf[holder] != 0 && boughtDuring[holder] != id;
    }

    /// @notice What `holder` gets by leaving now; all zero when they cannot.
    /// @return quoteOut Quote received: `fromCurve` plus `fromEscrow`.
    /// @return fromCurve What their units sell for, after the fee.
    /// @return fromEscrow Their whole part of the escrow.
    /// @return priceAfter The curve price after they left (see `price`).
    /// @return fee The ordinary sale fee on the curve part, owed to the DAO treasury.
    function quoteLeave(address holder)
        public
        view
        returns (uint256 quoteOut, uint256 fromCurve, uint256 fromEscrow, uint256 priceAfter, uint256 fee)
    {
        if (!canLeave(holder)) return (0, 0, 0, 0, 0);
        uint256 units = balanceOf[holder];
        uint256 gross;
        (gross,, fromEscrow,) = _quoteLeave(holder, units);
        fee = _bpsUp(gross, feeBps);
        fromCurve = gross - fee;
        quoteOut = fromCurve + fromEscrow;
        priceAfter =
            Math.mulDiv(virtualQuote + reserve - gross, 1e18 * PRICE_SCALE, virtualUnits - totalSupply + units);
    }

    /// @notice `holder`'s part of the escrow now: what leaving would hand back while they can leave,
    /// what a refund pays once abandoned, and otherwise their part with any open tranche taken off.
    function escrowOf(address holder) public view returns (uint256) {
        uint256 weight = weightOf[holder];
        if (weight == 0) return 0;
        if (_abandonedWritten) return Math.mulDiv(escrow, weight, totalWeight);
        if (_clockRanOut()) return Math.mulDiv(escrow - _orphaned(), weight, totalWeight);
        if (canLeave(holder)) {
            (,, uint256 fromEscrow,) = _quoteLeave(holder, balanceOf[holder]);
            return fromEscrow;
        }
        return Math.mulDiv(escrow - pending, weight, totalWeight + WEIGHT_OFFSET);
    }

    /// @notice The earliest time the next milestone may be posted.
    function nextClaimAt() public view returns (uint64) {
        return lastClaimAt + claimInterval;
    }

    /// @notice The time from which the project counts as abandoned for lack of a release, if a backer
    /// holds a weight then and no milestone is open.
    function abandonableAt() public view returns (uint64) {
        return lastReleaseAt + abandonAfter;
    }

    /// @notice The opening round and what one wallet can redeem (pass the zero address for the round alone).
    /// All zero for a pool opened without a round.
    function roundInfo(address holder) public view returns (RoundView memory r) {
        r.state = roundState;
        if (r.state == RoundState.None) return r;
        r.claimToken = address(claimToken);
        r.supply = roundSupply;
        r.minimumRaise = minimumRaise;
        r.holderClaimTokens = claimToken.balanceOf(holder);
        r.auction = auction;
        if (r.auction == address(0)) return r;
        IRoundAuction a = IRoundAuction(r.auction);
        r.endBlock = a.endBlock();
        r.raised = a.currencyRaised();
        r.clearingPriceX96 = r.state == RoundState.Live ? clearingPriceX96 : a.clearingPrice();
        r.received = roundReceived;
        r.unitsSold = roundUnits;
        r.openingPrice = openingPrice;
        r.liveAt = liveAt;
        r.unredeemedUnits = unredeemedUnits;
    }

    /// @notice The pool and one wallet in one call (pass the zero address for the pool alone).
    function snapshot(address holder) external view returns (Snapshot memory s) {
        s.price = price();
        s.buyPrice = buyPrice();
        s.reserve = reserve;
        s.escrow = escrow;
        s.released = released;
        s.refunded = refunded;
        s.feesTaken = feesTaken;
        s.treasuryOwed = treasuryOwed;
        s.totalSupply = totalSupply;
        s.totalWeight = totalWeight;
        s.abandoned = abandoned();
        s.openedAt = openedAt;
        s.nextClaimAt = nextClaimAt();
        s.abandonableAt = abandonableAt();
        s.abandonVotes = abandonVotes;
        s.milestoneId = milestoneCount;
        s.milestone = milestones[s.milestoneId];
        s.pending = pending;
        s.holderUnits = balanceOf[holder];
        s.holderWeight = weightOf[holder];
        s.holderEscrow = escrowOf(holder);
        if (s.holderUnits != 0) (s.holderSellValue,,,) = quoteSell(holder, s.holderUnits);
        s.holderCanLeave = canLeave(holder);
        (s.holderLeaveValue,,,,) = quoteLeave(holder);
        s.holderVotedAbandon = votedAbandon[holder];
        s.round = roundInfo(holder);
        if (earlyCap != 0 && block.timestamp < uint256(openedAt) + earlyWindow) {
            s.holderEarlyLeft = earlyCap - earlySpent[holder];
        } else {
            s.holderEarlyLeft = type(uint256).max;
        }
    }

    // ---- internals ------------------------------------------------------------------------------------------------

    /// @dev `amount * bps / 10000`, rounded up: fees and the project part never round in a trader's favour.
    function _bpsUp(uint256 amount, uint256 bps) private pure returns (uint256) {
        return (amount * bps + BPS - 1) / BPS;
    }

    /// @dev The split and the curve for a buy. Everything rounds against the buyer: the fee and the project
    /// part up, the units down.
    function _quoteBuy(uint256 quoteIn)
        private
        view
        returns (uint256 unitsOut, uint256 fee, uint256 toProject, uint256 toReserve)
    {
        if (quoteIn > type(uint128).max) revert TooLarge();
        fee = _bpsUp(quoteIn, feeBps);
        uint256 net = quoteIn - fee;
        toProject = _bpsUp(net, projectBps);
        toReserve = net - toProject;
        uint256 x = virtualQuote + reserve;
        if (x + toReserve > type(uint128).max) revert TooLarge();
        unitsOut = (virtualUnits - totalSupply) * toReserve / (x + toReserve);
    }

    /// @dev What `unitsIn` units pay from the curve.
    function _curveOut(uint256 unitsIn) private view returns (uint256) {
        return (virtualQuote + reserve) * unitsIn / (virtualUnits - totalSupply + unitsIn);
    }

    /// @dev The curve, the fee, the refund and the weight given up for a sale, with the project abandoned
    /// or not and `escrowLeft` to refund from.
    function _quoteSell(address holder, uint256 unitsIn, bool gone, uint256 escrowLeft)
        private
        view
        returns (uint256 gross, uint256 fee, uint256 refund, uint256 weight)
    {
        uint256 held = balanceOf[holder];
        if (unitsIn > held) revert InsufficientUnits();
        gross = _curveOut(unitsIn);
        uint256 holderWeight = weightOf[holder];
        weight = unitsIn == held ? holderWeight : Math.mulDiv(holderWeight, unitsIn, held);
        if (gone) {
            if (weight != 0) refund = Math.mulDiv(escrowLeft, weight, totalWeight);
        } else {
            fee = _bpsUp(gross, feeBps);
        }
    }

    /// @dev What leaving pays before the fee: the curve, and the leaver's whole part of the escrow, which is
    /// their part of the escrow with the tranche taken off plus their part of the tranche.
    function _quoteLeave(address holder, uint256 units)
        private
        view
        returns (uint256 gross, uint256 fromTranche, uint256 fromEscrow, uint256 weight)
    {
        gross = _curveOut(units);
        weight = weightOf[holder];
        if (weight != 0) {
            fromTranche = Math.mulDiv(pending, weight, staked);
            fromEscrow = Math.mulDiv(escrow - pending, weight, totalWeight + WEIGHT_OFFSET) + fromTranche;
        }
    }

    /// @dev Take `units` and `weight` from `holder` and `gross` from the reserve.
    function _burn(address holder, uint256 units, uint256 weight, uint256 gross) private {
        if (weight != 0) {
            if (votedAbandon[holder]) abandonVotes -= weight;
            weightOf[holder] -= weight;
            totalWeight -= weight;
        }
        balanceOf[holder] -= units;
        totalSupply -= units;
        reserve -= gross;
    }

    /// @dev The id of the milestone whose window is running now, or zero.
    function _liveMilestone() private view returns (uint256 id) {
        id = milestoneCount;
        Milestone storage m = milestones[id];
        if (m.status != MilestoneStatus.Open || block.timestamp >= m.windowEndsAt) return 0;
    }

    /// @dev The weight wallets hold: all of it, less the round's weight nobody has redeemed. That bucket
    /// belongs to claim tokens, not to a wallet that can sell, vote or be refunded, and part of it can never
    /// be redeemed (the auction rounds the units it counts as sold up, and what its bidders are paid down, so
    /// a few base units are left over for good). It counts as staying at a milestone and in the share of the
    /// escrow a refund divides, but not as "somebody is backing this pool": that is a wallet's weight.
    function _redeemableWeight() private view returns (uint256) {
        return totalWeight - unredeemedWeight;
    }

    /// @dev Whether the clock has made the project abandoned: some wallet holds a weight, nothing was
    /// released for `abandonAfter`, and no milestone is still waiting to be resolved. With no backer there is
    /// nobody to hand anything back to: the pool stays open, and any escrow left behind by people who sold
    /// stays project money, released by milestones. (Round buyers who have not redeemed yet are not backers
    /// until they do; once one redeems, a clock that has already run out takes effect at once, so they can
    /// always redeem and be refunded.)
    function _clockRanOut() private view returns (bool) {
        if (_redeemableWeight() == 0 || block.timestamp < uint256(lastReleaseAt) + abandonAfter) return false;
        Milestone storage m = milestones[milestoneCount];
        return m.status != MilestoneStatus.Open || block.timestamp >= m.resolveBy;
    }

    /// @dev The slice of the escrow no backer has a weight for (all of it when nobody has any).
    function _orphaned() private view returns (uint256) {
        if (totalWeight == 0) return escrow;
        return Math.mulDiv(escrow, WEIGHT_OFFSET, totalWeight + WEIGHT_OFFSET, Math.Rounding.Ceil);
    }

    /// @dev Write the abandonment. An open milestone ends with nothing released, and the escrow no
    /// backer has a weight for goes to the treasury, so what is left divides among the backers exactly
    /// as their parts stood, and a later buyer can never have it.
    function _abandon(bool byVote) private {
        uint256 id = milestoneCount;
        Milestone storage m = milestones[id];
        if (m.status == MilestoneStatus.Open) {
            m.status = MilestoneStatus.Void;
            pending = 0;
            staked = 0;
            emit MilestoneResolved(id, false, 0);
        }
        _abandonedWritten = true;
        uint256 orphaned = _orphaned();
        if (orphaned != 0) {
            escrow -= orphaned;
            released += orphaned;
            treasuryOwed += orphaned;
        }
        emit Abandoned(msg.sender, byVote, escrow, orphaned);
    }

    /// @dev Add `amount` to what the treasury is owed and try to pay all of it. A token that refuses
    /// (a blocked address, a pause) never stops a milestone or an abandonment: the money waits here,
    /// counted apart, for `payTreasury`.
    function _payTreasury(uint256 amount) private {
        uint256 owed = treasuryOwed + amount;
        (bool ok, bytes memory ret) = address(quote).call(abi.encodeCall(IERC20.transfer, (dao, owed)));
        if (ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))))) {
            treasuryOwed = 0;
            emit TreasuryPaid(owed);
        } else {
            treasuryOwed = owed;
        }
    }
}
