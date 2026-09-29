import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bot, Sparkles } from "lucide-react";

import { agentActivitySummary } from "@/features/home/lib/inbox";
import { useHomeFeedQuery } from "@/features/home/hooks";
import {
  useOrgClassifyTaskMutation,
  type OrgClassifyResult,
} from "@/features/org/hooks";
import { formatItemTimestamp } from "@/shared/lib/datetime";
import type { FeedItem } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { Spinner } from "@/shared/ui/spinner";

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
 * Status carried by a kind-44011 task row, parsed from its JSON content.
 * Returns `null` when the row is not a task or the content is unparseable.
 */
function taskStatus(item: FeedItem): string | null {
  if (item.kind !== 44011) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(item.content);
    if (typeof parsed === "object" && parsed !== null) {
      const status = (parsed as Record<string, unknown>).status;
      return typeof status === "string" && status !== "" ? status : null;
    }
  } catch {
    // Malformed task content — no status.
  }
  return null;
}

/**
 * "Draft contribution" on a done task: previews the classifier draft without
 * confirmation (nothing is published), then offers "Publish for review" with
 * a small confirm. On publish the user lands on the Org Contributions tab,
 * which is invalidated so the new pending record appears immediately.
 */
function AgentTaskDraftAction({ item }: { item: FeedItem }) {
  const navigate = useNavigate();
  const previewMutation = useOrgClassifyTaskMutation();
  const publishMutation = useOrgClassifyTaskMutation();
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<OrgClassifyResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const busy = previewMutation.isPending || publishMutation.isPending;

  const runPreview = () => {
    setError(null);
    setPreview(null);
    previewMutation.mutate(
      { taskEventId: item.id, publish: false },
      {
        onSuccess: (result) => {
          setPreview(result);
          setSheetOpen(true);
        },
        onError: (err) =>
          setError(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  const runPublish = () => {
    setConfirmOpen(false);
    setError(null);
    publishMutation.mutate(
      { taskEventId: item.id, publish: true },
      {
        onSuccess: () => {
          setSheetOpen(false);
          setPreview(null);
          void navigate({ to: "/org", search: { tab: "contributions" } });
        },
        onError: (err) =>
          setError(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  const draft = preview?.draft ?? null;
  const dimensions = draft?.dimensions;
  const humanVsAi = draft?.humanVsAi;

  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-2"
      data-testid={`draft-contribution-${item.id}`}
    >
      {!sheetOpen && !preview ? (
        <Button
          data-testid={`draft-contribution-preview-${item.id}`}
          disabled={busy}
          onClick={runPreview}
          size="xs"
          variant="outline"
        >
          <Sparkles aria-hidden="true" className="mr-1 h-3 w-3" />
          {previewMutation.isPending ? "Drafting…" : "Draft contribution"}
        </Button>
      ) : null}
      {error ? (
        <p
          className="text-2xs text-destructive"
          data-testid={`draft-contribution-error-${item.id}`}
        >
          {error}
        </p>
      ) : null}
      {preview?.mode === "published" ? (
        <p className="text-2xs text-muted-foreground">
          Published record {preview.eventId?.slice(0, 12)}… — opening
          Contributions.
        </p>
      ) : null}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Contribution draft</SheetTitle>
            <SheetDescription>
              Classifier proposal for the completed task — nothing is published
              until you confirm.
            </SheetDescription>
          </SheetHeader>
          {busy ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner aria-hidden="true" className="h-3.5 w-3.5" />
              {publishMutation.isPending ? "Publishing…" : "Drafting…"}
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Action
                </p>
                <p
                  className="mt-0.5 text-sm"
                  data-testid="draft-contribution-action"
                >
                  {typeof draft?.action === "string" ? draft.action : "—"}
                </p>
              </div>
              {draft &&
              typeof dimensions === "object" &&
              dimensions !== null ? (
                <div>
                  <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Dimensions
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {Object.entries(dimensions as Record<string, unknown>).map(
                      ([name, value]) => (
                        <span
                          className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-2xs"
                          key={name}
                        >
                          {name}
                          <span className="font-mono text-muted-foreground">
                            {typeof value === "number"
                              ? value.toFixed(2)
                              : String(value)}
                          </span>
                        </span>
                      ),
                    )}
                  </div>
                </div>
              ) : null}
              {draft && typeof humanVsAi === "object" && humanVsAi !== null ? (
                <p className="text-2xs text-muted-foreground">
                  Human/AI:{" "}
                  {Object.entries(humanVsAi as Record<string, unknown>)
                    .map(([name, value]) => `${name} ${value}`)
                    .join(" · ")}
                </p>
              ) : null}
              {preview && preview.mode === "preview" ? (
                <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                  <AlertDialogTrigger asChild>
                    <Button
                      className="w-full"
                      data-testid="draft-contribution-publish"
                      size="sm"
                    >
                      Publish for review
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Publish a pending contribution record for review?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        The drafted contribution record is signed with your key
                        and shared with the community, marked "pending review".
                        You can still accept or reject it from the Contributions
                        tab.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Not yet</AlertDialogCancel>
                      <AlertDialogAction
                        data-testid="draft-contribution-publish-confirm"
                        onClick={(event) => {
                          event.preventDefault();
                          void runPublish();
                        }}
                      >
                        Publish
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
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
                {taskStatus(item) === "done" ? (
                  <AgentTaskDraftAction item={item} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
