/**
 * Task steps in Notifications: each step that needs the person or answers something they did. A task from their
 * offer, or one given to them to say yes to; work sent back or confirmed; more time asked or given; a task given up
 * or cancelled. Each opens the task on its project's page. Someone muted is left out, as everywhere on that page.
 */

import { Link } from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import { useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { cn } from "@/shared/lib/cn";
import { relativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";

import { noticeVerb } from "../lib/task-notices";
import { useTaskNotices } from "../use-tasks";

/** A task's words, short enough for one row. */
const short = (what: string) =>
  what.length > 120 ? `${what.slice(0, 117)}…` : what;

/** How many notices show at first, and how many more each press adds. */
const PAGE = 10;

export function TaskNoticesSection({
  visitSeenAt,
  muted,
}: {
  visitSeenAt: number;
  muted: ReadonlySet<string>;
}) {
  const { notices, cut } = useTaskNotices(muted);
  const names = useUserNames(notices.map((notice) => notice.actor));
  const [shown, setShown] = useState(PAGE);
  if (notices.length === 0 && !cut) return null;
  return (
    <section
      aria-label="Tasks"
      className="border-b border-black/10 dark:border-white/10"
      data-testid="social-task-notices"
    >
      <h2 className="flex items-center gap-2 px-4 pt-3 text-sm font-bold text-black dark:text-white">
        <ClipboardCheck aria-hidden className="h-4 w-4" /> Tasks
      </h2>
      <ul>
        {notices.slice(0, shown).map((notice) => {
          const words = `${names(notice.actor)} ${noticeVerb(notice)} ${short(notice.what)}`;
          return (
            <li
              className={cn(
                "relative px-4 py-3 text-sm transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]",
                notice.at > visitSeenAt && "bg-sky-500/5",
              )}
              data-part={notice.part}
              data-testid="social-task-notice"
              data-unread={notice.at > visitSeenAt ? "true" : undefined}
              key={notice.id}
            >
              <p className="break-words text-black dark:text-white">
                <span className="font-bold">{names(notice.actor)}</span>{" "}
                {noticeVerb(notice)} “{short(notice.what)}”
                <span className="text-black/60 dark:text-white/60">
                  {" "}
                  in {notice.project.name} · {relativeTime(notice.at)}
                </span>
              </p>
              {notice.note ? (
                <p className="mt-1 line-clamp-2 break-words text-black/60 dark:text-white/60">
                  {notice.note}
                </p>
              ) : null}
              <Link
                aria-label={`Open the task. ${words}`}
                className="absolute inset-0"
                hash={`task-${notice.taskId}`}
                params={{ launchId: notice.project.id }}
                search={{ author: notice.project.author }}
                to="/launchpad/$launchId"
              />
            </li>
          );
        })}
      </ul>
      {notices.length > shown ? (
        <div className="px-4 pb-3">
          <Button
            onClick={() => setShown((n) => n + PAGE)}
            size="sm"
            type="button"
            variant="outline"
          >
            Show more task notices
          </Button>
        </div>
      ) : null}
      {cut ? (
        <p
          className="px-4 pb-3 text-xs text-black/60 dark:text-white/60"
          data-testid="social-task-notices-cut"
          role="note"
        >
          There are more records naming you than could be read, so some task
          notices may be missing. Each project's page shows its tasks in full.
        </p>
      ) : null}
    </section>
  );
}
