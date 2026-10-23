import assert from "node:assert/strict";
import test from "node:test";

import {
  isServerNote,
  KIND_SYSTEM_NOTE,
  parseSystemNote,
  systemNoteText,
} from "./system-notes.ts";

const SERVER = "5".repeat(64);
const BOARD = "b".repeat(64);
const REPLY = "c".repeat(64);
const ME = "d".repeat(64);

const NAMES = {
  [BOARD]: "Board Tester",
  [REPLY]: "Reply Tester",
  [ME]: "Me Myself",
};
const names = {
  nameOf: (pubkey) => NAMES[pubkey] ?? `${pubkey.slice(0, 8)}…`,
  self: ME,
};

const say = (body) =>
  systemNoteText(parseSystemNote(JSON.stringify(body)), names);

test("a new room's notes read as who made it and who was added", () => {
  assert.equal(
    say({ actor: BOARD, type: "channel_created" }),
    "Board Tester created this channel",
  );
  assert.equal(
    say({ actor: BOARD, target: REPLY, type: "member_joined" }),
    "Reply Tester was added by Board Tester",
  );
  assert.equal(
    say({ actor: REPLY, target: REPLY, type: "member_joined" }),
    "Reply Tester joined the channel",
  );
});

test("the reader is You, at the start of a sentence and inside it", () => {
  assert.equal(
    say({ actor: BOARD, target: ME, type: "member_joined" }),
    "You were added by Board Tester",
  );
  assert.equal(
    say({ actor: ME, target: REPLY, type: "member_joined" }),
    "Reply Tester was added by you",
  );
  assert.equal(
    say({ actor: ME, type: "channel_created" }),
    "You created this channel",
  );
  assert.equal(
    say({ actor: BOARD, target: ME, type: "member_removed" }),
    "Board Tester removed you from the channel",
  );
  // Matched by key, not by case.
  assert.equal(
    say({ actor: ME.toUpperCase(), type: "member_left" }),
    "You left the channel",
  );
});

test("the other notes the server writes have their own sentence", () => {
  assert.equal(
    say({ actor: REPLY, type: "member_left" }),
    "Reply Tester left the channel",
  );
  assert.equal(
    say({ type: "admin_kick", target: REPLY }),
    "Reply Tester was removed from the channel",
  );
  assert.equal(
    say({ actor: BOARD, type: "topic_changed", topic: " Launch week " }),
    "Board Tester changed the topic to “Launch week”",
  );
  assert.equal(
    say({ actor: BOARD, type: "purpose_changed", purpose: "  " }),
    "Board Tester cleared the purpose",
  );
  assert.equal(
    say({ actor: BOARD, type: "visibility_changed", visibility: "private" }),
    "Board Tester made this channel private",
  );
  assert.equal(
    say({ actor: BOARD, type: "ttl_changed", ttl_seconds: 172800 }),
    "Board Tester set this channel to clean up after 2 days without activity",
  );
  assert.equal(
    say({ actor: BOARD, type: "ttl_changed", ttl_seconds: null }),
    "Board Tester made this channel permanent",
  );
  assert.equal(
    say({ actor: BOARD, type: "channel_archived" }),
    "Board Tester archived this channel",
  );
  assert.equal(
    say({ type: "channel_auto_archived" }),
    "This channel was archived after a while without activity",
  );
  assert.equal(
    say({ actor: BOARD, type: "dm_created", participants: [BOARD, ME] }),
    "Board Tester started this conversation",
  );
  assert.equal(
    say({ actor: BOARD, type: "message_deleted", target_event_id: "e1" }),
    "Board Tester removed a message",
  );
  assert.equal(
    say({ actor: BOARD, type: "message_deleted", public_reason: "spam" }),
    "Removed by community moderators: spam",
  );
});

test("an unknown note, or one that is not readable, gets a neutral line and never its raw body", () => {
  assert.equal(
    say({ actor: BOARD, type: "something_new", detail: "x" }),
    "Board Tester updated this channel",
  );
  assert.equal(say({ type: "something_new" }), "This channel was updated");
  for (const body of ["not json", "[1,2]", "null", '"text"', '{"type":7}']) {
    assert.equal(
      systemNoteText(parseSystemNote(body), names),
      "This channel was updated",
    );
  }
  // A name the reader has no profile for is shortened, not dropped.
  assert.equal(
    say({ actor: "e".repeat(64), type: "channel_created" }),
    "eeeeeeee… created this channel",
  );
});

test("only the server's own notes count as notes", () => {
  const note = { kind: KIND_SYSTEM_NOTE, pubkey: SERVER };
  assert.equal(isServerNote(note, SERVER), true);
  // Someone else posting a note-shaped record: shown as their message instead.
  assert.equal(isServerNote({ ...note, pubkey: BOARD }, SERVER), false);
  // The server's key is not known: every note counts.
  assert.equal(isServerNote({ ...note, pubkey: BOARD }, null), true);
  assert.equal(isServerNote({ kind: 9, pubkey: SERVER }, SERVER), false);
});
