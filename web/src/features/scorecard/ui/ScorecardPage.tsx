/**
 * A project's public scorecard: what it is for, how fresh and how steady its weekly record is, the promises it kept and
 * missed, the work it did, its latest update and who is on it. Made to be read signed out and shared. A visitor's
 * green button is Follow; the founder's is "Post this week's update", and neither Follow nor "I can help" is shown to
 * the people who are on the project.
 *
 * Every number is from records the project's own people signed, and the record line says so once when a read was not
 * complete. There is no price here. The "Backing" block (what is held for the project, what each milestone releases,
 * the next milestone and the date backers may leave by) sits between the work and the latest update when the build
 * offers backing, and is read only: its actions are on the project's page.
 */

import { Link, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ProjectMark } from "@/features/feed/ui/MovingNow";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";
import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { teamOf } from "@/features/launchpad/lib/help-request";
import {
  NOT_LISTED_LINE,
  notListedYet,
} from "@/features/launchpad/lib/listing";
import {
  firstUpdateDue,
  parseScorecardSlug,
  projectSharePath,
  shareWords,
} from "@/features/launchpad/lib/share";
import {
  cardVariantsFor,
  type ShareCardVariant,
} from "@/features/launchpad/lib/share-card";
import {
  acceptedByOthers,
  doneAlone,
} from "@/features/launchpad/lib/task-checks";
import { type Launch, launchCoordinate } from "@/features/launchpad/models";
import { BackingBlock } from "@/features/launchpad/ui/BackingBlock";
import { ProjectLoadError } from "@/features/launchpad/ui/ProjectLoadError";
import { ProjectRecordLine } from "@/features/launchpad/ui/ProjectRecordLine";
import { ShareCardPanel } from "@/features/launchpad/ui/ShareCardPanel";
import { useViewerIsAgent } from "@/features/launchpad/use-account-agent";
import { useProjectUpdates } from "@/features/launchpad/use-help-requests";
import { useLaunch } from "@/features/launchpad/use-launches";
import { useProjectState } from "@/features/launchpad/use-my-projects";
import { useProjectRecord } from "@/features/launchpad/use-project-record";
import { useUserNames } from "@/features/profiles/use-profiles";
import { APP_NAME } from "@/shared/constants/brand";
import { existingUserPubkey } from "@/shared/lib/identity";
import { usePageMeta } from "@/shared/lib/page-meta";
import { Button } from "@/shared/ui/button";

import {
  LatestUpdate,
  PromisesAnswered,
  ScorecardActions,
  WorkDone,
} from "./ScorecardWork";

/** How many team members the card shows. */
const TEAM_SHOWN = 8;

/** The button for each picture a record can back. */
const KIND_LABEL: Record<ShareCardVariant, string> = {
  started: "Just started",
  kept: "Promises kept",
  accepted: "Work accepted",
  done: "Work done",
};

