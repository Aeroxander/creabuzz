export type WorkflowStatus = "active" | "disabled" | "archived";

export type Workflow = {
  id: string;
  revision: string;
  name: string;
  ownerPubkey: string;
  channelId: string | null;
  definition: Record<string, unknown>;
  status: WorkflowStatus;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowSaveResult = {
  workflow: Workflow;
  webhookSecret: string | null;
};

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_approval";

export type TraceEntry = {
  stepId: string;
  status: string;
  output: Record<string, unknown>;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  currentStep: number | null;
  executionTrace: TraceEntry[];
  startedAt: number | null;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
};

export type WorkflowApprovalStatus =
  | "pending"
  | "granted"
  | "denied"
  | "expired";

export type WorkflowApproval = {
  /** Hex-encoded approval token hash. Pass as the `token` to the grant/deny
   * mutation — it becomes the kind:46030/46031 `d` tag the relay resolves. */
  approvalRef: string;
  workflowId: string;
  runId: string;
  stepId: string;
  stepIndex: number;
  approverSpec: string;
  status: WorkflowApprovalStatus;
  approverPubkey: string | null;
  note: string | null;
  expiresAt: string;
  createdAt: number;
};

export type TriggerWorkflowResponse = {
  runId: string;
  workflowId: string;
  status: string;
};

export type ApprovalActionResponse = {
  token: string;
  status: string;
  runId: string;
  workflowId: string;
};
