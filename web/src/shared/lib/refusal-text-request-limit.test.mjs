import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  liveRefusalText,
  refusalText,
  requestLimitText,
} from "./refusal-text.ts";

const rejection = readFileSync(
  new URL("../../../../crates/buzz-relay/src/rejection.rs", import.meta.url),
  "utf8",
);

describe("the server's general request limit", () => {
  it("says how long to wait, in plain words", () => {
    assert.equal(
      refusalText("rate-limited: quota exceeded; retry in 4s", "x"),
      "You're doing that a bit fast. Try again in 4 seconds.",
    );
    assert.equal(
      refusalText("rate-limited: quota exceeded; retry in 1s", "x"),
      "You're doing that a bit fast. Try again in 1 second.",
    );
    // The window can roll over as the refusal is sent: no "0 seconds".
    assert.equal(
      refusalText("rate-limited: quota exceeded; retry in 0s", "x"),
      "You're doing that a bit fast. Try again in a moment.",
    );
  });

  it("says the server is busy when it could not check the limit", () => {
    assert.equal(
      refusalText("rate-limited: shared admission unavailable", "x"),
      "The server is busy. Try again in a moment.",
    );
  });

  it("leaves the other rate limits to their own words", () => {
    const newAccount =
      "rate-limited: new accounts can post 20 times an hour for their first day; try again later";
    assert.equal(requestLimitText(newAccount), null);
    assert.equal(
      refusalText(newAccount, "x"),
      "New accounts can post 20 times an hour for their first day; try again later.",
    );
    assert.equal(requestLimitText("restricted: not a channel member"), null);
  });

  it("tells someone whose live updates hit the limit to wait, not that their account was refused", () => {
    // The relay's CLOSED reason for a REQ over the limit, passed on as is by subscribe-channel and use-board.
    assert.equal(
      liveRefusalText("rate-limited: quota exceeded; retry in 3s"),
      "Live updates stopped because you're doing that a bit fast. Reload the page in 3 seconds.",
    );
    assert.equal(
      liveRefusalText("rate-limited: quota exceeded; retry in 0s"),
      "Live updates stopped because you're doing that a bit fast. Reload the page in a moment.",
    );
    assert.equal(
      liveRefusalText("rate-limited: shared admission unavailable"),
      "Live updates stopped because the server is busy. Reload the page in a moment.",
    );
    // Other refusals keep their own words.
    assert.equal(
      liveRefusalText("restricted: not a community member"),
      "Live updates stopped: the server refused this account. Reload the page to try again.",
    );
  });

  it("matches the server's own wording", () => {
    // If the server's words change, these sentences stop matching and people see the raw text again.
    assert.match(
      rejection,
      /format!\("rate-limited: quota exceeded; retry in \{reset_in_secs\}s"\)/,
    );
    assert.match(rejection, /"rate-limited: shared admission unavailable"/);
  });
});
