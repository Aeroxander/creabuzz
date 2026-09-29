import { useState } from "react";

import type { LaunchRecord } from "@/features/launchpad/models";
import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";

import { EMPTY_TALLY, type SortMode } from "../lib/ranking";
import { useLaunchNotes, useVoteTallies } from "../use-feed";
import { Composer } from "./Composer";
import { launchCoord, launchRef, launchVoteTarget } from "./LaunchVoteCard";
import { ThreadList } from "./ThreadList";
import { VoteButtons } from "./VoteButtons";

/**
 * The launch's public discussion: anyone can post about it (the post carries
 * the launch's coordinate, so it also appears in the Home feed), reply, and
 * vote on the launch itself.
 */
export function LaunchDiscussion({ record }: { record: LaunchRecord }) {
  const coord = launchCoord(record);
  const notes = useLaunchNotes(coord);
  const { tallies } = useVoteTallies();
  const [mode, setMode] = useState<SortMode>("hot");

  return (
    <section aria-label="Discussion" data-testid="launch-discussion">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <VoteButtons
            label={record.name}
            launch={launchRef(record)}
            tally={tallies.get(coord) ?? EMPTY_TALLY}
            target={launchVoteTarget(record)}
            testId="launch-vote"
          />
          <span className="text-sm text-black/60 dark:text-white/60">
            Support this launch
          </span>
        </div>
      </div>
      <div className="mt-3">
        <Composer
          launch={launchRef(record)}
          placeholder={`What do you think of ${record.name}?`}
          testId="launch-composer"
        />
      </div>
      <div className="mt-3 flex gap-1" role="tablist" aria-label="Sort posts">
        {(["hot", "new", "top"] as const).map((m) => (
          <button
            aria-selected={mode === m}
            className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
              mode === m
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            }`}
            key={m}
            onClick={() => setMode(m)}
            role="tab"
            type="button"
          >
            {m}
          </button>
        ))}
      </div>
      <div className="mt-3">
        {notes.isError ? (
          <QueryError
            description="The server did not answer the discussion query."
            error={notes.error}
            kinds={[KIND_TEXT_NOTE]}
            onRetry={() => void notes.refetch()}
            relayUrl={relayWsUrl()}
            testId="discussion-error"
            title="Couldn't load the discussion"
          />
        ) : notes.isLoading ? (
          <p className="text-sm text-black/60 dark:text-white/60" role="status">
            Loading the discussion…
          </p>
        ) : (
          <ThreadList
            empty={
              <p
                className="rounded-xl border border-dashed border-black/15 p-6 text-center text-sm text-black/60 dark:border-white/15 dark:text-white/60"
                data-testid="discussion-empty"
              >
                No one has posted about {record.name} yet.
              </p>
            }
            mode={mode}
            notes={notes.data ?? []}
            testId="discussion-list"
          />
        )}
      </div>
    </section>
  );
}
