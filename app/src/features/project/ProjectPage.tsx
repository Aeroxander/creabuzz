import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { ListChecks } from "lucide-react";
import { lazy, Suspense, useState } from "react";
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
import { BackBox } from "../money/BackBox";
import { MoneyTab } from "../money/MoneyTab";
import { anyRoundUnclosed, openRound } from "../money/numbers";
import { OpenBacking } from "../money/OpenBacking";
import {
  chainKeyOfProject,
  useProjectNumbers,
  useWalletAddress,
} from "../money/use-money";
import { JoinBox } from "./JoinBox";
import { PeopleTab } from "./PeopleTab";
import type { Project } from "./project-record";
import { currentStage, StageLine } from "./StageLine";
import { UpdatesTab } from "./UpdatesTab";
import { projectPeople, useProject, useProjectActivity } from "./use-project";

// Team and the market (milestone 7) load only when a project has numbers, so the first download stays small.
const TeamMoney = lazy(() =>
  import("../team/TeamMoney").then((m) => ({ default: m.TeamMoney })),
);
const TeamTop = lazy(() =>
  import("../team/TeamTop").then((m) => ({ default: m.TeamTop })),
);
const LaunchProject = lazy(() =>
  import("../team/LaunchProject").then((m) => ({ default: m.LaunchProject })),
);
const MemberActions = lazy(() =>
  import("../team/MemberActions").then((m) => ({ default: m.MemberActions })),
);

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
  // Money only where the server turns investing on: with it off the numbers are never even asked for.
  const numbersRead = useProjectNumbers(investing ? project : null);
  const numbers =
    investing && numbersRead.data && !numbersRead.data.removed
      ? numbersRead.data
      : null;
  const now = Math.floor(Date.now() / 1000);
  const round = numbers ? openRound(numbers, now) : null;
  const money = numbers
    ? { stage: numbers.stage.name, raised: numbers.raised.total }
    : null;
  const walletAddress = useWalletAddress().data ?? null;
  // Offered to the founder while no round is open or waiting to be closed, at Solo and Backed; who may press is the wallet
  // that runs it (OpenBacking says so). At Team the Pair's signers open a round from the Money tab (TeamMoney), both
  // signing.
  const canOpen =
    numbers !== null &&
    isFounder &&
    !anyRoundUnclosed(numbers) &&
    numbers.raised.left > 0n &&
    !numbers.clock.woundDown &&
    ["solo", "backed"].includes(numbers.stage.name);

  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-5"
      data-testid="project-page"
    >
      <BackHeader
        action={<FollowButton coordinate={project.coordinate} />}
        heading={false}
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

      <StageLine
        investing={investing}
        money={money}
        stage={currentStage(accepted.length, money)}
      />

      {numbers && round ? (
        <BackBox
          now={now}
          numbers={numbers}
          primary
          projectName={project.name}
          round={round}
        />
      ) : null}
      {numbers && canOpen ? (
        <OpenBacking address={walletAddress} numbers={numbers} />
      ) : null}
      {numbers ? (
        <Suspense fallback={null}>
          <TeamTop
            founder={project.author}
            numbers={numbers}
            profiles={profiles}
            team={[project.author, ...accepted.map((m) => m.pubkey)]}
          />
        </Suspense>
      ) : null}

      <JoinBox
        activity={activity.data}
        onTeam={onTeam}
        project={project}
        secondary={round !== null}
      />

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
                memberAction={
                  numbers
                    ? (member, name) => (
                        <Suspense fallback={null}>
                          <MemberActions
                            name={name}
                            numbers={numbers}
                            pubkey={member}
                            team={accepted.map((m) => m.pubkey)}
                          />
                        </Suspense>
                      )
                    : undefined
                }
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
                    <div className="flex flex-col gap-3">
                      {isFounder && !chainKeyOfProject(project) ? (
                        <Suspense fallback={null}>
                          <LaunchProject project={project} />
                        </Suspense>
                      ) : null}
                      {numbers ? (
                        <Suspense fallback={null}>
                          <TeamMoney
                            numbers={numbers}
                            profiles={profiles}
                            team={[
                              project.author,
                              ...accepted.map((m) => m.pubkey),
                            ]}
                          />
                        </Suspense>
                      ) : null}
                      <MoneyTab
                        error={numbersRead.error}
                        loading={
                          numbersRead.isPending &&
                          numbersRead.fetchStatus !== "idle"
                        }
                        now={now}
                        numbers={numbersRead.data}
                        onRetry={() => void numbersRead.refetch()}
                      />
                    </div>
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
