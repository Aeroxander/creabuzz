/**
 * The help a project still needs: every request from its earlier updates that the team has not marked "Help found".
 * The newest update's own request shows with that update, just above, so it is not repeated here.
 *
 * Read with the project's other records (`useProjectUpdates`). Until that read answers, or when it fails, nothing is
 * listed: the update card above already says so and offers to read again.
 */

import { useMemo } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";

import { helpRequest, teamOf } from "../lib/help-request";
import type { Launch } from "../models";
import { useProjectUpdates } from "../use-help-requests";
import { HelpRequestCard } from "./HelpRequestCard";

/** How many open requests are listed. */
const SHOWN = 5;

export function ProjectOpenHelp({
  launch,
  workTab,
}: {
  launch: Launch;
  workTab: boolean;
}) {
  const me = existingUserPubkey();
  const data = useProjectUpdates(launch.record).data;
  const open = useMemo(() => {
    if (!data) return [];
    const team = teamOf(launch.record);
    const asking = data.updates.filter(
      (update) => update.help && team.has(update.author),
    );
    // Newest first already; the newest team update is the one the update card shows in full.
    const newest = data.updates.find((update) => team.has(update.author));
    return asking
      .filter((update) => update.id !== newest?.id)
      .filter(
        (update) =>
          helpRequest({ update, signals: data.signals, team, viewer: me })
            ?.open,
      )
      .slice(0, SHOWN);
  }, [data, launch.record, me]);
  if (open.length === 0) return null;
  return (
    <section
      aria-labelledby="project-open-help-heading"
      className="glass rounded-2xl border p-4"
      data-testid="project-open-help"
    >
      <h2 className="text-sm font-bold" id="project-open-help-heading">
        Help still wanted
      </h2>
      <ul className="mt-2 flex flex-col gap-3">
        {open.map((update) => (
          <li key={update.id}>
            <p className="text-xs text-muted-foreground">
              Asked on {new Date(update.createdAt * 1000).toLocaleDateString()}{" "}
              in <span className="break-words">{update.title}</span>
            </p>
            <HelpRequestCard
              launch={launch}
              update={update}
              workTab={workTab}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
