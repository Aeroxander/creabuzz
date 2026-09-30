// Copyright 2026 Creabuzz contributors.
// Alias-free unit tests for the NIP-ORG node index. Run with:
//   node --test web/src/features/fleet/lib/index-org.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseOrgNode,
  indexOrgNodes,
  buildOrgTree,
  orgNodeKey,
} from "./index-org.ts";

const ALICE = "a".repeat(64);
const CTO_AGENT = "c".repeat(64);

function node(tagOverrides = {}, content = { v: 1, name: "CTO" }) {
  return {
    pubkey: ALICE,
    created_at: 100,
    // No `h` tag: the org is community-level (like a project or launch
    // record), so a node carries only its `d`. A stray `h` is tolerated but
    // never required and never routes.
    tags: [
      ["d", "cto"],
      ...Object.entries(tagOverrides).map(([k, v]) => [k, v]),
    ],
    content: JSON.stringify(content),
  };
}

test("parseOrgNode accepts a valid node with seats", () => {
  const parsed = parseOrgNode({
    ...node(),
    content: JSON.stringify({
      v: 1,
      name: "CTO",
      kind: "role",
      holders: [ALICE],
      agentSeats: [CTO_AGENT],
    }),
  });
  assert.ok(parsed);
  assert.equal(parsed.id, "cto");
  assert.equal(parsed.group, null);
  assert.equal(parsed.kind, "role");
  assert.deepEqual(parsed.holders, [ALICE]);
  assert.deepEqual(parsed.agentSeats, [CTO_AGENT]);
});

test("parseOrgNode captures a stray h tag without requiring it", () => {
  // `h` is not part of the envelope: absent is valid, present is recorded for
  // reference only and never used for routing.
  const withH = parseOrgNode({
    ...node(),
    tags: [
      ["d", "cto"],
      ["h", "comm-1"],
    ],
  });
  assert.ok(withH);
  assert.equal(withH.group, "comm-1");
  const withoutH = parseOrgNode({ ...node(), tags: [["d", "cto"]] });
  assert.ok(withoutH, "a node with no `h` is still valid");
  assert.equal(withoutH.group, null);
});

test("parseOrgNode drops events with no d", () => {
  assert.equal(parseOrgNode({ ...node(), tags: [["h", "comm-1"]] }), null);
  assert.equal(parseOrgNode({ ...node(), tags: [] }), null);
});

test("parseOrgNode fails open on malformed content but keeps identity", () => {
  const parsed = parseOrgNode({
    ...node(),
    tags: [
      ["d", "cto"],
      ["h", "comm-1"],
      ["name", "CTO"],
    ],
    content: "not json",
  });
  assert.ok(parsed);
  assert.equal(parsed.id, "cto");
  assert.equal(parsed.name, "CTO");
});

test("parseOrgNode unknown kind fails open to role", () => {
  const parsed = parseOrgNode(node({}, { v: 1, kind: "emperor" }));
  assert.ok(parsed);
  assert.equal(parsed.kind, "role");
});

test("indexOrgNodes keys by author + d (NIP-33 replacement)", () => {
  // One member cannot shadow another author's node id.
  const indexed = indexOrgNodes([
    { ...node(), pubkey: ALICE },
    { ...node(), pubkey: "b".repeat(64), created_at: 200 },
  ]);
  assert.equal(Object.keys(indexed).length, 2);
  assert.ok(indexed[orgNodeKey(ALICE, "cto")]);
  assert.ok(indexed[orgNodeKey("b".repeat(64), "cto")]);
});

test("indexOrgNodes keeps newest per identity", () => {
  const indexed = indexOrgNodes([
    { ...node(), created_at: 200 },
    { ...node(), created_at: 100 },
  ]);
  assert.equal(Object.keys(indexed).length, 1);
  assert.equal(indexed[orgNodeKey(ALICE, "cto")].updatedAt, 200_000);
});

test("buildOrgTree nests child under parent across authors", () => {
  const bob = "b".repeat(64);
  const indexed = indexOrgNodes([
    { ...node(), content: JSON.stringify({ v: 1, name: "Founder" }) },
    {
      ...node(),
      pubkey: bob,
      tags: [
        ["d", "eng"],
        ["h", "comm-1"],
      ],
      content: JSON.stringify({ v: 1, name: "Eng", parent: "cto" }),
    },
  ]);
  const forest = buildOrgTree(indexed);
  assert.equal(forest.length, 1);
  assert.equal(forest[0].entry.id, "cto");
  assert.equal(forest[0].children.length, 1);
  assert.equal(forest[0].children[0].entry.id, "eng");
});

function cycleNode(id, parent) {
  return {
    pubkey: ALICE,
    created_at: 100,
    tags: [["d", id]],
    content: JSON.stringify({ v: 1, name: id.toUpperCase(), parent }),
  };
}

test("buildOrgTree assigns depth by walking from roots, not list order", () => {
  // Child listed before its parent still gets the correct depth.
  const indexed = indexOrgNodes([
    cycleNode("eng", "cto"),
    cycleNode("cto", null),
  ]);
  const forest = buildOrgTree(indexed);
  assert.equal(forest.length, 1);
  assert.equal(forest[0].entry.id, "cto");
  assert.equal(forest[0].depth, 0);
  assert.equal(forest[0].children[0].entry.id, "eng");
  assert.equal(forest[0].children[0].depth, 1);
});

test("buildOrgTree hoists one member of a parent cycle instead of dropping both", () => {
  // A<->B: both must stay visible; the smaller storage key is hoisted to a
  // root and the other stays its child.
  const indexed = indexOrgNodes([
    cycleNode("b-node", "a-node"),
    cycleNode("a-node", "b-node"),
  ]);
  const forest = buildOrgTree(indexed);
  assert.equal(forest.length, 1, "one of the two cycle members is a root");
  const hoisted = forest[0];
  assert.equal(hoisted.entry.id, "a-node");
  assert.equal(hoisted.depth, 0);
  assert.equal(hoisted.children.length, 1);
  assert.equal(hoisted.children[0].entry.id, "b-node");
  assert.equal(hoisted.children[0].depth, 1);
});

test("buildOrgTree hoists missing parents and self-loops to roots", () => {
  const indexed = indexOrgNodes([
    {
      ...node(),
      tags: [
        ["d", "orphan"],
        ["h", "comm-1"],
      ],
      content: JSON.stringify({ v: 1, name: "Orphan", parent: "ghost" }),
    },
    {
      ...node(),
      created_at: 101,
      content: JSON.stringify({ v: 1, name: "Loop", parent: "cto" }),
    },
  ]);
  // "orphan" has no live parent; "cto" (self-parent at created_at 100 is
  // shadowed) — both root so nothing is hidden.
  const forest = buildOrgTree(indexed);
  const ids = forest.map((n) => n.entry.id).sort();
  assert.deepEqual(ids, ["cto", "orphan"]);
});
