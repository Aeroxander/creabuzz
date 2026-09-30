/**
 * Workflow run-list domain logic: defensive parsing of the server's
 * authorized run reads plus the presentation helpers the run list shares
 * with the approvals inbox. Pure and hook-free so it is unit-testable
 * without a connection.
 *
 * Wire contract (mirrors the desktop reference exactly):
 * - `GET /workflows/{id}/runs` → `{ runs, next }`, snake_case rows
 *   (desktop/src/shared/api/tauriWorkflows.ts `RawWorkflowRun`).
 * - `GET /workflows/{id}/runs/{runId}/approvals` → `{ approvals }`
 *   (`RawWorkflowApproval`).
 * - Workflow discovery is the replaceable workflow-definition event
 *   (`d` = workflow id, `h` = channel id).
 */

/** Replaceable workflow definition event (`d` carries the workflow id). */
export const KIND_WORKFLOW_DEF = 30620;

/** Bounded reads: never load more of anything than these caps. */
export const WORKFLOW_LIMIT = 12;
export const RUNS_LIMIT = 20;
export const APPROVALS_LIMIT = 20;

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStep = {
  stepId: string;
  status: string;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  currentStep: number | null;
  steps: RunStep[];
  startedAt: number | null;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
};

export type RunApprovalStatus = "pending" | "granted" | "denied" | "expired";

export type RunApproval = {
  /** Hex approval token hash — the resolution reference (`d` tag). */
  approvalRef: string;
  runId: string;
  stepId: string;
  stepIndex: number;
  /** Rendered approver selector from the workflow step (e.g. "@owner"). */
  approverSpec: string;
  status: RunApprovalStatus;
  approverPubkey: string | null;
  note: string | null;
  expiresAt: string | null;
  createdAt: number;
};

export type WorkflowSummary = {
  id: string;
  name: string;
  channelId: string | null;
  ownerPubkey: string | null;
};

type NostrEventLike = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
};

function tagValue(tags: readonly (readonly string[])[], name: string) {
  return tags.find((tag) => tag[0] === name)?.[1]?.trim() || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const RUN_STATUSES: readonly string[] = [
  "pending",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
];

function asRunStatus(value: unknown): WorkflowRunStatus {
  return typeof value === "string" && RUN_STATUSES.includes(value)
    ? (value as WorkflowRunStatus)
    : "pending";
}

const APPROVAL_STATUSES: readonly string[] = [
  "pending",
  "granted",
  "denied",
  "expired",
];

function asApprovalStatus(value: unknown): RunApprovalStatus {
  return typeof value === "string" && APPROVAL_STATUSES.includes(value)
    ? (value as RunApprovalStatus)
    : "expired";
}

/** Workflow name from definition content (YAML `name:` or JSON), best effort. */
export function workflowNameFromContent(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    const name = asRecord(parsed) && asString(asRecord(parsed)?.name);
    if (name) return name;
  } catch {
    // YAML content — fall through to the line scan.
  }
  const match = /^name:\s*(.+)$/m.exec(content);
  const name = match?.[1]?.trim();
  return name ? name.slice(0, 80) : null;
}

/**
 * Map a workflow-definition event to a summary. Returns null without a `d`
 * tag — such an event is not addressable and its runs cannot be looked up.
 */
export function parseWorkflowDefinition(
  event: NostrEventLike,
): WorkflowSummary | null {
  if (event.kind !== KIND_WORKFLOW_DEF) return null;
  const id = tagValue(event.tags, "d");
  if (!id) return null;
  return {
    id,
    name:
      workflowNameFromContent(event.content) ?? `Workflow ${id.slice(0, 8)}`,
    channelId: tagValue(event.tags, "h"),
    ownerPubkey: /^[0-9a-f]{64}$/i.test(event.pubkey)
      ? event.pubkey.toLowerCase()
      : null,
  };
}

function parseStep(raw: unknown): RunStep | null {
  const row = asRecord(raw);
  if (!row) return null;
  const stepId = asString(row.step_id);
  if (!stepId) return null;
  return {
    stepId,
    status: asString(row.status) ?? "unknown",
    error: asString(row.error),
    startedAt: asNumber(row.started_at),
    completedAt: asNumber(row.completed_at),
  };
}

