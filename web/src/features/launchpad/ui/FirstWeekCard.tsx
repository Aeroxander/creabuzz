/**
 * "First week": the founder's one clear next step while the project has no updates. A short list: the goal is set
 * (ticked once it is), post the first update, ask for one piece of help (opens the update form at "Help needed"), and
 * invite one person. It stands in for the update card until the first update exists; after that it is gone.
 *
 * `useNoUpdatesYet` is how the page knows: "yes" only when the project's updates were read to their end and none was
 * found, so a cut or failed read never tells a founder with updates that they have none.
 */

import { Check, Circle } from "lucide-react";
import { useId, useMemo } from "react";

import { projectProgress } from "@/features/feed/lib/project-progress";
import { Button } from "@/shared/ui/button";

import { firstWeekDueLine } from "../lib/first-week";
import type { Launch } from "../models";
import { useProjectUpdates } from "../use-help-requests";
import { useProjectRecord } from "../use-project-record";
import { ProjectUpdateCard } from "./ProjectUpdateCard";
import { ShareRecordButton } from "./ShareRecordButton";

/** Whether this project has posted no update at all: read to the end and none found. */
function useNoUpdatesYet(launch: Launch): boolean {
  const data = useProjectUpdates(launch.record).data;
  return useMemo(
    () =>
      Boolean(
        data?.complete &&
          !data.postsCut &&
          projectProgress(
            [{ record: launch.record, updates: data.updates }],
            data.posts,
          ).filter((item) => !item.evidence).length === 0,
      ),
    [data, launch.record],
  );
}

function Step({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 py-2" data-done={done}>
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
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {title}
          <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
        </p>
        {children}
      </div>
    </li>
  );
}

function FirstWeekCard({
  launch,
  welcomeShown,
  onPostUpdate,
  onAskForHelp,
}: {
  launch: Launch;
  /** The "Your project is live" card, which says when the first update is due, is on the page. */
  welcomeShown: boolean;
  onPostUpdate: () => void;
  /** Opens the update form with the cursor in "Help needed". */
  onAskForHelp: () => void;
}) {
  const headingId = useId();
  const { record } = launch;
  const goal = useProjectRecord(record).record?.goals.primary ?? null;
  return (
    <section
      aria-labelledby={headingId}
      className="glass rounded-2xl border p-4"
      data-testid="first-week"
    >
      <h2 className="text-sm font-bold" id={headingId}>
        First week
      </h2>
      <p className="text-xs text-muted-foreground" data-testid="first-week-due">
        {firstWeekDueLine(
          record.startedAt,
          Math.floor(Date.now() / 1000),
          welcomeShown,
        )}
      </p>
      <ol className="mt-1 divide-y divide-border/60">
        <Step done={goal !== null} title="Set your goal">
          {goal === null ? (
            <p className="text-xs text-muted-foreground">
              Say what you want to reach, in the goal card above.
            </p>
          ) : null}
        </Step>
        <Step done={false} title="Post your first update">
          <Button
            className="mt-1"
            data-testid="first-week-post"
            onClick={onPostUpdate}
            size="sm"
            type="button"
          >
            Post the first update
          </Button>
        </Step>
        <Step done={false} title="Ask for one piece of help">
          <p className="text-xs text-muted-foreground">
            People can answer with "I can help", and you see who offered.
          </p>
          <Button
            className="mt-1"
            data-testid="first-week-help"
            onClick={onAskForHelp}
            size="sm"
            type="button"
            variant="outline"
          >
            Ask for help
          </Button>
        </Step>
        <Step done={false} title="Invite one person">
          <div className="mt-1">
            <ShareRecordButton
              answered={null}
              card="started"
              goal={goal?.text ?? ""}
              kept={null}
              label="Copy an invite"
              project={record}
              streak={null}
              variant="outline"
            />
          </div>
        </Step>
      </ol>
    </section>
  );
}

/**
 * The news slot at the top of the page. A founder who has posted nothing gets "First week" in place of the update card,
 * so the page asks for one thing, not two: the update card's "due" prompt would say the first update is due while this
 * card says when. Everyone else, and a founder whose updates could not be read to their end, gets the update card.
 */
export function ProjectNews({
  launch,
  isFounder,
  firstWeek,
  showCard,
  workTab,
  welcomeShown = false,
  onPostUpdate,
  onAskForHelp,
  onOpenUpdates,
}: {
  launch: Launch;
  /** The welcome card is on the page, so the first-week card does not say when the first update is due again. */
  welcomeShown?: boolean;
  isFounder: boolean;
  /** The viewer may post as the founder (not an agent account), so the first-week card is theirs to see. */
  firstWeek: boolean;
  /** The update card is wanted here (it is not on the Updates tab, which lists the same things). */
  showCard: boolean;
  workTab: boolean;
  onPostUpdate: () => void;
  onAskForHelp: () => void;
  onOpenUpdates: () => void;
}) {
  const none = useNoUpdatesYet(launch);
  if (firstWeek && none)
    return (
      <FirstWeekCard
        launch={launch}
        welcomeShown={welcomeShown}
        onAskForHelp={onAskForHelp}
        onPostUpdate={onPostUpdate}
      />
    );
  if (!showCard) return null;
  return (
    <ProjectUpdateCard
      isFounder={isFounder}
      launch={launch}
      onOpenUpdates={onOpenUpdates}
      onPostUpdate={onPostUpdate}
      workTab={workTab}
    />
  );
}
