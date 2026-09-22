// Unit tests for NIP-ORG event parsing (camelCase content contract).
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/orgModels.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  eventToOrgNode,
  eventToOrgGrant,
  eventToOrgBudget,
  eventToContributionRecord,
  canonicalContributionRecords,
} from "./orgModels.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function orgEvent(kind, dtag, content, extras = {}) {
  return {
    id: `evt-${dtag}-${kind}`,
    pubkey: ALICE,
    created_at: 100,
    kind,
    tags: [["d", dtag], ...(extras.tags ?? [])],
    content: JSON.stringify(content),
    sig: "sig",
    ...extras.fields,
  };
}

describe("eventToOrgNode", () => {
  it("reads camelCase content keys", () => {
    const node = eventToOrgNode(
      orgEvent(37010, "eng", {
        v: 1,
        name: "Engineering",
        kind: "team",
        parent: "cto",
        holders: [ALICE],
        agentSeats: [BOB],
        scope: { max_agents: 3 },
      }),
    );
    assert.equal(node.dtag, "eng");
    assert.equal(node.name, "Engineering");
    assert.equal(node.kind, "team");
    assert.equal(node.parent, "cto");
    assert.deepEqual(node.holders, [ALICE]);
    assert.deepEqual(node.agentSeats, [BOB]);
    assert.equal(node.revoked, false);
  });

  it("fails open to a role with empty seat lists on malformed content", () => {
    const node = eventToOrgNode(
      orgEvent(37010, "eng", "not json", { fields: {} }),
    );
    assert.equal(node.kind, "role");
    assert.deepEqual(node.holders, []);
    assert.deepEqual(node.agentSeats, []);
    assert.equal(node.name, "eng");
  });

  it("marks kind:5 tombstones revoked", () => {
    const node = eventToOrgNode(orgEvent(5, "eng", { d: "eng" }));
    assert.equal(node.revoked, true);
  });

  it("marks a { revoked: true } republish revoked", () => {
    const node = eventToOrgNode(
      orgEvent(37010, "eng", { v: 1, name: "Eng", revoked: true }),
    );
    assert.equal(node.revoked, true);
  });
});

describe("eventToOrgGrant", () => {
  it("reads verbs, parentGrant, expires, and content grantee", () => {
    const grant = eventToOrgGrant(
      orgEvent(
        37011,
        "g1",
        {
          v: 1,
          issuer: ALICE,
          grantee: BOB,
          via: "cto",
          verbs: ["spend", "approve"],
          parentGrant: "root-grant",
          expires: 200,
          revoked: false,
        },
        { tags: [["p", BOB]] },
      ),
    );
    assert.equal(grant.dtag, "g1");
    assert.equal(grant.grantee, BOB);
    assert.equal(grant.via, "cto");
    assert.deepEqual(grant.verbs, ["spend", "approve"]);
    assert.equal(grant.parentGrant, "root-grant");
    assert.equal(grant.expires, 200);
    assert.equal(grant.revoked, false);
  });

  it("does not populate verbs from a snake_case payload", () => {
    // The camelCase contract is canonical; a snake_case body is not read.
    const grant = eventToOrgGrant(
      orgEvent(37011, "g1", { v: 1, verb: ["spend"], parent_grant: "x" }),
    );
    assert.deepEqual(grant.verbs, []);
    assert.equal(grant.parentGrant, undefined);
  });

  it("marks a { revoked: true } republish revoked", () => {
    const grant = eventToOrgGrant(orgEvent(37011, "g1", { revoked: true }));
    assert.equal(grant.revoked, true);
  });

  it("falls back to the p tag for the grantee", () => {
    const grant = eventToOrgGrant(
      orgEvent(37011, "g1", { v: 1 }, { tags: [["p", BOB]] }),
    );
    assert.equal(grant.grantee, BOB);
  });
});

