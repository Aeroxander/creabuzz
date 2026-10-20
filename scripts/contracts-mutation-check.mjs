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
