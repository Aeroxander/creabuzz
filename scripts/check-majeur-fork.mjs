#!/usr/bin/env node
/**
 * The Majeur fork may differ from upstream ONLY inside marked regions.
 *
 * `contracts/src/majeur/MolochPatched.sol` is a copy of
 * `contracts/lib/majeur/src/Moloch.sol` with the voting-weight patch applied
 * (docs/token-voting-design.md §7). Every changed line sits between
 *
 *     // @@CREABUZZ PATCH BEGIN <name>
 *     ...
 *     // @@CREABUZZ PATCH END <name>
 *
 * Strip those blocks and the two files must be byte-identical. That is what
 * makes the fork reviewable: a reviewer reads the patch regions and knows
 * nothing else moved, and an upstream fix can be re-copied without losing our
 * changes.
 *
 * Run from anywhere: `node scripts/check-majeur-fork.mjs`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORK = join(root, "contracts/src/majeur/MolochPatched.sol");
const UPSTREAM = join(root, "contracts/lib/majeur/src/Moloch.sol");

const BEGIN = /^\s*\/\/ @@CREABUZZ PATCH BEGIN\s+(\S+)\s*$/;
const END = /^\s*\/\/ @@CREABUZZ PATCH END\s+(\S+)\s*$/;

/** Remove every marked block, markers included. */
export function stripPatchRegions(source) {
  const out = [];
  let open = null;
  for (const [i, line] of source.split("\n").entries()) {
    const begin = line.match(BEGIN);
    if (begin) {
      if (open) {
        throw new Error(
          `nested patch region: "${begin[1]}" opens at line ${i + 1} while "${open}" is still open`,
        );
      }
      open = begin[1];
      continue;
    }
    const end = line.match(END);
    if (end) {
      if (!open) {
        throw new Error(`patch region "${end[1]}" closes at line ${i + 1} but nothing was open`);
      }
      if (end[1] !== open) {
        throw new Error(`patch region "${open}" closed by "${end[1]}" at line ${i + 1}`);
      }
      open = null;
      continue;
    }
    if (!open) out.push(line);
  }
  if (open) throw new Error(`patch region "${open}" is never closed`);
  return out.join("\n");
}

/** Every region name, in order, and whether each contains anything. */
export function patchRegions(source) {
  const regions = [];
  let current = null;
  for (const line of source.split("\n")) {
    const begin = line.match(BEGIN);
    if (begin) {
      current = { name: begin[1], lines: 0 };
      continue;
    }
    const end = line.match(END);
    if (end) {
      regions.push(current);
      current = null;
      continue;
    }
    if (current) current.lines += 1;
  }
  return regions;
}

function firstDifference(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) {
      return {
        line: i + 1,
        fork: left[i] ?? "<end of file>",
        upstream: right[i] ?? "<end of file>",
      };
    }
  }
  return null;
}

const fork = readFileSync(FORK, "utf8");
const upstream = readFileSync(UPSTREAM, "utf8");

/**
 * Compare the fork against upstream. Exported so the guard itself is testable
 * — a check nobody can break protects nothing.
 */
export function checkFork(forkSource, upstreamSource) {
  let stripped;
  try {
    stripped = stripPatchRegions(forkSource);
  } catch (error) {
    return { ok: false, message: `check-majeur-fork: ${error.message}` };
  }

  const regions = patchRegions(forkSource);
  const empty = regions.filter((r) => r.lines === 0);
  if (empty.length > 0) {
    return {
      ok: false,
      message: `check-majeur-fork: empty patch region(s): ${empty
        .map((r) => r.name)
        .join(", ")}`,
    };
  }

  const diff = firstDifference(stripped, upstreamSource);
  if (diff) {
    return {
      ok: false,
      message: [
        "check-majeur-fork: the fork differs from upstream OUTSIDE a patch region.",
        `  first difference at line ${diff.line}:`,
        `    fork:     ${diff.fork}`,
        `    upstream: ${diff.upstream}`,
        "",
        "Every change must sit between `// @@CREABUZZ PATCH BEGIN <name>` and",
        "`// @@CREABUZZ PATCH END <name>`. Anything else is an unreviewable edit",
        "to a contract we do not own (docs/token-voting-design.md §7).",
      ].join("\n"),
    };
  }

  const changed = regions.reduce((n, r) => n + r.lines, 0);
  return {
    ok: true,
    message: `check-majeur-fork: ok — ${regions.length} patch region(s), ${changed} line(s), nothing else changed`,
    regions,
  };
}

// Only run against the real files when executed directly; importing this
// module from its tests must not exit the process.
const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = checkFork(fork, upstream);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
}