function parseRun(raw: unknown, workflowId: string): WorkflowRun | null {
  const row = asRecord(raw);
  if (!row) return null;
  const id = asString(row.id);
  if (!id) return null;
  const trace = Array.isArray(row.execution_trace) ? row.execution_trace : [];
  return {
    id,
    workflowId: asString(row.workflow_id) ?? workflowId,
    status: asRunStatus(row.status),
    currentStep: asNumber(row.current_step),
    steps: trace
      .map(parseStep)
      .filter((step): step is RunStep => step !== null),
    startedAt: asNumber(row.started_at),
    completedAt: asNumber(row.completed_at),
    errorCode: asString(row.error_code),
    errorMessage: asString(row.error_message),
    createdAt: asNumber(row.created_at) ?? 0,
  };
}

/** Parse a `GET /workflows/{id}/runs` body. Malformed rows are dropped. */
export function parseRunsResponse(
  json: unknown,
  workflowId: string,
): WorkflowRun[] {
  const runs = asRecord(json)?.runs;
  if (!Array.isArray(runs)) return [];
  return runs
    .map((raw) => parseRun(raw, workflowId))
    .filter((run): run is WorkflowRun => run !== null);
}

function parseApproval(raw: unknown, runId: string): RunApproval | null {
  const row = asRecord(raw);
  if (!row) return null;
  const approvalRef = asString(row.approval_ref);
  if (!approvalRef) return null;
  return {
    approvalRef,
    runId: asString(row.run_id) ?? runId,
    stepId: asString(row.step_id) ?? "",
    stepIndex: asNumber(row.step_index) ?? 0,
    approverSpec: asString(row.approver_spec) ?? "",
    status: asApprovalStatus(row.status),
    approverPubkey: asString(row.approver_pubkey),
    note: asString(row.note),
    expiresAt: asString(row.expires_at),
    createdAt: asNumber(row.created_at) ?? 0,
  };
}

/** Parse a `GET .../runs/{id}/approvals` body. Malformed rows are dropped. */
export function parseApprovalsResponse(
  json: unknown,
  runId: string,
): RunApproval[] {
  const approvals = asRecord(json)?.approvals;
  if (!Array.isArray(approvals)) return [];
  return approvals
    .map((raw) => parseApproval(raw, runId))
    .filter((row): row is RunApproval => row !== null);
}

/** Active runs keep the bounded poll alive; finished runs do not. */
export function isActiveRunStatus(status: WorkflowRunStatus): boolean {
  return (
    status === "pending" ||
    status === "running" ||
    status === "waiting_approval"
  );
}

const RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  pending: "Queued",
  running: "Running",
  waiting_approval: "Waiting for approval",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function runStatusLabel(status: WorkflowRunStatus): string {
  return RUN_STATUS_LABEL[status];
}

export type RunStepRow = {
  stepId: string;
  label: string;
  error: string | null;
};

const STEP_STATUS_LABEL: Record<string, string> = {
  pending: "Queued",
  running: "Running",
  waiting_approval: "Waiting for approval",
  completed: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

export function runStepRows(run: WorkflowRun): RunStepRow[] {
  return run.steps.map((step) => ({
    stepId: step.stepId,
    label: STEP_STATUS_LABEL[step.status] ?? step.status,
    error: step.error,
  }));
}

/** What happened on a failed run — shown before any retry affordance. */
export function failureText(run: WorkflowRun): string {
  return (
    run.errorMessage ??
    run.errorCode ??
    "The run stopped without a reason. Run it again to retry."
  );
}

export type RunApprovalRow = {
  approval: RunApproval;
  /** True when this session's user is the pending approver (role gating). */
  canDecide: boolean;
};

/**
 * Attach decision gating to a run's approvals. An approval is actionable
 * only while it is pending AND its request is addressed to the current user
 * (the request's `p` tag set from the approval inbox query) — everyone else
 * sees the status line only.
 */
export function runApprovalRows(
  approvals: readonly RunApproval[],
  myPendingTokens: ReadonlySet<string>,
  locallyResolvedTokens: ReadonlySet<string>,
): RunApprovalRow[] {
  return approvals.map((approval) => ({
    approval,
    canDecide:
      approval.status === "pending" &&
      !locallyResolvedTokens.has(approval.approvalRef) &&
      myPendingTokens.has(approval.approvalRef),
  }));
}
