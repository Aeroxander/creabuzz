import type { WorkflowApproval } from "@/shared/api/types";

import { useApprovalMutation } from "../hooks";

type WorkflowApprovalCardProps = {
  approval: WorkflowApproval;
};

export function WorkflowApprovalCard({ approval }: WorkflowApprovalCardProps) {
  const isExpired = new Date(approval.expiresAt) < new Date();
  const resolveApproval = useApprovalMutation();
  const isResolving = resolveApproval.isPending;

  if (approval.status !== "pending" || isExpired) {
    return null;
  }

  const resolve = (action: "grant" | "deny") => {
    // approvalRef is the hex-encoded token hash — the reference the relay's
    // approval resolution reads from the kind:46030/46031 `d` tag.
    resolveApproval.mutate({
      token: approval.approvalRef,
      action,
    });
  };

  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
      data-testid="workflow-approval-card"
    >
      <p className="mb-2 text-sm font-medium">Approval Required</p>
      <p className="mb-2 text-xs text-muted-foreground">
        Approver: {approval.approverSpec}
      </p>
      <p className="mb-2 text-xs text-muted-foreground">
        Expires: {new Date(approval.expiresAt).toLocaleString()}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isResolving}
          onClick={() => resolve("grant")}
        >
          Approve
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isResolving}
          onClick={() => resolve("deny")}
        >
          Deny
        </button>
      </div>
      {resolveApproval.isError ? (
        <p className="mt-2 text-2xs text-red-400" role="alert">
          {resolveApproval.error instanceof Error
            ? resolveApproval.error.message
            : "Failed to send the approval decision."}
        </p>
      ) : null}
    </div>
  );
}