describe("eventToOrgBudget", () => {
  it("reads camelCase onExceed and limits", () => {
    const budget = eventToOrgBudget(
      orgEvent(37012, "b1", {
        v: 1,
        subject: "agent-seat-1",
        window: "month",
        limits: { runs: 100, spend: { amount: 5000, unit: "usd-cents" } },
        onExceed: "require-approval",
      }),
    );
    assert.equal(budget.subject, "agent-seat-1");
    assert.equal(budget.window, "month");
    assert.equal(budget.limits.runs, 100);
    assert.equal(budget.limits.spend.amount, 5000);
    assert.equal(budget.onExceed, "require-approval");
    assert.equal(budget.onchain, undefined);
    assert.equal(budget.revoked, false);
  });

  it("reads a well-formed onchain spend binding", () => {
    const budget = eventToOrgBudget(
      orgEvent(37012, "b1", {
        v: 1,
        subject: BOB,
        window: "week",
        limits: { spend: { amount: 2500, unit: "usd-cents" } },
        onExceed: "require-approval",
        onchain: {
          chain: "anvil-31337",
          contract: "0xabc",
          subject: BOB,
        },
      }),
    );
    assert.deepEqual(budget.onchain, {
      chain: "anvil-31337",
      contract: "0xabc",
      subject: BOB,
    });
  });

  it("treats a malformed onchain binding as absent", () => {
    for (const onchain of [
      "not-an-object",
      [],
      {},
      { chain: "eip155:8453" },
      { chain: "eip155:8453", contract: "0xabc" },
      { chain: "", contract: "0xabc", subject: BOB },
    ]) {
      const budget = eventToOrgBudget(
        orgEvent(37012, "b1", {
          v: 1,
          subject: BOB,
          window: "day",
          limits: {},
          onExceed: "require-approval",
          onchain,
        }),
      );
      assert.equal(
        budget.onchain,
        undefined,
        `onchain: ${JSON.stringify(onchain)}`,
      );
    }
  });

  it("marks kind:5 tombstones revoked", () => {
    const budget = eventToOrgBudget(orgEvent(5, "b1", { d: "b1" }));
    assert.equal(budget.revoked, true);
  });
});

describe("eventToContributionRecord", () => {
  it("reads camelCase review fields", () => {
    const record = eventToContributionRecord(
      orgEvent(
        37013,
        "c1",
        {
          v: 1,
          action: "merged-pr",
          dimensions: { impact: 3 },
          humanVsAi: { human: 60, ai: 40 },
          classifierVersion: "cls-7",
          reviewStatus: "accepted",
          appealHistory: [{ status: "accepted", at: 200 }],
          informedBy: ["org-node:eng"],
        },
        {
          tags: [
            ["e", "evt-9"],
            ["a", "legacy-tag"],
          ],
        },
      ),
    );
    assert.equal(record.action, "merged-pr");
    assert.deepEqual(record.humanVsAi, { human: 60, ai: 40 });
    assert.equal(record.classifierVersion, "cls-7");
    assert.equal(record.reviewStatus, "accepted");
    assert.deepEqual(record.appealHistory, [{ status: "accepted", at: 200 }]);
    assert.deepEqual(record.evidence, ["evt-9"]);
    // Canonical camelCase content key wins over the legacy a-tag encoding.
    assert.deepEqual(record.informedBy, ["org-node:eng"]);
  });

  it("falls back to a tags when informedBy content key is absent", () => {
    const record = eventToContributionRecord(
      orgEvent(
        37013,
        "c1",
        { v: 1, action: "x" },
        { tags: [["a", "old-ref"]] },
      ),
    );
    assert.deepEqual(record.informedBy, ["old-ref"]);
  });

  it("defaults an unknown reviewStatus to pending", () => {
    const record = eventToContributionRecord(
      orgEvent(37013, "c1", { v: 1, action: "x", reviewStatus: "weird" }),
    );
    assert.equal(record.reviewStatus, "pending");
  });
});

