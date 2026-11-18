import assert from "node:assert/strict";
import { test } from "node:test";

import { newPillWords, splitLive } from "./live-feed.ts";

const item = (id, at) => ({ id, at });
const ids = (list) => list.map((i) => i.id);

test("the first read shows everything", () => {
  const { visible, waiting } = splitLive([item("b", 2), item("a", 1)], null);
  assert.deepEqual(ids(visible), ["b", "a"]);
  assert.deepEqual(waiting, []);
});

test("a record that arrives later waits behind the pill; nothing shown moves", () => {
  const shown = new Set(["b", "a"]);
  const { visible, waiting } = splitLive(
    [item("c", 3), item("b", 2), item("a", 1)],
    shown,
  );
  assert.deepEqual(ids(visible), ["b", "a"]);
  assert.deepEqual(ids(waiting), ["c"]);
});

test("older records read by Show older join the list at once: they are not news", () => {
  const shown = new Set(["b", "a"]);
  const { visible, waiting } = splitLive(
    [item("b", 2), item("a", 1), item("z", 0)],
    shown,
  );
  assert.deepEqual(ids(visible), ["b", "a", "z"]);
  assert.deepEqual(waiting, []);
});

test("the pill counts in words", () => {
  assert.equal(newPillWords(1), "1 new record");
  assert.equal(newPillWords(3), "3 new records");
});
