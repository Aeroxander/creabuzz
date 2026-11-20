#!/usr/bin/env node
// Account call data as the app builds it, written down for the relay's sponsor to read back.
//
//   node --experimental-strip-types scripts/sponsor-calldata-vectors.mjs           # rewrite the vectors
//   node --experimental-strip-types scripts/sponsor-calldata-vectors.mjs --check   # fail when they are stale
//
// The sponsored-fee limit (`crates/buzz-relay/src/api/sponsor`) tells an exit (Take out) from other operations by reading
// the account's call data. The Rust reader must agree with the app's own `decodeExecuteCallData` on the same bytes, so the
// bytes are made here by the app's own encoder (`packages/creaton-core/src/aa/sponsoredSender.ts`) and the Rust test reads
// them from `crates/buzz-relay/src/api/sponsor/calldata_vectors.json`. Nothing is typed by hand: the exit calls come from
// `pot-calls.ts` (`leaveCall`, `leaveTeamCall`). The invalid rows are call data this script has checked the app's decoder
// refuses.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeExecuteCallData,
  encodeExecuteCallData,
} from "../packages/creaton-core/src/aa/sponsoredSender.ts";
import { leaveCall, leaveTeamCall } from "../packages/creaton-core/src/pot/pot-calls.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = resolve(repoRoot, "crates/buzz-relay/src/api/sponsor/calldata_vectors.json");

const treasury = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const other = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const holder = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const valid = [
  ["a single call with no data", [{ to: other, data: "0x", value: "0x0" }]],
  ["a single call with data", [{ to: other, data: "0xdeadbeef", value: "0x0" }]],
  ["a single call that carries value", [{ to: other, data: "0xdeadbeef", value: "0x2a" }]],
  ["a single call with a long data", [{ to: other, data: `0x${"ab".repeat(100)}`, value: "0x0" }]],
  ["a take out", [leaveCall({ treasury, shares: 1_000_000_000_000_000_000n, minCash: 5n, to: holder })]],
  ["a take out of Team Shares", [leaveTeamCall({ treasury, shares: 7n, minCash: 0n, to: holder })]],
  [
    "a batch of two",
    [
      { to: other, data: "0x095ea7b3", value: "0x0" },
      { to: treasury, data: `0x${"cd".repeat(36)}`, value: "0x0" },
    ],
  ],
  [
    "a batch of three with odd data lengths",
    [
      { to: other, data: "0x", value: "0x0" },
      { to: treasury, data: `0x${"01".repeat(33)}`, value: "0x0" },
      { to: holder, data: `0x${"02".repeat(64)}`, value: "0x1" },
    ],
  ],
  [
    "a take out and something else in one batch",
    [
      leaveCall({ treasury, shares: 3n, minCash: 1n, to: holder }),
      { to: other, data: "0x095ea7b3", value: "0x0" },
    ],
  ],
  [
    "two take outs in one batch",
    [
      leaveCall({ treasury, shares: 3n, minCash: 1n, to: holder }),
      leaveTeamCall({ treasury, shares: 4n, minCash: 2n, to: holder }),
    ],
  ],
].map(([name, calls]) => {
  const callData = encodeExecuteCallData(calls);
  const back = decodeExecuteCallData(callData);
  if (back.length !== calls.length) throw new Error(`${name}: the app's decoder disagrees with its encoder`);
  return { name, calls: back, callData };
});

const single = encodeExecuteCallData([{ to: other, data: "0xdeadbeef", value: "0x0" }]);
const batch = encodeExecuteCallData([
  { to: other, data: "0x", value: "0x0" },
  { to: treasury, data: "0xdeadbeef", value: "0x0" },
]);
const invalid = [
  ["a different function", `0xa9059cbb${single.slice(10)}`],
  ["cut short", single.slice(0, single.length - 64)],
  ["extra bytes after the call data", `${single}00`],
  ["padding that is not zero", `${single.slice(0, -2)}01`],
  ["an unknown mode", `0x${single.slice(2, 10)}02${single.slice(12)}`],
  ["a batch with a different count", `${batch.slice(0, 2 + 8 + 64 + 64 + 64 + 64)}${"00".repeat(31)}05${batch.slice(2 + 8 + 64 + 64 + 64 + 64 + 64)}`],
  ["not hex", "0xzz"],
  ["empty", "0x"],
].map(([name, callData]) => {
  let refused = false;
  try {
    decodeExecuteCallData(callData);
  } catch {
    refused = true;
  }
  if (!refused) throw new Error(`${name}: the app's decoder accepts it, so it is not an invalid row`);
  return { name, callData };
});

const text = `${JSON.stringify({ valid, invalid }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(FILE, "utf8") !== text) {
    console.error(`${FILE} is stale: run node --experimental-strip-types scripts/sponsor-calldata-vectors.mjs`);
    process.exit(1);
  }
  console.log("the call data vectors are what the app's encoder gives");
} else {
  writeFileSync(FILE, text);
  console.log(`wrote ${valid.length} valid and ${invalid.length} invalid rows to ${FILE}`);
}
