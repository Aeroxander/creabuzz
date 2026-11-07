#!/usr/bin/env node
// Fails when contracts/foundry.lock disagrees with the submodule gitlinks that
// actually pin contracts/lib/* (the lock documented one commit, the checkout
// used another, and nothing noticed). Run from anywhere:
//
//   node scripts/check-foundry-lock.mjs
//
// Also exported (`checkFoundryLock`) so scripts/check-foundry-lock.test.mjs can
// drive it with fixtures.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {Record<string,string>} lib path -> rev the lock pins */
export function lockRevs(lock) {
  const out = {};
  for (const [path, entry] of Object.entries(lock)) {
    out[path] = entry.tag ? entry.tag.rev : entry.rev;
  }
  return out;
}

/**
 * @param {Record<string,string>} locked lib path (`lib/x`) -> pinned rev
 * @param {Record<string,string>} gitlinks lib path (`lib/x`) -> gitlink sha
 * @returns {string[]} human-readable problems (empty = consistent)
 */
export function checkFoundryLock(locked, gitlinks) {
  const problems = [];
  for (const [path, rev] of Object.entries(locked)) {
    const link = gitlinks[path];
    if (!link) problems.push(`${path}: in foundry.lock but not a submodule gitlink`);
    else if (link !== rev) {
      problems.push(`${path}: foundry.lock pins ${rev} but the gitlink is ${link}`);
    }
  }
  for (const path of Object.keys(gitlinks)) {
    if (!(path in locked)) problems.push(`${path}: gitlink has no foundry.lock entry`);
  }
  return problems;
}

function readGitlinks() {
  const raw = execFileSync("git", ["ls-tree", "HEAD", "contracts/lib/"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const out = {};
  for (const line of raw.split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    const [, type, sha] = meta.split(" ");
    if (type === "commit") out[path.replace(/^contracts\//, "")] = sha;
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(resolve(repoRoot, "contracts/foundry.lock"), "utf8"));
  const problems = checkFoundryLock(lockRevs(lock), readGitlinks());
  if (problems.length > 0) {
    console.error("contracts/foundry.lock disagrees with the submodule gitlinks:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("contracts/foundry.lock matches the submodule gitlinks");
}
