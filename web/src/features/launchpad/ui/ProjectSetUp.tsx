/**
 * What a project page shows below its news. A new project has nothing to put in its Tasks, Team and Record cards, so
 * they stay off the page until there is something in them, and the founder (and anyone on the team) gets one quiet
 * button, "Set up more", that brings them all in (`setUpMore` in `lib/launch-tabs.ts`). The button is the way back to
 * adding a team member: it stays for as long as one of the three cards is not on the page.
 *
 * `useSetUpUses` reads what each card would hold: tasks the viewer may see, the people on the team, and promises, goal
 * steps or finished tasks for the record. A read that failed or was cut short answers "unknown", which keeps the card.
 */

import { useEffect, useMemo, useState } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import { allGoals, goalRecordEntries } from "../lib/goals";
import { teamOf } from "../lib/help-request";
import {
  cardUse,
  type SetUpCard,
  setUpCardShown,
  setUpMore,
  type TabUse,
} from "../lib/launch-tabs";
import { mayViewTask, openTasks } from "../lib/tasks";
import type { Launch } from "../models";
import { useProjectRecord } from "../use-project-record";
import { useProjectTasks } from "../use-tasks";
import { ProjectRecordCard } from "./ProjectRecordCard";
import { ProjectTasksCard } from "./ProjectTasksCard";
import { ProjectTeamCard } from "./ProjectTeamCard";

const SET_UP_CARDS: readonly SetUpCard[] = ["tasks", "team", "record"];

/** What each of the three cards would hold, for this viewer. */
export function useSetUpUses(launch: Launch): Record<SetUpCard, TabUse> {
  const { record } = launch;
  const me = existingUserPubkey();
  const team = useMemo(() => teamOf(record), [record]);
  const work = useProjectTasks(record);
  const promises = useProjectRecord(record);
  return useMemo(() => {
    const tasks = work.tasks;
    const open = tasks
      ? openTasks(tasks).filter((task) => mayViewTask(task, team, me)).length
      : null;
    const closed = (tasks ?? []).filter(
      (task) =>
        task.agreed !== null &&
        (task.state === "confirmed" ||
          task.gaveUp !== null ||
          task.cancelled !== null),
    ).length;
    const read = promises.record;
    // Its finished tasks are part of it: until they are read the card is not said to be empty.
    const lines =
      read && tasks
        ? read.promises.length +
          read.orphans.length +
          goalRecordEntries(allGoals(read.goals)).length +
          read.removed.count +
          read.removed.unnamed +
          closed
        : null;
    return {
      tasks: cardUse({
        count: open,
        failed: work.failed,
        complete: work.complete,
      }),
      team: record.team.length + record.formerTeam.length > 0 ? "yes" : "no",
      // Its tasks are part of the record: a failed read of them keeps the card, which says so with Try again.
      record: cardUse({
        count: lines,
        failed: promises.failed || work.failed,
        complete: Boolean(read?.facts.totals) && work.complete,
      }),
    };
  }, [work, promises, team, me, record.team, record.formerTeam]);
}

/**
 * The Tasks, Team and Record cards, each only once it has something or "Set up more" was pressed, then the button for
 * whoever can set the rest up: the founder, and anyone on the team (a member's "Give someone a task" lives in the Tasks
 * card, so it must stay reachable for them too).
 */
export function SetUpCards({
  launch,
  isFounder,
  opened,
  onOpen,
}: {
  launch: Launch;
  isFounder: boolean;
  opened: boolean;
  onOpen: () => void;
}) {
  const uses = useSetUpUses(launch);
  const me = existingUserPubkey();
  const onTeam = isFounder || (me !== null && teamOf(launch.record).has(me));
  // A card that has been on the page stays for this visit. A card that appears only because its read failed would
  // otherwise begin that read again as it mounts, drop out while it runs, and fail again: showing and hiding for ever.
  const [kept, setKept] = useState<ReadonlySet<SetUpCard>>(new Set());
  const wanted = SET_UP_CARDS.filter((card) =>
    setUpCardShown(uses[card], opened),
  );
  useEffect(() => {
    if (wanted.some((card) => !kept.has(card)))
      setKept(new Set([...kept, ...wanted]));
  }, [wanted, kept]);
  const shown = (card: SetUpCard) => wanted.includes(card) || kept.has(card);
  // What the button would still bring in: the cards the page is not showing, and has not shown.
  const left = setUpMore(uses, opened).filter((card) => !kept.has(card));
  return (
    <>
      {shown("tasks") ? <ProjectTasksCard launch={launch} /> : null}
      {shown("team") ? (
        <ProjectTeamCard isFounder={isFounder} launch={launch} />
      ) : null}
      {shown("record") ? (
        <ProjectRecordCard isFounder={isFounder} launch={launch} />
      ) : null}
      {onTeam ? (
        <SetUpMoreButton onOpen={onOpen} show={left.length > 0} />
      ) : null}
    </>
  );
}

/** The one button for the cards a new project does not have yet. Nothing when every card is on the page. */
function SetUpMoreButton({
  show,
  onOpen,
}: {
  show: boolean;
  onOpen: () => void;
}) {
  if (!show) return null;
  return (
    <section
      aria-label="Set up more"
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="set-up-more-row"
    >
      <Button
        data-testid="set-up-more"
        onClick={onOpen}
        size="sm"
        type="button"
        variant="outline"
      >
        Set up more
      </Button>
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        Add a team member, make a task, or see your record of promises.
      </p>
    </section>
  );
}
