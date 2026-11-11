// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BackingPool
/// @notice Instant backing for one project (docs/v3-review/BACKING-POOL.md). Anyone buys the project's
/// backing units with the quote token at a price read from a curve, and sells them back to the same
/// curve at any time: no rounds, no seats, no keeper. Part of every buy stays here as the reserve that
/// pays sellers; the rest is the project's money, held here until the project confirms a milestone and
/// backers do not object, and handed back to the backers who are still holding if the project is
/// declared abandoned.
///
/// WHAT A BACKER HOLDS. Backing units are a ledger inside this contract: they are not the DAO's Shares,
/// carry no vote in the DAO, and cannot be moved between wallets. The DAO's Shares can only ever be
/// minted by a reviewed award (the issuance rule is sealed at the DAO's birth), so no pool could mint
/// them, and a pool that could would let anyone buy a majority of the votes in one transaction. The
/// only voice a unit holder has is here, over this pool's project money: objecting to a milestone and
/// voting the project abandoned.
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
/// operator: it is what makes churn and griefing cost something the project receives), then
/// `projectBps` of the rest goes to the escrow and the remainder to the reserve. Each backer's part of
/// the escrow is tracked as a weight, priced like a vault share so a newcomer's weight is worth exactly
/// what they just put in: nobody can buy in late and take a part of money others left. Selling units
/// gives up the matching part of the seller's weight; what it stood for stays in the escrow for those
/// who remain. So a buy-then-sell loses the project part by design: this is backing, not a trade.
///
/// MILESTONES. The founder (or the DAO) posts "milestone reached" with the id of the public record
/// event; that opens an objection window. Backers who held before the post object with their weight.
/// When the window ends anyone resolves it: if objections reached `objectionBps` of the weight that
/// could object, the money stays; otherwise `trancheBps` of the escrow goes to the DAO treasury.
/// Buying during a window gives up that wallet's say on that milestone (so nobody can buy a block, or
/// buy to drown one), and tallies freeze when the window ends.
///
/// ABANDONMENT. If no tranche has been released for `abandonAfter`, or for `voteAfter` and backers
/// holding more than half the weight vote for it, anyone can declare the project abandoned. Buying and claiming stop for good;
/// selling keeps working on the curve, and each sale also pays the seller's part of the remaining
/// escrow.
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
        /// The part of the escrow one confirmed milestone releases (basis points).
        uint16 trancheBps;
        /// Objections at or above this part of the weight that could object keep a tranche back.
        uint16 objectionBps;
        /// How long backers have to object to a posted milestone.
        uint32 objectionWindow;
        /// The least time between two milestone posts (and between opening and the first one).
        uint32 claimInterval;
        /// How long without a released tranche before anyone may declare the project abandoned.
        uint32 abandonAfter;
        /// How long after a wallet's last buy before it may vote the project abandoned.
        uint32 voteSeasoning;
        /// How long without a released tranche before a vote of the backers can declare the project abandoned.
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
        Blocked,
        Void
    }

    /// @notice One milestone post.
    struct Milestone {
        bytes32 ref;
        uint64 postedAt;
        uint64 windowEndsAt;
        MilestoneStatus status;
        /// Weight that may object: what was held at the post, less what was sold or excluded since.
        uint256 eligible;
        uint256 objections;
        uint256 released;
    }

    /// @notice Everything the app shows about a pool and one wallet, in one call.
    struct Snapshot {
        uint256 price;
        uint256 buyPrice;
        uint256 reserve;
        uint256 escrow;
        uint256 released;
        uint256 refunded;
        uint256 totalSupply;
        uint256 totalWeight;
        bool abandoned;
        uint64 openedAt;
        uint64 nextClaimAt;
        uint64 abandonableAt;
        uint256 abandonVotes;
        uint256 feesTaken;
        uint256 treasuryOwed;
        uint256 milestoneId;
        Milestone milestone;
        uint256 holderUnits;
        uint256 holderWeight;
        uint256 holderEscrow;
        uint256 holderSellValue;
        bool holderCanObject;
        bool holderObjected;
        bool holderVotedAbandon;
        uint256 holderEarlyLeft;
    }

    uint256 private constant BPS = 10_000;
    /// @dev The vault-share offset: a first backer's weight is their project money times this, and the
    /// "plus one" beside it keeps the price defined when the escrow holds money nobody has a weight for.
    uint256 private constant WEIGHT_OFFSET = 1e12;

    /// @notice Units have 18 decimals, like the DAO's Shares.
    uint8 public constant decimals = 18;

    /// @notice The factory that made this pool.
    address public immutable factory;
    /// @notice The project's DAO: the treasury released tranches are paid to, and one of the two
    /// addresses that may post a milestone.
    address public immutable dao;
    /// @notice The founder, the other address that may post a milestone; zero when only the DAO may.
    address public immutable founder;
    /// @notice What backers pay in and are paid in.
    IERC20 public immutable quote;
    /// @notice When the pool opened.
    uint64 public immutable openedAt;

    uint256 public immutable virtualQuote;
    uint256 public immutable virtualUnits;
    uint16 public immutable projectBps;
    uint16 public immutable feeBps;
    uint16 public immutable trancheBps;
    uint16 public immutable objectionBps;
    uint32 public immutable objectionWindow;
    uint32 public immutable claimInterval;
    uint32 public immutable abandonAfter;
    uint32 public immutable voteSeasoning;
    uint32 public immutable voteAfter;
    uint32 public immutable earlyWindow;
    uint256 public immutable earlyCap;

    /// @notice Units in existence.
    uint256 public totalSupply;
    /// @notice Units a wallet holds.
    mapping(address => uint256) public balanceOf;
    /// @notice Quote held to pay curve sales.
    uint256 public reserve;
    /// @notice Project money held here: not yet released, not yet refunded.
    uint256 public escrow;
    /// @notice Project money released to the DAO treasury so far (paid or still owed).
    uint256 public released;
    /// @notice Project money refunded to backers after abandonment so far.
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
    /// @notice When the latest milestone was posted (the opening time before the first).
    uint64 public lastClaimAt;
    /// @notice When the latest tranche was released (the opening time before the first).
    uint64 public lastReleaseAt;
    /// @notice True once the project was declared abandoned. Final.
    bool public abandoned;
    /// @notice Weight currently voting to declare the project abandoned.
    uint256 public abandonVotes;

    /// @notice The milestone whose window a wallet bought during (it has no say on that one).
    mapping(address => uint256) public boughtDuring;
    /// @notice The milestone a wallet is objecting to.
    mapping(address => uint256) public objectedTo;
    /// @notice Whether a wallet is voting to declare the project abandoned.
    mapping(address => bool) public votedAbandon;
    /// @notice When a wallet last bought.
    mapping(address => uint64) public lastBuyAt;
    /// @notice Quote a wallet spent during the early window.
    mapping(address => uint256) public earlySpent;

    bool private transient _entered;

    /// @notice A buy. `priceAfter` is the curve price after it (quote base units per whole unit).
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
    /// @notice A milestone was posted and its objection window opened.
    event MilestonePosted(
        uint256 indexed id, bytes32 indexed ref, address indexed by, uint64 windowEndsAt, uint256 eligible
    );
    /// @notice A backer objected to a milestone.
    event Objected(uint256 indexed id, address indexed backer, uint256 weight);
    /// @notice A milestone's window ended and it was resolved: released, or kept back.
    event MilestoneResolved(uint256 indexed id, bool released, uint256 amount, uint256 objections, uint256 eligible);
    /// @notice Released money reached the DAO treasury.
    event TreasuryPaid(uint256 amount);
    /// @notice A backer voted to declare the project abandoned.
    event AbandonVoted(address indexed backer, uint256 weight);
    /// @notice The project was declared abandoned. `orphaned` is escrow nobody had a weight for.
    event Abandoned(address indexed by, bool byVote, uint256 escrow, uint256 orphaned);

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
    constructor(address dao_, address founder_, IERC20 quote_, Params memory p) {
        if (dao_ == address(0) || dao_.code.length == 0 || address(quote_).code.length == 0) revert InvalidParams();
        if (
            p.virtualQuote == 0 || p.virtualQuote > type(uint112).max || p.virtualUnits < 1e18
                || p.virtualUnits > type(uint112).max || p.projectBps > 9000 || p.feeBps > 500 || p.trancheBps == 0
                || p.trancheBps > 5000 || p.objectionBps == 0 || p.objectionBps > BPS || p.objectionWindow < 1 days
                || p.objectionWindow > 30 days || p.claimInterval < p.objectionWindow || p.claimInterval > 365 days
                || p.abandonAfter <= uint256(p.claimInterval) + p.objectionWindow || p.abandonAfter > 1460 days
                || p.voteSeasoning > 90 days || p.voteAfter > p.abandonAfter || p.earlyWindow > 30 days
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
        objectionBps = p.objectionBps;
        objectionWindow = p.objectionWindow;
        claimInterval = p.claimInterval;
        abandonAfter = p.abandonAfter;
        voteSeasoning = p.voteSeasoning;
        voteAfter = p.voteAfter;
        earlyWindow = p.earlyWindow;
        earlyCap = p.earlyCap;
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
        if (abandoned) revert IsAbandoned();
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

        // A wallet that buys while a window is running has no say on that milestone, and has to wait
        // again before it can vote the project abandoned.
        uint256 weightBefore = weightOf[msg.sender];
        uint256 id = _liveMilestone();
        if (id != 0 && boughtDuring[msg.sender] != id) {
            boughtDuring[msg.sender] = id;
            Milestone storage m = milestones[id];
            m.eligible -= weightBefore;
            if (objectedTo[msg.sender] == id) {
                objectedTo[msg.sender] = 0;
                m.objections -= weightBefore;
            }
        }
        if (votedAbandon[msg.sender]) {
            votedAbandon[msg.sender] = false;
            abandonVotes -= weightBefore;
        }
        lastBuyAt[msg.sender] = uint64(block.timestamp);

        // The buyer's weight is priced before their money goes in, so it is worth what they add.
        uint256 weight = Math.mulDiv(toProject, totalWeight + WEIGHT_OFFSET, escrow + 1);
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

    /// @notice Sell `unitsIn` units back to the curve. After abandonment the sale also pays your part of
    /// the remaining escrow; before it, the matching part of your weight stays with those who remain.
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
        (uint256 gross, uint256 fee, uint256 refund, uint256 weight) = _quoteSell(msg.sender, unitsIn);
        quoteOut = gross - fee + refund;
        if (quoteOut < minQuoteOut) revert Slippage();

        if (weight != 0) {
            uint256 id = _liveMilestone();
            if (id != 0 && boughtDuring[msg.sender] != id) {
                Milestone storage m = milestones[id];
                m.eligible -= weight;
                if (objectedTo[msg.sender] == id) m.objections -= weight;
            }
            if (votedAbandon[msg.sender]) abandonVotes -= weight;
            weightOf[msg.sender] -= weight;
            totalWeight -= weight;
        }
        balanceOf[msg.sender] -= unitsIn;
        totalSupply -= unitsIn;
        reserve -= gross;
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

    // ---- milestones -----------------------------------------------------------------------------------------------

    /// @notice Post "milestone reached": the founder or the DAO names the public record event that
    /// shows it, and the objection window opens. One post at a time, and no sooner than `claimInterval`
    /// after the last one (or after opening).
    /// @param ref The id of the public record event for this milestone.
    /// @return id The milestone's id.
    function postMilestone(bytes32 ref) external nonReentrant returns (uint256 id) {
        if (msg.sender != dao && (founder == address(0) || msg.sender != founder)) revert NotClaimant();
        if (abandoned) revert IsAbandoned();
        if (ref == bytes32(0)) revert ZeroAmount();
        if (milestones[milestoneCount].status == MilestoneStatus.Open) revert MilestoneOpen();
        uint256 notBefore = uint256(lastClaimAt) + claimInterval;
        if (block.timestamp < notBefore) revert TooSoon(notBefore);
        id = ++milestoneCount;
        uint64 ends = uint64(block.timestamp) + objectionWindow;
        milestones[id] = Milestone({
            ref: ref,
            postedAt: uint64(block.timestamp),
            windowEndsAt: ends,
            status: MilestoneStatus.Open,
            eligible: totalWeight,
            objections: 0,
            released: 0
        });
        lastClaimAt = uint64(block.timestamp);
        emit MilestonePosted(id, ref, msg.sender, ends, totalWeight);
    }

    /// @notice Object to the open milestone with all of your weight. Only while its window runs, and
    /// only for a wallet that has not bought since it was posted. Selling afterwards takes the sold
    /// part of the objection with it.
    function object() external nonReentrant {
        uint256 id = _liveMilestone();
        if (id == 0) revert WindowOver();
        uint256 weight = weightOf[msg.sender];
        if (weight == 0 || boughtDuring[msg.sender] == id) revert NoSay();
        if (objectedTo[msg.sender] == id) revert AlreadyDone();
        objectedTo[msg.sender] = id;
        milestones[id].objections += weight;
        emit Objected(id, msg.sender, weight);
    }

    /// @notice Resolve the open milestone once its window is over; anyone may call. If objections
    /// reached the threshold the escrow stays whole; otherwise one tranche goes to the DAO treasury.
    /// @return wasReleased Whether a tranche was released.
    /// @return amount The tranche released (zero when kept back).
    function resolveMilestone() external nonReentrant returns (bool wasReleased, uint256 amount) {
        if (abandoned) revert IsAbandoned();
        uint256 id = milestoneCount;
        Milestone storage m = milestones[id];
        if (m.status != MilestoneStatus.Open) revert NoOpenMilestone();
        if (block.timestamp < m.windowEndsAt) revert WindowNotOver();
        if (_blocked(m)) {
            m.status = MilestoneStatus.Blocked;
        } else {
            wasReleased = true;
            amount = escrow * trancheBps / BPS;
            m.status = MilestoneStatus.Released;
            m.released = amount;
            escrow -= amount;
            released += amount;
            lastReleaseAt = uint64(block.timestamp);
        }
        emit MilestoneResolved(id, wasReleased, amount, m.objections, m.eligible);
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
    /// `voteSeasoning` after its last buy; buying again withdraws the vote, selling shrinks it.
    function voteAbandon() external nonReentrant {
        if (abandoned) revert IsAbandoned();
        uint256 weight = weightOf[msg.sender];
        if (weight == 0) revert NoSay();
        if (votedAbandon[msg.sender]) revert AlreadyDone();
        uint256 notBefore = uint256(lastBuyAt[msg.sender]) + voteSeasoning;
        if (block.timestamp < notBefore) revert TooSoon(notBefore);
        votedAbandon[msg.sender] = true;
        abandonVotes += weight;
        emit AbandonVoted(msg.sender, weight);
    }

    /// @notice Declare the project abandoned; anyone may call once either condition holds: no tranche
    /// was released for `voteAfter` and more than half the weight votes for it, or no tranche was released for `abandonAfter` (a milestone whose
    /// window is still running, or that is waiting to be released, is settled first). Final: buying and
    /// milestones stop, and every sale from now on also pays the seller's part of the escrow.
    function declareAbandoned() external nonReentrant {
        if (abandoned) revert IsAbandoned();
        bool byVote = totalWeight != 0 && abandonVotes > totalWeight / 2
            && block.timestamp >= uint256(lastReleaseAt) + voteAfter;
        Milestone storage m = milestones[milestoneCount];
        if (!byVote) {
            if (block.timestamp < uint256(lastReleaseAt) + abandonAfter) revert NotAbandonable();
            // A milestone still inside its window, or one that passed and only waits for `resolveMilestone`,
            // is the project's last word: it is heard before the clock decides.
            if (m.status == MilestoneStatus.Open && (block.timestamp < m.windowEndsAt || !_blocked(m))) {
                revert MilestoneOpen();
            }
        }
        if (m.status == MilestoneStatus.Open) {
            m.status = byVote ? MilestoneStatus.Void : MilestoneStatus.Blocked;
            emit MilestoneResolved(milestoneCount, false, 0, m.objections, m.eligible);
        }
        abandoned = true;
        // Escrow nobody holds a weight for (every backer had already left) has no one to go back to.
        uint256 orphaned;
        if (totalWeight == 0 && escrow != 0) {
            orphaned = escrow;
            escrow = 0;
            released += orphaned;
        }
        emit Abandoned(msg.sender, byVote, escrow, orphaned);
        if (orphaned != 0) _payTreasury(orphaned);
    }

    // ---- reads ----------------------------------------------------------------------------------------------------

    /// @notice The curve price now: quote base units one whole unit (1e18) sells for at the margin,
    /// before the fee.
    function price() public view returns (uint256) {
        return Math.mulDiv(virtualQuote + reserve, 1e18, virtualUnits - totalSupply);
    }

    /// @notice What one whole unit costs to buy at the margin, with the project part and fee included.
    function buyPrice() public view returns (uint256) {
        return Math.mulDiv(price(), BPS * BPS, uint256(BPS - feeBps) * (BPS - projectBps), Math.Rounding.Ceil);
    }

    /// @notice What a buy of exactly `quoteIn` gives now.
    /// @return unitsOut Units received.
    /// @return fee The fee, owed to the DAO treasury.
    /// @return toEscrow The project part, held in the escrow.
    /// @return priceAfter The curve price after the buy.
    function quoteBuy(uint256 quoteIn)
        external
        view
        returns (uint256 unitsOut, uint256 fee, uint256 toEscrow, uint256 priceAfter)
    {
        uint256 toProject;
        uint256 toReserve;
        (unitsOut, fee, toProject, toReserve) = _quoteBuy(quoteIn);
        toEscrow = toProject;
        priceAfter =
            Math.mulDiv(virtualQuote + reserve + toReserve, 1e18, virtualUnits - totalSupply - unitsOut);
    }

    /// @notice What `holder` selling `unitsIn` gets now.
    /// @return quoteOut Quote received (fee taken, refund added).
    /// @return fee The fee, owed to the DAO treasury (zero after abandonment).
    /// @return refund The holder's part of the escrow paid with this sale (zero before abandonment).
    /// @return priceAfter The curve price after the sale.
    function quoteSell(address holder, uint256 unitsIn)
        external
        view
        returns (uint256 quoteOut, uint256 fee, uint256 refund, uint256 priceAfter)
    {
        uint256 gross;
        (gross, fee, refund,) = _quoteSell(holder, unitsIn);
        quoteOut = gross - fee + refund;
        priceAfter = Math.mulDiv(virtualQuote + reserve - gross, 1e18, virtualUnits - totalSupply + unitsIn);
    }

    /// @notice What `holder`'s weight in the escrow is worth now: their part of the money not yet
    /// released, which they get back if the project is abandoned while they still hold.
    function escrowOf(address holder) public view returns (uint256) {
        uint256 weight = weightOf[holder];
        if (weight == 0) return 0;
        return Math.mulDiv(escrow, weight, abandoned ? totalWeight : totalWeight + WEIGHT_OFFSET);
    }

    /// @notice The earliest time the next milestone may be posted.
    function nextClaimAt() public view returns (uint64) {
        return lastClaimAt + claimInterval;
    }

    /// @notice The time from which the project may be declared abandoned for lack of a release.
    function abandonableAt() public view returns (uint64) {
        return lastReleaseAt + abandonAfter;
    }

    /// @notice The pool and one wallet in one call (pass the zero address for the pool alone).
    function snapshot(address holder) external view returns (Snapshot memory s) {
        s.price = price();
        s.buyPrice = buyPrice();
        s.reserve = reserve;
        s.escrow = escrow;
        s.released = released;
        s.refunded = refunded;
        s.totalSupply = totalSupply;
        s.totalWeight = totalWeight;
        s.abandoned = abandoned;
        s.openedAt = openedAt;
        s.nextClaimAt = nextClaimAt();
        s.abandonableAt = abandonableAt();
        s.abandonVotes = abandonVotes;
        s.feesTaken = feesTaken;
        s.treasuryOwed = treasuryOwed;
        s.milestoneId = milestoneCount;
        s.milestone = milestones[s.milestoneId];
        s.holderUnits = balanceOf[holder];
        s.holderWeight = weightOf[holder];
        s.holderEscrow = escrowOf(holder);
        if (s.holderUnits != 0) {
            (uint256 gross, uint256 fee, uint256 refund,) = _quoteSell(holder, s.holderUnits);
            s.holderSellValue = gross - fee + refund;
        }
        uint256 live = _liveMilestone();
        s.holderObjected = live != 0 && objectedTo[holder] == live;
        s.holderCanObject = live != 0 && s.holderWeight != 0 && boughtDuring[holder] != live && !s.holderObjected;
        s.holderVotedAbandon = votedAbandon[holder];
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

    /// @dev The curve, the fee, the refund and the weight given up for a sale.
    function _quoteSell(address holder, uint256 unitsIn)
        private
        view
        returns (uint256 gross, uint256 fee, uint256 refund, uint256 weight)
    {
        uint256 held = balanceOf[holder];
        if (unitsIn > held) revert InsufficientUnits();
        gross = (virtualQuote + reserve) * unitsIn / (virtualUnits - totalSupply + unitsIn);
        uint256 holderWeight = weightOf[holder];
        weight = unitsIn == held ? holderWeight : Math.mulDiv(holderWeight, unitsIn, held);
        if (abandoned) {
            if (weight != 0) refund = Math.mulDiv(escrow, weight, totalWeight);
        } else {
            fee = _bpsUp(gross, feeBps);
        }
    }

    /// @dev The id of the milestone whose window is running now, or zero.
    function _liveMilestone() private view returns (uint256 id) {
        id = milestoneCount;
        Milestone storage m = milestones[id];
        if (m.status != MilestoneStatus.Open || block.timestamp >= m.windowEndsAt) return 0;
    }

    /// @dev Whether objections reached the threshold.
    function _blocked(Milestone storage m) private view returns (bool) {
        return m.objections != 0 && m.objections >= Math.mulDiv(m.eligible, objectionBps, BPS, Math.Rounding.Ceil);
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
