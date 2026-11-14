/**
 * A project's public scorecard: what it is for, how many weeks in a row it has posted, which promises it kept,
 * missed or changed, its latest update, what help it wants and who is on it. Made to be read signed out and shared;
 * Follow and "I can help" are the two things to do.
 *
 * Every number is from records the project's own people signed, and each says so when its read was not complete.
 * There is no price here. The "Backing" block (what is held for the project, what each milestone releases, the next
 * milestone and the date backers may leave by) sits between the record and the latest update when the build offers
 * backing, and is read only: its actions are on the project's page.
 */

import { Link, useParams } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";

import { ProjectMark } from "@/features/feed/ui/MovingNow";
import { useLaunchFollows } from "@/features/feed/use-launch-follows";
import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { teamOf } from "@/features/launchpad/lib/help-request";
import {
  NOT_LISTED_LINE,
  notListedYet,
} from "@/features/launchpad/lib/listing";
import {
  PROMISE_STATE_LABEL,
  type PromiseState,
} from "@/features/launchpad/lib/promises";
import { parseScorecardSlug } from "@/features/launchpad/lib/share";
import {
  freshnessLine,
  updateDueWords,
} from "@/features/launchpad/lib/weekly-update";
import { type Launch, launchCoordinate } from "@/features/launchpad/models";
import { BackingBlock } from "@/features/launchpad/ui/BackingBlock";
import { ShareRecordButton } from "@/features/launchpad/ui/ShareRecordButton";
import { useProjectUpdates } from "@/features/launchpad/use-help-requests";
import { useLaunch } from "@/features/launchpad/use-launches";
import { useProjectState } from "@/features/launchpad/use-my-projects";
import { useProjectRecord } from "@/features/launchpad/use-project-record";
import { useUserNames } from "@/features/profiles/use-profiles";
import { APP_NAME } from "@/shared/constants/brand";
import { existingUserPubkey } from "@/shared/lib/identity";
import { usePageMeta } from "@/shared/lib/page-meta";
import { Button } from "@/shared/ui/button";
import { Chip, type ChipTone } from "@/shared/ui/chip";

const ANSWERED: readonly PromiseState[] = ["kept", "missed", "changed"];
const TONE: Partial<Record<PromiseState, ChipTone>> = {
  kept: "success",
  missed: "danger",
  changed: "warning",
};
/** How many answered promises and team members the card shows. */
const PROMISES_SHOWN = 5;
const TEAM_SHOWN = 8;

