// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SecondaryMarketFixture} from "./SecondaryMarketMocks.t.sol";
import {DummyMandateFactory, FixedQuote, MockSecondaryPolicy, TestListingKit} from "./SecondaryMarketMocks.t.sol";
import {ISecondaryPolicy} from "../src/interfaces/ISecondaryPolicy.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {Call, Moloch, Shares, Summoner, Unauthorized} from "../src/majeur/MolochPatched.sol";
import {ContributorKitV2Base} from "./ContributorKitV2.t.sol";

/// @title Secondary market provenance and the D179 counterfeit regressions
/// @notice Nothing may list without the pinned summoner's real bytecode, real clone identity, real
/// policy and real shared mandate factory, and only the kit that created the factory may list at all.
/// These are the regressions the audit's first two findings live or die on: a fake DAO or counterfeit
/// terms can reach no one else's escrow, and there is exactly one market per DAO.

/// @dev A deployer stand-in: any non-kit caller someone might impersonate as the market's maker.
contract RogueDeployer {
    function deploy(
        SecondaryMarketFactory f,
        address dao,
        address token,
        ISecondaryPolicy policy,
        ERC20 quote,
        uint256 lotSize
    ) external returns (address) {
        return address(f.create(dao, token, policy, quote, lotSize));
    }
}

/// @dev A mintable ERC-20 with no other power: the counterfeit quote.
contract DustQuote is ERC20 {
    constructor() ERC20("Dust", "DST") {}

    function mint(address who, uint256 amount) external {
        _mint(who, amount);
    }
}

/// @dev A policy stand-in whose three answers the test chooses: the one thing a counterfeit DAO would
/// hand the factory in place of the real policy clone.
contract StubPolicy {
    address public dao;
    address public market;
    address public mandateFactory;

    function set(address dao_, address market_, address mandateFactory_) external {
        dao = dao_;
        market = market_;
        mandateFactory = mandateFactory_;
    }
}

/// @dev A Shares stand-in answering only the two reads a market constructor makes.
contract StubShares {
    address public DAO;
    address public transferExempt;

    function set(address dao_, address exempt_) external {
        DAO = dao_;
        transferExempt = exempt_;
    }
}

/// @dev A counterfeit DAO WITH code: it deploys its own Shares clone of the REAL Shares implementation at
/// exactly the CREATE2 address a real DAO would use (its own address as salt), becomes that token's DAO,
/// installs the exemption, and answers `shares()` and `votingWeight()` consistently. Every getter the
/// factory reads is therefore consistent; only the DAO's runtime bytecode betrays it.
contract FakeDao {
    address public shares;
    address public votingWeight;

    function deployShares(address sharesImplementation) external returns (address s) {
        bytes memory initcode = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", sharesImplementation, hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        bytes32 salt = bytes32(bytes20(address(this)));
        assembly ("memory-safe") {
            s := create2(0, add(initcode, 0x20), mload(initcode), salt)
        }
        require(s != address(0), "clone failed");
        Shares(s).init(new address[](0), new uint256[](0));
        shares = s;
    }

    function finish(address exempt, address policy) external {
        Shares(shares).lockTransfersWithNotice(exempt);
        votingWeight = policy;
    }
}

/// @dev The attacker's uninitialised proxy: a byte-for-byte copy of the pinned summoner's DAO proxy
/// runtime, deployed by anyone with a plain CREATE, never initialised.
library RawProxy {
    function deploy(address implementation) internal returns (address proxy) {
        bytes memory initcode = abi.encodePacked(
            hex"602d5f8160095f39f35f5f365f5f37365f73", implementation, hex"5af43d5f5f3e6029573d5ffd5b3d5ff3"
        );
        assembly ("memory-safe") {
            proxy := create(0, add(initcode, 0x20), mload(initcode))
        }
        require(proxy != address(0), "proxy failed");
    }
}

