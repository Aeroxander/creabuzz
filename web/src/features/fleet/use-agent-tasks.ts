/**
 * Fleet task board (kind:44011).
 *
 * Tasks are addressable-ish by `d` = task id; the relay stores every update
 * as its own row (read-side LWW), so this hook queries history + a live
 * subscription and dedupes to the newest event per task id. Anyone may
 * publish an update row with the same `d`; status is taken from the latest.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  queryEvents,
  type NostrFilter,
  type NostrEvent,
} from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { liveFiltersFor } from "@/features/channels/lib/live-scope";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { KIND_AGENT_TASK } from "@/shared/constants/kinds";
import { type NewTaskInput, publishNewTask } from "./lib/task-publish";
import { type FleetTask, parseTask, type TaskPriority } from "./lib/task-row";

export { parseTask };
export type { FleetTask, TaskPriority };

/**
 * The fleet's tasks: read once, then followed live, both untied and in each of `channelIds` (a task tied to a room is
 * delivered live only to a subscription tied to that room).
 */
export function useAgentTasks(channelIds: readonly string[] = []): {
  tasks: FleetTask[];
  loading: boolean;
  /** Set when the read failed; the view reports it rather than showing none. */
  loadError: unknown;
  createTask: (input: {
    title: string;
    description?: string;
    assignee?: string;
    channelId?: string;
    parentEventId?: string;
    priority?: TaskPriority;
    due?: number | null;
    labels?: string[];
  }) => Promise<void>;
} {
  const [tasks, setTasks] = useState<Record<string, FleetTask>>({});
  const [loading, setLoading] = useState(true);
  /** Set when the task read failed, so the list can say so instead of "none". */
  const [loadError, setLoadError] = useState<unknown>(null);
  // A stable key, so a new array with the same rooms does not resubscribe.
  const channelKey = channelIds.join(",");

  useEffect(() => {
    const wsUrl = relayWsUrl();
    const filter: NostrFilter = { kinds: [KIND_AGENT_TASK], limit: 200 };
    let disposed = false;

    const upsert = (event: NostrEvent) => {
      const parsed = parseTask(event);
      if (!parsed) return;
      // Read-side LWW per author-qualified identity: the `d` tag alone is not
      // unique (any member can reuse another author's task id).
      setTasks((prev) => {
        const existing = prev[parsed.key];
        if (existing && existing.updatedAt >= parsed.updatedAt) return prev;
        return { ...prev, [parsed.key]: parsed };
      });
    };

    void queryEvents(wsUrl, filter)
      .then((events) => {
        if (disposed) return;
        setTasks((prev) => {
          const next = { ...prev };
          for (const event of events) upsertFrom(event, next);
          return next;
        });
        setLoadError(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        console.warn("[fleet] task list failed", error);
        if (!disposed) {
          setLoadError(error);
          setLoading(false);
        }
      });

    const stops = liveFiltersFor(
      { kinds: [KIND_AGENT_TASK] } satisfies NostrFilter,
      channelKey === "" ? [] : channelKey.split(","),
    ).map((live) =>
      subscribeChannel(wsUrl, live, { onEvent: (event) => upsert(event) }),
    );
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [channelKey]);

  const createTask = useCallback(
    (input: NewTaskInput) => publishNewTask(input),
    [],
  );

  const sorted = useMemo(
    () =>
      Object.values(tasks).sort(
        (a, b) => a.status.localeCompare(b.status) || b.updatedAt - a.updatedAt,
      ),
    [tasks],
  );

  return { tasks: sorted, loading, loadError, createTask };
}

function upsertFrom(event: NostrEvent, into: Record<string, FleetTask>): void {
  const parsed = parseTask(event);
  if (!parsed) return;
  const existing = into[parsed.key];
  if (!existing || existing.updatedAt < parsed.updatedAt) {
    into[parsed.key] = parsed;
  }
}
