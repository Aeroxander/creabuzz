/**
 * "Your projects": the projects a person started, the ones they help (their tasks, the ones waiting on them first)
 * and the ones they follow. Each says when it last posted an update, how its promises stand, how many requests for
 * help are open, and what in it needs the person now.
 *
 * Nothing here is a price, an amount or a return: it is the record. Each number shows only when the read it rests on
 * reached its end; otherwise the card says it is not known. A read that fails says so, with a retry.
 */

import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { needAccountTo } from "@/features/identity/lib/account-copy";
import { notListedYet } from "@/features/launchpad/lib/listing";
import {
  type Need,
  needWords,
  orderNeeds,
  stateNeeds,
  taskNeeds,
} from "@/features/launchpad/lib/project-state";
import { promiseTotalsLine } from "@/features/launchpad/lib/promises";
import {
  dueLine,
  TASK_STATE_LABEL,
  type TaskView,
} from "@/features/launchpad/lib/tasks";
import {
  freshnessLine,
  streakLine,
  updateDueWords,
} from "@/features/launchpad/lib/weekly-update";
import {
  launchCoordinate,
  type LaunchRecord,
} from "@/features/launchpad/models";
import { NeedLink } from "@/features/launchpad/ui/NeedLink";
import {
  useMyProjects,
  useProjectState,
} from "@/features/launchpad/use-my-projects";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { SectionHeader } from "@/shared/ui/PageHeader";

/** How many cards a group shows before "Show more": each card reads its project. */
const SHOWN = 6;

const day = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** A person's own tasks in the order they should meet them: waiting on them first, then what they are waiting for. */
function myTasksInOrder(tasks: readonly TaskView[]): TaskView[] {
  const rank: Partial<Record<TaskView["state"], number>> = {
    offered: 0,
    "sent-back": 1,
    "in-progress": 2,
    submitted: 3,
  };
  return tasks
    .filter((task) => rank[task.state] !== undefined)
    .sort(
      (a, b) =>
        (rank[a.state] ?? 9) - (rank[b.state] ?? 9) ||
        Number(b.late) - Number(a.late) ||
        (a.id < b.id ? -1 : 1),
    );
}

