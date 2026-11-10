/**
 * A project's news at the top of its page: how long ago the team last posted, how many weeks in a row it has, and the
 * latest update itself with any help it asks for.
 *
 * The founder also gets one quiet prompt here when a week has passed with no update, which they can put away for the
 * week, and otherwise a line saying when the next one is due. There is no dialog and no reminder anywhere else. The
 * count of weeks in a row is this project's own: it is never a score and never compared with another project.
 */

import { useMemo, useState } from "react";

import { projectProgress } from "@/features/feed/lib/project-progress";
import { useFeedNotes } from "@/features/feed/use-feed";
import { progressScope } from "@/features/feed/use-progress-seen";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";

import {
  founderNudge,
  freshnessLine,
  inARowLine,
  nudgeDismissed,
  weeksInARow,
} from "../lib/weekly-update";
import { launchCoordinate, type Launch } from "../models";
import { UpdateBody } from "./UpdateBody";

const DISMISSED_KEY = "creaton.update-nudge.v1";
/** How many projects' dismissals this browser remembers. */
const DISMISSED_KEPT = 50;

function readDismissed(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(DISMISSED_KEY) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return {};
  }
}

/** Remembers the dismissal in this browser. False when it could not be saved (it still hides for this visit). */
function writeDismissed(scope: string, at: number): boolean {
  try {
    const next = Object.entries({ ...readDismissed(), [scope]: at })
      .sort(([, a], [, b]) => b - a)
      .slice(0, DISMISSED_KEPT);
    localStorage.setItem(
      DISMISSED_KEY,
      JSON.stringify(Object.fromEntries(next)),
    );
    return true;
  } catch {
    return false;
  }
}

export function ProjectUpdateCard({
  launch,
  isFounder,
  workTab,
  onPostUpdate,
  onOpenUpdates,
}: {
  launch: Launch;
  isFounder: boolean;
  /** Whether this project has a Work tab for a help card to point at. */
  workTab: boolean;
  onPostUpdate: () => void;
  onOpenUpdates: () => void;
}) {
  const me = existingUserPubkey();
  const notes = useFeedNotes();
  const scope = progressScope(
    relayWsUrl(),
    me,
    launchCoordinate(launch.record.author, launch.record.id),
  );
  const [dismissedAt, setDismissedAt] = useState<number | null>(
    () => readDismissed()[scope] ?? null,
  );
  // The team's own updates, in both forms the app has: the same list the Updates tab shows, without submitted work.
  const updates = useMemo(
    () =>
      projectProgress(
        [launch],
        (notes.data ?? []).map((n) => n.event),
      ).filter((item) => !item.evidence),
    [launch, notes.data],
  );
  const now = Math.floor(Date.now() / 1000);
  const latest = updates[0] ?? null;
  const raw = latest
    ? (launch.updates.find((u) => u.id === latest.id) ?? null)
    : null;
  // Until the posts are read, "no update in weeks" would be a guess; a failed read says so instead.
  const known = notes.isSuccess;
  const inARow = inARowLine(
    weeksInARow(
      updates.map((u) => u.at),
      now,
    ),
  );
  const nudge = founderNudge(latest?.at ?? null, now);
  const showNudge =
    known && isFounder && nudge.due && !nudgeDismissed(dismissedAt, now);

  // Nothing to say to a visitor about a project that has not posted: no empty card.
  if (!latest && !notes.isError && !(isFounder && known)) return null;

  return (
    <section
      aria-label="Project updates"
      className="glass rounded-2xl border p-4"
      data-testid="project-update-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {known ? (
          <p className="text-sm font-semibold" data-testid="update-freshness">
            {freshnessLine(latest?.at ?? null, now)}
          </p>
        ) : null}
        {known && inARow ? (
          <Chip data-testid="updates-in-a-row" tone="success">
            {inARow}
          </Chip>
        ) : null}
        {known && isFounder && !nudge.due ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="update-next-due"
          >
            {nudge.text}
          </p>
        ) : null}
        {notes.isError ? (
          <p className="text-sm" role="status">
            Couldn't check for the newest updates.{" "}
            <Button
              onClick={() => void notes.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </p>
        ) : null}
      </div>

      {showNudge ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-muted/60 p-3 text-sm"
          data-testid="update-nudge"
        >
          <p className="min-w-0 flex-1">{nudge.text}</p>
          <Button onClick={onPostUpdate} size="sm" type="button">
            Post one
          </Button>
          <Button
            aria-label="Hide this reminder for a week"
            onClick={() => {
              writeDismissed(scope, now);
              setDismissedAt(now);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Not now
          </Button>
        </div>
      ) : null}

      {latest ? (
        <article className="mt-3" data-testid="latest-update">
          <p className="text-xs text-muted-foreground">
            Latest update · {new Date(latest.at * 1000).toLocaleDateString()}
          </p>
          <h3 className="mt-1 break-words text-sm font-semibold">
            {latest.title}
          </h3>
          {raw ? (
            <UpdateBody
              launch={launch}
              max={400}
              update={raw}
              workTab={workTab}
            />
          ) : (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {latest.text.length > 400
                ? `${latest.text.slice(0, 400)}…`
                : latest.text}
            </p>
          )}
          {updates.length > 1 ? (
            <Button
              className="mt-2 h-auto p-0"
              onClick={onOpenUpdates}
              size="sm"
              type="button"
              variant="link"
            >
              See all {updates.length} updates
            </Button>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
