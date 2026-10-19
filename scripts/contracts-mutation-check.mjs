#!/usr/bin/env node
/**
 * scripts/contracts-mutation-check.mjs — break each money-path guard once and check that a test fails.
 *
 * For every entry below it replaces one guard in a contract (or in the web exit preview) with a broken version, runs the
 * money-path invariant and fuzz tests (`contracts/test/invariant/`), and puts the file back with `git checkout`. A guard
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

/** [what is broken, file (from the repo root), the guard, its broken replacement] */
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
    "web exit preview ignores the DAO's own Shares",
    "web/src/features/launchpad/lib/ragequit-position.ts",
    "return input.daoHeld >= outstanding ? 0n : outstanding - input.daoHeld;",
    "return outstanding;",
  ],
  [
    "web exit preview offers locked Shares",
    "web/src/features/launchpad/lib/ragequit-position.ts",
    "return locked >= balance ? 0n : balance - locked;",
    "return balance;",
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
for (const [i, name, file, guard, broken] of chosen) {
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
    out = spawnSync("forge", ["test", "--match-path", "test/invariant/*"], {
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
