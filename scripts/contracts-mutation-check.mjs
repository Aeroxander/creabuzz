#!/usr/bin/env node
/**
 * scripts/contracts-mutation-check.mjs — break each money-path guard once and check that a test fails.
 *
 * For every entry below it replaces one guard in a contract (or in the web exit preview) with a broken version, runs the
 * money-path invariant and fuzz tests (`contracts/test/invariant/`, plus any test file the entry names; an entry marked
 * "full" runs the whole suite, which the launch kit's tests need), and puts the file back with `git checkout`. A guard
 * whose removal no test notices is reported as MISSED and the script exits 1. It refuses to start while any file it would
 * touch has uncommitted changes, so it can never throw away work.
 *
 * Usage (from the repo root, hermit active): node scripts/contracts-mutation-check.mjs [index ...]
 * Takes a few minutes per mutation (the patched DAO recompiles with via-IR).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The secondary listing's contracts and the Foundry files that must catch a broken guard in each (relative to contracts/).
const SM = "contracts/src/SecondaryMarket.sol";
const FACTORY = "contracts/src/SecondaryMarketFactory.sol";
const AV = "contracts/src/ActivationVoting.sol";
const KIT2 = "contracts/src/ContributorKitV2.sol";
const MOLOCH = "contracts/src/majeur/MolochPatched.sol";
const SM_TESTS = [
  "test/SecondaryMarketAdversary.t.sol",
  "test/SecondaryMarketFlows.t.sol",
  "test/SecondaryMarketFlowsClearing.t.sol",
  "test/SecondaryMarketFlowsResolution.t.sol",
  "test/SecondaryMarketGuardPins.t.sol",
  "test/SecondaryMarketInvariant.t.sol",
  "test/SecondaryMarketProvenance.t.sol",
  "test/SecondaryMarketRealPolicy.t.sol",
  "test/SecondaryMarketReview.t.sol",
  "test/SecondaryListingVote.t.sol",
];
const KIT_TESTS = [
  "test/ContributorKitV2.t.sol",
  "test/ContributorKitV2Guards.t.sol",
  "test/FounderSaleEligibility.t.sol",
  "test/SecondaryMarketProvenance.t.sol",
];
const FACTORY_TESTS = [...SM_TESTS, "test/ContributorKitV2.t.sol"];
const AV_TESTS = [
  "test/ActivationVoting.t.sol",
  "test/ActivationVotingFuzz.t.sol",
  "test/FounderSaleEligibility.t.sol",
  "test/HoldingAge.t.sol",
  "test/SecondaryMarketRealPolicy.t.sol",
  "test/SecondaryMarketReview.t.sol",
  "test/SecondaryMarketInvariant.t.sol",
  "test/SecondaryListingVote.t.sol",
  "test/ContributorKitV2.t.sol",
];
const SHARES_TESTS = [...SM_TESTS, "test/FounderSaleEligibility.t.sol", "test/TransferLock.t.sol", "test/ExitExchange.t.sol"];

/** [what is broken, file (from the repo root), the guard, its broken replacement, optional: an extra test file or "full"] */
const MUTATIONS = [
  [
    "lock guard ignored (Shares)",
    "contracts/src/majeur/MolochPatched.sol",
    "if (locked != 0 && balanceOf[from] < amount + locked) revert LockedShares();",
    "if (false && locked != 0 && balanceOf[from] < amount + locked) revert LockedShares();",
  ],
  [
    "D58: next milestone no longer waits for the month on the one before",
    "contracts/src/MilestoneChallenge.sol",
    "if (block.timestamp < previous.unlockedAt + clawback || objection[index - 1].open) {",
    "if (objection[index - 1].open) {",
  ],
  [
    "D51: ragequit counts the DAO's own Shares again",
    "contracts/src/majeur/MolochPatched.sol",
    "total -= _shares.balanceOf(address(this)) + _loot.balanceOf(address(this));",
    "// removed",
  ],
  [
    "governor executes without a passed vote",
    "contracts/src/majeur/MolochPatched.sol",
    "        if (st != ProposalState.Succeeded && st != ProposalState.Queued) revert NotOk();\n        uint64 delay",
    "        st;\n        uint64 delay",
  ],
  [
    "approval bar dropped",
    "contracts/src/AllocationVoting.sol",
    "&& uint256(s.yes) * 10_000 >= uint256(p.approvalBps) * decided;",
    "&& decided >= 0;",
  ],
  [
    "D57: milestone vote weight not capped by the current balance",
    "contracts/src/MilestoneChallenge.sol",
    "IChallengeShares(IChallengeDao(dao).shares()).balanceOf(who)",
    "type(uint256).max",
  ],
  [
    "slash pays out more than it took",
    "contracts/src/VerifierSet.sol",
    "bondToken.safeTransfer(owner, taken);",
    "bondToken.safeTransfer(owner, taken + 1);",
  ],
  [
    "slash open to anyone",
    "contracts/src/VerifierSet.sol",
    "    function slash(address verifier, uint256 amount) external returns (uint256 taken) {\n        if (msg.sender != owner) revert OnlyOwner(msg.sender);",
    "    function slash(address verifier, uint256 amount) external returns (uint256 taken) {",
  ],
  [
    "claim challenge window ignored",
    "contracts/src/ClaimStake.sol",
    "if (block.timestamp < payableAt) revert InChallengeWindow(claimId, payableAt);",
    "payableAt;",
  ],
  [
    "zero-amount finish opened to money claims",
    "contracts/src/ClaimStake.sol",
    "msg.sender != claim.contributor && claim.amount != 0",
    "msg.sender != claim.contributor && false",
  ],
  [
    "finished stake paid to the caller",
    "contracts/src/ClaimStake.sol",
    "_payOrOwe(claim.contributor, claim.stake);",
    "_payOrOwe(msg.sender, claim.stake);",
    "test/FinishStep.t.sol",
  ],
  [
    "award finishes money claims",
    "contracts/src/TreasuryMandate.sol",
    "status == ClaimStake.Status.Approved && amount == 0;",
    "status == ClaimStake.Status.Approved;",
    "test/FinishStep.t.sol",
  ],
  [
    "award skips the finish (and its window check)",
    "contracts/src/TreasuryMandate.sol",
    "if (finish) claims.payout(claimId);",
    "finish;",
    "test/FinishStep.t.sol",
  ],
  [
    "an upheld late objection burns nothing",
    "contracts/src/MilestoneChallenge.sol",
    "            _clawBack(index);",
    "            index;",
  ],
  [
    "settling a vote reverts again when a payee is blocked (the D67 fix undone)",
    "contracts/src/MilestoneChallenge.sol",
    "        if (amount == 0) return;\n        (bool ok, bytes memory ret) = bondToken.call(",
    "        if (amount == 0) return;\n        IERC20(bondToken).safeTransfer(to, amount);\n        return;\n        (bool ok, bytes memory ret) = bondToken.call(",
  ],
  [
    "a blocked contributor's stake reverts the reserve's return again (D68 / ES-2 undone)",
    "contracts/src/ClaimStake.sol",
    "        if (amount == 0) return;\n        (bool ok, bytes memory ret) = address(currency).call(",
    "        if (amount == 0) return;\n        currency.safeTransfer(to, amount);\n        return;\n        (bool ok, bytes memory ret) = address(currency).call(",
    "test/ClaimStakeCurrency.t.sol",
  ],
  [
    "the claim escrow expects a bool from transfer again (D68 / ES-4 undone)",
    "contracts/src/ClaimStake.sol",
    "        if (total != 0) currency.safeTransfer(claim.contributor, total);",
    "        if (total != 0) require(currency.transfer(claim.contributor, total));",
    "test/ClaimStakeCurrency.t.sol",
  ],
  [
    "unclaimed sale Shares count in the voting supply again (D69 / ES-3 undone)",
    "contracts/src/DaoLaunchKit.sol",
    "        initCalls[next++] = KitCall(predictedPolicy, 0, abi.encodeCall(IKitPolicy.setExcluded, (predictedAuction, true)));",
    "        next++;",
    "full",
  ],
  [
    "web exit preview ignores the DAO's own Shares",
    "web/src/features/launchpad/lib/ragequit-position.ts",
    "const left = input.daoHeld >= outstanding ? 0n : outstanding - input.daoHeld;",
    "const left = outstanding;",
  ],
  [
    "web exit preview offers locked Shares",
    "web/src/features/launchpad/lib/ragequit-position.ts",
    "return locked >= balance ? 0n : balance - locked;",
    "return balance;",
  ],
  [
    "D72: ragequit counts the Shares still locked again",
    "contracts/src/majeur/MolochPatched.sol",
    "                    total -= lockedTotal;",
    "                    lockedTotal;",
    "test/MilestoneChallenge.t.sol",
  ],
  [
    "D72: the challenge lock's locked total does not fall when a milestone stands",
    "contracts/src/MilestoneChallenge.sol",
    "            totalLocked -= t.amount;",
    "            t.amount;",
    "test/MilestoneChallenge.t.sol",
  ],
  [
    "D72: the challenge lock's locked total does not fall on a forfeit",
    "contracts/src/MilestoneChallenge.sol",
    "        totalLocked -= total;\n        if (total != 0) IChallengeShares",
    "        if (total != 0) IChallengeShares",
    "test/MilestoneChallenge.t.sol",
  ],
  [
    "D72: the panel lock's locked total does not fall on an unlock",
    "contracts/src/MilestoneLock.sol",
    "        totalLocked -= tranche.amount;",
    "        tranche.amount;",
    "test/MilestoneLock.t.sol",
  ],
  [
    "web exit preview counts the Shares still locked again (D72)",
    "web/src/features/launchpad/lib/ragequit-position.ts",
    "return input.lockedTotal >= left ? 0n : left - input.lockedTotal;",
    "return left;",
  ],
  [
    "D73: a passed vote can burn a holder's Shares again",
    "contracts/src/majeur/MolochPatched.sol",
    "        require(Moloch(DAO).leaving(), Unauthorized());",
    "",
    "test/ExitProtections.t.sol",
  ],
  [
    "D73: a lock guard can be installed after \"none\" was chosen",
    "contracts/src/majeur/MolochPatched.sol",
    "        require(!lockGuardSet, LockGuardSet());",
    "",
    "test/ExitProtections.t.sol",
  ],
  [
    "D76: a passed vote can mint Shares again under the issuance rule",
    "contracts/src/majeur/MolochPatched.sol",
    "            if (!Moloch(DAO).awarding()) revert Unauthorized();\n            _countIssued(amount);",
    "            _countIssued(amount);",
    "test/IssuanceRule.t.sol",
  ],
  [
    "D76: awards no longer count against the year's allowance",
    "contracts/src/majeur/MolochPatched.sol",
    "            _countIssued(amount);\n            uint256 held = balanceOf[DAO];",
    "            uint256 held = balanceOf[DAO];",
    "test/IssuanceRule.t.sol",
  ],
  [
    "D76: the DAO can hand out its own Shares outside an award again",
    "contracts/src/majeur/MolochPatched.sol",
    "        if (awardsOnly && from == DAO && to != DAO && !Moloch(DAO).awarding()) revert Unauthorized();",
    "",
    "test/IssuanceRule.t.sol",
  ],
  [
    "D76: Loot can be minted under the issuance rule again",
    "contracts/src/majeur/MolochPatched.sol",
    "        if (Moloch(DAO).shares().awardsOnly()) revert Unauthorized();",
    "",
    "test/IssuanceRule.t.sol",
  ],
  [
    "D77: the transfer lock can be lifted without 30 days' notice",
    "contracts/src/majeur/MolochPatched.sol",
    "        ) revert UnlockNotDue();",
    "        ) {}",
    "test/TransferLock.t.sol",
  ],
  [
    "D77: Shares move between wallets while locked (the exemption lets everything through)",
    "contracts/src/majeur/MolochPatched.sol",
    "        if (exempt != address(0) && (from == exempt || to == exempt)) return;",
    "        if (exempt != address(0)) return;",
    "test/TransferLock.t.sol",
  ],
  [
    "D75: the kit accepts a sale under 60% of all Shares",
    "contracts/src/DaoLaunchKit.sol",
    "        if (uint256(p.saleSupply) * 10_000 < total * 6_000) revert UnfairTerms(1);",
    "",
    "full",
  ],
  [
    "D75: the kit accepts team Shares outside the milestones",
    "contracts/src/DaoLaunchKit.sol",
    "            if (sum != 10_000) revert UnfairTerms(4);",
    "",
    "full",
  ],
  [
    "D72/D75: the kit accepts a team seat that is the DAO, the executor, the auction or the kit",
    "contracts/src/DaoLaunchKit.sol",
    "            if (seat == dao || seat == executor || seat == auction || seat == address(this)) revert UnfairTerms(5);",
    "",
    "full",
  ],
  [
    "D74: the kit accepts a raise target below the whole tranche at the floor",
    "contracts/src/DaoLaunchKit.sol",
    "        if (a.floorPrice > (((uint256(a.requiredCurrencyRaised) + 1) << 96) - 1) / p.saleSupply) revert UnfairTerms(6);",
    "",
    "full",
  ],
  [
    "D86: the kit reads the floor and the target at fixed offsets again (a moved tuple passes)",
    "contracts/src/DaoLaunchKit.sol",
    "        KitAuctionParameters memory a = abi.decode(p.auctionConfig, (KitAuctionParameters));\n        if (a.floorPrice > (((uint256(a.requiredCurrencyRaised) + 1) << 96) - 1) / p.saleSupply) revert UnfairTerms(6);",
    "        (uint256 floorPrice, uint256 required) = abi.decode(p.auctionConfig[288:352], (uint256, uint256));\n        if (required < (floorPrice * p.saleSupply) >> 96) revert UnfairTerms(6);",
    "full",
  ],
  [
    "D86: the kit accepts milestone percentages without their checks (a team with no lock)",
    "contracts/src/DaoLaunchKit.sol",
    "            if (n < 2 || n > 8 || p.milestoneChecks.length != n) revert UnfairTerms(4);",
    "            if (n < 2 || n > 8) revert UnfairTerms(4);",
    "full",
  ],
  [
    "D86: the kit no longer reads back that the lock holds the whole team",
    "contracts/src/DaoLaunchKit.sol",
    "        _requireTeamLocked(p, lock);\n",
    "",
    "full",
  ],
  [
    "D79: a founder can start with more than a third of the first budget",
    "contracts/src/ContributorKit.sol",
    "        if (p.founderShares > uint256(p.shareBudget) / 3) revert InvalidTerms();",
    "",
    "test/ContributorKit.t.sol",
  ],
  [
    "D79: the founder can sit on the first budget's panel",
    "contracts/src/ContributorKit.sol",
    "            if (p.reviewers[i] == msg.sender) revert InvalidTerms();",
    "",
    "test/ContributorKit.t.sol",
  ],
  [
    "D84: the kit makes more than eight first projects",
    "contracts/src/ContributorKit.sol",
    "        if (count > MAX_FIRST_PROJECTS) revert InvalidTerms();",
    "",
    "test/ContributorKit.t.sol",
  ],
  [
    "D84: two first projects can have the same id",
    "contracts/src/ContributorKit.sol",
    "                if (p.projects[j].id == project.id) revert InvalidTerms();",
    "",
    "test/ContributorKit.t.sol",
  ],
  [
    "D84: the first projects can ask for more than the budget holds",
    "contracts/src/ContributorKit.sol",
    "        if (total > p.shareBudget) revert InvalidTerms();",
    "",
    "test/ContributorKit.t.sol",
  ],
  [
    "D84: a first project can be above the most for one project",
    "contracts/src/ContributorKit.sol",
    "                    || project.shares > p.shareCap || project.check == bytes32(0) || project.expires > p.budgetExpires",
    "                    || project.check == bytes32(0) || project.expires > p.budgetExpires",
    "test/ContributorKit.t.sol",
  ],
  [
    "N1: a work-area bounty pays during the challenge window",
    "contracts/src/WorkAreaBounty.sol",
    "        if (block.timestamp < payableAt) revert InChallengeWindow(claimId, payableAt);",
    "",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty still settles after refunds open",
    "contracts/src/WorkAreaBounty.sol",
    "        if (block.timestamp >= b.refundsFrom) revert SettleTooLate(id, b.refundsFrom);",
    "",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty refunds before refunds open",
    "contracts/src/WorkAreaBounty.sol",
    "        if (block.timestamp < b.refundsFrom) revert RefundsNotOpen(id, b.refundsFrom);",
    "",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a paid work-area bounty refunds as well",
    "contracts/src/WorkAreaBounty.sol",
    "        if (b.paidClaim != bytes32(0)) revert AlreadyPaid(id);\n        if (block.timestamp < b.refundsFrom)",
    "        if (block.timestamp < b.refundsFrom)",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty pays twice",
    "contracts/src/WorkAreaBounty.sol",
    "        if (b.paidClaim != bytes32(0)) revert AlreadyPaid(id);\n        if (block.timestamp >= b.refundsFrom)",
    "        if (block.timestamp >= b.refundsFrom)",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty pays a submission of another work area",
    "contracts/src/WorkAreaBounty.sol",
    "        if (mandate.claimProject(claimId) != b.projectId) revert NotThisWorkArea(claimId);",
    "",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty pays a frozen, rejected or open submission",
    "contracts/src/WorkAreaBounty.sol",
    "        if (status != ClaimStake.Status.Approved && status != ClaimStake.Status.Paid) revert NotAccepted(claimId);",
    "",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty pays work released before it opened",
    "contracts/src/WorkAreaBounty.sol",
    "        if (releasedAt < b.openedAt || releasedAt > b.deadline)",
    "        if (releasedAt > b.deadline)",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty pays work released after its deadline",
    "contracts/src/WorkAreaBounty.sol",
    "        if (releasedAt < b.openedAt || releasedAt > b.deadline)",
    "        if (releasedAt < b.openedAt)",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty takes money after its deadline",
    "contracts/src/WorkAreaBounty.sol",
    "        if (block.timestamp >= b.deadline || b.paidClaim != bytes32(0)) revert FundingClosed(id);",
    "        if (b.paidClaim != bytes32(0)) revert FundingClosed(id);",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty takes money for a budget the factory did not make",
    "contracts/src/WorkAreaBounty.sol",
    "        if (factory.daos(mandate) == address(0)) revert NotAWorkBudget(mandate);",
    "",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N1: a work-area bounty books more than it received",
    "contracts/src/WorkAreaBounty.sol",
    "        if (received != amount) revert ShortTransfer(amount, received);",
    "",
    "test/WorkAreaBounty.t.sol",
  ],
  [
    "N2: money comes in during a run",
    "contracts/src/OpenBounty.sol",
    "        if (b.runClaim != 0) revert RunOn(id);\n        if (amount == 0) revert NothingToFund();",
    "        if (amount == 0) revert NothingToFund();",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: money comes in after the deadline",
    "contracts/src/OpenBounty.sol",
    "        if (block.timestamp >= b.deadline) revert PastDeadline(id);\n        if (b.runClaim != 0) revert RunOn(id);\n        if (amount == 0)",
    "        if (b.runClaim != 0) revert RunOn(id);\n        if (amount == 0)",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: exactly half is a majority",
    "contracts/src/OpenBounty.sol",
    "return c.open && uint256(c.backing) * 2 > b.counting;",
    "return c.open && uint256(c.backing) * 2 >= b.counting;",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: a claimant's money counts",
    "contracts/src/OpenBounty.sol",
    "        if (openClaim[id][msg.sender] != 0) return;\n        b.counting += added;",
    "        b.counting += added;",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: filing a claim keeps the filer's money in the count",
    "contracts/src/OpenBounty.sol",
    "            b.counting -= weight;\n            _unback(id, msg.sender, weight);",
    "            _unback(id, msg.sender, weight);",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: a claimant can back a claim",
    "contracts/src/OpenBounty.sol",
    "        if (openClaim[id][msg.sender] != 0) revert HasOpenClaim(id, openClaim[id][msg.sender]);\n        if (backs[id][msg.sender] == claim)",
    "        if (backs[id][msg.sender] == claim)",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: two open claims per wallet",
    "contracts/src/OpenBounty.sol",
    "        if (openClaim[id][msg.sender] != 0) revert HasOpenClaim(id, openClaim[id][msg.sender]);\n        if (bytes(evidence)",
    "        if (bytes(evidence)",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: backing after the deadline",
    "contracts/src/OpenBounty.sol",
    "        if (block.timestamp >= b.deadline) revert PastDeadline(id);\n        if (claim == 0 || claim > b.claimCount",
    "        if (claim == 0 || claim > b.claimCount",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: a run survives losing its majority",
    "contracts/src/OpenBounty.sol",
    "        if (claim != 0 && !_qualifies(id, b, claim)) _endRun(id, b);",
    "        if (false && claim != 0 && !_qualifies(id, b, claim)) _endRun(id, b);",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: start without a majority",
    "contracts/src/OpenBounty.sol",
    "        if (!_qualifies(id, b, claim)) revert NotQualified(id, claim);",
    "",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: start while a run is on",
    "contracts/src/OpenBounty.sol",
    "        if (b.runClaim != 0) revert RunOn(id);\n        if (block.timestamp >= b.deadline) revert PastDeadline(id);\n        if (!_qualifies",
    "        if (block.timestamp >= b.deadline) revert PastDeadline(id);\n        if (!_qualifies",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: pay before the run is nine days old",
    "contracts/src/OpenBounty.sol",
    "        if (block.timestamp < payableAt) revert NotPayableYet(id, payableAt);",
    "",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: pay at or after refundsFrom",
    "contracts/src/OpenBounty.sol",
    "        if (block.timestamp >= b.refundsFrom) revert PayTooLate(id, b.refundsFrom);",
    "",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: pay twice",
    "contracts/src/OpenBounty.sol",
    "        if (b.paidClaim != 0) revert AlreadyPaid(id);\n        Appeal storage a = appeals[id];\n        if (a.state == APPEAL_UPHELD) {",
    "        Appeal storage a = appeals[id];\n        if (a.state == APPEAL_UPHELD) {",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: refund after payment",
    "contracts/src/OpenBounty.sol",
    "        if (b.paidClaim != 0) revert AlreadyPaid(id);\n        if (!_refundsOpen(id, b))",
    "        if (!_refundsOpen(id, b))",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: refunds open while a run is on",
    "contracts/src/OpenBounty.sol",
    "if (block.timestamp < b.deadline || b.runClaim != 0) return false;",
    "if (block.timestamp < b.deadline) return false;",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: refunds open before the deadline",
    "contracts/src/OpenBounty.sol",
    "if (block.timestamp < b.deadline || b.runClaim != 0) return false;",
    "if (b.runClaim != 0) return false;",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: the books take more than arrived",
    "contracts/src/OpenBounty.sol",
    "        if (received != amount) revert ShortTransfer(amount, received);\n        uint128 added = uint128(amount);\n        funded[id][msg.sender] += added;\n        b.total += added;\n        emit Funded(id, msg.sender, amount, b.total);\n        if (openClaim",
    "        uint128 added = uint128(amount);\n        funded[id][msg.sender] += added;\n        b.total += added;\n        emit Funded(id, msg.sender, amount, b.total);\n        if (openClaim",
    "test/OpenBounty.t.sol",
  ],
  [
    "Exit exchange: anyone passes the lock once an exchange is named",
    "contracts/src/majeur/MolochPatched.sol",
    "if (exchange != address(0) && msg.sender == exchange) return;",
    "if (exchange != address(0)) return;",
    "test/ExitExchange.t.sol",
  ],
  [
    "Exit exchange: it switches on without the 30 days",
    "contracts/src/majeur/MolochPatched.sol",
    "if (pending == address(0) || block.timestamp < uint256(exitExchangeAnnouncedAt) + UNLOCK_NOTICE) {",
    "if (pending == address(0)) {",
    "test/ExitExchange.t.sol",
  ],
  [
    "N6: the faucet hands out twice a day",
    "contracts/src/CreateFaucet.sol",
    "if (last != 0 && block.timestamp < uint256(last) + 1 days) revert TooSoon(last + 1 days);",
    "// removed",
    "test/CreateToken.t.sol",
  ],
  [
    "N7: jurors are drawn before the evidence time",
    "contracts/src/CreateCourt.sol",
    "if (block.timestamp < from) revert TooEarly(id, from);",
    "// removed",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: a juror seals after the sealing time",
    "contracts/src/CreateCourt.sol",
    "if (block.timestamp >= d.periodStart + COMMIT) revert TooLate(id, d.periodStart + COMMIT);",
    "// removed",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: someone not drawn seals a vote",
    "contracts/src/CreateCourt.sol",
    "if (v.seats == 0) revert NotDrawn(id);",
    "// removed",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: a vote opens without matching its seal",
    "contracts/src/CreateCourt.sol",
    "if (keccak256(abi.encode(choice, salt, msg.sender, id, r)) != v.commit) revert BadCommit(id);",
    "// removed",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: a fourth round",
    "contracts/src/CreateCourt.sol",
    "if (d.rounds == MAX_ROUNDS) revert LastRound(id);",
    "// removed",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: a case settles before its appeal time ends",
    "contracts/src/CreateCourt.sol",
    "if (d.rounds < MAX_ROUNDS && block.timestamp < d.periodStart + APPEAL) {",
    "if (false) {",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: a case times out early",
    "contracts/src/CreateCourt.sol",
    "if (block.timestamp < at) revert TooEarly(id, at);",
    "// removed",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: stake a case holds can be taken out",
    "contracts/src/CreateCourt.sol",
    "if (amount == 0 || amount > free) revert NotFree(free);",
    "if (amount == 0) revert NotFree(free);",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: a juror against the ruling keeps their stake",
    "contracts/src/CreateCourt.sol",
    "j.staked -= held;",
    "// removed",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: any opened vote counts as with the ruling",
    "contracts/src/CreateCourt.sol",
    "return v.choice != 0 && (ruling == 0 || v.choice == ruling);",
    "return v.choice != 0;",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: an appeal before the deadline",
    "contracts/src/OpenBounty.sol",
    "block.timestamp < b.deadline || block.timestamp >= from + APPEAL_WINDOW",
    "block.timestamp >= from + APPEAL_WINDOW",
    "test/OpenBountyAppeal.t.sol",
  ],
  [
    "N7: a second appeal on one bounty",
    "contracts/src/OpenBounty.sol",
    "if (a.state != 0) revert AlreadyAppealed(id);",
    "// removed",
    "test/OpenBountyAppeal.t.sol",
  ],
  [
    "N7: refunds while an appeal is open",
    "contracts/src/OpenBounty.sol",
    "if (a.state == APPEAL_OPEN) return false;",
    "// removed",
    "test/OpenBountyAppeal.t.sol",
  ],
  [
    "N7: refunds before the appeal window ends",
    "contracts/src/OpenBounty.sol",
    "|| block.timestamp >= _quietSince(b, a) + APPEAL_WINDOW;",
    "|| true;",
    "test/OpenBountyAppeal.t.sol",
  ],
  [
    "N7: anyone rules on an appeal",
    "contracts/src/OpenBounty.sol",
    "if (msg.sender != address(court)) revert NotCourt();",
    "// removed",
    "test/OpenBountyAppeal.t.sol",
  ],
  [
    "N7: an upheld claim is paid after its time",
    "contracts/src/OpenBounty.sol",
    "if (block.timestamp >= until) revert PayTooLate(id, until);",
    "// removed",
    "test/OpenBountyAppeal.t.sol",
  ],
  [
    "N7: an appealed claim is withdrawn",
    "contracts/src/OpenBounty.sol",
    "if (appeals[id].state == APPEAL_OPEN && appeals[id].claim == claim) revert AppealOpen(id);",
    "// removed",
    "test/OpenBountyAppeal.t.sol",
  ],
  [
    "N10: a seller loses what was credited to them",
    "contracts/src/Payouts.sol",
    "if (from != address(0) && from != dao) correction[from] += delta;",
    "// removed",
    "test/Payouts.t.sol",
  ],
  [
    "N10: a new holder is paid for payouts before they held",
    "contracts/src/Payouts.sol",
    "if (to != address(0) && to != dao) correction[to] -= delta;",
    "// removed",
    "test/Payouts.t.sol",
  ],
  [
    "N10: the DAO's own holding counts",
    "contracts/src/Payouts.sol",
    "return shares.totalSupply() + loot.totalSupply() - shares.balanceOf(dao) - loot.balanceOf(dao);",
    "return shares.totalSupply() + loot.totalSupply();",
    "test/Payouts.t.sol",
  ],
  [
    "N10: it pays before the DAO named it",
    "contracts/src/Payouts.sol",
    "if (IPayoutsDao(dao).payouts() != address(this)) revert NotNamed();",
    "// removed",
    "test/Payouts.t.sol",
  ],
  [
    "N10: anyone tells it who holds what",
    "contracts/src/Payouts.sol",
    "function ownershipChanged(bool, address from, address to, uint256 amount) external onlyDao {",
    "function ownershipChanged(bool, address from, address to, uint256 amount) external {",
    "test/Payouts.t.sol",
  ],
  [
    "N10: anyone declares a payout from the treasury",
    "contracts/src/Payouts.sol",
    "function declare(uint256 amount) external onlyDao nonReentrant {",
    "function declare(uint256 amount) external nonReentrant {",
    "test/Payouts.t.sol",
  ],
  [
    "N10: the split changes without notice",
    "contracts/src/Payouts.sol",
    "if (splitAnnouncedAt == 0 || block.timestamp < at) revert SplitNotDue(at);",
    "if (splitAnnouncedAt == 0) revert SplitNotDue(at);",
    "test/Payouts.t.sol",
  ],
  [
    "N10: a payout with nobody counting",
    "contracts/src/Payouts.sol",
    "if (c < MIN_COUNTING) revert NobodyCounting(c);",
    "// removed",
    "test/Payouts.t.sol",
  ],
  [
    "N10: a holder withdraws twice",
    "contracts/src/Payouts.sol",
    "withdrawn[who] += amount;",
    "// removed",
    "test/Payouts.t.sol",
  ],
  [
    "N10: the DAO renames its payout module",
    "contracts/src/majeur/MolochPatched.sol",
    "payouts == address(0)",
    "true",
    "test/Payouts.t.sol",
  ],
  [
    "N10: the payout module is not told of changes",
    "contracts/src/majeur/MolochPatched.sol",
    "if (module != address(0)) IPayoutsHook(module).ownershipChanged(isLoot, from, to, amount);",
    "// removed",
    "test/Payouts.t.sol",
  ],
  [
    "N12: a case is opened after the term",
    "contracts/src/RemixBond.sol",
    "if (block.timestamp >= b.releasesAt) revert TermOver(id);",
    "// removed",
    "test/RemixBond.t.sol",
  ],
  [
    "N12: two cases at once on one bond",
    "contracts/src/RemixBond.sol",
    "        if (b.openCase != 0) revert CaseOpen(id);\n        if (block.timestamp >= b.releasesAt) revert TermOver(id);",
    "        if (block.timestamp >= b.releasesAt) revert TermOver(id);",
    "test/RemixBond.t.sol",
  ],
  [
    "N12: a bond comes back while a case is open",
    "contracts/src/RemixBond.sol",
    "        if (b.openCase != 0) revert CaseOpen(id);\n        if (block.timestamp < b.releasesAt) revert NotDue(id, b.releasesAt);",
    "        if (block.timestamp < b.releasesAt) revert NotDue(id, b.releasesAt);",
    "test/RemixBond.t.sol",
  ],
  [
    "N12: a bond comes back before its term",
    "contracts/src/RemixBond.sol",
    "if (block.timestamp < b.releasesAt) revert NotDue(id, b.releasesAt);",
    "// removed",
    "test/RemixBond.t.sol",
  ],
  [
    "N12: anyone rules on a bond",
    "contracts/src/RemixBond.sol",
    "if (msg.sender != address(court)) revert NotCourt();",
    "// removed",
    "test/RemixBond.t.sol",
  ],
  [
    "N12: any ruling forfeits the bond",
    "contracts/src/RemixBond.sol",
    "if (ruling == 1) {",
    "if (true) {",
    "test/RemixBond.t.sol",
  ],
  [
    "N12: a forfeited bond is paid to the parent twice",
    "contracts/src/RemixBond.sol",
    "b.state = PAID;",
    "// removed",
    "test/RemixBond.t.sol",
  ],
  [
    "N12: a term shorter than the least",
    "contracts/src/RemixBond.sol",
    "if (term < MIN_TERM || term > MAX_TERM) revert BadTerm();",
    "if (term > MAX_TERM) revert BadTerm();",
    "test/RemixBond.t.sol",
  ],
  [
    "N7: a first stake of dust takes a place",
    "contracts/src/CreateCourt.sol",
    "if (amount < seatStake) revert BelowOneSeat(amount);",
    "// removed",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: unstaking leaves dust holding a place",
    "contracts/src/CreateCourt.sol",
    "if (left != 0 && left < seatStake) revert BelowOneSeat(left);",
    "// removed",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: a place is never given back",
    "contracts/src/CreateCourt.sol",
    "if (j.staked != 0) return;",
    "return;",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: an unheard appeal undoes the ruling it appealed",
    "contracts/src/CreateCourt.sol",
    "_rule(id, d, rounds[id][r - 1].ruling, r, true);",
    "_rule(id, d, 0, r, true);",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: an unheard appeal is not paid back",
    "contracts/src/CreateCourt.sol",
    "owedFee[unheard.appellant] += unheard.fee;",
    "feePool += unheard.fee;",
    "test/CreateCourt.t.sol",
  ],
  [
    "N7: an asker that refuses its ruling holds its jurors",
    "contracts/src/CreateCourt.sol",
    "undelivered[id] = true;",
    "revert NothingToDeliver(id);",
    "test/CreateCourt.t.sol",
  ],
  [
    "N10: a DAO names a module its own factory did not make",
    "contracts/src/majeur/MolochPatched.sol",
    "&& AllocationVoting(policyImpl).mandateFactory().payoutsFactory().daoOf(module) == address(this),",
    "&& module != address(0),",
    "test/Payouts.t.sol",
  ],
  [
    "N10: a module for a DAO that could still add a lock",
    "contracts/src/Payouts.sol",
    "if (!ILockGuarded(shares_).lockGuardSet() || ILockGuarded(shares_).lockGuard() != address(0)) {",
    "if (ILockGuarded(shares_).lockGuard() != address(0)) {",
    "test/Payouts.t.sol",
  ],
  [
    "N10: making the module early makes the vote fail",
    "contracts/src/Payouts.sol",
    "if (made.code.length != 0) return Payouts(made);",
    "// removed",
    "test/Payouts.t.sol",
  ],
  [
    "Rounds: a price that does not trade the most is accepted",
    "contracts/src/WeeklyRounds.sol",
    "if (demandUp >= supplyAt(id, step + 1) || demandUp > supply) revert WrongPrice(step);",
    "// removed",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Rounds: a step above the clearing one is accepted",
    "contracts/src/WeeklyRounds.sol",
    "if (demandAt(id, step - 1) < supplyDown || demand <= supplyDown) revert WrongPrice(step);",
    "// removed",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Rounds: sellers keep the treasury's cut",
    "contracts/src/WeeklyRounds.sol",
    "if (who != r.dao) cut = filled * (price - r.floor) * CUT_BPS / (UNIT * 10_000);",
    "// removed",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Rounds: the DAO sells at the floor",
    "contracts/src/WeeklyRounds.sol",
    "if (lowest >= STEPS || (msg.sender == r.dao && lowest < DAO_MIN_STEPS)) revert BadStep(lowest);",
    "if (lowest >= STEPS) revert BadStep(lowest);",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Rounds: orders change after bidding ends",
    "contracts/src/WeeklyRounds.sol",
    "if (block.timestamp >= r.closesAt) revert BiddingOver(id);",
    "// removed",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Rounds: a void round is settled late",
    "contracts/src/WeeklyRounds.sol",
    "if (block.timestamp >= uint256(r.closesAt) + SETTLE_WINDOW) revert SettleOver(id);",
    "// removed",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Rounds: shares at the price do not add up",
    "contracts/src/WeeklyRounds.sol",
    "return claimedAfter * r.marginGets / r.marginTotal - claimedBefore * r.marginGets / r.marginTotal;",
    "return amount * r.marginGets / r.marginTotal;",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Rounds: a bid is claimed twice",
    "contracts/src/WeeklyRounds.sol",
    "if (b.amount != 0 && !b.claimed) {",
    "if (b.amount != 0) {",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Rounds: a DAO opens rounds more than weekly",
    "contracts/src/WeeklyRounds.sol",
    "uint64 at = rounds[last].opensAt + EVERY;\n            if (block.timestamp < at) revert TooSoon(at);",
    "uint64 at = rounds[last].opensAt + EVERY;",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Rounds: a round opens for a DAO that did not name it",
    "contracts/src/WeeklyRounds.sol",
    "if (IRoundShares(shares).exitExchange() != address(this)) revert NotNamed();",
    "// removed",
    "test/WeeklyRounds.t.sol",
  ],
  [
    "Funding: a tranche opens before the notice",
    "contracts/src/FundingTerms.sol",
    "if (block.timestamp < t.activeFrom) revert NotYet(t.activeFrom);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: a tranche goes past the cap",
    "contracts/src/FundingTerms.sol",
    "if (uint256(t.sold) + quantity > t.cap) revert OverCap(t.cap - t.sold);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: the cap is lowered below what was sold",
    "contracts/src/FundingTerms.sol",
    "if (cap >= t.cap || cap < uint256(t.sold) + reserved[msg.sender]) revert BadTerms();",
    "if (cap >= t.cap) revert BadTerms();",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: publishing sets no notice",
    "contracts/src/FundingTerms.sol",
    "t.activeFrom = uint64(block.timestamp) + NOTICE;",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: an unsold reservation never returns to the tranche",
    "contracts/src/FundingTerms.sol",
    "tranches[dao].taken -= uint128(held - sold);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: Loot is created by anyone",
    "contracts/src/majeur/MolochPatched.sol",
    "The one way Loot appears under the issuance rule.\n    function mintForFunding(address to, uint256 amount) public {\n        require(",
    "The one way Loot appears under the issuance rule.\n    function mintForFunding(address to, uint256 amount) public {\n        if (false) require(",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: Shares are created by anyone",
    "contracts/src/majeur/MolochPatched.sol",
    "counts against no yearly allowance.\n    function mintForFunding(address to, uint256 amount) public {\n        require(",
    "counts against no yearly allowance.\n    function mintForFunding(address to, uint256 amount) public {\n        if (false) require(",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: a funding round settles below two steps over the floor",
    "contracts/src/WeeklyRounds.sol",
    "if (priceAt(id, step) * 10_000 < floorNow * (10_000 + STEP_BPS * DAO_MIN_STEPS)) {\n                revert BelowFloor(floorNow);\n            }",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: holders sell in a funding round",
    "contracts/src/WeeklyRounds.sol",
    "Round storage r = _bidding(id);\n        if (r.funding) revert NotForFunding();\n        if (amount == 0",
    "Round storage r = _bidding(id);\n        if (amount == 0",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: anyone reserves a tranche",
    "contracts/src/FundingTerms.sol",
    "Terms storage t = terms[dao];\n        if (msg.sender != t.rounds) revert NotTheRounds();\n        Tranche storage tr",
    "Terms storage t = terms[dao];\n        Tranche storage tr",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: anyone settles a reservation",
    "contracts/src/FundingTerms.sol",
    "if (msg.sender != t.rounds) revert NotTheRounds();\n        uint256 held",
    "uint256 held",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: terms change instrument or widen without notice",
    "contracts/src/FundingTerms.sol",
    "if (asShares != t.asShares || rounds != t.rounds || exitFeeBps != t.exitFeeBps || cap <= t.cap) {\n                revert BadTerms();\n            }",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: widening swaps the rounds contract",
    "contracts/src/FundingTerms.sol",
    "if (asShares != t.asShares || rounds != t.rounds || exitFeeBps != t.exitFeeBps || cap <= t.cap) {\n                revert BadTerms();\n            }",
    "if (asShares != t.asShares || exitFeeBps != t.exitFeeBps || cap <= t.cap) {\n                revert BadTerms();\n            }",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: terms name a wallet as the seller",
    "contracts/src/FundingTerms.sol",
    "if (cap == 0 || rounds.code.length == 0 || exitFeeBps > MAX_EXIT_FEE_BPS) revert BadTerms();",
    "if (cap == 0 || exitFeeBps > MAX_EXIT_FEE_BPS) revert BadTerms();",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: a sale while the treasury holds ETH",
    "contracts/src/FundingTerms.sol",
    "if (dao.balance != 0) revert OtherAssets(address(0));",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: a sale while the treasury holds a watched token",
    "contracts/src/FundingTerms.sol",
    "if (token != currency && !accepted[dao][token] && IERC20(token).balanceOf(dao) != 0) {\n                revert OtherAssets(token);\n            }",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: settling creates nothing",
    "contracts/src/FundingTerms.sol",
    "IFundingToken(t.asShares ? d.shares() : d.loot()).mintForFunding(msg.sender, sold);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: the treasury is not paid at settling",
    "contracts/src/WeeklyRounds.sol",
    "if (paid != 0) currency.safeTransfer(r.dao, paid);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: a round is finished before it is over",
    "contracts/src/WeeklyRounds.sol",
    "if (!r.settled && block.timestamp < uint256(r.closesAt) + SETTLE_WINDOW) revert NotOver(id);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Funding: Loot does not move through the exchange",
    "contracts/src/majeur/MolochPatched.sol",
    "if (msg.sender == Moloch(DAO).shares().exitExchange() && msg.sender != address(0)) return;",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "web exit preview leaves out the exit fee (D135)",
    "web/src/features/launchpad/lib/ragequit-position.ts",
    "return feeBps === 0n ? 0n : (due * feeBps) / 10_000n;",
    "return 0n;",
  ],
  [
    "Exit fee: leaving charges none",
    "contracts/src/majeur/MolochPatched.sol",
    "if (fee != 0) due -= mulDiv(due, fee, 10_000);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Exit fee: charged under notice",
    "contracts/src/FundingTerms.sol",
    "return t.published && block.timestamp >= t.activeFrom ? t.exitFeeBps : 0;",
    "return t.exitFeeBps;",
    "test/FundingTerms.t.sol",
  ],
  [
    "Exit fee: no cap",
    "contracts/src/FundingTerms.sol",
    "if (cap == 0 || rounds.code.length == 0 || exitFeeBps > MAX_EXIT_FEE_BPS) revert BadTerms();",
    "if (cap == 0 || rounds.code.length == 0) revert BadTerms();",
    "test/FundingTerms.t.sol",
  ],
  [
    "Exit fee: widening changes it",
    "contracts/src/FundingTerms.sol",
    "if (asShares != t.asShares || rounds != t.rounds || exitFeeBps != t.exitFeeBps || cap <= t.cap) {",
    "if (asShares != t.asShares || rounds != t.rounds || cap <= t.cap) { t.exitFeeBps = exitFeeBps;",
    "test/FundingTerms.t.sol",
  ],
  [
    "Exit fee: lowering can raise it",
    "contracts/src/FundingTerms.sol",
    "if (exitFeeBps >= t.exitFeeBps) revert BadTerms();",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Exit fee: the first publication sets none",
    "contracts/src/FundingTerms.sol",
    "t.exitFeeBps = exitFeeBps;\n        }",
    "}",
    "test/FundingTerms.t.sol",
  ],
  [
    "Untracked assets: anyone can flag",
    "contracts/src/FundingTerms.sol",
    "if (IERC20(d.shares()).balanceOf(msg.sender) == 0 && IERC20(d.loot()).balanceOf(msg.sender) == 0) {",
    "if (false) {",
    "test/FundingTerms.t.sol",
  ],
  [
    "Untracked assets: a token the treasury does not hold can be flagged",
    "contracts/src/FundingTerms.sol",
    "if (IERC20(token).balanceOf(dao) == 0) revert NotHeld(token);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Untracked assets: an accepted token can be flagged again",
    "contracts/src/FundingTerms.sol",
    "if (accepted[dao][token] || token == d.shares() || token == d.loot()) revert BadTerms();",
    "if (token == d.shares() || token == d.loot()) revert BadTerms();",
    "test/FundingTerms.t.sol",
  ],
  [
    "Untracked assets: accepting a token does not let sales go ahead",
    "contracts/src/FundingTerms.sol",
    "if (token != currency && !accepted[dao][token] && IERC20(token).balanceOf(dao) != 0) {",
    "if (token != currency && IERC20(token).balanceOf(dao) != 0) {",
    "test/FundingTerms.t.sol",
  ],
  [
    "Untracked assets: a full list drops a token still held",
    "contracts/src/FundingTerms.sol",
    "if (room == type(uint256).max && (accepted[dao][t] || IERC20(t).balanceOf(dao) == 0)) room = i;",
    "if (room == type(uint256).max) room = i;",
    "test/FundingTerms.t.sol",
  ],
  [
    "Untracked assets: a vote takes a flagged token off the list",
    "contracts/src/FundingTerms.sol",
    "        for (uint256 i; i < tokens.length; ++i) {\n            _watch(msg.sender, tokens[i]);",
    "        delete watched[msg.sender];\n        for (uint256 i; i < tokens.length; ++i) {\n            _watch(msg.sender, tokens[i]);",
    "test/FundingTerms.t.sol",
  ],
  [
    "Final exit: the last one out pays the fee",
    "contracts/src/majeur/MolochPatched.sol",
    "if (amt < total) fee = ",
    "fee = ",
    "test/FundingTerms.t.sol",
  ],
  [
    "web exit preview charges the last one out (D136)",
    "web/src/features/launchpad/lib/ragequit-position.ts",
    "const feeBps = amt >= total ? 0n : (input.exitFeeBps ?? 0n);",
    "const feeBps = input.exitFeeBps ?? 0n;",
  ],
  [
    "Untracked assets: a holder flags the DAO's own units",
    "contracts/src/FundingTerms.sol",
    "if (accepted[dao][token] || token == d.shares() || token == d.loot()) revert BadTerms();",
    "if (accepted[dao][token]) revert BadTerms();",
    "test/FundingTerms.t.sol",
  ],
  [
    "Escrow payouts: a seller's start is not recorded",
    "contracts/src/WeeklyRounds.sol",
    "sellPerUnit[id][msg.sender] = _perUnit(r.dao);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Escrow payouts: the settlement point is not recorded",
    "contracts/src/WeeklyRounds.sol",
    "settlePerUnit[id] = _perUnit(r.dao);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Escrow payouts: claims pass nothing on",
    "contracts/src/WeeklyRounds.sol",
    "_passPayouts(r.dao, who, earned);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Escrow payouts: a taken-back offer passes nothing on",
    "contracts/src/WeeklyRounds.sol",
    "_passPayouts(r.dao, msg.sender, amount * (_perUnit(r.dao) - sellPerUnit[id][msg.sender]));",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Escrow payouts: sellers get nothing for what sold",
    "contracts/src/WeeklyRounds.sol",
    "if (filled != 0) earned += filled * (settlePerUnit[id] - since);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  [
    "Escrow payouts: buyers get nothing before collecting",
    "contracts/src/WeeklyRounds.sol",
    "if (filled != 0) earned += filled * (perUnitNow - settlePerUnit[id]);",
    "// removed",
    "test/FundingTerms.t.sol",
  ],
  // ---- the secondary listing (D179/D180 candidate): SecondaryMarket, its factory, the activation policy and the V2 kit.
  // Each names the test files that must catch it (and stops at the first failure); a MISSED line is a missing test.
  // Guards are located by their text, so they survive line drift.
  [
    "Secondary market: anyone configures the listing",
    SM,
    "    function configureListing(bool enabled, uint128 minPrice, uint128 maxPrice, uint32 levels) external {\n        if (msg.sender != dao) revert NotDao();",
    "    function configureListing(bool enabled, uint128 minPrice, uint128 maxPrice, uint32 levels) external {",
    SM_TESTS,
  ],
  [
    "Secondary market: a listing with more price levels than the cap",
    SM,
    "levels == 0 || levels > MAX_LEVELS) revert InvalidTerms();",
    "levels == 0) revert InvalidTerms();",
    SM_TESTS,
  ],
  [
    "Secondary market: a price span the levels do not divide evenly",
    SM,
    "if (span % levels != 0) revert InvalidTerms();",
    "span;",
    SM_TESTS,
  ],
  [
    "Secondary market: a round opens before the weekly gap has passed",
    SM,
    "if (lastOpenAt != 0 && block.timestamp < lastOpenAt + EVERY) revert TooSoon(lastOpenAt + EVERY);",
    "lastOpenAt;",
    SM_TESTS,
  ],
  [
    "Secondary market: the DAO sells its own inventory",
    SM,
    "if (msg.sender == dao) revert DaoCannotSell();",
    "dao;",
    SM_TESTS,
  ],
  [
    "Secondary market: an offer above the seller's sale capacity",
    SM,
    "if (policy.saleCapacity(msg.sender) < amount) revert NoCapacity();",
    "amount;",
    SM_TESTS,
  ],
  [
    "Secondary market: Shares taken in are not measured against the balance",
    SM,
    "if (received != before + amount) revert BadAmount();",
    "received;",
    SM_TESTS,
  ],
  [
    "Secondary market: quote taken in is not measured against the balance",
    SM,
    "if (received != before + escrow) revert BadAmount();",
    "received;",
    SM_TESTS,
  ],
  [
    "Secondary market: sell is reentrant",
    SM,
    "function sell(uint256 id, uint128 lots, uint16 minStep) external nonReentrant {",
    "function sell(uint256 id, uint128 lots, uint16 minStep) external {",
    SM_TESTS,
  ],
  [
    "Secondary market: bid is reentrant",
    SM,
    "function bid(uint256 id, uint128 lots, uint16 maxStep) external nonReentrant {",
    "function bid(uint256 id, uint128 lots, uint16 maxStep) external {",
    SM_TESTS,
  ],
  [
    "Secondary market: cancelSell is reentrant",
    SM,
    "function cancelSell(uint256 id) external nonReentrant {",
    "function cancelSell(uint256 id) external {",
    SM_TESTS,
  ],
  [
    "Secondary market: cancelBid is reentrant",
    SM,
    "function cancelBid(uint256 id) external nonReentrant {",
    "function cancelBid(uint256 id) external {",
    SM_TESTS,
  ],
  [
    "Secondary market: settle is reentrant",
    SM,
    "function settle(uint256 id) external nonReentrant {",
    "function settle(uint256 id) external {",
    SM_TESTS,
  ],
  [
    "Secondary market: claimShares is reentrant",
    SM,
    "function claimShares(uint256 id, address who) external nonReentrant {",
    "function claimShares(uint256 id, address who) external {",
    SM_TESTS,
  ],
  [
    "Secondary market: claimQuote is reentrant",
    SM,
    "function claimQuote(uint256 id, address who) external nonReentrant {",
    "function claimQuote(uint256 id, address who) external {",
    SM_TESTS,
  ],
  [
    "Secondary market: the reentrancy lock never locks",
    SM,
    "if (_entered) revert Reentrancy();",
    "_entered;",
    SM_TESTS,
  ],
  [
    "Secondary market: a seller's proceeds are paid before the round settles",
    SM,
    "if ((r.settled || isVoid) && s.lots != 0 && !s.proceedsPaid) {",
    "if (s.lots != 0 && !s.proceedsPaid) {",
    SM_TESTS,
  ],
  [
    "Secondary market: a quote claim is not checked against the round's own intake",
    SM,
    "if (quoteIn[id] < amount) revert LedgerShort();",
    "amount;",
    SM_TESTS,
  ],
  [
    "Secondary market: a quote claim does not draw down the round's intake",
    SM,
    "quoteIn[id] -= amount;",
    "amount;",
    SM_TESTS,
  ],
  [
    "Secondary market: settling does not consume a seller's sold escrow",
    SM,
    "if (sFill[i] != 0) policy.consumeSoldEscrow(seller, uint256(sFill[i]) * lotSize);",
    "sFill[i];",
    SM_TESTS,
  ],
  [
    "Secondary market: settling returns unsold Shares without preparing the escrow return",
    SM,
    "policy.prepareEscrowReturn(seller, unsold);",
    "seller;",
    SM_TESTS,
  ],
  [
    "Secondary market: cancelling an offer returns Shares without preparing the escrow return",
    SM,
    "policy.prepareEscrowReturn(msg.sender, amount);",
    "amount;",
    SM_TESTS,
  ],
  [
    "Secondary market: a void round returns Shares without preparing the escrow return",
    SM,
    "policy.prepareEscrowReturn(who, amount);",
    "amount;",
    SM_TESTS,
  ],
  [
    "Market factory: anyone but the kit creates a market",
    FACTORY,
    "if (msg.sender != authorizedKit) revert NotAuthorizedKit();",
    "authorizedKit;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: a second market for the same DAO",
    FACTORY,
    "if (marketOf[dao] != address(0)) revert AlreadyListed(dao);",
    "dao;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: a DAO that is not the pinned runtime",
    FACTORY,
    "if (_codeHash(dao) != daoRuntimeHash) revert UnprovenDao();",
    "dao;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: a quote token with no code",
    FACTORY,
    "if (address(quote).code.length == 0) revert UnprovenQuote();",
    "quote;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: a lot size of zero or past 128 bits",
    FACTORY,
    "if (lotSize == 0 || lotSize > type(uint128).max) revert InvalidSetup();",
    "lotSize;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: Shares the DAO does not name",
    FACTORY,
    "if (IProvenanceMoloch(dao).shares() != sharesToken) revert UnprovenShares();",
    "sharesToken;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: a policy that is not the DAO's voting weight",
    FACTORY,
    "if (IProvenanceMoloch(dao).votingWeight() != address(policy)) revert UnprovenPolicy();",
    "policy;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: Shares that are not the DAO's own clone",
    FACTORY,
    "if (sharesToken != _predictedShares(dao)) revert UnprovenShares();",
    "sharesToken;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: Shares that name another DAO",
    FACTORY,
    "if (IMarketShareToken(sharesToken).DAO() != dao) revert UnprovenShares();",
    "sharesToken;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: a policy bound to another DAO",
    FACTORY,
    "if (address(policy.dao()) != dao) revert UnprovenPolicy();",
    "policy;",
    FACTORY_TESTS,
  ],
  [
    "Market factory: a policy that names another market",
    FACTORY,
    "if (address(policy.market()) != predict(dao, sharesToken, address(policy), address(quote), lotSize)) {\n            revert UnprovenPolicy();\n        }",
    "// removed",
    FACTORY_TESTS,
  ],
  [
    "Market factory: a policy from another summoner's mandate factory",
    FACTORY,
    "if (address(IProvenancePolicy(address(policy)).mandateFactory()) != address(summoner.mandateFactory())) {\n            revert UnprovenPolicy();\n        }",
    "// removed",
    FACTORY_TESTS,
  ],
  [
    "Market factory: Shares whose exempt endpoint is not the new market",
    FACTORY,
    "if (IMarketShareToken(sharesToken).transferExempt() != address(market)) revert UnprovenShares();",
    "market;",
    FACTORY_TESTS,
  ],
  [
    "Secondary market: a validator can freeze the market's escrow (the exemption in the transfer validator)",
    MOLOCH,
    "        address exempt = transferExempt;\n        if (exempt != address(0) && (from == exempt || to == exempt)) return;\n        if (validator != address(0)",
    "        address exempt = transferExempt;\n        exempt;\n        if (validator != address(0)",
    SHARES_TESTS,
  ],
  [
    "Secondary market: the transfer lock stops the market's escrow (the exemption in the lock check)",
    MOLOCH,
    "    // @@CREABUZZ PATCH BEGIN shares-transfer-exempt\n        address exempt = transferExempt;\n        if (exempt != address(0) && (from == exempt || to == exempt)) return;",
    "    // @@CREABUZZ PATCH BEGIN shares-transfer-exempt\n        address exempt = transferExempt;\n        exempt;",
    SHARES_TESTS,
  ],
  [
    "Secondary market: a move past the founder sale ceiling",
    MOLOCH,
    "if (policy != address(0) && amount > IShareSalePolicy(policy).saleCapacity(from)) {",
    "if (false && amount > IShareSalePolicy(policy).saleCapacity(from)) {",
    SHARES_TESTS,
  ],
  [
    "Activation voting: Shares minted straight to the market",
    AV,
    "if (to == market_ && from == address(0)) revert MintToMarket();",
    "market_;",
    AV_TESTS,
  ],
  [
    "Activation voting: the market is configured after the creation block",
    AV,
    "if (!initialized || initBlock == 0 || block.number != initBlock) revert NotInCreationBlock();",
    "initialized;",
    AV_TESTS,
  ],
  [
    "Activation voting: the market is configured twice",
    AV,
    "if (configured) revert AlreadyConfigured();",
    "configured;",
    AV_TESTS,
  ],
  [
    "Activation voting: a sale schedule whose cliff runs past its length, or with no length",
    AV,
    "initialGrant == 0 || initialGrant > type(uint96).max || cliff > duration || duration == 0",
    "initialGrant == 0 || initialGrant > type(uint96).max",
    AV_TESTS,
  ],
  [
    "Activation voting: the exclusion list stays open after configuring",
    AV,
    "        exclusionsFrozen = true;\n        emit SecondaryConfigured(",
    "        emit SecondaryConfigured(",
    AV_TESTS,
  ],
  [
    "Activation voting: a deposit into the market records no escrow",
    AV,
    "_escrowDeposit(from, amount);",
    "from;",
    AV_TESTS,
  ],
  [
    "Activation voting: a prepared return moves a different amount than prepared",
    AV,
    "if (amount != prepared) revert PreparedReturnMismatch();",
    "prepared;",
    AV_TESTS,
  ],
  [
    "Activation voting: a prepared return can be used twice",
    AV,
    "preparedReturnAmount[to] = 0;",
    "to;",
    AV_TESTS,
  ],
  [
    "Activation voting: a returned offer keeps no original age",
    AV,
    "_unsettleReturn(to, amount);",
    "to;",
    AV_TESTS,
  ],
  [
    "Activation voting: the market's books may claim more than its vault holds",
    AV,
    "if ((marketOutflow || to == market_) && escrowTotalMature + escrowTotalPending > capacity[market_]) {",
    "if (false) {",
    AV_TESTS,
  ],
  [
    "Activation voting: a sale consumes more escrow credit than the seller has",
    AV,
    "if (amount > pendSum + matureOwned) revert MarketInventoryShort();",
    "pendSum;",
    AV_TESTS,
  ],
  [
    "Activation voting: a return is prepared for more than the seller escrowed",
    AV,
    "if (amount > escrowMatureOwned[seller] + _histSum(escrowPend[seller])) revert MarketInventoryShort();",
    "seller;",
    AV_TESTS,
  ],
  [
    "Activation voting: anyone but the market consumes or prepares escrow",
    AV,
    "if (!configured || msg.sender != market_) revert MarketOnly();",
    "market_;",
    AV_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the Shares' own DAO",
    KIT2,
    "tokens.DAO() != made.dao ||",
    "false ||",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the transfer lock",
    KIT2,
    "|| !tokens.transfersLocked()",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the unlock notice",
    KIT2,
    "|| !tokens.unlockNoticeRequired()",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the market as the one exempt endpoint",
    KIT2,
    "|| tokens.transferExempt() != made.market",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the lock guard being empty",
    KIT2,
    "|| tokens.lockGuard() != address(0)",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the lock guard being sealed",
    KIT2,
    "|| !tokens.lockGuardSet()",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the sale policy",
    KIT2,
    "|| tokens.salePolicy() != made.policy",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the sale policy being sealed",
    KIT2,
    "|| !tokens.salePolicyChosen()",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the sale policy version",
    KIT2,
    "|| version != 1",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the founder starting with nothing to sell",
    KIT2,
    "|| eligible != 0",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips awards-only issuance",
    KIT2,
    "|| !tokens.awardsOnly()",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: the read-back skips the issuance cap",
    KIT2,
    "|| tokens.issuanceCapBps() != NO_CAP",
    "|| false",
    KIT_TESTS,
  ],
  // `p.quote == address(0)` is not given an entry: an address with no code is the zero address too, so the next clause
  // already refuses it and removing the first changes nothing.
  [
    "Launch kit V2: a quote token with no code",
    KIT2,
    "|| p.quote.code.length == 0",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: a lot size of zero",
    KIT2,
    "|| p.lotSize == 0",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: a lot size past the bound",
    KIT2,
    "|| p.lotSize > MAX_LOT_SIZE_BOUND",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: a sale schedule with no length",
    KIT2,
    "|| p.saleDuration == 0",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: a sale cliff longer than the schedule",
    KIT2,
    "|| p.saleCliff > p.saleDuration",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: a sale that starts in the past",
    KIT2,
    "|| (p.saleStart != 0 && p.saleStart < block.timestamp)",
    "|| false",
    KIT_TESTS,
  ],
  [
    "Launch kit V2: a sale schedule that runs off the 64-bit clock",
    KIT2,
    "if (uint256(saleStart) + p.saleCliff + p.saleDuration > type(uint64).max) revert InvalidTerms();",
    "saleStart;",
    KIT_TESTS,
  ],
];

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const only = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"))
  .map(Number);
