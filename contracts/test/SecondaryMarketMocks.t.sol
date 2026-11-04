// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Call, Moloch, Shares, Summoner} from "../src/majeur/MolochPatched.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISecondaryPolicy} from "../src/interfaces/ISecondaryPolicy.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";

/// @title Secondary market test seams
/// @dev Each helper here stands in for a piece that arrives later. There is no production policy yet:
/// ActivationVoting and ContributorKitV2 land separately, and the market's crossing with them is
/// validated in that kit journey, not here. `MockSecondaryPolicy` holds what the market must not get
/// away with ignoring: a deposit registers the seller's escrow through the DAO's `ownershipChanged`
/// callback (never by the market's word alone), `prepareEscrowReturn` pins one same-transaction return
/// to the original seller, and `consumeSoldEscrow` consumes the sold seller-age credit.

/// @notice An exact-transfer ERC-20 the tests use as a market's quote token.
contract FixedQuote is ERC20 {
    constructor() ERC20("Fixed quote", "CASH") {}

    /// @dev Minting is a test-only power; the market never mints anything.
    function mint(address owner, uint256 amount) external {
        _mint(owner, amount);
    }
}

/// @notice The same quote that can refuse outbound transfers, so a test can prove a blocked payout
/// stays recorded and collectable later, never stranded.
contract BlockableQuote is FixedQuote {
    error Blocked();

    bool public blocked;

    constructor() FixedQuote() {}

    function setBlocked(bool blocked_) external {
        blocked = blocked_;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (blocked && from != address(0)) revert Blocked();
        super._update(from, to, amount);
    }
}

/// @notice A hostile quote: the next outbound transfer, once armed, re-enters the market with the exact
/// calldata a test hands it, to prove a callback can never re-run or corrupt an order's state changes.
/// The nested call comes from this token's own address, so a test that wants it to act as a seller or a
/// buyer gives the token Shares, quote and approvals first (see `approveMarket`).
contract ReentrantQuote is FixedQuote {
    address public target;
    bytes public payload;
    /// @dev The assertions read these: how often the hook fired, whether the nested call went through,
    /// and the selector it reverted with. The hook disarms itself before calling, so it fires once.
    uint256 public pokes;
    uint256 public refusals;
    bool public lastOk;
    bytes4 public lastRevert;

    constructor() FixedQuote() {}

    /// @dev Arm the next outbound transfer to call `market` with the well-formed `data`.
    function arm(address market, bytes calldata data) external {
        target = market;
        payload = data;
    }

    /// @dev Let `market` pull this token's own balance of both tokens, so it can act as a seller and a buyer.
    function approveMarket(address market, IERC20 shares) external {
        _approve(address(this), market, type(uint256).max);
        shares.approve(market, type(uint256).max);
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (from != address(0) && target != address(0)) {
            address t = target;
            target = address(0);
            pokes += 1;
            (bool ok, bytes memory ret) = t.call(payload);
            lastOk = ok;
            lastRevert = ret.length >= 4 ? bytes4(ret) : bytes4(0);
            if (!ok) refusals += 1;
        }
    }
}

/// @dev A fake mandate factory, because the factory's real one only needs a target to compare the
/// policy against. The production journey later uses the actual mandate factory.
contract DummyMandateFactory {
    function ping() external pure returns (bool) {
        return true;
    }
}

