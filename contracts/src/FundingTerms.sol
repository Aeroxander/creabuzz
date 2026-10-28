// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFundingDao {
    function shares() external view returns (address);
    function loot() external view returns (address);
}

interface IFundingToken {
    function mintForFunding(address to, uint256 amount) external;
}

interface IFundingRounds {
    function currency() external view returns (IERC20);
}

/// @title FundingTerms
/// @notice Funding terms (D133, docs/v3-review/FUNDING-TERMS.md), for test networks: the only way a DAO under the
/// issuance rule can sell new units, and only as its own votes said in advance. Units earned through reviewed work are
/// untouched; these are units sold for money for the project.
///
/// A DAO publishes terms by vote: the instrument (non-voting Loot by default, or voting Shares), a funding limit on the
/// units that can be sold under them, and the one rounds contract that may sell them. Nothing sells until 30 days after
/// the vote, so a holder who disagrees can leave first; raising the limit restarts that notice; the instrument and the
/// rounds contract never change. Within the limit the DAO opens one tranche at a time by vote: a quantity, a least price
/// per whole unit, an expiry.
///
/// Only the rounds contract the terms name can reserve a tranche for a funding round and settle it. Settling creates the
/// units sold at once, for the rounds contract to hand to its buyers, in the same transaction as its check that they sell
/// above what leaving pays (so nothing arriving later changes what they were sold against). A sale needs a treasury that
/// holds only the round's currency: no ETH, and nothing of the tokens on its watch list, because a price set against one
/// asset would otherwise give buyers a share of the others for nothing. A contract cannot list the tokens it holds, so the
/// people that underpricing would harm keep the list (D136): the DAO can set it by vote, and any holder can add any token
/// the treasury holds, which stops sales at once. Only a vote can let sales go ahead while the treasury holds a token
/// (`accept`): holders then agree to sell part of it with the units. No admin, no pause.
///
/// The terms also fix a small exit fee (D135, at most 5%): the part of what leaving pays that stays in the treasury, for
/// the people who remain, so buying just before money lands and leaving just after it costs something. Only a vote can
/// lower it, never raise it, and it is not charged while terms are under notice, so a holder who would be diluted by a
/// higher funding limit can still leave whole. The DAO's exit reads it from `exitFeeOf`.
contract FundingTerms {
    /// @notice How long after terms are published, or widened, before anything under them sells.
    uint64 public constant NOTICE = 30 days;
    /// @notice The most tokens checked for a DAO.
    uint256 public constant MAX_WATCHED = 16;
    /// @notice The highest exit fee terms can set, in basis points.
    uint16 public constant MAX_EXIT_FEE_BPS = 500;

    struct Terms {
        bool published;
        /// @dev Fixed at the first publication: voting Shares, or non-voting Loot.
        bool asShares;
        uint64 activeFrom;
        /// @dev The funding limit, and how many units have been sold under it.
        uint128 cap;
        uint128 sold;
        /// @dev Fixed at the first publication: the one rounds contract that sells under these terms.
        address rounds;
        /// @dev Set at the first publication; only ever lowered after.
        uint16 exitFeeBps;
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
    /// @notice Units an open funding round holds.
    mapping(address => uint256) public reserved;
    mapping(address => address[]) private watched;
    /// @notice Tokens a DAO voted to sell units while holding, so that buyers get part of them too.
    mapping(address => mapping(address => bool)) public accepted;

    error BadTerms();
    error NoTerms();
    error NotYet(uint64 at);
    error BadTranche();
    error OverCap(uint256 room);
    error RoundOpen();
    error NotTheRounds();
    error NothingToSell();
    error TooMuch();
    error OtherAssets(address token);
    error NotAHolder();
    error NotHeld(address token);
    error ListFull();

    event TermsPublished(
        address indexed dao, bool asShares, uint256 cap, address rounds, uint16 exitFeeBps, uint64 activeFrom
    );
    event CapLowered(address indexed dao, uint256 cap);
    event ExitFeeLowered(address indexed dao, uint16 exitFeeBps);
    event Watching(address indexed dao, address[] tokens);
    event Flagged(address indexed dao, address indexed token, address indexed by);
    event Accepted(address indexed dao, address indexed token, bool yes);
    event TrancheOpened(address indexed dao, uint256 quantity, uint256 leastPrice, uint64 expiry);
    event TrancheClosed(address indexed dao);
    event Reserved(address indexed dao, uint256 units);
    event RoundSettled(address indexed dao, uint256 reserved, uint256 sold);

    // ---- the DAO's votes -----------------------------------------------------------------------------------------

    /// @notice Publish terms, or raise the limit of terms already published (instrument, rounds and exit fee stay). By
    /// the DAO.
    function publish(bool asShares, uint128 cap, address rounds, uint16 exitFeeBps) external {
        Terms storage t = terms[msg.sender];
        if (cap == 0 || rounds.code.length == 0 || exitFeeBps > MAX_EXIT_FEE_BPS) revert BadTerms();
        if (t.published) {
            if (asShares != t.asShares || rounds != t.rounds || exitFeeBps != t.exitFeeBps || cap <= t.cap) {
                revert BadTerms();
            }
        } else {
            t.published = true;
            t.asShares = asShares;
            t.rounds = rounds;
            t.exitFeeBps = exitFeeBps;
        }
        t.cap = cap;
        t.activeFrom = uint64(block.timestamp) + NOTICE;
        emit TermsPublished(msg.sender, asShares, cap, rounds, exitFeeBps, t.activeFrom);
    }

    /// @notice Lower the exit fee, at once.
    function lowerExitFee(uint16 exitFeeBps) external {
        Terms storage t = terms[msg.sender];
        if (!t.published) revert NoTerms();
        if (exitFeeBps >= t.exitFeeBps) revert BadTerms();
        t.exitFeeBps = exitFeeBps;
        emit ExitFeeLowered(msg.sender, exitFeeBps);
    }

    /// @notice Lower the limit, at once: never below what was sold or is reserved.
    function lowerCap(uint128 cap) external {
        Terms storage t = terms[msg.sender];
        if (!t.published) revert NoTerms();
        if (cap >= t.cap || cap < uint256(t.sold) + reserved[msg.sender]) revert BadTerms();
        t.cap = cap;
        emit CapLowered(msg.sender, cap);
    }

    /// @notice Add tokens the treasury must not hold while selling (besides the round's currency; ETH is always
    /// checked). Nothing is taken off the list this way: only accepting a token, or the treasury no longer holding it.
    function watch(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) {
            _watch(msg.sender, tokens[i]);
        }
        emit Watching(msg.sender, tokens);
    }

    /// @notice Let sales go ahead while the treasury holds `tokens` (`yes`), or stop them again. By the DAO's vote.
    function accept(address[] calldata tokens, bool yes) external {
        for (uint256 i; i < tokens.length; ++i) {
            accepted[msg.sender][tokens[i]] = yes;
            emit Accepted(msg.sender, tokens[i], yes);
        }
    }

    // ---- any holder ----------------------------------------------------------------------------------------------

    /// @notice Stop `dao`'s sales while its treasury holds `token`. Any holder of its Shares or Loot, for a token the
    /// treasury holds now and the DAO has not accepted. A full list makes room by dropping a token the treasury no
    /// longer holds or the DAO accepted.
    function flag(address dao, address token) external {
        IFundingDao d = IFundingDao(dao);
        if (IERC20(d.shares()).balanceOf(msg.sender) == 0 && IERC20(d.loot()).balanceOf(msg.sender) == 0) {
            revert NotAHolder();
        }
        if (accepted[dao][token]) revert BadTerms();
        if (IERC20(token).balanceOf(dao) == 0) revert NotHeld(token);
        _watch(dao, token);
        emit Flagged(dao, token, msg.sender);
    }

    // ---- the DAO's votes, continued ------------------------------------------------------------------------------

    /// @notice Open a tranche within the limit: `quantity` units at no less than `leastPrice` each, until `expiry`. It
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

    // ---- the rounds contract the terms name ----------------------------------------------------------------------

    /// @notice Reserve what is left of `dao`'s live tranche for a funding round: its units, least price and the token
    /// buyers get. Only the rounds contract the terms name, one round at a time, with a treasury of one asset.
    function reserve(address dao) external returns (uint256 units, uint256 leastPrice, address token) {
        Terms storage t = terms[dao];
        if (msg.sender != t.rounds) revert NotTheRounds();
        Tranche storage tr = tranches[dao];
        if (block.timestamp < t.activeFrom || block.timestamp >= tr.expiry || reserved[dao] != 0) {
            revert NothingToSell();
        }
        _oneAsset(dao, msg.sender);
        units = tr.quantity - tr.taken;
        uint256 room = t.cap - t.sold;
        if (units > room) units = room;
        if (units == 0) revert NothingToSell();
        tr.taken += uint128(units);
        reserved[dao] = units;
        leastPrice = tr.leastPrice;
        token = t.asShares ? IFundingDao(dao).shares() : IFundingDao(dao).loot();
        emit Reserved(dao, units);
    }

    /// @notice The round sold `sold` of what it reserved: those units are created now, for the rounds contract to hand
    /// to its buyers, and the rest goes back to the tranche. Releasing (`sold` zero) is always possible.
    function settle(address dao, uint256 sold) external {
        Terms storage t = terms[dao];
        if (msg.sender != t.rounds) revert NotTheRounds();
        uint256 held = reserved[dao];
        if (sold > held) revert TooMuch();
        reserved[dao] = 0;
        tranches[dao].taken -= uint128(held - sold);
        t.sold += uint128(sold);
        emit RoundSettled(dao, held, sold);
        if (sold == 0) return;
        _oneAsset(dao, msg.sender);
        IFundingDao d = IFundingDao(dao);
        IFundingToken(t.asShares ? d.shares() : d.loot()).mintForFunding(msg.sender, sold);
    }

    // ---- reads ---------------------------------------------------------------------------------------------------

    /// @dev Put `token` on `dao`'s list, once. A full list makes room by dropping a token the treasury no longer holds or
    /// the DAO accepted.
    function _watch(address dao, address token) private {
        address[] storage list = watched[dao];
        uint256 room = type(uint256).max;
        for (uint256 i; i < list.length; ++i) {
            address t = list[i];
            if (t == token) return;
            if (room == type(uint256).max && (accepted[dao][t] || IERC20(t).balanceOf(dao) == 0)) room = i;
        }
        if (list.length < MAX_WATCHED) list.push(token);
        else if (room != type(uint256).max) list[room] = token;
        else revert ListFull();
    }

    function watchedOf(address dao) external view returns (address[] memory) {
        return watched[dao];
    }

    /// @notice The part of what leaving pays that stays in `dao`'s treasury now, in basis points: none without terms,
    /// and none while they are under notice.
    function exitFeeOf(address dao) external view returns (uint256) {
        Terms storage t = terms[dao];
        return t.published && block.timestamp >= t.activeFrom ? t.exitFeeBps : 0;
    }

    /// @dev The treasury holds no ETH and none of the watched tokens the DAO has not accepted, other than the round's own
    /// currency.
    function _oneAsset(address dao, address rounds) private view {
        if (dao.balance != 0) revert OtherAssets(address(0));
        address currency = address(IFundingRounds(rounds).currency());
        address[] storage list = watched[dao];
        for (uint256 i; i < list.length; ++i) {
            address token = list[i];
            if (token != currency && !accepted[dao][token] && IERC20(token).balanceOf(dao) != 0) {
                revert OtherAssets(token);
            }
        }
    }
}
