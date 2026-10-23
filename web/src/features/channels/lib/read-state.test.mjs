import assert from "node:assert/strict";
import test from "node:test";

import {
  afterOutcomes,
  MAX_PENDING_MARKS,
  parsePendingMarks,
  parseSidebarPage,
  readStateBase,
  unreadMarker,
  withMark,
} from "./read-state.ts";

const ROOM = "0f0f0f0f-1111-2222-3333-444444444444";
const MSG = "a".repeat(64);
const MSG2 = "b".repeat(64);

test("the API is offered only when the server says so", () => {
  assert.equal(
    readStateBase({ buzz_v1: { version: 1, base_path: "/buzz/v1" } }),
    "/buzz/v1",
  );
  assert.equal(readStateBase({}), null);
  assert.equal(readStateBase(null), null);
  assert.equal(readStateBase({ buzz_v1: { base_path: "https://x/y" } }), null);
});

test("a sidebar page gives each room's counts and anchor; anything odd is unknown, not zero", () => {
  const { rows, nextCursor } = parseSidebarPage({
    channels: [
      {
        channel_id: ROOM,
        unread: { status: "exact", value: 3 },
        attention: { status: "exact", value: 1 },
        latest_message_id: MSG,
      },
      {
        channel_id: "other",
        unread: { status: "exact", value: -1 },
        attention: { status: "unknown" },
        latest_message_id: "not-hex",
      },
      { name: "no id" },
    ],
    next_cursor: "c2",
  });
  assert.equal(nextCursor, "c2");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    channelId: ROOM,
    unread: { status: "exact", value: 3 },
    attention: { status: "exact", value: 1 },
    latest: MSG,
  });
  assert.deepEqual(rows[1].unread, { status: "unknown" });
  assert.equal(rows[1].latest, null);
  assert.equal(parseSidebarPage({ channels: [] }).nextCursor, null);
});

test("the marker: nothing only for an exact zero, a number, a lower bound, or a dot when unknown", () => {
  const row = (unread, attention = { status: "exact", value: 0 }) => ({
    channelId: ROOM,
    unread,
    attention,
    latest: MSG,
  });
  assert.equal(unreadMarker(undefined), null);
  assert.equal(unreadMarker(row({ status: "exact", value: 0 })), null);
  assert.deepEqual(unreadMarker(row({ status: "exact", value: 4 })), {
    label: "4",
    attention: false,
    words: "4 unread",
  });
  assert.deepEqual(
    unreadMarker(
      row({ status: "at_least", value: 7 }, { status: "exact", value: 2 }),
    ),
    { label: "7+", attention: true, words: "7+ unread, some for you" },
  );
  assert.deepEqual(unreadMarker(row({ status: "unknown" })), {
    label: null,
    attention: false,
    words: "unread messages",
  });
});

test("marks wait until the server settles each one, and the same mark is kept once", () => {
  const a = { type: "mark_channel_read", channel_id: ROOM, message_id: MSG };
  const b = { type: "mark_channel_read", channel_id: ROOM, message_id: MSG2 };
  let pending = withMark([], a);
  pending = withMark(pending, a);
  pending = withMark(pending, b);
  assert.deepEqual(pending, [a, b]);
  // Applied and blocked settle; an unknown outcome is sent again as it was.
  assert.deepEqual(
    afterOutcomes(pending, {
      outcomes: [{ status: "applied" }, { status: "unknown", retryable: true }],
    }),
    [b],
  );
  assert.deepEqual(
    afterOutcomes(pending, { outcomes: [{ status: "blocked" }] }),
    [b],
  );
  assert.deepEqual(afterOutcomes(pending, null), pending);
  // Bounded.
  let many = [];
  for (let i = 0; i < MAX_PENDING_MARKS + 5; i += 1)
    many = withMark(many, {
      type: "mark_channel_read",
      channel_id: ROOM,
      message_id: i.toString(16).padStart(64, "0"),
    });
  assert.equal(many.length, MAX_PENDING_MARKS);
});

test("pending marks read back from the browser, ignoring anything that is not one", () => {
  const a = { type: "mark_channel_read", channel_id: ROOM, message_id: MSG };
  assert.deepEqual(parsePendingMarks(JSON.stringify([a, { type: "x" }, 3])), [
    a,
  ]);
  assert.deepEqual(parsePendingMarks("not json"), []);
  assert.deepEqual(parsePendingMarks(null), []);
});
