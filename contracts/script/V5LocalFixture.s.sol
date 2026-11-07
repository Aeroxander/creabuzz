// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ContributorKit} from "../src/ContributorKit.sol";
import {ContributorKitV2} from "../src/ContributorKitV2.sol";
import {ActivationVoting} from "../src/ActivationVoting.sol";
import {SecondaryMarket} from "../src/SecondaryMarket.sol";
import {SecondaryMarketFactory} from "../src/SecondaryMarketFactory.sol";
import {Moloch, Shares, Summoner} from "../src/majeur/MolochPatched.sol";
import {TreasuryMandate, TreasuryMandateFactory} from "../src/TreasuryMandate.sol";

/// @notice A throwaway 18-decimal ERC-20 used only as the local fixture's quote token. No policy, no
/// roles, no supply cap: the fixture never trades, it only needs real code at a real address.
contract FixtureQuote {
    string public name = "V5 Local Fixture Quote";
    string public symbol = "FQ";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @title V5LocalFixture
/// @notice Local-only runtime proof that the new creation version really deploys and launches inside
/// the EVM's own limits (EIP-3860 creation size, EIP-170 runtime size) on a live node — Foundry's test
/// VM waives both for `new`, so a green unit test is not evidence.
///
/// Deployment order, every step a real transaction from one fixture EOA:
///   1. TreasuryMandateFactory
///   2. ActivationVoting(factory)
///   3. Summoner(policy)
///   4. predict the kit's address from the deployer's next nonce
///   5. SecondaryMarketFactory(summoner, predictedKit)
///   6. ContributorKitV2(summoner, factory) — asserted to land on the prediction
/// Then, as the founder: a fixture ERC-20 (quote), and one `kit.launch(...)` with the candidate sale
/// schedule (0 cliff / 180 days, "at birth" start), one reviewer set, one first project (the work
/// area), lot size 1e18 and that quote token.
///
/// Everything after the launch is read back from the node's state, not from memory, and every
/// measured size is printed next to the limit it must fit.
///
/// Run (never against a public network):
///   forge script script/V5LocalFixture.s.sol --rpc-url http://127.0.0.1:<port> --broadcast
/// Env: V5_DEPLOYER_PK, V5_FOUNDER_PK, V5_REVIEWER_A, V5_REVIEWER_B (anvil fixture keys only).
contract V5LocalFixture is Script {
    /// @dev EIP-3860: the most a creation transaction may carry, constructor arguments included.
    uint256 internal constant MAX_INITCODE = 49_152;
    /// @dev EIP-170: the most runtime code any contract may have.
    uint256 internal constant MAX_RUNTIME = 24_576;

    /// @dev Candidate terms only, not production terms.
    uint256 internal constant FOUNDER_SHARES = 200e18;
    uint128 internal constant SHARE_BUDGET = 600e18;
    uint128 internal constant SHARE_CAP = 40e18;
    uint64 internal constant SALE_CLIFF = 0;
    uint64 internal constant SALE_DURATION = 180 days;
    uint256 internal constant LOT_SIZE = 1e18;
    bytes32 internal constant PROJECT_ID = keccak256("work-area:docs");
    bytes32 internal constant PROJECT_CHECK = keccak256("docs merged and reviewed");

    address internal deployer;
    address internal founder;

    function run() external {
        uint256 deployerPk = vm.envUint("V5_DEPLOYER_PK");
        uint256 founderPk = vm.envUint("V5_FOUNDER_PK");
        deployer = vm.addr(deployerPk);
        founder = vm.addr(founderPk);
        address reviewerA = vm.envAddress("V5_REVIEWER_A");
        address reviewerB = vm.envAddress("V5_REVIEWER_B");
        require(reviewerA != founder && reviewerB != founder, "reviewers must not be the founder");

        require(block.chainid == 31337, "V5LocalFixture: local anvil only (chain id 31337)");

        // ---- 1..6: the deployment order, one transaction each --------------------------------
        vm.startBroadcast(deployerPk);
        TreasuryMandateFactory mandateFactory = new TreasuryMandateFactory();
        ActivationVoting policyImplementation = new ActivationVoting(mandateFactory);
        Summoner summoner = new Summoner(address(policyImplementation));
        // The factory must be born authorised for exactly the address the kit will land on, so the
        // kit's next CREATE slot is predicted before the factory takes the one below it.
        address predictedKit = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        SecondaryMarketFactory marketFactory = new SecondaryMarketFactory(summoner, predictedKit);
        ContributorKitV2 kit = new ContributorKitV2(summoner, marketFactory);
        vm.stopBroadcast();

        require(address(kit) == predictedKit, "the kit did not land on the predicted address");
        console2.log("predicted kit (CREATE from the deployer nonce)", predictedKit);
        console2.log("ContributorKitV2 (actual, landed)            ", address(kit));
        _requireCode(address(mandateFactory), "mandate factory");
        _requireCode(address(policyImplementation), "policy implementation");
        _requireCode(address(summoner), "summoner");
        _requireCode(address(marketFactory), "market factory");
        _requireCode(address(kit), "kit");
        require(marketFactory.authorizedKit() == address(kit), "factory authorised another kit");
        require(address(marketFactory.summoner()) == address(summoner), "factory pins another summoner");
        require(kit.marketFactory() == marketFactory, "kit pins another factory");

        // ---- the founder's quote token and one launch ---------------------------------------
        vm.startBroadcast(founderPk);
        FixtureQuote quote = new FixtureQuote();
        quote.mint(founder, 1_000_000e18);
        vm.stopBroadcast();
        _requireCode(address(quote), "quote token");

        ContributorKitV2.LaunchParams memory p = _params(address(quote), reviewerA, reviewerB);
        // The budget factory makes each budget with a plain CREATE: read its next slot just before sending.
        p.base.predictedBudget = vm.computeCreateAddress(address(mandateFactory), vm.getNonce(address(mandateFactory)));

        (address expectedDao, address expectedShares, address expectedPolicy, address expectedMarket) =
            kit.predictLaunch(founder, FOUNDER_SHARES, p.base.salt, address(quote), LOT_SIZE);

        vm.startBroadcast(founderPk);
        (address daoAddr, address budgetAddr, address policyAddr) = kit.launch(p);
        vm.stopBroadcast();

        // ---- read-back, from the node's state ------------------------------------------------
        _verifyLaunch(
            marketFactory,
            mandateFactory,
            p,
            daoAddr,
            budgetAddr,
            policyAddr,
            expectedDao,
            expectedShares,
            expectedPolicy,
            expectedMarket,
            address(quote)
        );
        _reportSizes(
            kit,
            marketFactory,
            summoner,
            policyImplementation,
            mandateFactory,
            daoAddr,
            budgetAddr,
            policyAddr,
            expectedShares,
            expectedMarket,
            address(quote)
        );
        _emitSummary(
            kit,
            marketFactory,
            summoner,
            policyImplementation,
            mandateFactory,
            daoAddr,
            budgetAddr,
            policyAddr,
            expectedShares,
            expectedMarket,
            address(quote)
        );
    }

    /// @dev One machine-readable line, so the shell runner can read the same addresses back from the
    /// node with `cast` instead of trusting the script's own in-process view.
    function _emitSummary(
        ContributorKitV2 kit,
        SecondaryMarketFactory marketFactory,
        Summoner summoner,
        ActivationVoting policyImplementation,
        TreasuryMandateFactory mandateFactory,
        address daoAddr,
        address budgetAddr,
        address policyAddr,
        address sharesAddr,
        address marketAddr,
        address quote
    ) private view {
        console2.log(
            "FIXTURE_JSON",
            string.concat(
                '{"deployer":"',
                vm.toString(deployer),
                '","founder":"',
                vm.toString(founder),
                '","mandateFactory":"',
                vm.toString(address(mandateFactory)),
                '","policyImplementation":"',
                vm.toString(address(policyImplementation)),
                '","summoner":"',
                vm.toString(address(summoner)),
                '","marketFactory":"',
                vm.toString(address(marketFactory)),
                '","kit":"',
                vm.toString(address(kit)),
                '","quote":"',
                vm.toString(quote),
                '","dao":"',
                vm.toString(daoAddr),
                '","budget":"',
                vm.toString(budgetAddr),
                '","policy":"',
                vm.toString(policyAddr),
                '","shares":"',
                vm.toString(sharesAddr),
                '","market":"',
                vm.toString(marketAddr),
                '"}'
            )
        );
    }

    function _params(address quote, address reviewerA, address reviewerB)
        private
        view
        returns (ContributorKitV2.LaunchParams memory p)
    {
        address[] memory reviewers = new address[](2);
        reviewers[0] = reviewerA;
        reviewers[1] = reviewerB;

        ContributorKit.FirstProject[] memory projects = new ContributorKit.FirstProject[](1);
        projects[0] = ContributorKit.FirstProject({
            id: PROJECT_ID,
            manager: founder,
            shares: SHARE_CAP,
            expires: uint64(block.timestamp + 90 days),
            check: PROJECT_CHECK
        });

        p.base = ContributorKit.Params({
            name: "Docs Commons (local fixture)",
            symbol: "DOCS",
            founderShares: FOUNDER_SHARES,
            salt: keccak256("v5-local-fixture"),
            currency: quote,
            shareBudget: SHARE_BUDGET,
            shareCap: SHARE_CAP,
            budgetExpires: uint64(block.timestamp + 90 days),
            reviewers: reviewers,
            quorum: 2,
            predictedBudget: address(0), // filled just before the launch
            projects: projects
        });
        // Candidate sale schedule only: starts at birth (0 marker), no cliff, 180 linear days.
        p.saleStart = 0;
        p.saleCliff = SALE_CLIFF;
        p.saleDuration = SALE_DURATION;
        p.quote = quote;
        p.lotSize = LOT_SIZE;
    }

    function _verifyLaunch(
        SecondaryMarketFactory marketFactory,
        TreasuryMandateFactory mandateFactory,
        ContributorKitV2.LaunchParams memory p,
        address daoAddr,
        address budgetAddr,
        address policyAddr,
        address expectedDao,
        address expectedShares,
        address expectedPolicy,
        address expectedMarket,
        address quote
    ) private {
        // --- the DAO and its two clones ------------------------------------------------------
        require(daoAddr == expectedDao, "dao != predicted dao");
        require(policyAddr == expectedPolicy, "policy != predicted policy clone");
        _requireCode(daoAddr, "dao");
        _requireCode(budgetAddr, "work budget");
        _requireCode(policyAddr, "policy clone");
        _requireCode(expectedShares, "shares clone");
        _requireCode(expectedMarket, "market");

        Moloch dao = Moloch(payable(daoAddr));
        require(address(dao.shares()) == expectedShares, "dao shares != predicted shares clone");
        require(dao.votingWeight() == policyAddr, "dao votingWeight != predicted policy clone");

        // --- the market ----------------------------------------------------------------------
        require(marketFactory.marketOf(daoAddr) == expectedMarket, "marketOf(dao) != predicted market");
        SecondaryMarket market = SecondaryMarket(expectedMarket);
        require(market.dao() == daoAddr, "market.dao != dao");
        require(market.sharesToken() == expectedShares, "market.sharesToken != shares");
        require(address(market.policy()) == policyAddr, "market.policy != policy");
        require(address(market.quote()) == quote, "market.quote != quote");
        require(market.lotSize() == LOT_SIZE, "market.lotSize != 1e18");
        require(market.factory() == address(marketFactory), "market.factory != factory");
        (bool listingOn, uint128 minPrice, uint128 maxPrice, uint32 levels) = market.listing();
        require(!listingOn, "the listing must be born disabled");
        require(minPrice == 0 && maxPrice == 0 && levels == 0, "disabled listing must carry no terms");

        // --- the Shares at birth -------------------------------------------------------------
        Shares tokens = Shares(expectedShares);
        (uint256 eligible, uint8 version) = tokens.saleEligibleOf(founder);
        require(version == 1, "saleEligibleOf version != 1");
        require(eligible == 0, "the founder may sell something at birth");
        require(tokens.lockGuard() == address(0), "lockGuard != 0");
        require(tokens.lockGuardSet(), "lockGuardSet != true");
        require(tokens.transferExempt() == expectedMarket, "transferExempt != market");
        require(tokens.transfersLocked(), "transfers must be locked at birth");
        require(tokens.salePolicy() == policyAddr, "salePolicy != policy");
        require(tokens.balanceOf(founder) == FOUNDER_SHARES, "founder balance != grant");

        // --- bootstrap governance is real ----------------------------------------------------
        ActivationVoting variant = ActivationVoting(policyAddr);
        uint96 founderCapacity = variant.capacity(founder);
        require(founderCapacity != 0, "the founder has no governance capacity at birth");
        require(variant.saleCapacity(founder) == 0, "the founder's sale capacity at birth != 0");
        (address cfgMarket, address cfgFounder, uint256 cfgGrant, uint64 cfgStart, uint64 cfgCliff, uint64 cfgDuration) =
            variant.secondaryConfiguration();
        require(cfgMarket == expectedMarket && cfgFounder == founder && cfgGrant == FOUNDER_SHARES, "policy config");
        require(p.saleCliff == cfgCliff && p.saleDuration == cfgDuration, "policy schedule");
        require(p.saleStart == 0 && p.lotSize == LOT_SIZE && p.quote == quote, "launch params");
        require(cfgStart == block.timestamp, "the 0 marker must resolve to the launch block");

        // --- the work budget and its one work area -------------------------------------------
        require(mandateFactory.daos(budgetAddr) == daoAddr, "budget is not the DAO's");
        (address manager,,,,, uint128 shareBudget,) = TreasuryMandate(budgetAddr).projects(PROJECT_ID);
        require(manager == founder, "work area manager != founder");
        require(shareBudget == SHARE_CAP, "work area share budget != cap");

        console2.log("================ V5 local fixture: launch read-back ================");
        console2.log("deployer                        ", deployer);
        console2.log("founder                         ", founder);
        console2.log("TreasuryMandateFactory          ", address(mandateFactory));
        console2.log("policy (clone)                  ", policyAddr);
        console2.log("SecondaryMarketFactory          ", address(marketFactory));
        console2.log("quote token                     ", quote);
        console2.log("dao                             ", daoAddr);
        console2.log("dao.shares()                    ", address(dao.shares()));
        console2.log("dao.votingWeight()              ", dao.votingWeight());
        console2.log("work budget                     ", budgetAddr);
        console2.log("market                          ", expectedMarket);
        console2.log("market listing enabled          ", listingOn);
        console2.log("market lotSize                  ", market.lotSize());
        console2.log("shares transferExempt           ", tokens.transferExempt());
        console2.log("shares lockGuard                ", tokens.lockGuard());
        console2.log("shares lockGuardSet             ", tokens.lockGuardSet());
        console2.log("saleEligibleOf(founder) amount  ", eligible);
        console2.log("saleEligibleOf(founder) version ", version);
        console2.log("founder governance capacity     ", founderCapacity);
        console2.log("policy saleStart                ", cfgStart);
        console2.log("policy saleCliff                ", cfgCliff);
        console2.log("policy saleDuration             ", cfgDuration);
        console2.log("policy saleCapacity(founder)    ", variant.saleCapacity(founder));
    }

    function _reportSizes(
        ContributorKitV2 kit,
        SecondaryMarketFactory marketFactory,
        Summoner summoner,
        ActivationVoting policyImplementation,
        TreasuryMandateFactory mandateFactory,
        address daoAddr,
        address budgetAddr,
        address policyAddr,
        address sharesAddr,
        address marketAddr,
        address quote
    ) private {
        console2.log("================ V5 local fixture: real EVM limits ================");

        // Creation payloads as sent: artifact creation code plus the constructor arguments, which is
        // what EIP-3860 measures, and the runtimes the node now holds, which is what EIP-170 limits.
        _creationCheck(
            "ContributorKitV2",
            abi.encodePacked(
                vm.getCode("src/ContributorKitV2.sol:ContributorKitV2"), abi.encode(summoner, address(marketFactory))
            )
        );
        _creationCheck(
            "SecondaryMarketFactory",
            abi.encodePacked(
                vm.getCode("src/SecondaryMarketFactory.sol:SecondaryMarketFactory"), abi.encode(summoner, address(kit))
            )
        );
        _creationCheck(
            "SecondaryMarket",
            abi.encodePacked(
                vm.getCode("src/SecondaryMarket.sol:SecondaryMarket"),
                abi.encode(daoAddr, sharesAddr, policyAddr, quote, LOT_SIZE)
            )
        );
        _creationCheck(
            "Summoner",
            abi.encodePacked(vm.getCode("src/majeur/MolochPatched.sol:Summoner"), abi.encode(address(policyImplementation)))
        );
        _creationCheck(
            "ActivationVoting",
            abi.encodePacked(vm.getCode("src/ActivationVoting.sol:ActivationVoting"), abi.encode(address(mandateFactory)))
        );
        _creationCheck("TreasuryMandateFactory", vm.getCode("src/TreasuryMandate.sol:TreasuryMandateFactory"));
        _creationCheck(
            "Moloch (implementation)",
            abi.encodePacked(vm.getCode("src/majeur/MolochPatched.sol:Moloch"), abi.encode(address(policyImplementation)))
        );
        _creationCheck("Shares (implementation)", vm.getCode("src/majeur/MolochPatched.sol:Shares"));

        _runtimeCheck("ContributorKitV2", address(kit));
        _runtimeCheck("SecondaryMarketFactory", address(marketFactory));
        _runtimeCheck("SecondaryMarket", marketAddr);
        _runtimeCheck("Summoner", address(summoner));
        _runtimeCheck("ActivationVoting (implementation)", address(policyImplementation));
        _runtimeCheck("TreasuryMandateFactory", address(mandateFactory));
        _runtimeCheck("Moloch (implementation)", summoner.getImplementation());
        _runtimeCheck("Shares (implementation)", kit.sharesImplementation());
        _runtimeCheck("dao (clone)", daoAddr);
        _runtimeCheck("shares (clone)", sharesAddr);
        _runtimeCheck("policy (clone)", policyAddr);
        _runtimeCheck("work budget", budgetAddr);
    }

    function _creationCheck(string memory label, bytes memory payload) private pure {
        console2.log(label, "creation bytes (incl. args)", payload.length);
        console2.log("  EIP-3860 limit            ", MAX_INITCODE);
        require(payload.length <= MAX_INITCODE, string.concat(label, ": creation bytecode over EIP-3860"));
    }

    function _runtimeCheck(string memory label, address target) private view {
        uint256 size = target.code.length;
        console2.log(label, "runtime bytes", size);
        console2.log("  EIP-170 limit             ", MAX_RUNTIME);
        require(size <= MAX_RUNTIME, string.concat(label, ": runtime over EIP-170"));
        require(size != 0, string.concat(label, ": no code at the address"));
    }

    function _requireCode(address target, string memory label) private view {
        require(target.code.length != 0, string.concat(label, ": no code at the address"));
    }
}
