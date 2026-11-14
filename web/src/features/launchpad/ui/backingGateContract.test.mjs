import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The Backing block's switch. The mocked browser suite runs ordinary builds and cannot change the build's settings inside
 * a test, so, as in `pilotGatesContract.test.mjs`, the source is the seam for the gates that live in components. The
 * browser side is `tests/e2e/investing.spec.ts`, which runs against a build that names every address and leaves the switch
 * unset, and fails if the block renders there. These fail when a gate is removed or moved below a hook.
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("the Backing block is a component whose first statement is the switch, before any hook", () => {
  const block = source("./BackingBlock.tsx");
  const gate = block.slice(block.indexOf("export function BackingBlock("));
  assert.match(
    gate,
    /export function BackingBlock\([\s\S]*?\) \{\n {2}if \(!investingOffered\(\)\) return null;\n {2}return props\.variant === "page"/,
  );
  // No hook runs in the gate itself: the hooks are in the two components below it.
  const head = gate.slice(0, gate.indexOf("function ScorecardBacking"));
  assert.doesNotMatch(head, /\buse[A-Z]\w*\(/);
});

test("both pages put the block where the record is read first, and nowhere else", () => {
  const page = source("./LaunchDetailPage.tsx");
  assert.equal([...page.matchAll(/<BackingBlock\b/g)].length, 1);
  assert.match(
    page,
    /<ProjectRecordCard isFounder=\{isFounder\} launch=\{launch\} \/>[\s\S]*?<BackingBlock isFounder=\{isFounder\} launch=\{launch\} variant="page" \/>/,
  );
  const card = source("../../scorecard/ui/ScorecardPage.tsx");
  assert.equal([...card.matchAll(/<BackingBlock\b/g)].length, 1);
  assert.match(
    card,
    /<BackingBlock isFounder=\{false\} launch=\{launch\} variant="scorecard" \/>/,
  );
});

test("the one switch is the build's own: nothing reads investing from anywhere else", () => {
  const offered = source("../lib/investing-offered.ts");
  assert.match(offered, /env\?\.VITE_INVESTING\?\.trim\(\) === "1"/);
  assert.match(
    offered,
    /return\s*\(?\s*investingSwitchOn\(env\)\s*&&\s*namesAnyAddress\(\s*env\?\.VITE_BACKING_POOL_FACTORY/,
  );
  // The pool target is off whenever investing is off, so a pool is never read for a project the switch left out.
  const target = source("../lib/backing-target.ts");
  assert.match(
    target,
    /if \(!investingOffered\(env\)\) return \{ kind: "off" \};/,
  );
});
