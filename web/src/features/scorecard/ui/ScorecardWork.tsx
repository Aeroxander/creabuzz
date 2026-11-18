/**
 * The parts of a project's scorecard that are not its header: the promises it kept and missed, the work it did, its
 * latest update and the buttons for whoever is looking. Each says only what the project's signed records say; a read
 * that did not finish says so and leaves the part out, never a zero.
 */

import { Link } from "@tanstack/react-router";
import { Check, CheckCheck, X } from "lucide-react";
import { useMemo } from "react";

import {
  type PromiseEntry,
  PROMISE_STATE_LABEL,
  type PromiseState,
} from "@/features/launchpad/lib/promises";
import { whenWords } from "@/features/launchpad/lib/record-date";
import { acceptedTasks, taskStateLabel } from "@/features/launchpad/lib/tasks";
import type { TaskView } from "@/features/launchpad/lib/tasks";
import {
  previousWeekly,
  promiseTexts,
  updateView,
} from "@/features/launchpad/lib/update-view";
import type { Launch, LaunchUpdate } from "@/features/launchpad/models";
import { CheckedBy } from "@/features/launchpad/ui/CheckedBy";
import { JoinAskButton } from "@/features/launchpad/ui/JoinAskButton";
import { ShareRecordButton } from "@/features/launchpad/ui/ShareRecordButton";
import { StartYours } from "@/features/launchpad/ui/StartYours";
import { UpdateSections } from "@/features/launchpad/ui/UpdateSections";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Chip, type ChipTone } from "@/shared/ui/chip";

const ANSWERED: readonly PromiseState[] = ["kept", "missed", "changed"];
const TONE: Partial<Record<PromiseState, ChipTone>> = {
  kept: "success",
  // A miss is a fact, not an alarm: said in words, never red.
  missed: "warning",
  changed: "warning",
};
/** How many answered promises and finished pieces of work the scorecard lists. */
const LISTED = 5;

/** The newest answered promises, newest first, as many as the scorecard lists. */
function lastAnswered(
  promises: readonly PromiseEntry[],
  now: number,
): PromiseEntry[] {
  return promises
    .filter((promise) => ANSWERED.includes(promise.state))
    .sort(
      (a, b) =>
        Math.min(b.answeredAt ?? 0, now) - Math.min(a.answeredAt ?? 0, now) ||
        (a.id < b.id ? -1 : 1),
    )
    .slice(0, LISTED);
}