contract SecondaryMarketProvenance is SecondaryMarketFixture {
    SecondaryMarketFactory internal f;
    address internal constant S1 = address(0x5E1101);
    address internal constant S2 = address(0x5E1102);
    address internal constant B1 = address(0xB11);
    address internal constant STANDIN = address(0x518D1);

    Launch internal l;

    function setUp() public {
        address[] memory holders = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        holders[0] = S1;
        holders[1] = S2;
        holders[2] = B1;
        amounts[0] = 40e18;
        amounts[1] = 30e18;
        amounts[2] = 0;
        l = _launch(holders, amounts);
        _approve(l, S1);
        _approve(l, S2);
        _approve(l, B1);
        l.quote.mint(B1, 1_000_000e6);
        f = SecondaryMarketFactory(address(kit.factory()));
    }

    function test_create_registers_instead_of_a_second_market_for_the_same_dao() public {
        vm.prank(STANDIN);
        vm.expectRevert(abi.encodeWithSelector(SecondaryMarketFactory.AlreadyListed.selector, address(l.dao)));
        kit.createMarket(address(l.dao), address(l.shares), address(l.policy), l.quote, LOT_SIZE);
        assertEq(f.marketOf(address(l.dao)), address(l.market), "the one market per DAO stays the first one");
    }

    function test_only_the_kit_that_created_the_factory_may_create() public {
        RogueDeployer rogue = new RogueDeployer();
        vm.prank(address(rogue));
        vm.expectRevert(SecondaryMarketFactory.NotAuthorizedKit.selector);
        rogue.deploy(f, address(l.dao), address(l.shares), ISecondaryPolicy(address(l.policy)), l.quote, LOT_SIZE);
        // Nothing the rogue pushed lands in the registry: the honest market stays the DAO's one.
        assertEq(f.marketOf(address(l.dao)), address(l.market));
    }

    function test_a_counterfeit_dao_is_refused_at_the_bytecode_pin() public {
        RogueDeployer rogue = new RogueDeployer();
        // Refused for any caller but the kit...
        vm.startPrank(address(rogue));
        vm.expectRevert(SecondaryMarketFactory.NotAuthorizedKit.selector);
        rogue.deploy(f, address(0x9001), address(l.shares), ISecondaryPolicy(address(l.policy)), l.quote, LOT_SIZE);
        vm.stopPrank();
        // ...and through the authorized kit, an address whose code is not the pinned proxy runtime
        // is dead on arrival: UnprovenDao.
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenDao.selector);
        f.create(address(0x9001), address(l.shares), ISecondaryPolicy(address(l.policy)), l.quote, LOT_SIZE);
    }

    function test_a_counterfeit_token_and_policy_are_refused() public {
        Launch memory second = _launchNewDao();
        // The second DAO's own listing is honest on its own: prove that first.
        assertEq(f.marketOf(address(second.dao)), address(second.market));
        // Now try to pass another DAO's Shares as the first DAO's token: the Moloch clone names its own
        // Shares, so a mixed binding reverts before anything deploys.
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenShares.selector);
        f.create(
            address(second.dao), address(l.shares), ISecondaryPolicy(address(second.policy)), second.quote, LOT_SIZE
        );
        // A policy that never records either DAO is refused on its own dao()-pin.
        DustQuote dust = new DustQuote();
        MockSecondaryPolicy foreign = new MockSecondaryPolicy(address(new DummyMandateFactory()));
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenPolicy.selector);
        f.create(address(second.dao), address(second.shares), ISecondaryPolicy(address(foreign)), dust, LOT_SIZE);
        // Quote with no code is no market's quote: a call can only offer code-less junk.
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenQuote.selector);
        f.create(
            address(second.dao),
            address(second.shares),
            ISecondaryPolicy(address(second.policy)),
            ERC20(address(uint160(0x9991))),
            LOT_SIZE
        );
    }

    function test_a_wrong_lot_size_is_refused() public {
        Launch memory second = _launchNewDao();
        // A zero lot size is bounded on the factory before any pin, and the market's own constructor
        // enforces the cap as well; nothing deploys either way.
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.InvalidSetup.selector);
        f.create(address(second.dao), address(second.shares), ISecondaryPolicy(address(second.policy)), second.quote, 0);
    }

    function test_a_dao_whose_birth_exemption_points_wrong_cannot_list() public {
        // A second DAO, but with a mis-installed exemption at birth (lockTransfers to zero): its market
        // prediction would still be correct, yet the market constructor refuses a token whose
        // transferExempt is not itself.
        (Launch memory unlisted, address marketAddr) = _launchUnlisted();
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarket.InvalidSetup.selector);
        f.create(
            address(unlisted.dao),
            address(unlisted.shares),
            ISecondaryPolicy(address(unlisted.policy)),
            unlisted.quote,
            LOT_SIZE
        );
        assertEq(f.marketOf(address(unlisted.dao)), address(0));
        assertEq(unlisted.shares.transferExempt() == marketAddr, false);
    }

    // ---- single-fault pins on every factory guard ---------------------------------------------------------------
    //
    // Several guards share one error selector, so each case below is built from an otherwise honest DAO
    // born through the real summoner, then breaks exactly ONE fact. `test_the_single_fault_fixture_is_honest`
    // proves the same birth lists when nothing is broken, so a revert here can only come from the fault.

    address internal constant ATTACKER = address(0xA77AC4);

    /// @dev An honest unlisted DAO through the real summoner, with the policy's one market optionally
    /// named wrong at birth. The Shares' birth exemption always names the honest predicted market.
    function _born(uint256 n, FixedQuote q, address policyMarketOverride)
        internal
        returns (Launch memory born, address market)
    {
        address[] memory holders = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        holders[0] = address(uint160(0x9E0000 + n));
        holders[1] = address(uint160(0x9F0000 + n));
        amounts[0] = 40e18;
        amounts[1] = 30e18;
        bytes32 salt = bytes32(uint256(100 + n));
        (address daoAddr, address sharesAddr, address policyAddr) = _predictWithSalt(summoner, holders, amounts, salt);
        market = f.predict(daoAddr, sharesAddr, policyAddr, address(q), LOT_SIZE);
        Call[] memory setup = new Call[](2);
        setup[0] = Call(sharesAddr, 0, abi.encodeCall(Shares.lockTransfersWithNotice, (market)));
        setup[1] = Call(
            policyAddr,
            0,
            abi.encodeCall(
                MockSecondaryPolicy.setMarket, (policyMarketOverride == address(0) ? market : policyMarketOverride)
            )
        );
        born.dao = summoner.summon("ORG3", "OG3", "", 5000, true, address(0), salt, holders, amounts, setup);
        vm.roll(block.number + 1);
        born.shares = born.dao.shares();
        born.policy = MockSecondaryPolicy(born.dao.votingWeight());
        born.quote = q;
        assertEq(address(born.dao), daoAddr, "the DAO came out where it was predicted");
        assertEq(address(born.shares), sharesAddr, "the Shares clone where it was predicted");
        assertEq(address(born.policy), policyAddr, "the policy clone where it was predicted");
    }

    function _kitCreates(Launch memory b, uint256 lot) internal returns (SecondaryMarket) {
        vm.prank(address(kit));
        return f.create(address(b.dao), address(b.shares), ISecondaryPolicy(address(b.policy)), b.quote, lot);
    }

    function test_the_single_fault_fixture_is_honest() public {
        (Launch memory b, address market) = _born(1, new FixedQuote(), address(0));
        SecondaryMarket made = _kitCreates(b, LOT_SIZE);
        assertEq(address(made), market, "the honest birth lists at its predicted market");
        assertEq(f.marketOf(address(b.dao)), market);
    }

    /// @dev `Moloch.shares()` must name the token the caller passes (line: shares() != sharesToken).
    function test_guard_the_dao_must_name_the_token_it_is_listed_with() public {
        (Launch memory b,) = _born(2, new FixedQuote(), address(0));
        vm.mockCall(address(b.dao), abi.encodeWithSignature("shares()"), abi.encode(address(0xDEAD)));
        vm.expectRevert(SecondaryMarketFactory.UnprovenShares.selector);
        _kitCreates(b, LOT_SIZE);
    }

    /// @dev The DAO's own `votingWeight()` must be the policy the caller passes. The foreign policy
    /// agrees with the DAO, the predicted market and the mandate factory, so only this pin can refuse it.
    function test_guard_the_dao_must_name_the_policy_it_is_listed_with() public {
        (Launch memory b,) = _born(3, new FixedQuote(), address(0));
        StubPolicy foreign = new StubPolicy();
        address market = f.predict(address(b.dao), address(b.shares), address(foreign), address(b.quote), LOT_SIZE);
        foreign.set(address(b.dao), market, summoner.mandateFactory());
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenPolicy.selector);
        f.create(address(b.dao), address(b.shares), ISecondaryPolicy(address(foreign)), b.quote, LOT_SIZE);
    }

    /// @dev The token must be exactly the Shares clone the DAO deploys itself. The DAO's `shares()` is
    /// made to agree with a counterfeit token that agrees with everything else, so the CREATE2
    /// prediction is the only guard that can refuse it.
    function test_guard_the_token_must_be_the_predicted_shares_clone() public {
        (Launch memory b,) = _born(4, new FixedQuote(), address(0));
        StubShares fake = new StubShares();
        address market = f.predict(address(b.dao), address(fake), address(b.policy), address(b.quote), LOT_SIZE);
        fake.set(address(b.dao), market);
        vm.mockCall(address(b.dao), abi.encodeWithSignature("shares()"), abi.encode(address(fake)));
        vm.mockCall(address(b.policy), abi.encodeWithSignature("market()"), abi.encode(market));
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenShares.selector);
        f.create(address(b.dao), address(fake), ISecondaryPolicy(address(b.policy)), b.quote, LOT_SIZE);
    }

    /// @dev The token's own `DAO()` must be the listed DAO.
    function test_guard_the_token_must_belong_to_the_dao() public {
        (Launch memory b,) = _born(5, new FixedQuote(), address(0));
        vm.mockCall(address(b.shares), abi.encodeWithSignature("DAO()"), abi.encode(address(0xDA0)));
        vm.expectRevert(SecondaryMarketFactory.UnprovenShares.selector);
        _kitCreates(b, LOT_SIZE);
    }

    /// @dev The policy's `dao()` must be the listed DAO.
    function test_guard_the_policy_must_belong_to_the_dao() public {
        (Launch memory b,) = _born(6, new FixedQuote(), address(0));
        Launch memory other = _launchNewDao();
        vm.mockCall(address(b.policy), abi.encodeWithSignature("dao()"), abi.encode(address(other.dao)));
        vm.expectRevert(SecondaryMarketFactory.UnprovenPolicy.selector);
        _kitCreates(b, LOT_SIZE);
    }

    /// @dev The policy's one market, set at birth, must be the market these exact bindings predict.
    function test_guard_the_policy_must_name_the_predicted_market() public {
        // The birth named a different market than the bindings predict.
        (Launch memory wrong,) = _born(7, new FixedQuote(), address(0xBAD));
        vm.expectRevert(SecondaryMarketFactory.UnprovenPolicy.selector);
        _kitCreates(wrong, LOT_SIZE);
        // The birth was honest, but the caller asks for a different lot size than it was predicted for.
        (Launch memory honest,) = _born(8, new FixedQuote(), address(0));
        vm.expectRevert(SecondaryMarketFactory.UnprovenPolicy.selector);
        _kitCreates(honest, 2 * LOT_SIZE);
        // Or for a different (real) quote than it was predicted for.
        FixedQuote otherQuote = new FixedQuote();
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenPolicy.selector);
        f.create(
            address(honest.dao), address(honest.shares), ISecondaryPolicy(address(honest.policy)), otherQuote, LOT_SIZE
        );
        assertEq(f.marketOf(address(honest.dao)), address(0), "nothing listed by any refused attempt");
    }

    /// @dev The policy must come from the pinned summoner's own mandate factory. A DAO of the pinned
    /// summoner always gets a clone of the one policy implementation, so an honest birth cannot differ
    /// here; the fault is injected on the single read.
    function test_guard_the_policy_must_come_from_the_pinned_mandate_factory() public {
        (Launch memory b,) = _born(9, new FixedQuote(), address(0));
        vm.mockCall(address(b.policy), abi.encodeWithSignature("mandateFactory()"), abi.encode(address(0xF00D)));
        vm.expectRevert(SecondaryMarketFactory.UnprovenPolicy.selector);
        _kitCreates(b, LOT_SIZE);
    }

    // ---- the direct-constructor attack ------------------------------------------------------------------------

    /// @dev Anyone may try `new SecondaryMarket(realDao, realShares, realPolicy, ...)` without the
    /// factory: the Shares' one exemption names the factory's market and the policy names the same one,
    /// so the lookalike can never hold the exemption, and an account with no code cannot even be a maker.
    function test_a_direct_constructor_by_an_attacker_is_refused() public {
        vm.expectRevert(SecondaryMarket.InvalidSetup.selector);
        new SecondaryMarket(address(l.dao), address(l.shares), ISecondaryPolicy(address(l.policy)), l.quote, LOT_SIZE);
        vm.prank(ATTACKER);
        vm.expectRevert(SecondaryMarket.InvalidSetup.selector);
        new SecondaryMarket(address(l.dao), address(l.shares), ISecondaryPolicy(address(l.policy)), l.quote, LOT_SIZE);
        assertEq(f.marketOf(address(l.dao)), address(l.market), "the one market stays the factory's");
    }

    /// @dev A direct `new SecondaryMarket(...)` whose every fact is made consistent with the address it
    /// will land on (fresh stubs and a fresh CREATE address each time, since a refused creation still
    /// spends a nonce), so a case that breaks exactly one fact can only be refused by that fact's check.
    /// `sender == address(0)` means this test contract deploys; otherwise that code-less account does.
    function _direct(address daoArg, address tokenArg, address quoteArg, uint256 lot, address sender, bool expectFail)
        internal
        returns (address made, address self)
    {
        StubShares s = new StubShares();
        StubPolicy p = new StubPolicy();
        address from = sender == address(0) ? address(this) : sender;
        self = vm.computeCreateAddress(from, vm.getNonce(from));
        s.set(daoArg, self);
        p.set(daoArg, self, address(0));
        address token = tokenArg == address(0) ? address(s) : tokenArg;
        if (expectFail) vm.expectRevert(SecondaryMarket.InvalidSetup.selector);
        if (sender != address(0)) vm.prank(sender);
        made = address(new SecondaryMarket(daoArg, token, ISecondaryPolicy(address(p)), ERC20(quoteArg), lot));
    }

    function test_constructor_control_all_facts_consistent() public {
        (address made, address self) =
            _direct(address(l.dao), address(0), address(l.quote), LOT_SIZE, address(0), false);
        assertEq(made, self, "the consistent stubs do construct: only one fact breaks each case below");
    }

    function test_constructor_refuses_an_account_without_code_as_maker() public {
        _direct(address(l.dao), address(0), address(l.quote), LOT_SIZE, ATTACKER, true);
    }

    function test_constructor_refuses_a_code_less_dao() public {
        _direct(address(0x9001), address(0), address(l.quote), LOT_SIZE, address(0), true);
    }

    function test_constructor_refuses_a_code_less_token() public {
        _direct(address(l.dao), address(0x9002), address(l.quote), LOT_SIZE, address(0), true);
    }

    function test_constructor_refuses_a_code_less_quote() public {
        _direct(address(l.dao), address(0), address(0x9003), LOT_SIZE, address(0), true);
    }

    function test_constructor_refuses_a_zero_lot_size() public {
        _direct(address(l.dao), address(0), address(l.quote), 0, address(0), true);
    }

    function _brokenFact(uint256 which) internal {
        StubShares s = new StubShares();
        StubPolicy p = new StubPolicy();
        address dao = address(l.dao);
        address self = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        s.set(which == 1 ? address(0xDA0) : dao, which == 2 ? address(0xE0E) : self);
        p.set(which == 3 ? address(0xDA0) : dao, which == 4 ? address(0xBAD) : self, address(0));
        vm.expectRevert(SecondaryMarket.InvalidSetup.selector);
        new SecondaryMarket(dao, address(s), ISecondaryPolicy(address(p)), l.quote, LOT_SIZE);
    }

    function test_constructor_refuses_a_token_that_belongs_to_another_dao() public {
        _brokenFact(1);
    }

    function test_constructor_refuses_a_token_whose_exemption_is_not_itself() public {
        _brokenFact(2);
    }

    function test_constructor_refuses_a_policy_that_belongs_to_another_dao() public {
        _brokenFact(3);
    }

    function test_constructor_refuses_a_policy_that_names_another_market() public {
        _brokenFact(4);
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    /// @dev A second honest DAO under the same summoner, born right but left uncreated, so counterfeited
    /// creations can be probed against its bindings.
    function test_two_markets_stay_isolated_and_never_pay_each_others_orders() public {
        uint256 id = _openRoundWith(l);
        vm.prank(S1);
        l.market.sell(id, 10, 0);
        Launch memory second = _launchNewDao();
        (address daoAddr,,) = (address(second.dao), address(0), address(0));
        // The honest second DAO still creates its own market through the same kit.
        SecondaryMarket secondMarket = kit.createMarket(
            address(second.dao), address(second.shares), address(second.policy), second.quote, LOT_SIZE
        );
        second.market = secondMarket;
        _enableListing(second);
        // Let market two live a full empty round while market one's escrow sits untouched.
        (bool listed2,,,) = secondMarket.listing();
        assertTrue(listed2);
        uint256 secondId = secondMarket.openRound();
        // Market two's ledger is empty: it holds nothing of market one's, and its users claim only
        // from it.
        assertEq(secondMarket.sharesIn(secondId), 0);
        assertEq(secondMarket.quoteIn(secondId), 0);
        vm.prank(STANDIN);
        vm.expectRevert(SecondaryMarket.NothingToClaim.selector);
        secondMarket.claimShares(secondId, S1);
        (,,,, uint64 closesTwo,,,,,,) = secondMarket.rounds(secondId);
        vm.warp(closesTwo);
        secondMarket.settle(secondId);
        // Market one still holds exactly its own escrow after market two's whole round lived and died.
        assertEq(l.market.sharesIn(id), uint256(10) * LOT_SIZE);
        assertEq(l.shares.balanceOf(address(l.market)), uint256(10) * LOT_SIZE);
        assertEq(l.shares.balanceOf(address(secondMarket)), 0);
        assertEq(l.quote.balanceOf(address(secondMarket)), 0);
        daoAddr = address(second.dao);
    }

    function _launchNewDao() internal returns (Launch memory out) {
        address[] memory holders = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        holders[0] = address(0x7E1101);
        holders[1] = address(0x7E1102);
        holders[2] = address(0xB77);
        amounts[0] = 40e18;
        amounts[1] = 30e18;
        amounts[2] = 0;
        out = _launchWithQuote(holders, amounts, new FixedQuote(), false);
        assertEq(address(out.market), address(0), "left for the probes to create");
    }

    /// @dev A second DAO under the same summoner, whose Shares were locked to a WRONG exemption at
    /// birth, and no market: the factory sees the pinned bytecode and the right clones; only the
    /// exemption lies, and that is what the creation must refuse.
    function _launchUnlisted() internal returns (Launch memory born, address marketAddr) {
        FixedQuote q = new FixedQuote();
        address[] memory holders = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        holders[0] = address(0x8E1101);
        holders[1] = address(0x8E1102);
        amounts[0] = 40e18;
        amounts[1] = 30e18;
        (address daoAddr, address sharesAddr, address policyAddr) =
            _predictWithSalt(summoner, holders, amounts, bytes32(uint256(9)));
        marketAddr = f.predict(daoAddr, sharesAddr, policyAddr, address(q), LOT_SIZE);
        // Same birth as the real kit's, but the exemption points at nothing.
        Call[] memory setup = new Call[](2);
        setup[0] = Call(sharesAddr, 0, abi.encodeCall(Shares.lockTransfersWithNotice, (address(0))));
        setup[1] = Call(policyAddr, 0, abi.encodeCall(MockSecondaryPolicy.setMarket, (marketAddr)));
        born.dao =
            summoner.summon("ORG2", "OG2", "", 5000, true, address(0), bytes32(uint256(9)), holders, amounts, setup);
        vm.roll(block.number + 1);
        born.shares = born.dao.shares();
        born.policy = MockSecondaryPolicy(born.dao.votingWeight());
        born.quote = q;
        born.market = SecondaryMarket(address(0));
    }
}

