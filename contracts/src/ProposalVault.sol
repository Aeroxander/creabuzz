// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title JoinPrice
/// @notice What one project token costs a backer at the moment they spend
/// vouchers (funding-and-governance-plan.md §4).
///
/// The plan's rule is a maximum over three sources — the pledge-time price (a
/// floor), the market average at join time, and the treasury's value per token
/// — with an optional early-supporter discount that is capped and visible and
/// may never take the price below treasury value per token. Picking those
/// three numbers needs price data this contract cannot read honestly on its
/// own, so the arithmetic lives behind this interface and the vault enforces
/// the one part that must never bend.
interface IJoinPrice {
    /// @notice The price one backer pays now, and the hard floor for it.
    /// @return pricePerToken currency base units per whole token
    /// @return floorPerToken the treasury's value per token; `pricePerToken`
    ///         must be at least this, or `buy-then-ragequit` is free money.
    function joinPrice(address buyer, bytes32 proposalId)
        external
        view
        returns (uint256 pricePerToken, uint256 floorPerToken);
}

/// @title ProposalVault
/// @notice The backer-directed half of a raise: capital that goes where the
/// backers send it, not where the team would have spent it
/// (funding-and-governance-plan.md §4, "vouchers and the proposal vault").
///
/// The flow, in the plan's words:
///
/// 1. **Pledge.** A backer deposits currency and receives vouchers, one per
///    currency unit. Vouchers are soulbound: there is no transfer function for
///    them anywhere in this contract, they carry no claim on the treasury, and
///    they carry no votes of their own.
/// 2. **Direct the funds.** Spending vouchers on a proposal moves the money to
///    that proposal's milestone reserve, minus a tax to the treasury.
/// 3. **Get the stake.** At that moment the backer's project tokens are minted
///    at the join price and held here until the milestone is verified. If it
///    fails, the money and the tokens go back — a refund, not a slash.
/// 4. **Unspent vouchers** are refundable at any time.
///
/// ## Weight (docs/token-voting-design.md §3)
///
/// This contract is the source of the `backing` term of the voting weight:
///
/// ```
/// backing(a, b) = Σ_positions escrowed × (1 + min(age / T, 1))
/// ```
///
/// `age` is blocks since that position opened, `T` is `maturationBlocks`. A
/// commitment earns its stake back plus at most as much again — at most
/// `2 × escrowed` — and only while the capital is actually at risk. Holding
/// tokens earns nothing here; directing capital is what compounds.
///
/// Unspent vouchers carry no weight, ever. That is what stops this becoming a
/// reputation faucet, and it is why G6 ("no score, activity count or
/// reputation can feed voting power", docs/legitimacy-synthesis.md) still
/// holds: nothing in this contract reads a score. Backing is capital that can
/// be lost — the "we slash stake, not reputation" line.
///
/// ## Money accounting (solvency)
///
/// The vault's `currency` balance is exactly
/// `totalVouchers + Σ_p reserved[p]` at every point:
///
/// - `pledge`      pulls `amount`; vouchers +`amount`            — balanced
/// - `refundVouchers` pushes `amount`; vouchers −`amount`        — balanced
/// - `back`        pushes the tax out; vouchers −`amount`,
///                 `reserved` +`amount − tax`                   — balanced
/// - `refundPosition` pushes `reserved` −`amount`                — balanced
///
/// So one proposal can never spend another proposal's reserve or a backer's
/// unspent vouchers. Its `token` balance is exactly `Σ_p escrowed[p]`: tokens
/// are minted to the vault, never to a backer, until a milestone is verified.
contract ProposalVault {
    /* ─────────────────────────── types ─────────────────────────── */

    enum ProposalState {
        Open, // collecting backing
        Verified, // milestone check passed; backers may claim their tokens
        Failed // rejected or expired; backers may take their money back
    }

    /// @notice A funding proposal: what it is for, what it needs, and the
    /// milestone check written up front (plan G16) that decides its outcome.
    struct Proposal {
        uint256 minAmount;
        uint256 maxAmount;
        uint64 deadline;
        /// @notice The acceptance check, written before anyone backs the
        /// proposal and never changed afterwards.
        bytes32 checkHash;
        uint256 reserved; // currency committed to this proposal
        uint256 escrowed; // tokens minted and held for its backers
        ProposalState state;
    }

    /// @notice One act of backing. Positions are per act rather than per
    /// account so the age of each tranche of capital is exact.
    struct Position {
        uint256 tokens; // escrowed project tokens, priced at the join price
        uint256 currency; // the currency this act moved into the reserve
        uint64 startBlock;
    }

    /* ─────────────────────────── immutables ─────────────────────────── */

    /// @notice The one raise currency, so payouts are clean (plan §4).
    address public immutable currency;
    /// @notice The project token, minted at the join price.
    address public immutable token;
    /// @notice Receives the tax on every act of backing.
    address public immutable treasury;
    /// @notice Opens proposals. The team still proposes; backers decide
    /// which proposals get money.
    address public immutable governance;
    IJoinPrice public immutable pricing;

    /// @notice Blocks over which a commitment matures (the plan's window).
    uint64 public immutable maturationBlocks;
    /// @notice Tax on backing, in basis points, paid to the treasury.
    uint16 public immutable taxBps;
    uint16 public constant BPS_DENOM = 10_000;

    /* ─────────────────────────── vouchers ─────────────────────────── */

    mapping(address => uint256) public vouchers;
    uint256 public totalVouchers;

    /* ─────────────────────────── proposals ─────────────────────────── */

    mapping(bytes32 => Proposal) public proposals;
    mapping(bytes32 => mapping(address => Position[])) public positions;
    /// @notice Escrowed tokens per (proposal, backer) — the O(1) read the exit
    /// gate and `claimTokens` need.
    mapping(bytes32 => mapping(address => uint256)) public escrowedOf;
    /// @notice Every proposal an account has backed, so "is any of my capital
    /// still at risk?" is a bounded scan rather than a guess.
    mapping(address => bytes32[]) public backedProposals;

    /* ─────────────────────────── events ─────────────────────────── */

    event Pledged(address indexed backer, uint256 currencyAmount, uint256 vouchers);
    event VouchersRefunded(address indexed backer, uint256 vouchers, uint256 currencyAmount);
    event ProposalOpened(bytes32 indexed proposalId, uint256 minAmount, uint256 maxAmount, uint64 deadline, bytes32 checkHash);
    event Backed(bytes32 indexed proposalId, address indexed backer, uint256 vouchers, uint256 tokens, uint256 tax);
    event ProposalVerified(bytes32 indexed proposalId, uint256 tokensEscrowed);
    event ProposalFailed(bytes32 indexed proposalId);
    event TokensClaimed(bytes32 indexed proposalId, address indexed backer, uint256 tokens);
    event PositionRefunded(bytes32 indexed proposalId, address indexed backer, uint256 currency, uint256 tokens);

    /* ─────────────────────────── errors ─────────────────────────── */

    error ZeroAmount();
    error ZeroAddress();
    error BadBps();
    error BadWindow();
    error BadRange();
    error OnlyGovernance(address caller);
    error UnknownProposal(bytes32 proposalId);
    error ProposalClosed(bytes32 proposalId);
    error ProposalNotResolvable(bytes32 proposalId);
    error BelowMinimum(bytes32 proposalId);
    error AboveMaximum(bytes32 proposalId);
    error DeadlinePassed(bytes32 proposalId);
    error CheckUnset();
    error PriceBelowFloor(uint256 price, uint256 floor);
    error NothingToRefund();
    error NothingToClaim();
    error TransferFailed();

    constructor(
        address currency_,
        address token_,
        address treasury_,
        address governance_,
        IJoinPrice pricing_,
        uint64 maturationBlocks_,
        uint16 taxBps_
    ) {
        if (
            currency_ == address(0) || token_ == address(0)
                || treasury_ == address(0) || governance_ == address(0)
        ) revert ZeroAddress();
        if (maturationBlocks_ == 0) revert BadWindow();
        if (taxBps_ > BPS_DENOM) revert BadBps();
        currency = currency_;
        token = token_;
        treasury = treasury_;
        governance = governance_;
        pricing = pricing_;
        maturationBlocks = maturationBlocks_;
        taxBps = taxBps_;
    }

    /* ─────────────────────────── vouchers ─────────────────────────── */

    /// @notice Deposit currency and receive vouchers, one per unit. Soulbound:
    /// no transfer function exists for them anywhere in this contract.
    function pledge(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _pull(msg.sender, amount);
        vouchers[msg.sender] += amount;
        totalVouchers += amount;
        emit Pledged(msg.sender, amount, amount);
    }

    /// @notice Burn unspent vouchers and take the currency back. Any amount,
    /// any time — including the automatic refund the plan requires when a
    /// project ends or a voucher expires.
    function refundVouchers(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 held = vouchers[msg.sender];
        if (amount > held) revert NothingToRefund();
        unchecked {
            vouchers[msg.sender] = held - amount;
            totalVouchers -= amount;
        }
        _pushCurrency(msg.sender, amount);
        emit VouchersRefunded(msg.sender, amount, amount);
    }

    /* ─────────────────────────── proposals ─────────────────────────── */

    /// @notice Open a funding proposal. The milestone check is written here,
    /// up front, and can never change afterwards (plan G16) — a check that
    /// moves after people have backed it is not a check.
    function openProposal(
        bytes32 proposalId,
        uint256 minAmount,
        uint256 maxAmount,
        uint64 deadline,
        bytes32 checkHash
    ) external {
        if (msg.sender != governance) revert OnlyGovernance(msg.sender);
        if (checkHash == bytes32(0)) revert CheckUnset();
        if (minAmount == 0 || maxAmount < minAmount) revert BadRange();
        if (deadline <= block.number) revert DeadlinePassed(proposalId);
        if (proposals[proposalId].deadline != 0) revert ProposalClosed(proposalId);
        Proposal storage p = proposals[proposalId];
        p.minAmount = minAmount;
        p.maxAmount = maxAmount;
        p.deadline = deadline;
        p.checkHash = checkHash;
        emit ProposalOpened(proposalId, minAmount, maxAmount, deadline, checkHash);
    }

    /// @notice Back a proposal: spend vouchers on it. The money moves into that
    /// proposal's reserve, the tax goes to the treasury, and the backer's
    /// project tokens are minted at the join price and escrowed here until the
    /// milestone is verified.
    ///
    /// This is the only path that mints tokens to a backer, which is why votes
    /// cannot be bought on the market: a market purchase moves `Loot`, the flat
    /// `held` term of the weight. Only capital directed to a proposal
    /// compounds.
    function back(bytes32 proposalId, uint256 voucherAmount) external {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) revert UnknownProposal(proposalId);
        if (p.state != ProposalState.Open) revert ProposalClosed(proposalId);
        if (block.number > p.deadline) revert DeadlinePassed(proposalId);
        if (voucherAmount == 0) revert ZeroAmount();

        uint256 held = vouchers[msg.sender];
        if (voucherAmount > held) revert NothingToRefund();

        // The join price, and the one rule that may never bend: the price is
        // never below the treasury's value per token, or buying and then
        // ragequitting is free money (plan §4).
        (uint256 pricePerToken, uint256 floorPerToken) =
            pricing.joinPrice(msg.sender, proposalId);
        if (pricePerToken < floorPerToken) {
            revert PriceBelowFloor(pricePerToken, floorPerToken);
        }

        uint256 tax = (voucherAmount * taxBps) / BPS_DENOM;
        uint256 intoReserve = voucherAmount - tax;
        if (p.reserved + intoReserve > p.maxAmount) revert AboveMaximum(proposalId);

        unchecked {
            vouchers[msg.sender] = held - voucherAmount;
            totalVouchers -= voucherAmount;
        }
        p.reserved += intoReserve;

        // Tokens priced off the money that reached the reserve, so a tax can
        // never buy extra weight.
        uint256 tokens = pricePerToken == 0 ? 0 : (intoReserve * 1e18) / pricePerToken;
        if (tokens != 0) {
            p.escrowed += tokens;
            escrowedOf[proposalId][msg.sender] += tokens;
            if (positions[proposalId][msg.sender].length == 0) {
                backedProposals[msg.sender].push(proposalId);
            }
            positions[proposalId][msg.sender].push(
                Position({
                    tokens: tokens,
                    currency: intoReserve,
                    startBlock: uint64(block.number)
                })
            );
            _mintToVault(tokens);
        } else {
            // Nothing minted, but the money still went to the reserve and is
            // still this backer's exposure — record it or the refund loses it.
            if (positions[proposalId][msg.sender].length == 0) {
                backedProposals[msg.sender].push(proposalId);
            }
            positions[proposalId][msg.sender].push(
                Position({
                    tokens: 0,
                    currency: intoReserve,
                    startBlock: uint64(block.number)
                })
            );
        }

        if (tax != 0) _pushCurrency(treasury, tax);
        emit Backed(proposalId, msg.sender, voucherAmount, tokens, tax);
    }

    /* ─────────────────────────── resolution ─────────────────────────── */

    /// @notice The milestone check passed. Escrowed tokens become the backers'
    /// to claim; the reserve belongs to the proposal's work.
    ///
    /// The plan puts verification with the launch's verifier set (§7 G1/G16),
    /// so this is called by the governance address that set is bound to — never
    /// by the team unilaterally.
    function verify(bytes32 proposalId) external {
        if (msg.sender != governance) revert OnlyGovernance(msg.sender);
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) revert UnknownProposal(proposalId);
        if (p.state != ProposalState.Open) revert ProposalClosed(proposalId);
        if (p.reserved < p.minAmount) revert BelowMinimum(proposalId);
        p.state = ProposalState.Verified;
        emit ProposalVerified(proposalId, p.escrowed);
    }

    /// @notice The milestone was rejected, or the deadline passed below the
    /// minimum: money and tokens go back to the backers. A refund, not a slash
    /// — the plan is explicit that this is not `ClaimStake`'s
    /// slash-to-treasury path.
    ///
    /// Rejecting is governance's call while there is time left; once the
    /// deadline has passed below the minimum anyone may close it, so a
    /// proposal can never strand its backers' money behind an absent judge.
    function fail(bytes32 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) revert UnknownProposal(proposalId);
        if (p.state != ProposalState.Open) revert ProposalClosed(proposalId);

        bool deadlineMissed = block.number > p.deadline && p.reserved < p.minAmount;
        bool rejected = msg.sender == governance;
        if (!deadlineMissed && !rejected) revert ProposalNotResolvable(proposalId);
        p.state = ProposalState.Failed;
        emit ProposalFailed(proposalId);
    }

    /// @notice Take back a failed proposal's backing: the currency returns and
    /// the escrowed tokens are burned.
    function refundPosition(bytes32 proposalId) external {
        if (proposals[proposalId].state != ProposalState.Failed) {
            revert ProposalNotResolvable(proposalId);
        }
        Position[] storage mine = positions[proposalId][msg.sender];
        uint256 n = mine.length;
        if (n == 0) revert NothingToRefund();

        uint256 currencyBack;
        uint256 tokensBack;
        for (uint256 i; i != n; ++i) {
            Position storage pos = mine[i];
            currencyBack += pos.currency;
            tokensBack += pos.tokens;
            pos.currency = 0;
            pos.tokens = 0;
        }
        escrowedOf[proposalId][msg.sender] = 0;
        proposals[proposalId].reserved -= currencyBack;
        proposals[proposalId].escrowed -= tokensBack;

        if (tokensBack != 0) _burnFromVault(tokensBack);
        if (currencyBack != 0) _pushCurrency(msg.sender, currencyBack);
        emit PositionRefunded(proposalId, msg.sender, currencyBack, tokensBack);
    }

    /// @notice A verified milestone's tokens are the backer's to take.
    function claimTokens(bytes32 proposalId) external {
        if (proposals[proposalId].state != ProposalState.Verified) {
            revert ProposalNotResolvable(proposalId);
        }
        Position[] storage mine = positions[proposalId][msg.sender];
        uint256 n = mine.length;
        uint256 tokens;
        for (uint256 i; i != n; ++i) {
            Position storage pos = mine[i];
            tokens += pos.tokens;
            pos.tokens = 0;
        }
        if (tokens == 0) revert NothingToClaim();
        escrowedOf[proposalId][msg.sender] = 0;
        emit TokensClaimed(proposalId, msg.sender, tokens);
        _transferToken(msg.sender, tokens);
    }

    /* ─────────────────────────── weight ─────────────────────────── */

    /// @notice The `backing` term of the voting weight at a past block
    /// (docs/token-voting-design.md §3).
    ///
    /// Each position earns `tokens × (1 + min(age / T, 1))`, so a commitment
    /// gets its stake back plus at most as much again. A position opened after
    /// `atBlock` counts for nothing — a snapshot is a snapshot — and only
    /// proposals still `Open` count, because that is the only state in which
    /// the capital is at risk.
    function backingWeightAt(bytes32 proposalId, address backer, uint48 atBlock)
        public
        view
        returns (uint256 weight)
    {
        if (proposals[proposalId].state != ProposalState.Open) return 0;
        Position[] storage mine = positions[proposalId][backer];
        uint256 n = mine.length;
        for (uint256 i; i != n; ++i) {
            Position storage pos = mine[i];
            if (pos.tokens == 0 || pos.startBlock > atBlock) continue;
            uint256 age = uint256(atBlock) - uint256(pos.startBlock);
            uint256 matured = age >= maturationBlocks ? maturationBlocks : age;
            unchecked {
                weight += pos.tokens + (pos.tokens * matured) / maturationBlocks;
            }
        }
    }

    /// @notice Tokens of the caller's still at risk behind open proposals —
    /// the number the exit gate reads (docs/token-voting-design.md §6). It is
    /// derived, never cached, so a resolved proposal cannot leave a stale lock
    /// behind and strand a backer's exit (Review-Proven Rule 6).
    function tokensAtRisk(address backer) public view returns (uint256 atRisk) {
        bytes32[] storage mine = backedProposals[backer];
        uint256 n = mine.length;
        for (uint256 i; i != n; ++i) {
            if (proposals[mine[i]].state == ProposalState.Open) {
                atRisk += escrowedOf[mine[i]][backer];
            }
        }
    }

    /* ─────────────────────────── plumbing ─────────────────────────── */

    function _pull(address from, uint256 amount) internal {
        _call(currency, abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
    }

    function _pushCurrency(address to, uint256 amount) internal {
        _call(currency, abi.encodeWithSelector(0xa9059cbb, to, amount));
    }

    /// @notice Mint to the vault. Backer tokens are escrowed here, never held
    /// by the backer, until a milestone is verified.
    function _mintToVault(uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0x40c10f19, address(this), amount));
    }

    function _burnFromVault(uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0x9dc29fac, address(this), amount));
    }

    function _transferToken(address to, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount));
    }

    function _call(address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
