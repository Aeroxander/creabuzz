// Dashboard derivations: blocking banners + activity rows (pure logic).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveBlockingBanners,
  deriveActivityRows,
  relativeTimeLabel,
} from "./dashboard.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const NOW = 1_800_000;

function node({
  dtag = "eng",
  name = "Engineering",
  seats = [],
  holders = [],
} = {}) {
  return {
    eventId: `node-${dtag}`,
    author: ALICE,
    dtag,
    name,
    kind: "team",
    holders,
    agentSeats: seats,
    createdAt: NOW - 1000,
    revoked: false,
  };
}

function grant({
  dtag = "grant-1",
  issuer = ALICE,
  grantee = BOB,
  via = "eng",
  verbs = ["read"],
  parentGrant,
  expires,
  revoked = false,
  createdAt = NOW - 900,
}) {
  return {
    eventId: `grant-${dtag}`,
    author: ALICE,
    dtag,
    issuer,
    grantee,
    via,
    verbs,
    parentGrant,
    expires,
    revoked,
    createdAt,
  };
}

function budget({
  dtag = "budget-1",
  subject = BOB,
  window = "month",
  runs = 10,
  createdAt = NOW - 800,
}) {
  return {
    eventId: `budget-${dtag}`,
    author: ALICE,
    dtag,
    subject,
    window,
    limits: { runs },
    onExceed: "require-approval",
    createdAt,
    revoked: false,
  };
}

const names = new Map([
  [BOB, "Bob"],
  [ALICE, "Alice"],
]);

describe("deriveBlockingBanners", () => {
  const baseInput = {
    budgets: [],
    utilizations: [],
    grants: [],
    liveness: new Map(),
    nodes: [],
    namesByPubkey: names,
    nowSeconds: NOW,
  };

  it("produces no banners when nothing blocks", () => {
    assert.deepEqual(
      deriveBlockingBanners({
        ...baseInput,
        budgets: [budget({ runs: 10 })],
        utilizations: [{ budget: budget({}), summary: null }],
        liveness: new Map([[BOB, { status: "live", lastSeenAt: NOW - 10 }]]),
        nodes: [node({ seats: [BOB] })],
      }),
      [],
    );
  });

  it("flags a budget at/over 90% with cause + consequence + one action", () => {
    const b = budget({ runs: 10, subject: BOB });
    const banners = deriveBlockingBanners({
      ...baseInput,
      budgets: [b],
      utilizations: [
        {
          budget: b,
          summary: {
            consumed: 9,
            limit: 10,
            truncated: false,
            windowStart: NOW - 86400,
          },
        },
      ],
      namesByPubkey: names,
    });
    assert.equal(banners.length, 1);
    assert.equal(banners[0].key, `budget-${b.dtag}`);
    assert.equal(banners[0].tone, "blocking");
    assert.match(banners[0].title, /Bob hit 90% of its month runs budget/);
    assert.match(banners[0].detail, /rejected/);
    assert.equal(banners[0].actionLabel, "Raise the budget");
    assert.equal(banners[0].actionTarget, "budgets");
  });

  it("skips budgets under the threshold and budgets without a runs ceiling", () => {
    const cheap = budget({ dtag: "cheap", runs: 100, subject: BOB });
    const noCeiling = budget({ dtag: "none", runs: 0, subject: BOB });
    const banners = deriveBlockingBanners({
      ...baseInput,
      budgets: [cheap, noCeiling],
      utilizations: [
        {
          budget: cheap,
          summary: {
            consumed: 50,
            limit: 100,
            truncated: false,
            windowStart: NOW - 86400,
          },
        },
        {
          budget: noCeiling,
          summary: {
            consumed: 3,
            limit: 0,
            truncated: false,
            windowStart: NOW - 86400,
          },
        },
      ],
    });
    assert.deepEqual(banners, []);
  });

  it("flags offline agents that still hold active grants", () => {
    const banners = deriveBlockingBanners({
      ...baseInput,
      grants: [grant({ grantee: BOB })],
      liveness: new Map([[BOB, { status: "gone", lastSeenAt: null }]]),
      nodes: [node({ seats: [BOB] })],
    });
    assert.equal(banners.length, 1);
    assert.equal(banners[0].key, "gone-agents-with-grants");
    assert.equal(banners[0].tone, "waiting");
    assert.equal(banners[0].actionLabel, "Open grants");
  });

  it("does not flag a gone agent whose grants are all revoked or expired", () => {
    const revoked = grant({ grantee: BOB, revoked: true });
    const expired = grant({ grantee: BOB, expires: NOW - 100 });
    const banners = deriveBlockingBanners({
      ...baseInput,
      grants: [revoked, expired],
      liveness: new Map([[BOB, { status: "gone", lastSeenAt: null }]]),
      nodes: [node({ seats: [BOB] })],
    });
    assert.deepEqual(banners, []);
  });

  it("flags expired grants still referenced as parentGrant by active ones", () => {
    const parent = grant({
      dtag: "gone-parent",
      expires: NOW - 100,
      revoked: false,
    });
    const child = grant({
      dtag: "active-child",
      parentGrant: "gone-parent",
      expires: NOW + 1000,
    });
    const banners = deriveBlockingBanners({
      ...baseInput,
      grants: [parent, child],
    });
    assert.equal(banners.length, 1);
    assert.equal(banners[0].key, "expired-parent-grants");
    assert.match(banners[0].title, /1 expired grant still parents/);
    assert.equal(banners[0].actionLabel, "Review grants");
  });

  it("orders over-budget agents first and worst first", () => {
    const b1 = budget({ dtag: "b1", runs: 10, subject: BOB });
    const b2 = budget({ dtag: "b2", runs: 10, subject: ALICE });
    const banners = deriveBlockingBanners({
      ...baseInput,
      budgets: [b1, b2],
      utilizations: [
        {
          budget: b1,
          summary: {
            consumed: 10,
            limit: 10,
            truncated: false,
            windowStart: NOW - 86400,
          },
        },
        {
          budget: b2,
          summary: {
            consumed: 9,
            limit: 10,
            truncated: false,
            windowStart: NOW - 86400,
          },
        },
      ],
      grants: [grant({ grantee: BOB })],
      liveness: new Map([[BOB, { status: "gone", lastSeenAt: null }]]),
      nodes: [node({ seats: [BOB] })],
    });
    assert.equal(banners.length, 3);
    assert.equal(banners[0].key, "budget-b1"); // 100% worst
    assert.equal(banners[1].key, "budget-b2"); // 90% second
    assert.equal(banners[2].key, "gone-agents-with-grants");
  });
});

