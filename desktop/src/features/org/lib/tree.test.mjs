// Unit tests for the org tree assembly (two-pass depth + cycle hoisting).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/tree.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildOrgTree, buildGrantTree } from "./tree.ts";

function node(dtag, parent, name = dtag) {
  return {
    eventId: `evt-${dtag}`,
    dtag,
    name,
    kind: "role",
    parent,
    holders: [],
    agentSeats: [],
    createdAt: 100,
    revoked: false,
  };
}

function grant(dtag, parentGrant) {
  return {
    eventId: `evt-${dtag}`,
    dtag,
    grantee: "b".repeat(64),
    via: "",
    verbs: ["spend"],
    parentGrant,
    revoked: false,
    createdAt: 100,
  };
}

function rootIds(roots) {
  return roots.map((r) => r.node.dtag).sort();
}

describe("buildOrgTree depth", () => {
  it("assigns depth by walking from roots, not by list order", () => {
    // Child listed BEFORE its parent: a single-pass wiring would give the
    // child a stale (wrong) depth.
    const tree = buildOrgTree([
      node("eng", "cto"),
      node("backend", "eng"),
      node("cto", undefined),
    ]);
    assert.deepEqual(rootIds(tree.roots), ["cto"]);
    const cto = tree.roots[0];
    assert.equal(cto.depth, 0);
    assert.equal(cto.children[0].node.dtag, "eng");
    assert.equal(cto.children[0].depth, 1);
    assert.equal(cto.children[0].children[0].node.dtag, "backend");
    assert.equal(cto.children[0].children[0].depth, 2);
  });

  it("indexes every assembled node in byDtag", () => {
    const tree = buildOrgTree([
      node("cto", undefined),
      node("eng", "cto"),
      node("sales", undefined),
    ]);
    assert.deepEqual([...tree.byDtag.keys()].sort(), ["cto", "eng", "sales"]);
    assert.equal(tree.byDtag.get("eng").depth, 1);
  });
});

describe("buildOrgTree cycles", () => {
  it("hoists one member of an A<->B cycle to a root instead of dropping both", () => {
    const tree = buildOrgTree([node("b", "a"), node("a", "b")]);
    assert.equal(tree.roots.length, 1);
    // Stable rule: the lexicographically smaller d is hoisted.
    assert.equal(tree.roots[0].node.dtag, "a");
    assert.deepEqual(
      tree.roots[0].children.map((c) => c.node.dtag),
      ["b"],
    );
    assert.equal(tree.roots[0].children[0].depth, 1);
  });

  it("keeps a tail node's depth finite when its chain enters a cycle", () => {
    const tree = buildOrgTree([
      node("a", "b"),
      node("b", "a"),
      node("tail", "b"),
    ]);
    assert.deepEqual(rootIds(tree.roots), ["a"]);
    const a = tree.roots[0];
    const b = a.children.find((c) => c.node.dtag === "b");
    assert.ok(b);
    assert.equal(b.depth, 1);
    assert.deepEqual(
      b.children.map((c) => c.node.dtag),
      ["tail"],
    );
    assert.equal(b.children[0].depth, 2);
  });

  it("hoists self-parents to roots", () => {
    const tree = buildOrgTree([node("loop", "loop")]);
    assert.deepEqual(rootIds(tree.roots), ["loop"]);
  });
});

describe("buildOrgTree parents", () => {
  it("roots a node whose parent is missing", () => {
    const tree = buildOrgTree([node("orphan", "ghost")]);
    assert.deepEqual(rootIds(tree.roots), ["orphan"]);
  });

  it("does not nest children under revoked parents (they become roots)", () => {
    const revokedParent = { ...node("cto", undefined), revoked: true };
    const tree = buildOrgTree([revokedParent, node("eng", "cto")]);
    assert.deepEqual(rootIds(tree.roots), ["eng"]);
  });
});

describe("buildGrantTree", () => {
  it("nests grants by parentGrant with correct depth", () => {
    const roots = buildGrantTree([
      grant("child", "root"),
      grant("root", undefined),
    ]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].grant.dtag, "root");
    assert.equal(roots[0].children[0].grant.dtag, "child");
    assert.equal(roots[0].children[0].depth, 1);
  });

  it("hoists one member of a grant cycle instead of dropping both", () => {
    const roots = buildGrantTree([grant("ga", "gb"), grant("gb", "ga")]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].grant.dtag, "ga");
    assert.deepEqual(
      roots[0].children.map((c) => c.grant.dtag),
      ["gb"],
    );
  });
});
