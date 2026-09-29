import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkBudgetPublisher,
  checkNodePublication,
  isAuthorityHolder,
  isEquityGrantContent,
  nodeAnchoring,
  resolveNode,
  tallyReviews,
  verbEntailedBy,
  verifyIncomingGrant,
} from "./orgAuthority.ts";
import { verbEntailedBy as legacyVerbEntailedBy } from "./grantVerify.ts";

// `scripts/org-authority-corpus.json` is generated from the production Rust
// resolver (`just regen-org-corpus`) and gated against drift in buzz-core. A
// green run here proves this twin agrees with the relay decision for decision:
// anchoring, canonical node choice, grant chains, node and budget publication,
// authority holders, verb entailment and the review tally.
const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../../scripts/org-authority-corpus.json", import.meta.url),
    ),
    "utf8",
  ),
);

test("the web twin is byte-identical to this file", () => {
  const here = readFileSync(
    fileURLToPath(new URL("./orgAuthority.ts", import.meta.url)),
    "utf8",
  );
  const twin = readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../web/src/features/fleet/lib/orgAuthority.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.equal(twin, here);
});

test("corpus is populated", () => {
  assert.ok(corpus.worlds.length >= 100);
  assert.ok(corpus.entailment.length >= 300);
  assert.ok(corpus.tally.length >= 40);
});

test("verb entailment matches the Rust resolver on every pair", () => {
  for (const [child, parent, expected] of corpus.entailment) {
    assert.equal(
      verbEntailedBy(child, parent),
      expected,
      `verbEntailedBy(${child}, ${parent})`,
    );
  }
});

test("the legacy chain verifier's entailment agrees on every pair too", () => {
  for (const [child, parent, expected] of corpus.entailment) {
    assert.equal(
      legacyVerbEntailedBy(child, parent),
      expected,
      `grantVerify.verbEntailedBy(${child}, ${parent})`,
    );
  }
});

for (const world of corpus.worlds) {
  const { graph, expect } = world;

  test(`${world.name}: anchoring and canonical node`, () => {
    assert.deepEqual(nodeAnchoring(graph), expect.anchored, "per-node anchoring");
    for (const [d, want] of Object.entries(expect.canonical)) {
      const got = resolveNode(graph, d);
      assert.equal(got.kind === "found" ? got.node.eventId : got.kind, want, d);
    }
  });

  test(`${world.name}: grant decision`, () => {
    const { grant } = expect;
    assert.equal(
      verifyIncomingGrant(graph, grant.incoming.issuer, grant.incoming, corpus.now).ok,
      grant.ok,
      "incoming grant",
    );
    assert.equal(
      verifyIncomingGrant(graph, grant.forgedAuthor, grant.incoming, corpus.now).ok,
      grant.forgedAuthorOk,
      "grant signed by someone other than its issuer",
    );
  });

  test(`${world.name}: node publication`, () => {
    for (const q of expect.publish) {
      assert.equal(
        checkNodePublication(graph, q.author, q.d, q.parent, q.canGrant).ok,
        q.ok,
        JSON.stringify(q),
      );
    }
  });

  test(`${world.name}: authority holders and budget publishers`, () => {
    for (const [who, want] of Object.entries(expect.holders)) {
      assert.equal(isAuthorityHolder(graph, who), want, `holder ${who}`);
    }
    for (const b of expect.budget) {
      const r = checkBudgetPublisher(graph, b.author, b.subject);
      const got = r.ok ? r.as : null;
      assert.equal(got, b.result, JSON.stringify(b));
    }
  });
}

test("review tally matches the Rust resolver", () => {
  for (const t of corpus.tally) {
    assert.deepEqual(
      tallyReviews(t.rows, t.subject, new Set(t.authorized)),
      t.expect,
      JSON.stringify(t),
    );
  }
});

test("equity records are recognised and authority records are not", () => {
  assert.equal(isEquityGrantContent({ type: "equity" }), true);
  assert.equal(isEquityGrantContent({ type: "authority" }), false);
  assert.equal(isEquityGrantContent({ verbs: [] }), false);
  assert.equal(isEquityGrantContent(null), false);
});