/// @notice The stood-in policy. Its rules mirror what the pinned `ISecondaryPolicy` leaves the market
/// to assume: escrow registered only by the DAO callback, market-only hooks, and buyers that always
/// start fresh with no inherited seller age.
contract MockSecondaryPolicy {
    /// @dev `mandateFactory` has to match the summoner's own for the factory's provenance check.
    address public immutable mandateFactory;
    /// @dev One clone per DAO: each clone holds its own storage (delegatecall at the clone's context).
    Shares public sharesToken;
    address public dao;
    address public market;

    mapping(address => uint256) public escrowedBalance;
    /// @notice The first epoch at which a holder registered, used only by freshness assertions.
    mapping(address => uint64) public heldSince;
    /// @dev `prepareEscrowReturn` records an amount owed before the transfer fires, so the callback can
    /// tell a same-transaction return (age kept) from a fresh purchase (age started).
    mapping(address => uint256) private _pendingReturn;

    event EscrowReturnPrepared(address indexed seller, uint256 amount);
    event SoldEscrowConsumed(address indexed seller, uint256 amount);

    error NotMarket();
    error NotDao();

    constructor(address mandateFactory_) {
        mandateFactory = mandateFactory_;
    }

    /// @dev The same initialize Moloch's birth calls; msg.sender is the DAO itself.
    function initialize(address shares, address[] calldata) external {
        if (msg.sender.code.length == 0) revert NotDao();
        dao = msg.sender;
        sharesToken = Shares(shares);
    }

    /// @dev The provisioning init call names the clone's one market before anything can be sold.
    function setMarket(address m) external {
        if (msg.sender != dao) revert NotDao();
        if (market != address(0)) revert NotDao();
        market = m;
    }

    /// @dev The one ownership hook every Shares and Loot movement fires through the DAO. The DAO gates
    /// its own Shares pointer, so the policy trusts it: a holder's deposit into the market registers
    /// against them (with their original acquisition epoch); a prepared return keeps their age;
    /// anything else from the market is a fresh buyer.
    function ownershipChanged(bool isLoot, address from, address to, uint256 amount) external {
        if (isLoot || msg.sender != dao) revert NotDao();
        if (to == market && from != market) {
            escrowedBalance[from] += amount;
            if (heldSince[from] == 0) heldSince[from] = uint64(block.number);
        } else if (from == market && to != market) {
            uint256 pending = _pendingReturn[to];
            if (pending >= amount) {
                _pendingReturn[to] = pending - amount;
                escrowedBalance[to] -= amount;
                if (escrowedBalance[to] == 0) heldSince[to] = 0;
            } else {
                heldSince[to] = uint64(block.number);
            }
        }
    }

    /// @dev Candidate stand-in: the holder's whole balance is saleable. The real policy derives the
    /// capacity from the acquisition maturity, awards and escrow totals instead.
    function saleCapacity(address holder) external view returns (uint256) {
        return address(sharesToken).code.length == 0 ? 0 : sharesToken.balanceOf(holder);
    }

    function consumeSoldEscrow(address seller, uint256 amount) external {
        if (msg.sender != market) revert NotMarket();
        if (escrowedBalance[seller] < amount) revert NotMarket();
        escrowedBalance[seller] -= amount;
        if (escrowedBalance[seller] == 0) heldSince[seller] = 0;
        emit SoldEscrowConsumed(seller, amount);
    }

    function prepareEscrowReturn(address seller, uint256 amount) external {
        if (msg.sender != market) revert NotMarket();
        if (escrowedBalance[seller] < amount) revert NotMarket();
        _pendingReturn[seller] += amount;
        emit EscrowReturnPrepared(seller, amount);
    }
}

/// @dev Deploys the kit exactly where the deployer predicted it: the spawner's first CREATE lands at
/// computeCreateAddress(spawner, 0), which the deployer computed BEFORE deploying the factory.
contract KitSpawner {
    function spawn(Summoner summoner, SecondaryMarketFactory predeployed_) external returns (TestListingKit kit) {
        return new TestListingKit(summoner, predeployed_);
    }
}

/// @notice The kit-shaped stand-in: it accepts the pre-deployed factory and verifies its kit slot the
/// way the real kit will — authorized to this kit, pinned to the same summoner — and is otherwise the
/// one `authorizedKit` around which every launch in these tests runs.
contract TestListingKit {
    SecondaryMarketFactory public immutable factory;

    error NotAuthorizedKit();

    constructor(Summoner summoner, SecondaryMarketFactory predeployed_) {
        if (predeployed_.authorizedKit() != address(this)) revert NotAuthorizedKit();
        if (predeployed_.summoner() != summoner) revert NotAuthorizedKit();
        if (predeployed_.molochImplementation() != summoner.getImplementation()) revert NotAuthorizedKit();
        factory = predeployed_;
    }

    /// @dev The kit's own market creation, after the birth transaction installed the exemptions.
    function createMarket(address dao, address sharesToken, address policy, IERC20 quote, uint256 lotSize)
        external
        returns (SecondaryMarket market)
    {
        market = factory.create(dao, sharesToken, ISecondaryPolicy(policy), quote, lotSize);
    }
}

