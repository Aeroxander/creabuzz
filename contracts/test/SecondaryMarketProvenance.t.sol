// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SecondaryMarketFixture} from "./SecondaryMarketMocks.t.sol";
import {DummyMandateFactory, FixedQuote, MockSecondaryPolicy, TestListingKit} from "./SecondaryMarketMocks.t.sol";
import {ISecondaryPolicy} from "../src/interfaces/ISecondaryPolicy.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {Call, Shares, Summoner} from "../src/majeur/MolochPatched.sol";

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
