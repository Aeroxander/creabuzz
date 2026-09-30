import * as React from "react";

import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Spinner } from "@/shared/ui/spinner";
import { StatusGlyph } from "@/shared/ui/StatusGlyph";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { cn } from "@/shared/lib/cn";

import {
  useAgentLivenessQuery,
  useBudgetUtilizationsQuery,
  useContributionRecordsQuery,
  useOrgActivityExtrasQuery,
} from "../hooks";
import { pluralize } from "../lib/format";
import { collectAgentSeats, newestSeenPerSeat } from "../lib/nodeLiveness";
import {
  deriveActivityRows,
  deriveBlockingBanners,
  relativeTimeLabel,
  BANNER_LIMIT,
} from "../lib/dashboard";
import type { OrgChart } from "../orgModels";
import { AgentWikiSection } from "./AgentWikiSection";
import { LivenessBadge } from "./LivenessBadge";
import { OrgMetricRow } from "./OrgMetricRow";
import { OrgDiagnosticCard } from "./OrgDiagnosticCard";

type OrgDashboardProps = {
  query: UseQueryResult<OrgChart, Error>;
  /** Switch to the owning tab ("grants"/budgets/nodes resolve on Chart). */
  onOpenTab: (tab: "chart" | "contributions") => void;
};

/** pubkey → node display name; first node wins so an agent-seat node
 *  (whose own name is the agent name) beats a team it also sits on. */
function buildNamesByPubkey(
  nodes: ReadonlyArray<{
    name: string;
    holders: string[];
    agentSeats: string[];
  }>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const node of nodes) {
    for (const pubkey of [...node.holders, ...node.agentSeats]) {
      const key = pubkey.trim().toLowerCase();
      if (!names.has(key)) names.set(key, node.name);
    }
  }
  return names;
}

/** Liveness decays even without new events, so re-derive it on a timer. */
const LIVENESS_TICK_MS = 30_000;

