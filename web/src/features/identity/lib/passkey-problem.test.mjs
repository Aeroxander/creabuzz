import assert from "node:assert/strict";
import test from "node:test";

import {
  passkeyCreateProblem,
  passkeyUnlockProblem,
} from "./passkey-problem.ts";

function named(
  name,
  message = "The operation either timed out or was not allowed.",
) {
  const error = new Error(message);
  error.name = name;
  return error;
}

test("a cancelled passkey says so and names the other way in, as the screen offers it", () => {
  assert.equal(
    passkeyCreateProblem(named("NotAllowedError")),
    "The passkey was cancelled. Try again, or create without a passkey.",
  );
  assert.equal(
    passkeyCreateProblem(
      named("NotAllowedError"),
      "create an account without one",
    ),
    "The passkey was cancelled. Try again, or create an account without one.",
  );
  assert.equal(
    passkeyCreateProblem(
      named("PrfUnavailableError"),
      "create an account without one",
    ),
    "This browser cannot keep a passkey account. Create an account without one instead.",
  );
});

test("unlocking never shows the browser's own sentence or a key", () => {
  assert.match(passkeyUnlockProblem(named("NotAllowedError")), /cancelled/);
  const other = passkeyUnlockProblem(
    new Error(
      "This passkey re-derived a different Nostr identity than the one registered on this browser (registered aa, derived bb).",
    ),
  );
  assert.match(other, /different account/);
  assert.doesNotMatch(other, /Nostr|aa|derived/);
  assert.equal(
    passkeyUnlockProblem(named("UnknownError")),
    "Your passkey did not unlock. Try again.",
  );
});
