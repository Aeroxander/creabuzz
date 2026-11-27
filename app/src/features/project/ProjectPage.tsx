import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { lazy, Suspense, useState } from "react";
import { BackHeader } from "../../app/BackHeader";
import { useAccount } from "../../lib/account";
import { useFollowProject, useFollows } from "../../lib/follows";
import { nameOf, pictureOf, useProfiles } from "../../lib/profiles";
import { investingOn } from "../../lib/server";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { ChunkBoundary } from "../../ui/chunk-boundary";
import { EmptyState } from "../../ui/empty-state";
import { Tabs } from "../../ui/tabs";
import { useToast } from "../../ui/toast";
import {
  chainKeyOfProject,
  useProjectNumbers,
  useWalletAddress,
} from "../money/use-money";
import { useMarkProjectSeen } from "../alerts/use-news";
import { ProjectFeed } from "../feed/ProjectFeed";
import { useRoomNews } from "../room/use-room-news";
import { PlannedStrips } from "../tasks/chain/holder/PlannedStrips";
import { JoinBox } from "./JoinBox";
import { PeopleTab } from "./PeopleTab";
import type { Project } from "./project-record";
import { ProjectTop } from "./ProjectTop";
import { UpdatesTab } from "./UpdatesTab";
import { projectPeople, useProject, useProjectActivity } from "./use-project";

// The Tasks tab carries the money calls (paying a task, an agent's limits) and their contract ABIs: it loads when the tab
// is opened, so the first download stays small.
const TasksTab = lazy(() =>
  import("../tasks/TasksTab").then((m) => ({ default: m.TasksTab })),
);
// The Money tab carries the money calls and their contract ABIs: it loads when the page does not need it yet.
const ProjectMoney = lazy(() =>
  import("../pot/ProjectMoney").then((m) => ({ default: m.ProjectMoney })),
);
// Opening a project to backers carries the launch call and the contract ABIs: it loads only for a founder who has not launched.
const LaunchCard = lazy(() =>
  import("../launch/LaunchCard").then((m) => ({ default: m.LaunchCard })),
);
// The room carries the writing, the report, the team's tools and perks: it loads when its tab is opened.
// The project's notes: loaded only where there is a project page, and the git library only when a person opens them.
const BrainRow = lazy(() => import("../brain/BrainRow"));
const RoomTab = lazy(() =>
  import("../room/RoomTab").then((m) => ({ default: m.RoomTab })),
);

/** The project page: its top (what it is, its money, Back, Share), Ask to join, then Updates, Tasks, People, Money and Room. */
export function ProjectPage({
  projectRef,
  initialTab,
  brainSetup = false,
}: {
  projectRef: string;
  /** The tab to open on, when the link names one (the news on You opens Money). */
  initialTab?: "money";
  /** Open the steps for keeping a project brain on arrival (a founder who said yes to it in Start). */
  brainSetup?: boolean;
}) {
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
  return (
    <ProjectView
      brainSetup={brainSetup}
      initialTab={initialTab}
      project={project.data}
    />
  );
}