const chosen = MUTATIONS.map((m, i) => [i, ...m]).filter(([i]) => only.length === 0 || only.includes(i));

/** The test files an entry runs: its own list, or the money-path invariants plus the one extra file. */
const testsOf = (extra) => (Array.isArray(extra) ? extra : extra && extra !== "full" ? [extra] : []);

// --list prints every entry as JSON, for the script's own test to check which guards have an entry.
if (flags.includes("--list")) {
  console.log(
    JSON.stringify(
      chosen.map(([i, name, file, guard, broken, extra]) => ({ i, name, file, guard, broken, tests: testsOf(extra) })),
    ),
  );
  process.exit(0);
}

// --check runs no forge: it proves each guard is still in its file exactly once, differs from its broken text, and that
// every test file the entry names exists, so a rewritten guard cannot silently turn an entry into a SKIPPED one.
if (flags.includes("--check")) {
  const problems = [];
  for (const [i, name, file, guard, broken, extra] of chosen) {
    const source = readFileSync(join(ROOT, file), "utf8");
    const found = source.split(guard).length - 1;
    if (found !== 1) problems.push(`${i}. ${name}: the guard is in ${file} ${found} times, not once`);
    if (guard === broken) problems.push(`${i}. ${name}: the broken text equals the guard`);
    for (const t of testsOf(extra)) {
      if (!existsSync(join(ROOT, "contracts", t))) problems.push(`${i}. ${name}: test file ${t} does not exist`);
    }
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`every entry is well formed (${chosen.length} checked)`);
  process.exit(0);
}

