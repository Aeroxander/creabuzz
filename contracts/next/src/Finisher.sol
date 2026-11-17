// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "oz5/token/ERC20/IERC20.sol";
import {SafeERC20} from "oz5/token/ERC20/utils/SafeERC20.sol";
import {IShares, ITreasuryFinish} from "./Interfaces.sol";
import {
    IPinnedStrategy,
    IPinnedAuction,
    IPinnedPoolManager,
    IPinnedGuard,
    LBPInitializationParams,
    PoolKey,
    PoolRead,
    SaleParams
} from "./Pinned.sol";

/// @title Finisher
/// @notice One per project, made by the Launcher in the same transaction as the project's Shares and Treasury. It holds the
/// 500,000,000 Shares set aside at birth for the first sale and the pool, opens that sale when the Launcher says so, and is
/// the auction's Shares recipient and the pool step's recipient: the sale's dollars and unsold Shares come to this contract,
/// never to the founder. It is the only address the Treasury believes when it says the pool is open, the sale closed, or the
/// sale abandoned.
///
/// The finish is three steps. Each can be called by anyone, each is safe to repeat, and each works whoever did the one before:
///  1. `openPool`: run the strategy's pool step if nobody has. The strategy swallows a failure inside that step and reports
///     success, so nothing here believes an event or the strategy's say-so: step 2 reads the pool itself.
///  2. `settle`: only if this sale's pool exists (liquidity at the guarded key, and the pool step took this sale's money: see
///     `poolIsOpen`), send every dollar that came back from the
///     strategy to the Treasury, mark the pool open (the Vester's clock starts) and split the money 15 : 60, all in one
///     transaction. Nobody can split a part of the money first, because the Treasury refuses to split until the pool is
///     marked open and the money is only ever sent in this same call.
///  3. `sweep`: send the unsold Shares and the pool reserve the pool did not need to the Treasury as plain reserve, and mark
///     the sale closed (exits open). On a sale that failed to reach its minimum it instead keeps the Shares for a new try.
/// `abandon` is the way out of a pool that never opens: see its documentation.
/// @dev A clone per project. The strategy, the pool guard and the pool manager are immutables of the implementation, which
/// clones read, so a founder chooses none of them. Pool state is read through `PoolRead` from the pool manager's storage.
contract Finisher {
    using SafeERC20 for IERC20;

    /// @notice Where a project's sale stands.
    enum Stage {
        Idle, // no sale yet
        Open, // a sale was opened and is not finished
        Done, // finished: the pool is open, the unsold Shares are in the Treasury, exits are open
        Failed, // the sale did not reach its minimum: everyone was refunded and a new sale may open after `retryBlock`
        Abandoned // no pool ever opened: the money went to the floor, exits are open
    }

    /// @notice The least share of the pool's dollar budget, in percent, the pool step must have taken for the pool to count as
    /// this sale's. A real pool takes all of it to the unit; a pool made by somebody else takes none.
    uint256 public constant MIN_TAKEN_PERCENT = 50;

    /// @notice The Launcher that made this project; the only caller of `initialize` and `open`.
    address public immutable launcher;
    /// @notice The pool strategy every sale uses (the platform's, fixed when the Launcher was made).
    IPinnedStrategy public immutable strategy;
    /// @notice The pool guard that is the hook of every project's pool.
    address public immutable guard;
    /// @notice The Uniswap v4 pool manager the strategy uses.
    IPinnedPoolManager public immutable poolManager;

    /// @notice The project's Treasury (it believes only this contract about the pool and the sale).
    ITreasuryFinish public treasury;
    /// @notice The project's Shares.
    IShares public shares;
    /// @notice The dollar token of the project.
    IERC20 public quote;
    /// @notice The current (or last) auction.
    address public auction;
    /// @notice Where the sale stands.
    Stage public stage;
    /// @notice The last block of the current (or last) sale.
    uint64 public endBlock;
    /// @notice After a failed sale, the first block a new sale may open (24 hours after the failed one ended).
    uint64 public retryBlock;
    /// @notice How many sales were opened; makes each auction's creation salt different.
    uint32 public attempts;
    /// @notice Step 2 is done for the current sale.
    bool public settled;
    bool private transient _locked;

    /// @notice A sale was opened.
    event SaleOpenedBy(address indexed auction, uint64 endBlock, uint32 attempt);
    /// @notice The pool step ran in this call. `poolOpen` is what the pool manager says afterwards, not what any event says.
    event PoolStep(address indexed auction, bool poolOpen);
    /// @notice Step 2: the money reached the Treasury and was split, and the pool was marked open.
    event Settled(address indexed auction, uint256 raised, uint256 afterFee, uint256 toTreasury);
    /// @notice Step 2: the sale's pool, as it stands when the money is split. `poolId` is the pool's id at the pool manager,
    /// `sqrtPriceX96` its price right then, `poolDollars` and `poolShares` what the pool step put into it. The two amounts are the
    /// auction's raise after the fee less the dollars that came back to this contract, and the pool reserve less the Shares that came
    /// back; they read low if somebody sent dollars or Shares to this contract before step 2. Always emitted by `settle`, even when
    /// a stranger ran the pool step directly (then there is no `PoolStep`). The position's token id is not here: the position
    /// manager's own `Transfer` to the LiquidityHolder in the pool step's transaction names it.
    event PoolOpened(
        address indexed auction, bytes32 poolId, uint160 sqrtPriceX96, uint256 poolDollars, uint256 poolShares
    );
    /// @notice Step 3: Shares went to the Treasury and the sale was marked closed.
    event Swept(address indexed auction, uint256 sharesToTreasury);
    /// @notice The sale did not reach its minimum; a new sale may open from `retryBlock`.
    event SaleFailed(address indexed auction, uint64 retryBlock);
    /// @notice Seven days after the sale ended no pool of this sale existed: the money went to the floor and exits opened.
    event Abandoned(address indexed auction, uint256 toFloorOnly, uint256 split);

    /// @notice The caller is not the Launcher.
    error NotLauncher();
    /// @notice This clone was already set up, or the setup is not valid.
    error BadSetup();
    /// @notice A call came back into the Finisher while another was running.
    error Reentrancy();
    /// @notice A sale cannot open now: one is open, or this project already sold, or it is too soon after a failed sale.
    error CannotOpen();
    /// @notice This step does not apply at the sale's current stage.
    error WrongStage();
    /// @notice The pool step has not run, so the money has not come back from the strategy yet.
    error PoolStepNotRun();
    /// @notice This sale's pool does not exist: nothing is at the guarded key, or what is there did not take this sale's money.
    error NoPool();
    /// @notice The sale did not reach its minimum: there is nothing to settle (its Shares come back with `sweep`).
    error SaleDidNotGraduate();
    /// @notice Step 2 must come before step 3.
    error SettleFirst();
    /// @notice Fewer dollars came back than the auction's own figures say must.
    error MoneyMissing(uint256 held, uint256 expected);
    /// @notice It is too early to abandon the sale.
    error TooEarly(uint256 abandonBlock);
    /// @notice A pool exists, so the sale cannot be abandoned; finish it normally.
    error PoolExists();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    /// @param launcher_ The Launcher that will make this implementation's clones (it calls `initialize` and `open`).
    /// @param strategy_ The platform's pool strategy.
    /// @param guard_ The pool guard (the hook of every project's pool).
    constructor(address launcher_, address strategy_, address guard_) {
        (launcher, strategy, guard) = (launcher_, IPinnedStrategy(strategy_), guard_);
        poolManager = IPinnedPoolManager(IPinnedStrategy(strategy_).poolManager());
    }

    /// @notice Set up the clone, once. The Launcher calls it in the transaction that makes the clone.
    function initialize(address treasury_, address shares_, address quote_) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (address(treasury) != address(0) || treasury_ == address(0) || shares_ == address(0) || quote_ == address(0))
        {
            revert BadSetup();
        }
        (treasury, shares, quote) = (ITreasuryFinish(treasury_), IShares(shares_), IERC20(quote_));
    }

    // ================================================ opening ========================================================

    /// @notice True when a new sale may open now: this project never opened one, or the last one failed to reach its
    /// minimum and 24 hours have passed since it ended. A project that sold, or whose sale was abandoned, never opens one here.
    function canOpen() public view returns (bool) {
        if (address(treasury) == address(0)) return false;
        Stage s = stage;
        return s == Stage.Idle || (s == Stage.Failed && block.number >= retryBlock);
    }

    /// @notice Open the sale: hand the strategy the 500,000,000 Shares and the finished settings the Launcher built. Only the
    /// Launcher may call it, and only when `canOpen`.
    /// @param configData The strategy's settings and the auction's, encoded by the Launcher.
    /// @return auction_ The new auction.
    /// @return endBlock_ Its last block.
    function open(bytes calldata configData) external nonReentrant returns (address auction_, uint64 endBlock_) {
        if (msg.sender != launcher) revert NotLauncher();
        if (!canOpen()) revert CannotOpen();
        uint256 total = SaleParams.SALE_SHARES + SaleParams.POOL_SHARES;
        shares.approve(address(strategy), total);
        uint32 attempt = attempts++;
        strategy.initializeDistribution(address(shares), total, configData, bytes32(uint256(attempt)));
        auction_ = strategy.registeredPoolIds(_poolId());
        endBlock_ = IPinnedAuction(auction_).endBlock();
        (auction, endBlock, stage, settled) = (auction_, endBlock_, Stage.Open, false);
        emit SaleOpenedBy(auction_, endBlock_, attempt);
    }

    // ================================================ the finish =====================================================

    /// @notice Step 1. Run the strategy's pool step, unless somebody already has. Returns whether this call ran it. After the
    /// sale ends anyone may call it and it works once; a failure inside it is swallowed by the strategy, so this does not
    /// say whether a pool exists: `poolIsOpen` does, read from the pool manager.
    /// @return ran True when this call performed the pool step.
    function openPool() external nonReentrant returns (bool ran) {
        Stage s = stage;
        if (s == Stage.Idle) revert WrongStage();
        if (s != Stage.Open || !_stepPending()) return false;
        _runPoolStep();
        return true;
    }

    /// @notice Step 2. Needs step 1. If this sale's pool exists (`poolIsOpen`), send the Treasury every dollar the
    /// strategy returned, mark the pool open and split the money 15 : 60, in this one transaction. Refuses otherwise, and
    /// leaves nothing half done. Returns false when already done.
    /// @dev The dollars that come back are the raise after the platform's 3 less what the pool took; the auction's own report
    /// of the raise sets the least that must be here (`MoneyMissing`).
    /// @return done True when this call did the work.
    function settle() external nonReentrant returns (bool done) {
        if (settled) return false;
        if (stage != Stage.Open) revert WrongStage();
        if (_stepPending()) revert PoolStepNotRun();
        IPinnedAuction a = IPinnedAuction(auction);
        if (!a.isGraduated()) revert SaleDidNotGraduate();
        if (!poolIsOpen()) revert NoPool();
        uint256 raised = a.currencyRaised();
        uint256 afterFee = a.lbpInitializationParams().currencyRaised;
        uint256 least = afterFee - afterFee * SaleParams.POOL_RATE / SaleParams.RATE_SCALE;
        uint256 held = quote.balanceOf(address(this));
        if (held < least) revert MoneyMissing(held, least);
        settled = true;
        uint256 sharesBack = shares.balanceOf(address(this));
        bytes32 poolId = _poolId();
        emit PoolOpened(
            address(a),
            poolId,
            PoolRead.sqrtPrice(poolManager, poolId),
            held < afterFee ? afterFee - held : 0,
            sharesBack < SaleParams.POOL_SHARES ? SaleParams.POOL_SHARES - sharesBack : 0
        );
        quote.safeTransfer(address(treasury), held);
        treasury.markPoolOpen();
        uint256 arrived = treasury.unaccounted();
        treasury.settle(arrived);
        emit Settled(address(a), raised, afterFee, arrived);
        return true;
    }

    /// @notice Step 3. Needs step 1. Sweep the auction's unsold Shares here, then send every Share this contract holds (unsold,
    /// the pool reserve the pool did not need, dust) to the Treasury as plain reserve and mark the sale closed, which opens
    /// exits. For a sale that failed to reach its minimum it keeps the Shares instead and opens the way to a new try 24 hours
    /// after the failed one ended. Returns false when nothing is left to do.
    /// @return done True when this call did the work.
    function sweep() external nonReentrant returns (bool done) {
        Stage s = stage;
        if (s == Stage.Idle) revert WrongStage();
        if (s != Stage.Open) return false;
        if (_stepPending()) revert PoolStepNotRun();
        IPinnedAuction a = IPinnedAuction(auction);
        a.sweepUnsoldTokens();
        if (!a.isGraduated()) {
            uint64 retry = endBlock + SaleParams.SALE_BLOCKS;
            (stage, retryBlock) = (Stage.Failed, retry);
            emit SaleFailed(address(a), retry);
            return true;
        }
        if (!settled) revert SettleFirst();
        stage = Stage.Done;
        uint256 held = _sharesToTreasury();
        treasury.markSaleClosed();
        emit Swept(address(a), held);
        return true;
    }

    /// @notice The way out when no pool ever opens. Seven days after the sale ended (50,400 blocks), if this sale's pool does
    /// not exist (`poolIsOpen`), anyone may call this. It runs the pool step first if nobody has (if that makes the pool, the call reverts
    /// `PoolExists` and the normal finish applies). Then, in one transaction: the dollars that came back go to the Treasury, the
    /// sale is marked abandoned (the Vester's clock starts), the 22 of each 100 raised that was meant for the pool go wholly
    /// into the melting floor and the rest is split 15 : 60, so of each 100 raised 15 are spendable and 82 are floor (3 went to the
    /// platform); all Shares come back to the Treasury as reserve and exits open.
    /// @dev This is the owner's call 4: a pool that never opens must not leave a project with no way to exit.
    function abandon() external nonReentrant {
        if (stage != Stage.Open) revert WrongStage();
        uint256 from = uint256(endBlock) + SaleParams.ABANDON_DELAY_BLOCKS;
        if (block.number < from) revert TooEarly(from);
        IPinnedAuction a = IPinnedAuction(auction);
        // the pool step also finishes the auction's last checkpoint, so graduation is read only after it
        if (_stepPending()) _runPoolStep();
        if (!a.isGraduated()) revert SaleDidNotGraduate();
        if (poolIsOpen()) revert PoolExists();
        stage = Stage.Abandoned;
        uint256 held = quote.balanceOf(address(this));
        quote.safeTransfer(address(treasury), held);
        treasury.markAbandoned();
        uint256 arrived = treasury.unaccounted();
        uint256 toFloorOnly = arrived * SaleParams.POOL_RATE / SaleParams.RATE_SCALE;
        treasury.settleToFloor(toFloorOnly);
        treasury.settle(arrived - toFloorOnly);
        a.sweepUnsoldTokens();
        uint256 sharesBack = _sharesToTreasury();
        treasury.markSaleClosed();
        emit Abandoned(address(a), toFloorOnly, arrived - toFloorOnly);
        emit Swept(address(a), sharesBack);
    }

    // ================================================ reading ========================================================

    /// @notice True when THIS SALE's pool exists. Before step 2 that means two things, both read from the pool manager and the
    /// auction, never from an event: the key whose hook is the platform's guard holds liquidity (and the guard names the strategy
    /// as the only creator), AND the pool step took this sale's money, that is, at least half of the pool's budget of dollars is
    /// missing from what the strategy returned to this contract. The second part is what tells the sale's own pool from a pool
    /// somebody else made at the same key through the strategy (the strategy lets any holder of the project's Shares do that once
    /// a failed pool step has freed the key): such a pool takes none of this sale's money, because a failed step returns all of
    /// it. After step 2 it is true until the sale is abandoned or never opened.
    /// @dev What a stranger can still do: send dollars to this contract before step 2, which makes a real pool look as if it
    /// took less. It needs more than half of the pool's budget (more than 11 of each 100 dollars the pool holds) and the dollars
    /// become the project's.
    function poolIsOpen() public view returns (bool) {
        Stage s = stage;
        if (s == Stage.Done) return true;
        if (s != Stage.Open) return false;
        return settled || (poolAtTheKey() && _poolTookTheMoney());
    }

    /// @notice The block from which `abandon` is allowed for the current sale.
    function abandonBlock() external view returns (uint256) {
        return uint256(endBlock) + SaleParams.ABANDON_DELAY_BLOCKS;
    }

    /// @notice The pool key of this project: dollar and Share in address order, the pool fee, the tick spacing, the guard.
    function poolKey() public view returns (PoolKey memory key) {
        (address q, address s) = (address(quote), address(shares));
        key = PoolKey({
            currency0: q < s ? q : s,
            currency1: q < s ? s : q,
            fee: SaleParams.POOL_FEE,
            tickSpacing: SaleParams.POOL_TICK_SPACING,
            hooks: guard
        });
    }

    // ================================================ plumbing =======================================================

    /// @notice True when a pool exists at this project's key whose hook is the platform's guard, that guard names the strategy as
    /// the only creator, and the pool holds liquidity (a pool nobody created has none). It does not say whose pool it is: after a
    /// failed pool step a holder of the project's Shares can make one through the strategy. `poolIsOpen` is the answer that
    /// counts.
    function poolAtTheKey() public view returns (bool) {
        try IPinnedGuard(guard).authorized() returns (address creator) {
            if (creator != address(strategy)) return false;
        } catch {
            return false;
        }
        return PoolRead.liquidity(poolManager, _poolId()) != 0;
    }

    /// @dev The pool step keeps what the pool takes and returns the rest of the raise (after the fee) to this contract; a failed
    /// step returns all of it. So the dollars missing from what this contract holds are what the pool took. `MIN_TAKEN_PERCENT`
    /// of the pool's budget is the least that counts.
    function _poolTookTheMoney() private view returns (bool) {
        IPinnedAuction a = IPinnedAuction(auction);
        uint256 afterFee;
        try a.lbpInitializationParams() returns (LBPInitializationParams memory p) {
            afterFee = p.currencyRaised;
        } catch {
            return false;
        }
        uint256 held = quote.balanceOf(address(this));
        uint256 took = held >= afterFee ? 0 : afterFee - held;
        uint256 budget = afterFee * SaleParams.POOL_RATE / SaleParams.RATE_SCALE;
        return took * 100 >= budget * MIN_TAKEN_PERCENT;
    }

    function _poolId() private view returns (bytes32) {
        return PoolRead.id(poolKey());
    }

    /// @dev The strategy reserves the pool id until its pool step runs, and clears it first thing in that step; so the id
    /// pointing at this sale's auction means the step has not run.
    function _stepPending() private view returns (bool) {
        return strategy.registeredPoolIds(_poolId()) == auction;
    }

    function _runPoolStep() private {
        strategy.migrate(auction);
        emit PoolStep(auction, poolIsOpen());
    }

    function _sharesToTreasury() private returns (uint256 held) {
        held = shares.balanceOf(address(this));
        if (held != 0) shares.transfer(address(treasury), held); // the project's own token: it reverts rather than return false
    }
}
