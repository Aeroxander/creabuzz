/**
 * After an update is published: a small, still note on the project page that it is out, how many weeks in a row
 * that makes, and one button to share the record. It sits in the page and covers nothing; nothing moves, so there is
 * nothing for "reduce motion" to stop.
 */

import { PartyPopper } from "lucide-react";
import { useId, useMemo } from "react";

import { teamOf } from "../lib/help-request";
import { promiseRecord, promiseTotals } from "../lib/promises";
import { weeksInARow } from "../lib/weekly-update";
import type { Launch } from "../models";
import { useProjectUpdates } from "../use-help-requests";
import { Button } from "@/shared/ui/button";

import { ShareRecordButton } from "./ShareRecordButton";

export function UpdatePosted({
  project,
  onClose,
}: {
  project: Launch["record"];
  onClose: () => void;
}) {
  const headingId = useId();
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
          {facts === null
            ? "It's on your project's record for everyone to read."
            : facts.streak >= 2
              ? `That's ${facts.streak} weeks in a row. Keep it going next week.`
              : "That's week one. Post again next week and your run begins."}
        </p>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <ShareRecordButton
            answered={facts?.answered ?? null}
            kept={facts?.kept ?? null}
            project={project}
            streak={facts?.streak ?? null}
          />
          <Button onClick={onClose} type="button" variant="outline">
            Done
          </Button>
        </div>
      </div>
    </section>
  );
}
