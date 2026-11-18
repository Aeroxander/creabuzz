#!/usr/bin/env node
// The event signatures the relay's chain reader decodes, taken from the
// contracts/next build (`forge build` in contracts/next):
//
//   node scripts/chain-reader-events.mjs           # rewrite the list
//   node scripts/chain-reader-events.mjs --check   # fail when the list is stale
//
// Output: crates/buzz-relay/src/chain_reader/testdata/next-events.json, one
// sorted list of canonical signatures ("Name(type,type)", structs as tuples)
// per contract. The Rust test `the_catalog_matches_every_recorded_event`
// compares the reader's event list with this file, so it runs in CI without a
// contracts/next build. Run this after changing an event in contracts/next/src
// and add the event to crates/buzz-relay/src/chain_reader/events.rs.
// `--check` without a build (no contracts/next/out) says so and fails.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(repoRoot, "contracts/next/out");
const LIST = resolve(
  repoRoot,
  "crates/buzz-relay/src/chain_reader/testdata/next-events.json",
);
const CONTRACTS = ["Launcher", "Rounds", "Vester", "Treasury", "Finisher", "Pair", "ShareToken"];
// Allowances are not followed.
const SKIPPED = new Set(["ShareToken.Approval"]);

/** @param {{type: string, components?: object[]}} input */
function canonical(input) {
  if (input.type.startsWith("tuple")) {
    const inner = (input.components ?? []).map(canonical).join(",");
    return `(${inner})${input.type.slice("tuple".length)}`;
  }
  return input.type;
}

/** @returns {Record<string, string[]>} */
export function signaturesFromBuild(outDir = OUT_DIR) {
  /** @type {Record<string, string[]>} */
  const list = {};
  for (const name of CONTRACTS) {
    const path = resolve(outDir, `${name}.sol`, `${name}.json`);
    const abi = JSON.parse(readFileSync(path, "utf8")).abi;
    list[name] = abi
      .filter((item) => item.type === "event" && !SKIPPED.has(`${name}.${item.name}`))
      .map((item) => `${item.name}(${item.inputs.map(canonical).join(",")})`)
      .sort();
  }
  return list;
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(OUT_DIR)) {
    console.error("contracts/next/out is missing: run `forge build` in contracts/next first");
    process.exit(1);
  }
  const text = `${JSON.stringify(signaturesFromBuild(), null, 2)}\n`;
  if (check) {
    const current = existsSync(LIST) ? readFileSync(LIST, "utf8") : "";
    if (current !== text) {
      console.error(
        "next-events.json does not match the contracts/next build: run node scripts/chain-reader-events.mjs, then add the new events to crates/buzz-relay/src/chain_reader/events.rs",
      );
      process.exit(1);
    }
    console.log("next-events.json matches the contracts/next build");
    return;
  }
  writeFileSync(LIST, text);
  console.log(`wrote ${LIST}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