describe("eventToOrgNode scope + onchain", () => {
  it("reads the camelCase scope and defaults missing scope to closed", () => {
    const scoped = eventToOrgNode(
      orgEvent(37010, "cto", {
        v: 1,
        name: "CTO",
        scope: {
          readBelow: true,
          assignBelow: true,
          canGrant: ["read", "spend:100000"],
        },
      }),
    );
    assert.deepEqual(scoped.scope, {
      readBelow: true,
      assignBelow: true,
      canGrant: ["read", "spend:100000"],
    });

    for (const scope of [undefined, "x", [], 7]) {
      const node = eventToOrgNode(orgEvent(37010, "cto", { v: 1, scope }));
      assert.deepEqual(node.scope, {
        readBelow: false,
        assignBelow: false,
        canGrant: [],
      });
    }
  });

  it("reads a well-formed root-node onchain DAO binding", () => {
    const node = eventToOrgNode(
      orgEvent(37010, "root", {
        v: 1,
        name: "Root",
        onchain: {
          chain: "eip155:8453",
          dao: "0xdao",
          boundAt: 1_798_765_432,
        },
      }),
    );
    assert.deepEqual(node.onchain, {
      chain: "eip155:8453",
      dao: "0xdao",
      boundAt: 1_798_765_432,
    });
  });

  it("treats a malformed node onchain binding as absent", () => {
    for (const onchain of [
      undefined,
      "x",
      [],
      {},
      { chain: "eip155:8453" },
      { dao: "0xdao" },
      { chain: "", dao: "0xdao" },
      { chain: "eip155:8453", dao: 7 },
    ]) {
      const node = eventToOrgNode(orgEvent(37010, "root", { v: 1, onchain }));
      assert.equal(
        node.onchain,
        undefined,
        `onchain: ${JSON.stringify(onchain)}`,
      );
    }
  });

  it("tolerates a missing boundAt", () => {
    const node = eventToOrgNode(
      orgEvent(37010, "root", {
        v: 1,
        onchain: { chain: "eip155:8453", dao: "0xdao" },
      }),
    );
    assert.deepEqual(node.onchain, {
      chain: "eip155:8453",
      dao: "0xdao",
      boundAt: undefined,
    });
  });
});


describe("canonicalContributionRecords", () => {
  const base = (overrides) => ({
    eventId: "evt-1",
    author: ALICE,
    dtag: "action-1",
    action: "did-a-thing",
    dimensions: {},
    evidence: [],
    humanVsAi: { human: 0, ai: 1 },
    informedBy: [],
    reviewStatus: "pending",
    appealHistory: [],
    createdAt: 100,
    ...overrides,
  });

  it("collapses reviewer forks to the newest record per action id", () => {
    const pending = base({
      eventId: "evt-author",
      reviewStatus: "pending",
      createdAt: 100,
    });
    const accepted = base({
      eventId: "evt-reviewer",
      author: BOB,
      reviewStatus: "accepted",
      createdAt: 200,
    });
    const out = canonicalContributionRecords([pending, accepted]);
    assert.equal(out.length, 1);
    assert.equal(out[0].eventId, "evt-reviewer");
    assert.equal(out[0].reviewStatus, "accepted");
  });

  it("keeps a newer rejection over an older acceptance", () => {
    const accepted = base({ eventId: "a", reviewStatus: "accepted", createdAt: 100 });
    const rejected = base({ eventId: "b", reviewStatus: "rejected", createdAt: 300 });
    const out = canonicalContributionRecords([accepted, rejected]);
    assert.equal(out.length, 1);
    assert.equal(out[0].reviewStatus, "rejected");
  });

  it("breaks created_at ties by lowest event id", () => {
    const laterId = base({ eventId: "zzz", createdAt: 100 });
    const earlierId = base({ eventId: "aaa", reviewStatus: "accepted", createdAt: 100 });
    const out = canonicalContributionRecords([laterId, earlierId]);
    assert.equal(out.length, 1);
    assert.equal(out[0].eventId, "aaa");
  });

  it("keeps distinct actions and preserves records without a dtag", () => {
    const one = base({ dtag: "action-1" });
    const two = base({ dtag: "action-2", eventId: "evt-2" });
    const orphan = base({ dtag: "", eventId: "evt-orphan" });
    const out = canonicalContributionRecords([one, two, orphan]);
    assert.equal(out.length, 3);
    assert.ok(out.some((r) => r.eventId === "evt-orphan"));
  });
});
