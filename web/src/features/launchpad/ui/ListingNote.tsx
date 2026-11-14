import { useState } from "react";

import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";

import { isIdea } from "../lib/idea";
import { NOT_LISTED_LINE, notListedYet } from "../lib/listing";
import type { Launch, LaunchStage } from "../models";
import { useChangeOwnRecord } from "../use-own-record";
import { LOST_CHANGE_WORDS, useRecordAgreement } from "../use-record-agreement";

/**
 * Whether the project is listed, said on its page. Everyone who opens a project that is not listed reads that it is
 * not; its founder also gets the one button that changes it, and reads what being listed means before pressing it.
 *
 * What was chosen is shown at once, because the server can take seconds to show the record back, and only until the
 * record read back agrees: a failed save, or a save another change replaced, puts the record's own words back with
 * the reason and what to do.
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
  const recorded = notListedYet(launch.record);
  // What the founder chose here is shown at once, and only until the record read back says the same. If a newer
  // record arrives without it (another save replaced it), the page goes back to what the record says, and says why.
  const chosen = useRecordAgreement(
    launch.record.createdAt,
    (key) => recorded === (key === "unlisted"),
    (_key, why) => setFailure({ text: LOST_CHANGE_WORDS[why], detail: null }),
  );
  const ahead = chosen.waiting[0];
  const unlisted = ahead === undefined ? recorded : ahead === "unlisted";
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
    const key = next ? "unlisted" : "listed";
    setBusy(true);
    setFailure(null);
    chosen.drop(next ? "listed" : "unlisted");
    chosen.begin(key);
    try {
      const done = await change(launch.record.id, (own) =>
        notListedYet(own) === next
          ? null
          : { listing: next ? "unlisted" : undefined },
      );
      chosen.saved(key, done.signedAt);
    } catch (cause) {
      chosen.drop(key);
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
              ? "Listing it shows it in Discover and on Home."
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