function Fact({
  label,
  value,
  testId,
}: {
  label: string;
  value: ReactNode;
  testId: string;
}) {
  return (
    <div className="glass flex min-w-0 flex-col rounded-2xl border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-base font-bold" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function Scorecard({ launch }: { launch: Launch }) {
  const project = launch.record;
  const coordinate = launchCoordinate(project.author, project.id);
  const state = useProjectState(project);
  const { record, failed: recordFailed, retry } = useProjectRecord(project);
  const updates = useProjectUpdates(project);
  const follows = useLaunchFollows();
  const team = useMemo(() => [...teamOf(project)], [project]);
  const nameOf = useUserNames(team);
  const now = Math.floor(Date.now() / 1000);
  const s = state.data;
  const totals = s?.promises ?? null;
  const answered = totals ? totals.kept + totals.missed + totals.changed : null;
  const lastFive = useMemo(
    () =>
      (record?.promises ?? [])
        .filter((promise) => ANSWERED.includes(promise.state))
        .sort(
          (a, b) =>
            Math.min(b.answeredAt ?? 0, now) -
              Math.min(a.answeredAt ?? 0, now) || (a.id < b.id ? -1 : 1),
        )
        .slice(0, PROMISES_SHOWN),
    [record, now],
  );
  const latest = useMemo(() => {
    const own = new Set(team);
    return (
      (updates.data?.updates ?? [])
        .filter((u) => own.has(u.author) && u.createdAt <= now)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    );
  }, [updates.data, team, now]);
  const streak = s?.streak ?? null;
  const due = s?.updatesKnown ? updateDueWords(s.lastUpdateAt, now) : null;
  const followed = follows.followed.has(coordinate);
  const goal = record?.goals.primary?.text || project.pitch || "";

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
        <div className="flex flex-wrap items-start gap-2">
          <Button
            aria-pressed={followed}
            className="max-sm:h-11"
            data-testid="scorecard-follow"
            disabled={
              existingUserPubkey() !== null &&
              (!follows.ready || follows.pending)
            }
            onClick={() => {
              if (existingUserPubkey() === null) {
                window.dispatchEvent(new Event(SIGN_UP_EVENT));
                return;
              }
              follows.toggle(coordinate);
            }}
            type="button"
            variant={followed ? "outline" : "default"}
          >
            {followed ? "Following" : "Follow"}
          </Button>
          <Button asChild className="max-sm:h-11">
            <Link
              data-testid="scorecard-help"
              params={{ launchId: project.id }}
              search={{ author: project.author, tab: "updates" }}
              to="/launchpad/$launchId"
            >
              I can help
            </Link>
          </Button>
          <ShareRecordButton
            answered={answered}
            kept={totals?.kept ?? null}
            label="Share"
            project={project}
            streak={streak}
            variant="outline"
          />
        </div>
      </header>

      {state.isError && !s ? (
        <p className="text-sm" data-testid="scorecard-failed" role="alert">
          Couldn't read this project's record.{" "}
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
          Reading its record…
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Fact
            label="Weekly updates"
            testId="scorecard-streak"
            value={
              streak === null
                ? "Not known"
                : streak >= 2
                  ? `${streak} weeks in a row`
                  : streak === 1
                    ? "1 week so far"
                    : "No run yet"
            }
          />
          <Fact
            label="Promises kept"
            testId="scorecard-kept"
            value={
              totals === null
                ? "Not known"
                : answered
                  ? `${totals.kept} of ${answered}`
                  : "None answered yet"
            }
          />
          <Fact
            label="Not kept"
            testId="scorecard-missed"
            value={
              totals === null ? (
                "Not known"
              ) : (
                <>
                  <span className="block">{totals.missed} missed</span>
                  <span className="hidden"> · </span>
                  <span className="block">{totals.changed} changed</span>
                </>
              )
            }
          />
          <Fact
            label="Help wanted"
            testId="scorecard-open-help"
            value={
              s.openHelp === null
                ? "Not known"
                : s.openHelp === 0
                  ? "Nothing open"
                  : s.openHelp === 1
                    ? "1 open request"
                    : `${s.openHelp} open requests`
            }
          />
        </dl>
      )}
      {s && (!s.updatesKnown || s.promises === null) ? (
        <p className="text-xs" data-testid="scorecard-partial" role="status">
          Not all of this project's records could be read here, so a number that
          could not be worked out says "Not known".
        </p>
      ) : null}

      <section
        aria-labelledby="scorecard-promises-heading"
        className="flex flex-col gap-2"
      >
        <h2 className="text-base font-semibold" id="scorecard-promises-heading">
          Last promises answered
        </h2>
        {recordFailed ? (
          <p className="text-sm" role="alert">
            Couldn't read the promises.{" "}
            <Button onClick={retry} size="sm" type="button" variant="outline">
              Try again
            </Button>
          </p>
        ) : !record ? (
          <p className="text-sm text-muted-foreground" role="status">
            Reading the promises…
          </p>
        ) : lastFive.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="scorecard-no-promises"
          >
            No promise has been answered yet. Each weekly update says what is
            next, and the one after says what came of it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lastFive.map((promise) => (
              <li
                className="glass flex flex-wrap items-baseline gap-2 rounded-2xl border p-3 text-sm"
                data-state={promise.state}
                data-testid="scorecard-promise"
                key={promise.id}
              >
                <Chip tone={TONE[promise.state] ?? "neutral"}>
                  {PROMISE_STATE_LABEL[promise.state]}
                </Chip>
                <span className="min-w-0 flex-1 break-words">
                  {promise.text}
                  {promise.note ? (
                    <span className="block text-xs text-muted-foreground">
                      {promise.note}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Backing, when the build offers it: between the record and the latest update. Read only here. */}
      <BackingBlock isFounder={false} launch={launch} variant="scorecard" />

      <section
        aria-labelledby="scorecard-update-heading"
        className="flex flex-col gap-2"
      >
        <h2 className="text-base font-semibold" id="scorecard-update-heading">
          Latest update
        </h2>
        {updates.isError && !updates.data ? (
          <p className="text-sm" role="alert">
            Couldn't read the updates.{" "}
            <Button
              onClick={() => void updates.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </p>
        ) : !updates.data ? (
          <p className="text-sm text-muted-foreground" role="status">
            Reading the updates…
          </p>
        ) : latest ? (
          <div
            className="glass rounded-2xl border p-3"
            data-testid="scorecard-update"
          >
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {freshnessLine(latest.createdAt, now)}
              {due ? (
                <Chip tone={due.late ? "warning" : "neutral"}>{due.text}</Chip>
              ) : null}
            </p>
            <h3 className="mt-1 break-words text-sm font-bold">
              {latest.title}
            </h3>
            {latest.body ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {latest.body.length > 400
                  ? `${latest.body.slice(0, 400)}…`
                  : latest.body}
              </p>
            ) : null}
          </div>
        ) : (
          <p
            className="text-sm text-muted-foreground"
            data-testid="scorecard-no-update"
          >
            No update yet.
          </p>
        )}
      </section>

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

      <p>
        <Link
          className="text-sm font-semibold underline"
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
        <p className="text-sm" data-testid="scorecard-load-failed" role="alert">
          Couldn't open this project.{" "}
          <Button
            onClick={() => {
              void first.refetch();
              void second.refetch();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
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
