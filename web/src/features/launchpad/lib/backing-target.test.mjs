import assert from "node:assert/strict";
import test from "node:test";

import { backingRefreshMs, backingTarget } from "./backing-target.ts";

const FACTORY = `0x${"b1".repeat(20)}`;
const QUOTE = `0x${"b3".repeat(20)}`;
const DAO = `0x${"da".repeat(20)}`;
const ON = {
  VITE_INVESTING: "1",
  VITE_BACKING_POOL_FACTORY: JSON.stringify({ 11155111: FACTORY }),
  VITE_BACKING_QUOTE_TOKEN: JSON.stringify({ 11155111: QUOTE }),
};
const record = {
  chainId: "11155111",
  treasury: DAO,
  tokenPlan: { mode: "dao" },
};

test("with the switch off no project has a target, whatever else is set", () => {
  assert.deepEqual(backingTarget(record, {}), { kind: "off" });
  assert.deepEqual(backingTarget(record, { ...ON, VITE_INVESTING: "" }), {
    kind: "off",
  });
  assert.deepEqual(backingTarget(record, undefined), { kind: "off" });
});

test("a DAO-run project on a named network has a target, with its own DAO lowercased", () => {
  assert.deepEqual(
    backingTarget(
      { ...record, treasury: DAO.toUpperCase().replace("0X", "0x") },
      ON,
    ),
    {
      kind: "target",
      chainId: 11155111,
      factory: FACTORY,
      quoteToken: QUOTE,
      dao: DAO,
    },
  );
});

test("a project with no DAO, no network or no factory for its network says which", () => {
  assert.deepEqual(backingTarget({ ...record, treasury: null }, ON), {
    kind: "not-here",
    why: "no-dao",
  });
  assert.deepEqual(backingTarget({ ...record, treasury: "0x12" }, ON), {
    kind: "not-here",
    why: "no-dao",
  });
  assert.deepEqual(backingTarget({ ...record, tokenPlan: null }, ON), {
    kind: "not-here",
    why: "no-dao",
  });
  assert.deepEqual(backingTarget({ ...record, chainId: null }, ON), {
    kind: "not-here",
    why: "no-network",
  });
  assert.deepEqual(backingTarget({ ...record, chainId: "abc" }, ON), {
    kind: "not-here",
    why: "no-network",
  });
  assert.deepEqual(backingTarget({ ...record, chainId: "1" }, ON), {
    kind: "not-here",
    why: "no-factory",
  });
  // A factory without the backing token is not enough to take money.
  assert.deepEqual(
    backingTarget(record, { ...ON, VITE_BACKING_QUOTE_TOKEN: "" }),
    { kind: "not-here", why: "no-factory" },
  );
});

test("a pool is read again slower after each failure in a row, never faster than every 15 seconds, never slower than 5 minutes", () => {
  assert.equal(backingRefreshMs(0, false), 45_000);
  assert.equal(backingRefreshMs(0, true), 15_000);
  assert.equal(backingRefreshMs(1, false), 15_000);
  assert.equal(backingRefreshMs(2, false), 30_000);
  assert.equal(backingRefreshMs(3, true), 60_000);
  assert.equal(backingRefreshMs(50, false), 300_000);
});
