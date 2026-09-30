// Tests for the org_grant.rs port. Every case mirrors a test in
// crates/buzz-core/src/org_grant.rs so the TS verifier and the Rust relay
// gate are pinned to the same behavior.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/grantVerify.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_GRANT_CHAIN_DEPTH,
  verbEntailedBy,
  verifyGrantChain,
} from "./grantVerify.ts";

// Fixed "current time" (unix seconds) for chain-verification tests.
const TEST_NOW = 1_700_000_000;

const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);
const PK_C = "c".repeat(64);
const PK_X = "x".repeat(64);

function makeNode(d, holders, canGrant) {
  return {
    d,
    holders,
    agentSeats: [],
    scope: { readBelow: true, assignBelow: true, canGrant },
  };
}

function makeGrant(
  d,
  issuer,
  grantee,
  via,
  verbs,
  parentGrant,
  revoked = false,
  expires,
) {
  const grant = { d, issuer, grantee, via, verbs, revoked };
  if (parentGrant !== undefined) grant.parentGrant = parentGrant;
  if (expires !== undefined) grant.expires = expires;
  return grant;
}

function chain(grants, nodes, start) {
  return verifyGrantChain(
    start,
    TEST_NOW,
    new Map(grants.map((g) => [g.d, g])),
    new Map(nodes.map((n) => [n.d, n])),
  );
}

function errorType(result) {
  return result.ok ? null : result.error.type;
}

describe("verbEntailedBy (mirror of verb_entailment_basic)", () => {
  it("same verb, no args -> entailed", () => {
    assert.ok(verbEntailedBy("read", "read"));
  });
  it("parent unbounded -> any child argument is a subset", () => {
    assert.ok(verbEntailedBy("read:#leadership", "read"));
  });
  it("child unbounded, parent scoped -> widening, rejected", () => {
    assert.ok(!verbEntailedBy("read", "read:#leadership"));
  });
  it("spend: child <= parent", () => {
    assert.ok(verbEntailedBy("spend:50000", "spend:100000"));
    assert.ok(!verbEntailedBy("spend:200000", "spend:100000"));
  });
  it("different names -> not entailed", () => {
    assert.ok(!verbEntailedBy("task:create", "read"));
  });
  it("channel scope: exact match or child contained by parent", () => {
    assert.ok(verbEntailedBy("read:#eng", "read:#eng"));
    assert.ok(verbEntailedBy("read:#eng:frontend", "read:#eng"));
  });
  it("different channels -> not entailed", () => {
    assert.ok(!verbEntailedBy("read:#eng", "read:#leadership"));
  });
  it("substring prefixes are NOT containment", () => {
    assert.ok(!verbEntailedBy("read:#l", "read:#leadership"));
  });
});