/// @title The DAO bytecode pin, proved against the real ContributorKitV2
/// @notice The pin is what makes every other getter trustworthy, so it is exercised with the real kit as
/// the authorised caller (the only caller `create` accepts) and counterfeit DAOs that agree with the
/// factory on every other getter: only the runtime-bytecode hash can refuse them.
contract SecondaryMarketDaoPin is ContributorKitV2Base {
    function _fakeBindings(FakeDao fake) internal returns (address shares, StubPolicy policy, address market) {
        shares = fake.deployShares(marketFactory.sharesImplementation());
        policy = new StubPolicy();
        market = marketFactory.predict(address(fake), shares, address(policy), address(quote), LOT_SIZE);
        policy.set(address(fake), market, summoner.mandateFactory());
        fake.finish(market, address(policy));
    }

    function test_a_counterfeit_dao_with_code_and_consistent_getters_is_refused() public {
        FakeDao fake = new FakeDao();
        (address shares, StubPolicy policy, address market) = _fakeBindings(fake);
        // Every getter the factory reads agrees: the only difference is the DAO's runtime bytecode.
        assertEq(fake.shares(), shares);
        assertEq(fake.votingWeight(), address(policy));
        assertEq(Shares(shares).DAO(), address(fake));
        assertEq(Shares(shares).transferExempt(), market);
        assertEq(policy.market(), market);
        assertTrue(address(fake).code.length != 0, "the fake has code, so a code-length check would pass it");
        assertTrue(address(fake).codehash != marketFactory.daoRuntimeHash());
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenDao.selector);
        marketFactory.create(address(fake), shares, ISecondaryPolicy(address(policy)), IERC20(address(quote)), LOT_SIZE);
        assertEq(marketFactory.marketOf(address(fake)), address(0));
    }

    function test_a_dao_of_another_summoner_is_refused() public {
        // A second summoner's DAO: its proxy points at that summoner's own Moloch implementation.
        Summoner other = new Summoner(summoner.policyImplementation());
        assertTrue(other.getImplementation() != summoner.getImplementation());
        address[] memory holders = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        holders[0] = address(0xA11CE);
        amounts[0] = 10e18;
        Moloch dao =
            other.summon("OTHER", "OTH", "", 5000, true, address(0), bytes32(0), holders, amounts, new Call[](0));
        vm.roll(block.number + 1);
        address otherShares = address(dao.shares());
        address otherPolicy = dao.votingWeight();
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenDao.selector);
        marketFactory.create(address(dao), otherShares, ISecondaryPolicy(otherPolicy), IERC20(address(quote)), LOT_SIZE);
    }

    /// @dev Anyone can deploy a byte-identical proxy of the real implementation, and it passes the
    /// bytecode pin by design. It is safe because only the pinned summoner can initialise it
    /// (`Moloch.init` requires `msg.sender == SUMMONER`), so it never gets a Shares clone, a policy
    /// or any state, and the `shares()` read refuses it.
    function test_an_uninitialised_proxy_of_the_real_implementation_cannot_list() public {
        address proxy = RawProxy.deploy(marketFactory.molochImplementation());
        assertEq(proxy.codehash, marketFactory.daoRuntimeHash(), "it passes the bytecode pin by design");
        // Nobody but the summoner can initialise it.
        vm.expectRevert(Unauthorized.selector);
        Moloch(payable(proxy))
            .init("X", "X", "", 5000, true, address(0), new address[](0), new uint256[](0), new Call[](0));
        assertEq(address(Moloch(payable(proxy)).shares()), address(0));
        // Offering the empty token and policy it really has...
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenShares.selector);
        marketFactory.create(proxy, address(0), ISecondaryPolicy(address(0)), IERC20(address(quote)), LOT_SIZE);
        // ...or the token a real DAO at that address would have had (nobody can deploy it there).
        vm.prank(address(kit));
        vm.expectRevert(SecondaryMarketFactory.UnprovenShares.selector);
        marketFactory.create(proxy, address(0xBEEF), ISecondaryPolicy(address(0)), IERC20(address(quote)), LOT_SIZE);
        assertEq(marketFactory.marketOf(proxy), address(0));
    }
}
