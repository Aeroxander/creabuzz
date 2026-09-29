import * as React from "react";

import { AlertTriangle, Check, Copy, Plus, ShieldCheck } from "lucide-react";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import type { RelayEvent } from "@/shared/api/types";
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
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { Spinner } from "@/shared/ui/spinner";
import { StatusGlyph } from "@/shared/ui/StatusGlyph";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import {
  useOrgAuditChainQuery,
  useOrgAuditQuery,
  useOrgChartQuery,
} from "../hooks";
import {
  AUDIT_FETCH_LIMIT,
  auditActorOptions,
  auditKindLabel,
  auditKindOptions,
  deriveAuditRows,
  deriveVerifySummary,
  filterAuditRows,
  fullTimestampLabel,
  groupAuditRows,
  type AuditGroupBy,
  type AuditObjectRef,
} from "../lib/audit";
import {
  auditActionLabel,
  badgeForEvent,
  deriveChainBadges,
  verifyChain,
  type ChainBadge,
} from "../lib/auditChain";
import { relativeTimeLabel } from "../lib/dashboard";

/**
 * Org audit view — the evidence spine (NIP-ORG). Every structural change
 * (kinds 37010–37014 + 46010/46030/46031), attributed, newest first, with the
 * affected object linked to the view that details it.
 *
 * Two verification layers, both honest about what they prove:
 *
 * 1. **Hash chain** — chain entries (kind:48001) are re-digested in the
 *    browser by `lib/auditChain.ts` (byte-exact with `crates/buzz-audit`).
 *    A verified run shows its seq range; a break turns loud red at the exact
 *    seq. The relay does publish these entries (relay-signed kind:48001), but
 *    only to community owners and admins; when none are served to this reader
 *    the badge says "not served" rather than green. A verified chain proves the
 *    published entries are internally consistent — it is not tamper-evidence
 *    against the relay operator, who signs and stores the chain.
 * 2. **Presence check** — the Verify modal re-fetches and confirms the rows
 *    you were reading are still there. It is labeled as presence, never as a
 *    chain proof.
 */

const VERIFY_SAMPLE_NOTE =
  "Checks that the newest entries you were viewing are still present after a fresh re-fetch.";

const CHAIN_NOT_SERVED_NOTE =
  "The audit chain is only visible to community owners and admins, so it cannot be verified from this account. Every row below is still individually signed.";

const CHAIN_OPERATOR_CAVEAT =
  "This shows the relay's published entries are internally consistent; it does not protect against the relay operator, who signs and stores the chain.";

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

/** Short machine identity for an object chip (ids stay monospace). */
function shortIdentity(value: string): string {
  return value.length > 12 ? `${value.slice(0, 10)}…` : value;
}

type ChainStatusView = {
  state: "loading" | "error" | "unserved" | "verified" | "broken" | "malformed";
  text: string;
  note: string;
};

function describeChainStatus(input: {
  isPending: boolean;
  isError: boolean;
  entryCount: number;
  malformed: number;
  verification: ReturnType<typeof verifyChain> | null;
  hitLimit: boolean;
}): ChainStatusView {
  if (input.isPending)
    return { state: "loading", text: "Checking chain…", note: "" };
  if (input.isError) {
    return {
      state: "error",
      text: "Chain unavailable",
      note: "The relay did not answer the chain query. Rows below are signed events; chain verification did not run.",
    };
  }
  if (input.entryCount === 0 && input.malformed === 0) {
    return {
      state: "unserved",
      text: "Chain not served",
      note: CHAIN_NOT_SERVED_NOTE,
    };
  }
  if (input.malformed > 0) {
    return {
      state: "malformed",
      text: `${input.malformed} chain entr${input.malformed === 1 ? "y" : "ies"} unreadable`,
      note: `Verification ran over the entries that did parse; the ${input.malformed} unreadable envelope${input.malformed === 1 ? " was" : "s were"} excluded, so treat the result as partial. The count is the honest signal — nothing here is dropped silently.`,
    };
  }
  const verification = input.verification;
  if (verification?.state === "broken") {
    const reason =
      verification.breakReason === "chain_violation"
        ? "prev_hash does not match the preceding entry"
        : verification.breakReason === "hash_mismatch"
          ? "stored hash does not match the recomputed digest"
          : "entry could not be digested";
    return {
      state: "broken",
      text: `Chain broken at #${String(verification.breakSeq)}`,
      note: `Entry #${String(verification.breakSeq)}: ${reason}. Entries #${String(verification.fromSeq)}–#${String(verification.toSeq)} verified before the break; everything after it is unverified.`,
    };
  }
  if (verification?.state === "verified") {
    const coverage = input.hitLimit ? "loaded prefix" : "loaded chain";
    const range = `#${String(verification.fromSeq)}–#${String(verification.toSeq)}`;
    return verification.genesis
      ? {
          state: "verified",
          text: `Chain verified ${range}`,
          note: `All ${verification.count} entries from the genesis entry hash-link correctly; digests were recomputed in this app. Coverage: ${coverage}. ${CHAIN_OPERATOR_CAVEAT}`,
        }
      : {
          state: "verified",
          text: `Chain verified ${range}`,
          note: `Entries ${range} hash-link correctly; digests were recomputed in this app. Verification covers the ${coverage} above — the chain continues before it. ${CHAIN_OPERATOR_CAVEAT}`,
        };
  }
  return {
    state: "unserved",
    text: "Chain not served",
    note: CHAIN_NOT_SERVED_NOTE,
  };
}

