import assert from "node:assert/strict";
import test from "node:test";

import {
  errorMessage,
  failureWords,
  plainErrorText,
  readableError,
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

test("anything else is passed on as one sentence, and errorMessage stays untouched", () => {
  const timeout = new Error("query timed out");
  assert.equal(plainErrorText(timeout), null);
  assert.equal(readableError(timeout), "Query timed out.");
  // Callers that match on the server's words (CommunityHomePage) read the raw text.
  const refused = new RelayAnsweredError("restricted: not a relay member");
  assert.equal(errorMessage(refused), "restricted: not a relay member");
  assert.equal(errorMessage("plain string"), "plain string");
  assert.equal(errorMessage(undefined), "unknown error");
  // An unknown refusal has no plain words: the server's own, as a sentence, with one full stop.
  assert.equal(
    readableError(new RelayAnsweredError("error: database error: down.")),
    "Error: database error: down.",
  );
  assert.equal(readableError(new Error("")), "");
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

test("timeouts, HTTP codes and lowercase codes never reach main copy", () => {
  for (const raw of [
    "query timed out",
    "HTTP 500",
    "profile publish rejected",
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
    "You are timed out in this community until Oct 30, 2026, 2:39 PM. You can still read; you can post again then.";
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
    failureWords(new Error("The server did not accept this write. Try again.")),
    { text: "The server did not accept this write. Try again.", detail: null },
  );
});