function Scorecard({ launch }: { launch: Launch }) {
  const project = launch.record;
  const coordinate = launchCoordinate(project.author, project.id);
  const state = useProjectState(project);
  const { record, failed: recordFailed, retry } = useProjectRecord(project);
  const updates = useProjectUpdates(project);
  const follows = useLaunchFollows();
  const viewerIsAgent = useViewerIsAgent();
  const team = useMemo(() => [...teamOf(project)], [project]);
  const nameOf = useUserNames(team);
  const now = Math.floor(Date.now() / 1000);
  const viewer = existingUserPubkey();
  const isFounder = viewer === project.author;
  const onTeam = viewer !== null && team.includes(viewer);
  const s = state.data;
  const totals = s?.promises ?? null;
  const answered = totals ? totals.kept + totals.missed + totals.changed : null;
  const latest = useMemo(() => {
    const own = new Set(team);
    return (
      (updates.data?.updates ?? [])
        .filter((u) => own.has(u.author) && u.createdAt <= now)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    );
  }, [updates.data, team, now]);
  const streak = s?.streak ?? null;
  const followed = follows.followed.has(coordinate);
  const goal = record?.goals.primary?.text || project.pitch || "";
  // The picture and its sentence state only what the record shows: which of them it can back is worked out here.
  // Work someone else accepted and work the founder checked alone are two numbers and never added together.
  const accepted = s?.tasksKnown ? acceptedByOthers(s.tasks).length : null;
  const doneByFounder = s?.tasksKnown ? doneAlone(s.tasks).length : null;
  // Nothing posted, answered or accepted yet: a brand-new project says it just started, and no more.
  const fresh = Boolean(s?.updatesKnown && s.lastUpdateAt === null);
  const firstDue = fresh ? firstUpdateDue(project.startedAt, now) : null;
  const kinds = cardVariantsFor({
    answered,
    accepted,
    doneAlone: doneByFounder,
    fresh,
  });
  const [chosenKind, setChosenKind] = useState<ShareCardVariant | null>(null);
  const kind = chosenKind && kinds.includes(chosenKind) ? chosenKind : kinds[0];
  const kept = totals?.kept ?? null;
  const picture = useMemo(
    () => ({
      variant: kind,
      name: project.name,
      goal,
      app: APP_NAME,
      streak,
      kept,
      answered,
      accepted,
      doneAlone: doneByFounder,
      firstDue,
    }),
    [
      kind,
      project.name,
      goal,
      streak,
      kept,
      answered,
      accepted,
      doneByFounder,
      firstDue,
    ],
  );
  const words = shareWords({
    name: project.name,
    app: APP_NAME,
    streak,
    kept,
    answered,
    url: `${window.location.origin}${projectSharePath(project)}`,
    variant: kind,
    accepted,
    doneAlone: doneByFounder,
    firstDue,
  });

  usePageMeta({
    title: `${project.name} on ${APP_NAME}`,
    description: [
      goal,
      streak && streak >= 2 ? `${streak} weeks in a row.` : "",
      answered ? `${totals?.kept} of ${answered} promises kept.` : "",
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 200),
  });

  return (
    <article className="flex flex-col gap-5" data-testid="scorecard">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <ProjectMark image={project.image} name={project.name} />
          <h1 className="min-w-0 break-words text-2xl font-black">
            {project.name}
          </h1>
        </div>
        {goal ? (
          <p className="break-words text-base" data-testid="scorecard-goal">
            {goal}
          </p>
        ) : null}
        {notListedYet(project) ? (
          <p className="text-xs text-muted-foreground">{NOT_LISTED_LINE}</p>
        ) : null}
        <ScorecardActions
          followDisabled={
            existingUserPubkey() !== null && (!follows.ready || follows.pending)
          }
          followed={followed}
          isFounder={isFounder}
          launch={launch}
          onFollow={() => {
            if (existingUserPubkey() === null) {
              window.dispatchEvent(new Event(SIGN_UP_EVENT));
              return;
            }
            follows.toggle(coordinate);
          }}
          onTeam={onTeam}
          share={{
            answered,
            kept,
            streak,
            card: kind,
            accepted,
            doneAlone: doneByFounder,
            firstDue,
          }}
          viewerIsAgent={viewerIsAgent}
        />
      </header>

      {state.isError && !s ? (
        <p className="text-sm" data-testid="scorecard-failed" role="alert">
          Couldn't load this record.{" "}
          <Button
            onClick={() => void state.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : !s ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading the record...
        </p>
      ) : (
        <ProjectRecordLine
          launch={launch}
          viewerIsFounder={isFounder}
          withLink={false}
        />
      )}

      <PromisesAnswered
        failed={recordFailed}
        now={now}
        onRetry={retry}
        promises={record?.promises ?? null}
      />

      <WorkDone
        now={now}
        tasks={s?.tasksKnown ? s.tasks : null}
        viewerIsFounder={isFounder}
      />

      {/* Backing, when the build offers it: between the work and the latest update. Read only here. */}
      <BackingBlock isFounder={false} launch={launch} variant="scorecard" />

      <LatestUpdate
        complete={updates.data?.complete ?? false}
        failed={updates.isError && !updates.data}
        latest={latest}
        launch={launch}
        now={now}
        onRetry={() => void updates.refetch()}
        updates={updates.data?.updates ?? null}
      />

      <section
        aria-labelledby="scorecard-team-heading"
        className="flex flex-col gap-2"
      >
        <h2 className="text-base font-semibold" id="scorecard-team-heading">
          Team
        </h2>
        <ul className="flex flex-wrap gap-2" data-testid="scorecard-team">
          {team.slice(0, TEAM_SHOWN).map((pubkey) => (
            <li key={pubkey}>
              <Link
                className="inline-flex items-center rounded-full bg-foreground/[0.07] px-3 py-1 text-sm font-medium hover:bg-foreground/10 max-sm:min-h-11"
                params={{ pubkey }}
                to="/u/$pubkey"
              >
                {nameOf(pubkey)}
                {pubkey === project.author ? " · founder" : ""}
              </Link>
            </li>
          ))}
          {team.length > TEAM_SHOWN ? (
            <li className="px-1 py-1 text-sm text-muted-foreground">
              and {team.length - TEAM_SHOWN} more
            </li>
          ) : null}
        </ul>
      </section>

      {s ? (
        <section
          aria-labelledby="scorecard-share-heading"
          className="glass flex flex-col gap-3 rounded-2xl border p-4"
          data-testid="scorecard-share"
        >
          <h2 className="text-base font-semibold" id="scorecard-share-heading">
            Share this scorecard
          </h2>
          <p className="text-sm text-muted-foreground">
            A picture with the goal and what the record says, and a link to this
            page.
          </p>
          {kinds.length > 1 ? (
            <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
              <legend className="sr-only">What the picture shows</legend>
              {kinds.map((option) => (
                <Button
                  aria-pressed={kind === option}
                  className="max-sm:h-11"
                  data-testid={`scorecard-share-${option}`}
                  key={option}
                  onClick={() => setChosenKind(option)}
                  size="sm"
                  type="button"
                  variant={kind === option ? "secondary" : "outline"}
                >
                  {KIND_LABEL[option]}
                </Button>
              ))}
            </fieldset>
          ) : null}
          <ShareCardPanel
            card={picture}
            postToHome
            preview
            project={project}
            words={words}
          />
        </section>
      ) : null}

      <p>
        <Link
          className="inline-flex min-h-8 items-center text-sm font-semibold underline max-sm:min-h-11"
          data-testid="scorecard-full"
          params={{ launchId: project.id }}
          search={{ author: project.author }}
          to="/launchpad/$launchId"
        >
          Open the full project page
        </Link>
      </p>
    </article>
  );
}

export function ScorecardPage() {
  const { slug } = useParams({ from: "/p/$slug" });
  const named = parseScorecardSlug(slug);
  // The id alone first; when several founders use it, the one this address names.
  const first = useLaunch(named?.id, undefined);
  const chosen = first.launch
    ? undefined
    : first.several?.find((author) =>
        author.startsWith(named?.founderStart ?? "-"),
      );
  const second = useLaunch(chosen ? named?.id : undefined, chosen);
  const found = first.launch ?? second.launch;
  // Only the project whose founder the address names: the same id under another founder is another project.
  const launch =
    found && named && found.record.author.startsWith(named.founderStart)
      ? found
      : undefined;
  const loading = first.isLoading || (chosen !== undefined && second.isLoading);
  const error = launch ? null : (first.error ?? second.error);
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8"
      data-testid="scorecard-page"
    >
      {launch ? (
        <Scorecard launch={launch} />
      ) : !named ? (
        <p data-testid="scorecard-missing">
          This link doesn't name a project.{" "}
          <Link className="underline" to="/discover">
            See all projects
          </Link>
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          Opening the project…
        </p>
      ) : error ? (
        <ProjectLoadError
          error={error}
          onRetry={() => {
            void first.refetch();
            void second.refetch();
          }}
          testId="scorecard-load-failed"
        />
      ) : (
        <p data-testid="scorecard-missing">
          There is no project at this link. It may have been removed.{" "}
          <Link className="underline" to="/discover">
            See all projects
          </Link>
        </p>
      )}
    </div>
  );
}