function ProjectView({
  project,
  initialTab,
  brainSetup,
}: {
  project: Project;
  initialTab?: "money";
  brainSetup: boolean;
}) {
  const { pubkey } = useAccount();
  const activity = useProjectActivity(project);
  const people = activity.data ? projectPeople(project, activity.data) : null;
  const accepted =
    people?.team.members.filter((m) => m.state === "accepted") ?? [];
  const onTeam = Boolean(pubkey && accepted.some((m) => m.pubkey === pubkey));
  const isFounder = pubkey === project.author;
  const [tab, setTab] = useState(
    initialTab === "money" && investingOn() ? "money" : "updates",
  );
  const investing = investingOn();
  const profiles = useProfiles([
    project.author,
    ...project.team.map((m) => m.pubkey),
    ...(activity.data?.asks.map((a) => a.author) ?? []),
    ...(activity.data?.updates.map((u) => u.author) ?? []),
  ]).data;
  const founderName = nameOf(profiles, project.author);
  // Money only where the server turns investing on: with it off the numbers are never even asked for.
  const numbersRead = useProjectNumbers(investing ? project : null);
  const numbers =
    investing && numbersRead.data && !numbersRead.data.removed
      ? numbersRead.data
      : null;
  const now = Math.floor(Date.now() / 1000);
  const walletAddress = useWalletAddress().data ?? null;
  // The strips below are this project's news: opening the page reads it.
  useMarkProjectSeen(numbers, walletAddress);
  const roomNews = useRoomNews(project, investing, activity.data);
  const team = [project.author, ...accepted.map((m) => m.pubkey)];
  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-4"
      data-testid="project-page"
    >
      <BackHeader
        action={<FollowButton coordinate={project.coordinate} />}
        heading={false}
        title="Project"
      />
      <ProjectTop
        founderName={founderName}
        founderPicture={pictureOf(profiles, project.author)}
        investing={investing}
        now={now}
        numbers={numbers}
        project={project}
      />

      {investing && isFounder && !chainKeyOfProject(project) ? (
        <Suspense fallback={<Card className="h-24 animate-pulse" />}>
          <LaunchCard onLaunched={() => setTab("money")} project={project} />
        </Suspense>
      ) : null}

      <JoinBox
        activity={activity.data}
        onTeam={onTeam}
        project={project}
        secondary={false}
      />

      {/* Money is about to move for a planned task: every reader sees who gets how much at most, and from when. */}
      {investing && numbers ? (
        <PlannedStrips
          address={walletAddress}
          numbers={numbers}
          onOpenMoney={() => setTab("money")}
          onOpenTasks={() => setTab("tasks")}
          project={project}
        />
      ) : null}

      <ProjectFeed numbers={numbers} project={project} />

      <Suspense fallback={null}>
        <BrainRow
          isFounder={isFounder}
          project={project}
          setupOpen={brainSetup && isFounder}
        />
      </Suspense>

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
            content: (
              <ChunkBoundary>
                <Suspense fallback={<Card className="h-24 animate-pulse" />}>
                  <TasksTab
                    address={walletAddress}
                    numbers={numbers}
                    profiles={profiles}
                    project={project}
                  />
                </Suspense>
              </ChunkBoundary>
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
          // Money exists only where the server turns investing on: nothing set, nothing shown.
          ...(investing
            ? [
                {
                  value: "money",
                  label: "Money",
                  content: (
                    <ChunkBoundary>
                      <Suspense
                        fallback={<Card className="h-40 animate-pulse" />}
                      >
                        <ProjectMoney
                          chainKey={chainKeyOfProject(project)}
                          error={numbersRead.error}
                          loading={
                            numbersRead.isPending &&
                            numbersRead.fetchStatus !== "idle"
                          }
                          now={now}
                          numbers={numbersRead.data}
                          onRetry={() => void numbersRead.refetch()}
                          profiles={profiles}
                          project={project}
                          projectName={project.name}
                          team={team}
                        />
                      </Suspense>
                    </ChunkBoundary>
                  ),
                },
              ]
            : []),
          // The room is the holders' place under a project that is launched: it needs the server's chain reader.
          ...(investing && chainKeyOfProject(project)
            ? [
                {
                  value: "room",
                  label: "Room",
                  news: roomNews && tab !== "room",
                  content: (
                    <ChunkBoundary>
                      <Suspense
                        fallback={<Card className="h-24 animate-pulse" />}
                      >
                        <RoomTab
                          numbers={numbers}
                          profiles={profiles}
                          project={project}
                          team={team}
                        />
                      </Suspense>
                    </ChunkBoundary>
                  ),
                },
              ]
            : []),
        ]}
        label={`${project.name} sections`}
        onValueChange={setTab}
        value={tab}
      />
    </main>
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