const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(chosen.map(([, , f]) => f))], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();
if (dirty) {
  console.error(`refusing to run: these files have uncommitted changes and would be reset:\n${dirty}`);
  process.exit(2);
}

let missed = 0;
for (const [i, name, file, guard, broken, extra] of chosen) {
  const path = join(ROOT, file);
  const source = readFileSync(path, "utf8");
  if (source.split(guard).length !== 2) {
    console.log(`${i}. ${name}: SKIPPED (the guard is not in ${file} exactly once; update this script)`);
    missed++;
    continue;
  }
  writeFileSync(path, source.replace(guard, broken));
  let out;
  try {
    // A filtered run compiles only what it needs; the kit's tests need the full build (they deploy its artifact). An entry
    // that lists its test files runs exactly those and stops at the first failure.
    const args =
      extra === "full"
        ? ["test", "--offline"]
        : Array.isArray(extra)
          ? ["test", "--offline", "--fail-fast", "--match-path", `{${extra.join(",")}}`]
          : ["test", "--offline", "--match-path", extra ? `{test/invariant/*,${extra}}` : "test/invariant/*"];
    out = spawnSync("forge", args, {
      env: { ...process.env, REQUIRE_CONTRACT_ARTIFACTS: "1" },
      cwd: join(ROOT, "contracts"),
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } finally {
    execFileSync("git", ["checkout", "--", file], { cwd: ROOT });
  }
  // A forge that could not even start is an error to stop on, never a mutant that "no test noticed".
  if (out.error) throw out.error;
  const text = `${out.stdout}${out.stderr}`;
  const reason = text.match(/\[FAIL: ([^\]]{0,140})/)?.[1];
  // --fail-fast also marks tests it cancelled as `[FAIL]` (no reason, no gas), so name the one that carries a reason.
  const failedTest = text.match(/\[FAIL: .*\]\s+(\w+\()/)?.[1];
  if (/Compiler run failed/.test(text)) {
    console.log(`${i}. ${name}: COMPILE ERROR`);
    missed++;
  } else if (reason) {
    console.log(`${i}. ${name}: caught by ${failedTest ? `${failedTest})` : "a test"} (${reason.replace(/; counterexample.*/, "")})`);
  } else if (out.status !== 0) {
    const tail = text.split("\n").filter((l) => l.trim() && !/^\s*(-->|\|)|^Warning/.test(l)).slice(-6).join("\n    ");
    console.log(`${i}. ${name}: ERROR (forge exited ${out.status} and no test failed)\n    ${tail}`);
    missed++;
  } else {
    console.log(`${i}. ${name}: MISSED`);
    missed++;
  }
}
console.log(missed === 0 ? "every mutation was caught" : `${missed} mutation(s) not caught`);
process.exit(missed === 0 ? 0 : 1);
