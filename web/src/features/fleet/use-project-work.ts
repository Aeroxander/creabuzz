import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { existingUserPubkey } from "@/shared/lib/identity";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import {
  launchCoordinate,
  type LaunchRecord,
} from "@/features/launchpad/models";
import {
  projectWorkFilters,
  projectTaskHistoryFilters,
  readProjectWork,
} from "./lib/project-work";
import { parseTask } from "./use-agent-tasks";

/** Team-signed project records. Community task activity remains on the workspace board. */
export function useProjectWork(record: LaunchRecord) {
  const relay = relayWsUrl();
  const me = existingUserPubkey();
  const coordinate = launchCoordinate(record.author, record.id);
  const channels = [...new Set(record.channels)].sort().slice(0, 8).join(",");
  const authors = [
    record.author,
    ...[...new Set(record.team.map((t) => t.pubkey))]
      .filter((p) => p !== record.author)
      .sort(),
  ]
    .slice(0, 64)
    .join(",");
  const scope = useMemo(
    () => ({
      coordinate,
      authors: authors.split(","),
      channels: channels ? channels.split(",") : [],
    }),
    [coordinate, authors, channels],
  );
  const client = useQueryClient();
  const key = useMemo(
    () => ["project-work", relay, me, coordinate, channels, authors],
    [relay, me, coordinate, channels, authors],
  );
  const query = useQuery({
    queryKey: key,
    staleTime: 15_000,
    retry: 1,
    queryFn: async () => {
      const result = await readProjectWork(scope, (f) => queryEvents(relay, f));
      const tasks = result.records.flatMap((m) => {
        const task = parseTask(m.event);
        return task
          ? [{ ...task, key: `${m.creator}:${task.id}`, linkedBy: m.linkedBy }]
          : [];
      });
      return {
        ...result,
        tasks: tasks.sort((a, b) => b.updatedAt - a.updatedAt),
        truncated:
          result.truncated ||
          record.channels.length > 8 ||
          record.team.length >= 64,
      };
    },
  });
  const ids = (query.data?.ids ?? []).join(",");
  const filters = useMemo(
    () => [
      // Legacy team-wide reads are discovery only. Live delivery is project,
      // channel or known-task scoped, so unrelated activity cannot refetch it.
      ...projectWorkFilters(scope).slice(0, -1),
      ...projectTaskHistoryFilters(scope, ids ? ids.split(",") : []),
    ],
    [scope, ids],
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer === null)
        timer = setTimeout(() => {
          timer = null;
          void client.invalidateQueries({ queryKey: key });
        }, 500);
    };
    const stops = filters.map((f) =>
      subscribeChannel(relay, f, { onEvent: refresh }),
    );
    return () => {
      for (const stop of stops) stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [relay, filters, key, client]);
  return query;
}
