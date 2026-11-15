/**
 * After an update is published: a small, still note on the project page that it is out, how many weeks in a row
 * that makes (stated only once two promises are answered, the rule the share picture follows, so the sentence and the
 * picture agree), one button to share the record, with its picture, and one to add a weekly reminder to the founder's own calendar (a
 * calendar file; nothing is sent from here). It sits in the page and covers nothing; nothing moves, so there is
 * nothing for "reduce motion" to stop.
 */

import { PartyPopper } from "lucide-react";
import { useId, useMemo } from "react";

import {
  projectPageUrl,
  weeklyReminderFileName,
  weeklyReminderIcs,
} from "../lib/calendar-reminder";
import { postedLine } from "../lib/first-week";
import { projectGoals } from "../lib/goals";
import { teamOf } from "../lib/help-request";
import { promiseRecord, promiseTotals } from "../lib/promises";
import { WEEKDAY_NAMES } from "../lib/update-day";
import { weeksInARow } from "../lib/weekly-update";
import type { Launch } from "../models";
import { useProjectUpdates } from "../use-help-requests";
import { Button } from "@/shared/ui/button";

import { downloadCalendarFile } from "./download-calendar";
import { ShareRecordButton } from "./ShareRecordButton";
import { useUpdateDay } from "./use-update-day";

export function UpdatePosted({
  project,
  onClose,
}: {
  project: Launch["record"];
  onClose: () => void;
}) {
  const headingId = useId();
  const day = useUpdateDay(project);
  const read = useProjectUpdates(project);
  const facts = useMemo(() => {
    const data = read.data;
    if (!data?.complete) return null;
    const now = Math.floor(Date.now() / 1000);
    const team = teamOf(project);
    const totals = promiseTotals(
      promiseRecord(data.founder.updates, project.author),
    );
    return {
      // The update just posted counts for this week even before it is read back.
      streak: weeksInARow(
        [
          now,
          ...data.updates
            .filter((u) => team.has(u.author) && u.weekly)
            .map((u) => u.createdAt),
        ],
        now,
      ),
      kept: totals.kept,
      answered: totals.kept + totals.missed + totals.changed,
      // The goal in the founder's words, for the share picture.
      goal:
        projectGoals(data.founder.goals, project.author).primary?.text ?? "",
    };
  }, [read.data, project]);
  return (
    <section
      aria-labelledby={headingId}
      className="glass rounded-2xl border border-primary/40 p-4"
      data-testid="update-posted"
    >
      <div className="flex flex-col gap-3">
        <h2
          className="flex items-center gap-2 text-lg font-semibold text-black dark:text-white"
          id={headingId}
        >
          <PartyPopper aria-hidden className="h-5 w-5 text-primary" />
          Update posted
        </h2>
        <p className="text-sm" data-testid="update-posted-streak" role="status">
          {postedLine(facts)}
        </p>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <ShareRecordButton
            answered={facts?.answered ?? null}
            card="kept"
            goal={facts?.goal ?? ""}
            kept={facts?.kept ?? null}
            project={project}
            streak={facts?.streak ?? null}
            withImage
          />
          <Button onClick={onClose} type="button" variant="outline">
            Done
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="update-posted-reminder"
            onClick={() =>
              downloadCalendarFile(
                weeklyReminderFileName(project),
                weeklyReminderIcs(
                  {
                    id: project.id,
                    name: project.name,
                    url: projectPageUrl(window.location.origin, project),
                  },
                  { weekday: day.weekday },
                ),
              )
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Add a weekly reminder
          </Button>
          <p
            className="min-w-0 flex-1 text-xs text-muted-foreground"
            data-testid="update-posted-reminder-note"
          >
            A repeating event for your calendar app, every{" "}
            {WEEKDAY_NAMES[day.weekday]}. Nothing is sent from here.
          </p>
        </div>
      </div>
    </section>
  );
}
