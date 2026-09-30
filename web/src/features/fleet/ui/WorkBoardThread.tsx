/**
 * Work-board thread replies and task status history.
 *
 * Split out of `WorkBoard.tsx`, which sits close to the file-size ratchet, and
 * because both panes name people: each pane resolves its authors' usernames in
 * one batched profile read instead of printing raw hex next to a reply.
 */

import { useEffect, useMemo, useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  KIND_AGENT_TASK,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";

export function RecentThread({ parentId }: { parentId: string }) {
  const [rows, setRows] = useState<
    { author: string; content: string; created: number }[]
  >([]);
  useEffect(() => {
    let disposed = false;
    const load = () =>
      void import("@/shared/lib/http-query").then(({ queryEventsHttp }) =>
        queryEventsHttp([
          {
            kinds: [
              KIND_STREAM_MESSAGE,
              KIND_STREAM_MESSAGE_V2,
              KIND_AGENT_TASK,
            ],
            "#e": [parentId],
            limit: 50,
          },
        ])
          .then((events) => {
            if (disposed) return;
            setRows(
              events
                .sort((a, b) => a.created_at - b.created_at)
                .map((e) => ({
                  author: e.pubkey,
                  content: e.content.slice(0, 400),
                  created: e.created_at,
                })),
            );
          })
          .catch((error: unknown) => {
            // Background refresh of the thread pane: log, do not interrupt.
            console.warn("[work] thread history failed", error);
          }),
      );
    load();
    // Live-ish: refresh while the pane is open so agent replies land.
    const timer = setInterval(load, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [parentId]);

  // One batched kind-0 read for every author in the pane, not one per reply.
  const authors = useMemo(
    () => [...new Set(rows.map((row) => row.author))],
    [rows],
  );
  const userName = useUserNames(authors);

  return (
    <div className="flex flex-col gap-1.5">
      {rows.length === 0 ? (
        <p className="text-xs text-black/60 dark:text-white/60">
          Loading thread…
        </p>
      ) : (
        rows.map((row) => (
          <div
            key={row.author + "-" + row.created}
            className="flex items-start gap-2 rounded-md bg-black/[0.03] p-2 dark:bg-white/5"
          >
            <UserAvatar
              avatarUrl={null}
              displayName={userName(row.author)}
              size="xs"
              className="mt-0.5"
            />
            <div className="min-w-0">
              <p className="truncate text-2xs font-medium text-black/60 dark:text-white/60">
                {userName(row.author)}
              </p>
              <p className="whitespace-pre-wrap break-words text-xs text-black/80 dark:text-white/80">
                {row.content}
              </p>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** Status-change history from the task's event rows. */
export function TaskHistory({ taskId }: { taskId: string }) {
  const [rows, setRows] = useState<
    { status: string; at: number; who: string }[]
  >([]);
  useEffect(() => {
    let disposed = false;
    void import("@/shared/lib/http-query").then(({ queryEventsHttp }) =>
      queryEventsHttp([{ kinds: [44011], "#d": [taskId], limit: 100 }])
        .then((events) => {
          if (disposed) return;
          setRows(
            events
              .map((e) => {
                try {
                  const body = JSON.parse(e.content) as {
                    status?: string;
                  };
                  return {
                    status: body.status ?? "",
                    at: e.created_at,
                    who: e.pubkey,
                  };
                } catch {
                  return null;
                }
              })
              .filter(
                (r): r is { status: string; at: number; who: string } => !!r,
              )
              .sort((a, b) => a.at - b.at),
          );
        })
        .catch((error: unknown) => {
          // Approval history is a background read; log rather than interrupt.
          console.warn("[work] approval history failed", error);
        }),
    );
    return () => {
      disposed = true;
    };
  }, [taskId]);

  // Hooks stay above the empty guard so the pane keeps a stable hook order as
  // rows arrive.
  // One batched kind-0 read for everyone who touched this task.
  const actors = useMemo(
    () => [...new Set(rows.map((row) => row.who))],
    [rows],
  );
  const userName = useUserNames(actors);

  if (rows.length === 0) return null;
  return (
    <div className="border-t border-black/10 pt-1.5 dark:border-white/10">
      <p className="text-2xs font-semibold uppercase tracking-wide text-black/60 dark:text-white/60">
        History
      </p>
      <ol className="mt-1 space-y-0.5 text-2xs text-black/55 dark:text-white/55">
        {rows.map((r) => (
          <li key={`${r.at}-${r.who.slice(0, 8)}`}>
            {new Date(r.at * 1000).toLocaleString()} —{" "}
            <span className="font-medium capitalize">{r.status}</span> ·{" "}
            {userName(r.who)}
          </li>
        ))}
      </ol>
    </div>
  );
}
