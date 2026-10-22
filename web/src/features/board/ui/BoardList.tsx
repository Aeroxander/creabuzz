/**
 * The board's list of posts: sorting, the filter for proposals, the composer, and the "show" button that keeps the
 * list still while it is read. Above them, the board's rules; pinned threads come first, and locked ones say so. The
 * Moderation button opens who moderates the board and its public moderation log.
 *
 * Proposal posts are not ranked by votes. With "Proposals" chosen the order is fixed (decisions that can still change
 * first, then latest activity) and the sort buttons are hidden, because a vote on a board is not the DAO's vote.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { Channel } from "@/features/channels/use-channels";
import type { Profile } from "@/features/profiles/use-profiles";
import { needAccountTo } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { liveRefusalText, whenText } from "@/shared/lib/refusal-text";
import { Button } from "@/shared/ui/button";

import {
  arrange,
  type Board,
  type BoardFilter,
  type BoardPost,
  type BoardSort,
  filterPosts,
  SORT_LABELS,
} from "../lib/board-model";
import {
  type BoardState,
  type LogEntry,
  pinnedFirst,
} from "../lib/board-moderation";
import { type PostStatus, priorityMap } from "../lib/post-status";
import { type BoardRecords, POST_LIMIT } from "../use-board";
import type { BoardActions } from "../use-board-actions";
import type { BoardModerationActions } from "../use-board-moderation";
import { BoardModerationPanel } from "./BoardModerationPanel";
import { BoardPeople } from "./BoardPeople";
import { BoardRules } from "./BoardRules";
import { JoinBoardButton } from "./JoinBoardButton";
import { PostComposer } from "./PostComposer";
import { PostRow } from "./PostRow";

const SORTS = Object.keys(SORT_LABELS) as BoardSort[];

function needAccount(action: string): boolean {
  if (existingUserPubkey() !== null) return true;
  toast.error(needAccountTo(action));
  return false;
}

/** The board's moderation, as the list shows and offers it. */
export interface BoardListModeration {
  state: BoardState;
  log: LogEntry[];
  me: string | null;
  canModerate: boolean;
  canManage: boolean;
  /** When the reader's mute on this board ends (unix seconds), if they are muted. */
  mutedUntil: number | null;
  actions: BoardModerationActions;
  /** May the reader undo what this person did (lift their mute)? */
  mayUndoBy: (placer: string | undefined) => boolean;
  /** A post's title, when the board has it. */
  titleOf: (post: string) => string | null;
  onOpenPost: (id: string) => void;
  /** People the reader could appoint as moderators. */
  candidates: string[];
}

function sameOrder(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((id, i) => id === b[i]);
}

