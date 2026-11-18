// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BlockNumberish} from "blocknumberish/src/BlockNumberish.sol";
import {Summoner} from "./majeur/MolochPatched.sol";
import {BackingPool, IRoundAuction} from "./BackingPool.sol";

/// @notice The canonical auction factory (Uniswap's `ContinuousClearingAuctionFactory`), as far as a round needs it.
interface IRoundAuctionFactory {
    function create(address token, uint256 amount, bytes calldata configData, bytes32 salt)
        external
        returns (address auction);
}

/// @dev The auction's own `AuctionParameters`, field for field (as `KitAuctionParameters` in `DaoLaunchKit`).
struct RoundAuctionParameters {
    address currency;
    address tokensRecipient;
    address fundsRecipient;
    uint64 startBlock;
    uint64 endBlock;
    uint64 claimBlock;
    uint256 tickSpacing;
    address validationHook;
    uint256 floorPrice;
    uint128 requiredCurrencyRaised;
    bytes auctionStepsData;
}

/// @notice What the factory reads from a candidate DAO.
interface IBackingMoloch {
    function votingWeight() external view returns (address);
}

/// @title BackingPoolDeployer
/// @notice Holds the pool's creation code for one `BackingPoolFactory`, which makes it in its constructor: with
/// that code inside the factory itself the factory would not fit the 24,576-byte limit. It does exactly what
/// its factory tells it and nothing for anyone else, keeps nothing, and is what a pool records as the
/// contract that made it (`BackingPool.factory`); the registry of real pools is `BackingPoolFactory.poolOf`.
contract BackingPoolDeployer {
    /// @notice The factory this deployer serves.
    address public immutable owner;

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Create a pool. Only the factory.
    function deploy(address dao, address founder, IERC20 quote, BackingPool.Params calldata terms, uint256 roundSupply)
        external
        returns (BackingPool pool)
    {
        if (msg.sender != owner) revert NotOwner();
        pool = new BackingPool(dao, founder, quote, terms, roundSupply);
    }

    /// @notice Bind a pool's opening round. Only the factory.
    function bindRound(BackingPool pool, address auction, uint256 minimumRaise) external {
        if (msg.sender != owner) revert NotOwner();
        pool.bindRound(auction, minimumRaise);
    }
}

