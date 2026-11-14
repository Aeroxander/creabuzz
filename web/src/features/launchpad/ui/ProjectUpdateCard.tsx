/**
 * A project's news at the top of its page: how long ago the team last posted, how many weeks in a row it has, and the
 * latest update itself with any help it asks for.
 *
 * The founder also gets one quiet prompt here when a week has passed with no update, which they can put away for the
 * week, and otherwise a line saying when the next one is due. There is no dialog and no reminder anywhere else. The
 * count of weeks in a row is this project's own: it is never a score and never compared with another project.
 *
 * All of it is worked out from this project's own records, read for it alone and to their end where that is possible
 * (`useProjectUpdates`), not from the list of every project, which is cut at a fixed size. What a cut read cannot settle
 * is left unsaid: no "no update in weeks", no "you haven't posted", no count in a row. A failed read says so, with a
 * way to read again.
 */

import { useMemo, useState } from "react";

import { projectProgress } from "@/features/feed/lib/project-progress";
import { progressScope } from "@/features/feed/use-progress-seen";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";

import {
  founderNudge,
  updateDueWords,
  freshnessLine,
  inARowLine,
  nudgeDismissed,
  updateFacts,
  weeksInARow,
} from "../lib/weekly-update";
import { launchCoordinate, type Launch } from "../models";
import { useProjectUpdates } from "../use-help-requests";
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
  const read = useProjectUpdates(launch.record);
  const scope = progressScope(
    relayWsUrl(),
    me,
    launchCoordinate(launch.record.author, launch.record.id),
  );
  const [dismissedAt, setDismissedAt] = useState<number | null>(
    () => readDismissed()[scope] ?? null,
  );
  const data = read.data;
  // The team's own updates, in both forms the app has, without submitted work: what the Updates tab lists.
  const updates = useMemo(
    () =>
      data
        ? projectProgress(
            [{ record: launch.record, updates: data.updates }],
            data.posts,
          ).filter((item) => !item.evidence)
        : [],
    [launch.record, data],
  );
  if (!data) {
    // Not read yet: nothing is said. Not readable: said, with a way to read again.
    if (!read.isError) return null;
    return (
      <section
        aria-label="Project updates"
        className="glass rounded-2xl border p-4"
        data-testid="project-update-card"
      >
        <p className="text-sm" data-testid="update-read-failed" role="alert">
          Couldn't read this project's updates.{" "}
          <Button
            onClick={() => void read.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      </section>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const latest = updates[0] ?? null;
  const raw = latest
    ? (data.updates.find((u) => u.id === latest.id) ?? null)
    : null;
  const facts = updateFacts({
    latestAt: latest?.at ?? null,
    recordsComplete: data.complete,
    postsCut: data.postsCut,
    oldestPostAt:
      data.posts.length > 0
        ? Math.min(...data.posts.map((post) => post.created_at))
        : null,
  });
  const inARow = facts.inARow
    ? inARowLine(
        weeksInARow(
          updates.map((u) => u.at),
          now,
        ),
      )
    : null;
  const nudge = founderNudge(latest?.at ?? null, now);
  // For everyone: when the next weekly update is due, or how late it is.
  const dueWords = facts.freshness
    ? updateDueWords(latest?.at ?? null, now)
    : null;
  const showNudge =
    facts.freshness &&
    isFounder &&
    nudge.due &&
    !nudgeDismissed(dismissedAt, now);

  // Nothing to say to a visitor about a project that has not posted: no empty card.
  if (!latest && !(isFounder && facts.freshness)) return null;

  return (
    <section
      aria-label="Project updates"
      className="glass rounded-2xl border p-4"
      data-testid="project-update-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {facts.freshness ? (
          <p className="text-sm font-semibold" data-testid="update-freshness">
            {freshnessLine(latest?.at ?? null, now)}
          </p>
        ) : (
          <p
            className="text-xs text-muted-foreground"
            data-testid="update-freshness-unknown"
          >
            This project has more posts than could be read here, so how recent
            its newest update is can't be worked out.
          </p>
        )}
        {inARow ? (
          <Chip data-testid="updates-in-a-row" tone="success">
            {inARow}
          </Chip>
        ) : null}
        {dueWords && !(isFounder && !nudge.due) ? (
          <Chip
            data-testid="update-due-words"
            tone={dueWords.late ? "warning" : "neutral"}
          >
            {dueWords.text}
          </Chip>
        ) : null}
        {facts.freshness && isFounder && !nudge.due ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="update-next-due"
          >
            {nudge.text}
          </p>
        ) : null}
        {read.isError ? (
          <p className="text-sm" role="status">
            Couldn't check for newer updates.{" "}
            <Button
              onClick={() => void read.refetch()}
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
            aria-label="Not now: hide this reminder for a week"
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
              See all updates
            </Button>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
