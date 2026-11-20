import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { ListChecks, Plus } from "lucide-react";
import { useState } from "react";
import { useAccount } from "../../lib/account";
import type { ProfileMetadata } from "../../lib/profiles";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { freshnessOf, isRunner, type ProjectNumbers } from "../money/numbers";
import { PLAY_MONEY_WORDS } from "../pot/pot-words";
import type { Project } from "../project/project-record";
import { AgentCaps } from "./AgentCaps";
import { PostTaskSheet } from "./PostTaskSheet";
import { TaskCard } from "./TaskCard";
import { nowOf } from "./chain/state";
import { CheckInLine } from "./chain/team/CheckInLine";
import { PlanOnlyCard } from "./chain/team/PlanOnlyCard";
import { type TabItem, orderTasks } from "./chain/team/tasks-order";
import { ageNoteOf, queueLine, tasksStaleWords } from "./chain/words";
import { teamOf, useProjectTasks } from "./use-tasks";

/**
 * The project's tasks: the team posts one with what it is and what it pays, someone outside the team takes it and hands
 * the work in, and a person on the team accepts it and pays in one press. Where the server keeps money off nothing
 * about money shows, and no task with pay can be posted.
 */
export function TasksTab({
  project,
  profiles,
  numbers,
  address,
}: {
  project: Project;
  profiles: Record<string, ProfileMetadata> | undefined;
  /** The project's numbers where money is on, else null. */
  numbers: ProjectNumbers | null;
  address: string | null;
}) {
  const { pubkey } = useAccount();
  const read = useProjectTasks(project);
  const [posting, setPosting] = useState(false);
  const team = teamOf(project);
  const onTeam = Boolean(pubkey && team.has(pubkey));
  const agents = read.data?.agents ?? new Set<string>();
  const operators = read.data?.operators ?? new Map<string, string>();
  // A person on the team posts; an agent account can, but the app offers it to people.
  const canPost = onTeam && numbers !== null && !(pubkey && agents.has(pubkey));
  const runner = numbers !== null && isRunner(numbers, address);

  const post = canPost ? (
    <>
      <Button
        block
        data-testid="task-new"
        onClick={() => setPosting(true)}
        variant="secondary"
      >
        <Plus aria-hidden="true" size={18} />
        Post a task
      </Button>
      <PostTaskSheet
        onOpenChange={setPosting}
        open={posting}
        project={project}
      />
    </>
  ) : null;

  if (read.isPending)
    return <Card className="h-24 animate-pulse" tone="plain" />;
  if (read.isError)
    return (
      <EmptyState
        action={
          <Button onClick={() => void read.refetch()} variant="secondary">
            Try again
          </Button>
        }
        title="Tasks could not be read"
      >
        {readFailureWords(read.error).text}
      </EmptyState>
    );
  const tasks = read.data.tasks;
  const taken = new Set(
    tasks.flatMap((t) => (t.paidTx ? [t.paidTx.toLowerCase()] : [])),
  );
  // The task queue (step 2) where the server's record carries one: plans first, then the other tasks, then plans that ended.
  const queue =
    numbers && typeof numbers.tasks === "object" && numbers.tasks
      ? numbers.tasks
      : null;
  const now = numbers && queue ? nowOf(numbers.asOf.time) : 0;
  const groups = queue
    ? orderTasks(queue, tasks)
    : {
        planned: [],
        others: tasks.map((task): TabItem => ({ kind: "task", task })),
        ended: [],
      };
  const age = numbers && queue ? ageNoteOf(numbers, now) : null;
  const stale =
    numbers && queue ? freshnessOf(numbers, now).level === "stale" : false;
  const card = (item: TabItem) =>
    item.kind === "task" ? (
      <li key={`task-${item.task.id}`}>
        <TaskCard
          address={address}
          agents={agents}
          me={pubkey}
          numbers={numbers}
          operators={operators}
          profiles={profiles}
          project={project}
          taken={taken}
          task={item.task}
          team={team}
        />
      </li>
    ) : numbers ? (
      <li key={`plan-${item.row.serial}`}>
        <PlanOnlyCard
          ageNote={age}
          now={now}
          row={item.row}
          windDownAt={numbers.windDown?.at ?? null}
        />
      </li>
    ) : null;
  const section = (title: string, items: TabItem[], testId: string) =>
    items.length === 0 ? null : (
      <section
        aria-label={title}
        className="flex flex-col gap-3"
        data-testid={testId}
      >
        <h2 className="text-sm font-semibold text-muted">{title}</h2>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map(card)}
        </ul>
      </section>
    );
  const none =
    groups.planned.length + groups.others.length + groups.ended.length === 0;
  const named = groups.planned.length > 0 || groups.ended.length > 0;
  return (
    <div className="flex flex-col gap-3" data-testid="project-tasks">
      {numbers && mustSayPlayMoney(numbers.playMoney) ? (
        <p className="text-sm text-muted" data-testid="tasks-play-money">
          {PLAY_MONEY_WORDS}
        </p>
      ) : null}
      {numbers && queueLine(numbers.tasks) ? (
        <p className="text-sm text-muted" data-testid="tasks-queue-line">
          {queueLine(numbers.tasks)}
        </p>
      ) : null}
      {numbers && stale ? (
        <p className="text-sm text-muted" data-testid="tasks-stale">
          {tasksStaleWords(numbers.asOf.time)}
        </p>
      ) : null}
      {onTeam && numbers && queue ? (
        <CheckInLine now={now} numbers={numbers} queue={queue} />
      ) : null}
      {post}
      {none ? (
        <EmptyState
          icon={<ListChecks size={28} />}
          testId="tasks-none"
          title="No tasks yet"
        >
          When the team needs a hand it posts a task here, and anyone can take
          it.
        </EmptyState>
      ) : (
        <>
          {section("Planned and running", groups.planned, "tasks-planned")}
          {groups.others.length === 0 ? null : named ? (
            section("Other tasks", groups.others, "tasks-others")
          ) : (
            <ul
              aria-label="Tasks"
              className="m-0 flex list-none flex-col gap-3 p-0"
            >
              {groups.others.map(card)}
            </ul>
          )}
          {section("Ended plans", groups.ended, "tasks-ended")}
        </>
      )}
      {read.data.complete ? null : (
        <p className="text-xs text-muted">
          Older tasks are not shown: this project has more than one read holds.
        </p>
      )}
      {runner && numbers ? <AgentCaps numbers={numbers} /> : null}
    </div>
  );
}
