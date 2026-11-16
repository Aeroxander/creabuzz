/**
 * What a project page shows below its news: the Tasks, Team and Record cards (`setUpCardShown` in
 * `lib/launch-tabs.ts`). Record stays off the page until there is something in it.
 *
 * `useSetUpUses` reads what each card would hold: tasks the viewer may see, the people on the team, and promises, goal
 * steps or finished tasks for the record. A read that failed or was cut short answers "unknown", which keeps the card.
 */

import { useEffect, useMemo, useState } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";

import { allGoals, goalRecordEntries } from "../lib/goals";
import { teamOf } from "../lib/help-request";
import {
  cardUse,
  type SetUpCard,
  setUpCardShown,
  type TabUse,
} from "../lib/launch-tabs";
import { mayViewTask, openTasks } from "../lib/tasks";
import type { Launch } from "../models";
import { useProjectRecord } from "../use-project-record";
import { useProjectTasks, useTeamRemovals } from "../use-tasks";
import { ProjectRecordCard } from "./ProjectRecordCard";
import { ProjectTasksCard } from "./ProjectTasksCard";
import { ProjectTeamCard } from "./ProjectTeamCard";

const SET_UP_CARDS: readonly SetUpCard[] = ["tasks", "team", "record"];

/** What each of the three cards would hold, for this viewer. */
function useSetUpUses(launch: Launch): {
  uses: Record<SetUpCard, TabUse>;
  /** The project's tasks were read, or could not be: what the cards say about work is settled. */
  tasksRead: boolean;
} {
  const { record } = launch;
  const me = existingUserPubkey();
  const team = useMemo(() => teamOf(record), [record]);
  const work = useProjectTasks(record);
  const promises = useProjectRecord(record);
  // What team members removed is part of the record, and is never kept off the page.
  const removals = useTeamRemovals(record);
  const uses = useMemo((): Record<SetUpCard, TabUse> => {
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
          (removals ? removals.members.length + removals.unchecked : 0) +
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
  }, [work, promises, removals, team, me, record.team, record.formerTeam]);
  return { uses, tasksRead: Boolean(work.tasks) || work.failed };
}

/**
 * The Tasks, Team and Record cards. Tasks and Team are on the page from the start for the founder and the team (they
 * hold "Add something to do" and "Add a person"); Record shows once it has something to hold.
 */
export function SetUpCards({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const { uses, tasksRead } = useSetUpUses(launch);
  const me = existingUserPubkey();
  const onTeam = isFounder || (me !== null && teamOf(launch.record).has(me));
  // A card that has been on the page stays for this visit. A card that appears only because its read failed would
  // otherwise begin that read again as it mounts, drop out while it runs, and fail again: showing and hiding for ever.
  const [kept, setKept] = useState<ReadonlySet<SetUpCard>>(new Set());
  const wanted = SET_UP_CARDS.filter((card) =>
    setUpCardShown(card, uses[card], onTeam),
  );
  useEffect(() => {
    if (wanted.some((card) => !kept.has(card)))
      setKept(new Set([...kept, ...wanted]));
  }, [wanted, kept]);
  const shown = (card: SetUpCard) => wanted.includes(card) || kept.has(card);
  return (
    <>
      {/* Says when the tasks were read, so a page with nothing to show for them can be told from one still reading. */}
      <span
        data-tasks-read={tasksRead ? "true" : undefined}
        data-testid="set-up-state"
        hidden
      />
      {shown("tasks") ? <ProjectTasksCard launch={launch} /> : null}
      {shown("team") ? (
        <ProjectTeamCard isFounder={isFounder} launch={launch} />
      ) : null}
      {shown("record") ? (
        <ProjectRecordCard isFounder={isFounder} launch={launch} />
      ) : null}
    </>
  );
}
