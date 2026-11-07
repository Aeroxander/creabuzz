// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Bal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice The surface `ClaimStake` drives: mint at approval quorum,
///         suspend on fraud freeze.
interface IRoyaltyDistributor {
    function mint(
        bytes32 claimId,
        address contributor,
        uint32 weight,
        uint64 term,
        uint8 band,
        uint128 allocation
    ) external;

    function suspend(bytes32 claimId) external;
}

/// @title RoyaltyDistributor
/// @notice Contributor royalty ledger for a launched project token
/// (docs/token-lifecycle-design.md).
///
/// Revenue splits FIRST (D3) into a buyback share, a treasury share, and the
/// contributor pool — the buyback machine only ever draws its own share and
/// has no claim on contributor money at any point (I2). The pool is
/// attributed to attested royalty schedules (minted exclusively by
/// `ClaimStake` at approval quorum — I8: no attestation, no income) and
/// CREDITED to contributors.
///
/// The core guarantee — "credited is owned" (D2): once an amount lands in
/// `claimableOf`, no call in this contract — or governance, or a pause, or a
/// wind-down — can reduce it except a successful transfer to its owner.
/// There is no pause, no sweep, no clawback, and no governance path over
/// credited balances anywhere in this contract. `claim()` is the one
/// unmoderated function in the system.
///
/// Accrual is scaled prospectively only (D5): `h = min(1, held/alloc)`
/// trapezoidally sampled at window boundaries (v1 sampling per design doc
/// §3.3). Selling allocation reduces the accrual RATE from that moment;
/// everything already credited survives any sale. Unattributable pool
/// shares carry into the next window's pool (D4) — never to treasury or
/// buybacks.
///
/// Band tables (D10, locked): badge tier -> schedule caps and LBAMM
/// per-window sell caps (bps of allocation).
contract RoyaltyDistributor {
    // ---------------------------------------------------------------- errors
    error ZeroAddress();
    error BadBps();
    error BadWindow();
    error NotClaimStake();
    error NotGovernance();
    error NotTreasury();
    error NoWindow();
    error TooEarly();
    error ScheduleExists();
    error NoSchedule();
    error BadSchedule();
    error NothingToClaim();
    error TransferFailed();
    error Reentrancy();

    // ---------------------------------------------------------------- events
    event Funded(address indexed from, uint256 amount);
    event ScheduleMinted(
        bytes32 indexed claimId,
        address indexed contributor,
        uint32 weight,
        uint64 term,
        uint8 band,
        uint256 allocation
    );
    event ScheduleSuspended(bytes32 indexed claimId);
    event ScheduleUnsuspended(bytes32 indexed claimId);
    event WindowClosed(
        uint64 indexed windowId,
        uint256 revenue,
        uint256 buybackShare,
        uint256 treasuryShare,
        uint256 pool,
        uint256 carried
    );
    /// @param pushed true when the credit was delivered in the same call;
    ///        false when it sits in `claimableOf` awaiting an eternal pull.
    event Credited(address indexed contributor, uint256 amount, bool pushed);

    // ------------------------------------------------------------------ data
    struct Schedule {
        address contributor;
        uint64 start;
        uint64 end;
        uint32 weight;
        uint8 band;
        uint128 allocation;
        bool suspended;
    }

    IERC20Bal public immutable currency; // revenue currency (e.g. USDC)
    IERC20Bal public immutable projectToken; // launched project token
    address public immutable treasury;
    address public immutable buybackSink; // TokenMaster market / buyback executor
    address public immutable claimStake; // sole schedule minter (attestation)
    address public immutable governance; // may only UNSUSPEND schedules
    uint64 public immutable windowLen; // settlement window (D10: ~30 days)
    uint16 public immutable buybackBps; // β
    uint16 public immutable treasuryBps; // τ; pool π = 10000 − β − τ

    uint64 public genesis; // set at first fund
    uint64 public closedWindows; // number of settled windows

    uint256 public pendingRevenue; // funded, not yet settled
    uint256 public carry; // unattributable -> next window's pool (D4)
    uint256 public totalClaimable; // Σ claimableOf (solvency bookkeeping)
    mapping(address => uint256) public claimableOf;

    mapping(bytes32 => Schedule) public schedules;
    bytes32[] public scheduleIds;
    mapping(address => uint256) public allocOf; // Σ earned allocations
    mapping(address => uint256) public openBal; // project-token balance at last close
    address[] public contributors;
    mapping(address => bool) internal enrolled;
    uint256 internal locked = 1;

    // ------------------------------------------------------------ modifiers
    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    modifier onlyClaimStake() {
        if (msg.sender != claimStake) revert NotClaimStake();
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(
        IERC20Bal currency_,
        IERC20Bal projectToken_,
        address treasury_,
        address buybackSink_,
        address claimStake_,
        address governance_,
        uint64 windowLen_,
        uint16 buybackBps_,
        uint16 treasuryBps_
    ) {
        if (
            address(currency_) == address(0) ||
            address(projectToken_) == address(0) ||
            treasury_ == address(0) ||
            buybackSink_ == address(0) ||
            claimStake_ == address(0) ||
            governance_ == address(0)
        ) revert ZeroAddress();
        if (windowLen_ == 0) revert BadWindow();
        if (uint256(buybackBps_) + treasuryBps_ >= 10_000) revert BadBps();
        currency = currency_;
        projectToken = projectToken_;
        treasury = treasury_;
        buybackSink = buybackSink_;
        claimStake = claimStake_;
        governance = governance_;
        windowLen = windowLen_;
        buybackBps = buybackBps_;
        treasuryBps = treasuryBps_;
    }

    // ------------------------------------------------------- band tables D10
    /// @notice Schedule weight cap by badge tier (1x / 2x / 3x).
    function bandWeightCap(uint8 band) public pure returns (uint32) {
        if (band == 1) return 1;
        if (band == 2) return 2;
        if (band == 3) return 3;
        revert BadSchedule();
    }

    /// @notice Schedule term cap by badge tier (12 / 24 / 36 months, seconds).
    function bandTermCap(uint8 band) public pure returns (uint64) {
        if (band == 1) return 365 days;
        if (band == 2) return 730 days;
        if (band == 3) return 1095 days;
        revert BadSchedule();
    }

    /// @notice LBAMM per-window sell cap by badge tier (D8), bps of
    ///         allocation. Consumed by the sell-rate gate.
    function bandSellCapBps(uint8 band) public pure returns (uint16) {
        if (band == 1) return 300; // 3%
        if (band == 2) return 500; // 5%
        if (band == 3) return 800; // 8%
        revert BadSchedule();
    }

    // ----------------------------------------------------------- revenue in
    /// @notice Revenue arrives. `from` funds itself, or the treasury funds
    ///         any payer. Attribution happens at the window close; nothing is
    ///         owed until it is CREDITED — and once credited it is untouchable.
    function fund(address from, uint256 amount) external nonReentrant {
        if (msg.sender != treasury && msg.sender != from) revert NotTreasury();
        if (amount == 0) return;
        if (genesis == 0) genesis = uint64(block.timestamp);
        pendingRevenue += amount;
        if (!currency.transferFrom(from, address(this), amount)) revert TransferFailed();
        emit Funded(from, amount);
    }

    // ------------------------------------------------------- schedule minting
    /// @notice Mint a royalty schedule. Callable ONLY by `ClaimStake` at
    ///         approval quorum — the unlock is attestation, never a price
    ///         read. One schedule per claim (I8, I4).
    function mint(
        bytes32 claimId,
        address contributor,
        uint32 weight,
        uint64 term,
        uint8 band,
        uint128 allocation
    ) external nonReentrant onlyClaimStake {
        if (schedules[claimId].contributor != address(0)) revert ScheduleExists();
        if (
            contributor == address(0) ||
            weight == 0 ||
            weight > bandWeightCap(band) ||
            term == 0 ||
            term > bandTermCap(band) ||
            allocation == 0
        ) revert BadSchedule();
        uint64 start = uint64(block.timestamp);
        schedules[claimId] = Schedule(contributor, start, start + term, weight, band, allocation, false);
        scheduleIds.push(claimId);
        allocOf[contributor] += allocation;
        if (!enrolled[contributor]) {
            enrolled[contributor] = true;
            contributors.push(contributor);
            // Trapezoid opening sample for the running window (§3.3 v1).
            openBal[contributor] = projectToken.balanceOf(contributor);
        }
        emit ScheduleMinted(claimId, contributor, weight, term, band, allocation);
    }

    /// @notice Suspend a schedule (fraud escalation via `ClaimStake.freeze`).
    ///         Stops FUTURE accrual only — credited balances are untouched by
    ///         construction (D2, I3).
    function suspend(bytes32 claimId) external onlyClaimStake {
        if (schedules[claimId].contributor == address(0)) revert NoSchedule();
        schedules[claimId].suspended = true;
        emit ScheduleSuspended(claimId);
    }

    /// @notice Governance clears a suspension after investigation. Future
    ///         accrual only (I3). This is the ONLY governance power here —
    ///         it can never touch credited balances (D2).
    function unsuspend(bytes32 claimId) external onlyGovernance nonReentrant {
        if (schedules[claimId].contributor == address(0)) revert NoSchedule();
        schedules[claimId].suspended = false;
        emit ScheduleUnsuspended(claimId);
    }

    // -------------------------------------------------------------- settling
    /// @notice Close the earliest un-closed window. Permissionless.
    ///
    /// Split-first (D3/D4): B and T are fixed from the window's revenue; the
    /// pool = remainder + carry. Pool attribution is scaled by `h` and the
    /// unattributable part — plus division remainders — carries forward.
    /// Every transfer is delivered independently: a failed buyback or
    /// treasury push falls back to that address's own `claimableOf` and can
    /// never block contributor credits (I2).
    function settle() external nonReentrant {
        if (genesis == 0) revert NoWindow();
        uint64 id = closedWindows;
        uint64 close = uint64(uint256(genesis) + (uint256(id) + 1) * uint256(windowLen));
        if (block.timestamp < close) revert TooEarly();
        closedWindows = id + 1;
        uint64 open = uint64(uint256(close) - uint256(windowLen));

        uint256 revenue = pendingRevenue;
        pendingRevenue = 0;
        uint256 buybackShare = (revenue * buybackBps) / 10_000;
        uint256 treasuryShare = (revenue * treasuryBps) / 10_000;
        uint256 pool = revenue - buybackShare - treasuryShare + carry;
        carry = 0;

        // Weight numerators: Σ weight × active-seconds in the window. The
        // shared 1/windowLen denominator cancels in the split below.
        uint256 totalNum;
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            Schedule storage s = schedules[scheduleIds[i]];
            if (s.suspended) continue;
            uint256 ov = _overlap(s.start, s.end, open, close);
            if (ov == 0) continue;
            uint256 num = uint256(s.weight) * ov;
            _numOf[s.contributor] += num;
            totalNum += num;
        }

        if (totalNum == 0) {
            carry = pool;
        } else {
            uint256 attributed;
            for (uint256 i = 0; i < contributors.length; i++) {
                address c = contributors[i];
                uint256 closeB = projectToken.balanceOf(c);
                uint256 num = _numOf[c];
                _numOf[c] = 0;
                if (num > 0) {
                    uint256 entitlement = (pool * num) / totalNum;
                    attributed += entitlement;
                    uint256 alloc = allocOf[c];
                    uint256 avg = (openBal[c] + closeB) / 2;
                    uint256 h = avg >= alloc ? 1e18 : (avg * 1e18) / alloc;
                    uint256 credit = (entitlement * h) / 1e18;
                    carry += entitlement - credit; // unattributable -> next pool (D4)
                    if (credit > 0) {
                        _credit(c, credit);
                    }
                }
                // Roll the trapezoid opening sample for the next window even
                // when this window attributed nothing.
                openBal[c] = closeB;
            }
            carry += pool - attributed; // division remainder grows P, never B/T (I2)
        }

        // Independent delivery of the non-contributor shares (I2).
        if (buybackShare > 0) _pushOrCredit(buybackSink, buybackShare);
        if (treasuryShare > 0) _pushOrCredit(treasury, treasuryShare);

        emit WindowClosed(id, revenue, buybackShare, treasuryShare, pool, carry);
    }

    /// @notice Pull a credited balance. Unmoderated and non-expiring (D2):
    ///         no caller restriction, no window, no pause — the only way a
    ///         credited balance ever decreases is its owner receiving the
    ///         transfer.
    function claim() external nonReentrant {
        uint256 amt = claimableOf[msg.sender];
        if (amt == 0) revert NothingToClaim();
        claimableOf[msg.sender] = 0;
        totalClaimable -= amt;
        // Revert restores the balance — the money can be retried forever.
        if (!_pay(msg.sender, amt)) revert TransferFailed();
        emit Credited(msg.sender, amt, true);
    }

    // ----------------------------------------------------------------- views
    function nextClose() public view returns (uint64) {
        if (genesis == 0) return 0;
        return uint64(uint256(genesis) + (uint256(closedWindows) + 1) * uint256(windowLen));
    }

    /// @notice Highest badge tier across this contributor's schedules —
    ///         the input the sell-rate gate caps against (D8).
    function bandOf(address contributor) external view returns (uint8 band) {
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            Schedule storage s = schedules[scheduleIds[i]];
            if (s.contributor == contributor && s.band > band) band = s.band;
        }
    }

    // -------------------------------------------------------------- internal
    mapping(address => uint256) internal _numOf;

    /// @notice Credit first (attribution is final — I4), then attempt push
    ///         delivery; a failed push leaves the credit in `claimableOf`,
    ///         claimable forever.
    function _credit(address to, uint256 amount) internal {
        claimableOf[to] += amount;
        totalClaimable += amount;
        if (_pay(to, amount)) {
            claimableOf[to] -= amount;
            totalClaimable -= amount;
            emit Credited(to, amount, true);
        } else {
            emit Credited(to, amount, false);
        }
    }

    /// @notice Deliver a share or leave it claimable by the recipient.
    function _pushOrCredit(address to, uint256 amount) internal {
        if (_pay(to, amount)) {
            emit Credited(to, amount, true);
        } else {
            claimableOf[to] += amount;
            totalClaimable += amount;
            emit Credited(to, amount, false);
        }
    }

    function _pay(address to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        try currency.transfer(to, amount) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _overlap(uint64 s0, uint64 s1, uint64 o, uint64 c) internal pure returns (uint256) {
        uint64 a = s0 > o ? s0 : o;
        uint64 b = s1 < c ? s1 : c;
        return b > a ? uint256(b) - uint256(a) : 0;
    }
}
