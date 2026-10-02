import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFollowGraph,
  likerWeight,
  MAX_TRUST_SHARE,
  percentiles,
  rankingStrength,
  rankScore,
  seededPageRank,
  trustBlend,
} from "./trust.ts";

const hex = (c) => c.repeat(64);
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map(hex);
const list = (pubkey, created_at, ...follows) => ({
  id: hex(String(created_at % 10)),
  pubkey,
  created_at,
  tags: follows.map((p) => ["p", p]),
});

test("only each author's newest contact list counts, and self-follows drop", () => {
  const graph = buildFollowGraph([
    list(A, 1, B, C),
    list(A, 5, B, A),
    list(B, 2, "not-hex"),
  ]);
  assert.deepEqual([...graph.get(A)], [B]);
  assert.equal(graph.get(B).size, 0);
});

test("PageRank scores sum to one and favour accounts many follow", () => {
  const graph = buildFollowGraph([
    list(A, 1, C),
    list(B, 1, C),
    list(D, 1, C),
    list(C, 1, E),
  ]);
  const rank = seededPageRank(graph, []);
  const total = [...rank.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `sums to ${total}`);
  assert.ok(rank.get(C) > rank.get(A));
  assert.ok(rank.get(C) > rank.get(B));
});

test("seeds pull trust toward the accounts they reach", () => {
  const graph = buildFollowGraph([
    list(A, 1, B),
    list(B, 1, C),
    list(D, 1, E),
    list(E, 1, D),
  ]);
  const fromA = seededPageRank(graph, [A]);
  assert.ok((fromA.get(C) ?? 0) > (fromA.get(E) ?? 0));
  const fromD = seededPageRank(graph, [D]);
  assert.ok((fromD.get(E) ?? 0) > (fromD.get(C) ?? 0));
});

test("an unknown seed falls back to a uniform walk instead of vanishing", () => {
  const graph = buildFollowGraph([list(A, 1, B)]);
  const rank = seededPageRank(graph, [hex("f")]);
  assert.ok(rank.size > 0);
});

test("percentiles span 0 to 1 and ties share a value", () => {
  const p = percentiles(
    new Map([
      [A, 0.1],
      [B, 0.1],
      [C, 0.5],
      [D, 0.9],
    ]),
  );
  assert.equal(p.get(D), 1);
  assert.equal(p.get(A), p.get(B));
  assert.ok(p.get(C) > p.get(A));
  assert.equal(percentiles(new Map([[A, 3]])).get(A), 1);
});

test("the blend is zero for a small community and rises smoothly", () => {
  assert.equal(trustBlend(0), 0);
  assert.equal(trustBlend(25), 0);
  let previous = 0;
  for (const size of [30, 50, 100, 200, 400, 800, 1_000]) {
    const blend = trustBlend(size);
    assert.ok(blend > previous, `${size}: ${blend} > ${previous}`);
    previous = blend;
  }
  assert.equal(trustBlend(1_000_000), MAX_TRUST_SHARE);
  // No cliff: growing by a few accounts moves the blend by a hair.
  assert.ok(trustBlend(41) - trustBlend(40) < 0.01);
});

test("a small community ranks almost chronologically, a large one leans on engagement", () => {
  assert.equal(rankingStrength(10), 0.25);
  assert.equal(rankingStrength(1_000), 1);
  assert.ok(rankingStrength(100) > rankingStrength(40));
});

test("at zero blend every liker counts the same; at full blend trust decides", () => {
  const stranger = { percentile: 0, followedByViewer: false };
  const known = { percentile: 1, followedByViewer: false };
  assert.equal(likerWeight(stranger, 0), 1);
  assert.equal(likerWeight(known, 0), 1);
  assert.ok(likerWeight(stranger, 0.8) < 1);
  assert.ok(likerWeight(known, 0.8) > 1);
  assert.ok(likerWeight(known, 0.8) > likerWeight(stranger, 0.8) * 3);
});

test("someone you follow counts for more, never past the ceiling", () => {
  const plain = { percentile: 0.4, followedByViewer: false };
  const followed = { ...plain, followedByViewer: true };
  assert.ok(likerWeight(followed, 0.6) > likerWeight(plain, 0.6));
  assert.ok(likerWeight({ percentile: 1, followedByViewer: true }, 1) <= 2);
});

test("a swarm of strangers loses to a few trusted likes once trust is in play", () => {
  const strangers = Array.from({ length: 6 }, () =>
    likerWeight({ percentile: 0, followedByViewer: false }, 0.8),
  ).reduce((a, b) => a + b, 0);
  const trusted = Array.from({ length: 2 }, () =>
    likerWeight({ percentile: 1, followedByViewer: false }, 0.8),
  ).reduce((a, b) => a + b, 0);
  assert.ok(trusted > strangers);
  // …and at zero blend the swarm wins on headcount, as before.
  assert.ok(6 > 2);
});

test("with no ranking strength the order is purely by time", () => {
  const older = { engagement: 50, at: 1_000_000 };
  const newer = { engagement: 0, at: 1_000_100 };
  assert.ok(rankScore(newer, 0) > rankScore(older, 0));
  // With strength, plenty of engagement can lift an older post.
  const much = { engagement: 5_000, at: 1_000_000 - 20_000 };
  assert.ok(rankScore(much, 1) > rankScore(newer, 1));
});
