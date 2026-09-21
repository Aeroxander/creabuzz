// Audit-log derivations: rows, kind tones, timestamps, verify summary (pure).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIT_EVENT_KINDS,
  AUDIT_FETCH_LIMIT,
  auditDescription,
  auditKindTone,
  deriveAuditRows,
  deriveVerifySummary,
  fullTimestampLabel,
} from "./audit.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const NOW = 1_800_000;
const DAO = "0x1234567890abcdef1234567890abcdef12345678";

function auditEvent({
  id = "evt-1",
  kind,
  pubkey = ALICE,
  createdAt = NOW - 100,
  dtag = "some-d",
  content = {},
  extraTags = [],
}) {
  return {
    id,
    pubkey,
    created_at: createdAt,
    kind,
    tags: [["d", dtag], ...extraTags],
    content: typeof content === "string" ? content : JSON.stringify(content),
    sig: "mock-sig",
  };
}

describe("auditKindTone", () => {
  it("maps the documented kind tones", () => {
    assert.equal(auditKindTone(37010), "neutral");
    assert.equal(auditKindTone(37011), "review");
    assert.equal(auditKindTone(37012), "waiting");
    assert.equal(auditKindTone(37014), "ok");
    assert.equal(auditKindTone(46010), "live");
    assert.equal(auditKindTone(46030), "live");
    assert.equal(auditKindTone(46031), "live");
  });

  it("covers exactly the eight structural kinds", () => {
    assert.deepEqual(
      [...AUDIT_EVENT_KINDS],
      [37010, 37011, 37012, 37013, 37014, 46010, 46030, 46031],
    );
  });
});

describe("auditDescription", () => {
  it("describes a grant with grantee and verbs", () => {
    const names = new Map([[BOB, "Bob"]]);
    const text = auditDescription(
      auditEvent({
        kind: 37011,
        content: {
          issuer: ALICE,
          grantee: BOB,
          via: "eng",
          verbs: ["read:#leadership"],
        },
      }),
      { namesByPubkey: names, namesByDtag: new Map([["eng", "Engineering"]]) },
    );
    assert.equal(text, "Granted Bob: read:#leadership via Engineering");
  });

  it("describes a revocation", () => {
    const text = auditDescription(
      auditEvent({
        kind: 37011,
        dtag: "g1",
        content: {
          issuer: ALICE,
          grantee: BOB,
          via: "",
          verbs: ["read:#eng"],
          revoked: true,
        },
      }),
      { namesByPubkey: new Map(), namesByDtag: new Map() },
    );
    assert.equal(text, "Revoked grant read:#eng");
  });

  it("describes a DAO binding on a root node", () => {
    const text = auditDescription(
      auditEvent({
        kind: 37010,
        content: {
          name: "Founder",
          onchain: { chain: "eip155:8453", dao: DAO },
        },
      }),
      { namesByPubkey: new Map(), namesByDtag: new Map() },
    );
    assert.equal(text, "Bound the org root to eip155:8453 DAO 0x123456…5678");
  });

  it("falls back to the event id when an approval request has no d tag", () => {
    const text = auditDescription(
      auditEvent({ kind: 46010, dtag: "", content: "please approve" }),
      { namesByPubkey: new Map(), namesByDtag: new Map() },
    );
    assert.match(text, /^Approval requested: /);
  });

  it("returns null for a non-audit kind", () => {
    assert.equal(
      auditDescription(auditEvent({ kind: 1, content: "hello" }), {
        namesByPubkey: new Map(),
        namesByDtag: new Map(),
      }),
      null,
    );
  });

  it("never renders raw JSON for malformed content", () => {
    const text = auditDescription(
      auditEvent({ kind: 37012, content: "not json at all" }),
      { namesByPubkey: new Map(), namesByDtag: new Map() },
    );
    assert.ok(!text.includes("{"));
    assert.match(text, /^Budget set for /);
  });
});

describe("deriveAuditRows", () => {
  it("sorts newest first across kinds", () => {
    const events = [
      auditEvent({
        id: "old",
        kind: 37010,
        createdAt: NOW - 500,
        content: { name: "Root" },
      }),
      auditEvent({
        id: "new",
        kind: 37014,
        createdAt: NOW - 10,
        content: { amount: 100, unit: "usd-cents" },
      }),
      auditEvent({
        id: "mid",
        kind: 37011,
        createdAt: NOW - 100,
        content: { grantee: BOB, verbs: ["read"] },
      }),
    ];
    const rows = deriveAuditRows({
      events,
      namesByPubkey: new Map([[BOB, "Bob"]]),
      namesByDtag: new Map(),
    });
    assert.deepEqual(
      rows.map((r) => r.key),
      ["new", "mid", "old"],
    );
  });

  it("escalates a revoked grant to the blocking tone", () => {
    const rows = deriveAuditRows({
      events: [
        auditEvent({
          kind: 37011,
          content: { grantee: BOB, verbs: ["read"], revoked: true },
        }),
      ],
      namesByPubkey: new Map(),
      namesByDtag: new Map(),
    });
    assert.equal(rows[0].tone, "blocking");
  });

  it("keeps every fetched event (no extra row cap beyond the fetch)", () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      auditEvent({
        id: `e${i}`,
        kind: 37012,
        createdAt: NOW - i,
        content: { subject: BOB, window: "day", limits: { runs: 1 } },
      }),
    );
    const rows = deriveAuditRows({
      events,
      namesByPubkey: new Map([[BOB, "Bob"]]),
      namesByDtag: new Map(),
    });
    assert.equal(rows.length, 40);
  });
});

describe("fullTimestampLabel", () => {
  it("is deterministic ISO 8601 UTC", () => {
    assert.equal(fullTimestampLabel(0), "1970-01-01T00:00:00.000Z");
  });
});

describe("deriveVerifySummary", () => {
  it("verifies when every sampled id is present in the fresh fetch", () => {
    const summary = deriveVerifySummary({
      previousTopIds: ["a", "b", "c"],
      refetchedIds: ["c", "b", "a"],
      hitFetchLimit: false,
    });
    assert.equal(summary.state, "verified");
    assert.equal(summary.checkedCount, 3);
    assert.equal(summary.presentCount, 3);
    assert.deepEqual(summary.missingIds, []);
  });

  it("degrades when a previously visible entry is gone", () => {
    const summary = deriveVerifySummary({
      previousTopIds: ["a", "b", "c"],
      refetchedIds: ["c", "b"],
      hitFetchLimit: false,
    });
    assert.equal(summary.state, "degraded");
    assert.deepEqual(summary.missingIds, ["a"]);
  });

  it("samples at most AUDIT_VERIFY_SAMPLE ids", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const summary = deriveVerifySummary({
      previousTopIds: ids,
      refetchedIds: ids.slice(0, 12),
      hitFetchLimit: true,
    });
    assert.equal(summary.checkedCount, 12);
    assert.equal(summary.state, "verified");
    assert.equal(summary.hitFetchLimit, true);
  });

  it("keeps the bounded fetch constant honest", () => {
    assert.equal(AUDIT_FETCH_LIMIT, 200);
  });
});