describe("activity rows", () => {
  const contribution = {
    eventId: "cr-1",
    author: ALICE,
    dtag: "cr-1",
    action: "Shipped the chart viewer",
    reviewStatus: "pending",
    createdAt: NOW - 50,
  };
  const extras = [
    {
      id: "approval-1",
      kind: 46010,
      pubkey: "0000".padEnd(64, "0"),
      created_at: NOW - 20,
      tags: [["d", "ab12".padEnd(64, "3")]],
      content: JSON.stringify({
        type: "budget-exceeded",
        subject: BOB,
        counterType: "runs",
        window: "month",
        limit: 30,
      }),
    },
    {
      id: "receipt-1",
      kind: 37014,
      pubkey: "0000".padEnd(64, "0"),
      created_at: NOW - 10,
      tags: [["d", "feed1234567890"]],
      content: "{}",
    },
    {
      id: "grant-res-1",
      kind: 46030,
      pubkey: "1111".padEnd(64, "0"),
      created_at: NOW - 5,
      tags: [["d", "cafe".padEnd(64, "4")]],
      content: "",
    },
  ];

  const input = {
    nodes: [node({ seats: [BOB] })],
    grants: [grant({ verbs: ["read:#eng"], via: "eng" })],
    budgets: [budget({})],
    contributions: [contribution],
    extras,
    namesByPubkey: names,
    namesByDtag: new Map([["eng", "Engineering"]]),
  };

  it("renders every kind as a readable line with the right tone and tab", () => {
    const rows = deriveActivityRows(input);
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    assert.equal(byKind.get(37010).description, "Node updated: Engineering");
    assert.equal(byKind.get(37010).tone, "neutral");
    assert.match(
      byKind.get(37011).description,
      /Alice granted Bob: read:#eng via Engineering/,
    );
    assert.equal(byKind.get(37011).tone, "review");
    assert.match(byKind.get(37012).description, /Bob: 10 runs\/month/);
    assert.equal(byKind.get(37012).tone, "waiting");
    assert.match(
      byKind.get(37013).description,
      /pending review of: Shipped the chart viewer/,
    );
    assert.equal(byKind.get(37013).tone, "waiting");
    assert.equal(byKind.get(37013).targetTab, "contributions");
    assert.match(
      byKind.get(46010).description,
      /Budget approval requested: Bob over 30 runs\/month/,
    );
    assert.equal(byKind.get(46010).tone, "waiting");
    assert.match(
      byKind.get(37014).description,
      /Spend receipt recorded: feed123456…/,
    );
    assert.equal(byKind.get(37014).tone, "ok");
    assert.match(byKind.get(46030).description, /Approval granted/);
    assert.equal(byKind.get(46030).tone, "ok");
    for (const row of rows) {
      const expected = row.kind === 37013 ? "contributions" : "grants";
      assert.equal(row.targetTab, expected, `kind ${row.kind}`);
    }
  });

  it("sorts newest first and bounds the list", () => {
    const many = [];
    for (let i = 0; i < 40; i++) {
      many.push({
        ...contribution,
        eventId: `cr-${i}`,
        createdAt: NOW - i,
        action: `item ${i}`,
      });
    }
    const rows = deriveActivityRows({
      ...input,
      contributions: many,
      grants: [],
      budgets: [],
      nodes: [],
      extras: [],
    });
    assert.ok(rows.length <= 12);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].createdAt >= rows[i].createdAt);
    }
  });

  it("drops malformed approval events without rendering raw JSON", () => {
    const bad = [
      {
        id: "bad-1",
        kind: 46010,
        pubkey: ALICE,
        created_at: NOW - 5,
        tags: [], // no d tag → unresolvable
        content: "not-json",
      },
      {
        id: "bad-2",
        kind: 37014,
        pubkey: ALICE,
        created_at: "soon",
        tags: [],
        content: "{}",
      },
    ];
    const rows = deriveActivityRows({
      ...input,
      nodes: [],
      grants: [],
      budgets: [],
      contributions: [],
      extras: bad,
    });
    assert.equal(rows.length, 0);
  });

  it("never leaks raw JSON into a description", () => {
    const rows = deriveActivityRows(input);
    for (const row of rows) {
      assert.ok(!row.description.includes("{"), row.description);
      assert.ok(!row.description.includes('"'), row.description);
    }
  });
});

describe("relativeTimeLabel", () => {
  it("labels buckets deterministically", () => {
    assert.equal(relativeTimeLabel(1000, 1000), "just now");
    assert.equal(relativeTimeLabel(1000, 1059), "just now");
    assert.equal(relativeTimeLabel(1000, 1060), "1m ago");
    assert.equal(relativeTimeLabel(1000, 3600 + 1000), "1h ago");
    assert.equal(relativeTimeLabel(1000, 86_400 + 1000), "1d ago");
  });
});
