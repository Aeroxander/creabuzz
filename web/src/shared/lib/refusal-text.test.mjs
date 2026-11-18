import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ACCESS_REMOVED_TEXT,
  asSentence,
  banIn,
  banText,
  NO_ACCESS_TEXT,
  parseBan,
  liveRefusalText,
  refusalText,
  restrictionText,
} from "./refusal-text.ts";

const relay = (path) =>
  readFileSync(
    new URL(`../../../../crates/buzz-relay/src/${path}`, import.meta.url),
    "utf8",
  );

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
      refusalText("restricted: only an admin can add people", "x"),
      "restricted: only an admin can add people",
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

describe("restrictions on the reader", () => {
  it("say what happened, until when, and what still works", () => {
    assert.equal(
      refusalText("blocked: you are banned from this community", "x"),
      "You are banned from this community.",
    );
    assert.match(
      refusalText("restricted: you are timed out until 1893456000", "x"),
      /^You are muted everywhere in this community until .*2030.*\. You can still read; you can post again then\.$/,
    );
    assert.match(
      refusalText(
        "restricted: you are muted on this board until 1893456000",
        "x",
      ),
      /^You are muted on this board until .*2030.*\. You can still read it, and post everywhere else\.$/,
    );
    assert.equal(
      refusalText("restricted: this thread is locked", "x"),
      "This thread is locked. Only the board's moderators, owners and admins can reply.",
    );
    // Not a restriction: passed on as it is.
    assert.equal(restrictionText("restricted: not a community member"), null);
  });

  it("tell someone removed from a private room or board that they were, and someone not on it that they are not", () => {
    const revoked = "restricted: channel access revoked";
    assert.equal(restrictionText(revoked), ACCESS_REMOVED_TEXT);
    assert.equal(refusalText(revoked, "x"), ACCESS_REMOVED_TEXT);
    // The server says the same to the removed and the never-added, so the words claim neither.
    const notOn = "restricted: not a channel member";
    assert.equal(restrictionText(notOn), NO_ACCESS_TEXT);
    assert.equal(refusalText(notOn, "x"), NO_ACCESS_TEXT);
    // A live view the reader had open: they were removed.
    assert.match(liveRefusalText(notOn), /no longer have access/);
    assert.equal(
      ACCESS_REMOVED_TEXT,
      "You no longer have access to this room or board.",
    );
  });

  it("match the server's own wording", () => {
    // If the server's words change, these sentences stop matching and people see the raw text again.
    assert.match(
      relay("handlers/ingest.rs"),
      /"restricted: you are timed out until \{\}"/,
    );
    const board = relay("handlers/board_moderation.rs");
    assert.match(board, /"you are muted on this board until \{\}"/);
    assert.match(board, /restricted\("this thread is locked"\)/);
    // Removed from a private room or board: the read, the write, and the live subscription.
    assert.match(
      relay("handlers/req.rs"),
      /"restricted: not a channel member"/,
    );
    assert.match(
      relay("handlers/ingest.rs"),
      /"restricted: not a channel member"/,
    );
    assert.match(
      relay("handlers/side_effects.rs"),
      /"restricted: channel access revoked"/,
    );
  });
});

describe("a ban", () => {
  const SOON = 1893456000;

  it("is read from the server's refusal: when it ends and the moderator's reason", () => {
    assert.deepEqual(
      parseBan(
        `blocked: you are banned from this community until ${SOON}; reason: Selling coins in chat`,
      ),
      { ends: SOON, reason: "Selling coins in chat" },
    );
    assert.deepEqual(
      parseBan("blocked: you are banned from this community for good"),
      { ends: "never", reason: null },
    );
    assert.deepEqual(
      parseBan(
        "blocked: you are banned from this community for good; reason: spam; and more spam",
      ),
      { ends: "never", reason: "spam; and more spam" },
    );
    // An older server says neither.
    assert.deepEqual(parseBan("blocked: you are banned from this community"), {
      ends: null,
      reason: null,
    });
    assert.deepEqual(parseBan("blocked: you are banned"), {
      ends: null,
      reason: null,
    });
    assert.equal(parseBan("restricted: you are timed out until 1"), null);
    // Found after a client's own words, as a failed sign-in reports it.
    assert.deepEqual(
      banIn(
        "auth failed: blocked: you are banned from this community for good; reason: Spam",
      ),
      { ends: "never", reason: "Spam" },
    );
    assert.equal(banIn("not a relay member"), null);
  });

  it("is said in plain words: until when, or for good, then the reason", () => {
    const timed = refusalText(
      `blocked: you are banned from this community until ${SOON}; reason: selling coins in chat`,
      "x",
    );
    assert.match(
      timed,
      /^You are banned from this community until .*2030.*\. Reason: Selling coins in chat\.$/,
    );
    assert.doesNotMatch(timed, new RegExp(String(SOON)));
    assert.equal(
      refusalText("blocked: you are banned from this community for good", "x"),
      "You are banned from this community for good.",
    );
    assert.equal(
      liveRefusalText(
        "blocked: you are banned from this community for good; reason: Spam",
      ),
      "You are banned from this community for good. Reason: Spam.",
    );
    assert.equal(
      banText({ ends: null, reason: null }),
      "You are banned from this community.",
    );
  });

  it("matches the server's own wording", () => {
    const auth = relay("handlers/auth.rs");
    assert.match(
      auth,
      /BAN_REFUSAL: &str = "blocked: you are banned from this community"/,
    );
    assert.match(auth, /"\{BAN_REFUSAL\} until \{\}"/);
    assert.match(auth, /"\{BAN_REFUSAL\} for good"/);
    assert.match(auth, /"; reason: "/);
  });
});

describe("liveRefusalText", () => {
  it("names the restriction, or says live updates stopped and what to do", () => {
    assert.equal(
      liveRefusalText("blocked: you are banned from this community"),
      "You are banned from this community.",
    );
    for (const removed of [
      "restricted: channel access revoked",
      "restricted: not a channel member",
    ]) {
      assert.equal(
        liveRefusalText(removed),
        "You no longer have access to this room or board. Live updates stopped.",
      );
    }
    assert.equal(
      liveRefusalText("restricted: not a community member"),
      "Live updates stopped: the server refused this account. Reload the page to try again.",
    );
    assert.equal(
      liveRefusalText(null),
      "Live updates stopped: the server refused this account. Reload the page to try again.",
    );
  });
});
