#!/usr/bin/env node
//
// scripts/screen-audit-unique.mjs <shots-dir> — fail when two screen-audit stops saved the same picture.
//
// Two stops with byte-identical PNGs almost always mean one of them never reached its own state (a click on a control
// that is hidden at that width, a dialog that never opened), so its picture passed for something it is not. Equal
// pictures are allowed only when all but one of them is explained: the page sent the stop elsewhere (`redirected`, a
// route the build does not offer), or the stop says it looks like another stop of the group (`sameAs`, a tab the page
// shows as another). Reads `<shots-dir>/index.ndjson` as `web/tests/e2e-real/screen-audit.spec.ts` writes it; the last
// line for a stop and width wins, as a rerun overwrites its picture.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The captures in an index, one per stop and width (the last line wins), leaving out stops checked without a picture. */
export function capturesFromIndex(ndjson) {
  const byKey = new Map();
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    byKey.set(`${record.stop}-${record.variant}`, record);
  }
  return [...byKey.values()].filter((record) => !record.checked);
}

/**
 * Groups of captures with the same picture that nothing explains. `hashOf(record)` gives a picture's hash (or null when
 * the file is missing). A group passes when at most one member is unexplained, a member being explained by a redirect
 * or by a `sameAs` naming another member of the group.
 */
export function unexplainedDuplicates(captures, hashOf) {
  const groups = new Map();
  for (const record of captures) {
    const hash = hashOf(record);
    if (!hash) continue;
    const group = groups.get(hash) ?? [];
    group.push(record);
    groups.set(hash, group);
  }
  const problems = [];
  for (const [hash, group] of groups) {
    if (group.length < 2) continue;
    const names = new Set(group.map((record) => record.stop));
    const unexplained = group.filter(
      (record) =>
        !record.redirected &&
        !(
          record.sameAs &&
          record.sameAs !== record.stop &&
          names.has(record.sameAs)
        ),
    );
    if (unexplained.length > 1) {
      problems.push({
        hash,
        captures: group
          .map((record) => `${record.stop}-${record.variant}`)
          .sort(),
      });
    }
  }
  return problems;
}

function main(dir) {
  const index = join(dir, "index.ndjson");
  if (!existsSync(index)) {
    console.error(`screen-audit-unique: no index at ${index}`);
    return 1;
  }
  const captures = capturesFromIndex(readFileSync(index, "utf8"));
  const hashOf = (record) => {
    const file = join(dir, `${record.stop}-${record.variant}.png`);
    if (!existsSync(file)) return null;
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  };
  const problems = unexplainedDuplicates(captures, hashOf);
  for (const problem of problems) {
    console.error(
      `same picture (${problem.hash.slice(0, 12)}): ${problem.captures.join(", ")}: at most one of these reached its own state`,
    );
  }
  if (problems.length === 0)
    console.log(`${captures.length} captures, every picture its own`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: scripts/screen-audit-unique.mjs <shots-dir>");
    process.exit(2);
  }
  process.exit(main(dir));
}
