import assert from "node:assert/strict";
import test from "node:test";

import { readExecutions, TOPIC_EXECUTED } from "./payment-history.ts";

const DAO = `0x${"d0".repeat(20)}`;
const id = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const tx = (n) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;

function chain(logs, times = (b) => 1_700_000_000 + b) {
  const asked = [];
  return {
    asked,
    async logs(filter) {
      asked.push(filter);
      return logs;
    },
    async blockTimes(blocks) {
      return new Map(
        blocks.flatMap((b) => (times(b) === null ? [] : [[b, times(b)]])),
      );
    },
  };
}

const executed = (n, block) => ({
  topics: [TOPIC_EXECUTED, id(n), `0x${"0".repeat(64)}`],
  data: "0x",
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: tx(n),
});

test("the Executed topic is the DAO's event (cast keccak golden)", () => {
  // cast keccak 'Executed(uint256,address,uint8,address,uint256)'
  assert.equal(
    TOPIC_EXECUTED,
    "0x3a9779bb5b1f42d7e010f92128f76537a3c79b192cab9a01e7189e97c7603bd9",
  );
});

test("each decision that ran gets the transaction and the day it ran", async () => {
  const c = chain([executed(7, 0x40), executed(9, 0x50)]);
  const runs = await readExecutions(c, DAO, [id(7), id(9), id(11)]);
  assert.equal(c.asked[0].address, DAO);
  assert.deepEqual(c.asked[0].topics, [TOPIC_EXECUTED]);
  assert.equal(runs.get(id(7)).tx, tx(7));
  assert.equal(runs.get(id(7)).at, 1_700_000_000 + 0x40);
  assert.equal(runs.get(id(9)).block, 0x50);
  assert.equal(
    runs.has(id(11)),
    false,
    "a decision with no Executed log has no run",
  );
});

test("a block whose time could not be read is undated, never guessed", async () => {
  const runs = await readExecutions(
    chain([executed(7, 0x40)], () => null),
    DAO,
    [id(7)],
  );
  assert.equal(runs.get(id(7)).at, null);
  assert.equal(runs.get(id(7)).tx, tx(7));
});
