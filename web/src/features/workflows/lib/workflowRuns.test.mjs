// Workflow run-list contract: wire parsing plus the command event shapes the
// run list publishes. The builder pins bind web to the desktop reference
// (desktop/src-tauri/src/events/workflows.rs `build_approval_grant`/`deny`/
// `build_workflow_trigger`): flipping a tag must fail this suite.
// Run with: node --experimental-strip-types --test src/features/workflows/lib/workflowRuns.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  KIND_WORKFLOW_DEF,
  failureText,
  isActiveRunStatus,
  parseApprovalsResponse,
  parseRunsResponse,
  parseWorkflowDefinition,
  runApprovalRows,
  runStatusLabel,
  runStepRows,
  workflowNameFromContent,
} from "./workflowRuns.ts";
import {
  KIND_APPROVAL_DENY,
  KIND_APPROVAL_GRANT,
  KIND_WORKFLOW_TRIGGER,
  buildApprovalDecision,
  buildWorkflowTrigger,
} from "./runActions.ts";

const TOKEN = "ab".repeat(32);
const WORKFLOW_ID = "3f2b7c9e-1111-2222-3333-444455556666";

function runRow(overrides = {}) {
  return {
    id: "run1",
    workflow_id: WORKFLOW_ID,
    status: "failed",
    current_step: 1,
    execution_trace: [
      {
        step_id: "fetch",
        status: "completed",
        started_at: 10,
        completed_at: 20,
      },
      { step_id: "post", status: "failed", error: "step blew up" },
    ],
    started_at: 10,
    completed_at: 30,
    error_code: "STEP_FAILED",
    error_message: "Step post failed",
    created_at: 5,
    ...overrides,
  };
}

describe("parseRunsResponse", () => {
  it("maps snake_case run rows and drops malformed ones", () => {
    const runs = parseRunsResponse(
      { runs: [runRow(), { id: "" }, "nope"], next: null },
      WORKFLOW_ID,
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, "run1");
    assert.equal(runs[0].workflowId, WORKFLOW_ID);
    assert.equal(runs[0].status, "failed");
    assert.equal(runs[0].errorMessage, "Step post failed");
    assert.deepEqual(
      runs[0].steps.map((step) => step.stepId),
      ["fetch", "post"],
    );
  });

  it("returns empty for a body without a runs array", () => {
    assert.deepEqual(parseRunsResponse({ error: "no" }, WORKFLOW_ID), []);
    assert.deepEqual(parseRunsResponse(null, WORKFLOW_ID), []);
  });
});

describe("parseApprovalsResponse", () => {
  it("keeps rows with an approval reference and drops the rest", () => {
    const rows = parseApprovalsResponse(
      {
        approvals: [
          {
            approval_ref: TOKEN,
            run_id: "run1",
            step_id: "post",
            step_index: 1,
            approver_spec: "@owner",
            status: "pending",
            approver_pubkey: null,
            note: null,
            expires_at: "2030-01-01T00:00:00Z",
            created_at: 5,
          },
          { approval_ref: "", status: "pending" },
        ],
      },
      "run1",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].approvalRef, TOKEN);
    assert.equal(rows[0].status, "pending");
  });
});

describe("run presentation", () => {
  it("labels statuses in plain language", () => {
    assert.equal(runStatusLabel("waiting_approval"), "Waiting for approval");
    assert.equal(runStatusLabel("completed"), "Done");
    assert.equal(isActiveRunStatus("waiting_approval"), true);
    assert.equal(isActiveRunStatus("completed"), false);
    assert.equal(isActiveRunStatus("failed"), false);
  });

  it("surfaces the failure before any retry affordance", () => {
    const [run] = parseRunsResponse({ runs: [runRow()] }, WORKFLOW_ID);
    assert.equal(failureText(run), "Step post failed");
    const bare = parseRunsResponse(
      { runs: [runRow({ error_message: null, error_code: null })] },
      WORKFLOW_ID,
    )[0];
    assert.match(failureText(bare), /without a reason/i);
    assert.deepEqual(runStepRows(run)[1], {
      stepId: "post",
      label: "Failed",
      error: "step blew up",
    });
  });

  it("gates decisions on pending approvals addressed to me", () => {
    const [approval] = parseApprovalsResponse(
      {
        approvals: [
          {
            approval_ref: TOKEN,
            run_id: "run1",
            status: "pending",
            step_id: "post",
            step_index: 1,
            approver_spec: "@owner",
            created_at: 1,
          },
        ],
      },
      "run1",
    );
    const mine = new Set([TOKEN]);
    assert.equal(
      runApprovalRows([approval], mine, new Set())[0].canDecide,
      true,
    );
    assert.equal(
      runApprovalRows([approval], new Set(), new Set())[0].canDecide,
      false,
    );
    assert.equal(
      runApprovalRows([approval], mine, new Set([TOKEN]))[0].canDecide,
      false,
    );
  });
});

describe("workflow definition events", () => {
  it("reads id from the d tag and a best-effort name", () => {
    const summary = parseWorkflowDefinition({
      id: "ev1",
      kind: KIND_WORKFLOW_DEF,
      pubkey: "b".repeat(64),
      created_at: 1,
      tags: [
        ["d", WORKFLOW_ID],
        ["h", "chan1"],
      ],
      content: "name: Nightly digest\nsteps: []",
    });
    assert.equal(summary.id, WORKFLOW_ID);
    assert.equal(summary.name, "Nightly digest");
    assert.equal(summary.channelId, "chan1");
    assert.equal(
      parseWorkflowDefinition({
        id: "ev2",
        kind: KIND_WORKFLOW_DEF,
        pubkey: "b".repeat(64),
        created_at: 1,
        tags: [],
        content: "",
      }),
      null,
    );
  });

  it("falls back to a short id when the definition has no name", () => {
    assert.equal(workflowNameFromContent("steps: []"), null);
  });
});

describe("command event shapes (desktop-pinned)", () => {
  it("builds the grant decision exactly like the desktop builder", () => {
    assert.deepEqual(
      buildApprovalDecision({ tokenHash: TOKEN, approved: true, note: "ok" }),
      {
        kind: KIND_APPROVAL_GRANT,
        content: "ok",
        tags: [["d", TOKEN]],
      },
    );
  });

  it("builds the deny decision with empty content when no note is given", () => {
    assert.deepEqual(
      buildApprovalDecision({ tokenHash: TOKEN, approved: false }),
      {
        kind: KIND_APPROVAL_DENY,
        content: "",
        tags: [["d", TOKEN]],
      },
    );
  });

  it("rejects a token that is not a 64-char hex hash", () => {
    assert.throws(
      () => buildApprovalDecision({ tokenHash: "deadbeef", approved: true }),
      /64-character hex hash/,
    );
  });

  it("builds the run trigger exactly like the desktop builder", () => {
    assert.deepEqual(buildWorkflowTrigger(WORKFLOW_ID), {
      kind: KIND_WORKFLOW_TRIGGER,
      content: "",
      tags: [["d", WORKFLOW_ID]],
    });
    assert.throws(() => buildWorkflowTrigger("  "), /required/);
  });
});
