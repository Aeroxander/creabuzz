/**
 * After an update is published: a small, still note on the project page that it is out, how many weeks in a row
 * that makes (stated only once two promises are answered, the rule the share picture follows, so the sentence and the
 * picture agree), when the next update is due, and one outline button to share the record, with its picture. On the
 * first update it also offers "Add a weekly reminder" for the founder's own calendar (a calendar file; nothing is sent
 * from here), as the one filled button: that is the next step. It sits in the page and covers nothing; nothing moves,
 * so there is nothing for "reduce motion" to stop.
 */

import { CheckCircle2 } from "lucide-react";
import { useId, useMemo, useState } from "react";

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
import { updateDueWords, weeksInARow } from "../lib/weekly-update";
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
  const [now] = useState(() => Math.floor(Date.now() / 1000));
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
      // How many weekly updates the read holds. The one just posted may or may not be in it yet, so "the first" is
      // one or none.
      weekly: data.updates.filter((u) => team.has(u.author) && u.weekly).length,
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
  // The first update: a read that did not reach the end cannot say it is not, so the reminder is offered then too.
  const first = facts === null || facts.weekly <= 1;
  const next = updateDueWords(now, now)?.text.replace(
    /^Next update /,
    "Next update: ",
  );
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
          <CheckCircle2 aria-hidden className="h-5 w-5 text-primary" />
          Update posted
        </h2>
        <p className="text-sm" data-testid="update-posted-streak" role="status">
          {postedLine(facts)}
        </p>
        {next ? (
          <p className="text-sm" data-testid="update-posted-next">
            {next}
          </p>
        ) : null}
        {first ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="max-sm:h-11"
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
                type="button"
              >
                Add a weekly reminder
              </Button>
              <Button
                className="max-sm:h-11"
                onClick={onClose}
                type="button"
                variant="ghost"
              >
                Done
              </Button>
            </div>
            <p
              className="text-xs text-muted-foreground"
              data-testid="update-posted-reminder-note"
            >
              A repeating event for your calendar app, every{" "}
              {WEEKDAY_NAMES[day.weekday]}. Nothing is sent from here.
            </p>
          </div>
        ) : (
          <div>
            <Button
              className="max-sm:h-11"
              onClick={onClose}
              type="button"
              variant="ghost"
            >
              Done
            </Button>
          </div>
        )}
        <ShareRecordButton
          answered={facts?.answered ?? null}
          card="kept"
          goal={facts?.goal ?? ""}
          kept={facts?.kept ?? null}
          project={project}
          streak={facts?.streak ?? null}
          variant="outline"
          withImage
        />
      </div>
    </section>
  );
}
