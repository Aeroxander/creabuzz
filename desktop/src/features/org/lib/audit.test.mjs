// Audit-log derivations: rows, kind tones, timestamps, verify summary (pure).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIT_EVENT_KINDS,
  AUDIT_FETCH_LIMIT,
  auditActorOptions,
  auditDescription,
  auditKindLabel,
  auditKindOptions,
  auditKindTone,
  deriveAuditRows,
  deriveVerifySummary,
  filterAuditRows,
  fullTimestampLabel,
  groupAuditRows,
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

  it("names the community-default budget instead of a truncated key", () => {
    const text = auditDescription(
      auditEvent({
        kind: 37012,
        content: { subject: "*", window: "day", limits: { messages: 3 } },
      }),
      { namesByPubkey: new Map(), namesByDtag: new Map() },
    );
    assert.equal(
      text,
      "Budget set for All agents (community default): 3 messages/day",
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

// ── Object refs, labels, filtering, grouping ────────────────────────────────

describe("auditKindLabel", () => {
  it("names every structural kind once", () => {
    assert.deepEqual(
      [37010, 37011, 37012, 37013, 37014, 46010, 46030, 46031].map(
        auditKindLabel,
      ),
      [
        "Node",
        "Grant",
        "Budget",
        "Contribution record",
        "Spend receipt",
        "Approval request",
        "Approval granted",
        "Approval denied",
      ],
    );
  });

  it("labels an unknown kind as unknown rather than as a known one", () => {
    assert.equal(auditKindLabel(1), "Unknown kind (1)");
  });
});

describe("deriveAuditRows — affected object refs", () => {
  it("links a node to its chart detail", () => {
    const rows = deriveAuditRows({
      events: [
        auditEvent({
          kind: 37010,
          dtag: "eng",
          content: { name: "Engineering" },
        }),
      ],
      namesByPubkey: new Map(),
      namesByDtag: new Map(),
    });
    assert.deepEqual(rows[0].object, { target: "node", id: "eng" });
  });

  it("links a grant to its detail sheet by d-tag", () => {
    const rows = deriveAuditRows({
      events: [
        auditEvent({
          kind: 37011,
          dtag: "g-7",
          content: { grantee: BOB, verbs: ["read:#eng"] },
        }),
      ],
      namesByPubkey: new Map(),
      namesByDtag: new Map(),
    });
    assert.deepEqual(rows[0].object, { target: "grant", id: "g-7" });
  });

  it("links a budget to its subject, and a spend receipt to the same subject", () => {
    const rows = deriveAuditRows({
      events: [
        auditEvent({
          kind: 37012,
          content: { subject: BOB, window: "day", limits: { runs: 1 } },
        }),
        auditEvent({
          kind: 37014,
          content: { amount: 10, unit: "usd-cents", subject: BOB },
        }),
      ],
      namesByPubkey: new Map(),
      namesByDtag: new Map(),
    });
    assert.deepEqual(rows[0].object, { target: "budget", id: BOB });
    assert.deepEqual(rows[1].object, { target: "budget", id: BOB });
  });

  it("shows an approval token without promising a detail view", () => {
    const rows = deriveAuditRows({
      events: [
        auditEvent({
          kind: 46010,
          dtag: "tok-1",
          content: "please approve the spend",
        }),
      ],
      namesByPubkey: new Map(),
      namesByDtag: new Map(),
    });
    assert.deepEqual(rows[0].object, { target: null, id: "tok-1" });
  });

  it("links a contribution record to the contributions tab", () => {
    const rows = deriveAuditRows({
      events: [
        auditEvent({
          kind: 37013,
          dtag: "rec-1",
          content: { action: "shipped parser", reviewStatus: "accepted" },
        }),
      ],
      namesByPubkey: new Map(),
      namesByDtag: new Map(),
    });
    assert.deepEqual(rows[0].object, { target: "record", id: "rec-1" });
  });
});

describe("filterAuditRows", () => {
  const rows = deriveAuditRows({
    events: [
      auditEvent({
        id: "a1",
        kind: 37010,
        pubkey: ALICE,
        content: { name: "Root" },
      }),
      auditEvent({
        id: "b1",
        kind: 37011,
        pubkey: BOB,
        content: { grantee: BOB, verbs: ["read"] },
      }),
      auditEvent({
        id: "a2",
        kind: 37012,
        pubkey: ALICE,
        content: { subject: BOB, window: "day", limits: {} },
      }),
    ],
    namesByPubkey: new Map(),
    namesByDtag: new Map(),
  });

  it("returns every row when no filter is active", () => {
    assert.equal(filterAuditRows(rows, {}).length, 3);
    assert.equal(filterAuditRows(rows, { actor: null, kind: null }).length, 3);
  });

  it("filters by actor (case-insensitive)", () => {
    assert.deepEqual(
      filterAuditRows(rows, { actor: ALICE }).map((row) => row.key),
      ["a1", "a2"],
    );
    assert.deepEqual(
      filterAuditRows(rows, { actor: BOB }).map((row) => row.key),
      ["b1"],
    );
  });

  it("filters by kind and by both at once", () => {
    assert.deepEqual(
      filterAuditRows(rows, { kind: 37011 }).map((row) => row.key),
      ["b1"],
    );
    assert.deepEqual(
      filterAuditRows(rows, { actor: ALICE, kind: 37012 }).map(
        (row) => row.key,
      ),
      ["a2"],
    );
    assert.deepEqual(filterAuditRows(rows, { actor: ALICE, kind: 46010 }), []);
  });
});

describe("groupAuditRows", () => {
  const rows = deriveAuditRows({
    events: [
      auditEvent({
        id: "newest",
        kind: 37010,
        pubkey: BOB,
        content: { name: "Root" },
      }),
      auditEvent({
        id: "older",
        kind: 37012,
        pubkey: ALICE,
        content: { subject: BOB, window: "day", limits: {} },
      }),
      auditEvent({
        id: "oldest",
        kind: 37012,
        pubkey: BOB,
        content: { subject: ALICE, window: "day", limits: {} },
      }),
    ],
    namesByPubkey: new Map([[ALICE, "Alice"]]),
    namesByDtag: new Map(),
  });

  it("returns no groups on the flat axis", () => {
    assert.deepEqual(groupAuditRows(rows, "none", new Map()), []);
  });

  it("groups by actor, newest actor first, resolving display names", () => {
    const groups = groupAuditRows(rows, "actor", new Map([[ALICE, "Alice"]]));
    assert.deepEqual(
      groups.map((group) => [group.key, group.label, group.rows.length]),
      [
        [BOB, `${BOB.slice(0, 8)}…${BOB.slice(-4)}`, 2],
        [ALICE, "Alice", 1],
      ],
    );
    assert.deepEqual(
      groups[0].rows.map((row) => row.key),
      ["newest", "oldest"],
    );
  });

  it("groups by kind with the kind's one name", () => {
    const groups = groupAuditRows(rows, "kind", new Map());
    assert.deepEqual(
      groups.map((group) => [group.label, group.rows.length]),
      [
        ["Node", 1],
        ["Budget", 2],
      ],
    );
  });
});

describe("filter options", () => {
  const rows = deriveAuditRows({
    events: [
      auditEvent({
        id: "x1",
        kind: 37010,
        pubkey: ALICE,
        content: { name: "Root" },
      }),
      auditEvent({
        id: "x2",
        kind: 37010,
        pubkey: BOB,
        content: { name: "Other" },
      }),
      auditEvent({
        id: "x3",
        kind: 37011,
        pubkey: BOB,
        content: { grantee: ALICE, verbs: ["read"] },
      }),
    ],
    namesByPubkey: new Map([[ALICE, "Alice"]]),
    namesByDtag: new Map(),
  });

  it("lists actors with counts, in first-appearance order", () => {
    assert.deepEqual(
      auditActorOptions(rows, new Map([[ALICE, "Alice"]])).map((option) => [
        option.value,
        option.label,
        option.count,
      ]),
      [
        [ALICE, "Alice", 1],
        [BOB, `${BOB.slice(0, 8)}…${BOB.slice(-4)}`, 2],
      ],
    );
  });

  it("lists kinds with counts", () => {
    assert.deepEqual(
      auditKindOptions(rows).map((option) => [
        option.value,
        option.label,
        option.count,
      ]),
      [
        ["37010", "Node", 2],
        ["37011", "Grant", 1],
      ],
    );
  });
});