const CHAIN_STATUS_TONE: Record<
  ChainStatusView["state"],
  { badge: string; icon: boolean }
> = {
  loading: { badge: "text-muted-foreground", icon: false },
  error: { badge: "text-status-waiting", icon: false },
  unserved: { badge: "text-muted-foreground", icon: false },
  malformed: { badge: "text-status-waiting", icon: true },
  verified: { badge: "text-status-ok", icon: false },
  broken: { badge: "text-status-blocking", icon: true },
};

function ChainStatusBadge({ view }: { view: ChainStatusView }) {
  const tone = CHAIN_STATUS_TONE[view.state];
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium",
        view.state === "broken"
          ? "border-status-blocking-border bg-status-blocking-bg"
          : view.state === "verified"
            ? "border-status-ok-border bg-status-ok-bg"
            : "border-border bg-muted",
        tone.badge,
      )}
      data-testid="org-audit-chain-status"
      role="status"
      title={view.note}
    >
      {view.state === "broken" || view.state === "malformed" ? (
        <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />
      ) : null}
      <span className="truncate">{view.text}</span>
    </span>
  );
}

/** One row's chain position. Never green unless that digest was recomputed. */
function ChainPosition({ badge }: { badge: ChainBadge }) {
  const content = (() => {
    switch (badge.state) {
      case "verified":
        return {
          visible: `#${badge.seq} ✓`,
          text: `Chain entry ${badge.seq} (${auditActionLabel(badge.action)}) verified — hash recomputed in this app`,
          className: "text-status-ok",
        };
      case "broken":
        return {
          visible: `#${badge.seq} ✗`,
          text: `Chain entry ${badge.seq} (${auditActionLabel(badge.action)}) is the break: ${
            badge.reason === "chain_violation"
              ? "prev_hash does not match the preceding entry"
              : badge.reason === "hash_mismatch"
                ? "stored hash does not match the recomputed digest"
                : "entry could not be digested"
          }`,
          className: "text-status-blocking",
        };
      case "unverified":
        return {
          visible: `#${badge.seq} ?`,
          text: `Chain entry ${badge.seq} is unverified — the chain breaks before it`,
          className: "text-status-waiting",
        };
      case "not-in-chain":
        return {
          visible: "—",
          text: "No hash-chain entry covers this event in the loaded chain",
          className: "text-muted-foreground",
        };
      default:
        return {
          visible: "—",
          text: "Hash chain not served by this relay — chain position unavailable",
          className: "text-muted-foreground",
        };
    }
  })();

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center font-mono text-2xs font-medium",
        content.className,
      )}
      data-testid="org-audit-chain-badge"
      title={content.text}
    >
      <span aria-hidden="true">{content.visible}</span>
      <span className="sr-only">{content.text}</span>
    </span>
  );
}

