import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { GENERIC_REFUSAL, requestAnswerError } from "./request-answer-copy.ts";

test("a refusal with no reason says what happened and what to do, never 'rejected the event'", () => {
  const generic = new Error(GENERIC_REFUSAL);
  for (const err of [generic, "boom", undefined, new Error("")]) {
    const text = requestAnswerError("approve", err);
    assert.doesNotMatch(text, /event/i);
    assert.equal(
      text,
      "The server didn't save your approval, so nothing changed for this request. Press Approve to try again.",
    );
  }
  assert.match(
    requestAnswerError("decline", generic),
    /your decline.*Press Decline/,
  );
});

test("a refusal the server explained is shown as it is", () => {
  const explained = new Error(
    "You're doing that a bit fast. Try again in a minute.",
  );
  assert.equal(requestAnswerError("approve", explained), explained.message);
});

test("the Projects board's own fallback says what happened and what to do, and is the one recognized here", () => {
  // The join dialog shows this text as it is, so it must stand on its own.
  assert.doesNotMatch(GENERIC_REFUSAL, /event|rejected/i);
  assert.match(GENERIC_REFUSAL, /nothing changed/);
  assert.match(GENERIC_REFUSAL, /try again/);
  // use-projects.ts must hand this constant (not a copy of the words) to the publish path, or the approve and decline
  // answers would show the bare fallback instead of naming the button to press.
  const source = readFileSync(
    new URL("../use-projects.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /publishAsUser\(\s*template,\s*GENERIC_REFUSAL\s*,?\s*\)/,
  );
  assert.match(
    source,
    /import \{ GENERIC_REFUSAL \} from "\.\/lib\/request-answer-copy"/,
  );
});
