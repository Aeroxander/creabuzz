import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { relayFailureGuidance } from "./relay-failure.ts";
import {
  INVITE_ONLY_TEXT,
  liveRefusalText,
  plainRefusalText,
  refusalText,
  restrictionText,
} from "./refusal-text.ts";

const relay = (path) =>
  readFileSync(
    new URL(`../../../../crates/buzz-relay/src/${path}`, import.meta.url),
    "utf8",
  );

describe("an invite-only server's refusal", () => {
  it("is said in plain words with what to do, on the socket and over HTTP", () => {
    assert.equal(
      INVITE_ONLY_TEXT,
      "This server is invite-only. Open the invite link you were sent.",
    );
    for (const refusal of [
      "restricted: not a relay member",
      "relay_membership_required",
    ]) {
      assert.equal(restrictionText(refusal), INVITE_ONLY_TEXT);
      assert.equal(plainRefusalText(refusal), INVITE_ONLY_TEXT);
      assert.equal(refusalText(refusal, "x"), INVITE_ONLY_TEXT);
      assert.equal(liveRefusalText(refusal), INVITE_ONLY_TEXT);
      // What a failed read (Home's feed) says in place of "the server refused this request".
      assert.equal(relayFailureGuidance(refusal), INVITE_ONLY_TEXT);
    }
  });

  it("is not confused with a room or community the reader is not in", () => {
    assert.equal(restrictionText("restricted: not a channel member"), null);
    assert.equal(restrictionText("restricted: not a community member"), null);
  });

  it("matches the server's own wording", () => {
    // If the server's words change, people see the raw text again.
    assert.match(relay("handlers/auth.rs"), /"restricted: not a relay member"/);
    assert.match(relay("api/mod.rs"), /"error": "relay_membership_required"/);
  });
});

describe("plainRefusalText", () => {
  it("says the request limit in plain words", () => {
    assert.equal(
      plainRefusalText("rate-limited: quota exceeded; retry in 4s"),
      "You're doing that a bit fast. Try again in 4 seconds.",
    );
    assert.equal(
      plainRefusalText("rate-limited: shared admission unavailable"),
      "The server is busy. Try again in a moment.",
    );
  });

  it("has nothing to say about a refusal it has no words for", () => {
    assert.equal(plainRefusalText("restricted: not a channel member"), null);
    assert.equal(
      plainRefusalText("rate-limited: you can start 5 boards a day"),
      null,
    );
  });
});
