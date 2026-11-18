import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dismissNextStep,
  NEXT_STEP_QUIET_SECONDS,
  nextStepDismissed,
} from "./next-step.ts";

const memory = () => {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
};

test("put away, the line stays away for a day and then comes back", () => {
  const store = memory();
  assert.equal(nextStepDismissed(store, "s|me", 1_000), false);
  assert.equal(dismissNextStep(store, "s|me", 1_000), true);
  assert.equal(nextStepDismissed(store, "s|me", 1_001), true);
  assert.equal(
    nextStepDismissed(store, "s|me", 1_000 + NEXT_STEP_QUIET_SECONDS - 1),
    true,
  );
  assert.equal(
    nextStepDismissed(store, "s|me", 1_000 + NEXT_STEP_QUIET_SECONDS),
    false,
  );
});

test("it is put away for one person on one server only", () => {
  const store = memory();
  dismissNextStep(store, "s|me", 1_000);
  assert.equal(nextStepDismissed(store, "s|someone-else", 1_001), false);
  assert.equal(nextStepDismissed(store, "other-server|me", 1_001), false);
});

test("a note that cannot be read, is dated ahead, or cannot be kept hides nothing", () => {
  assert.equal(nextStepDismissed(null, "s|me", 1), false);
  assert.equal(
    nextStepDismissed({ getItem: () => "{not json", setItem() {} }, "s|me", 1),
    false,
  );
  const ahead = memory();
  dismissNextStep(ahead, "s|me", 5_000);
  assert.equal(nextStepDismissed(ahead, "s|me", 4_000), false);
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("full");
    },
  };
  assert.equal(dismissNextStep(refusing, "s|me", 1), false);
  assert.equal(dismissNextStep(null, "s|me", 1), false);
});
