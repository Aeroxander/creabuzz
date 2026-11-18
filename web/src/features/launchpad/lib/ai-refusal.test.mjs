import assert from "node:assert/strict";
import test from "node:test";

import { AI_BUSY_WORDS, aiRefusalWords } from "./ai-refusal.ts";

test("the server's plain words are shown as they are", () => {
  const error =
    "You have used all of today's AI help for your account. It comes back at midnight UTC, in about 5 hours. You can write this yourself in the meantime.";
  assert.equal(
    aiRefusalWords({
      error,
      code: "ai_limit_account",
      retry_after_secs: 18000,
    }),
    error,
  );
  const community =
    "The AI helper has reached today's limit for this whole server, so it is paused for everyone. It comes back at midnight UTC, within the hour. You can write this yourself in the meantime.";
  assert.equal(
    aiRefusalWords({ error: community, code: "ai_limit_community" }),
    community,
  );
});

test("a body with no sentence of its own gets the app's words", () => {
  for (const body of [
    null,
    undefined,
    "busy",
    42,
    [],
    {},
    { error: "" },
    { error: "   " },
    { error: 7 },
    { error: "x".repeat(401) },
  ])
    assert.equal(aiRefusalWords(body), AI_BUSY_WORDS);
});

test("control characters are not carried into the sentence", () => {
  assert.equal(
    aiRefusalWords({ error: "Wait a second\u001b[31m and try again.\n" }),
    "Wait a second [31m and try again.",
  );
});
