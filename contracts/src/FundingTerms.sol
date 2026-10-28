// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IFundingDao {
    function shares() external view returns (address);
    function loot() external view returns (address);
}

interface IFundingToken {
    function mintForFunding(address to, uint256 amount) external;
}

interface IFundingShares {
    function exitExchange() external view returns (address);
}

/// @title FundingTerms
/// @notice Funding terms (D133, docs/v3-review/FUNDING-TERMS.md), for test networks: the only way a DAO under the
/// issuance rule can sell new units, and only as its own votes said in advance. Units earned through reviewed work are
/// untouched; these are units sold for money for the project.
///
/// A DAO publishes terms by vote: the instrument (non-voting Loot by default, or voting Shares) and a lifetime cap on the
/// units that can ever be sold under them. Nothing sells until 30 days after the vote, so a holder who disagrees can
/// leave first; raising the cap restarts that notice, and the instrument never changes. Within the cap the DAO opens one
/// tranche at a time by vote: a quantity, a least price per whole unit, an expiry.
///
/// A tranche is sold only through the weekly rounds the DAO named as its exchange: a funding round reserves what is left
/// of it, settles how much sold, and delivers each buyer's units, which the DAO's Shares or Loot create at that moment
/// (`mintForFunding`, which accepts only their summoner's funding-terms contract). The rounds contract that reserved a
/// round is the only one that can settle and deliver it, even if the DAO names another exchange meanwhile. No admin, no
/// pause.
contract FundingTerms {
    /// @notice How long after terms are published, or widened, before anything under them sells.
    uint64 public constant NOTICE = 30 days;

    struct Terms {
        bool published;
        /// @dev Fixed at the first publication: voting Shares, or non-voting Loot.
        bool asShares;
        uint64 activeFrom;
        /// @dev The most units ever sold under these terms, and how many have been.
        uint128 cap;
        uint128 sold;
    }

    struct Tranche {
        uint128 quantity;
        /// @dev Reserved by an open round, or sold.
        uint128 taken;
        /// @dev Per whole unit, in the round's currency.
        uint128 leastPrice;
        uint64 expiry;
    }

    mapping(address => Terms) public terms;
    mapping(address => Tranche) public tranches;
    /// @notice Units an open funding round reserved, and the rounds contract that holds them.
    mapping(address => uint256) public reserved;
    mapping(address => address) public reservedBy;
    /// @notice Units sold and not yet delivered, by DAO and by the rounds contract that sold them.
    mapping(address => mapping(address => uint256)) public owed;

    error BadTerms();
    error NoTerms();
    error NotYet(uint64 at);
    error BadTranche();
    error OverCap(uint256 room);
    error RoundOpen();
    error NotTheExchange();
    error NothingToSell();
    error TooMuch();

    event TermsPublished(address indexed dao, bool asShares, uint256 cap, uint64 activeFrom);
    event CapLowered(address indexed dao, uint256 cap);
    event TrancheOpened(address indexed dao, uint256 quantity, uint256 leastPrice, uint64 expiry);
    event TrancheClosed(address indexed dao);
    event Reserved(address indexed dao, address indexed rounds, uint256 units);
    event RoundSettled(address indexed dao, address indexed rounds, uint256 reserved, uint256 sold);
    event Delivered(address indexed dao, address indexed to, uint256 units);

    // ---- the DAO's votes -----------------------------------------------------------------------------------------

    /// @notice Publish terms, or widen the cap of terms already published (the instrument stays). Called by the DAO.
    function publish(bool asShares, uint128 cap) external {
        Terms storage t = terms[msg.sender];
        if (cap == 0) revert BadTerms();
        if (t.published) {
            if (asShares != t.asShares || cap <= t.cap) revert BadTerms();
        } else {
            t.published = true;
            t.asShares = asShares;
        }
        t.cap = cap;
        t.activeFrom = uint64(block.timestamp) + NOTICE;
        emit TermsPublished(msg.sender, asShares, cap, t.activeFrom);
    }

    /// @notice Lower the cap, at once: never below what was sold or is reserved.
    function lowerCap(uint128 cap) external {
        Terms storage t = terms[msg.sender];
        if (!t.published) revert NoTerms();
        if (cap >= t.cap || cap < uint256(t.sold) + reserved[msg.sender]) revert BadTerms();
        t.cap = cap;
        emit CapLowered(msg.sender, cap);
    }

    /// @notice Open a tranche within the cap: `quantity` units at no less than `leastPrice` each, until `expiry`. It
    /// replaces any earlier tranche, while no round holds one.
    function openTranche(uint128 quantity, uint128 leastPrice, uint64 expiry) external {
        Terms storage t = terms[msg.sender];
        if (!t.published) revert NoTerms();
        if (block.timestamp < t.activeFrom) revert NotYet(t.activeFrom);
        if (quantity == 0 || leastPrice == 0 || expiry <= block.timestamp) revert BadTranche();
        if (reserved[msg.sender] != 0) revert RoundOpen();
        if (uint256(t.sold) + quantity > t.cap) revert OverCap(t.cap - t.sold);
        tranches[msg.sender] = Tranche(quantity, 0, leastPrice, expiry);
        emit TrancheOpened(msg.sender, quantity, leastPrice, expiry);
    }

    /// @notice Stop selling the tranche, while no round holds it.
    function closeTranche() external {
        if (reserved[msg.sender] != 0) revert RoundOpen();
        delete tranches[msg.sender];
        emit TrancheClosed(msg.sender);
    }

    // ---- the rounds contract the DAO named -----------------------------------------------------------------------

    /// @notice Reserve what is left of `dao`'s live tranche for a funding round: its units, least price and the token
    /// buyers get. Only the exchange the DAO named, and one round at a time.
    function reserve(address dao) external returns (uint256 units, uint256 leastPrice, address token) {
        if (msg.sender != IFundingShares(IFundingDao(dao).shares()).exitExchange()) revert NotTheExchange();
        Terms storage t = terms[dao];
        Tranche storage tr = tranches[dao];
        if (block.timestamp < t.activeFrom || block.timestamp >= tr.expiry || reserved[dao] != 0) {
            revert NothingToSell();
        }
        units = tr.quantity - tr.taken;
        uint256 room = t.cap - t.sold;
        if (units > room) units = room;
        if (units == 0) revert NothingToSell();
        tr.taken += uint128(units);
        reserved[dao] = units;
        reservedBy[dao] = msg.sender;
        leastPrice = tr.leastPrice;
        token = t.asShares ? IFundingDao(dao).shares() : IFundingDao(dao).loot();
        emit Reserved(dao, msg.sender, units);
    }

    /// @notice The round that reserved `dao`'s tranche sold `sold` of it; the rest goes back to the tranche.
    function settle(address dao, uint256 sold) external {
        if (msg.sender != reservedBy[dao]) revert NotTheExchange();
        uint256 held = reserved[dao];
        if (sold > held) revert TooMuch();
        reserved[dao] = 0;
        reservedBy[dao] = address(0);
        tranches[dao].taken -= uint128(held - sold);
        terms[dao].sold += uint128(sold);
        owed[dao][msg.sender] += sold;
        emit RoundSettled(dao, msg.sender, held, sold);
    }

    /// @notice Create `units` of what the rounds contract sold, for the buyer `to`.
    function deliver(address dao, address to, uint256 units) external {
        uint256 due = owed[dao][msg.sender];
        if (units > due) revert TooMuch();
        owed[dao][msg.sender] = due - units;
        emit Delivered(dao, to, units);
        IFundingDao d = IFundingDao(dao);
        IFundingToken(terms[dao].asShares ? d.shares() : d.loot()).mintForFunding(to, units);
    }
}
