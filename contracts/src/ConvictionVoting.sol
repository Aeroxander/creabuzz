// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IConvictionWeight
/// @notice The `conviction` term of the voting weight — a bounded, non-transferable
/// credit allowance held on one proposal for some time
/// (`ConvictionVoting.convictionWeightAt`). Sums into `VotingWeight.weightFor`
/// alongside work, held and backing (docs/token-voting-design.md §10).
interface IConvictionWeight {
    /// @notice Conviction this account has behind one proposal at a past block.
    /// Honest at the block: credits staked later are ignored, and conviction an
    /// account has moved away from is not counted.
    function convictionWeightAt(bytes32 proposalId, address account, uint48 atBlock)
        external
        view
        returns (uint256);
}

/// @title ConvictionVoting
/// @notice Continuous, deadline-free preference on funding proposals
/// (docs/token-voting-design.md §10): members spend a bounded credit allowance
/// on the proposals they want funded, and conviction — the weight of that
/// preference — grows while the credits stay put and fades when they move.
/// A proposal passes when its accumulated conviction crosses a threshold that
/// rises with the share of the pool it asks for.
///
/// This is the entry-voice replacement: where the vault's backing term answers
/// "is your money at risk behind this", this answers "have you kept saying so".
/// The two are summed by `VotingWeight`; nothing here touches capital.
///
/// ## The allowance (why this is not a reputation faucet, G6)
///
/// Credits are issued per seat by governance — the same bounded seat map the
/// summon mints — and are non-transferable: there is no transfer function for
/// them anywhere in this contract. Nothing here reads a score, a badge tier or
/// a reputation root. Issuance is membership, not measurement.
///
/// Because conviction accumulates **linearly** in credits, splitting one
/// allowance across many addresses gains exactly nothing — one seat holding C
/// credits and k seats holding C/k each arrive at the same total conviction.
/// The only way to add weight is to hold more seats, and seats are granted one
/// approval at a time. Splitting a sybil farm therefore buys nothing; the seat
/// map is the sybil defence.
///
/// ## The recursion
///
/// One position of `s` credits on a proposal, last touched at block `t0` with
/// accumulated conviction `y0`, reads at block `b`:
///
/// ```
/// y(b) = α^(b−t0) · y0 + s · (1 − α^(b−t0)) / (1 − α)
/// ```
///
/// `α` is per block (WAD). Conviction therefore grows toward `s / (1 − α)`
/// while held, and decays back toward the target when support is withdrawn.
/// Every stake and unstake is checkpointed, so `convictionWeightAt` is honest
/// at any past block (the same rule the backing term keeps: "a snapshot ignores
/// backing that came after it"). Unspent credits carry no weight, ever.
///
/// ## The threshold
///
/// A proposal asking for share `ρ` of the pool passes when its total conviction
/// reaches:
///
/// ```
/// threshold(ρ) = max(minConvictionFloor,
///                    totalIssued / (1 − α) · (minW + (maxW − minW) · ρ))
/// ```
///
/// so an expensive proposal needs a larger, longer-held share of the whole
/// allowance, and a cheap ask can never pass on crumbs below the floor (the
/// spam defence: opening many small proposals cannot dilute a real one, because
/// thresholds are measured against total issuance, never against what happens
/// to be staked elsewhere). `minW`/`maxW` are WAD fractions; the defaults are
/// a simulation question, not a design one.
contract ConvictionVoting is IConvictionWeight {
    // ---- config ----

    /// @notice Who grants seats, issues credits and opens proposals. In a
    /// summoned DAO this is the DAO's own executor; in tests it is a deployer.
    address public governance;

    /// @notice α per block, in WAD. Conviction is multiplied by this once per
    /// block since the last update.
    uint256 public immutable decayWad;

    /// @notice `1e18 · WAD / (WAD − decayWad)`: one over (1 − α), WAD-scaled.
    uint256 public immutable invOneMinusAlphaWad;

    /// @notice Threshold fraction of maximum conviction at an ask of zero.
    uint256 public immutable minThresholdWad;

    /// @notice Threshold fraction of maximum conviction at an ask of the whole
    /// pool. Must be at least `minThresholdWad`.
    uint256 public immutable maxThresholdWad;

    /// @notice Absolute conviction floor every proposal must clear, however
    /// small its ask. The spam defence.
    uint256 public immutable minConvictionFloor;

    /// @notice Upper bound on seats per DAO. A bounded loop of grants is the
    /// only iteration in this contract, and it is bounded here.
    uint256 public constant MAX_SEATS = 256;

    /// @notice Upper bound on total credits issued (keeps every product in the
    /// recursion arithmetic far below overflow).
    uint256 public constant MAX_TOTAL_ISSUED = 2 ** 96;

    // ---- state ----

    struct Proposal {
        /// @notice Share of the funding pool requested, WAD (0..1e18).
        uint256 askWad;
        /// @notice Block the proposal opened at.
        uint48 openedAtBlock;
        bool exists;
    }

    /// @notice One recorded change of an account's stake on a proposal. The
    /// stored conviction is the accumulated value at `fromBlock`; later blocks
    /// are computed from here in closed form, so no history is walked.
    struct Checkpoint {
        uint48 fromBlock;
        uint256 credits;
        uint256 conviction;
    }

    /// @notice The settled running total of one proposal.
    struct Total {
        uint48 updated;
        uint256 credits;
        uint256 conviction;
    }

    mapping(bytes32 => Proposal) public proposals;
    mapping(bytes32 => mapping(address => Checkpoint[])) internal positions;
    mapping(bytes32 => Total) public totals;

    mapping(address => bool) public isSeat;
    uint256 public seatCount;
    mapping(address => uint256) public unspent;
    uint256 public totalIssued;

    // ---- errors ----

    error OnlyGovernance();
    error NotASeat();
    error UnknownProposal();
    error ProposalExists();
    error BadConfig();
    error SeatLimit();
    error IssueLimit();
    error NoCredits();
    error Underflow();

    // ---- events ----

    event SeatGranted(address indexed seat);
    event CreditsIssued(address indexed seat, uint256 amount);
    event ProposalOpened(bytes32 indexed proposalId, uint256 askWad);
    event Staked(bytes32 indexed proposalId, address indexed account, uint256 credits);
    event Unstaked(bytes32 indexed proposalId, address indexed account, uint256 credits);

    constructor(
        address governance_,
        uint256 decayWad_,
        uint256 minThresholdWad_,
        uint256 maxThresholdWad_,
        uint256 minConvictionFloor_
    ) {
        if (governance_ == address(0)) revert BadConfig();
        if (decayWad_ == 0 || decayWad_ >= 1e18) revert BadConfig();
        // α cannot be so close to 1 that 1/(1 − α) overflows the recursion.
        if (1e18 - decayWad_ < 1e12) revert BadConfig();
        if (minThresholdWad_ > maxThresholdWad_ || maxThresholdWad_ > 1e18) {
            revert BadConfig();
        }
        governance = governance_;
        decayWad = decayWad_;
        invOneMinusAlphaWad = 1e36 / (1e18 - decayWad_);
        minThresholdWad = minThresholdWad_;
        maxThresholdWad = maxThresholdWad_;
        minConvictionFloor = minConvictionFloor_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert OnlyGovernance();
        _;
    }

    /// @notice Hand the executor to another address (the DAO's own call).
    function setGovernance(address next) external onlyGovernance {
        if (next == address(0)) revert BadConfig();
        governance = next;
    }

    // ---- issuance: seats and credits ----

    /// @notice Add a seat. A seat is what makes an account eligible for
    /// credits; the seat map is the sybil defence, so this is the one door.
    function grantSeat(address seat) external onlyGovernance {
        if (seat == address(0)) revert BadConfig();
        if (isSeat[seat]) return;
        if (seatCount >= MAX_SEATS) revert SeatLimit();
        isSeat[seat] = true;
        seatCount += 1;
        emit SeatGranted(seat);
    }

    /// @notice Batch grant, bounded by `MAX_SEATS` through the same door.
    function grantSeats(address[] calldata seats) external onlyGovernance {
        for (uint256 i = 0; i < seats.length; i++) {
            if (seats[i] == address(0)) revert BadConfig();
            if (isSeat[seats[i]]) continue;
            if (seatCount >= MAX_SEATS) revert SeatLimit();
            isSeat[seats[i]] = true;
            seatCount += 1;
            emit SeatGranted(seats[i]);
        }
    }

    /// @notice Give a seat more credits. Refills are governance's call and are
    /// the only way the allowance grows; there is no accrual faucet and no
    /// self-service claim, which is what keeps issuance bounded and auditable.
    function refill(address seat, uint256 amount) external onlyGovernance {
        if (!isSeat[seat]) revert NotASeat();
        if (totalIssued + amount > MAX_TOTAL_ISSUED) revert IssueLimit();
        totalIssued += amount;
        unspent[seat] += amount;
        emit CreditsIssued(seat, amount);
    }

    // ---- proposals ----

    /// @notice Open a funding proposal. `askWad` is the share of the pool it
    /// requests (WAD); it sets how much conviction it will need.
    function openProposal(bytes32 proposalId, uint256 askWad)
        external
        onlyGovernance
    {
        if (askWad > 1e18) revert BadConfig();
        if (proposals[proposalId].exists) revert ProposalExists();
        proposals[proposalId] =
            Proposal({askWad: askWad, openedAtBlock: uint48(block.number), exists: true});
        emit ProposalOpened(proposalId, askWad);
    }

    // ---- staking ----

    /// @notice Put credits behind a proposal. They leave the unspent pool and
    /// may not back anything else while they are here: one allowance, one
    /// preference at a time.
    function stake(bytes32 proposalId, uint256 credits) external {
        if (!isSeat[msg.sender]) revert NotASeat();
        if (!proposals[proposalId].exists) revert UnknownProposal();
        if (credits == 0 || credits > unspent[msg.sender]) revert NoCredits();

        unspent[msg.sender] -= credits;
        Position memory pos = settlePosition(proposalId, msg.sender);
        pos.credits += credits;
        writePosition(proposalId, msg.sender, pos);

        Total memory tot = settleTotal(proposalId);
        tot.credits += credits;
        writeTotal(proposalId, tot);

        emit Staked(proposalId, msg.sender, credits);
    }

    /// @notice Take credits back. Accumulated conviction is not erased; with
    /// fewer credits behind the proposal it now decays toward the new target.
    function unstake(bytes32 proposalId, uint256 credits) external {
        Position memory pos = settlePosition(proposalId, msg.sender);
        if (credits == 0 || credits > pos.credits) revert Underflow();

        pos.credits -= credits;
        writePosition(proposalId, msg.sender, pos);
        unspent[msg.sender] += credits;

        Total memory tot = settleTotal(proposalId);
        tot.credits -= credits;
        writeTotal(proposalId, tot);

        emit Unstaked(proposalId, msg.sender, credits);
    }

    // ---- reading ----

    /// @notice α^blocks in WAD, by binary exponentiation. Monotone: more
    /// elapsed blocks never mean more decay factor.
    function decayFactor(uint256 blocks_) public view returns (uint256) {
        uint256 base = decayWad;
        uint256 result = 1e18;
        uint256 exp = blocks_;
        while (exp > 0) {
            if (exp & 1 == 1) result = (result * base) / 1e18;
            base = (base * base) / 1e18;
            exp >>= 1;
        }
        return result;
    }

    /// @notice Current conviction of one account behind one proposal.
    function convictionOf(bytes32 proposalId, address account)
        public
        view
        returns (uint256)
    {
        Checkpoint[] storage history = positions[proposalId][account];
        if (history.length == 0) return 0;
        Checkpoint storage last = history[history.length - 1];
        return grown(last.credits, last.conviction, block.number - last.fromBlock);
    }

    /// @notice Current total conviction behind one proposal.
    function totalConviction(bytes32 proposalId) public view returns (uint256) {
        Total storage tot = totals[proposalId];
        return grown(tot.credits, tot.conviction, block.number - tot.updated);
    }

    /// @notice Conviction one account has behind one proposal at a past block
    /// (`IConvictionWeight`). Credits staked after `atBlock` are ignored.
    function convictionWeightAt(bytes32 proposalId, address account, uint48 atBlock)
        external
        view
        returns (uint256)
    {
        Checkpoint[] storage history = positions[proposalId][account];
        if (history.length == 0) return 0;
        if (atBlock < history[0].fromBlock) return 0;

        // Largest checkpoint that had already taken effect at `atBlock`.
        uint256 lo = 0;
        uint256 hi = history.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (history[mid].fromBlock <= atBlock) lo = mid;
            else hi = mid - 1;
        }
        Checkpoint storage cp = history[lo];
        return grown(cp.credits, cp.conviction, atBlock - cp.fromBlock);
    }

    /// @notice Conviction a proposal needs to pass, given its ask.
    function threshold(bytes32 proposalId) public view returns (uint256) {
        Proposal storage p = proposals[proposalId];
        if (!p.exists) revert UnknownProposal();
        uint256 thresholdWad =
            minThresholdWad + ((maxThresholdWad - minThresholdWad) * p.askWad) / 1e18;
        // totalIssued / (1 − α) is the ceiling every possible conviction sum
        // sits under, so the threshold can never be unreachable in principle.
        uint256 ceiling = (totalIssued * invOneMinusAlphaWad) / 1e18;
        uint256 scaled = (ceiling * thresholdWad) / 1e18;
        return scaled < minConvictionFloor ? minConvictionFloor : scaled;
    }

    /// @notice Whether accumulated conviction has crossed the threshold.
    function passed(bytes32 proposalId) external view returns (bool) {
        return totalConviction(proposalId) >= threshold(proposalId);
    }

    // ---- internal ----

    struct Position {
        uint256 credits;
        uint256 conviction;
    }

    /// @notice The recursion: one position of `credits` with `conviction`
    /// accumulated, advanced `elapsed` blocks.
    function grown(uint256 credits, uint256 conviction, uint256 elapsed)
        internal
        view
        returns (uint256)
    {
        uint256 decay = decayFactor(elapsed);
        return (decay * conviction) / 1e18
            + (credits * (1e18 - decay)) / (1e18 - decayWad);
    }

    /// @notice Settle a position to this block and return it in memory.
    function settlePosition(bytes32 proposalId, address account)
        internal
        view
        returns (Position memory pos)
    {
        Checkpoint[] storage history = positions[proposalId][account];
        if (history.length == 0) return pos;
        Checkpoint storage last = history[history.length - 1];
        pos.credits = last.credits;
        pos.conviction =
            grown(last.credits, last.conviction, block.number - last.fromBlock);
    }

    function writePosition(bytes32 proposalId, address account, Position memory pos)
        internal
    {
        Checkpoint[] storage history = positions[proposalId][account];
        uint48 nowBlock = uint48(block.number);
        if (history.length > 0 && history[history.length - 1].fromBlock == nowBlock) {
            history[history.length - 1].credits = pos.credits;
            history[history.length - 1].conviction = pos.conviction;
            return;
        }
        history.push(
            Checkpoint({fromBlock: nowBlock, credits: pos.credits, conviction: pos.conviction})
        );
    }

    function settleTotal(bytes32 proposalId) internal view returns (Total memory tot) {
        Total storage stored = totals[proposalId];
        tot.credits = stored.credits;
        tot.conviction =
            grown(stored.credits, stored.conviction, block.number - stored.updated);
        tot.updated = uint48(block.number);
    }

    function writeTotal(bytes32 proposalId, Total memory tot) internal {
        totals[proposalId] = tot;
    }
}
