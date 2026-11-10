/**
 * A project's open tasks: who each is with, what it is, what "done" means, how it stands, and when it is due. A late
 * task shows as late, at the top; it is never hidden. Finished and closed tasks are on the record card below.
 *
 * The team can also give someone a task directly. That person is named on it only once they say yes.
 *
 * Tasks are read for this project on their own (`useProjectTasks`). A read that fails says so, with a way to read
 * again; one that was cut short says a task or a step may be missing. An empty list is shown only for a finished read.
 */

import { useMemo, useRef, useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { PersonSearch } from "@/features/social/ui/PersonSearch";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import { teamOf } from "../lib/help-request";
import { openTasks } from "../lib/tasks";
import type { Launch } from "../models";
import { useProjectTasks, useTaskActions } from "../use-tasks";
import { TaskForm } from "./TaskForm";
import { TaskRow } from "./TaskRow";

/** How many open tasks show at first, and how many more each press adds. */
const PAGE = 10;

/** The team's "Give someone a task": pick who (or yourself), then the task's words and its finish line. */
function DirectTask({
  launch,
  me,
  onDone,
  onCancel,
}: {
  launch: Launch;
  me: string;
  onDone: (said: string) => void;
  onCancel: () => void;
}) {
  const { make } = useTaskActions(launch.record);
  const [helper, setHelper] = useState<string | null>(null);
  const names = useUserNames(helper ? [helper] : []);
  return (
    <TaskForm
      blocked={helper ? null : "Pick who the task is for."}
      busy={make.isPending}
      failed={make.isError ? "The task was not made." : null}
      onCancel={onCancel}
      onSend={(draft) => {
        if (!helper) return;
        make.mutate(
          { helper, ...draft },
          {
            onSuccess: (sent) =>
              onDone(
                sent.adopted && sent.changed
                  ? "An earlier try had already gone through, so that task was saved as it was then. If you meant a different task, make it again."
                  : helper === me
                    ? "Task made. Someone else on the team checks it when you hand it in."
                    : `Task made. It is ${names(helper)}'s once they say yes.`,
              ),
          },
        );
      }}
      testId="direct-task-form"
      title="Give someone a task"
    >
      <div className="mb-2" data-testid="direct-task-who">
        {helper ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              For{" "}
              <span className="font-semibold">
                {helper === me ? "you" : names(helper)}
              </span>
            </span>
            <Button
              onClick={() => setHelper(null)}
              size="sm"
              type="button"
              variant="outline"
            >
              Change
            </Button>
          </p>
        ) : (
          <>
            <p className="text-sm font-medium" id="direct-task-who-label">
              Who is it for
            </p>
            <p className="text-xs text-muted-foreground">
              They are named on the task only once they say yes.
            </p>
            <div className="mt-1">
              <PersonSearch
                inputId="direct-task-person"
                inputTestId="direct-task-person"
                label="Who is the task for"
                me={me}
                onPick={setHelper}
              />
            </div>
            <Button
              className="mt-1"
              onClick={() => setHelper(me)}
              size="sm"
              type="button"
              variant="outline"
            >
              I'll do it myself
            </Button>
          </>
        )}
      </div>
    </TaskForm>
  );
}

export function ProjectTasksCard({ launch }: { launch: Launch }) {
  const me = existingUserPubkey();
  const { record } = launch;
  const team = useMemo(() => teamOf(record), [record]);
  const read = useProjectTasks(record);
  const { tasks } = read;
  const open = useMemo(() => (tasks ? openTasks(tasks) : []), [tasks]);
  const [shown, setShown] = useState(PAGE);
  const [giving, setGiving] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const names = useUserNames(
    open.flatMap((task) => [
      task.helper,
      task.madeBy,
      ...(task.helperAgent?.owner ? [task.helperAgent.owner] : []),
      ...task.evidence.flatMap((piece) =>
        [...piece.sentBack, ...piece.confirmed].map((a) => a.by),
      ),
      ...task.moreTime.flatMap((ask) => (ask.granted ? [ask.granted.by] : [])),
    ]),
  );
  const onTeam = me !== null && team.has(me);
  // Said in the card and focused there: the row a step was taken on may have left the list.
  const say = (text: string) => {
    setSaid(text);
    section.current?.focus();
  };

  if (!read.tasks) {
    if (!read.failed) return null;
    return (
      <section
        aria-label="Tasks"
        className="glass rounded-2xl border p-4"
        data-testid="project-tasks"
      >
        <p className="text-sm" data-testid="tasks-read-failed" role="alert">
          Couldn't read this project's tasks.{" "}
          <Button
            onClick={read.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      </section>
    );
  }
  // Nothing open, and nobody here who could make one: the section would only be a heading.
  if (open.length === 0 && !onTeam && read.complete && !said) return null;

  return (
    <section
      aria-labelledby="project-tasks-heading"
      className="glass rounded-2xl border p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="project-tasks"
      ref={section}
      tabIndex={-1}
    >
      <h2 className="text-sm font-bold" id="project-tasks-heading">
        Tasks
      </h2>
      <p className="text-xs text-muted-foreground">
        Work with a finish line: “Done means” is written before anyone starts,
        and someone other than the person who did the work checks it.
      </p>
      {said ? (
        <p className="mt-2 text-sm" data-testid="tasks-said" role="status">
          {said}
        </p>
      ) : null}
      {read.complete ? null : (
        <p className="mt-2 text-sm" data-testid="tasks-read-cut" role="status">
          This project has more task records than could be read here, so a task
          or a step on one may be missing below.{" "}
          <Button
            onClick={read.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      )}
      {read.stale ? (
        <p className="mt-2 text-sm" role="status">
          Couldn't check for newer tasks.{" "}
          <Button
            onClick={read.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : null}
      {open.length === 0 ? (
        read.complete ? (
          <p
            className="mt-2 text-sm text-muted-foreground"
            data-testid="tasks-empty"
          >
            No open tasks. Accept an offer on a help request to make one, or
            give someone a task.
          </p>
        ) : null
      ) : (
        <ul className="mt-3 flex flex-col gap-3" data-testid="open-tasks">
          {open.slice(0, shown).map((task) => (
            <TaskRow
              key={task.id}
              launch={launch}
              names={names}
              onSaid={say}
              task={task}
              team={team}
              viewer={me}
            />
          ))}
        </ul>
      )}
      {open.length > shown ? (
        <Button
          className="mt-2"
          onClick={() => setShown((n) => n + PAGE)}
          size="sm"
          type="button"
          variant="outline"
        >
          Show more tasks
        </Button>
      ) : null}
      {onTeam && me ? (
        giving ? (
          <DirectTask
            launch={launch}
            me={me}
            onCancel={() => setGiving(false)}
            onDone={(text) => {
              setGiving(false);
              say(text);
            }}
          />
        ) : (
          <Button
            className="mt-3"
            data-testid="give-task"
            onClick={() => {
              setSaid(null);
              setGiving(true);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Give someone a task
          </Button>
        )
      ) : null}
    </section>
  );
}