export function BoardList({
  channel,
  board,
  records,
  actions,
  me,
  profiles,
  onOpenPost,
  suggestPeopleFrom,
  statuses,
  statusesReady,
  moderation,
}: {
  channel: Channel;
  moderation: BoardListModeration;
  board: Board;
  records: BoardRecords;
  actions: BoardActions;
  me: string | null;
  profiles: Record<string, Profile> | undefined;
  onOpenPost: (id: string) => void;
  suggestPeopleFrom: string | null;
  /** Where each proposal post's decision stands, by post id. */
  statuses: ReadonlyMap<string, PostStatus>;
  /** False while the decisions are still being read, so the order is not taken on half the facts. */
  statusesReady: boolean;
}) {
  const [sort, setSort] = useState<BoardSort>("active");
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [composing, setComposing] = useState(false);
  const [showingPeople, setShowingPeople] = useState(false);
  const [showingModeration, setShowingModeration] = useState(false);
  const mutedReason =
    moderation.mutedUntil !== null
      ? `You are muted on this board until ${whenText(moderation.mutedUntil)}.`
      : null;
  const [frozen, setFrozen] = useState<string[] | null>(null);

  const proposalsView = filter === "proposals";
  const visible = useMemo(
    () => filterPosts(board.posts, filter),
    [board.posts, filter],
  );
  const priority = useMemo(
    () =>
      proposalsView
        ? priorityMap(
            visible.map((post) => post.id),
            statuses,
          )
        : undefined,
    [proposalsView, visible, statuses],
  );
  const arrangement = useMemo(
    () =>
      arrange({
        posts: visible,
        sort: proposalsView ? "active" : sort,
        frozen,
        me,
        priority,
      }),
    [visible, sort, proposalsView, frozen, me, priority],
  );

  // Take the order once the posts are in (and, for proposals, once their decisions have been read), and again
  // whenever it is asked for (a different sort or filter, or "show"); after that it only changes by the reader's own
  // posts arriving or posts being deleted.
  useEffect(() => {
    if (records.isLoading || (proposalsView && !statusesReady)) return;
    setFrozen((previous) =>
      sameOrder(previous, arrangement.order) ? previous : arrangement.order,
    );
  }, [arrangement.order, records.isLoading, proposalsView, statusesReady]);

  const hasProposals = board.posts.some((post) => post.proposal !== null);

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
          {proposalsView ? null : (
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
          )}
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
            aria-expanded={showingModeration}
            data-testid="board-moderation-toggle"
            onClick={() => setShowingModeration((v) => !v)}
            size="sm"
            variant="outline"
          >
            Moderation
          </Button>
          {channel.visibility === "public" ? (
            <JoinBoardButton boardId={channel.id} boardName={channel.name} />
          ) : null}
          <Button
            aria-describedby={
              mutedReason !== null ? "board-muted-note" : undefined
            }
            data-testid="board-new-post"
            disabled={mutedReason !== null}
            onClick={() => {
              if (needAccount("post")) setComposing(true);
            }}
            size="sm"
            title={mutedReason ?? undefined}
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

      {showingModeration ? (
        <BoardModerationPanel
          actions={moderation.actions}
          canManage={moderation.canManage}
          canModerate={moderation.canModerate}
          candidates={moderation.candidates}
          log={moderation.log}
          mayUndoBy={moderation.mayUndoBy}
          me={moderation.me}
          onOpenPost={moderation.onOpenPost}
          state={moderation.state}
          titleOf={moderation.titleOf}
        />
      ) : null}

      {records.liveStatus && records.liveStatus !== "open" ? (
        <p
          className="px-4 pt-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="board-live-status"
          role="status"
        >
          {records.liveStatus === "refused"
            ? liveRefusalText(records.liveRefusal)
            : records.liveStatus === "connecting"
              ? "Connecting for live updates…"
              : "Live updates paused. Reconnecting…"}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 p-4">
        <BoardRules
          canEdit={moderation.canManage}
          onSave={moderation.actions.setRules}
          rules={moderation.state.rules}
        />
        {moderation.mutedUntil !== null ? (
          <p
            className="rounded-xl border bg-secondary/30 p-3 text-sm"
            data-testid="board-muted-note"
            id="board-muted-note"
            role="status"
          >
            You are muted on this board until{" "}
            {new Date(moderation.mutedUntil * 1000).toLocaleString()}. You can
            still read it, and post everywhere else.
          </p>
        ) : null}
        {composing ? (
          <PostComposer
            onCancel={() => setComposing(false)}
            onSubmit={async (title, body) => {
              await actions.createPost({ title, body });
              setComposing(false);
            }}
          />
        ) : null}

        <div
          aria-live="polite"
          className="sticky top-2 z-10 self-center"
          role="status"
        >
          {pending ? (
            <button
              className="rounded-full border bg-card px-4 py-1.5 text-xs font-medium shadow-sm"
              data-testid="board-show-new"
              onClick={() => setFrozen(null)}
              type="button"
            >
              {pillText}. Show
            </button>
          ) : null}
        </div>

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
            {pinnedFirst(arrangement.rows, moderation.state.pinned).map(
              (post) => (
                <PostRow
                  key={post.id}
                  voteDisabledReason={mutedReason}
                  locked={moderation.state.locked.has(post.id)}
                  pinned={moderation.state.pinned.includes(post.id)}
                  onOpen={() => onOpenPost(post.id)}
                  onVote={(direction) => vote(post, direction)}
                  post={post}
                  profile={profiles?.[post.author]}
                  status={statuses.get(post.id)}
                />
              ),
            )}
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