function ProjectCard({
  record,
  tasks = [],
  invited = false,
  testId,
}: {
  record: LaunchRecord;
  /** The person's own tasks on this project. */
  tasks?: readonly TaskView[];
  /** The project added the person to its team and waits for their answer. */
  invited?: boolean;
  testId: string;
}) {
  const me = existingUserPubkey();
  const read = useProjectState(record);
  const state = read.data;
  const now = Math.floor(Date.now() / 1000);
  const coordinate = launchCoordinate(record.author, record.id);
  const due = state?.updatesKnown
    ? updateDueWords(state.lastUpdateAt, now)
    : null;
  const streak =
    state?.streak != null && state.streak >= 2
      ? streakLine(state.streak)
      : null;
  const needs: Need[] = orderNeeds([
    ...(state ? stateNeeds(state) : []),
    ...(me ? taskNeeds(tasks, me, now) : []),
    ...(invited ? [{ kind: "invitation", coordinate } as Need] : []),
  ]);
  const mine = myTasksInOrder(tasks);
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid={testId}>
      <div className="flex flex-wrap items-baseline gap-2">
        <Link
          className="min-w-0 truncate text-base font-semibold hover:underline"
          data-testid="your-project-name"
          params={{ launchId: record.id }}
          search={{ action: undefined, author: record.author }}
          to="/launchpad/$launchId"
        >
          {record.name}
        </Link>
        {notListedYet(record) ? (
          <span className="text-xs text-muted-foreground">Not listed yet</span>
        ) : null}
      </div>
      {read.isError && !state ? (
        <p className="text-sm" data-testid="your-project-failed" role="alert">
          Couldn't read how this project stands.{" "}
          <Button
            onClick={() => void read.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : !state ? (
        <p className="text-sm text-muted-foreground" role="status">
          Reading its record…
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Last update</dt>
          <dd>
            <span data-testid="your-project-update">
              {state.updatesKnown
                ? freshnessLine(state.lastUpdateAt, now)
                : "Not known: its updates could not all be read"}
            </span>
            {due ? (
              <span
                className={`ml-2 text-xs font-semibold ${due.late ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
                data-testid="your-project-due"
              >
                {due.text}
              </span>
            ) : null}
          </dd>
          {streak ? (
            <>
              <dt className="text-muted-foreground">Run</dt>
              <dd data-testid="your-project-streak">{streak}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Promises</dt>
          <dd data-testid="your-project-promises">
            {state.promises
              ? (promiseTotalsLine(state.promises) ?? "None answered yet")
              : "Not known: its updates could not all be read"}
          </dd>
          <dt className="text-muted-foreground">Help wanted</dt>
          <dd data-testid="your-project-help">
            {state.openHelp === null
              ? "Not known: its updates could not all be read"
              : state.openHelp === 0
                ? "No open requests"
                : state.openHelp === 1
                  ? "1 open request"
                  : `${state.openHelp} open requests`}
          </dd>
        </dl>
      )}
      {mine.length > 0 ? (
        <div>
          <h4 className="text-xs font-bold text-muted-foreground">
            Your tasks
          </h4>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {mine.map((task) => (
              <li
                className="break-words"
                data-state={task.state}
                data-testid="your-project-task"
                key={task.id}
              >
                <Link
                  className="underline-offset-2 hover:underline"
                  hash={`task-${task.id}`}
                  params={{ launchId: record.id }}
                  search={{ author: record.author }}
                  to="/launchpad/$launchId"
                >
                  {task.what}
                </Link>{" "}
                <span className="text-xs text-muted-foreground">
                  {TASK_STATE_LABEL[task.state]}
                  {dueLine(task, day) ? ` · ${dueLine(task, day)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <h4 className="text-xs font-bold text-muted-foreground">
          Needs you now
        </h4>
        {needs.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {needs.map((need) => {
              const words = needWords(need, record.name);
              return (
                <li
                  className="break-words"
                  data-kind={need.kind}
                  data-testid="your-project-need"
                  key={`${need.kind}:${"taskId" in need ? need.taskId : "updateId" in need ? need.updateId : ""}`}
                >
                  {words.text}{" "}
                  <NeedLink
                    className="font-medium underline"
                    need={need}
                    project={record}
                  >
                    {words.action}
                  </NeedLink>
                </li>
              );
            })}
          </ul>
        ) : (
          <p
            className="mt-1 text-sm text-muted-foreground"
            data-testid="your-project-no-needs"
          >
            {state?.tasksKnown && state.updatesKnown
              ? "Nothing right now."
              : state
                ? "Nothing found, but not all of its record could be read."
                : "Not known yet."}
          </p>
        )}
      </div>
    </Card>
  );
}

function Group({
  id,
  title,
  description,
  empty,
  children,
  count,
}: {
  id: string;
  title: string;
  description: string;
  /** Shown when the group has no project. */
  empty: ReactNode;
  count: number;
  children: (shown: number) => ReactNode;
}) {
  const [shown, setShown] = useState(SHOWN);
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-3"
      data-testid={id}
    >
      <SectionHeader
        description={description}
        title={<span id={`${id}-heading`}>{title}</span>}
      />
      {count === 0 ? (
        <p className="text-sm text-black/60 dark:text-white/60">{empty}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {children(shown)}
        </ul>
      )}
      {count > shown ? (
        <div>
          <Button
            onClick={() => setShown((n) => n + SHOWN)}
            size="sm"
            type="button"
            variant="outline"
          >
            Show more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function YourProjects() {
  const me = existingUserPubkey();
  const mine = useMyProjects();
  if (me === null)
    return (
      <p className="text-sm" data-testid="your-projects-signed-out">
        {needAccountTo(
          "see the projects you start, help and follow, and what needs you in each",
        )}
      </p>
    );
  if (mine.failed)
    return (
      <p className="text-sm" data-testid="your-projects-failed" role="alert">
        Couldn't read your projects.{" "}
        <Button onClick={mine.retry} size="sm" type="button" variant="outline">
          Try again
        </Button>
      </p>
    );
  if (!mine.data)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Reading your projects…
      </p>
    );
  const { started, helping, following, invitations } = mine.data;
  const tasksOn = (record: LaunchRecord) =>
    mine.myTasks.find(
      (entry) =>
        entry.coordinate === launchCoordinate(record.author, record.id),
    )?.tasks ?? [];
  const key = (record: LaunchRecord) => `${record.author}:${record.id}`;
  return (
    <div className="flex flex-col gap-8" data-testid="your-projects">
      {invitations.length > 0 ? (
        <Group
          count={invitations.length}
          description="Projects that added you to their team. Say yes or no on each project's page."
          empty={null}
          id="your-projects-invited"
          title="Waiting for your answer"
        >
          {(shown) =>
            invitations.slice(0, shown).map((record) => (
              <li key={key(record)}>
                <ProjectCard invited record={record} testId="your-project" />
              </li>
            ))
          }
        </Group>
      ) : null}
      <Group
        count={started.length}
        description="Each with its last update, how its promises stand, and what needs you."
        empty={
          <>
            You have not started a project.{" "}
            <Link className="underline" to="/start">
              Start one
            </Link>{" "}
            with four answers.
          </>
        }
        id="your-projects-started"
        title="Projects you started"
      >
        {(shown) =>
          started.slice(0, shown).map((record) => (
            <li key={key(record)}>
              <ProjectCard
                record={record}
                tasks={tasksOn(record)}
                testId="your-project"
              />
            </li>
          ))
        }
      </Group>
      <Group
        count={helping.length}
        description="Projects whose team you are on or that gave you a task. Tasks waiting on you come first."
        empty={
          <>
            You are not helping a project yet.{" "}
            <Link className="underline" to="/discover">
              Find one that asks for help
            </Link>
            .
          </>
        }
        id="your-projects-helping"
        title="Projects you help"
      >
        {(shown) =>
          helping.slice(0, shown).map(({ record, tasks }) => (
            <li key={key(record)}>
              <ProjectCard
                record={record}
                tasks={tasks}
                testId="your-project"
              />
            </li>
          ))
        }
      </Group>
      <Group
        count={following.length}
        description="Projects you follow, and how each is keeping its promises."
        empty={
          mine.followsFailed ? (
            <span data-testid="your-projects-follows-failed" role="alert">
              Couldn't read which projects you follow, so none are listed here.{" "}
              <Button
                onClick={mine.retryFollows}
                size="sm"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            </span>
          ) : (
            <>
              Follow a project to keep an eye on it here.{" "}
              <Link className="underline" to="/discover">
                Browse projects
              </Link>
            </>
          )
        }
        id="your-projects-following"
        title="Projects you follow"
      >
        {(shown) =>
          following.slice(0, shown).map((record) => (
            <li key={key(record)}>
              <ProjectCard record={record} testId="portfolio-followed" />
            </li>
          ))
        }
      </Group>
      {mine.cut && !mine.followsFailed ? (
        <p className="text-xs" data-testid="your-projects-cut" role="status">
          You have more projects, tasks or follows than could be read here, so
          some may be missing from these lists.
        </p>
      ) : null}
    </div>
  );
}
