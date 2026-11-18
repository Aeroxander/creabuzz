// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SignatureChecker} from "oz5/utils/cryptography/SignatureChecker.sol";
import {IShares, IVester, ILauncherProjects, ProjectAddresses} from "./Interfaces.sol";

/// @title EarlierBackers
/// @notice The claim contract for project zero's earlier raise (Creaton's backers under the old SAFTs; design:
/// `docs/next-version/EARLIER-BACKERS.md`, section 5). At project zero's launch the Launcher gives this contract one plain
/// grant in the project's Vester, on the one clock every held Share follows (evenly over 365 days from the market opening or
/// a "no market" declaration, never faster). Each entry of the list receives `amount * released / granted` of it, where
/// `released` and `granted` are the Vester's figures for this contract's grant, once its holder has agreed and its waits are
/// over. There is no refund path, no money, no fee, no vote, no park and no hand-back here.
///
/// The list: one stored leaf per entry, `keccak256(abi.encode(entry, holder, amount, salt))`, so an entry cannot appear
/// twice and holders' addresses and amounts stay hidden until each one agrees. The sum of the entries is checked when they
/// agree: the Shares agreed to never pass `total`.
///
/// Agreeing (`consent`): the holder signs one EIP-712 message (domain "Creaton earlier backers", version 1, this chain and
/// this contract) naming the entry, the holder, the Share count, where the Shares go, the project, the text's fingerprint and
/// version, counsel's one-line summary, the holder version and a deadline; anyone may submit it. A plain key signs with ECDSA,
/// a contract wallet answers EIP-1271, and a holder may instead call in person with no signature. Nothing can be agreed until
/// the grant is in the Vester and covers the whole list. The Shares go only to a wallet that already has code on this chain,
/// or to the holder itself.
///
/// The keeper (a 2-of-3 Safe in the design: counsel, one independent person and the owner) can do three things and nothing
/// else: void a consent inside its 21-day challenge window (it goes back to open, never to someone else), replace the holder
/// of an open entry after a public 30-day wait the holder can veto (a lost key), and publish a corrected text. Delivery
/// (`deliver`, anyone) waits out the challenge window and, when counsel switches it on, a hold from each signature
/// (`minHoldFromConsent`, zero by default). Entries nobody agreed to by counsel's long-stop date go to the project's reserve
/// (`close`, then `toReserve`); until then they wait, and the project's Treasury leaves Shares released here but not yet
/// delivered out of the count its exit slice is divided by.
/// @dev Deliberately no immutables: the Launcher accepts this contract only if its deployed code hashes to
/// `keccak256(type(EarlierBackers).runtimeCode)` (read once from `Parts`), and immutables would make each copy's code differ.
contract EarlierBackers {
    /// @notice The most entries a list may have.
    uint256 public constant MAX_ENTRIES = 64;
    /// @notice After each consent, this long for the keeper to void it (with public evidence); nothing is delivered before.
    uint256 public constant CHALLENGE = 21 days;
    /// @notice A holder replacement waits this long after it is proposed (the holder may veto meanwhile).
    uint256 public constant REPLACE_WAIT = 30 days;
    /// @notice The long-stop date must be at least this long after the list is made.
    uint256 public constant MIN_LONG_STOP = 730 days;
    /// @notice The longest hold from each signature counsel may switch on.
    uint256 public constant MAX_HOLD = 730 days;
    /// @notice The one message a holder signs. `summary` is counsel's one-line sentence: the wallet shows it, and its hash is
    /// what the contract stores (`summaryHash`), as EIP-712 encodes a string.
    bytes32 public constant CONSENT_TYPEHASH = keccak256(
        "Consent(uint256 entry,address holder,uint256 amount,address receiver,bytes32 project,bytes32 textHash,"
        "uint256 textVersion,string summary,uint256 holderVersion,uint256 validUntil)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Creaton earlier backers");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// @notice One entry of the list.
    struct Entry {
        address holder; // the holder after a replacement; zero while the holder is the one in the leaf
        uint32 holderVersion; // grows with each replacement, so signatures for an earlier holder never verify
        uint64 consentAt; // when the current consent was given; zero while the entry is open
        address signer; // the holder who gave the current consent
        uint64 pendingAt; // when the pending replacement was proposed
        address pending; // the proposed new holder; zero when none
        address barred; // the holder whose consent the keeper last voided: may not veto a replacement
        address receiver; // where the Shares go (set at consent)
        uint256 amount; // the entry's Shares (set at consent)
        uint256 taken; // Shares delivered so far
    }

    // ---- fixed when the list is made (storage, not immutables: see the contract's @dev)
    /// @notice The Launcher the list was made for.
    address public launcher;
    /// @notice The project (its Launcher key) the list was made for.
    bytes32 public key;
    /// @notice The Shares the whole list is owed.
    uint256 public total;
    /// @notice From this time anyone may close the list; open entries then go to the reserve.
    uint256 public longStop;
    /// @notice No delivery before this long after each consent (counsel's lock-up gate); zero: off.
    uint256 public minHoldFromConsent;

    // ---- the agreement text
    /// @notice The fingerprint of the agreement text holders sign now.
    bytes32 public textHash;
    /// @notice The hash of counsel's one-line summary holders sign now.
    bytes32 public summaryHash;
    /// @notice The text's version; grows with each published text.
    uint256 public textVersion;

    // ---- the keeper
    /// @notice Voids consents inside their window, replaces holders after the wait, publishes texts.
    address public keeper;
    /// @notice The keeper role was offered to this address.
    address public pendingKeeper;

    // ---- the project, read from the Launcher once at the launch (`bind`)
    /// @notice The project's Vester, where the grant is.
    IVester public vester;
    /// @notice The project's Shares.
    IShares public shares;
    /// @notice The project's Treasury (the reserve).
    address public treasury;
    address private _rounds;
    address private _finisher;

    // ---- the list
    bytes32[] private _leaves;
    mapping(uint256 => Entry) private _entries;
    /// @notice Shares of all entries agreed to now.
    uint256 public consentedTotal;
    /// @notice Entries agreed to now.
    uint256 public consentedCount;
    /// @notice Shares delivered to receivers, in all.
    uint256 public delivered;
    /// @notice Shares of open entries (and of grant beyond the list) sent to the reserve after the close, in all.
    uint256 public reserveTaken;
    /// @notice The list was closed: no more consents; open entries go to the reserve.
    bool public closed;

    /// @notice The project's contracts were read from the Launcher.
    event Bound(address indexed vester, address indexed treasury);
    /// @notice An entry was agreed to.
    event Consented(
        uint256 indexed entry, address indexed holder, address indexed receiver, uint256 amount, bytes32 textHash
    );
    /// @notice The keeper voided an entry's consent inside its window; the entry is open again.
    event Voided(uint256 indexed entry, address indexed holder, bytes32 evidence);
    /// @notice Released Shares of an entry were sent to its receiver.
    event Delivered(uint256 indexed entry, address indexed receiver, uint256 amount);
    /// @notice The keeper proposed `next` as an open entry's holder; it applies from `from` unless cancelled.
    event HolderProposed(uint256 indexed entry, address indexed next, uint256 from, bytes32 evidence);
    /// @notice An entry's holder was replaced.
    event HolderReplaced(uint256 indexed entry, address indexed next, uint256 holderVersion);
    /// @notice A pending replacement was cancelled (by the holder, the keeper, or the holder's consent).
    event ReplacementCancelled(uint256 indexed entry, address indexed by);
    /// @notice A new agreement text was published.
    event TextPublished(uint256 indexed version, bytes32 textHash, bytes32 summaryHash);
    /// @notice The list was closed after the long-stop date; `open` Shares of the list were not agreed to.
    event ListClosed(uint256 open);
    /// @notice Shares went to the project's reserve (open entries after the close, and strays).
    event SentToReserve(uint256 amount);
    /// @notice The keeper role was offered (`taken` false) or taken (`taken` true).
    event KeeperChanged(address indexed keeper, bool taken);

    /// @notice The list's settings are not usable.
    error BadSetup();
    /// @notice The project's contracts were read already, or the project has not launched.
    error BindState();
    /// @notice The grant does not cover the list yet, or was never read from the Launcher.
    error NotFunded();
    /// @notice No such entry.
    error UnknownEntry();
    /// @notice The entry's details do not match its leaf.
    error NotOnList();
    /// @notice The holder may not be the zero address.
    error BadHolder();
    /// @notice The keeper voided this holder's consent and proposed another holder: it may not agree again meanwhile.
    error Barred();
    /// @notice The entry is agreed to already, or is not.
    error EntryState();
    /// @notice The message's deadline passed.
    error Expired();
    /// @notice The signature does not verify for the holder, or a call with no signature is not from the holder.
    error BadSignature();
    /// @notice The text named is not the one published now.
    error TextMoved();
    /// @notice The receiver is zero, a project contract, or a wallet with no code here that is not the holder.
    error BadReceiver();
    /// @notice Agreeing to this entry would take the list above its total.
    error OverTotal();
    /// @notice Too early: allowed from `from`.
    error TooEarly(uint256 from);
    /// @notice Only the keeper may do this.
    error NotKeeper();
    /// @notice The challenge window is over.
    error WindowOver();
    /// @notice No replacement is pending, or the caller may not cancel it.
    error NoReplacement();
    /// @notice The list is closed, or not.
    error ClosedState();

    /// @param launcher_ The Launcher project zero launches through.
    /// @param key_ Project zero's key (`Launcher.keyOf(founder, projectId)`).
    /// @param leaves_ One leaf per entry, `keccak256(abi.encode(entry, holder, amount, salt))`, entry = its index here.
    /// @param total_ The Shares the whole list is owed (the list's sum; the grant must cover it).
    /// @param textHash_ The agreement text's fingerprint (version 1).
    /// @param summaryHash_ `keccak256` of counsel's one-line summary.
    /// @param longStop_ Counsel's long-stop date, at least 730 days from now.
    /// @param minHoldFromConsent_ The lock-up gate: no delivery before this long after each consent; zero (off) unless
    /// counsel switches it on; at most 730 days.
    /// @param keeper_ The keeper.
    constructor(
        address launcher_,
        bytes32 key_,
        bytes32[] memory leaves_,
        uint256 total_,
        bytes32 textHash_,
        bytes32 summaryHash_,
        uint256 longStop_,
        uint256 minHoldFromConsent_,
        address keeper_
    ) {
        uint256 n = leaves_.length;
        if (keeper_ == address(0)) revert BadSetup();
        if (n == 0 || n > MAX_ENTRIES) revert BadSetup();
        if (launcher_ == address(0)) revert BadSetup();
        if (total_ == 0) revert BadSetup();
        if (longStop_ < block.timestamp + MIN_LONG_STOP) revert BadSetup();
        if (minHoldFromConsent_ > MAX_HOLD) revert BadSetup();
        for (uint256 i; i < n; ++i) {
            _leaves.push(leaves_[i]);
        }
        (launcher, key, total, longStop, minHoldFromConsent) = (launcher_, key_, total_, longStop_, minHoldFromConsent_);
        (textHash, summaryHash, textVersion, keeper) = (textHash_, summaryHash_, 1, keeper_);
        emit TextPublished(1, textHash_, summaryHash_);
        emit KeeperChanged(keeper_, true);
    }

    // ================================================ the launch ======================================================

    /// @notice Read the project's contracts from the Launcher, once, after the launch. The Launcher calls it in the launch
    /// transaction that makes this contract's grant; anyone may call it if that ever did not happen.
    function bind() external {
        if (address(vester) != address(0)) revert BindState();
        ProjectAddresses memory p = ILauncherProjects(launcher).projectByKey(key);
        if (p.shares == address(0)) revert BindState();
        (vester, shares, treasury, _rounds, _finisher) =
            (IVester(p.vester), IShares(p.shares), p.treasury, p.rounds, p.finisher);
        emit Bound(p.vester, p.treasury);
    }

    // ================================================ agreeing ========================================================

    /// @notice Agree to an entry: its SAFT ends and its Shares go to `receiver` as the clock releases them. Anyone may submit
    /// a holder's signature; with an empty `signature` only the holder itself may call. The holder is the one in the leaf, or
    /// the replacement once one applied.
    /// @param entry The entry's index.
    /// @param holder The holder named in the entry's leaf.
    /// @param amount The entry's Shares, as in the leaf.
    /// @param salt The entry's salt, as in the leaf.
    /// @param receiver Where the Shares go: a wallet with code on this chain, or the holder itself.
    /// @param text The text fingerprint the holder read: must be the one published now (binds a call with no signature).
    /// @param validUntil The message's deadline.
    /// @param signature The holder's EIP-712 signature (ECDSA, or whatever its wallet's EIP-1271 accepts); empty for a call
    /// in person.
    function consent(
        uint256 entry,
        address holder,
        uint256 amount,
        bytes32 salt,
        address receiver,
        bytes32 text,
        uint256 validUntil,
        bytes calldata signature
    ) external {
        if (closed) revert ClosedState();
        if (funding() != total) revert NotFunded();
        if (entry >= _leaves.length) revert UnknownEntry();
        if (_leaves[entry] != leafOf(entry, holder, amount, salt)) revert NotOnList();
        Entry storage e = _entries[entry];
        address signer = e.holder == address(0) ? holder : e.holder;
        if (signer == address(0)) revert BadHolder();
        if (e.consentAt != 0) revert EntryState();
        if (signer == e.barred && e.pending != address(0)) revert Barred();
        if (block.timestamp > validUntil) revert Expired();
        if (text != textHash) revert TextMoved();
        _checkReceiver(signer, receiver);
        if (signature.length == 0) {
            if (msg.sender != signer) revert BadSignature();
        } else if (!SignatureChecker.isValidSignatureNowCalldata(
                signer, consentDigest(entry, signer, amount, receiver, validUntil), signature
            )) {
            revert BadSignature();
        }
        uint256 agreed = consentedTotal + amount;
        if (agreed > total) revert OverTotal();
        (consentedTotal, consentedCount) = (agreed, consentedCount + 1);
        if (e.pending != address(0)) {
            (e.pending, e.pendingAt) = (address(0), 0);
            emit ReplacementCancelled(entry, signer);
        }
        (e.consentAt, e.signer, e.receiver, e.amount) = (uint64(block.timestamp), signer, receiver, amount);
        emit Consented(entry, signer, receiver, amount, textHash);
    }

    /// @notice The EIP-712 digest a holder signs for an entry, with the text, summary and holder version of now.
    function consentDigest(uint256 entry, address holder, uint256 amount, address receiver, uint256 validUntil)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                CONSENT_TYPEHASH,
                entry,
                holder,
                amount,
                receiver,
                key,
                textHash,
                textVersion,
                summaryHash,
                _entries[entry].holderVersion,
                validUntil
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice The EIP-712 domain: "Creaton earlier backers", version 1, this chain, this contract.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice An entry's leaf.
    function leafOf(uint256 entry, address holder, uint256 amount, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(entry, holder, amount, salt));
    }

    // ================================================ delivery ========================================================

    /// @notice Send an agreed entry its released Shares, to its receiver only. Anyone may call it, from 21 days after the
    /// consent (and, when counsel's gate is on, `minHoldFromConsent` after it).
    /// @return amount Shares sent.
    function deliver(uint256 entry) public returns (uint256 amount) {
        Entry storage e = _entries[entry];
        uint256 since = e.consentAt;
        if (since == 0) revert EntryState();
        if (block.timestamp < since + CHALLENGE) revert TooEarly(since + CHALLENGE);
        if (block.timestamp < since + minHoldFromConsent) revert TooEarly(since + minHoldFromConsent);
        amount = due(entry);
        if (amount == 0) return 0;
        e.taken += amount;
        delivered += amount;
        vester.claim(address(this));
        _send(e.receiver, amount);
        emit Delivered(entry, e.receiver, amount);
    }

    /// @notice `deliver` for several entries.
    function deliverMany(uint256[] calldata entries) external {
        for (uint256 i; i < entries.length; ++i) {
            deliver(entries[i]);
        }
    }

    /// @notice Shares the clock has released for an agreed entry that it has not received yet (deliverable once its waits
    /// are over): `amount * released / granted - taken`. Zero for an open entry.
    function due(uint256 entry) public view returns (uint256) {
        Entry storage e = _entries[entry];
        if (e.consentAt == 0) return 0;
        (uint256 granted,) = vester.grants(address(this));
        return e.amount * vester.released(address(this)) / granted - e.taken;
    }

    // ================================================ the keeper ======================================================

    /// @notice Void a consent inside its 21-day window, with public evidence (a leaked key, a wrong wallet). The entry goes
    /// back to open with no receiver; the keeper can never name one. The voided holder may not veto a replacement.
    function voidConsent(uint256 entry, bytes32 evidence) external {
        if (msg.sender != keeper) revert NotKeeper();
        Entry storage e = _entries[entry];
        uint256 since = e.consentAt;
        if (since == 0) revert EntryState();
        if (block.timestamp >= since + CHALLENGE) revert WindowOver();
        (consentedTotal, consentedCount) = (consentedTotal - e.amount, consentedCount - 1);
        address was = e.signer;
        e.barred = was;
        (e.consentAt, e.signer, e.receiver, e.amount) = (0, address(0), address(0), 0);
        emit Voided(entry, was, evidence);
    }

    /// @notice Propose `next` as the holder of an open entry (a lost key), with public evidence. It applies after 30 days
    /// unless the holder vetoes it or the holder's consent cancels it.
    function proposeHolder(uint256 entry, address next, bytes32 evidence) external {
        if (msg.sender != keeper) revert NotKeeper();
        if (entry >= _leaves.length) revert UnknownEntry();
        if (next == address(0)) revert BadHolder();
        Entry storage e = _entries[entry];
        if (e.consentAt != 0) revert EntryState();
        (e.pending, e.pendingAt) = (next, uint64(block.timestamp));
        emit HolderProposed(entry, next, block.timestamp + REPLACE_WAIT, evidence);
    }

    /// @notice Cancel a pending replacement: the keeper, or the entry's holder in person (unless the keeper voided that
    /// holder's consent). A holder named only in the leaf proves it with the entry's `amount` and `salt`.
    function cancelHolder(uint256 entry, uint256 amount, bytes32 salt) external {
        Entry storage e = _entries[entry];
        if (e.pending == address(0)) revert NoReplacement();
        if (msg.sender != keeper) {
            address holder = e.holder;
            bool isHolder = holder == address(0)
                ? _leaves[entry] == leafOf(entry, msg.sender, amount, salt)  // a pending replacement implies a real entry
                : msg.sender == holder;
            if (!isHolder || msg.sender == e.barred) revert NoReplacement();
        }
        (e.pending, e.pendingAt) = (address(0), 0);
        emit ReplacementCancelled(entry, msg.sender);
    }

    /// @notice Apply a pending replacement, 30 days after it was proposed (the entry is still open). Anyone may.
    function applyHolder(uint256 entry) external {
        Entry storage e = _entries[entry];
        address next = e.pending;
        if (next == address(0)) revert NoReplacement();
        if (block.timestamp < e.pendingAt + REPLACE_WAIT) revert TooEarly(e.pendingAt + REPLACE_WAIT);
        // the entry is open: a replacement is proposed only for an open entry, and a consent while one is pending either
        // cancels it (the holder) or is refused (the holder the keeper voided)
        uint32 version = e.holderVersion + 1;
        (e.holder, e.holderVersion, e.pending, e.pendingAt, e.barred) = (next, version, address(0), 0, address(0));
        emit HolderReplaced(entry, next, version);
    }

    /// @notice Publish a new agreement text and summary (counsel's non-material fixes, or a new text offered to everyone).
    /// Signatures over an earlier version no longer verify. Only the keeper.
    function publishText(bytes32 textHash_, bytes32 summaryHash_) external {
        if (msg.sender != keeper) revert NotKeeper();
        uint256 version = textVersion + 1;
        (textHash, summaryHash, textVersion) = (textHash_, summaryHash_, version);
        emit TextPublished(version, textHash_, summaryHash_);
    }

    /// @notice Offer the keeper role; the next keeper takes it with `takeKeeper`. Only the keeper.
    function offerKeeper(address next) external {
        if (msg.sender != keeper) revert NotKeeper();
        pendingKeeper = next;
        emit KeeperChanged(next, false);
    }

    /// @notice Take the keeper role that was offered to the caller.
    function takeKeeper() external {
        if (msg.sender != pendingKeeper || msg.sender == address(0)) revert NotKeeper();
        (keeper, pendingKeeper) = (msg.sender, address(0));
        emit KeeperChanged(msg.sender, true);
    }

    // ================================================ the long-stop ===================================================

    /// @notice Close the list at counsel's long-stop date: no more consents. Anyone may.
    function close() external {
        if (block.timestamp < longStop) revert TooEarly(longStop);
        if (closed) revert ClosedState();
        closed = true;
        emit ListClosed(total - consentedTotal);
    }

    /// @notice After the close, send the reserve its part: the released Shares of every open entry (and of any grant beyond
    /// the list), plus Shares sent here by mistake. Anyone may, as often as the clock releases more.
    /// @return sent Shares sent to the project's Treasury.
    function toReserve() external returns (uint256 sent) {
        if (!closed) revert ClosedState();
        vester.claim(address(this));
        (uint256 granted, uint256 claimed) = vester.grants(address(this));
        uint256 part = (granted - consentedTotal) * vester.released(address(this)) / granted;
        reserveTaken = part;
        sent = shares.balanceOf(address(this)) - (claimed - delivered - part);
        if (sent == 0) return 0;
        _send(treasury, sent);
        emit SentToReserve(sent);
    }

    // ================================================ reading =========================================================

    /// @notice Shares the clock has released for the list that have not reached a receiver or the reserve yet (in the Vester
    /// or here). The Treasury leaves them out of the Shares in people's hands, so open entries, the challenge window and the
    /// lock-up gate thin nobody's exit slice.
    function undelivered() external view returns (uint256) {
        if (address(vester) == address(0)) return 0;
        return vester.released(address(this)) - delivered - reserveTaken;
    }

    /// @notice The Shares of this contract's grant in the Vester (zero before the launch). Consents need at least `total`.
    function funding() public view returns (uint256 granted) {
        if (address(vester) == address(0)) return 0;
        (granted,) = vester.grants(address(this));
    }

    /// @notice When the list may be closed.
    function closeAt() external view returns (uint256) {
        return longStop;
    }

    /// @notice How many entries the list has.
    function entryCount() external view returns (uint256) {
        return _leaves.length;
    }

    /// @notice An entry's stored leaf.
    function leaf(uint256 entry) external view returns (bytes32) {
        return _leaves[entry];
    }

    /// @notice An entry's state.
    function entryOf(uint256 entry) external view returns (Entry memory) {
        return _entries[entry];
    }

    // ================================================ plumbing ========================================================

    /// @dev The receiver is a wallet with code on this chain, or the holder itself (so never zero: a holder is never zero);
    /// never a project contract.
    function _checkReceiver(address holder, address receiver) private view {
        if (
            receiver == address(this) || receiver == launcher || receiver == address(shares) || receiver == treasury
                || receiver == address(vester) || receiver == _rounds || receiver == _finisher
        ) revert BadReceiver();
        if (receiver.code.length == 0 && receiver != holder) revert BadReceiver();
    }

    function _send(address to, uint256 amount) private {
        if (!shares.transfer(to, amount)) revert NotFunded();
    }
}
