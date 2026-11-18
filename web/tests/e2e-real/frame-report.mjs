/**
 * The frame meter's numbers for a whole run (`frame-meter.ts` writes one JSON line per test):
 *
 *   node tests/e2e-real/frame-report.mjs <report.jsonl> [per-second limit]
 *
 * Prints the busiest tests, the run's peak in any 5 seconds for one account, and every request the server refused for
 * its request limit. With the limit, a peak above 5 times it is marked. Always exits 0 when the file reads: it measures,
 * the specs judge. `scripts/web-social-e2e.sh` runs it after the specs when SOCIAL_FRAME_REPORT=1.
 */
import { existsSync, readFileSync } from "node:fs";

import { WINDOW_MS } from "./frame-count.mjs";

const [file, perSecond] = process.argv.slice(2);
if (!file) {
  console.error("usage: frame-report.mjs <report.jsonl> [per-second limit]");
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(
    `[frames] no report at ${file}: no spec that imports ./frame-meter ran, or SOCIAL_FRAME_REPORT was not 1`,
  );
  process.exit(1);
}
const tests = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
const budget = Number(perSecond)
  ? Number(perSecond) * (WINDOW_MS / 1000)
  : null;

let peak = { value: 0, account: "", title: "" };
let refused = 0;
for (const t of tests) {
  for (const a of t.accounts) {
    refused += a.refused;
    if (a.peak > peak.value)
      peak = { value: a.peak, account: a.account, title: t.title };
  }
}

const seconds = WINDOW_MS / 1000;
console.log(`[frames] ${tests.length} tests measured`);
for (const t of [...tests].sort((a, b) => b.peak - a.peak).slice(0, 5)) {
  console.log(`[frames]   ${t.peak} in ${seconds} s  ${t.file}: ${t.title}`);
}
console.log(
  `[frames] run peak: ${peak.value} in ${seconds} s by ${peak.account || "nobody"}${peak.title ? ` (${peak.title})` : ""}`,
);
// Peaks are per test (a burst across two tests is split), and the specs' own Node-side reads and posts are not counted.
console.log(
  "[frames] (a slight undercount: leave headroom above it when setting the limit)",
);
if (budget !== null) {
  const verdict =
    peak.value > budget
      ? `OVER the limit of ${budget} (${perSecond} a second)`
      : `within the limit of ${budget} (${perSecond} a second), ${Math.round((peak.value / budget) * 100)}% of it`;
  console.log(`[frames] ${verdict}`);
}
console.log(
  `[frames] requests the server refused for its request limit: ${refused}`,
);
