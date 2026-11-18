import test from "node:test";
import assert from "node:assert/strict";

import { describeSeat, helperSeats, seatUpdate } from "./helper-seats.ts";

const FOUNDER = "a".repeat(64);
const AGENT = "b".repeat(64);
const OTHER = "c".repeat(64);

function node(id, over = {}) {
  return {
    id,
    pubkey: FOUNDER,
    group: null,
    name: id,
    kind: "agent_seat",
    parent: "root",
    holders: [],
    agentSeats: [],
    scope: null,
    updatedAt: 1,
    ...over,
  };
}

function byKey(...nodes) {
  return Object.fromEntries(nodes.map((n) => [`${n.pubkey}:${n.id}`, n]));
}

test("seats are the agent seats, vacant first, each knowing which helper it is for", () => {
  const seats = helperSeats(
    byKey(
      node("root", { kind: "role", parent: null, name: "Studio" }),
      node("seat-writer", { name: "Head of Story", agentSeats: [AGENT] }),
      node("seat-producer", { name: "The Producer" }),
      node("by-hand", { name: "Alpha" }),
    ),
  );
  assert.deepEqual(
    seats.map((s) => [s.nodeId, s.personaId, s.occupants.length]),
    [
      ["by-hand", null, 0],
      ["seat-producer", "producer", 0],
      ["seat-writer", "writer", 1],
    ],
  );
});

test("a seat is open, or names who is in it and whether they are online", () => {
  const agents = new Map([
    [AGENT, { name: "The Writer", alive: true }],
    [OTHER, { name: "Old Helper", alive: false }],
  ]);
  const seat = (occupants) => ({
    nodeId: "s",
    key: "k",
    personaId: null,
    title: "t",
    occupants,
  });
  assert.deepEqual(describeSeat(seat([]), agents), {
    state: "open",
    text: "Open seat",
  });
  assert.deepEqual(describeSeat(seat([AGENT]), agents), {
    state: "online",
    text: "The Writer · online",
  });
  assert.deepEqual(describeSeat(seat([OTHER]), agents), {
    state: "offline",
    text: "Old Helper · offline",
  });
  assert.deepEqual(describeSeat(seat([AGENT, OTHER]), agents), {
    state: "online",
    text: "The Writer · online",
  });
  // Someone in the seat who never announced themselves is still a helper.
  assert.deepEqual(describeSeat(seat(["d".repeat(64)]), agents), {
    state: "offline",
    text: "A helper · offline",
  });
});

test("filling a seat changes only who is in it", () => {
  const entry = node("seat-writer", {
    name: "Head of Story",
    scope: { readBelow: true, assignBelow: false, canGrant: ["read"] },
  });
  const draft = seatUpdate(entry, AGENT.toUpperCase(), "fill");
  assert.equal(draft.kind, 37010);
  assert.deepEqual(draft.tags, [
    ["d", "seat-writer"],
    ["name", "Head of Story"],
    ["seat", AGENT],
  ]);
  assert.deepEqual(JSON.parse(draft.content), {
    v: 1,
    name: "Head of Story",
    kind: "agent_seat",
    parent: "root",
    holders: [],
    agentSeats: [AGENT],
    scope: { readBelow: true, assignBelow: false, canGrant: ["read"] },
  });
  // Already there: nothing to send.
  assert.equal(
    seatUpdate({ ...entry, agentSeats: [AGENT] }, AGENT, "fill"),
    null,
  );
});

test("emptying a seat takes out one helper and leaves the rest", () => {
  const entry = node("seat-writer", {
    agentSeats: [AGENT, OTHER],
    holders: [FOUNDER],
  });
  const draft = seatUpdate(entry, AGENT, "empty");
  assert.deepEqual(JSON.parse(draft.content).agentSeats, [OTHER]);
  assert.deepEqual(
    draft.tags.filter((t) => t[0] === "seat").map((t) => t[1]),
    [FOUNDER, OTHER],
  );
  assert.equal(seatUpdate(node("seat-writer"), AGENT, "empty"), null);
  // A seat with no scope on record gets the plain default, never null.
  assert.deepEqual(
    JSON.parse(seatUpdate(node("s"), AGENT, "fill").content).scope,
    {
      readBelow: false,
      assignBelow: false,
      canGrant: [],
    },
  );
});
