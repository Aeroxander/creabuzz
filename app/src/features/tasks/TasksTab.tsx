import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { ListChecks, Plus } from "lucide-react";
import { useState } from "react";
import { useAccount } from "../../lib/account";
import type { ProfileMetadata } from "../../lib/profiles";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { isRunner, type ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";
import { AgentCaps } from "./AgentCaps";
import { PostTaskSheet } from "./PostTaskSheet";
import { TaskCard } from "./TaskCard";
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
  return (
    <div className="flex flex-col gap-3" data-testid="project-tasks">
      {post}
      {tasks.length === 0 ? (
        <EmptyState
          icon={<ListChecks size={28} />}
          testId="tasks-none"
          title="No tasks yet"
        >
          When the team needs a hand it posts a task here, and anyone can take
          it.
        </EmptyState>
      ) : (
        tasks.map((task) => (
          <TaskCard
            address={address}
            agents={agents}
            key={task.id}
            me={pubkey}
            numbers={numbers}
            operators={operators}
            profiles={profiles}
            project={project}
            task={task}
            team={team}
          />
        ))
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
