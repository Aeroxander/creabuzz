/**
 * "Your first week": one card, directly under the project's header, for a founder who has posted nothing. Three steps,
 * and every one of them can be done on your own: the goal (ticked from the start), one piece of work done, and the
 * first update. One button is green at a time: "Add what you did" until something is done, then "Post this week's
 * update". After the first update it is one line, with the next update's date and a row to bring someone along.
 *
 * Its words and its ticks come from `lib/first-week.ts`; the solo box is `SoloWinDialog`, opened through
 * `useSoloAccess`. A founder who is not alone (or an agent account) never sees "I did it": the card tells them to
 * make a task below instead of offering a box that would refuse them.
 */

import { Check, Circle } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

import { aiStarterKinds, starterTasksLeft } from "../lib/ai-starters";
import {
  FIRST_WEEK_HEADING,
  FIRST_WEEK_LINE,
  FIRST_WEEK_STEPS,
  FIRST_WEEK_WORDS,
  firstWeekDoneLine,
  firstWeekProgress,
  progressWords,
  youSaidWords,
} from "../lib/first-week";
import { projectSharePath } from "../lib/share";
import { openTasks, type TaskView } from "../lib/tasks";
import type { Launch } from "../models";
import { useProjectRecord } from "../use-project-record";
import { useProjectTasks } from "../use-tasks";
import { RecoveryKeyPrompt } from "./RecoveryKeyPrompt";
import { useSoloAccess } from "./SoloWinHost";

/** The three segments and "1 of 3". The bar is for the eye; the count is the words. */
function Bar({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-3">
      <div
        aria-label="First week progress"
        aria-valuemax={3}
        aria-valuemin={0}
        aria-valuenow={count}
        aria-valuetext={progressWords(count)}
        className="flex min-w-0 flex-1 gap-1"
        data-testid="first-week-bar"
        role="progressbar"
      >
        {[1, 2, 3].map((n) => (
          <span
            className={cn(
              "h-1.5 flex-1 rounded-full",
              n <= count ? "bg-primary" : "bg-muted",
            )}
            key={n}
          />
        ))}
      </div>
      <span
        className="shrink-0 text-sm font-medium"
        data-testid="first-week-count"
      >
        {progressWords(count)}
      </span>
    </div>
  );
}

function Step({
  done,
  title,
  inline = false,
  children,
}: {
  done: boolean;
  title: string;
  /** The words beside the title on one line (a ticked step), not under it. */
  inline?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 py-1.5" data-done={done}>
      {done ? (
        <Check
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
        />
      ) : (
        <Circle
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
        />
      )}
      <div
        className={cn(
          "min-w-0 flex-1 sm:flex sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1",
          inline && "flex items-baseline gap-2",
        )}
      >
        <p className="shrink-0 text-sm font-medium sm:min-w-44">
          {title}
          <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
        </p>
        {children}
      </div>
    </li>
  );
}

const STARTER_CLASS =
  "rounded-full border border-border px-3 py-1 text-left text-xs font-medium max-sm:min-h-11 hover:bg-muted";

/** The founder's own task that is still open: the one "I did it" is about. */
function ownOpenTask(tasks: readonly TaskView[] | null, me: string | null) {
  if (!tasks || !me) return null;
  return (
    openTasks(tasks).find(
      (task) =>
        task.helper === me &&
        task.agreed !== null &&
        (task.state === "in-progress" ||
          task.state === "sent-back" ||
          task.state === "submitted"),
    ) ?? null
  );
}