/** "Promises, kept and missed": the last promises answered, or what to expect when none is. */
export function PromisesAnswered({
  promises,
  failed,
  onRetry,
  now,
}: {
  /** Null while the record is being read. */
  promises: readonly PromiseEntry[] | null;
  failed: boolean;
  onRetry: () => void;
  now: number;
}) {
  const listed = useMemo(
    () => (promises ? lastAnswered(promises, now) : []),
    [promises, now],
  );
  return (
    <section
      aria-labelledby="scorecard-promises-heading"
      className="flex flex-col gap-2"
    >
      <h2 className="text-base font-semibold" id="scorecard-promises-heading">
        Promises, kept and missed
      </h2>
      {failed ? (
        <p className="text-sm" role="alert">
          Couldn't load this record.{" "}
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Try again
          </Button>
        </p>
      ) : !promises ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading the record...
        </p>
      ) : listed.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="scorecard-no-promises"
        >
          Nothing to check yet. Next week's update says what came of this week's
          promises.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {listed.map((promise) => (
            <li
              className="glass flex flex-wrap items-baseline gap-2 rounded-2xl border p-3 text-sm"
              data-state={promise.state}
              data-testid="scorecard-promise"
              key={promise.id}
            >
              <Chip
                icon={promise.state === "kept" ? Check : X}
                tone={TONE[promise.state] ?? "neutral"}
              >
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
  );
}

/**
 * "Work done": the pieces of work that were checked, newest first. Work someone else accepted says "Work accepted";
 * work only the founder checked says "Done, checked by the founder" (to the founder, "checked by you"). They are
 * never worded alike.
 */
export function WorkDone({
  tasks,
  now,
  viewerIsFounder,
}: {
  /** The project's tasks, or null when they could not all be read (then nothing is listed). */
  tasks: readonly TaskView[] | null;
  now: number;
  viewerIsFounder: boolean;
}) {
  const done = useMemo(
    () =>
      tasks
        ? acceptedTasks(
            tasks.filter((task) => task.agreed !== null),
            now,
          ).slice(0, LISTED)
        : [],
    [tasks, now],
  );
  if (done.length === 0) return null;
  const viewer = existingUserPubkey();
  return (
    <section
      aria-labelledby="scorecard-work-heading"
      className="flex flex-col gap-2"
      data-testid="scorecard-work"
    >
      <h2 className="text-base font-semibold" id="scorecard-work-heading">
        Work done
      </h2>
      <ul className="flex flex-col gap-2">
        {done.map((task) => (
          <li
            className="glass flex flex-col gap-1 rounded-2xl border p-3 text-sm"
            data-testid={
              task.selfChecked ? "scorecard-work-alone" : "scorecard-work-item"
            }
            key={task.id}
          >
            <span className="break-words font-medium">{task.what}</span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Chip
                icon={task.selfChecked ? CheckCheck : Check}
                tone={task.selfChecked ? "neutral" : "success"}
              >
                {task.selfChecked
                  ? taskStateLabel(task, viewerIsFounder)
                  : "Work accepted"}
              </Chip>
              <CheckedBy className="text-sm" task={task} viewer={viewer} />
              {task.accepted ? (
                <span className="text-sm text-muted-foreground">
                  {whenWords(task.accepted.confirmedAt, now)}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Latest update": the newest update the team posted, laid out under its promises, this week and next week. */
export function LatestUpdate({
  launch,
  updates,
  complete,
  latest,
  failed,
  onRetry,
  now,
}: {
  launch: Launch;
  /** Every update read, or null while they are being read. */
  updates: readonly LaunchUpdate[] | null;
  /** The whole list was read (the update before the latest is then known). */
  complete: boolean;
  latest: LaunchUpdate | null;
  failed: boolean;
  onRetry: () => void;
  now: number;
}) {
  const view = useMemo(
    () =>
      latest && updates
        ? updateView(latest, {
            founder: launch.record.author,
            texts: promiseTexts(updates),
            previous: complete
              ? previousWeekly(updates, latest, launch.record.author)
              : null,
          })
        : null,
    [latest, updates, complete, launch.record.author],
  );
  return (
    <section
      aria-labelledby="scorecard-update-heading"
      className="flex flex-col gap-2"
    >
      <h2 className="text-base font-semibold" id="scorecard-update-heading">
        Latest update
      </h2>
      {failed ? (
        <p className="text-sm" role="alert">
          Couldn't load the updates.{" "}
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Try again
          </Button>
        </p>
      ) : !updates ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading the updates...
        </p>
      ) : latest && view ? (
        <div
          className="glass rounded-2xl border p-3"
          data-testid="scorecard-update"
        >
          <p className="text-xs text-muted-foreground">
            {whenWords(latest.createdAt, now)}
          </p>
          <h3 className="mt-1 break-words text-sm font-bold">{latest.title}</h3>
          <UpdateSections max={400} view={view} />
          {latest.help ? (
            <div className="mt-2" data-testid="scorecard-update-help">
              <h4 className="text-xs font-semibold text-muted-foreground">
                Help needed
              </h4>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">
                {latest.help.text}
              </p>
            </div>
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
  );
}

/**
 * The buttons for whoever is looking. A visitor: "Ask to join" is green, Follow, "I can help" and Share are outline. The founder or
 * someone on the team: no Follow and no "I can help"; Share, and for the founder "Post this week's update" in green.
 * Signed out, a quiet link says how to start a project of one's own.
 */
export function ScorecardActions({
  launch,
  onTeam,
  isFounder,
  viewerIsAgent,
  followed,
  followDisabled,
  onFollow,
  share,
}: {
  launch: Launch;
  onTeam: boolean;
  isFounder: boolean;
  viewerIsAgent: boolean;
  followed: boolean;
  followDisabled: boolean;
  onFollow: () => void;
  share: Omit<
    React.ComponentProps<typeof ShareRecordButton>,
    "label" | "project" | "variant"
  >;
}) {
  const project = launch.record;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {onTeam ? null : (
        <>
          <JoinAskButton project={project} />
          <Button
            aria-pressed={followed}
            className="max-sm:h-11"
            data-testid="scorecard-follow"
            disabled={followDisabled}
            onClick={onFollow}
            type="button"
            variant="outline"
          >
            {followed ? "Following" : "Follow"}
          </Button>
          <Button asChild className="max-sm:h-11" variant="outline">
            <Link
              data-testid="scorecard-help"
              params={{ launchId: project.id }}
              search={{ author: project.author, tab: "updates" }}
              to="/launchpad/$launchId"
            >
              I can help
            </Link>
          </Button>
        </>
      )}
      {isFounder && !viewerIsAgent ? (
        <Button asChild className="max-sm:h-11">
          <Link
            data-testid="scorecard-post-update"
            params={{ launchId: project.id }}
            search={{ author: project.author, action: "update" }}
            to="/launchpad/$launchId"
          >
            Post this week's update
          </Link>
        </Button>
      ) : null}
      <ShareRecordButton
        {...share}
        label="Share"
        project={project}
        variant="outline"
      />
      <StartYours />
    </div>
  );
}
