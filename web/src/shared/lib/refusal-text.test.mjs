import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asSentence, refusalText } from "./refusal-text.ts";

describe("refusalText", () => {
  it("reads a rate limit as a sentence and passes other reasons on", () => {
    assert.equal(
      refusalText(
        "rate-limited: new accounts can post 20 times an hour for their first day; try again later",
        "x",
      ),
      "New accounts can post 20 times an hour for their first day; try again later.",
    );
    assert.equal(
      refusalText("restricted: not a channel member", "x"),
      "restricted: not a channel member",
    );
    assert.equal(
      refusalText("", "The server refused this post."),
      "The server refused this post.",
    );
    assert.equal(refusalText(undefined, "fallback"), "fallback");
  });

  it("makes words a sentence", () => {
    assert.equal(asSentence(" already done. "), "Already done.");
  });
});
