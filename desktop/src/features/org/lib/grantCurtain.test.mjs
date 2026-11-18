// Tests for the grant curtain grouping (lib/grantCurtain.ts).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/grantCurtain.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  groupGrantsByLifecycle,
  isGrantActive,
  isGrantExpired,
} from "./grantCurtain.ts";

const NOW = 1_700_000_000;

function grant(overrides = {}) {
  return {
    eventId: "evt",
    dtag: "g-1",
    grantee: "g".repeat(64),
    via: "node-1",
    verbs: ["read"],
    revoked: false,
    createdAt: NOW - 600,
    ...overrides,
  };
}

describe("isGrantExpired / isGrantActive", () => {
  it("no expiry -> never expired", () => {
    assert.equal(isGrantExpired(grant(), NOW), false);
    assert.equal(isGrantActive(grant(), NOW), true);
  });
  it("expiry strictly in the future -> active", () => {
    const g = grant({ expires: NOW + 1 });
    assert.equal(isGrantExpired(g, NOW), false);
    assert.equal(isGrantActive(g, NOW), true);
  });
  it("expiry exactly at now -> expired (grant valid only strictly before)", () => {
    const g = grant({ expires: NOW });
    assert.equal(isGrantExpired(g, NOW), true);
    assert.equal(isGrantActive(g, NOW), false);
  });
  it("revoked grant is never active even with a future expiry", () => {
    const g = grant({ revoked: true, expires: NOW + 1000 });
    assert.equal(isGrantActive(g, NOW), false);
  });
});

describe("groupGrantsByLifecycle", () => {
  it("empty input -> empty output", () => {
    assert.deepEqual(groupGrantsByLifecycle([], NOW), {
      active: [],
      curtain: [],
    });
  });
  it("active grants stay in the chain", () => {
    const g1 = grant({ dtag: "a" });
    const g2 = grant({ dtag: "b", expires: NOW + 100 });
    const { active, curtain } = groupGrantsByLifecycle([g1, g2], NOW);
    assert.equal(active.length, 2);
    assert.equal(curtain.length, 0);
  });
  it("revoked grant lands in the curtain with reason revoked", () => {
    const g = grant({ revoked: true });
    const { active, curtain } = groupGrantsByLifecycle([g], NOW);
    assert.equal(active.length, 0);
    assert.deepEqual(curtain, [{ grant: g, reason: "revoked" }]);
  });
  it("unrevoked expired grant lands in the curtain with reason expired", () => {
    const g = grant({ expires: NOW - 10 });
    const { active, curtain } = groupGrantsByLifecycle([g], NOW);
    assert.equal(active.length, 0);
    assert.deepEqual(curtain, [{ grant: g, reason: "expired" }]);
  });
  it("revoked wins over expired labelling", () => {
    const g = grant({ revoked: true, expires: NOW - 10 });
    const { curtain } = groupGrantsByLifecycle([g], NOW);
    assert.equal(curtain[0].reason, "revoked");
  });
  it("curtain reads newest-first", () => {
    const old = grant({ dtag: "old", revoked: true, createdAt: NOW - 5000 });
    const fresh = grant({ dtag: "fresh", revoked: true, createdAt: NOW - 10 });
    const { curtain } = groupGrantsByLifecycle([old, fresh], NOW);
    assert.deepEqual(
      curtain.map((entry) => entry.grant.dtag),
      ["fresh", "old"],
    );
  });
  it("revoked grants are never active regardless of age", () => {
    const g = grant({ revoked: true, createdAt: NOW - 9000 });
    const { active, curtain } = groupGrantsByLifecycle([g], NOW);
    assert.equal(active.length, 0);
    assert.equal(curtain.length, 1);
  });
  it("equal timestamps tiebreak revoked before expired", () => {
    const expired = grant({ dtag: "expired", expires: NOW - 10 });
    const revoked = grant({ dtag: "revoked", revoked: true });
    const { curtain } = groupGrantsByLifecycle([expired, revoked], NOW);
    assert.deepEqual(
      curtain.map((entry) => entry.reason),
      ["revoked", "expired"],
    );
  });
});
