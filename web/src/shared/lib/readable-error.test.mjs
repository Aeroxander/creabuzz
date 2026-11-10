import assert from "node:assert/strict";
import test from "node:test";

import { SigningBlockedError } from "./nostr-signer.ts";
import {
  errorMessage,
  failureWords,
  plainErrorText,
  READ_REFUSED_TEXT,
  READ_SIGN_IN_TEXT,
  READ_UNANSWERED_TEXT,
  readableError,
  readFailureWords,
} from "./readable-error.ts";
import { RelayAnsweredError } from "./relay-failure.ts";
import { INVITE_ONLY_TEXT, SERVER_FAILED_TEXT } from "./refusal-text.ts";

// What chat rooms, the room list and conversations print after "Couldn't …" when a read or a write fails.

test("a request-limit refusal reads as plain words, not the server's", () => {
  const refused = new RelayAnsweredError(
    "rate-limited: quota exceeded; retry in 4s",
  );
  const words = readableError(refused);
  assert.equal(words, "You're doing that a bit fast. Try again in 4 seconds.");
  assert.doesNotMatch(words, /quota|rate-limited|\.\.$/);
  assert.equal(plainErrorText(refused), words);
});

test("an invite-only refusal tells the reader to open their invite link", () => {
  const refused = new RelayAnsweredError("restricted: not a relay member");
  assert.equal(readableError(refused), INVITE_ONLY_TEXT);
  assert.equal(plainErrorText(refused), INVITE_ONLY_TEXT);
});

test("a server message on any error carrying it is read the same way", () => {
  const failure = Object.assign(new Error("query failed"), {
    relayMessage: "rate-limited: quota exceeded; retry in 4s",
  });
  assert.equal(
    readableError(failure),
    "You're doing that a bit fast. Try again in 4 seconds.",
  );
});

test("errorMessage stays untouched, for callers that match on the server's words", () => {
  // CommunityHomePage reads the raw text.
  const refused = new RelayAnsweredError("restricted: not a relay member");
  assert.equal(errorMessage(refused), "restricted: not a relay member");
  assert.equal(errorMessage("plain string"), "plain string");
  assert.equal(errorMessage(undefined), "unknown error");
  assert.equal(plainErrorText(new Error("query timed out")), null);
});

// What "Couldn't load older messages." and "Couldn't load more channels." go on to say: never the socket's or the
// server's own code, which is kept for Technical details.

test("a read that timed out or lost its socket says the server didn't answer", () => {
  for (const raw of [
    "Server query timed out after 15000ms",
    "WebSocket connection failed",
    "Server query ended without an answer.",
    "Server closed the connection before finishing the query.",
    "query timed out",
  ]) {
    assert.deepEqual(readFailureWords(new Error(raw)), {
      text: READ_UNANSWERED_TEXT,
      detail: raw,
    });
    assert.equal(readableError(new Error(raw)), "The server didn't answer.");
  }
});

test("a read the server refused without words for people says it couldn't, not its code", () => {
  for (const raw of ["error: database error: down.", "error: internal"]) {
    assert.deepEqual(readFailureWords(new RelayAnsweredError(raw)), {
      text: READ_REFUSED_TEXT,
      detail: raw,
    });
  }
  // Not on a private room's list (removed, or never added): said so.
  assert.equal(
    readableError(new RelayAnsweredError("restricted: not a channel member")),
    "You don't have access to this room or board. Its owner can add you.",
  );
  // A refusal with words for people keeps them, without the prefix.
  assert.equal(
    readableError(new RelayAnsweredError("restricted: unknown filter field")),
    "Unknown filter field.",
  );
});

test("a read that needs sign-in says so, and a locked passkey's own sentence is kept", () => {
  const authRequired = new RelayAnsweredError(
    "auth-required: the server closed the connection before it accepted this browser's authentication.",
  );
  assert.equal(readableError(authRequired), READ_SIGN_IN_TEXT);
  assert.doesNotMatch(readableError(authRequired), /auth-required/i);
  assert.equal(
    readableError(new SigningBlockedError()),
    "Unlock your passkey so this browser can confirm this.",
  );
  assert.equal(readableError(new Error("")), READ_UNANSWERED_TEXT);
});

// What a failed write says in main copy (create a channel, start a conversation, save a profile), and what it keeps
// for Technical details.

test("a server's internal failure is said as the caller's plain words, the server's kept as detail", () => {
  const fallback = "Couldn't create the channel. Try again.";
  for (const failure of [
    new Error("error: database error: down"),
    new RelayAnsweredError("error: database error: down"),
  ]) {
    assert.deepEqual(failureWords(failure, fallback), {
      text: fallback,
      detail: "error: database error: down",
    });
  }
  // Without the caller's words: the general one.
  assert.equal(
    failureWords(new Error("error: database error: down")).text,
    SERVER_FAILED_TEXT,
  );
});

test("timeouts, HTTP codes, lowercase codes and the browser's network words never reach main copy", () => {
  for (const raw of [
    "query timed out",
    "HTTP 500",
    "profile publish rejected",
    // Capitalised, some with a full stop, but not the app's words.
    "WebSocket connection failed.",
    "WebSocket connection failed",
    "NetworkError when attempting to fetch resource.",
    "Failed to fetch",
    "Load failed",
    "Server publish timed out.",
    "Server query timed out after 15000ms.",
  ]) {
    const words = failureWords(
      new Error(raw),
      "Couldn't save your profile. Try again.",
    );
    assert.equal(words.text, "Couldn't save your profile. Try again.");
    assert.equal(words.detail, raw);
  }
  assert.deepEqual(failureWords(undefined, "Try again."), {
    text: "Try again.",
    detail: "unknown error",
  });
});

test("a refusal with words for people is said in them, without the prefix", () => {
  assert.deepEqual(
    failureWords(new Error("restricted: only an admin can add people")),
    {
      text: "Only an admin can add people.",
      detail: "restricted: only an admin can add people",
    },
  );
  // The plain words of a known restriction win, wherever the server's message is carried.
  assert.equal(
    failureWords(
      new RelayAnsweredError("rate-limited: quota exceeded; retry in 4s"),
    ).text,
    "You're doing that a bit fast. Try again in 4 seconds.",
  );
  assert.deepEqual(failureWords(new Error("restricted: not a relay member")), {
    text: INVITE_ONLY_TEXT,
    detail: "restricted: not a relay member",
  });
});

test("a sentence the app wrote for people is kept as it is, with nothing more to show", () => {
  // publishAsUser throws a known restriction already in plain words.
  assert.deepEqual(
    failureWords(new Error("You are banned from this community.")),
    {
      text: "You are banned from this community.",
      detail: null,
    },
  );
  // A timeout said with its date and time keeps its words, colon and all.
  const timedOut =
    "You are muted everywhere in this community until Oct 30, 2026, 2:39 PM. You can still read; you can post again then.";
  assert.deepEqual(failureWords(new Error(timedOut), "Try again."), {
    text: timedOut,
    detail: null,
  });
  // A code in front is not the app's sentence.
  assert.equal(
    failureWords(new Error("Error: database error: down."), "Try again.").text,
    "Try again.",
  );
  assert.deepEqual(
    failureWords(new Error("The server did not accept that. Try again.")),
    { text: "The server did not accept that. Try again.", detail: null },
  );
});