export function FirstWeekSteps({
  launch,
  form,
  updates,
  lastUpdateAt,
  onPostUpdate,
  onAskForHelp,
}: {
  launch: Launch;
  form: "steps" | "done";
  /** Updates posted, for the ticks (null: not read to the end). */
  updates: number | null;
  lastUpdateAt: number | null;
  onPostUpdate: () => void;
  /** Opens the update form with the cursor in "Help needed". */
  onAskForHelp: () => void;
}) {
  const headingId = useId();
  const { record } = launch;
  const goal =
    useProjectRecord(record).record?.goals.primary?.text || record.pitch || "";
  const read = useProjectTasks(record);
  const solo = useSoloAccess();
  const me = solo.available ? record.author : null;
  const task = ownOpenTask(read.tasks, me);
  const worksDone = read.tasks
    ? read.tasks.filter((t) => t.state === "confirmed").length
    : null;
  const progress = firstWeekProgress({ worksDone, updates });
  const [copied, setCopied] = useState(false);
  const kinds = aiStarterKinds(record.category);
  const made = (read.tasks ?? []).map((t) => t.what);
  const starters = kinds.flatMap((kind) => {
    const first = starterTasksLeft(kind, made)[0];
    return first ? [{ kind: kind.id, ...first }] : [];
  });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${projectSharePath(record)}`,
      );
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const doneLine =
    form === "done" && lastUpdateAt !== null
      ? firstWeekDoneLine(lastUpdateAt, Math.floor(Date.now() / 1000))
      : null;

  return (
    <section
      aria-labelledby={headingId}
      className="glass flex flex-col gap-2 rounded-2xl border p-4"
      data-testid="first-week"
    >
      <div>
        <h2 className="text-base font-bold" id={headingId}>
          {FIRST_WEEK_HEADING}
        </h2>
        {form === "steps" ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="first-week-due"
          >
            {FIRST_WEEK_LINE}
          </p>
        ) : null}
      </div>
      <Bar count={form === "done" ? 3 : progress.count} />

      {form === "steps" ? (
        <ol className="divide-y divide-border/60">
          <Step done inline title={FIRST_WEEK_STEPS[0].title}>
            {goal ? (
              <p
                className="min-w-0 truncate text-sm text-muted-foreground"
                data-testid="first-week-goal"
                title={goal}
              >
                {goal}
              </p>
            ) : null}
          </Step>
          <Step done={progress.done.work} title={FIRST_WEEK_STEPS[1].title}>
            {progress.done.work ? (
              <p className="text-sm" data-testid="first-week-work-done">
                {FIRST_WEEK_WORDS.workDone}
              </p>
            ) : !solo.available ? (
              <p className="text-sm text-muted-foreground">
                Make a task in the Tasks card below. Someone else on the project
                checks it when it is done.
              </p>
            ) : solo.pending ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 sm:mt-0">
                <p className="text-sm" data-testid="first-week-part-saved">
                  {FIRST_WEEK_WORDS.partSaved}
                </p>
                <Button
                  data-testid="first-week-retry"
                  onClick={() =>
                    solo.open({
                      mode: "finish",
                      taskId: solo.pending?.task?.id,
                      text: solo.pending?.text,
                    })
                  }
                  size="sm"
                  type="button"
                >
                  {FIRST_WEEK_WORDS.tryAgain}
                </Button>
              </div>
            ) : task ? (
              <div className="mt-1 flex flex-col items-start gap-2 sm:mt-0 sm:flex-row sm:items-center sm:gap-3">
                <p
                  className="break-words text-sm"
                  data-testid="first-week-said"
                >
                  {youSaidWords(task.what)}
                </p>
                <Button
                  data-testid="first-week-did-it"
                  onClick={() => solo.open({ mode: "finish", taskId: task.id })}
                  size="sm"
                  type="button"
                >
                  {FIRST_WEEK_WORDS.didIt}
                </Button>
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 sm:mt-0">
                <Button
                  data-testid="first-week-add"
                  onClick={() => solo.open({ mode: "full" })}
                  size="sm"
                  type="button"
                >
                  {FIRST_WEEK_WORDS.addWork}
                </Button>
                <button
                  className="inline-flex min-h-8 items-center text-sm text-primary-ink underline-offset-4 hover:underline max-sm:min-h-11"
                  data-testid="first-week-plan"
                  onClick={() => solo.open({ mode: "plan" })}
                  type="button"
                >
                  {FIRST_WEEK_WORDS.addNext}
                </button>
              </div>
            )}
            {solo.available &&
            !progress.done.work &&
            !task &&
            starters.length > 0 ? (
              <fieldset
                className="m-0 mt-2 flex w-full min-w-0 flex-wrap gap-2 border-0 p-0"
                data-testid="first-week-starters"
              >
                <legend className="sr-only">Ideas to start from</legend>
                {starters.map((starter) => (
                  <button
                    className={STARTER_CLASS}
                    data-testid="first-week-starter"
                    key={starter.kind}
                    onClick={() =>
                      solo.open({
                        mode: "plan",
                        text: starter.title,
                        done: starter.done,
                      })
                    }
                    type="button"
                  >
                    {starter.title}
                  </button>
                ))}
              </fieldset>
            ) : null}
          </Step>
          <Step done={false} title={FIRST_WEEK_STEPS[2].title}>
            <Button
              className="mt-1 sm:mt-0"
              data-testid="first-week-post"
              onClick={onPostUpdate}
              size="sm"
              type="button"
              variant={
                progress.done.work || !solo.available ? "default" : "outline"
              }
            >
              {FIRST_WEEK_WORDS.post}
            </Button>
          </Step>
        </ol>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium" data-testid="first-week-done-line">
            {doneLine ?? "First week done."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{FIRST_WEEK_WORDS.bringSomeone}</span>
            <Button
              data-testid="first-week-copy-link"
              onClick={() => void copyLink()}
              size="sm"
              type="button"
              variant="outline"
            >
              {FIRST_WEEK_WORDS.copyLink}
            </Button>
            <Button
              data-testid="first-week-help"
              onClick={onAskForHelp}
              size="sm"
              type="button"
              variant="outline"
            >
              {FIRST_WEEK_WORDS.askForHelp}
            </Button>
            <span
              className="text-xs text-muted-foreground"
              data-testid="first-week-copy-status"
              role="status"
            >
              {copied ? "Copied. Paste it anywhere." : ""}
            </span>
          </div>
        </div>
      )}
      <RecoveryKeyPrompt />
    </section>
  );
}
