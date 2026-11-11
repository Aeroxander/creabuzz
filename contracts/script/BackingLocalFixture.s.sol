// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {BackingPool} from "../src/BackingPool.sol";
import {BackingPoolFactory} from "../src/BackingPoolFactory.sol";
import {ContributorKit} from "../src/ContributorKit.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {ContributorKitV3} from "../src/ContributorKitV3.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {TestQuoteToken} from "../src/TestQuoteToken.sol";
import {Summoner} from "../src/majeur/MolochPatched.sol";
import {TreasuryMandateFactory} from "../src/TreasuryMandate.sol";
import {BackingTerms} from "./BackingTerms.sol";

/// @title BackingLocalFixture
/// @notice Local-only runtime proof that the instant-backing set deploys and works inside a live node's own limits
/// (EIP-3860 creation size, EIP-170 runtime size; Foundry's test VM waives both). Every step is a real transaction
/// from one fixture key:
///   1. what is already on Sepolia, made fresh: work budget factory, voting policy, summoner, the V2 market factory
///      and kit, and a free-mint test token;
///   2. the new set, in the order `DeployBackingSepolia` uses: market factory, pool factory, `ContributorKitV3`;
///   3. a project launched with its pool (`launchWithPool`), a buy and a partial sale in it;
///   4. a project launched by `ContributorKitV2`, and its pool opened afterwards by its founder in one call;
///   5. a third project whose pool is opened behind an opening round, on the real auction factory.
/// Everything is then read back from the node's state.
///
/// Run (chain id 31337 only, never a public network):
///   forge script script/BackingLocalFixture.s.sol --rpc-url http://127.0.0.1:<port> --broadcast
/// Env: PRIVATE_KEY (a throwaway local key with ETH on that node), BACKING_AUCTION_FACTORY (the auction factory
/// deployed on that node, see `run`).
contract BackingLocalFixture is Script {
    function run() external {
        require(block.chainid == 31337, "BackingLocalFixture: a local node only (chain id 31337)");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        // The real auction factory, deployed on this node beforehand (it pins another compiler, so a script cannot
        // create it): `forge create lib/continuous-clearing-auction/src/ContinuousClearingAuctionFactory.sol:ContinuousClearingAuctionFactory --constructor-args 0x0000000000000000000000000000000000000000`.
        address auctionFactory = vm.envAddress("BACKING_AUCTION_FACTORY");
        require(auctionFactory.code.length != 0, "BackingLocalFixture: no auction factory at BACKING_AUCTION_FACTORY");

        vm.startBroadcast(pk);
        TreasuryMandateFactory mandateFactory = new TreasuryMandateFactory();
        Summoner summoner = new Summoner(address(new ActivationVoting(mandateFactory)));
        address predictedV2 = vm.computeCreateAddress(me, vm.getNonce(me) + 1);
        SecondaryMarketFactory marketFactoryV2 = new SecondaryMarketFactory(summoner, predictedV2);
        ContributorKitV2 kitV2 = new ContributorKitV2(summoner, marketFactoryV2);
        TestQuoteToken quote = new TestQuoteToken();

        BackingPool.Params memory terms = BackingTerms.defaults(quote.decimals());
        address predicted = vm.computeCreateAddress(me, vm.getNonce(me) + 2);
        SecondaryMarketFactory marketFactory = new SecondaryMarketFactory(summoner, predicted);
        BackingPoolFactory poolFactory = new BackingPoolFactory(
            summoner, IERC20(address(quote)), terms, predicted, BackingTerms.round(auctionFactory)
        );
        ContributorKitV3 kit = new ContributorKitV3(summoner, marketFactory, poolFactory);

        // A project with its pool at birth, and a first buy and sale in it.
        (address dao,,, address poolAddress) =
            kit.launchWithPool(_params(me, "born with a pool", address(quote), mandateFactory));
        BackingPool pool = BackingPool(poolAddress);
        quote.mint(me, 1_000e18);
        quote.approve(poolAddress, type(uint256).max);
        uint256 units = pool.buy(500e18, 0, block.timestamp + 1 hours);
        pool.sell(units / 2, 0, block.timestamp + 1 hours);

        // A V2 project, then its pool in one more call.
        (address daoV2,,) = kitV2.launch(_params(me, "pool later", address(quote), mandateFactory));
        BackingPool later = poolFactory.open(daoV2);

        // A third project, opened behind a round: the pool waits, the auction holds the claim tokens.
        (address daoRound,,) = kitV2.launch(_params(me, "pool with a round", address(quote), mandateFactory));
        (BackingPool waiting, address auction) = poolFactory.openWithRound(daoRound, 0);
        vm.stopBroadcast();

        require(waiting.roundState() == BackingPool.RoundState.Waiting && waiting.auction() == auction, "round");
        require(
            waiting.claimToken().balanceOf(auction) == waiting.roundSupply() && auction.code.length != 0,
            "the auction holds the claim tokens"
        );

        require(address(kit) == predicted, "kit off its prediction");
        require(poolFactory.poolOf(dao) == poolAddress && pool.dao() == dao && pool.founder() == me, "pool at birth");
        require(poolFactory.poolOf(daoV2) == address(later) && later.founder() == me, "pool opened later");
        require(pool.balanceOf(me) == units - units / 2, "units after the trades");
        require(
            quote.balanceOf(poolAddress) == pool.reserve() + pool.escrow() + pool.treasuryOwed(), "books != balance"
        );

        console2.log("summoner:", address(summoner));
        console2.log("quote:", address(quote));
        console2.log("kit v3:", address(kit));
        console2.log("pool factory:", address(poolFactory));
        console2.log("pool at birth:", poolAddress);
        console2.log("pool opened later:", address(later));
        console2.log("auction factory:", auctionFactory);
        console2.log("pool waiting for its round:", address(waiting));
        console2.log("its auction:", auction);
        console2.log("auction runtime bytes (limit 24576):", auction.code.length);
        console2.log("kit v3 runtime bytes (limit 24576):", address(kit).code.length);
        console2.log("pool factory runtime bytes (limit 24576):", address(poolFactory).code.length);
        console2.log("pool runtime bytes (limit 24576):", poolAddress.code.length);
    }

    function _params(address me, bytes32 salt, address quote, TreasuryMandateFactory mandateFactory)
        internal
        view
        returns (ContributorKitV2.LaunchParams memory p)
    {
        address[] memory reviewers = new address[](2);
        reviewers[0] = address(0xA1);
        reviewers[1] = address(0xA2);
        p.base.name = "Backing fixture";
        p.base.symbol = "BACK";
        p.base.founderShares = 200e18;
        p.base.salt = salt;
        p.base.currency = quote;
        p.base.shareBudget = 600e18;
        p.base.shareCap = 40e18;
        p.base.budgetExpires = uint64(block.timestamp + 90 days);
        p.base.reviewers = reviewers;
        p.base.quorum = 2;
        p.base.predictedBudget = vm.computeCreateAddress(address(mandateFactory), vm.getNonce(address(mandateFactory)));
        p.base.projects = new ContributorKit.FirstProject[](1);
        p.base.projects[0] = ContributorKit.FirstProject({
            id: bytes32("docs"),
            manager: me,
            shares: 40e18,
            expires: uint64(block.timestamp + 90 days),
            check: keccak256("docs merged and reviewed")
        });
        p.saleStart = 0;
        p.saleCliff = 180 days;
        p.saleDuration = 180 days;
        p.quote = quote;
        p.lotSize = 1e18;
    }
}
