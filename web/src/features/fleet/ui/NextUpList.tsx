import { useMemo, useState } from "react";

import { nextUpOrder } from "../lib/task-planning";
import type { TaskPlanning } from "../use-task-planning";
import type { WorkItem } from "../use-work-board";
import { BackButton } from "./TaskPlanningPanel";

function dueLabel(due: number | null): string | null {
  if (due === null) return null;
  return `Due ${new Date(due).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

/**
 * "Next up": tasks nobody has started, most-backed first, then by priority
 * and due date. Backing is how the team — people with a track record counting
 * more — decides what to build next.
 */
export function NextUpList({
  items,
  planning,
  onOpen,
}: {
  items: readonly WorkItem[];
  planning: TaskPlanning;
  onOpen: (item: WorkItem) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const ordered = useMemo(
    () =>
      nextUpOrder(
        items.filter((item) => item.type === "task"),
        (item) => planning.supportOf(item).score,
      ),
    [items, planning],
  );

  return (
    <section
      aria-labelledby="next-up-heading"
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      data-testid="next-up"
    >
      <div>
        <h3 id="next-up-heading" className="text-sm font-semibold">
          Next up
        </h3>
        <p className="text-xs text-black/60 dark:text-white/60">
          Tasks nobody has started yet, most-backed first. Back the ones you
          think matter most — people with a track record count more.
        </p>
        {planning.error ? (
          <p
            className="mt-1 text-xs text-amber-700 dark:text-amber-300"
            role="status"
            data-testid="next-up-backing-error"
          >
            Couldn't load who backed what, so this list is ordered by priority
            and due date for now.
          </p>
        ) : null}
      </div>
      {ordered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-black/60 dark:border-white/15 dark:text-white/60">
          Nothing waiting. New tasks show up here until someone starts them.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5" data-testid="next-up-list">
          {ordered.map((item, index) => {
            const support = planning.supportOf(item);
            const due = dueLabel(item.due);
            return (
              <li
                key={item.key}
                className="flex items-start gap-3 rounded-lg border border-black/10 bg-white p-2.5 dark:border-white/10 dark:bg-white/5"
                data-testid="next-up-item"
              >
                <span className="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-black/50 dark:text-white/50">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onOpen(item)}
                    className="text-left text-sm font-medium hover:underline"
                  >
                    {item.title}
                  </button>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-black/60 dark:text-white/60">
                    {item.priority !== "normal" ? (
                      <span className="capitalize">
                        {item.priority} priority
                      </span>
                    ) : null}
                    {due ? <span>{due}</span> : null}
                    {item.milestone ? (
                      <span>Toward: {item.milestone}</span>
                    ) : null}
                    {item.reward !== null ? (
                      <span>Earns {item.reward} points</span>
                    ) : null}
                    <span data-testid="next-up-support">
                      {support.up === 0
                        ? "Not backed yet"
                        : `Backed by ${support.up}`}
                    </span>
                  </div>
                </div>
                <BackButton
                  item={item}
                  planning={planning}
                  busy={busyKey === item.key}
                  onBusy={(on) => setBusyKey(on ? item.key : null)}
                />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
