import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { Banknote, ListChecks } from "lucide-react";
import { useState } from "react";
import { BackHeader } from "../../app/BackHeader";
import { useAccount } from "../../lib/account";
import { useFollowProject, useFollows } from "../../lib/follows";
import { nameOf, pictureOf, useProfiles } from "../../lib/profiles";
import { investingOn } from "../../lib/server";
import { useRequireAccount } from "../../lib/use-require-account";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { Tabs } from "../../ui/tabs";
import { useToast } from "../../ui/toast";
import { JoinBox } from "./JoinBox";
import { PeopleTab } from "./PeopleTab";
import type { Project } from "./project-record";
import { currentStage, StageLine } from "./StageLine";
import { UpdatesTab } from "./UpdatesTab";
import { projectPeople, useProject, useProjectActivity } from "./use-project";

/** The project page: its record, the stage line, Ask to join, then Updates, Tasks, People and Money. */
export function ProjectPage({ projectRef }: { projectRef: string }) {
  const project = useProject(projectRef);
  if (project.isPending)
    return (
      <main className="screen mx-auto flex max-w-lg flex-col gap-4">
        <BackHeader title="Project" />
        <Card className="h-48 animate-pulse" />
      </main>
    );
  if (project.isError || !project.data)
    return (
      <main className="screen mx-auto flex max-w-lg flex-col gap-4">
        <BackHeader title="Project" />
        <EmptyState
          action={
            project.isError ? (
              <Button
                onClick={() => void project.refetch()}
                variant="secondary"
              >
                Try again
              </Button>
            ) : null
          }
          testId="project-missing"
          title={
            project.isError
              ? "This project could not be read"
              : "This project is not here"
          }
        >
          {project.isError
            ? readFailureWords(project.error).text
            : "The link may be wrong, or its founder took the project down."}
        </EmptyState>
      </main>
    );
  return <ProjectView project={project.data} />;
}

function ProjectView({ project }: { project: Project }) {
  const { pubkey } = useAccount();
  const activity = useProjectActivity(project);
  const people = activity.data ? projectPeople(project, activity.data) : null;
  const accepted =
    people?.team.members.filter((m) => m.state === "accepted") ?? [];
  const onTeam = Boolean(pubkey && accepted.some((m) => m.pubkey === pubkey));
  const isFounder = pubkey === project.author;
  const [tab, setTab] = useState("updates");
  const investing = investingOn();
  const profiles = useProfiles([
    project.author,
    ...project.team.map((m) => m.pubkey),
    ...(activity.data?.asks.map((a) => a.author) ?? []),
    ...(activity.data?.updates.map((u) => u.author) ?? []),
  ]).data;
  const founderName = nameOf(profiles, project.author);

  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-5"
      data-testid="project-page"
    >
      <BackHeader
        action={<FollowButton coordinate={project.coordinate} />}
        title="Project"
      />
      <header className="flex flex-col gap-3">
        <h1 className="headline text-4xl" data-testid="project-name">
          {project.name}
        </h1>
        {project.pitch ? (
          <p className="text-lg text-muted">{project.pitch}</p>
        ) : null}
        <div className="flex items-center gap-2.5 text-sm">
          <Avatar
            name={founderName}
            picture={pictureOf(profiles, project.author)}
            pubkey={project.author}
            size="sm"
          />
          <span>
            Started by <span className="font-semibold">{founderName}</span>{" "}
            <span className="text-muted">
              {relativeTime(project.startedAt)}
            </span>
          </span>
        </div>
      </header>

      <StageLine investing={investing} stage={currentStage(accepted.length)} />

      <JoinBox activity={activity.data} onTeam={onTeam} project={project} />

      <Tabs
        items={[
          {
            value: "updates",
            label: "Updates",
            content: (
              <UpdatesTab
                activity={activity}
                canPost={isFounder || onTeam}
                profiles={profiles}
                project={project}
              />
            ),
          },
          {
            value: "tasks",
            label: "Tasks",
            soon: true,
            content: (
              <EmptyState
                icon={<ListChecks size={28} />}
                testId="tasks-placeholder"
                title="Tasks are coming"
              >
                Soon the team posts tasks here, anyone can take one, and the
                team accepts the work.
              </EmptyState>
            ),
          },
          {
            value: "people",
            label: "People",
            content: (
              <PeopleTab
                activity={activity.data}
                isFounder={isFounder}
                loading={activity.isPending}
                profiles={profiles}
                project={project}
              />
            ),
          },
          {
            value: "money",
            label: "Money",
            soon: true,
            content: <MoneyTab investing={investing} />,
          },
        ]}
        label={`${project.name} sections`}
        onValueChange={setTab}
        value={tab}
      />
    </main>
  );
}

/** Money is a placeholder in this part: what it will hold, and the ownership line wherever money is offered. */
function MoneyTab({ investing }: { investing: boolean }) {
  if (!investing)
    return (
      <EmptyState
        icon={<Banknote size={28} />}
        testId="money-off"
        title="No money on this server"
      >
        This server does not offer backing, so projects here have no money to
        show.
      </EmptyState>
    );
  return (
    <EmptyState
      icon={<Banknote size={28} />}
      testId="money-placeholder"
      title="Backing shows here"
    >
      <p>
        Rounds, what was paid in and what can still be taken back show here once
        the server reads them from the network.
      </p>
      <p className="mt-3">
        Buyers acquire ownership only: governance and exit. No dividends or
        revenue share, ever, unless they contribute and earn one.
      </p>
    </EmptyState>
  );
}

function FollowButton({ coordinate }: { coordinate: string }) {
  const follows = useFollows().data;
  const follow = useFollowProject();
  const requireAccount = useRequireAccount();
  const toast = useToast();
  const following = follows?.projects.has(coordinate) ?? false;
  return (
    <Button
      aria-pressed={following}
      data-testid="project-follow"
      disabled={follow.isPending}
      onClick={() =>
        requireAccount(() =>
          follow.mutate(
            { coordinate, follow: !following },
            { onError: (error) => toast(error.message, "problem") },
          ),
        )
      }
      size="sm"
      variant="secondary"
    >
      {following ? "Following" : "Follow"}
    </Button>
  );
}
