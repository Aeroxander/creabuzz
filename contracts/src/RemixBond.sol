// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArbitrator} from "./OpenBounty.sol";

/// @title RemixBond
/// @notice A remix's bond to its parent (N12, docs/v3-review/REMIX-PARENT-SHARE.md), for test networks: a project built
/// on another posts $CREATE, held for a term, against the parent's remix terms (their words are kept in the event, their
/// hash here). Anyone can take it to the court, paying the court's fee, saying the remix broke those terms; if the court
/// upholds that, the bond is the parent DAO's (anyone sends it there), and the page says so. Any other ruling leaves it
/// held. Cases can be opened only during the term; after it, with no case open, anyone returns the bond to whoever posted
/// it.
///
/// Nothing else happens: nobody's tokens are taken, leaving stays open in both projects, and the bond is the whole remedy.
/// No admin, no pause.
contract RemixBond {
    using SafeERC20 for IERC20;

    uint64 public constant MIN_TERM = 30 days;
    uint64 public constant MAX_TERM = 730 days;
    uint256 public constant MAX_TEXT = 1000;

    uint8 internal constant HELD = 1;
    uint8 internal constant FORFEITED = 2;
    uint8 internal constant RETURNED = 3;
    uint8 internal constant PAID = 4;

    IERC20 public immutable token;
    IArbitrator public immutable court;

    struct Bond {
        address poster;
        address parentDao;
        uint64 releasesAt;
        uint8 state;
        /// @dev The court case open on it, or 0.
        uint64 openCase;
        uint128 amount;
        /// @dev keccak256 of the remix's and the parent's launch record coordinates, so pages find a bond by either.
        bytes32 remix;
        bytes32 parent;
        bytes32 termsHash;
    }

    uint256 public bondCount;
    mapping(uint256 => Bond) public bonds;
    /// @notice The bond each court case is about.
    mapping(uint256 => uint256) public bondOfCase;
    bool private entered;

    error InvalidSetup();
    error Reentrancy();
    error BadTerm();
    error BadText();
    error NothingToBond();
    error ShortTransfer(uint256 expected, uint256 received);
    error NotHeld(uint256 id);
    error CaseOpen(uint256 id);
    error NotDue(uint256 id, uint64 at);
    error NotCourt();
    error UnknownCase(uint256 dispute);
    error NotForfeited(uint256 id);
    error TermOver(uint256 id);

    event Posted(
        uint256 indexed id,
        bytes32 indexed remix,
        bytes32 indexed parent,
        address poster,
        address parentDao,
        uint256 amount,
        uint64 releasesAt,
        string terms
    );
    event CaseOpened(uint256 indexed id, uint256 dispute, address indexed by);
    event Ruled(uint256 indexed id, uint256 dispute, uint256 ruling);
    event Forfeited(uint256 indexed id, address indexed parentDao, uint256 amount);
    event PaidToParent(uint256 indexed id, address indexed parentDao, uint256 amount);
    event Returned(uint256 indexed id, address indexed poster, uint256 amount);

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(IERC20 token_, IArbitrator court_) {
        if (address(token_).code.length == 0 || address(court_).code.length == 0) revert InvalidSetup();
        token = token_;
        court = court_;
    }

    /// @notice Post `amount` as a bond to `parentDao` for `term`, against the parent's remix `terms` (in words).
    function post(bytes32 remix, bytes32 parent, address parentDao, string calldata terms, uint256 amount, uint64 term)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (term < MIN_TERM || term > MAX_TERM) revert BadTerm();
        if (bytes(terms).length > MAX_TEXT) revert BadText();
        if (amount == 0 || amount > type(uint128).max || parentDao == address(0)) revert NothingToBond();
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert ShortTransfer(amount, received);
        id = ++bondCount;
        Bond storage b = bonds[id];
        b.poster = msg.sender;
        b.parentDao = parentDao;
        b.releasesAt = uint64(block.timestamp) + term;
        b.state = HELD;
        b.amount = uint128(amount);
        b.remix = remix;
        b.parent = parent;
        b.termsHash = keccak256(bytes(terms));
        emit Posted(id, remix, parent, msg.sender, parentDao, amount, b.releasesAt, terms);
    }

    /// @notice Ask the court whether the remix broke the parent's terms, paying the court's fee. One case at a time.
    function openCase(uint256 id) external nonReentrant returns (uint256 dispute) {
        Bond storage b = bonds[id];
        if (b.state != HELD) revert NotHeld(id);
        if (b.openCase != 0) revert CaseOpen(id);
        if (block.timestamp >= b.releasesAt) revert TermOver(id);
        IERC20 feeToken = court.feeToken();
        uint256 fee = court.arbitrationCost();
        uint256 before = feeToken.balanceOf(address(this));
        feeToken.safeTransferFrom(msg.sender, address(this), fee);
        uint256 received = feeToken.balanceOf(address(this)) - before;
        if (received != fee) revert ShortTransfer(fee, received);
        feeToken.forceApprove(address(court), fee);
        dispute = court.createDispute(2, abi.encode(id, b.termsHash));
        b.openCase = uint64(dispute);
        bondOfCase[dispute] = id;
        emit CaseOpened(id, dispute, msg.sender);
    }

    /// @notice The court's final ruling: 1 means the remix broke the terms and the bond goes to the parent's DAO.
    function rule(uint256 dispute, uint256 ruling) external nonReentrant {
        if (msg.sender != address(court)) revert NotCourt();
        uint256 id = bondOfCase[dispute];
        Bond storage b = bonds[id];
        if (id == 0 || b.openCase != dispute) revert UnknownCase(dispute);
        b.openCase = 0;
        emit Ruled(id, dispute, ruling);
        if (ruling == 1) {
            b.state = FORFEITED;
            emit Forfeited(id, b.parentDao, b.amount);
        }
    }

    /// @notice Send a forfeited bond to the parent's DAO. Anyone may call it; kept apart from the ruling so nothing about
    /// the transfer can stop the court from ruling.
    function payParent(uint256 id) external nonReentrant {
        Bond storage b = bonds[id];
        if (b.state != FORFEITED) revert NotForfeited(id);
        b.state = PAID;
        emit PaidToParent(id, b.parentDao, b.amount);
        token.safeTransfer(b.parentDao, b.amount);
    }

    /// @notice Return a bond to whoever posted it, once its term is over and no case is open. Anyone may call it.
    function release(uint256 id) external nonReentrant {
        Bond storage b = bonds[id];
        if (b.state != HELD) revert NotHeld(id);
        if (b.openCase != 0) revert CaseOpen(id);
        if (block.timestamp < b.releasesAt) revert NotDue(id, b.releasesAt);
        b.state = RETURNED;
        emit Returned(id, b.poster, b.amount);
        token.safeTransfer(b.poster, b.amount);
    }
}
