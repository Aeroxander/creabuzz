/**
 * "Your work" on the Work page: every task you took on, with its four dated steps (offered, accepted, handed in,
 * checked) and one link to where you act on it. The read is the one behind your record; when it did not reach its
 * end the list says a task may be missing, and a failed read is said with a retry.
 */

import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";

import {
  dueLine,
  isOpenTask,
  TASK_STATE_LABEL,
} from "@/features/launchpad/lib/tasks";
import { HELP_SIZE_LABEL } from "@/features/launchpad/lib/weekly-update";
import { useTrackRecord } from "@/features/launchpad/use-tasks";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { SectionHeader } from "@/shared/ui/PageHeader";

import { myWork } from "../lib/my-work";

/** Tasks shown before "Show more". */
const SHOWN = 8;

const day = (at: number) =>
  new Date(at * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
const dueDay = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export function YourWork({ me }: { me: string }) {
  const read = useTrackRecord(me);
  const [shown, setShown] = useState(SHOWN);
  const items = useMemo(() => {
    if (!read.data) return null;
    return myWork({
      person: me,
      records: read.data.taskRecords,
      teams: new Map(
        Object.entries(read.data.teams).map(([coordinate, team]) => [
          coordinate,
          new Set(team),
        ]),
      ),
      now: Math.floor(Date.now() / 1000),
    });
  }, [read.data, me]);
  const partial =
    read.data && (!read.data.helperComplete || read.data.tooManyProjects);
  return (
    <section
      aria-labelledby="work-yours-heading"
      className="flex flex-col gap-3"
      data-testid="work-yours"
    >
      <SectionHeader
        description="Tasks you took on, step by step."
        title={<span id="work-yours-heading">Your work</span>}
      />
      {read.isError && !read.data ? (
        <p className="text-sm" data-testid="work-yours-failed" role="alert">
          Couldn't load your tasks.{" "}
          <Button
            onClick={() => void read.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : items === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading your tasks…
        </p>
      ) : items.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="work-yours-none"
        >
          {partial
            ? "No task found, but not all of your tasks could be read here."
            : "You haven't taken on a task yet. Offer to help on something below and it shows up here once you say yes."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.slice(0, shown).map(({ task, steps }) => {
            const project = read.data?.projects[task.coordinate];
            const due = isOpenTask(task) ? dueLine(task, dueDay) : null;
            return (
              <li
                data-state={task.state}
                data-testid="work-yours-item"
                key={task.id}
              >
                <Card className="flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                    <span className="font-bold">
                      {project?.name ?? "A project"}
                    </span>
                    <span
                      className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold text-primary-ink"
                      data-testid="work-yours-state"
                    >
                      {TASK_STATE_LABEL[task.state]}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {HELP_SIZE_LABEL[task.size]}
                      {due ? ` · ${due}` : ""}
                    </span>
                  </div>
                  <p className="break-words text-sm">{task.what}</p>
                  <p className="break-words text-xs text-muted-foreground">
                    Done means: {task.done}
                  </p>
                  <ol
                    aria-label="Steps so far"
                    className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                    data-testid="work-yours-steps"
                  >
                    {steps.map((step) => (
                      <li
                        className={`flex flex-col rounded-xl border px-2 py-1.5 text-xs ${
                          step.done
                            ? "border-primary/40 bg-primary/10"
                            : "border-dashed text-muted-foreground"
                        }`}
                        data-done={step.done}
                        data-step={step.id}
                        key={step.id}
                      >
                        <span className="flex items-center gap-1 font-semibold">
                          {step.done ? (
                            <Check aria-hidden className="h-3 w-3" />
                          ) : null}
                          {step.label}
                        </span>
                        <span>
                          {step.at !== null
                            ? day(step.at)
                            : step.done
                              ? "Done"
                              : "Not yet"}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {project ? (
                    <div>
                      <Link
                        aria-label={`Open task: ${task.what}`}
                        className="text-sm font-semibold underline"
                        data-testid="work-yours-open"
                        hash={`task-${task.id}`}
                        params={{ launchId: project.id }}
                        search={{ author: project.author }}
                        to="/launchpad/$launchId"
                      >
                        Open task
                      </Link>
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {items && items.length > shown ? (
        <div>
          <Button
            onClick={() => setShown((count) => count + SHOWN)}
            size="sm"
            type="button"
            variant="outline"
          >
            Show more
          </Button>
        </div>
      ) : null}
      {partial && items && items.length > 0 ? (
        <p className="text-xs" data-testid="work-yours-partial" role="status">
          Not all of your tasks could be read here, so one may be missing. Your
          profile has your whole record.
        </p>
      ) : null}
    </section>
  );
}
