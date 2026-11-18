import assert from "node:assert/strict";
import { test } from "node:test";

import {
  keepVoteKey,
  keptVoteKey,
  parseVoteKey,
  voteKeyName,
} from "./vote-key.ts";

const KEY = `0x${"ab".repeat(32)}`;

test("a sealed vote's key is kept per court, case, round and wallet, and read back", () => {
  const map = new Map();
  const store = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
  const name = voteKeyName("0xC0", 3n, 1, "0xA1");
  assert.equal(name, "creaton:vote-key:0xc0:3:1:0xa1");
  assert.equal(
    keepVoteKey(name, KEY.toUpperCase().replace("0X", "0x"), store),
    true,
  );
  assert.equal(keptVoteKey(name, store), KEY);
  assert.equal(keptVoteKey(voteKeyName("0xC0", 3n, 2, "0xA1"), store), null);
});

test("storage that is missing or refuses does not break sealing", () => {
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(keepVoteKey("n", KEY, refusing), false);
  assert.equal(keptVoteKey("n", refusing), null);
  assert.equal(keepVoteKey("n", KEY, null), false);
});

test("a pasted key is tidied, and anything else refused", () => {
  assert.equal(parseVoteKey(`  ${"AB".repeat(32)} `), KEY);
  assert.equal(parseVoteKey(KEY), KEY);
  assert.equal(parseVoteKey("0x1234"), null);
});
