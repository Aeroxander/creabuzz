import assert from "node:assert/strict";
import test from "node:test";

import { resolvePick } from "./claim-pick.ts";

const KEYS = ["0xm:0xa", "0xm:0xb"];

test("a form opened with no target starts on the first claim", () => {
  assert.deepEqual(resolvePick(KEYS, null, ""), {
    key: "0xm:0xa",
    gone: false,
  });
  assert.deepEqual(resolvePick([], null, ""), { key: null, gone: false });
});

test("a form opened for a claim chooses that claim, whatever the address case", () => {
  assert.deepEqual(resolvePick(KEYS, "0xM:0xb", ""), {
    key: "0xm:0xb",
    gone: false,
  });
});

test("a claim that is no longer eligible is reported gone, never swapped for another", () => {
  // Freeze A was asked for, A has been paid since, B is still open: the form must not offer B on its own.
  assert.deepEqual(resolvePick(["0xm:0xb"], "0xm:0xa", ""), {
    key: null,
    gone: true,
  });
});

test("what the person picks in the form wins over where they came from, and a pick that disappears is gone too", () => {
  assert.deepEqual(resolvePick(KEYS, "0xm:0xa", "0xm:0xb"), {
    key: "0xm:0xb",
    gone: false,
  });
  assert.deepEqual(resolvePick(["0xm:0xa"], null, "0xm:0xb"), {
    key: null,
    gone: true,
  });
});
