import assert from "node:assert/strict";
import test from "node:test";

import { roomTimeline } from "./room-events.ts";

const ROOM = "room-a";
const OTHER = "room-b";
const event = (id, created_at, room, extra = {}) => ({
  id,
  kind: 9,
  created_at,
  tags: [["h", room]],
  content: "",
  ...extra,
});
const created = (id, created_at, room) =>
  event(id, created_at, room, {
    kind: 40099,
    content: JSON.stringify({ type: "channel_created", actor: "x" }),
  });

test("only the room's own events are kept, once each, oldest first", () => {
  const timeline = roomTimeline(
    [
      event("2", 20, ROOM),
      created("other-made", 5, OTHER),
      event("1", 10, ROOM),
      event("2", 20, ROOM),
      event("untagged", 15, ROOM, { tags: [] }),
    ],
    ROOM,
  );
  assert.deepEqual(
    timeline.map((e) => e.id),
    ["1", "2"],
  );
});

test("the room's creation note comes before anything else from the same second", () => {
  const timeline = roomTimeline(
    [
      event("added", 100, ROOM, {
        kind: 40099,
        content: JSON.stringify({ type: "member_joined" }),
      }),
      created("made", 100, ROOM),
      event("hello", 100, ROOM),
    ],
    ROOM,
  );
  assert.equal(timeline[0].id, "made");
  assert.deepEqual(
    timeline.slice(1).map((e) => e.id),
    ["added", "hello"],
  );
});
