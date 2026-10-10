/**
 * A board: posts people want to talk about, newest activity first.
 *
 * The page is live (replies, votes and new posts arrive without a reload) but
 * it holds still while it is read: counts and scores change in place, a post
 * does not jump because someone replied, and other people's new posts wait
 * behind a "show" button so the one under the cursor never moves. The reader's
 * own post goes straight to the top.
 *
 * What is decided (ordering, scoring, which posts are held back) is in
 * `../lib/board-model.ts`; this file shows it.
 */

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { needAccountTo } from "@/features/identity/lib/account-copy";
import type { Channel } from "@/features/channels/use-channels";
import { useProfiles } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { QueryError } from "@/shared/ui/query-error";

import {
  arrange,
  type BoardFilter,
  type BoardPost,
  type BoardSort,
  buildBoard,
  filterPosts,
  SORT_LABELS,
} from "../lib/board-model";
import { POST_LIMIT, useBoardRecords } from "../use-board";
import { useBoardActions } from "../use-board-actions";
import { BoardPeople } from "./BoardPeople";
import { PostComposer } from "./PostComposer";
import { PostRow } from "./PostRow";
import { PostThread } from "./PostThread";

const SORTS = Object.keys(SORT_LABELS) as BoardSort[];

function needAccount(action: string): boolean {
  if (existingUserPubkey() !== null) return true;
  toast.error(needAccountTo(action));
  return false;
}

function sameOrder(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((id, i) => id === b[i]);
}

