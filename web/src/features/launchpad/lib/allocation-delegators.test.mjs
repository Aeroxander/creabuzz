import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";

import { readDelegatorsTo } from "./allocation-delegators.ts";
import { encodeCall0, SIGNATURES } from "@creaton/core/launchpad/work.ts";

const DAO = `0x${"d0".repeat(20)}`;
const POLICY = `0x${"e0".repeat(20)}`;
const ME = `0x${"aa".repeat(20)}`;
const NIA = `0x${"bb".repeat(20)}`;
const RUI = `0x${"cc".repeat(20)}`;
const word = (address) => `0x${address.slice(2).padStart(64, "0")}`;

function chain(delegateOf) {
  const calls = [];
  return {
    calls,
    async call(to, data) {
      calls.push(to);
      if (to === DAO && data === encodeCall0(SIGNATURES.policy))
        return word(POLICY);
      for (const [owner, delegate] of Object.entries(delegateOf)) {
        if (
          to === POLICY &&
          data ===
            encodeFunctionData("delegateOf(address)", ["address"], [owner])
        )
          return word(delegate);
      }
      throw new Error(`unexpected call to ${to}`);
    },
  };
}

test("only the holders who handed this account their vote are offered, by the policy's own record", async () => {
  const fake = chain({ [NIA]: ME, [RUI]: `0x${"0".repeat(40)}` });
  assert.deepEqual(await readDelegatorsTo(fake, DAO, ME, [ME, NIA, RUI]), [
    NIA,
  ]);
});

test("someone nobody delegated to is offered nothing, and the viewer is never asked about", async () => {
  const fake = chain({ [NIA]: RUI });
  assert.deepEqual(await readDelegatorsTo(fake, DAO, ME, [NIA]), []);
  const alone = chain({});
  assert.deepEqual(await readDelegatorsTo(alone, DAO, ME, [ME]), []);
  assert.equal(alone.calls.length, 0);
});

test("the comparison ignores letter case", async () => {
  const fake = chain({ [NIA]: ME });
  assert.deepEqual(
    await readDelegatorsTo(fake, DAO, ME.toUpperCase().replace("0X", "0x"), [
      NIA,
    ]),
    [NIA],
  );
});
