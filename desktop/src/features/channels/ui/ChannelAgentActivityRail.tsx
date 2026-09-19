import * as React from "react";
import { Bot } from "lucide-react";

import { agentActivitySummary } from "@/features/home/lib/inbox";
import { useHomeFeedQuery } from "@/features/home/hooks";
import { formatItemTimestamp } from "@/shared/lib/datetime";
import type { FeedItem } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";

/** Rows shown before the rail collapses into the Home feed link. */
const MAX_RAIL_ROWS = 8;

/** Agent names shown in the "active now" line. */
const MAX_ACTIVE_NAMES = 5;

function rowSummary(item: FeedItem): { headline: string; preview: string } {
  const summary = agentActivitySummary(item.kind, item.content);
  if (summary) {
    return summary;
  }
  // Honest fallback for agent-plane kinds without a specific summary —
  // never fabricate semantics (VISION_ACTIVITY.md).
  return { headline: "Agent update", preview: "" };
}

/**
 * Distinct agent names from the latest capabilities rows, newest first.
 * Pure function of feed items so it is unit-testable; the rail renders its
 * result as the "active now" line. Names come from signed 44010 content,
 * never invented — rows without a parseable name are skipped.
 */
export function selectActiveAgentNames(items: readonly FeedItem[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  for (const item of sorted) {
    if (item.kind !== 44010 || names.length >= MAX_ACTIVE_NAMES) {
      continue;
    }
    let name: string | null = null;
    try {
      const parsed: unknown = JSON.parse(item.content);
      if (typeof parsed === "object" && parsed !== null) {
        const raw = (parsed as Record<string, unknown>).name;
        if (typeof raw === "string" && raw.trim() !== "") {
          name = raw.trim();
        }
      }
    } catch {
      // Malformed capabilities content — skip, never guess.
    }
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Member-visible agent activity for one channel, fed by the relay's
 * `agent_activity` feed (agent-plane kinds in accessible channels + own
 * turn metrics — see docs/agent-activity-sharing.md). Owner-only rows
 * never reach this list: the relay authorizes every row before delivery.
 */
export function ChannelAgentActivityRail({
  channelId,
}: {
  channelId: string | null;
}) {
  const feedQuery = useHomeFeedQuery();
  const items = React.useMemo(() => {
    if (!channelId) {
      return [];
    }
    const all = feedQuery.data?.feed.agentActivity ?? [];
    return all
      .filter((item) => item.channelId === channelId)
      .slice(0, MAX_RAIL_ROWS);
  }, [channelId, feedQuery.data?.feed.agentActivity]);
  const activeNames = React.useMemo(
    () => selectActiveAgentNames(items),
    [items],
  );

  if (!channelId) {
    return null;
  }

  return (
    <section
      aria-label="Agent activity"
      className="mt-4"
      data-testid="channel-agent-activity-rail"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-muted-foreground">
        <Bot aria-hidden="true" className="h-4 w-4" />
        Agent activity
      </h2>
      {activeNames.length > 0 ? (
        <p
          className="mt-1 px-1 text-2xs text-muted-foreground"
          data-testid="channel-agent-activity-active"
        >
          Active now: {activeNames.join(", ")}
        </p>
      ) : null}
      {feedQuery.isLoading ? (
        <p className="px-1 py-3 text-xs text-muted-foreground">
          Loading agent activity...
        </p>
      ) : feedQuery.isError ? (
        <p
          className="px-1 py-3 text-xs text-destructive"
          data-testid="channel-agent-activity-error"
        >
          Couldn&apos;t load agent activity.
        </p>
      ) : items.length === 0 ? (
        <p
          className="px-1 py-3 text-xs text-muted-foreground"
          data-testid="channel-agent-activity-empty"
        >
          No agent activity in this channel yet.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {items.map((item) => {
            const summary = rowSummary(item);
            return (
              <li
                className={cn(
                  "rounded-lg border border-border/60 bg-background/70 px-3 py-2",
                )}
                data-testid={`channel-agent-activity-row-${item.id}`}
                key={item.id}
              >
                <p className="text-xs font-medium leading-snug">
                  {summary.headline}
                </p>
                {summary.preview ? (
                  <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted-foreground">
                    {summary.preview}
                  </p>
                ) : null}
                <p className="mt-1 text-2xs text-muted-foreground">
                  {formatItemTimestamp(item.createdAt, { withTime: true })}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