export function BoardView({
  channel,
  postId,
  onOpenPost,
  renderPostHeader,
  suggestPeopleFrom = null,
}: {
  channel: Channel;
  /** A channel whose speakers are offered as people to add to a private board. */
  suggestPeopleFrom?: string | null;
  /** The post that is open, if any (kept in the address so it can be linked to). */
  postId: string | undefined;
  onOpenPost: (id: string | null) => void;
  /** A header for a post that says it is about something else, such as a DAO decision. */
  renderPostHeader?: (post: BoardPost) => ReactNode;
}) {
  const records = useBoardRecords(channel.id);
  const me = existingUserPubkey();
  const actions = useBoardActions(channel.id, records.add);
  const board = useMemo(
    () => buildBoard(records.events, me),
    [records.events, me],
  );

  const [sort, setSort] = useState<BoardSort>("active");
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [composing, setComposing] = useState(false);
  const [showingPeople, setShowingPeople] = useState(false);
  const [frozen, setFrozen] = useState<string[] | null>(null);

  const visible = useMemo(
    () => filterPosts(board.posts, filter),
    [board.posts, filter],
  );
  const arrangement = useMemo(
    () => arrange({ posts: visible, sort, frozen, me }),
    [visible, sort, frozen, me],
  );

  // Take the order once the posts are in, and again whenever it is asked for
  // (a different sort or filter, or "show"); after that it only changes by the
  // reader's own posts arriving or posts being deleted.
  useEffect(() => {
    if (records.isLoading) return;
    setFrozen((previous) =>
      sameOrder(previous, arrangement.order) ? previous : arrangement.order,
    );
  }, [arrangement.order, records.isLoading]);

  const authors = useMemo(() => {
    const set = new Set(board.posts.map((p) => p.author));
    for (const list of board.comments.values())
      for (const c of list) set.add(c.author);
    return [...set];
  }, [board]);
  const profiles = useProfiles(authors).data;

  const hasProposals = board.posts.some((post) => post.proposal !== null);
  const open = postId
    ? board.posts.find((post) => post.id === postId)
    : undefined;

  if (records.error) {
    return (
      <div className="p-4">
        <QueryError
          description={`We couldn't load #${channel.name}.`}
          error={records.error}
          onRetry={records.refetch}
          testId="board-error"
          title="Couldn't load this board"
        />
      </div>
    );
  }

  if (postId) {
    return open ? (
      <PostThread
        actions={actions}
        comments={board.comments.get(open.id) ?? []}
        header={renderPostHeader?.(open)}
        me={me}
        needAccount={needAccount}
        onBack={() => onOpenPost(null)}
        post={open}
        profiles={profiles}
      />
    ) : (
      <div className="p-6 text-sm" data-testid="board-missing-post">
        {records.isLoading ? (
          <p className="text-muted-foreground" role="status">
            Loading…
          </p>
        ) : (
          <>
            <p>This post isn't here. It may have been deleted.</p>
            <Button
              className="mt-3"
              onClick={() => onOpenPost(null)}
              size="sm"
              variant="outline"
            >
              Back to the board
            </Button>
          </>
        )}
      </div>
    );
  }

  const pending = arrangement.fresh > 0 || arrangement.reordered;
  const pillText =
    arrangement.fresh > 0
      ? arrangement.fresh === 1
        ? "1 new post"
        : `${arrangement.fresh} new posts`
      : "New activity";

  const vote = (post: BoardPost, direction: "up" | "down") => {
    if (!needAccount("vote")) return;
    actions.vote(post.id, direction, post).catch((error) =>
      toast.error("Couldn't vote", {
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="board"
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold" data-testid="board-name">
            {channel.name}
          </h2>
          {channel.description ? (
            <p className="truncate text-xs text-muted-foreground">
              {channel.description}
            </p>
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <fieldset className="m-0 flex min-w-0 rounded-md border p-0.5">
            <legend className="sr-only">Sort posts</legend>
            {SORTS.map((key) => (
              <button
                aria-pressed={sort === key}
                className={`rounded px-2.5 py-1 text-xs font-medium ${
                  sort === key
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60"
                }`}
                data-testid={`board-sort-${key}`}
                key={key}
                onClick={() => {
                  setSort(key);
                  setFrozen(null);
                }}
                type="button"
              >
                {SORT_LABELS[key]}
              </button>
            ))}
          </fieldset>
          {hasProposals ? (
            <fieldset className="m-0 flex min-w-0 rounded-md border p-0.5">
              <legend className="sr-only">Show</legend>
              {(["all", "proposals"] as const).map((key) => (
                <button
                  aria-pressed={filter === key}
                  className={`rounded px-2.5 py-1 text-xs font-medium ${
                    filter === key
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60"
                  }`}
                  data-testid={`board-filter-${key}`}
                  key={key}
                  onClick={() => {
                    setFilter(key);
                    setFrozen(null);
                  }}
                  type="button"
                >
                  {key === "all" ? "All" : "Proposals"}
                </button>
              ))}
            </fieldset>
          ) : null}
          {channel.visibility === "private" ? (
            <Button
              aria-expanded={showingPeople}
              data-testid="board-people-toggle"
              onClick={() => setShowingPeople((v) => !v)}
              size="sm"
              variant="outline"
            >
              People
            </Button>
          ) : null}
          <Button
            data-testid="board-new-post"
            onClick={() => {
              if (needAccount("post")) setComposing(true);
            }}
            size="sm"
          >
            New post
          </Button>
        </div>
      </header>

      {showingPeople && channel.visibility === "private" ? (
        <BoardPeople
          boardId={channel.id}
          suggestFromChannelId={suggestPeopleFrom}
        />
      ) : null}

      {records.liveStatus && records.liveStatus !== "open" ? (
        <p
          className="px-4 pt-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="board-live-status"
          role="status"
        >
          {records.liveStatus === "connecting"
            ? "Connecting for live updates…"
            : "Live updates paused. Reconnecting…"}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 p-4">
        {composing ? (
          <PostComposer
            onCancel={() => setComposing(false)}
            onSubmit={async (title, body) => {
              await actions.createPost({ title, body });
              setComposing(false);
            }}
          />
        ) : null}

        {pending ? (
          <button
            className="sticky top-2 z-10 self-center rounded-full border bg-card px-4 py-1.5 text-xs font-medium shadow-sm"
            data-testid="board-show-new"
            onClick={() => setFrozen(null)}
            type="button"
          >
            {pillText}. Show
          </button>
        ) : null}

        {records.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading posts…
          </p>
        ) : arrangement.rows.length === 0 && arrangement.fresh === 0 ? (
          <p
            className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground"
            data-testid="board-empty"
          >
            {filter === "proposals"
              ? "No decisions are being discussed yet."
              : "No posts yet. Start the first discussion."}
          </p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="board-posts">
            {arrangement.rows.map((post) => (
              <PostRow
                key={post.id}
                onOpen={() => onOpenPost(post.id)}
                onVote={(direction) => vote(post, direction)}
                post={post}
                profile={profiles?.[post.author]}
              />
            ))}
          </ul>
        )}
        {records.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the newest {POST_LIMIT} posts.
          </p>
        ) : null}
      </div>
    </div>
  );
}
