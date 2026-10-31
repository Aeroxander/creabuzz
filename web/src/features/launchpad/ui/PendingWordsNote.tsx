/**
 * Work areas' words that are still to be published (`use-pending-words.ts`): each one named, why it matters, and one
 * button that publishes the words alone. Shown on Decisions and Work to the person who opened the vote, until the
 * server accepts them.
 */

import { useState } from "react";

import { Button } from "@/shared/ui/button";

import { idLabel } from "@creaton/core/launchpad/work.ts";
import type { Launch } from "../models";
import { usePendingWords } from "../use-pending-words";

export function PendingWordsNote({ launch }: { launch: Launch }) {
  const pending = usePendingWords(launch);
  const [failed, setFailed] = useState<string | null>(null);
  if (pending.jobs.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      data-testid="pending-words"
      role="status"
    >
      {pending.jobs.map((job) => (
        <p
          className="flex flex-wrap items-center gap-2"
          data-testid="pending-words-item"
          key={`${job.mandate}:${job.id}`}
        >
          <span className="flex-1">
            The words for the work area “{idLabel(job.id)}” are not published
            yet, so people cannot read what finished work in it looks like. Its
            vote is open; publishing the words does not open it again.
          </span>
          <Button
            data-testid="pending-words-publish"
            disabled={pending.busy}
            onClick={async () => {
              setFailed(null);
              try {
                await pending.send(job);
              } catch {
                setFailed(job.id);
              }
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Publish the words
          </Button>
          {failed === job.id ? (
            <span className="w-full text-xs" role="alert">
              The server did not take them. Try again in a moment.
            </span>
          ) : null}
        </p>
      ))}
    </div>
  );
}
