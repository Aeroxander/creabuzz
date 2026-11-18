import assert from "node:assert/strict";
import test from "node:test";

import { rememberShown, resolvePick } from "./claim-pick.ts";

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

test("the first option a form shows becomes its target: if it disappears on a refresh, the next one is not quietly shown", () => {
  // The person has not touched the dropdown; a destructive amount is typed against what is on screen.
  let selected = "";
  const show = (keys) => {
    const pick = resolvePick(keys, null, selected);
    selected = rememberShown(selected, pick);
    return pick;
  };
  assert.deepEqual(show(["0xm:0xa", "0xm:0xb"]), {
    key: "0xm:0xa",
    gone: false,
  });
  // A refresh drops A. Before this, the form would have shown B in its place with the amount still typed.
  assert.deepEqual(show(["0xm:0xb"]), { key: null, gone: true });
  // It stays gone until the person chooses.
  assert.deepEqual(show(["0xm:0xb"]), { key: null, gone: true });
  selected = "0xm:0xb";
  assert.deepEqual(show(["0xm:0xb"]), { key: "0xm:0xb", gone: false });
});

test("a form that had nothing to show takes the first one that appears, and then keeps it", () => {
  let selected = "";
  const show = (keys) => {
    const pick = resolvePick(keys, null, selected);
    selected = rememberShown(selected, pick);
    return pick;
  };
  assert.deepEqual(show([]), { key: null, gone: false });
  assert.deepEqual(show(["0xm:0xa"]), { key: "0xm:0xa", gone: false });
  assert.deepEqual(show([]), { key: null, gone: true });
});

test("what was picked is never replaced by remembering", () => {
  assert.equal(
    rememberShown("0xm:0xb", { key: "0xm:0xa", gone: false }),
    "0xm:0xb",
  );
  assert.equal(rememberShown("", { key: null, gone: false }), "");
});
