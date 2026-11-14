import assert from "node:assert/strict";
import test from "node:test";

import { withCache } from "./cache.ts";

const openOk = async () => ({ execute: async () => ({ rows: [] }) });
const openMissing = async () => null;
const openThrows = async () => {
  throw new Error("OPFS unavailable in this browser");
};

test("a missing cache yields the fallback instead of throwing", async () => {
  const result = await withCache(
    openMissing,
    async () => "from cache",
    "fallback",
  );
  assert.equal(result, "fallback");
});

test("a cache that cannot be opened yields the fallback", async () => {
  const result = await withCache(
    openThrows,
    async () => "from cache",
    "fallback",
  );
  assert.equal(result, "fallback");
});

test("a failing read yields the fallback, not a rejection", async () => {
  // This is the path that used to make a successful publish report failure.
  const result = await withCache(openOk, async () => {
    throw new Error("SQLITE_CANTOPEN");
  }, []);
  assert.deepEqual(result, []);
});

test("a working cache returns the read result", async () => {
  const result = await withCache(
    openOk,
    async (db) => {
      const { rows } = await db.execute("SELECT 1");
      return rows.length;
    },
    -1,
  );
  assert.equal(result, 0);
});

test("a write is attempted exactly once and its result is returned", async () => {
  let calls = 0;
  const result = await withCache(
    async () => ({
      execute: async (sql) => {
        calls += 1;
        assert.match(sql, /INSERT/);
        return { rows: [] };
      },
    }),
    async (db) => {
      await db.execute("INSERT INTO pages VALUES (1)");
      return "written";
    },
    "skipped",
  );
  assert.equal(result, "written");
  assert.equal(calls, 1);
});
