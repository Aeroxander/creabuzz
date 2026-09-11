#!/usr/bin/env node
/**
 * Bundle-size budget for the web client's first load.
 *
 * The heavy views (wiki, fleet, work board, search) and the heavy routes
 * (repos, launchpad) are code-split on purpose: reading a channel must not
 * download them. This gate fails if the entry chunk grows past the budget,
 * which is what a stray static import of a heavy feature would do.
 *
 * Run after `pnpm build`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BUDGET_BYTES = 1_000_000; // entry chunk, uncompressed
const ASSET_DIR = join(process.cwd(), "dist", "assets");

/** Chunks that must not be reachable from the entry chunk on first load. */
const LAZY_CHUNKS = [
  "WikiView",
  "WorkBoard",
  "FleetView",
  "ReposPage",
  "LaunchDetailPage",
];

let files;
try {
  files = readdirSync(ASSET_DIR).filter((name) => name.endsWith(".js"));
} catch {
  console.error(`No build output in ${ASSET_DIR}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const entry = files.filter((name) => name.startsWith("index-"));
if (entry.length === 0) {
  console.error("Could not find the entry chunk (index-*.js) in dist/assets.");
  process.exit(1);
}

let failed = false;
let total = 0;
for (const name of entry) {
  const size = statSync(join(ASSET_DIR, name)).size;
  total += size;
  const status = size <= BUDGET_BYTES ? "ok" : "OVER BUDGET";
  console.log(`${name} ${size} bytes (${MIB(size)}) — ${status}`);
  if (size > BUDGET_BYTES) failed = true;
}

const missing = LAZY_CHUNKS.filter(
  (prefix) => !files.some((name) => name.startsWith(`${prefix}-`)),
);
if (missing.length > 0) {
  console.error(
    `Expected these to be separate chunks, but found no chunk for: ${missing.join(", ")}`,
  );
  failed = true;
}

function MIB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

if (failed) {
  console.error(
    `\nWeb bundle budget failed (entry budget ${MIB(BUDGET_BYTES)}; entry total ${MIB(total)}).`,
  );
  process.exit(1);
}
console.log(
  `\nWeb bundle budget ok: entry ${MIB(total)}, ${LAZY_CHUNKS.length} heavy chunks split out.`,
);
