import { useState } from "react";

import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";

import { isIdea } from "../lib/idea";
import { NOT_LISTED_LINE, notListedYet } from "../lib/listing";
import type { Launch, LaunchStage } from "../models";
import { useChangeOwnRecord } from "../use-own-record";

/**
 * Whether the project is listed, said on its page. Everyone who opens a project that is not listed reads that it is
 * not; its founder also gets the one button that changes it, and reads what being listed means before pressing it.
 *
 * What was chosen is shown at once (`chosen`), because the server can take seconds to show the record back; a failed
 * save puts the old words back with the reason and a retry.
 */
export function ListingNote({
  launch,
  stage,
  isFounder,
}: {
  launch: Launch;
  /** The stage in effect (`effectiveStage`). */
  stage: LaunchStage;
  isFounder: boolean;
}) {
  const change = useChangeOwnRecord();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureWords | null>(null);
  // What the founder chose here, until the record read back agrees with it.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const recorded = notListedYet(launch.record);
  const unlisted = chosen ?? recorded;
  // A sale still being set up is in no list whatever its founder chose; that is said to them, with no button.
  if (stage === "draft" && !isIdea(launch.record))
    return isFounder ? (
      <p className="text-sm" data-testid="project-listing-state" role="status">
        Not listed yet: this sale is still being set up. It is listed once it
        opens.
      </p>
    ) : null;
  if (!unlisted && !isFounder) return null;

  const set = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setChosen(next);
    try {
      await change(launch.record.id, (own) =>
        notListedYet(own) === next
          ? null
          : { listing: next ? "unlisted" : undefined },
      );
    } catch (cause) {
      setChosen(null);
      setFailure(
        failureWords(
          cause,
          next
            ? "The project is still listed: the change was not saved. Try again."
            : "The project is still not listed: the change was not saved. Try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Listing"
      className="rounded-2xl border border-border p-4 text-sm"
      data-testid="project-listing"
    >
      <p data-testid="project-listing-state" role="status">
        {unlisted
          ? NOT_LISTED_LINE
          : "Listed. Anyone on this server can find this project in Discover and on Home."}
      </p>
      {isFounder ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button
            data-testid="project-listing-toggle"
            disabled={busy}
            onClick={() => void set(!unlisted)}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy
              ? "Saving…"
              : unlisted
                ? "List this project"
                : "Not listed yet"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {unlisted
              ? "Listing it shows it in Discover, on Home and in search."
              : "Choose this to keep working without being in any list. The page still opens from its link."}
          </span>
        </div>
      ) : null}
      {failure ? (
        <FailureNote
          className="mt-2"
          failure={failure}
          testId="project-listing-failed"
        />
      ) : null}
    </section>
  );
}
