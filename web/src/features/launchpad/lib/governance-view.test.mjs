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
  quorumSummary,
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
    assert.match(route.mechanism, /Token vote/);
    assert.match(route.rationale, /N-1 snapshot/);
  });

  it("budget matters route to futarchy and only futarchy", () => {
    const route = governanceRoute("futarchy-budget");
    assert.equal(route.mechanism, "Futarchy · budget");
    assert.equal(route.ballot, true);
  });
});

describe("quorum math in plain language (D6)", () => {
  it("assembles known params", () => {
    const line = quorumSummary({
      quorumBps: 500,
      minYes: 1,
      proposalTtl: "7d",
      timelockDelay: "2d",
    });
    assert.match(line, /N-1 snapshot/);
    assert.match(line, /quorum 5% of snapshot supply/);
    assert.match(line, /FOR must beat AGAINST/);
    assert.match(line, /minYes 1/);
    assert.match(line, /TTL 7d/);
    assert.match(line, /timelock 2d/);
  });

  it("never invents numbers it does not have", () => {
    const line = quorumSummary();
    assert.match(line, /quorum per DAO config/);
    assert.match(line, /minYes per DAO config/);
    assert.match(line, /TTL per DAO config/);
    assert.match(line, /timelock per DAO config/);
  });

  it("names the absolute quorum when bps is off (majeur's two modes)", () => {
    const line = quorumSummary({ quorumBps: 0, quorumAbsolute: 3 });
    assert.match(line, /quorum 3 absolute/);
    const bothOff = quorumSummary({ quorumBps: 0, quorumAbsolute: 0 });
    assert.match(bothOff, /quorum per DAO config/);
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
    assert.match(RECEIPTS_COPY, /47005/);
    assert.match(RECORD_ONLY_COPY, /Record-only/);
  });

  it("state decode follows majeur's enum order", () => {
    assert.equal(decodeProposalState(3), "Succeeded");
    assert.equal(decodeProposalState(6), "Executed");
    assert.match(decodeProposalState(99), /Unknown/);
  });
});