export function OrgAuditView({
  onOpenTab,
  onOpenObject,
}: {
  /** Send the viewer to the Chart tab to make the first change. */
  onOpenTab: (tab: "chart") => void;
  /**
   * Open the object a row touched. Falls back to the chart tab when the
   * caller has no detail-view plumbing.
   */
  onOpenObject?: (object: AuditObjectRef) => void;
}) {
  const auditQuery = useOrgAuditQuery();
  const chainQuery = useOrgAuditChainQuery();
  const chartQuery = useOrgChartQuery();

  // Pages are appended oldest-ward; dedupe by id so a cursor that overlaps a
  // dense second cannot render the same event twice.
  const events = React.useMemo(() => {
    const seen = new Set<string>();
    const merged: RelayEvent[] = [];
    for (const page of auditQuery.data?.pages ?? []) {
      for (const event of page.events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        merged.push(event);
      }
    }
    return merged;
  }, [auditQuery.data]);

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

  // ── Filters and grouping ────────────────────────────────────────────────
  const [groupBy, setGroupBy] = React.useState<AuditGroupBy>("none");
  const [actorFilter, setActorFilter] = React.useState<string | null>(null);
  const [kindFilter, setKindFilter] = React.useState<number | null>(null);
  const filtered = React.useMemo(
    () => filterAuditRows(rows, { actor: actorFilter, kind: kindFilter }),
    [rows, actorFilter, kindFilter],
  );
  const groups = React.useMemo(
    () => groupAuditRows(filtered, groupBy, namesByPubkey),
    [filtered, groupBy, namesByPubkey],
  );
  const actorOptions = React.useMemo(
    () => auditActorOptions(rows, namesByPubkey),
    [rows, namesByPubkey],
  );
  const kindOptions = React.useMemo(() => auditKindOptions(rows), [rows]);
  const clearFilters = () => {
    setActorFilter(null);
    setKindFilter(null);
  };
  const filtersActive = actorFilter !== null || kindFilter !== null;

  // ── Chain verification (client-side, byte-exact with the Rust crate) ────
  const chainPage = chainQuery.data;
  const chainServed = (chainPage?.entries.length ?? 0) > 0;
  const verification = React.useMemo(
    () => (chainPage ? verifyChain(chainPage.entries) : null),
    [chainPage],
  );
  const chainBadges = React.useMemo(
    () =>
      chainPage && verification
        ? deriveChainBadges(chainPage.entries, verification)
        : new Map<string, ChainBadge>(),
    [chainPage, verification],
  );
  const chainStatus = describeChainStatus({
    isPending: chainQuery.isPending,
    isError: chainQuery.isError,
    entryCount: chainPage?.entries.length ?? 0,
    malformed: chainPage?.malformed ?? 0,
    verification,
    hitLimit: chainPage?.hitLimit ?? false,
  });

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
      refetchedIds: events.map((event) => event.id),
      hitFetchLimit: events.length >= AUDIT_FETCH_LIMIT,
    });
  }, [
    verifyOpen,
    verifySampleIds,
    auditQuery.isPending,
    auditQuery.isError,
    events,
  ]);

  const newest = rows[0];
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

  const openObject = (object: AuditObjectRef) => {
    if (onOpenObject) onOpenObject(object);
    else onOpenTab("chart");
  };

  const renderRow = (row: ReturnType<typeof deriveAuditRows>[number]) => (
    <AuditRowItem
      key={row.key}
      badge={badgeForEvent(chainBadges, row.key, chainServed)}
      namesByPubkey={namesByPubkey}
      nowSeconds={Math.floor(Date.now() / 1000)}
      onOpenObject={openObject}
      row={row}
    />
  );

  return (
    <div className="space-y-3 p-4" data-testid="org-audit-view">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Every structural change, attributed and signed. Newest first.
        </p>
        <div className="flex items-center gap-2">
          <ChainStatusBadge view={chainStatus} />
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
      </div>

      {chainStatus.state === "verified" &&
      verification &&
      !verification.genesis ? (
        <p
          className="text-2xs text-muted-foreground"
          data-testid="org-audit-chain-coverage"
        >
          Entries #{String(verification.fromSeq)}–#{String(verification.toSeq)}{" "}
          loaded — verification covers the loaded prefix, not the whole chain.
        </p>
      ) : null}
      {chainStatus.state === "broken" && verification ? (
        <p
          className="text-2xs font-medium text-status-blocking"
          data-testid="org-audit-chain-break"
        >
          {chainStatus.note}
        </p>
      ) : null}
      {chainStatus.state === "unserved" ||
      chainStatus.state === "error" ||
      chainStatus.state === "malformed" ? (
        <p
          className="text-2xs text-muted-foreground"
          data-testid="org-audit-chain-note"
        >
          {chainStatus.note}
        </p>
      ) : null}

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
          title="No structural changes recorded yet"
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<AuditGroupBy>
              legend="Group audit entries"
              onValueChange={setGroupBy}
              optionTestIdPrefix="org-audit-group"
              options={[
                { value: "none", label: "Flat" },
                { value: "actor", label: "By actor" },
                { value: "kind", label: "By kind" },
              ]}
              size="compact"
              testId="org-audit-group"
              value={groupBy}
            />
            <label className="sr-only" htmlFor="org-audit-filter-actor">
              Filter by actor
            </label>
            <select
              className="rounded border bg-background px-1 py-0.5 text-2xs"
              data-testid="org-audit-filter-actor"
              id="org-audit-filter-actor"
              onChange={(event) => setActorFilter(event.target.value || null)}
              value={actorFilter ?? ""}
            >
              <option value="">All actors</option>
              {actorOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({option.count})
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="org-audit-filter-kind">
              Filter by kind
            </label>
            <select
              className="rounded border bg-background px-1 py-0.5 text-2xs"
              data-testid="org-audit-filter-kind"
              id="org-audit-filter-kind"
              onChange={(event) =>
                setKindFilter(
                  event.target.value ? Number(event.target.value) : null,
                )
              }
              value={kindFilter === null ? "" : String(kindFilter)}
            >
              <option value="">All kinds</option>
              {kindOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({option.count})
                </option>
              ))}
            </select>
            {filtersActive ? (
              <Button
                data-testid="org-audit-clear-filters"
                onClick={clearFilters}
                size="sm"
                variant="ghost"
              >
                Clear filters
              </Button>
            ) : null}
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={clearFilters} size="sm" variant="outline">
                  Clear filters
                </Button>
              }
              description="No audit entry matches the selected actor and kind."
              testId="org-audit-no-matches"
              title="No matching changes"
            />
          ) : groupBy === "none" ? (
            <Card className="p-1" data-testid="org-audit-feed">
              <ul className="divide-y">{filtered.map(renderRow)}</ul>
            </Card>
          ) : (
            <div className="space-y-3">
              {groups.map((group) => (
                <section key={group.key} aria-label={`${group.label} entries`}>
                  <h4
                    className="px-1 pb-1 font-mono text-3xs uppercase tracking-wide text-muted-foreground"
                    data-testid="org-audit-group-heading"
                  >
                    {group.label} · {group.rows.length}
                  </h4>
                  <Card className="p-1">
                    <ul className="divide-y">{group.rows.map(renderRow)}</ul>
                  </Card>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {auditQuery.hasNextPage ? (
        <div className="flex items-center justify-between gap-2">
          <p className="px-1 text-2xs text-muted-foreground">
            Showing the newest {events.length} of at least{" "}
            {events.length + AUDIT_FETCH_LIMIT} — the chain is append-only, so
            older history loads on demand.
          </p>
          <Button
            data-testid="org-audit-load-older"
            disabled={auditQuery.isFetchingNextPage}
            onClick={() => void auditQuery.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {auditQuery.isFetchingNextPage ? "Loading…" : "Load older"}
          </Button>
        </div>
      ) : events.length >= AUDIT_FETCH_LIMIT ? (
        <p
          className="px-1 text-2xs text-muted-foreground"
          data-testid="org-audit-truncated"
        >
          Showing the newest {events.length} events. Older history exists — this
          is a floor, not a total.
        </p>
      ) : null}

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
                it is <strong>not</strong> a hash-chain proof. Hash-chain
                verification runs in this app over the chain entries the relay
                serves; the status chip above reports its result, including when
                no chain is served.
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
  badge,
  namesByPubkey,
  nowSeconds,
  onOpenObject,
}: {
  row: ReturnType<typeof deriveAuditRows>[number];
  badge: ChainBadge;
  namesByPubkey: ReadonlyMap<string, string>;
  nowSeconds: number;
  onOpenObject?: (object: AuditObjectRef) => void;
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
  const object = row.object;
  const objectLabel = object
    ? `Open ${auditKindLabel(row.kind)} ${object.id}`
    : undefined;

  return (
    <li
      className="flex items-center gap-2 px-2 py-1.5"
      data-testid="org-audit-row"
    >
      <StatusGlyph
        aria-label={row.description}
        className="shrink-0"
        tone={row.tone}
      />
      <span
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate"
        title={row.description}
      >
        <span className="truncate text-sm">{row.description}</span>
        {object &&
          (object.target && onOpenObject ? (
            <button
              aria-label={objectLabel}
              className="inline-flex shrink-0 rounded border px-1 py-0.5 font-mono text-3xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="org-audit-object"
              onClick={() => onOpenObject(object)}
              title={`${auditKindLabel(row.kind)} ${object.id} — open detail`}
              type="button"
            >
              {shortIdentity(object.id)}
            </button>
          ) : (
            <span
              className="inline-flex shrink-0 rounded border border-border px-1 py-0.5 font-mono text-3xs text-muted-foreground"
              data-testid="org-audit-object"
              title={`${auditKindLabel(row.kind)} ${object.id}`}
            >
              {shortIdentity(object.id)}
            </span>
          ))}
      </span>
      <ChainPosition badge={badge} />
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
    </li>
  );
}
