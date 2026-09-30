// Approval inbox contract: kind:46010 requests (budget overruns + workflow)
// resolve through kind:46030/46031 command events keyed by the token hash.
// Run with: node --experimental-strip-types --test src/features/notifications/lib/approvals.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_REQUEST,
  approvalDetailRows,
  approvalHeadline,
  approvalStatus,
  buildResolutionMap,
  parseApprovalRequest,
  parseApprovalResolution,
} from "./approvals.ts";

const TOKEN = "ab".repeat(32);
const AGENT = "a".repeat(64);

function requestEvent(content, tags = [["d", TOKEN]]) {
  return {
    id: "req1",
    kind: KIND_APPROVAL_REQUEST,
    pubkey: "b".repeat(64),
    created_at: 1000,
    tags,
    content,
  };
}

describe("parseApprovalRequest", () => {
  it("parses a budget overrun with subject, counter, window, limit", () => {
    const request = parseApprovalRequest(
      requestEvent(
        JSON.stringify({
          type: "budget-exceeded",
          subject: AGENT,
          counterType: "llmCostCents",
          window: "week",
          limit: 500,
        }),
      ),
    );
    assert.ok(request);
    assert.equal(request.kind, "budget-overrun");
    assert.equal(request.subjectPubkey, AGENT);
    assert.equal(request.counterType, "llmCostCents");
    assert.equal(request.window, "week");
    assert.equal(request.limit, 500);
  });

  it("treats plain-text content as a workflow request", () => {
    const request = parseApprovalRequest(requestEvent("Please approve step 3"));
    assert.ok(request);
    assert.equal(request.kind, "workflow");
    assert.equal(request.limit, null);
  });

  it("drops events without a resolvable token hash", () => {
    assert.equal(
      parseApprovalRequest(requestEvent("x", [["d", "not-a-hash"]])),
      null,
    );
  });
});

describe("resolution + status", () => {
  it("maps grant/deny events by token hash", () => {
    const grant = parseApprovalResolution({
      id: "g1",
      kind: KIND_APPROVAL_GRANT,
      pubkey: "c".repeat(64),
      created_at: 2000,
      tags: [["d", TOKEN]],
      content: "",
    });
    assert.ok(grant);
    assert.equal(grant.approved, true);
    assert.equal(grant.tokenHash, TOKEN);
  });

  it("shows granted/denied outcomes and never resurrects local resolves", () => {
    const request = parseApprovalRequest(
      requestEvent(JSON.stringify({ type: "budget-exceeded", subject: AGENT })),
    );
    assert.ok(request);
    assert.equal(approvalStatus(request, new Map()), "pending");
    const denied = buildResolutionMap([
      {
        tokenHash: TOKEN,
        approved: false,
        resolverPubkey: "c".repeat(64),
        eventId: "g2",
      },
    ]);
    assert.equal(approvalStatus(request, denied), "denied");
    assert.equal(
      approvalStatus(request, new Map(), new Set([TOKEN])),
      "granted",
    );
  });

  it("rows answer who/what/why: agent, counter, window, limit", () => {
    const request = parseApprovalRequest(
      requestEvent(
        JSON.stringify({
          type: "budget-exceeded",
          subject: AGENT,
          counterType: "runs",
          window: "day",
          limit: 100,
        }),
      ),
    );
    assert.ok(request);
    const rows = approvalDetailRows(request, (pk) => `agent:${pk.slice(0, 4)}`);
    assert.deepEqual(rows, [
      { label: "Agent", value: `agent:${AGENT.slice(0, 4)}` },
      { label: "Counter", value: "runs" },
      { label: "Window", value: "day" },
      { label: "Limit", value: "100" },
    ]);
    assert.equal(approvalHeadline(request), "Budget approval needed");
  });
});