describe("verifyGrantChain", () => {
  it("accepts a valid root grant (grant_chain_valid_root)", () => {
    const result = chain(
      [makeGrant("g1", PK_A, PK_B, "cto", ["read"])],
      [makeNode("cto", [PK_A], ["read", "task"])],
      "g1",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("accepts a valid 2-level attenuated chain (grant_chain_valid_2_level)", () => {
    const result = chain(
      [
        makeGrant("g1", PK_A, PK_B, "cto", ["spend:100000"]),
        makeGrant("g2", PK_B, PK_C, "eng", ["spend:50000"], "g1"),
      ],
      [
        makeNode("cto", [PK_A], ["read", "task", "spend"]),
        makeNode("eng", [PK_B], ["read"]),
      ],
      "g2",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("rejects a revoked link (grant_chain_rejected_revoked)", () => {
    const result = chain(
      [makeGrant("g1", PK_A, PK_B, "cto", ["read"], undefined, true)],
      [makeNode("cto", [PK_A], ["read"])],
      "g1",
    );
    assert.equal(errorType(result), "revoked");
  });

  it("rejects an unseated issuer (grant_chain_rejected_issuer_not_seated)", () => {
    const result = chain(
      [makeGrant("g1", PK_X, PK_B, "cto", ["read"])],
      [makeNode("cto", [PK_A], ["read"])],
      "g1",
    );
    assert.equal(errorType(result), "issuer-not-seated");
  });

  it("rejects a widening child (grant_chain_rejected_attenuation_violation)", () => {
    const result = chain(
      [
        makeGrant("g1", PK_A, PK_B, "cto", ["spend:100000"]),
        makeGrant("g2", PK_B, PK_C, "eng", ["spend:200000"], "g1"),
      ],
      [
        makeNode("cto", [PK_A], ["read", "task"]),
        makeNode("eng", [PK_B], ["read"]),
      ],
      "g2",
    );
    assert.equal(errorType(result), "attenuation-violation");
    assert.equal(result.ok ? null : result.error.verb, "spend:200000");
  });

  it("rejects a root grant whose node lacks canGrant (root_lacks_standing)", () => {
    const result = chain(
      [makeGrant("g1", PK_A, PK_B, "cto", ["spend:100000"])],
      [makeNode("cto", [PK_A], ["read"])],
      "g1",
    );
    assert.equal(errorType(result), "root-lacks-standing");
  });

  it("rejects a circular chain (grant_chain_rejected_circular)", () => {
    const result = chain(
      [
        makeGrant("g1", PK_A, PK_B, "cto", ["read"], "g2"),
        makeGrant("g2", PK_A, PK_C, "cto", ["read"], "g1"),
      ],
      [makeNode("cto", [PK_A], ["read"])],
      "g1",
    );
    assert.equal(errorType(result), "circular-chain");
  });

  it("rejects channel widening with a substring prefix (grant_chain_rejects_channel_widening)", () => {
    const result = chain(
      [
        makeGrant("g1", PK_A, PK_B, "cto", ["read:#leadership"]),
        makeGrant("g2", PK_B, PK_C, "eng", ["read:#l"], "g1"),
      ],
      [
        makeNode("cto", [PK_A], ["read:#leadership"]),
        makeNode("eng", [PK_B], []),
      ],
      "g2",
    );
    assert.equal(errorType(result), "attenuation-violation");
  });

  it("accepts channel containment (grant_chain_accepts_channel_containment)", () => {
    const result = chain(
      [
        makeGrant("g1", PK_A, PK_B, "cto", ["read:#eng"]),
        makeGrant("g2", PK_B, PK_C, "eng", ["read:#eng:frontend"], "g1"),
      ],
      [makeNode("cto", [PK_A], ["read:#eng"]), makeNode("eng", [PK_B], [])],
      "g2",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("root standing compares the spend argument (grant_chain_root_standing_compares_spend_argument)", () => {
    const node = makeNode("cto", [PK_A], ["spend:100000"]);
    const over = chain(
      [makeGrant("g1", PK_A, PK_B, "cto", ["spend:999999"])],
      [node],
      "g1",
    );
    assert.equal(errorType(over), "root-lacks-standing");

    const under = chain(
      [makeGrant("g1", PK_A, PK_B, "cto", ["spend:50000"])],
      [node],
      "g1",
    );
    assert.deepEqual(under, { ok: true });
  });

  it("rejects an expired grant (grant_chain_rejected_expired_grant)", () => {
    const result = chain(
      [
        makeGrant(
          "g1",
          PK_A,
          PK_B,
          "cto",
          ["read"],
          undefined,
          false,
          TEST_NOW - 1,
        ),
      ],
      [makeNode("cto", [PK_A], ["read"])],
      "g1",
    );
    assert.equal(errorType(result), "expired");
    assert.equal(result.ok ? null : result.error.expires, TEST_NOW - 1);
  });

  it("accepts a grant strictly before expiry (grant_chain_accepts_non_expired_grant)", () => {
    const result = chain(
      [
        makeGrant(
          "g1",
          PK_A,
          PK_B,
          "cto",
          ["read"],
          undefined,
          false,
          TEST_NOW + 1,
        ),
      ],
      [makeNode("cto", [PK_A], ["read"])],
      "g1",
    );
    assert.deepEqual(result, { ok: true });
  });

  it("a chain at exactly MAX_GRANT_CHAIN_DEPTH links still verifies (at_max_depth_still_verifies)", () => {
    const grants = [];
    for (let i = 0; i <= MAX_GRANT_CHAIN_DEPTH; i++) {
      grants.push(
        makeGrant(
          `g${i}`,
          PK_A,
          PK_B,
          "cto",
          ["read"],
          i === 0 ? undefined : `g${i - 1}`,
        ),
      );
    }
    const result = chain(
      grants,
      [makeNode("cto", [PK_A], ["read"])],
      `g${MAX_GRANT_CHAIN_DEPTH}`,
    );
    assert.deepEqual(result, { ok: true });
  });

  it("one link past the bound rejects on depth (rejects_depth_exceeded)", () => {
    const depth = MAX_GRANT_CHAIN_DEPTH + 1;
    const grants = [];
    for (let i = 0; i <= depth; i++) {
      grants.push(
        makeGrant(
          `g${i}`,
          PK_A,
          PK_B,
          "cto",
          ["read"],
          i === 0 ? undefined : `g${i - 1}`,
        ),
      );
    }
    const result = chain(
      grants,
      [makeNode("cto", [PK_A], ["read"])],
      `g${depth}`,
    );
    assert.equal(errorType(result), "chain-depth-exceeded");
  });

  it("rejects a missing parent grant", () => {
    const result = chain(
      [makeGrant("g1", PK_A, PK_B, "cto", ["read"], "missing")],
      [makeNode("cto", [PK_A], ["read"])],
      "g1",
    );
    assert.equal(errorType(result), "parent-grant-not-found");
  });

  it("rejects a grant whose via node is missing", () => {
    const result = chain(
      [makeGrant("g1", PK_A, PK_B, "cto", ["read"])],
      [],
      "g1",
    );
    assert.equal(errorType(result), "node-not-found");
  });
});
