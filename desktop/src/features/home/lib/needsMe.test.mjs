import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalTokenHashFromTags,
  buildResolutionMap,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_REQUEST,
  mergeNeedsMeRequests,
  needsMeHeadline,
  needsMePreview,
  needsMeStatus,
  parseNeedsMeApproval,
  parseNeedsMeResolution,
} from "./needsMe.ts";

const TOKEN_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const AGENT_PUBKEY = "c".repeat(64);
const OWNER_PUBKEY = "d".repeat(64);

function budgetOverrunEvent(overrides = {}) {
  return {
    id: overrides.id ?? "budget-req-1",
    kind: KIND_APPROVAL_REQUEST,
    pubkey: overrides.pubkey ?? OWNER_PUBKEY,
    created_at: overrides.created_at ?? 1_000,
    content: JSON.stringify({
      type: "budget-exceeded",
      subject: overrides.subject ?? AGENT_PUBKEY,
      counterType: overrides.counterType ?? "runs",
      window: overrides.window ?? "week",
      limit: overrides.limit ?? 10,
    }),
    tags: [
      ["d", overrides.tokenHash ?? TOKEN_HASH],
      ["p", overrides.p ?? AGENT_PUBKEY],
    ],
    sig: "",
  };
}

function workflowRequestEvent(overrides = {}) {
  return {
    id: overrides.id ?? "workflow-req-1",
    kind: KIND_APPROVAL_REQUEST,
    pubkey: overrides.pubkey ?? OWNER_PUBKEY,
    created_at: overrides.created_at ?? 1_100,
    content: overrides.content ?? "Approval requested (from pubkey)",
    tags: [
      ["h", "channel-uuid"],
      ["d", overrides.tokenHash ?? OTHER_HASH],
      ["p", overrides.p ?? OWNER_PUBKEY],
      ["buzz:workflow", "true"],
    ],
    sig: "",
  };
}

test("parses a budget overrun request with its budget fields", () => {
  const approval = parseNeedsMeApproval(budgetOverrunEvent());
  assert.equal(approval.kind, "budget-overrun");
  assert.equal(approval.tokenHash, TOKEN_HASH);
  assert.equal(approval.subjectPubkey, AGENT_PUBKEY);
  assert.equal(approval.counterType, "runs");
  assert.equal(approval.window, "week");
  assert.equal(approval.limit, 10);
  assert.equal(needsMeHeadline(approval), "Budget approval needed");
  assert.match(needsMePreview(approval), /Agent c{8}…c{4} hit its runs budget/);
  assert.match(needsMePreview(approval), /\(limit 10 per week\)/);
});

test("parses a workflow approval request and keeps its headline", () => {
  const approval = parseNeedsMeApproval(workflowRequestEvent());
  assert.equal(approval.kind, "workflow");
  assert.equal(approval.subjectPubkey, OWNER_PUBKEY);
  assert.equal(approval.counterType, null);
  assert.equal(approval.limit, null);
  assert.equal(needsMeHeadline(approval), "Approval requested");
  assert.equal(needsMePreview(approval), "A workflow is waiting for approval.");
});

test("rejects requests without a valid token hash", () => {
  assert.equal(
    parseNeedsMeApproval(budgetOverrunEvent({ tokenHash: "not-a-hash" })),
    null,
  );
  assert.equal(
    parseNeedsMeApproval({
      ...budgetOverrunEvent(),
      tags: [["p", AGENT_PUBKEY]],
    }),
    null,
  );
  assert.equal(
    parseNeedsMeApproval({ ...budgetOverrunEvent(), kind: 9 }),
    null,
  );
});

test("budget content without the budget-exceeded type is a workflow request", () => {
  const event = budgetOverrunEvent();
  event.content = JSON.stringify({ type: "something-else" });
  const approval = parseNeedsMeApproval(event);
  assert.equal(approval.kind, "workflow");
});

test("malformed budget content falls back to the workflow shape", () => {
  const event = budgetOverrunEvent();
  event.content = "{not json";
  const approval = parseNeedsMeApproval(event);
  assert.equal(approval.kind, "workflow");
  // Subject falls back to the p tag.
  assert.equal(approval.subjectPubkey, AGENT_PUBKEY);
});

