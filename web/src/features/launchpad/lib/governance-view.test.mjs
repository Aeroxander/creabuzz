/**
 * `governance-view.ts` under `node --test` (node >= 22 strip-types). The
 * routing map, quorum copy, and litmus facts — the S2 acceptance lives here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorityLine,
  decodeProposalState,
  governanceRoute,
  RECEIPTS_COPY,
  RECORD_ONLY_COPY,
} from "./governance-view.ts";

describe("the routing map (D1)", () => {
  it("signals never get a ballot — the anti-theater rule", () => {
    const route = governanceRoute("signal");
    assert.equal(route.ballot, false);
    assert.equal(route.mechanism, "Deliberation");
    assert.match(route.rationale, /discussion, not a vote/);
  });

  it("plain matters route to the token vote with the ruleset rationale", () => {
    const route = governanceRoute("plain");
    assert.equal(route.ballot, true);
    assert.match(route.mechanism, /Shares vote/);
    assert.match(route.rationale, /support has to hold/);
  });

  it("budget matters use the same Shares ballot", () => {
    const route = governanceRoute("futarchy-budget");
    assert.equal(route.mechanism, "Shares vote");
    assert.equal(route.ballot, true);
  });
});

describe("the three litmus facts", () => {
  it("authority states who and under what (D5)", () => {
    assert.equal(
      authorityLine("0xalice", "g1"),
      "Proposed by 0xalice · under grant g1",
    );
    assert.match(authorityLine("0xalice"), /no recorded delegation/);
  });

  it("receipts and record-only copy are stable strings (D4/D8)", () => {
    assert.match(RECEIPTS_COPY, /linked to its transaction/);
    assert.match(RECORD_ONLY_COPY, /Record-only/);
  });

  it("state decode follows majeur's enum order", () => {
    assert.equal(decodeProposalState(3), "Succeeded");
    assert.equal(decodeProposalState(6), "Executed");
    assert.match(decodeProposalState(99), /Unknown/);
  });
});