export function OrgDashboard({ query, onOpenTab }: OrgDashboardProps) {
  const livenessQuery = useAgentLivenessQuery();
  const contributionsQuery = useContributionRecordsQuery();
  const extrasQuery = useOrgActivityExtrasQuery();
  const [nowTick, setNowTick] = React.useState(() =>
    Math.floor(Date.now() / 1_000),
  );
  React.useEffect(() => {
    const id = window.setInterval(
      () => setNowTick(Math.floor(Date.now() / 1_000)),
      LIVENESS_TICK_MS,
    );
    return () => window.clearInterval(id);
  }, []);

  // Everything below must live before the early returns (rules of hooks);
  // the derivations tolerate undefined data and only the render branches on
  // loading/error/empty.
  const data = query.data;
  const contributions = contributionsQuery.data ?? [];
  const extras = extrasQuery.data ?? [];
  const agents = React.useMemo(
    () => collectAgentSeats(data?.nodes ?? []),
    [data?.nodes],
  );
  const liveness = React.useMemo(
    () => newestSeenPerSeat(livenessQuery.data ?? [], agents, nowTick),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [livenessQuery.data, agents, nowTick],
  );
  const namesByPubkey = React.useMemo(
    () => buildNamesByPubkey(data?.nodes ?? []),
    [data?.nodes],
  );
  const namesByDtag = React.useMemo(
    () => new Map((data?.nodes ?? []).map((node) => [node.dtag, node.name])),
    [data?.nodes],
  );
  const activeBudgets = React.useMemo(
    () => (data?.budgets ?? []).filter((b) => !b.revoked),
    [data?.budgets],
  );
  const utilizations = useBudgetUtilizationsQuery(activeBudgets);
  const banners = React.useMemo(
    () =>
      deriveBlockingBanners({
        budgets: activeBudgets,
        utilizations: utilizations.data ?? [],
        grants: data?.grants ?? [],
        liveness,
        nodes: data?.nodes ?? [],
        namesByPubkey,
        nowSeconds: nowTick,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeBudgets,
      utilizations.data,
      data?.grants,
      liveness,
      data?.nodes,
      namesByPubkey,
      nowTick,
    ],
  );
  const activity = React.useMemo(
    () =>
      deriveActivityRows({
        nodes: data?.nodes ?? [],
        grants: data?.grants ?? [],
        budgets: data?.budgets ?? [],
        contributions,
        extras,
        namesByPubkey,
        namesByDtag,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      data?.nodes,
      data?.grants,
      data?.budgets,
      contributions,
      extras,
      namesByPubkey,
      namesByDtag,
    ],
  );

  // Profile-backed identity for agent seats and activity actors: display
  // name (profile → node name → truncated pubkey) plus avatar URL. One batch
  // query covers both lists.
  const identityPubkeys = React.useMemo(() => {
    const keys = new Set(agents);
    for (const row of activity) {
      if (row.actorPubkey) keys.add(row.actorPubkey);
    }
    return [...keys];
  }, [agents, activity]);
  const profiles = useUsersBatchQuery(identityPubkeys).data?.profiles;
  const resolveIdentity = React.useCallback(
    (
      pubkey: string,
    ): { label: string; avatarUrl: string | null; isAgent: boolean } => {
      const key = pubkey.trim().toLowerCase();
      const profile = profiles?.[key];
      return {
        label: resolveUserLabel({
          pubkey,
          profiles,
          fallbackName: namesByPubkey.get(key) ?? undefined,
        }),
        avatarUrl: profile?.avatarUrl ?? null,
        isAgent: profile?.isAgent ?? false,
      };
    },
    [profiles, namesByPubkey],
  );

  const loading =
    query.isPending || contributionsQuery.isPending || extrasQuery.isPending;
  const error =
    query.isError || contributionsQuery.isError || extrasQuery.isError;

  if (loading) {
    return (
      <EmptyState
        icon={<Spinner aria-hidden="true" className="h-6 w-6" />}
        testId="org-dashboard-loading"
        title="Loading org dashboard…"
      />
    );
  }

  if (error) {
    return (
      <EmptyState
        action={
          <Button
            onClick={() => {
              void query.refetch();
              void contributionsQuery.refetch();
              void extrasQuery.refetch();
            }}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        }
        description="The relay did not answer one of the dashboard queries. Check the connection, then retry."
        testId="org-dashboard-error"
        title="Failed to load the org dashboard"
        variant="error"
      />
    );
  }

  const hasAnyData =
    (data?.nodes.length ?? 0) > 0 ||
    (data?.grants.length ?? 0) > 0 ||
    (data?.budgets.length ?? 0) > 0 ||
    contributions.length > 0 ||
    extras.length > 0;

  if (!data || !hasAnyData) {
    return (
      <EmptyState
        action={
          <Button onClick={() => onOpenTab("chart")} size="sm">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create First Node
          </Button>
        }
        description="No roles, teams, budgets, or activity yet. Create a node to seed the org graph."
        icon={<Plus aria-hidden="true" className="h-5 w-5" />}
        testId="org-dashboard-empty"
        title="No org data yet"
      />
    );
  }

  const visibleBanners = banners.slice(0, BANNER_LIMIT);
  const hiddenBannerCount = banners.length - visibleBanners.length;

  // Live agents row: agent seats sorted live → waiting → gone.
  const sortedAgents = [...agents].sort((a, b) => {
    const rank = { live: 2, waiting: 1, gone: 0 };
    const aStatus = liveness.get(a)?.status ?? "gone";
    const bStatus = liveness.get(b)?.status ?? "gone";
    return rank[bStatus] - rank[aStatus] || a.localeCompare(b);
  });
  const liveSeatCount = [...liveness.values()].filter(
    (entry) => entry.status === "live",
  ).length;

  return (
    <div className="space-y-4 p-4" data-testid="org-dashboard">
      {/* The Phase 4 instrument (OA.md §6) — recomputable via `buzz diag`. */}
      <OrgDiagnosticCard />

      {/* 1. Blocking banners — cause + consequence + ONE action. */}
      {banners.length > 0 && (
        <div className="space-y-2">
          {visibleBanners.map((banner) => (
            <Card
              className="flex items-start gap-2 border-status-blocking-border bg-status-blocking-bg p-3"
              data-testid={`org-banner-${banner.key}`}
              key={banner.key}
            >
              <AlertTriangle
                aria-hidden="true"
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  banner.tone === "waiting"
                    ? "text-status-waiting"
                    : "text-status-blocking",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight">
                  {banner.title}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {banner.detail}
                </p>
              </div>
              <Button
                className="shrink-0"
                onClick={() => onOpenTab("chart")}
                size="sm"
                variant="outline"
              >
                {banner.actionLabel}
              </Button>
            </Card>
          ))}
          {hiddenBannerCount > 0 && (
            <p
              className="px-1 text-xs text-muted-foreground"
              data-testid="org-banners-more"
            >
              +{pluralize(hiddenBannerCount, "more blocking issue")}
            </p>
          )}
        </div>
      )}

      {/* 2. Live agents row — liveness before numbers. */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">
          Live agents — {liveSeatCount} of {agents.length} live
        </h3>
        {agents.length === 0 ? (
          <EmptyState
            action={
              <Button onClick={() => onOpenTab("chart")} size="sm">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Open chart
              </Button>
            }
            description="Add an agent seat to a role or team, then its liveness appears here."
            icon={<RefreshCw aria-hidden="true" className="h-5 w-5" />}
            testId="org-dashboard-no-agents"
            title="No agent seats yet"
          />
        ) : (
          <Card className="divide-y p-1" data-testid="org-live-agents">
            {sortedAgents.map((seat) => {
              const entry = liveness.get(seat);
              const status = entry?.status ?? "gone";
              const identity = resolveIdentity(seat);
              return (
                <div
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5",
                    status === "gone" && "opacity-60",
                  )}
                  data-live-agent={seat}
                  key={seat}
                >
                  <UserAvatar
                    avatarUrl={identity.avatarUrl}
                    className="h-5 w-5 shrink-0"
                    displayName={identity.label}
                    shape={identity.isAgent ? "squircle" : "circle"}
                    size="xs"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {identity.label}
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                    {truncatePubkey(seat)}
                  </span>
                  <LivenessBadge
                    status={status}
                    testId={`org-agent-liveness-${status}`}
                  />
                </div>
              );
            })}
          </Card>
        )}
      </div>

      {/* 3. Metric cards — same four numbers as the Chart tab. */}
      <OrgMetricRow data={data} onFocusBudgets={() => onOpenTab("chart")} />

      {/* 4. Recent activity — one row per event, no raw JSON. */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Recent activity</h3>
        {activity.length === 0 ? (
          <EmptyState
            action={
              <Button onClick={() => onOpenTab("chart")} size="sm">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Open chart
              </Button>
            }
            description="Publish grants, budgets, or contribution records and they show up here."
            icon={<Plus aria-hidden="true" className="h-5 w-5" />}
            testId="org-dashboard-no-activity"
            title="No activity yet"
          />
        ) : (
          <Card className="divide-y p-1" data-testid="org-activity-feed">
            {activity.map((row) => {
              const identity = resolveIdentity(row.actorPubkey);
              const known = Boolean(
                profiles?.[row.actorPubkey.trim().toLowerCase()] ??
                  namesByPubkey.get(row.actorPubkey.trim().toLowerCase()),
              );
              return (
                <button
                  aria-label={`${row.description} by ${identity.label}`}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="org-activity-row"
                  key={row.key}
                  onClick={() =>
                    onOpenTab(
                      row.targetTab === "contributions"
                        ? "contributions"
                        : "chart",
                    )
                  }
                  type="button"
                >
                  <StatusGlyph aria-label={row.description} tone={row.tone} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {row.description}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 max-w-32 shrink truncate text-2xs",
                      known
                        ? "font-medium text-foreground/70"
                        : "text-muted-foreground",
                    )}
                  >
                    {identity.label}
                  </span>
                  <span className="shrink-0 text-2xs font-medium tabular-nums text-muted-foreground">
                    {relativeTimeLabel(row.createdAt, nowTick)}
                  </span>
                </button>
              );
            })}
          </Card>
        )}
      </div>

      {/* 5. Agent wiki — kind:44002 standup + page list (read-only). */}
      <AgentWikiSection nowSeconds={nowTick} />
    </div>
  );
}
