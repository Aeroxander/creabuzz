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
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser } from "@/shared/lib/identity";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { KIND_AGENT_TASK } from "@/shared/constants/kinds";

export type TaskStatus =
  | "open"
  | "assigned"
  | "in_progress"
  | "needs_approval"
  | "done"
  | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface FleetTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;
  parentEventId: string | null;
  channelId: string | null;
  author: string;
  priority: TaskPriority;
  due: number | null;
  labels: string[];
  updatedAt: number;
}

export function parseTask(event: NostrEvent): FleetTask | null {
  const id = event.tags.find((t) => t[0] === "d")?.[1];
  if (!id) return null;
  let body: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    due?: number | null;
    labels?: string[];
  } = {};
  try {
    body = JSON.parse(event.content) as typeof body;
  } catch {
    // malformed content — task still surfaces with defaults
  }
  const statusList: TaskStatus[] = [
    "open",
    "assigned",
    "in_progress",
    "needs_approval",
    "done",
    "cancelled",
  ];
  const status = statusList.includes(body.status as TaskStatus)
    ? (body.status as TaskStatus)
    : "open";
  return {
    id,
    title: body.title ?? event.content.slice(0, 80),
    description: body.description ?? "",
    status,
    assignee: event.tags.find((t) => t[0] === "p")?.[1] ?? null,
    parentEventId: event.tags.find((t) => t[0] === "e")?.[1] ?? null,
    channelId: event.tags.find((t) => t[0] === "h")?.[1] ?? null,
    author: event.pubkey,
    priority: (["low", "normal", "high", "urgent"] as const).includes(
      body.priority as TaskPriority,
    )
      ? (body.priority as TaskPriority)
      : "normal",
    due: typeof body.due === "number" && body.due > 0 ? body.due : null,
    labels: Array.isArray(body.labels) ? body.labels : [],
    updatedAt: event.created_at * 1000,
  };
}

export function useAgentTasks(): {
  tasks: FleetTask[];
  loading: boolean;
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

  useEffect(() => {
    const wsUrl = relayWsUrl();
    const filter: NostrFilter = { kinds: [KIND_AGENT_TASK], limit: 200 };
    let disposed = false;

    const upsert = (event: NostrEvent) => {
      const parsed = parseTask(event);
      if (!parsed) return;
      // Read-side LWW: keep the newest row per task id.
      setTasks((prev) => {
        const existing = prev[parsed.id];
        if (existing && existing.updatedAt >= parsed.updatedAt) return prev;
        return { ...prev, [parsed.id]: parsed };
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
        setLoading(false);
      })
      .catch(() => {
        if (!disposed) setLoading(false);
      });

    const unsubscribe = subscribeChannel(wsUrl, filter, {
      onEvent: (event) => upsert(event),
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const createTask = useCallback(
    async (input: {
      title: string;
      description?: string;
      assignee?: string;
      channelId?: string;
      parentEventId?: string;
      priority?: TaskPriority;
      due?: number | null;
      labels?: string[];
    }) => {
      const id =
        "task-" +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 6);
      const tags: string[][] = [["d", id]];
      if (input.assignee) tags.push(["p", input.assignee]);
      if (input.parentEventId) tags.push(["e", input.parentEventId]);
      if (input.channelId) tags.push(["h", input.channelId]);
      const signed = await signAsUser({
        kind: KIND_AGENT_TASK,
        tags,
        content: JSON.stringify({
          title: input.title,
          description: input.description ?? "",
          status: input.assignee ? "assigned" : "open",
          priority: input.priority ?? "normal",
          due: input.due ?? null,
          labels: input.labels ?? [],
        }),
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        throw new Error(result.message ?? "task publish rejected");
      }
    },
    [],
  );

  const sorted = useMemo(
    () =>
      Object.values(tasks).sort(
        (a, b) => a.status.localeCompare(b.status) || b.updatedAt - a.updatedAt,
      ),
    [tasks],
  );

  return { tasks: sorted, loading, createTask };
}

function upsertFrom(event: NostrEvent, into: Record<string, FleetTask>): void {
  const parsed = parseTask(event);
  if (!parsed) return;
  const existing = into[parsed.id];
  if (!existing || existing.updatedAt < parsed.updatedAt) {
    into[parsed.id] = parsed;
  }
}
