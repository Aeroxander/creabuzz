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
