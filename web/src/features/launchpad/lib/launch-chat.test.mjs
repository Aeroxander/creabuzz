import assert from "node:assert/strict";
import test from "node:test";

import {
  hasChat,
  missingRooms,
  pendingBackers,
  roomRows,
  withRooms,
} from "./launch-chat.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const none = { team: null, supporters: null, backers: null };
const all = { team: "t-room", supporters: "s-room", backers: "b-room" };

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

test("hasChat is false until any room exists", () => {
  assert.equal(hasChat(none), false);
  assert.equal(hasChat({ ...none, backers: "b" }), true);
});

test("an idea needs team and supporters; a sale also needs backers", () => {
  assert.deepEqual(missingRooms(none, { sale: false }), ["team", "supporters"]);
  assert.deepEqual(missingRooms(none, { sale: true }), [
    "team",
    "supporters",
    "backers",
  ]);
  assert.deepEqual(
    missingRooms({ ...none, team: "t", supporters: "s" }, { sale: true }),
    ["backers"],
  );
  assert.deepEqual(missingRooms(all, { sale: true }), []);
});

test("withRooms fills gaps and never replaces a room that exists", () => {
  const merged = withRooms(
    { team: "t", supporters: null, backers: null },
    { team: "other", supporters: "s", backers: "b" },
  );
  assert.deepEqual(merged, { team: "t", supporters: "s", backers: "b" });
});

const base = {
  chat: all,
  visibleRooms: new Set(),
  supportersMembers: new Set(),
  viewer: B,
  bidders: [],
};
const standing = (rows, room) => rows.find((r) => r.room === room)?.standing;

test("a stranger can join the open room and is locked out of the gated one", () => {
  const rows = roomRows(base);
  assert.equal(standing(rows, "supporters"), "join");
  assert.equal(standing(rows, "backers"), "locked");
  assert.equal(standing(rows, "team"), undefined);
});

test("being in the open room's member list means member, ignoring key case", () => {
  const rows = roomRows({
    ...base,
    supportersMembers: new Set([B]),
    viewer: B.toUpperCase(),
  });
  assert.equal(standing(rows, "supporters"), "member");
});

test("an unknown member list never claims membership", () => {
  const rows = roomRows({ ...base, supportersMembers: null });
  assert.equal(standing(rows, "supporters"), "join");
});

test("a bidder is pending until the founder admits them", () => {
  const rows = roomRows({ ...base, bidders: [B.toUpperCase()] });
  assert.equal(standing(rows, "backers"), "pending");
  const admitted = roomRows({
    ...base,
    bidders: [B],
    visibleRooms: new Set(["b-room"]),
  });
  assert.equal(standing(admitted, "backers"), "member");
});

test("the team room is listed only to the team", () => {
  const rows = roomRows({ ...base, visibleRooms: new Set(["t-room"]) });
  assert.equal(standing(rows, "team"), "member");
});

test("signed out: join is offered, nothing is claimed", () => {
  const rows = roomRows({ ...base, viewer: null, bidders: [B] });
  assert.equal(standing(rows, "supporters"), "join");
  assert.equal(standing(rows, "backers"), "locked");
});

test("rooms that do not exist are not listed", () => {
  assert.deepEqual(roomRows({ ...base, chat: none }), []);
});
