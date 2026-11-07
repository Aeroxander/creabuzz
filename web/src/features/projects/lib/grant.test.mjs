import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GrantValidationError,
  buildOwnershipGrantTemplate,
  parseOwnershipGrant,
} from "./grant.ts";

const FOUNDER = "f".repeat(64);
const REQUESTER = "a".repeat(64);

const INPUT = {
  nodeId: "nebula",
  role: "writer",
  pct: 12,
  grantee: REQUESTER,
  issuer: FOUNDER,
};

function sign(template, overrides = {}) {
  return {
    id: overrides.id ?? "b".repeat(64),
    kind: template.kind,
    pubkey: overrides.pubkey ?? FOUNDER,
    created_at: overrides.created_at ?? 5_000,
    tags: template.tags,
    content: template.content,
  };
}

describe("buildOwnershipGrantTemplate", () => {
  it("composes the golden kind:37011 ownership tags", () => {
    const template = buildOwnershipGrantTemplate(INPUT);
    assert.equal(template.kind, 37011);
    assert.deepEqual(template.tags, [
      ["d", "nebula/writer"],
      ["grantee", REQUESTER],
      ["org", "12"],
      ["role", "writer"],
      ["p", REQUESTER],
    ]);
  });

  it("carries an equity-marked OrgGrantContent body with no authority verbs", () => {
    const template = buildOwnershipGrantTemplate(INPUT);
    assert.deepEqual(JSON.parse(template.content), {
      v: 1,
      type: "equity",
      issuer: FOUNDER,
      grantee: REQUESTER,
      via: "nebula",
      verbs: [],
      parentGrant: null,
      expires: null,
      revoked: false,
    });
  });

  it("refuses a stake, key, or keypair the relay would reject", () => {
    for (const bad of [
      { pct: 0 },
      { pct: 101 },
      { pct: 12.5 },
      { role: "Writer!" },
      { nodeId: "has space" },
      { grantee: "nope" },
      { issuer: "nope" },
    ]) {
      assert.throws(
        () => buildOwnershipGrantTemplate({ ...INPUT, ...bad }),
        (error) => error instanceof GrantValidationError,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });
});

describe("parseOwnershipGrant", () => {
  it("round-trips what the builder composed", () => {
    const grant = parseOwnershipGrant(sign(buildOwnershipGrantTemplate(INPUT)));
    assert.ok(grant);
    assert.equal(grant.via, "nebula");
    assert.equal(grant.role, "writer");
    assert.equal(grant.pct, 12);
    assert.equal(grant.grantee, REQUESTER);
    assert.equal(grant.author, FOUNDER);
    assert.equal(grant.revoked, false);
  });

  it("ignores authority grants with no ownership percentage", () => {
    const template = buildOwnershipGrantTemplate(INPUT);
    const authorityOnly = {
      ...template,
      tags: template.tags.filter((tag) => tag[0] !== "org"),
    };
    assert.equal(parseOwnershipGrant(sign(authorityOnly)), null);
  });

  it("ignores a grant whose content issuer disagrees with the signature", () => {
    const template = buildOwnershipGrantTemplate(INPUT);
    const impostor = sign(template, { pubkey: REQUESTER });
    assert.equal(parseOwnershipGrant(impostor), null);
  });

  it("ignores a grant whose d, via, and role disagree", () => {
    const template = buildOwnershipGrantTemplate(INPUT);
    const mismatched = {
      ...template,
      tags: template.tags.map((tag) =>
        tag[0] === "d" ? ["d", "other-project/writer"] : tag,
      ),
    };
    assert.equal(parseOwnershipGrant(sign(mismatched)), null);
  });

  it("keeps a revoked grant as revoked (revocation is a rewrite, not a delete)", () => {
    const template = buildOwnershipGrantTemplate(INPUT);
    const revoked = {
      ...template,
      content: JSON.stringify({
        ...JSON.parse(template.content),
        revoked: true,
      }),
    };
    const grant = parseOwnershipGrant(sign(revoked));
    assert.ok(grant);
    assert.equal(grant.revoked, true);
  });

  it("rejects an ownership percentage above the pool", () => {
    const template = buildOwnershipGrantTemplate({ ...INPUT, pct: 100 });
    const over = {
      ...template,
      tags: template.tags.map((tag) =>
        tag[0] === "org" ? ["org", "101"] : tag,
      ),
    };
    assert.equal(parseOwnershipGrant(sign(over)), null);
  });
});
