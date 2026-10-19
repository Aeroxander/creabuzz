import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { plainRefusal } from "./refusal.ts";

describe("plainRefusal", () => {
  it("drops the machine prefix and reads as a sentence", () => {
    assert.equal(
      plainRefusal(
        "rate-limited: you can start 5 boards a day; try again tomorrow",
      ),
      "You can start 5 boards a day; try again tomorrow.",
    );
    assert.equal(plainRefusal("Already a sentence."), "Already a sentence.");
    assert.equal(
      plainRefusal("invalid: "),
      "The server didn't accept that. Try again.",
    );
  });
});