/// @title BackingPoolFactory
/// @notice Opens the one `BackingPool` a project can have (docs/v3-review/BACKING-POOL.md), with terms
/// fixed here at deployment. The founder chooses one thing: how deep the curve is, from a short fixed list of
/// tiers (`depthTiers`; zero means the default). A deeper curve moves less when people sell, a shallower one
/// moves more as money comes in, so the right depth follows the size of the raise the founder hopes for.
/// One call, no vote: a pool needs no power
/// over the DAO (it mints no Shares and moves none), so nothing has to be authorised by the DAO first.
///
/// Who may open a project's pool: the founder the DAO's own voting policy recorded at birth
/// (`ContributorKitV2` and later), the DAO itself (a vote, the only way for a project made by the
/// legacy kit, whose policy records no founder), or the one kit this factory was deployed for, which
/// opens the pool in the same transaction that makes the project. The DAO must be a clone the pinned
/// summoner made: its runtime bytecode is compared with that summoner's proxy, as
/// `SecondaryMarketFactory` does.
///
/// TWO WAYS TO OPEN. `open` opens the curve at once. `openWithRound` opens the pool behind an opening round:
/// the factory creates the pool waiting, builds the auction's configuration itself (so there is no
/// founder-supplied configuration to validate: currency, recipients, blocks, floor, schedule are all derived
/// here from the pool and this factory's fixed round settings; the founder chooses at most the minimum to
/// raise), creates the auction on the canonical auction factory and binds it to the pool, then asks the auction to
/// checkpoint so that an auction counting blocks on another clock than this factory reverts the open (with the
/// auction's own `AuctionNotStarted`) instead of leaving a pool waiting for a round that has not begun. The curve
/// opens when the round is settled (`BackingPool.seedFromAuction`). A project whose round failed may open again.
///
/// No owner, no admin, no upgrade: the terms, the quote token and the kit are immutable, and after
/// `open` the factory has no power over the pool it made.
contract BackingPoolFactory is BlockNumberish {
    /// @notice The summoner every project opened here came from.
    Summoner public immutable summoner;
    /// @notice The runtime bytecode hash of that summoner's DAO clones.
    bytes32 public immutable daoRuntimeHash;
    /// @notice What every pool of this factory is bought and paid out in.
    IERC20 public immutable quote;
    /// @notice The kit that may open a pool for a project it is making; zero for none.
    address public immutable authorizedKit;
    /// @notice Each project's one pool.
    mapping(address => address) public poolOf;
    /// @notice Every pool, in the order opened.
    address[] public pools;

    /// @notice The contract that holds the pool's creation code and deploys pools for this factory only.
    BackingPoolDeployer public immutable poolDeployer;

    /// @notice The fixed settings of every opening round this factory makes.
    struct RoundSettings {
        /// The canonical auction factory; zero switches opening rounds off.
        address auctionFactory;
        /// How many blocks a round takes bids for. It must divide 10,000,000 (the auction sells an equal
        /// part of the supply every block).
        uint64 blocks;
        /// Claim tokens a round offers: at most half of the pool's paper units.
        uint128 supply;
    }

    /// @notice The canonical auction factory rounds are created on; zero when rounds are off.
    IRoundAuctionFactory public immutable auctionFactory;
    /// @notice How many blocks a round takes bids for.
    uint64 public immutable roundBlocks;
    /// @notice Claim tokens a round offers.
    uint128 public immutable roundSupply;
    /// @notice The curve depth (paper reserve, in quote base units) a pool gets when its founder names none: the
    /// `virtualQuote` of the terms this factory was deployed with. The tiers are fixed multiples of it.
    uint256 public immutable defaultDepth;
    /// @notice The paper units of every pool's curve, kept here to derive a round's price step.
    uint256 private immutable _virtualUnits;

    BackingPool.Params private _terms;

    /// @notice A project's pool was opened.
    event PoolOpened(address indexed dao, address indexed pool, address indexed founder, address openedBy);
    /// @notice The curve depth a pool was opened with (emitted right after `PoolOpened`): the chosen tier, or the
    /// default when the founder named none. A pool opened behind a round sets its own paper reserve when the round is
    /// settled, so this is where the founder's choice stays readable.
    event DepthChosen(address indexed pool, uint256 depth);
    /// @notice A project's pool was opened behind an opening round (`PoolOpened` is emitted too).
    event RoundOpened(
        address indexed dao,
        address indexed pool,
        address indexed auction,
        address claimToken,
        uint128 supply,
        uint128 minimumRaise,
        uint64 startBlock,
        uint64 endBlock
    );

    error InvalidSetup();
    error UnprovenDao();
    error AlreadyOpen(address pool);
    error NotAllowed();
    error RoundsOff();
    error MinimumTooLow(uint128 least);
    error BadDepth();

    /// @dev The least a round may be asked to raise, in quote base units: enough that every part of the split
    /// is more than nothing.
    uint128 private constant LEAST_MINIMUM = 10_000;

    /// @param pinnedSummoner The summoner whose DAOs may open pools here.
    /// @param quote_ The quote token of every pool.
    /// @param terms_ The terms every pool gets. A pool's own constructor is what checks them, so bad terms make
    /// `open` revert and nothing else: the deploy script checks them before it deploys.
    /// @param authorizedKit_ The kit that may open pools for projects it makes, or zero.
    /// @param round_ The opening-round settings (an `auctionFactory` of zero for none).
    constructor(
        Summoner pinnedSummoner,
        IERC20 quote_,
        BackingPool.Params memory terms_,
        address authorizedKit_,
        RoundSettings memory round_
    ) {
        if (address(pinnedSummoner).code.length == 0 || address(quote_).code.length == 0) {
            revert InvalidSetup();
        }
        address implementation = pinnedSummoner.getImplementation();
        if (implementation.code.length == 0) revert InvalidSetup();
        summoner = pinnedSummoner;
        daoRuntimeHash = keccak256(
            abi.encodePacked(hex"5f5f365f5f37365f73", bytes20(implementation), hex"5af43d5f5f3e6029573d5ffd5b3d5ff3")
        );
        quote = quote_;
        authorizedKit = authorizedKit_;
        // The tiers are fifths of the default depth (the shallowest is two fifths), so the default must divide by
        // five, and the deepest tier (twenty times the default) must stay within the pool's own limit (a uint112),
        // which also keeps a round's `depth << 96` far from overflowing. This holds whether or not rounds are on.
        if (terms_.virtualQuote == 0 || terms_.virtualQuote % 5 != 0 || terms_.virtualQuote > type(uint112).max / 20) {
            revert InvalidSetup();
        }
        _terms = terms_;
        defaultDepth = terms_.virtualQuote;
        _virtualUnits = terms_.virtualUnits;
        poolDeployer = new BackingPoolDeployer();
        if (round_.auctionFactory != address(0)) {
            if (
                round_.auctionFactory.code.length == 0 || round_.blocks == 0 || 10_000_000 % round_.blocks != 0
                    || 10_000_000 / round_.blocks > type(uint24).max || round_.supply < 1e18
                    || round_.supply > terms_.virtualUnits / 2
            ) revert InvalidSetup();
            // Every tier must give a round the auction accepts, so a bad pair of terms fails here and not at the
            // first founder who picks the tier.
            uint256[6] memory tiers = _tiersOf(terms_.virtualQuote);
            for (uint256 i; i < 6; ++i) {
                (uint256 step,, uint256 minimum) = _roundTerms(tiers[i], terms_.virtualUnits, round_.supply);
                if (step < 2 || step * 100 <= (1 << 32) || minimum < LEAST_MINIMUM || minimum > type(uint128).max) {
                    revert InvalidSetup();
                }
            }
            auctionFactory = IRoundAuctionFactory(round_.auctionFactory);
            roundBlocks = round_.blocks;
            roundSupply = round_.supply;
        }
    }

    /// @dev A round's price step, floor and default minimum for a curve of paper reserve `depth`. The step is a
    /// hundredth of the opening price, and the floor a whole number of steps, as the auction requires (its own least
    /// floor is 2**32 + 1); the default minimum is the whole supply at the floor.
    function _roundTerms(uint256 depth, uint256 units, uint256 supply)
        private
        pure
        returns (uint256 step, uint256 floor, uint256 minimum)
    {
        step = (depth << 96) / units / 100;
        floor = step * 100;
        minimum = supply * depth / units;
    }

    /// @dev The six depths, from two fifths of `base` to twenty times it: with a default of 25,000 whole quote units
    /// they are 10,000, 25,000, 50,000, 100,000, 250,000 and 500,000. There is no depth of a fifth (5,000): the price
    /// multiple of a pool follows what it took in next to its depth alone, so the shallowest depth is where the
    /// least money multiplies the price the most (25,000 paid in moved it about 30 times at 5,000, against about 10
    /// times at 10,000), which rewards being first, not the project doing well (docs/v3-review/BACKING-POOL.md,
    /// "What the first buyers hold").
    function _tiersOf(uint256 base) private pure returns (uint256[6] memory t) {
        t[0] = base / 5 * 2;
        t[1] = base;
        t[2] = base * 2;
        t[3] = base * 4;
        t[4] = base * 10;
        t[5] = base * 20;
    }

    /// @notice The curve depths a founder may choose from, in quote base units: a paper reserve for the curve to
    /// start with, shallowest first. Deeper means a sale moves the price less (and money coming in moves it less
    /// too). With the default of 25,000 whole quote units: 10,000, 25,000, 50,000, 100,000, 250,000 and 500,000.
    function depthTiers() external view returns (uint256[6] memory) {
        return _tiersOf(defaultDepth);
    }

    /// @dev `depth` as a curve depth: zero is the default, anything else must be one of the tiers.
    function _depth(uint256 depth) private view returns (uint256) {
        if (depth == 0) return defaultDepth;
        uint256[6] memory tiers = _tiersOf(defaultDepth);
        for (uint256 i; i < 6; ++i) {
            if (tiers[i] == depth) return depth;
        }
        revert BadDepth();
    }

    /// @notice What a round at `depth` (zero for the default) asks of the auction: its price step and floor price
    /// in the auction's fixed point, and the minimum raised when the founder names none.
    function roundTerms(uint256 depth)
        public
        view
        returns (uint256 tickSpacingX96, uint256 floorPriceX96, uint128 defaultMinimum)
    {
        if (address(auctionFactory) == address(0)) return (0, 0, 0);
        uint256 minimum;
        (tickSpacingX96, floorPriceX96, minimum) = _roundTerms(_depth(depth), _virtualUnits, roundSupply);
        defaultMinimum = uint128(minimum);
    }

    /// @notice A round's floor price and price step at the default depth, in the auction's fixed point (quote base
    /// units per base unit of claim token, times 2**96): the floor is the price an "open now" curve starts at.
    function roundFloorPriceX96() external view returns (uint256 floorPrice) {
        (, floorPrice,) = roundTerms(0);
    }

    function roundTickSpacingX96() external view returns (uint256 tickSpacing) {
        (tickSpacing,,) = roundTerms(0);
    }

    /// @notice The minimum a round at the default depth must raise when the founder names none: the whole supply at
    /// the floor.
    function defaultMinimumRaise() external view returns (uint128 minimum) {
        (,, minimum) = roundTerms(0);
    }

    /// @notice The terms every pool of this factory gets.
    function terms() external view returns (BackingPool.Params memory) {
        return _terms;
    }

    /// @notice How many pools this factory has opened.
    function poolCount() external view returns (uint256) {
        return pools.length;
    }

    /// @notice The founder a DAO's voting policy recorded at birth, or zero when it recorded none.
    function founderOf(address dao) public view returns (address founder) {
        address policy = IBackingMoloch(dao).votingWeight();
        (bool ok, bytes memory data) = policy.staticcall(abi.encodeWithSignature("secondaryConfiguration()"));
        if (ok && data.length == 6 * 32) {
            (, founder,,,,) = abi.decode(data, (address, address, uint256, uint64, uint64, uint64));
        }
    }

    /// @notice Open `dao`'s pool with the curve live at once. Callable by the project's recorded founder, by
    /// the DAO, or by the authorised kit; once per project (again only after a round that failed).
    /// @param depth The curve depth, one of `depthTiers()`, or zero for the default.
    /// @return pool The new pool.
    function open(address dao, uint256 depth) external returns (BackingPool pool) {
        pool = _open(dao, 0, depth);
    }

    /// @notice Open `dao`'s pool behind an opening round: an auction of `roundSupply` claim tokens for
    /// `roundBlocks` blocks from this block, floor at the curve's opening price at the chosen depth. Same callers as
    /// `open`. The curve that opens when the round is settled is set from what the round raised, at the average
    /// price it paid; the depth sets the floor price, so the curve opens at about 0.8 to 0.9 of that depth when the
    /// round clears at the floor, and deeper when demand lifts the price.
    /// @param minimumRaise What the round must raise for the pool to go live (bidders are refunded by the
    /// auction otherwise); zero for the default, the whole supply at the floor.
    /// @param depth The curve depth, one of `depthTiers()`, or zero for the default.
    /// @return pool The new pool, waiting for its round.
    /// @return auction The round's auction: bids, refunds and claim tokens are handled there.
    function openWithRound(address dao, uint128 minimumRaise, uint256 depth)
        external
        returns (BackingPool pool, address auction)
    {
        if (address(auctionFactory) == address(0)) revert RoundsOff();
        (uint256 tickSpacing, uint256 floorPrice, uint128 defaultMinimum) = roundTerms(depth);
        if (minimumRaise == 0) minimumRaise = defaultMinimum;
        if (minimumRaise < LEAST_MINIMUM) revert MinimumTooLow(LEAST_MINIMUM);
        pool = _open(dao, roundSupply, depth);
        // The auction's own clock (`BlockNumberish`, the helper the auction itself uses), not `block.number`:
        // on Arbitrum and its Orbit chains the two differ, and a round whose blocks were counted on the wrong
        // one would already be over, or not yet begun, when the auction opens.
        uint64 start = uint64(_getBlockNumberish());
        RoundAuctionParameters memory config = RoundAuctionParameters({
            currency: address(quote),
            tokensRecipient: address(pool),
            fundsRecipient: address(pool),
            startBlock: start,
            endBlock: start + roundBlocks,
            claimBlock: start + roundBlocks,
            tickSpacing: tickSpacing,
            validationHook: address(0),
            floorPrice: floorPrice,
            requiredCurrencyRaised: minimumRaise,
            auctionStepsData: abi.encodePacked(uint24(10_000_000 / roundBlocks), uint40(roundBlocks))
        });
        address claim = address(pool.claimToken());
        auction =
            auctionFactory.create(claim, roundSupply, abi.encode(config), bytes32(uint256(uint160(address(pool)))));
        // The pool checks the auction against itself (token, currency, both recipients) before funding it.
        poolDeployer.bindRound(pool, auction, minimumRaise);
        // The auction must be running on the clock this factory counted the round on. Asking it to checkpoint now
        // makes it read its own clock: one that is behind this factory's (an Orbit-style chain whose auction copy
        // of `BlockNumberish` reads another source) has not started the round, so the auction's own
        // `AuctionNotStarted` reverts this call, and nothing is opened, instead of leaving a pool waiting for a
        // round that begins in the far future and blocks the project from opening another. The revert is the
        // auction's, passed on unchanged. (A clock that is ahead is not refused: the round is shorter, or over, and
        // closes like any round that raised nothing.)
        IRoundAuction(auction).checkpoint();
        emit RoundOpened(dao, address(pool), auction, claim, roundSupply, minimumRaise, start, start + roundBlocks);
    }

    function _open(address dao, uint256 supply, uint256 depth) private returns (BackingPool pool) {
        bytes32 codeHash;
        assembly ("memory-safe") {
            codeHash := extcodehash(dao)
        }
        if (codeHash != daoRuntimeHash) revert UnprovenDao();
        address existing = poolOf[dao];
        // One pool per project, except that a pool whose opening round failed never opened at all.
        if (existing != address(0) && BackingPool(existing).roundState() != BackingPool.RoundState.Failed) {
            revert AlreadyOpen(existing);
        }
        address founder = founderOf(dao);
        if (msg.sender != dao && msg.sender != founder && (authorizedKit == address(0) || msg.sender != authorizedKit))
        {
            revert NotAllowed();
        }
        // The chosen depth is the curve's paper reserve, and the per-wallet early cap scales with it (it is a
        // twenty-fifth of the depth at the defaults).
        BackingPool.Params memory t = _terms;
        uint256 chosen = _depth(depth);
        if (chosen != t.virtualQuote) {
            t.earlyCap = t.earlyCap * chosen / t.virtualQuote;
            t.virtualQuote = chosen;
        }
        pool = poolDeployer.deploy(dao, founder, quote, t, supply);
        poolOf[dao] = address(pool);
        pools.push(address(pool));
        emit PoolOpened(dao, address(pool), founder, msg.sender);
        emit DepthChosen(address(pool), chosen);
    }
}
