import assert from "node:assert/strict";
import test from "node:test";

import { relayAnswered } from "../../../shared/lib/relay-failure.ts";
import { INVITE_ONLY_TEXT } from "../../../shared/lib/refusal-text.ts";
import {
  ALREADY_MEMBER_TEXT,
  ASK_FOR_INVITE_TEXT,
  COULDNT_OPEN_TEXT,
  NEEDS_INVITE_TITLE,
  PUBLIC_RECORD_BUSY_TEXT,
  PUBLIC_RECORD_BUSY_TITLE,
  isInviteOnlyRefusal,
  projectLoadFailure,
  publicRecordFailure,
} from "./refusal-copy.ts";

const notMember = relayAnswered("restricted: not a relay member");

test("a signed-out visitor refused by an invite-only server is told so, who to ask, and gets Sign in, not Try again", () => {
  const f = projectLoadFailure(notMember, false);
  assert.equal(f.kind, "invite-only");
  assert.equal(f.title, NEEDS_INVITE_TITLE);
  assert.deepEqual(f.lines, [
    INVITE_ONLY_TEXT,
    ASK_FOR_INVITE_TEXT,
    ALREADY_MEMBER_TEXT,
  ]);
  assert.match(ASK_FOR_INVITE_TEXT, /Ask the person who sent you this link/);
  assert.equal(f.signIn, true);
  assert.equal(f.retry, false);
});

test("the HTTP form of the same refusal is the same words", () => {
  assert.equal(
    projectLoadFailure(relayAnswered("relay_membership_required"), false).kind,
    "invite-only",
  );
});

test("someone already signed in is not offered Sign in, and still told who to ask", () => {
  const f = projectLoadFailure(notMember, true);
  assert.equal(f.kind, "invite-only");
  assert.equal(f.signIn, false);
  assert.equal(f.retry, false);
  assert.deepEqual(f.lines, [INVITE_ONLY_TEXT, ASK_FOR_INVITE_TEXT]);
});

test("every other failure keeps Try again and the old words", () => {
  for (const error of [
    new Error("Server query timed out after 8000ms"),
    relayAnswered("restricted: not a channel member"),
    relayAnswered("blocked: you are banned from this community"),
    relayAnswered("error: database error: down"),
    "restricted: not a relay member",
    null,
    undefined,
  ]) {
    const f = projectLoadFailure(error, false);
    assert.equal(f.kind, "other", String(error));
    assert.equal(f.title, COULDNT_OPEN_TEXT);
    assert.equal(f.retry, true);
    assert.equal(f.signIn, false);
    assert.deepEqual(f.lines, []);
    assert.equal(isInviteOnlyRefusal(error), false);
  }
});

test("a public record the server could not give this time is 'busy, try again', never 'you need an invite'", () => {
  // The server turned the reader away as someone not on its list: it shows no public record.
  assert.equal(publicRecordFailure(notMember), "closed");
  assert.equal(
    publicRecordFailure(relayAnswered("relay_membership_required")),
    "closed",
  );
  // It does show them, and a limit was reached, the record is too long, the read timed out, or nothing came back.
  for (const error of [
    relayAnswered("rate-limited: public reads are busy; retry in 41s"),
    relayAnswered("rate-limited: shared admission unavailable"),
    relayAnswered(
      "unavailable: this project's record is too long to read without an invite",
    ),
    relayAnswered("query timed out"),
    relayAnswered("server responded 503"),
    new TypeError("Failed to fetch"),
  ])
    assert.equal(publicRecordFailure(error), "busy", String(error));
  assert.doesNotMatch(PUBLIC_RECORD_BUSY_TITLE, /invite/i);
  assert.match(PUBLIC_RECORD_BUSY_TEXT, /Try again/);
});
