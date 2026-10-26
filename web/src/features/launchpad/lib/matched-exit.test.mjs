import assert from "node:assert/strict";
import { test } from "node:test";

import { readExitSales } from "./matched-exit.ts";

const SHARES = `0x${"05".repeat(20)}`;
const word = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;

test("Shares made before sales between members read as none; a network failure is still an error", async () => {
  const answering = { call: async () => word(0) };
  assert.deepEqual(await readExitSales(answering, SHARES), {
    transfersLocked: false,
    exchange: null,
    pending: null,
    announcedAt: 0,
  });
  const old = {
    call: async (_to, data) => {
      if (data === "0x83f1211b") return word(1); // transfersLocked() exists on every locked Shares
      throw new Error("execution reverted");
    },
  };
  assert.equal(await readExitSales(old, SHARES), null);
  const down = {
    call: async () => {
      throw new Error("fetch failed");
    },
  };
  await assert.rejects(readExitSales(down, SHARES), /fetch failed/);
});