abstract contract SecondaryMarketFixture is Test {
    uint256 internal constant LOT_SIZE = 1e18;
    uint128 internal constant MIN_PRICE = 1_600; // one lot's floor, in quote base units
    uint128 internal constant MAX_PRICE = 5_600;
    uint32 internal constant LEVELS = 8;
    uint64 internal constant BIDDING = 3 days;
    uint64 internal constant SETTLE_WINDOW = 2 days;
    uint64 internal constant WEEK = 7 days;

    /// @dev One whole launch: the Summoner's real clone pieces and the market the kit made for it.
    struct Launch {
        Moloch dao;
        Shares shares;
        MockSecondaryPolicy policy;
        FixedQuote quote;
        SecondaryMarket market;
    }

    TestListingKit internal kit;
    DummyMandateFactory internal mf;
    MockSecondaryPolicy internal policyImpl;
    // One summoner, one kit, one pinned policy implementation per test: every launch below shares
    // them, exactly like one environment's real kit does. The factory is the pre-deployed, one
    // per-environment deployment whose explicit authorizedKit is the kit's predicted address.
    Summoner internal summoner;
    SecondaryMarketFactory internal factory;
    address internal _kitAddress;

    /// @dev A launch with `holders` starting with the given Shares, locked at birth to move only
    /// through the predicted market, up but unlisted until the DAO decides otherwise.
    function _launch(address[] memory holders, uint256[] memory amounts) internal returns (Launch memory l) {
        return _launchWithQuote(holders, amounts, new FixedQuote(), true);
    }

    /// @dev Same, with a hostile or blocking quote token and optionally without registering the market,
    /// so counterfeited creations and adversarial tokens get their own honest DAO each time.
    function _launchWithQuote(address[] memory holders, uint256[] memory amounts, ERC20 quoteIn, bool kitCreates)
        internal
        returns (Launch memory l)
    {
        if (address(summoner) == address(0)) {
            vm.warp(1 days);
            mf = new DummyMandateFactory();
            policyImpl = new MockSecondaryPolicy(address(mf));
            summoner = new Summoner(address(policyImpl));
            // The deployer predicts the kit's future address first, exactly like the real two-
            // infrastructure flow: the EIP-3860-small factory takes the kit's predicted address as
            // its explicit authorizedKit, and the kit then lands there and checks its own slot. A
            // freshly created spawner's next CREATE address is at its EIP-161 contract nonce (1).
            KitSpawner kitSpawner = new KitSpawner();
            _kitAddress = vm.computeCreateAddress(address(kitSpawner), vm.getNonce(address(kitSpawner)));
            factory = new SecondaryMarketFactory(summoner, _kitAddress);
            kit = TestListingKit(kitSpawner.spawn(summoner, factory));
        }
        l.quote = FixedQuote(address(quoteIn));

        (address daoAddr, address sharesAddr, address policyAddr) = _predict(summoner, holders, amounts);
        address marketAddr = kit.factory().predict(daoAddr, sharesAddr, policyAddr, address(l.quote), LOT_SIZE);

        Call[] memory setup = new Call[](2);
        setup[0] = Call(sharesAddr, 0, abi.encodeCall(Shares.lockTransfersWithNotice, (marketAddr)));
        setup[1] = Call(policyAddr, 0, abi.encodeCall(MockSecondaryPolicy.setMarket, (marketAddr)));

        l.dao = summoner.summon("ORG", "ORG", "", 5000, true, address(0), bytes32(uint256(7)), holders, amounts, setup);
        vm.roll(block.number + 1);

        l.shares = l.dao.shares();
        l.policy = MockSecondaryPolicy(l.dao.votingWeight());
        assertEq(address(l.dao), daoAddr, "the DAO came out where it was predicted");
        assertEq(address(l.shares), sharesAddr, "the Shares clone where it was predicted");
        assertEq(address(l.policy), policyAddr, "the policy clone where it was predicted");

        if (!kitCreates) {
            // Leave the market uncreated: counterfeited creations get their own honest DAO each time.
            assertEq(l.shares.transferExempt(), marketAddr, "the exemption still points at the predicted market");
            return l;
        }

        l.market = kit.createMarket(address(l.dao), address(l.shares), address(l.policy), l.quote, LOT_SIZE);
        assertEq(address(l.market), marketAddr, "CREATE2 landed at the kit's predicted market");
        assertEq(l.shares.DAO(), address(l.dao), "the Shares belong to the DAO");
        assertEq(l.shares.transferExempt(), address(l.market), "the market holds the Shares' birth exemption");
        assertTrue(
            SecondaryMarketFactory(address(kit.factory())).marketOf(address(l.dao)) == address(l.market),
            "the factory's registry maps this DAO to this market"
        );
        (bool listed,,,) = l.market.listing();
        assertFalse(listed, "nothing is listed before the DAO decides");
    }

    function _predict(Summoner summoner, address[] memory holders, uint256[] memory amounts)
        internal
        view
        returns (address daoAddr, address sharesAddr, address policyAddr)
    {
        return _predictWithSalt(summoner, holders, amounts, bytes32(uint256(7)));
    }

    function _predictWithSalt(Summoner summoner, address[] memory holders, uint256[] memory amounts, bytes32 userSalt)
        internal
        view
        returns (address daoAddr, address sharesAddr, address policyAddr)
    {
        // The Shares implementation the Moloch implementation clones at its own birth (SAME formula
        // as ContributorKit reads back).
        address molochImpl = summoner.getImplementation();
        address sharesImpl = _create2(molochImpl, bytes32(bytes20(molochImpl)), keccak256(type(Shares).creationCode));
        bytes32 salt = keccak256(abi.encode(holders, amounts, userSalt));
        bytes memory molochProxy = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", bytes20(molochImpl), hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        daoAddr = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(summoner), salt, keccak256(molochProxy)))))
        );
        sharesAddr = _cloneAt(daoAddr, sharesImpl);
        policyAddr = _cloneAt(daoAddr, address(policyImpl));
    }

    function _create2(address deployer, bytes32 salt, bytes32 initcodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initcodeHash)))));
    }

    function _cloneAt(address deployer, address implementation) internal view returns (address) {
        bytes memory proxy = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", bytes20(implementation), hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), deployer, bytes32(bytes20(deployer)), keccak256(proxy)))
                )
            )
        );
    }

    /// @dev The DAO's listing decision: fixed per-lot bounds and a fully divisible grid. Levels at
    /// 1600, 2100, 2600, 3100, 3600, 4100, 4600 and the 5600 cap.
    function _enableListing(Launch memory l) internal {
        vm.prank(address(l.dao));
        l.market.configureListing(true, MIN_PRICE, MAX_PRICE, LEVELS);
    }

    /// @dev Everyone approves the market for both sides; amounts stay generous.
    function _approve(Launch memory l, address who) internal {
        vm.startPrank(who);
        l.shares.approve(address(l.market), type(uint256).max);
        l.quote.approve(address(l.market), type(uint256).max);
        vm.stopPrank();
    }

    function _enable(Launch memory l) internal {
        _enableListing(l);
        l.market.openRound();
    }

    /// @dev Open the round and return its id, as any caller may.
    function _openRoundWith(Launch memory l) internal returns (uint256 id) {
        _enableListing(l);
        id = l.market.openRound();
    }

    /// @dev Move inside the settle window, where `settle` runs.
    function _toSettle(Launch memory l, uint256 id) internal {
        (,,,, uint64 closesAt,,,,,,) = l.market.rounds(id);
        vm.warp(closesAt);
    }

    /// @dev Move past the settle window, where the round is void and claims pay everything back.
    function _toVoid(Launch memory l, uint256 id) internal {
        (,,,,, uint64 deadline,,,,,) = l.market.rounds(id);
        vm.warp(deadline);
    }
}
