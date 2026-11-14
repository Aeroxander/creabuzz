/**
 * Workflow command event builders. Shapes are pinned to the desktop
 * reference (desktop/src-tauri/src/events/workflows.rs) and the SDK builder
 * (`build_workflow_approval` / `build_workflow_trigger` in
 * crates/buzz-sdk/src/builders.rs); unit tests bind them so a drifted tag
 * fails the suite.
 *
 * Mirrors the server's workflow kinds. Kept local to the web client the
 * same way the approvals inbox keeps its approval kinds local.
 */

export const KIND_WORKFLOW_TRIGGER = 46020;
export const KIND_APPROVAL_GRANT = 46030;
export const KIND_APPROVAL_DENY = 46031;

export type EventTemplate = {
  kind: number;
  content: string;
  tags: string[][];
};

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Kind:46030 (grant) / 46031 (deny) for one approval token. The relay
 * resolves the reference from the `d` tag only; `content` carries the
 * optional human-readable note.
 */
export function buildApprovalDecision(input: {
  tokenHash: string;
  approved: boolean;
  note?: string;
}): EventTemplate {
  const tokenHash = input.tokenHash.trim().toLowerCase();
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw new Error("approval reference must be a 64-character hex hash");
  }
  return {
    kind: input.approved ? KIND_APPROVAL_GRANT : KIND_APPROVAL_DENY,
    content: input.note?.trim() ?? "",
    tags: [["d", tokenHash]],
  };
}

/** Kind:46020 — trigger a new run of a workflow (`d` = workflow id). */
export function buildWorkflowTrigger(workflowId: string): EventTemplate {
  const id = workflowId.trim();
  if (!id) {
    throw new Error("workflow id is required");
  }
  return {
    kind: KIND_WORKFLOW_TRIGGER,
    content: "",
    tags: [["d", id]],
  };
}
