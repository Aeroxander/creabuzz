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

const { HOW_WORK_COUNTS, SELF_CHECKED_LABEL, SELF_CHECKED_VIEWER_LABEL } =
  await import("./lib/tasks.ts");
const { doneAloneLine } = await import("./lib/task-checks.ts");

test('work the founder checked is "done, checked by the founder" ("by you" to the founder), never "accepted"', () => {
  assert.equal(SELF_CHECKED_LABEL, "Done, checked by the founder");
  assert.equal(SELF_CHECKED_VIEWER_LABEL, "Done, checked by you");
  assert.equal(
    doneAloneLine(1),
    "1 piece of work done, checked by the founder",
  );
  for (const words of [
    SELF_CHECKED_LABEL,
    SELF_CHECKED_VIEWER_LABEL,
    doneAloneLine(2),
  ])
    assert.doesNotMatch(words, /accept|working alone/i, words);
});

test("how work counts is said once, in these words", () => {
  assert.equal(
    HOW_WORK_COUNTS,
    "Work is accepted when someone on the team, other than the person who did it, checks it. A founder with nobody else on the team can check their own work: it shows as done, checked by the founder, and is counted apart.",
  );
});

// "Working alone" was the old name for the founder's own check. Files that still say it are listed so it cannot spread;
// a file leaves this list when it is reworded (the list may only shrink).
const STILL_SAYS_WORKING_ALONE = new Set([
  "launchpad/ui/PersonTrackRecord.tsx",
  "launchpad/ui/PublicRecord.tsx",
  "feed/ui/RecordFeed.tsx",
]);

test('no screen calls the founder\'s own check "working alone", except the files still to be reworded', () => {
  const featuresRoot = join(here, "..");
  const found = [];
  for (const path of sources(featuresRoot)) {
    const file = relative(featuresRoot, path);
    if (STILL_SAYS_WORKING_ALONE.has(file)) continue;
    withoutComments(readFileSync(path, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (/working alone/i.test(line)) found.push(`${file}:${i + 1}`);
      });
  }
  assert.deepEqual(found, []);
});
