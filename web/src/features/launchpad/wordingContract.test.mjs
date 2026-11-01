import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The words people read on a project (suite review, decision 8): the founder's short list is "Priorities", never "Now",
 * and the shares that carry no vote are "non-voting shares", never "Loot", "new units" or "(units)". "Shares" stays the name for
 * voting shares. The components and the core describe texts are the seam: comments, identifiers and record fields are
 * left alone, so the source is read with its comments taken out and checked for the old words as words.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const roots = [
  here,
  join(here, "../../../../packages/creaton-core/src/launchpad"),
];

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* sources(path);
    } else if (/\.(ts|tsx)$/.test(name) && !name.includes(".test.")) {
      yield path;
    }
  }
}

/** The source without its comments, line numbers kept. */
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const hits = (pattern) => {
  const found = [];
  for (const root of roots) {
    for (const path of sources(root)) {
      withoutComments(readFileSync(path, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          if (pattern.test(line))
            found.push(`${relative(root, path)}:${i + 1}: ${line.trim()}`);
        });
    }
  }
  return found;
};

test('the founder\'s short list reads "Priorities", not "Now"', () => {
  assert.deepEqual(hits(/\bNow\b/), []);
});

test('shares with no vote read "non-voting shares", not "Loot" or "new units"', () => {
  assert.deepEqual(
    hits(/\bLoot\b|\bnew units\b|\bNew units\b|\w \(units\)/),
    [],
  );
});
