import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { LaunchRecord } from "@/features/launchpad/models";
import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";

import { EMPTY_TALLY, type SortMode } from "../lib/ranking";
import {
  type PinnedUpdatable,
  generateThreadSummary,
  newestSummary,
  pinnedUpdates,
  readSummaryOptIn,
  writeSummaryOptIn,
} from "../lib/launch-thread";
import {
  useLaunchNotes,
  useLaunchSummaries,
  useVoteTallies,
} from "../use-feed";
import { Composer } from "./Composer";
import { launchCoord, launchRef, launchVoteTarget } from "./LaunchVoteCard";
import { ThreadList } from "./ThreadList";
import { VoteButtons } from "./VoteButtons";

/** The founder's own updates, pinned above the replies, newest first. */
function PinnedUpdates({ updates }: { updates: PinnedUpdatable[] }) {
  if (updates.length === 0) return null;
  return (
    <section
      aria-label="Pinned founder updates"
      className="mt-3 flex flex-col gap-2"
      data-testid="pinned-updates"
    >
      {updates.map((update) => (
        <article
          className="glass rounded-xl border p-3"
          key={update.id}
          data-testid="pinned-update"
        >
          <p className="flex flex-wrap items-center gap-2 text-2xs text-black/60 dark:text-white/60">
            <span className="rounded-full bg-black/10 px-2 py-0.5 font-medium text-black/70 dark:bg-white/15 dark:text-white/70">
              Pinned · founder update
            </span>
            {relativeTime(update.createdAt)}
          </p>
          <h3 className="mt-1 text-sm font-semibold text-black dark:text-white">
            {update.title}
          </h3>
          <p className="mt-0.5 text-sm whitespace-pre-wrap text-black/80 dark:text-white/80">
            {update.body}
          </p>
        </article>
      ))}
    </section>
  );
}

/**
 * The launch's official feed. The team (the founder and anyone listed on the
 * record) posts here; everyone else replies and votes. A supporter's own post
 * about the launch carries its coordinate and shows up in the Creaton feed
 * with the launch's chip, so it is never lost — it just isn't pinned into the
 * team's channel. The founder's updates sit pinned at the top, and when the
 * founder has opted in, the launch's agent may leave a thread summary —
 * rendered as its own card, badged as the agent's words.
 */
export function LaunchDiscussion({
  record,
  updates = [],
}: {
  record: LaunchRecord;
  updates?: readonly PinnedUpdatable[];
}) {
  const coord = launchCoord(record);
  const notes = useLaunchNotes(coord);
  const { tallies } = useVoteTallies();
  const [mode, setMode] = useState<SortMode>("hot");
  const me = existingUserPubkey();
  const isFounder = me === record.author;
  const teamKeys = useMemo(
    () => new Set([record.author, ...record.team.map((t) => t.pubkey)]),
    [record.author, record.team],
  );
  const isTeam = me !== null && teamKeys.has(me);
  // Top-level posts from the team, and every reply under them.
  const teamNotes = useMemo(() => {
    const all = notes.data ?? [];
    const roots = new Set(
      all.filter((n) => !n.rootId && teamKeys.has(n.author)).map((n) => n.id),
    );
    return all.filter((n) =>
      n.rootId ? roots.has(n.rootId) : roots.has(n.id),
    );
  }, [notes.data, teamKeys]);
  const [optIn, setOptIn] = useState(() => readSummaryOptIn(coord));
  const { summaries } = useLaunchSummaries(coord);
  const summary = newestSummary(summaries);
  const [note, setNote] = useState<string | null>(null);

  const toggleOptIn = () => {
    const next = !optIn;
    writeSummaryOptIn(coord, next);
    setOptIn(next);
  };

  const summarize = async () => {
    setNote(null);
    try {
      await generateThreadSummary({
        launchCoord: coord,
        thread: (notes.data ?? []).map((n) => n.event),
      });
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

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
        {isFounder ? (
          <div className="flex items-center gap-2">
            <button
              aria-checked={optIn}
              className="rounded-full border border-black/15 px-3 py-1 text-xs font-medium text-black/70 hover:bg-black/5 dark:border-white/15 dark:text-white/70 dark:hover:bg-white/10"
              data-testid="summary-optin"
              onClick={toggleOptIn}
              role="switch"
              type="button"
            >
              Agent thread summaries
            </button>
            {optIn ? (
              <button
                className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-black"
                data-testid="summary-generate"
                onClick={() => void summarize()}
                type="button"
              >
                Summarize thread
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {note ? (
        <p
          className="mt-2 text-2xs text-black/60 dark:text-white/60"
          data-testid="summary-note"
          role="status"
        >
          {note}
        </p>
      ) : null}
      <PinnedUpdates updates={pinnedUpdates(updates)} />
      {summary ? (
        <article
          className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3"
          data-testid="thread-summary-card"
        >
          <p className="text-2xs font-medium text-sky-700 dark:text-sky-300">
            Summarized by agent {truncatePubkey(summary.author)}
          </p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-black/80 dark:text-white/80">
            {summary.text}
          </p>
        </article>
      ) : null}
      <div className="mt-3">
        {isTeam ? (
          <Composer
            launch={launchRef(record)}
            placeholder={`Post to ${record.name}'s backers`}
            testId="launch-composer"
          />
        ) : (
          <p
            className="glass rounded-xl border px-4 py-3 text-sm text-muted-foreground"
            data-testid="launch-team-only"
          >
            The team posts here; you can reply to any post and vote. Want to
            share your own take on {record.name}?{" "}
            <Link
              className="font-semibold text-primary-ink underline"
              to="/social"
            >
              Post it in the Creaton feed
            </Link>
            .
          </p>
        )}
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
                The team hasn't posted about {record.name} yet.
              </p>
            }
            mode={mode}
            notes={teamNotes}
            testId="discussion-list"
          />
        )}
      </div>
    </section>
  );
}
