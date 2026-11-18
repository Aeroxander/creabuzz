#!/usr/bin/env node
/**
 * The app's first-load budget, run after `vite build`: the entry chunk stays under BUDGET_BYTES, and nothing but the
 * service worker sits in the dist root (the relay serves only /assets/* as files; see the report's open items for
 * /sw.js).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BUDGET_BYTES = 450_000; // entry chunk, uncompressed
const DIST = join(process.cwd(), "dist");
const ASSETS = join(DIST, "assets");
const ROOT_FILES_ALLOWED = new Set(["index.html", "sw.js", "assets"]);

let failed = false;
const js = readdirSync(ASSETS).filter((name) => name.endsWith(".js"));
const entry = js.filter((name) => name.startsWith("index-"));
if (entry.length === 0) {
  console.error("Could not find the entry chunk (index-*.js) in dist/assets.");
  process.exit(1);
}
let total = 0;
for (const name of js) total += statSync(join(ASSETS, name)).size;
for (const name of entry) {
  const size = statSync(join(ASSETS, name)).size;
  const ok = size <= BUDGET_BYTES;
  console.log(
    `${name} ${(size / 1024).toFixed(0)} KiB ${ok ? "ok" : "OVER BUDGET"}`,
  );
  if (!ok) failed = true;
}
console.log(`all scripts ${(total / 1024).toFixed(0)} KiB`);
const strays = readdirSync(DIST).filter(
  (name) => !ROOT_FILES_ALLOWED.has(name),
);
if (strays.length > 0) {
  console.error(
    `Files in the dist root the relay will not serve: ${strays.join(", ")}`,
  );
  failed = true;
}
if (failed) process.exit(1);
