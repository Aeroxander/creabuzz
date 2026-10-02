import assert from "node:assert/strict";
import test from "node:test";

import {
  chatAccess,
  hasChat,
  pendingBackers,
  roomToOpen,
} from "./launch-chat.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const chat = { team: "t-room", supporters: "s-room" };

test("pendingBackers lists each bidder once, oldest first", () => {
  const bids = [
    { author: B, createdAt: 30 },
    { author: C, createdAt: 20 },
    { author: B, createdAt: 10 },
  ];
  assert.deepEqual(pendingBackers(bids, new Set(), []), [B, C]);
});

test("pendingBackers skips members and the team, ignoring key case", () => {
  const bids = [
    { author: A.toUpperCase(), createdAt: 1 },
    { author: B, createdAt: 2 },
    { author: C, createdAt: 3 },
  ];
  assert.deepEqual(pendingBackers(bids, new Set([B]), [A]), [C]);
});

test("pendingBackers is empty without bids", () => {
  assert.deepEqual(pendingBackers([], new Set(), []), []);
});

test("chatAccess: seeing a room means membership", () => {
  const access = chatAccess({
    chat,
    visibleRooms: new Set(["s-room"]),
    viewer: B,
    bidders: [],
  });
  assert.equal(access, "member");
});

test("chatAccess: a bidder who cannot see a room is pending", () => {
  const access = chatAccess({
    chat,
    visibleRooms: new Set(),
    viewer: B,
    bidders: [B.toUpperCase()],
  });
  assert.equal(access, "pending");
});

test("chatAccess: no bid and no room is none, including signed out", () => {
  assert.equal(
    chatAccess({ chat, visibleRooms: new Set(), viewer: C, bidders: [B] }),
    "none",
  );
  assert.equal(
    chatAccess({ chat, visibleRooms: new Set(), viewer: null, bidders: [B] }),
    "none",
  );
});

test("hasChat is false until a room exists", () => {
  assert.equal(hasChat({ team: null, supporters: null }), false);
  assert.equal(hasChat({ team: null, supporters: "s" }), true);
});

test("roomToOpen prefers the supporters room, falls back to the team room", () => {
  assert.equal(roomToOpen(chat, new Set(["s-room", "t-room"])), "s-room");
  assert.equal(roomToOpen(chat, new Set(["t-room"])), "t-room");
  assert.equal(roomToOpen(chat, new Set()), null);
});
