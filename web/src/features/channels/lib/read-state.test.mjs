import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PENDING_MARKS,
  parsePendingMarks,
  parseSidebarPage,
  readStateBase,
  settledMarks,
  unreadMarker,
  withMark,
  withoutSettled,
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

const mark = (n) => ({
  type: "mark_channel_read",
  channel_id: ROOM,
  message_id: n.toString(16).padStart(64, "0"),
});

test("marks wait until the server settles each one, and the same mark is kept once", () => {
  const a = { type: "mark_channel_read", channel_id: ROOM, message_id: MSG };
  const b = { type: "mark_channel_read", channel_id: ROOM, message_id: MSG2 };
  let pending = withMark([], a).marks;
  pending = withMark(pending, a).marks;
  pending = withMark(pending, b).marks;
  assert.deepEqual(pending, [a, b]);
  // Applied, blocked and invalid settle; an unknown or missing outcome is sent again as it was.
  const settle = (json) => withoutSettled(pending, settledMarks(pending, json));
  assert.deepEqual(
    settle({
      outcomes: [{ status: "applied" }, { status: "unknown", retryable: true }],
    }),
    [b],
  );
  assert.deepEqual(settle({ outcomes: [{ status: "blocked" }] }), [b]);
  assert.deepEqual(
    settle({ outcomes: [{ status: "invalid" }, { status: "applied" }] }),
    [],
  );
  assert.deepEqual(settle(null), pending);
});

test("a full queue refuses the next mark and keeps every mark it holds", () => {
  let many = [];
  for (let i = 0; i < MAX_PENDING_MARKS; i += 1) {
    const queued = withMark(many, mark(i));
    assert.equal(queued.accepted, true);
    many = queued.marks;
  }
  const refused = withMark(many, mark(MAX_PENDING_MARKS));
  assert.equal(refused.accepted, false);
  assert.deepEqual(refused.marks, many);
  assert.deepEqual(refused.marks[0], mark(0));
  // One already waiting is still accepted: it is kept once, not refused.
  assert.equal(withMark(many, mark(7)).accepted, true);
  // Room again once the server settles one.
  const after = withoutSettled(
    many,
    settledMarks([mark(0)], { outcomes: [{ status: "applied" }] }),
  );
  assert.equal(withMark(after, mark(MAX_PENDING_MARKS)).accepted, true);
});

test("an answer removes only the marks it settled: one added while the batch was in flight stays", () => {
  const sent = [mark(1), mark(2)];
  // While the batch was out, a newer mark joined the queue.
  const pending = [...sent, mark(3)];
  const left = withoutSettled(
    pending,
    settledMarks(sent, {
      outcomes: [{ status: "applied" }, { status: "applied" }],
    }),
  );
  assert.deepEqual(left, [mark(3)]);
  // Settled by identity, not by position: a queue reordered since the send still loses the right ones.
  assert.deepEqual(
    withoutSettled(
      [mark(3), mark(2), mark(1)],
      settledMarks(sent, {
        outcomes: [{ status: "applied" }, { status: "unknown" }],
      }),
    ),
    [mark(3), mark(2)],
  );
});

test("pending marks read back from the browser, ignoring anything that is not one", () => {
  const a = { type: "mark_channel_read", channel_id: ROOM, message_id: MSG };
  assert.deepEqual(parsePendingMarks(JSON.stringify([a, { type: "x" }, 3])), [
    a,
  ]);
  assert.deepEqual(parsePendingMarks("not json"), []);
  // More than the queue holds (an older build wrote them): the first hundred are kept, in order.
  const stored = Array.from({ length: MAX_PENDING_MARKS + 3 }, (_, i) =>
    mark(i),
  );
  assert.deepEqual(
    parsePendingMarks(JSON.stringify(stored)),
    stored.slice(0, MAX_PENDING_MARKS),
  );
  assert.deepEqual(parsePendingMarks(null), []);
});
