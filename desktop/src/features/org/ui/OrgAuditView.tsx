import * as React from "react";

import { Check, Copy, Plus, ShieldCheck } from "lucide-react";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Spinner } from "@/shared/ui/spinner";
import { StatusGlyph } from "@/shared/ui/StatusGlyph";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { useOrgAuditQuery, useOrgChartQuery } from "../hooks";
import {
  AUDIT_FETCH_LIMIT,
  deriveAuditRows,
  deriveVerifySummary,
  fullTimestampLabel,
} from "../lib/audit";
import { relativeTimeLabel } from "../lib/dashboard";

/**
 * Org audit view — the evidence spine (NIP-ORG). Every structural change
 * (kinds 37010–37014 + 46010/46030/46031), attributed, newest first.
 *
 * Honesty note on the verify affordance: the modal re-fetches and checks
 * PRESENCE + RECENCY of the same events. Exact hash-chain verification is an
 * operator-path upgrade (relay audit hash chain + buzz-admin); this surface
 * deliberately does not claim cryptographic verification.
 */

const VERIFY_SAMPLE_NOTE =
  "Checks that the newest entries you were viewing are still present after a fresh re-fetch.";

function CopyableEventId({ eventId }: { eventId: string }) {
  const [copied, setCopied] = React.useState(false);
  const resetTimer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  return (
    <button
      aria-label={`Copy event id ${eventId}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-2xs text-muted-foreground",
        "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
      )}
      data-testid="org-audit-event-id"
      onClick={() => {
        copyTextToClipboard(eventId, "Event id copied");
        setCopied(true);
        window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
      }}
      title={eventId}
      type="button"
    >
      {eventId.length > 12 ? `${eventId.slice(0, 12)}…` : eventId}
      {copied ? (
        <Check aria-hidden="true" className="h-3 w-3" />
      ) : (
        <Copy aria-hidden="true" className="h-3 w-3" />
      )}
    </button>
  );
}

export function OrgAuditView({
  onOpenTab,
}: {
  /** Send the viewer to the Chart tab to make the first change. */
  onOpenTab: (tab: "chart") => void;
}) {
  const auditQuery = useOrgAuditQuery();
  const chartQuery = useOrgChartQuery();

  const events = auditQuery.data ?? [];
  const data = chartQuery.data;
  const namesByDtag = React.useMemo(
    () => new Map((data?.nodes ?? []).map((node) => [node.dtag, node.name])),
    [data?.nodes],
  );
  const namesByPubkey = React.useMemo(() => {
    const names = new Map<string, string>();
    for (const node of data?.nodes ?? []) {
      for (const pubkey of [...node.holders, ...node.agentSeats]) {
        const key = pubkey.trim().toLowerCase();
        if (!names.has(key)) names.set(key, node.name);
      }
    }
    return names;
  }, [data?.nodes]);

  const rows = React.useMemo(
    () => deriveAuditRows({ events, namesByPubkey, namesByDtag }),
    [events, namesByPubkey, namesByDtag],
  );

  // Verify modal state: the ids visible when "Verify" was pressed, compared
  // against a fresh re-fetch (deriveVerifySummary does the honest math).
  const [verifyOpen, setVerifyOpen] = React.useState(false);
  const [verifySampleIds, setVerifySampleIds] = React.useState<string[]>([]);
  const refetch = auditQuery.refetch;
  const openVerify = React.useCallback(() => {
    setVerifySampleIds(rows.slice(0, 12).map((row) => row.key));
    setVerifyOpen(true);
    void refetch();
  }, [rows, refetch]);

  const verifySummary = React.useMemo(() => {
    if (!verifyOpen || auditQuery.isPending || auditQuery.isError) return null;
    return deriveVerifySummary({
      previousTopIds: verifySampleIds,
      refetchedIds: (auditQuery.data ?? []).map((event) => event.id),
      hitFetchLimit: events.length >= AUDIT_FETCH_LIMIT,
    });
  }, [
    verifyOpen,
    verifySampleIds,
    auditQuery.isPending,
    auditQuery.isError,
    auditQuery.data,
    events.length,
  ]);

  const newest = rows[0];
  const truncated = events.length >= AUDIT_FETCH_LIMIT;

  const loading = auditQuery.isPending || chartQuery.isPending;
  if (loading) {
    return (
      <EmptyState
        icon={<Spinner aria-hidden="true" className="h-6 w-6" />}
        testId="org-audit-loading"
        title="Loading audit log…"
      />
    );
  }

  if (auditQuery.isError) {
    return (
      <EmptyState
        action={
          <Button
            onClick={() => void auditQuery.refetch()}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        }
        description="The relay did not answer the audit query. Check the connection, then retry."
        testId="org-audit-error"
        title="Failed to load the audit log"
        variant="error"
      />
    );
  }

  return (
    <div className="space-y-3 p-4" data-testid="org-audit-view">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Every structural change, attributed and signed. Newest first.
        </p>
        <Button
          data-testid="org-audit-verify"
          disabled={rows.length === 0}
          onClick={openVerify}
          size="sm"
          variant="outline"
        >
          <ShieldCheck aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          Verify
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          action={
            <Button onClick={() => onOpenTab("chart")} size="sm">
              <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              Create a node or grant
            </Button>
          }
          description="Make the first structural change — create a node or grant. Every change lands here as a signed event."
          icon={<Plus aria-hidden="true" className="h-5 w-5" />}
          testId="org-audit-empty"
          title="No structural changes yet"
        />
      ) : (
        <Card className="divide-y p-1" data-testid="org-audit-feed">
          {rows.map((row) => (
            <AuditRowItem
              key={row.key}
              namesByPubkey={namesByPubkey}
              nowSeconds={Math.floor(Date.now() / 1000)}
              row={row}
            />
          ))}
        </Card>
      )}

      {truncated && (
        <p
          className="px-1 text-xs text-muted-foreground"
          data-testid="org-audit-truncated"
        >
          Showing the newest {AUDIT_FETCH_LIMIT} events. Older history exists —
          this is a floor, not a total.
        </p>
      )}

      <Dialog onOpenChange={setVerifyOpen} open={verifyOpen}>
        <DialogContent data-testid="org-audit-verify-modal">
          <DialogHeader>
            <DialogTitle>Verify audit entries</DialogTitle>
            <DialogDescription>{VERIFY_SAMPLE_NOTE}</DialogDescription>
          </DialogHeader>
          {auditQuery.isPending ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" className="h-4 w-4" />
              Re-fetching from the relay…
            </div>
          ) : verifySummary ? (
            <div className="space-y-3 py-2 text-sm">
              <div
                className={cn(
                  "rounded-md border p-3",
                  verifySummary.state === "verified"
                    ? "border-status-ok-border bg-status-ok-bg"
                    : "border-status-waiting-border bg-status-waiting-bg",
                )}
                data-testid="org-audit-verify-state"
              >
                <p className="font-medium">
                  {verifySummary.state === "verified"
                    ? "Presence verified"
                    : "Presence degraded"}
                  : {verifySummary.presentCount} of {verifySummary.checkedCount}{" "}
                  sampled entries re-fetched from the relay.
                </p>
                {verifySummary.missingIds.length > 0 && (
                  <p className="mt-1 text-xs">
                    Missing from the fresh fetch:{" "}
                    <span className="font-mono">
                      {verifySummary.missingIds.join(", ")}
                    </span>
                  </p>
                )}
                {verifySummary.hitFetchLimit && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    The re-fetch hit its {AUDIT_FETCH_LIMIT}-event bound; older
                    history was not sampled.
                  </p>
                )}
              </div>
              {newest && (
                <p className="text-xs text-muted-foreground">
                  Newest entry:{" "}
                  {relativeTimeLabel(
                    newest.createdAt,
                    Math.floor(Date.now() / 1000),
                  )}{" "}
                  ({fullTimestampLabel(newest.createdAt)}).
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                This verifies presence and recency of the same signed events —
                it is <strong>not</strong> a hash-chain proof. Exact
                cryptographic chain verification is an operator-path upgrade
                (the relay&apos;s audit hash chain via buzz-admin); the chain
                already covers these events at write time.
              </p>
            </div>
          ) : (
            <p className="py-4 text-sm text-destructive">
              The re-fetch failed. Check the connection, then retry.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AuditRowItem({
  row,
  namesByPubkey,
  nowSeconds,
}: {
  row: ReturnType<typeof deriveAuditRows>[number];
  namesByPubkey: ReadonlyMap<string, string>;
  nowSeconds: number;
}) {
  const profiles = useUsersBatchQuery([row.actorPubkey]).data?.profiles;
  const key = row.actorPubkey.trim().toLowerCase();
  const identity = {
    label: resolveUserLabel({
      pubkey: row.actorPubkey,
      profiles,
      fallbackName: namesByPubkey.get(key) ?? undefined,
    }),
    avatarUrl: profiles?.[key]?.avatarUrl ?? null,
    isAgent: profiles?.[key]?.isAgent ?? false,
  };

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5"
      data-testid="org-audit-row"
    >
      <StatusGlyph
        aria-label={row.description}
        className="shrink-0"
        tone={row.tone}
      />
      <span className="min-w-0 flex-1 truncate text-sm" title={row.description}>
        {row.description}
      </span>
      <span className="inline-flex min-w-0 max-w-40 shrink items-center gap-1.5">
        <UserAvatar
          avatarUrl={identity.avatarUrl}
          className="h-4 w-4 shrink-0"
          displayName={identity.label}
          shape={identity.isAgent ? "squircle" : "circle"}
          size="xs"
        />
        <span className="truncate text-2xs font-medium text-foreground/70">
          {identity.label}
        </span>
      </span>
      <time
        className="shrink-0 text-2xs font-medium tabular-nums text-muted-foreground"
        dateTime={fullTimestampLabel(row.createdAt)}
        title={fullTimestampLabel(row.createdAt)}
      >
        {relativeTimeLabel(row.createdAt, nowSeconds)}
      </time>
      <CopyableEventId eventId={row.key} />
    </div>
  );
}
