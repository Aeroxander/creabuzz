import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { LaunchRecord } from "@/features/launchpad/models";
import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { useUserNames } from "@/features/profiles/use-profiles";
import { relativeTime } from "@/shared/lib/relative-time";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";
import { useLaunchUpdates } from "@/features/social/use-launch-updates";

import { EMPTY_TALLY, type SortMode } from "../lib/ranking";
import {
  type PinnedUpdatable,
  newestSummary,
  pinnedUpdates,
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
              Pinned · team update
            </span>
            {relativeTime(update.createdAt)}
          </p>
          {update.title ? (
            <h3 className="mt-1 text-sm font-semibold text-black dark:text-white">
              {update.title}
            </h3>
          ) : null}
          <p className="mt-0.5 text-sm whitespace-pre-wrap break-words text-black/80 [overflow-wrap:anywhere] dark:text-white/80">
            {update.body}
          </p>
          {update.replyTo ? (
            <Link
              className="mt-2 inline-block text-sm font-semibold text-primary-ink underline"
              data-testid="pinned-update-reply"
              params={{ id: update.replyTo }}
              to="/social/post/$id"
            >
              Reply
            </Link>
          ) : null}
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
 * team's channel. The founder's updates sit pinned at the top; one posted on
 * Home carries a Reply link to its own thread. A thread summary someone
 * published is rendered as its own card, badged as the agent's words.
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
  const teamKeys = useMemo(
    () => new Set([record.author, ...record.team.map((t) => t.pubkey)]),
    [record.author, record.team],
  );
  const isTeam = me !== null && teamKeys.has(me);
  // Launch-mode posts from the team pin to the top like the older founder
  // updates, and leave the thread list below so they are not shown twice.
  const allUpdates = useLaunchUpdates().updates;
  const launchUpdates = useMemo(
    () => allUpdates.filter((u) => u.coord === coord),
    [allUpdates, coord],
  );
  const pinnedFromPosts: PinnedUpdatable[] = useMemo(
    () =>
      launchUpdates.map((u) => ({
        id: u.id,
        author: u.author,
        createdAt: u.at,
        title: "",
        body: u.event.content.replace(/\n*nostr:naddr1\w+/g, "").trim(),
        replyTo: u.id,
      })),
    [launchUpdates],
  );
  const pinned = pinnedUpdates([...updates, ...pinnedFromPosts]);
  const pinnedCount = pinned.length;
  // Top-level posts from the team, and every reply under them.
  const teamNotes = useMemo(() => {
    const all = notes.data ?? [];
    const roots = new Set(
      all.filter((n) => !n.rootId && teamKeys.has(n.author)).map((n) => n.id),
    );
    const pinned = new Set(launchUpdates.map((u) => u.id));
    return all.filter(
      (n) =>
        !pinned.has(n.id) && (n.rootId ? roots.has(n.rootId) : roots.has(n.id)),
    );
  }, [notes.data, teamKeys, launchUpdates]);
  const { summaries } = useLaunchSummaries(coord);
  const summary = newestSummary(summaries);
  const nameOf = useUserNames(summary ? [summary.author] : []);
  // Whether anything pinned takes a reply: a team post made on Home does, a record-only update does not.
  const replyable = pinned.some((update) => update.replyTo);

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
            Support this project
          </span>
        </div>
      </div>
      <PinnedUpdates updates={pinned} />
      {summary ? (
        <article
          className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3"
          data-testid="thread-summary-card"
        >
          <p className="text-2xs font-medium text-sky-700 dark:text-sky-300">
            Summarized by agent {nameOf(summary.author)}
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
            placeholder={`Tell people how ${record.name} is going`}
            testId="launch-composer"
          />
        ) : (
          <p
            className="glass rounded-xl border px-4 py-3 text-sm text-muted-foreground"
            data-testid="launch-team-only"
          >
            {replyable
              ? "The team posts here, and you can reply to their posts. "
              : "The team posts here. "}
            Want to share your own take on {record.name}?{" "}
            <Link
              className="font-semibold text-primary-ink underline"
              to="/social"
            >
              Post it on Home
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
                {replyable
                  ? "No replies yet. Reply to an update above."
                  : pinnedCount > 0
                    ? "No replies yet."
                    : `The team hasn't posted about ${record.name} yet.`}
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
