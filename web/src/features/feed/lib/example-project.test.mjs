import assert from "node:assert/strict";
import { test } from "node:test";

import { exampleFirst, exampleProject } from "./example-project.ts";

const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const launch = (author, eventId, startedAt, listing = null) => ({
  record: { author, eventId, startedAt, listing },
});

test("the example is the owner's oldest listed project, found by who started it", () => {
  const newer = launch(OWNER, "e2", 200);
  const older = launch(OWNER, "e1", 100);
  const theirs = launch(OTHER, "e3", 50);
  assert.equal(exampleProject([newer, theirs, older], OWNER), older);
  // The owner is matched whatever the case the list wrote.
  assert.equal(exampleProject([older], OWNER.toUpperCase()), older);
});

test("no owner, no project of theirs, or only one they did not list: there is no example", () => {
  const hidden = launch(OWNER, "e1", 100, "unlisted");
  assert.equal(exampleProject([hidden, launch(OTHER, "e2", 1)], OWNER), null);
  assert.equal(exampleProject([launch(OWNER, "e1", 1)], null), null);
  assert.equal(exampleProject([], OWNER), null);
});

test("the example goes first in the follow list, once, and never to its own founder", () => {
  const example = launch(OWNER, "e1", 100);
  const a = launch(OTHER, "e2", 1);
  const b = launch(OTHER, "e3", 2);
  assert.deepEqual(exampleFirst([a, b], example), [example, a, b]);
  // Already among them: moved to the front, not repeated.
  assert.deepEqual(exampleFirst([a, launch(OWNER, "e1", 100), b], example), [
    example,
    a,
    b,
  ]);
  // A full list stays the same length.
  const five = [1, 2, 3, 4, 5].map((n) => launch(OTHER, `x${n}`, n));
  assert.equal(exampleFirst(five, example).length, 5);
  assert.equal(exampleFirst(five, example)[0], example);
  // Nothing to put first, or it is the reader's own.
  assert.deepEqual(exampleFirst([a, b], null), [a, b]);
  assert.deepEqual(exampleFirst([a, b], example, OWNER), [a, b]);
});
