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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    "        if (b.paidClaim != 0) revert AlreadyPaid(id);\n        uint32 claim = b.runClaim;",
    "        uint32 claim = b.runClaim;",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: refund after payment",
    "contracts/src/OpenBounty.sol",
    "        if (b.paidClaim != 0) revert AlreadyPaid(id);\n        if (!_refundsOpen(b))",
    "        if (!_refundsOpen(b))",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: refunds open while a run is on",
    "contracts/src/OpenBounty.sol",
    "(block.timestamp >= b.deadline && b.runClaim == 0)",
    "(block.timestamp >= b.deadline)",
    "test/OpenBounty.t.sol",
  ],
  [
    "N2: refunds open before the deadline",
    "contracts/src/OpenBounty.sol",
    "(block.timestamp >= b.deadline && b.runClaim == 0)",
    "(b.runClaim == 0)",
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
    "N5: anyone passes the lock once an exchange is named",
    "contracts/src/majeur/MolochPatched.sol",
    "if (exchange != address(0) && msg.sender == exchange) return;",
    "if (exchange != address(0)) return;",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: the exchange switches on without the 30 days",
    "contracts/src/majeur/MolochPatched.sol",
    "if (pending == address(0) || block.timestamp < uint256(exitExchangeAnnouncedAt) + UNLOCK_NOTICE) {",
    "if (pending == address(0)) {",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: an offer fills at its expiry",
    "contracts/src/MatchedExit.sol",
    "if (block.timestamp >= offer.expiry) revert OfferExpired(offer.expiry);",
    "if (block.timestamp > offer.expiry) revert OfferExpired(offer.expiry);",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: cancelling below a number does not stop a fill",
    "contracts/src/MatchedExit.sol",
    "if (offer.nonce < minNonce[offer.seller]) revert NonceCancelled();",
    "// removed",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: a filled or cancelled offer fills again",
    "contracts/src/MatchedExit.sol",
    "if (used[digest]) revert OfferUsed();",
    "// removed",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: a fill does not use up the offer",
    "contracts/src/MatchedExit.sol",
    "        used[digest] = true;\n        uint256 before",
    "        uint256 before",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: the signature is not checked",
    "contracts/src/MatchedExit.sol",
    "if (!_signedBy(offer.seller, digest, signature)) revert BadSignature();",
    "// removed",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: a seller is paid less than asked",
    "contracts/src/MatchedExit.sol",
    "if (received != offer.price) revert ShortPayment(offer.price, received);",
    "// removed",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: anyone cancels someone else's offer",
    "contracts/src/MatchedExit.sol",
    "if (msg.sender != offer.seller) revert NotSeller();",
    "// removed",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: a key that is not the seller's signs for them",
    "contracts/src/MatchedExit.sol",
    "if (err == ECDSA.RecoverError.NoError && recovered == seller) return true;",
    "if (err == ECDSA.RecoverError.NoError) return true;",
    "test/MatchedExit.t.sol",
  ],
  [
    "N5: a filled offer still shows as open",
    "contracts/src/MatchedExit.sol",
    "return !used[digest] && _signedBy",
    "return _signedBy",
    "test/MatchedExit.t.sol",
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
    "N8: bets after the close",
    "contracts/src/ForecastPool.sol",
    "p.outcome != OPEN || paidClaim != 0 || runClaim != 0 || block.timestamp + CLOSE_BEFORE >= deadline",
    "p.outcome != OPEN || paidClaim != 0 || runClaim != 0",
    "test/ForecastPool.t.sol",
  ],
  [
    "N8: bets while work is winning",
    "contracts/src/ForecastPool.sol",
    "p.outcome != OPEN || paidClaim != 0 || runClaim != 0 || block.timestamp",
    "p.outcome != OPEN || paidClaim != 0 || block.timestamp",
    "test/ForecastPool.t.sol",
  ],
  [
    "N8: the bounty's creator bets against it",
    "contracts/src/ForecastPool.sol",
    "if (!yes && (msg.sender == creator || bounties.openClaim(id, msg.sender) != 0)) revert Barred(id);",
    "if (!yes && bounties.openClaim(id, msg.sender) != 0) revert Barred(id);",
    "test/ForecastPool.t.sol",
  ],
  [
    "N8: a claimant bets against the work",
    "contracts/src/ForecastPool.sol",
    "if (!yes && (msg.sender == creator || bounties.openClaim(id, msg.sender) != 0)) revert Barred(id);",
    "if (!yes && msg.sender == creator) revert Barred(id);",
    "test/ForecastPool.t.sol",
  ],
  [
    "N8: a wallet goes over the cap",
    "contracts/src/ForecastPool.sol",
    "if (already + amount > CAP) revert OverCap(id, CAP - already);",
    "// removed",
    "test/ForecastPool.t.sol",
  ],
  [
    "N8: settles no before refunds open",
    "contracts/src/ForecastPool.sol",
    "else if (bounties.refundsOpen(id)) outcome = NO;",
    "else if (true) outcome = NO;",
    "test/ForecastPool.t.sol",
  ],
  [
    "N8: an empty winning side keeps everyone's money",
    "contracts/src/ForecastPool.sol",
    "if ((outcome == YES ? p.yes : p.no) == 0) outcome = VOID;",
    "// removed",
    "test/ForecastPool.t.sol",
  ],
  [
    "N8: a bettor collects twice",
    "contracts/src/ForecastPool.sol",
    "collected[id][who] = true;",
    "// removed",
    "test/ForecastPool.t.sol",
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
];

const only = process.argv.slice(2).map(Number);
const chosen = MUTATIONS.map((m, i) => [i, ...m]).filter(([i]) => only.length === 0 || only.includes(i));

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
    // A filtered run compiles only what it needs; the kit's tests need the full build (they deploy its artifact).
    const args = extra === "full" ? ["test"] : ["test", "--match-path", extra ? `{test/invariant/*,${extra}}` : "test/invariant/*"];
    out = spawnSync("forge", args, {
      env: { ...process.env, REQUIRE_CONTRACT_ARTIFACTS: "1" },
      cwd: join(ROOT, "contracts"),
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } finally {
    execFileSync("git", ["checkout", "--", file], { cwd: ROOT });
  }
  const text = `${out.stdout}${out.stderr}`;
  const reason = text.match(/\[FAIL: ([^\]]{0,140})/)?.[1];
  if (/Compiler run failed/.test(text)) {
    console.log(`${i}. ${name}: COMPILE ERROR`);
    missed++;
  } else if (reason) {
    console.log(`${i}. ${name}: caught (${reason.replace(/; counterexample.*/, "")})`);
  } else {
    console.log(`${i}. ${name}: MISSED`);
    missed++;
  }
}
console.log(missed === 0 ? "every mutation was caught" : `${missed} mutation(s) not caught`);
process.exit(missed === 0 ? 0 : 1);
