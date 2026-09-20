import { CircleAlert, LoaderCircle } from "lucide-react";
import * as React from "react";

import {
  needsMeHeadline,
  needsMePayloadRows,
  type NeedsMeApproval,
  type NeedsMeStatus,
} from "@/features/home/lib/needsMe";
import { relativeTime } from "@/features/projects/lib/projectsViewHelpers";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { PubKey } from "@/shared/ui/PubKey";
import { StatusBadge } from "@/shared/ui/StatusBadge";
import { UserAvatar } from "@/shared/ui/UserAvatar";

const STATUS_VARIANT: Record<
  NeedsMeStatus,
  "pending" | "resolving" | "approved" | "denied"
> = {
  pending: "pending",
  resolving: "resolving",
  granted: "approved",
  denied: "denied",
};

/**
 * Requester identity for the subject of a kind:46010 request (the budgeted
 * agent for overruns, the workflow owner for workflow requests). Resolves the
 * profile display name/avatar through the shared profile hooks; falls back to
 * the canonical PubKey chip when no profile exists.
 */
function NeedsMeSubjectIdentity({
  pubkey,
  className,
}: {
  className?: string;
  pubkey: string | null;
}) {
  const profiles = useUsersBatchQuery(
    React.useMemo(() => (pubkey ? [pubkey] : []), [pubkey]),
  ).data?.profiles;
  if (!pubkey) {
    return <span className={className}>Unknown requester</span>;
  }
  const profile = profiles?.[pubkey];
  const label = resolveUserLabel({ pubkey, profiles });
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <UserAvatar
        avatarUrl={profile?.avatarUrl ?? null}
        className="h-4.5 w-4.5"
        displayName={label}
        shape={profile?.isAgent ? "squircle" : "circle"}
        size="xs"
      />
      <span className="truncate font-medium text-foreground">{label}</span>
      {profile ? null : (
        <PubKey className="shrink-0" interactive={false} pubkey={pubkey} />
      )}
    </span>
  );
}

function TypeBadge({ kind }: { kind: NeedsMeApproval["kind"] }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-2xs font-semibold uppercase leading-3 tracking-wide text-muted-foreground">
      {kind === "budget-overrun" ? "Budget overrun" : "Workflow"}
    </span>
  );
}

/**
 * Approval card for a "needs me" kind:46010 request (WhatNeedsMe /
 * ApprovalCard pattern): type badge, requester identity, subject, status pill,
 * the type-specific payload, and INLINE resolution — Approve/Deny with
 * pending-state labels and publish failures rendered next to the buttons
 * (never a toast for state visible on screen). Pending rows older than 24h
 * get the amber aging treatment via `isAging`.
 */
export function NeedsMeApprovalCard({
  approval,
  status,
  isAging = false,
  error = null,
  onResolve,
  className,
  testId,
}: {
  approval: NeedsMeApproval;
  status: NeedsMeStatus;
  /** Pending rows waiting over 24h get the amber aging emphasis. */
  isAging?: boolean;
  /** Inline publish-failure message from the last rejected resolution. */
  error?: string | null;
  onResolve?: (approval: NeedsMeApproval, approved: boolean) => void;
  className?: string;
  testId?: string;
}) {
  // Which decision is in flight — the resolution model tracks the token, the
  // pending label needs the direction. Reset when the publish settles.
  const [pendingAction, setPendingAction] = React.useState<
    "approve" | "deny" | null
  >(null);
  React.useEffect(() => {
    if (status !== "resolving") {
      setPendingAction(null);
    }
  }, [status]);

  const isDecided = status === "granted" || status === "denied";
  const canAct = status === "pending" && onResolve !== undefined;
  const payloadRows = needsMePayloadRows(approval);
  const headline = needsMeHeadline(approval);
  const requestLabel = `the ${
    approval.kind === "budget-overrun" ? "budget overrun" : "workflow"
  } request from ${approval.subjectPubkey ?? "unknown requester"}`;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-background/60 p-3 text-left",
        isAging && "border-status-waiting-border bg-status-waiting-bg",
        className,
      )}
      data-aging={isAging ? "true" : undefined}
      data-status={status}
      data-testid={testId}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <TypeBadge kind={approval.kind} />
          <span className="inline-flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
            <span className="shrink-0">Requested by</span>
            <NeedsMeSubjectIdentity pubkey={approval.subjectPubkey} />
          </span>
        </div>
        <StatusBadge
          testId={testId ? `${testId}-status` : undefined}
          variant={STATUS_VARIANT[status]}
        />
      </div>

      <h3 className="mt-2 truncate text-sm font-semibold leading-4 text-foreground">
        {headline}
      </h3>
      <p className="mt-1 text-2xs leading-3 text-muted-foreground">
        Requested {relativeTime(approval.createdAt)}
        {isAging ? " — waiting over a day" : ""}
      </p>

      {payloadRows.length > 0 ? (
        <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/50 pt-2.5">
          {payloadRows.map((row) => (
            <div
              className="flex min-w-0 items-baseline gap-1.5"
              key={row.label}
            >
              <dt className="text-2xs uppercase tracking-wide text-muted-foreground">
                {row.label}
              </dt>
              <dd className="truncate font-mono text-2xs text-foreground">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {canAct ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-2.5">
          <Button
            aria-label={`Approve ${requestLabel}`}
            className="h-6 gap-1 border border-status-ok-border bg-status-ok-bg px-2 text-xs text-status-ok hover:bg-status-ok-bg"
            data-testid={testId ? `${testId}-approve` : undefined}
            disabled={pendingAction !== null}
            onClick={(event) => {
              // The row wrapper selects on click; stop it so the decision
              // only resolves this request and never selects the row.
              event.stopPropagation();
              setPendingAction("approve");
              onResolve?.(approval, true);
            }}
            size="xs"
            type="button"
          >
            {pendingAction === "approve" ? "Approving…" : "Approve"}
          </Button>
          <Button
            aria-label={`Deny ${requestLabel}`}
            className="h-6 gap-1 border border-status-blocking-border bg-status-blocking-bg px-2 text-xs text-status-blocking hover:bg-status-blocking-bg"
            data-testid={testId ? `${testId}-deny` : undefined}
            disabled={pendingAction !== null}
            onClick={(event) => {
              event.stopPropagation();
              setPendingAction("deny");
              onResolve?.(approval, false);
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            {pendingAction === "deny" ? "Denying…" : "Deny"}
          </Button>
          {error ? (
            <p
              className="flex min-w-0 items-center gap-1 text-2xs font-medium text-status-blocking"
              data-testid={testId ? `${testId}-error` : undefined}
              role="alert"
            >
              <CircleAlert aria-hidden="true" className="h-3 w-3 shrink-0" />
              <span className="truncate">{error}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {status === "resolving" && pendingAction === null ? (
        <p
          aria-live="polite"
          className="mt-2.5 flex items-center gap-1 text-2xs font-medium text-muted-foreground"
          role="status"
        >
          <LoaderCircle aria-hidden="true" className="h-3 w-3 animate-spin" />
          Sending decision…
        </p>
      ) : null}

      {isDecided ? (
        <p className="mt-2.5 text-2xs text-muted-foreground">
          {status === "granted"
            ? "You approved this request."
            : "You denied this request."}
        </p>
      ) : null}
    </div>
  );
}