test("budget limit must be a finite number", () => {
  const event = budgetOverrunEvent();
  event.content = JSON.stringify({
    type: "budget-exceeded",
    subject: AGENT_PUBKEY,
    counterType: "runs",
    window: "week",
    limit: "ten",
  });
  assert.equal(parseNeedsMeApproval(event).limit, null);
});

test("parses grant and deny resolutions", () => {
  const grant = parseNeedsMeResolution({
    id: "res-1",
    kind: KIND_APPROVAL_GRANT,
    pubkey: OWNER_PUBKEY,
    created_at: 2_000,
    content: "",
    tags: [["d", TOKEN_HASH]],
    sig: "",
  });
  assert.equal(grant.approved, true);
  assert.equal(grant.tokenHash, TOKEN_HASH);

  const deny = parseNeedsMeResolution({
    id: "res-2",
    kind: 46031,
    pubkey: OWNER_PUBKEY,
    created_at: 2_000,
    content: "",
    tags: [["d", TOKEN_HASH]],
    sig: "",
  });
  assert.equal(deny.approved, false);
});

test("needsMeStatus derives pending/granted/denied and honors local resolution", () => {
  const approval = parseNeedsMeApproval(budgetOverrunEvent());
  assert.equal(needsMeStatus(approval, buildResolutionMap([])), "pending");
  assert.equal(
    needsMeStatus(approval, buildResolutionMap([]), new Set([TOKEN_HASH])),
    "granted",
  );
  const denied = parseNeedsMeResolution({
    id: "res-2",
    kind: 46031,
    pubkey: OWNER_PUBKEY,
    created_at: 2_000,
    content: "",
    tags: [["d", TOKEN_HASH]],
    sig: "",
  });
  assert.equal(needsMeStatus(approval, buildResolutionMap([denied])), "denied");
});

test("approvalTokenHashFromTags requires a 64-char hex d tag", () => {
  assert.equal(approvalTokenHashFromTags([["d", TOKEN_HASH]]), TOKEN_HASH);
  assert.equal(approvalTokenHashFromTags([["d", "zz"]]), null);
  assert.equal(approvalTokenHashFromTags([]), null);
});

test("mergeNeedsMeRequests merges pending requests and drops resolved rows", () => {
  const feed = {
    feed: {
      mentions: [],
      needsAction: [
        {
          id: "backend-copy",
          kind: KIND_APPROVAL_REQUEST,
          pubkey: OWNER_PUBKEY,
          content: "Approval requested",
          createdAt: 900,
          channelId: null,
          channelName: "",
          tags: [["d", OTHER_HASH]],
          category: "needs_action",
        },
        {
          id: "resolved-elsewhere",
          kind: KIND_APPROVAL_REQUEST,
          pubkey: OWNER_PUBKEY,
          content: "stale request",
          createdAt: 800,
          channelId: null,
          channelName: "",
          tags: [["d", TOKEN_HASH]],
          category: "needs_action",
        },
      ],
      activity: [],
      agentActivity: [],
    },
    meta: { since: 0, total: 0, generatedAt: 0 },
  };
  const merged = mergeNeedsMeRequests(
    feed,
    [
      // Live needs-me copy of the backend event — must not duplicate.
      workflowRequestEvent({ id: "backend-copy", created_at: 900 }),
      budgetOverrunEvent(),
      // Already resolved: must disappear from the merged feed.
      workflowRequestEvent({ id: "resolved-elsewhere", tokenHash: TOKEN_HASH }),
    ],
    new Set(["resolved-elsewhere"]),
  );

  const ids = merged.feed.needsAction.map((entry) => entry.id);
  assert.deepEqual(ids.sort(), ["backend-copy", "budget-req-1"]);
  const budgetRow = merged.feed.needsAction.find(
    (entry) => entry.id === "budget-req-1",
  );
  assert.equal(budgetRow.category, "needs_action");
  assert.equal(budgetRow.channelId, null);
});
