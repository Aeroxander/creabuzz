/**
 * The boards front page on Home: every board's posts in one list, Hot, New or Top, with each board one tap away and
 * a "New post" that asks which board it goes on. Voting works from the list; a post opens on its board's own page.
 *
 * The order is taken when the posts arrive and when the reader picks a sort, so a vote does not make the post under
 * the cursor jump; the counts change in place.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { needAccountTo } from "@/features/identity/lib/account-copy";
import { usePeople } from "@/features/social/use-people";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { QueryError } from "@/shared/ui/query-error";

import {
  FEED_SORT_LABELS,
  type FeedPost,
  type FeedSort,
  sortFeed,
} from "../lib/board-feed";
import type { BoardEvent } from "../lib/board-model";
import { useBoardActions } from "../use-board-actions";
import { FEED_POST_LIMIT, useBoardFeed } from "../use-board-feed";
import { PostComposer } from "./PostComposer";
import { PostRow } from "./PostRow";

const SORTS = Object.keys(FEED_SORT_LABELS) as FeedSort[];

function needAccount(action: string): boolean {
  if (existingUserPubkey() !== null) return true;
  toast.error(needAccountTo(action));
  return false;
}

/** One post in the mixed list; votes go to the post's own board. */
function FeedRow({
  post,
  board,
  profile,
  add,
}: {
  post: FeedPost;
  board: { id: string; name: string };
  profile: Parameters<typeof PostRow>[0]["profile"];
  add: (event: BoardEvent) => void;
}) {
  const actions = useBoardActions(post.boardId, add);
  const navigate = useNavigate();
  return (
    <PostRow
      board={board}
      onOpen={() =>
        void navigate({
          to: "/b/$boardId",
          params: { boardId: post.boardId },
          search: { post: post.id },
        })
      }
      onVote={(direction) => {
        if (!needAccount("vote")) return;
        actions.vote(post.id, direction, post).catch((error) =>
          toast.error("Couldn't vote", {
            description: error instanceof Error ? error.message : String(error),
          }),
        );
      }}
      post={post}
      profile={profile}
    />
  );
}

/** "New post" from the front page: pick the board, then the usual form. */
function FeedComposer({
  boards,
  onDone,
}: {
  boards: readonly { id: string; name: string }[];
  onDone: (boardId: string, postId: string) => void;
}) {
  const [boardId, setBoardId] = useState(boards[0]?.id ?? "");
  const actions = useBoardActions(boardId, () => {});
  return (
    <div className="flex flex-col gap-2" data-testid="board-feed-composer">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Post on</span>
        <select
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          data-testid="board-feed-composer-board"
          onChange={(event) => setBoardId(event.target.value)}
          value={boardId}
        >
          {boards.map((board) => (
            <option key={board.id} value={board.id}>
              {board.name}
            </option>
          ))}
        </select>
      </label>
      <PostComposer
        onCancel={() => onDone("", "")}
        onSubmit={async (title, body) => {
          const signed = await actions.createPost({ title, body });
          onDone(boardId, signed.id);
        }}
      />
    </div>
  );
}

export function BoardFeed() {
  const feed = useBoardFeed();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<FeedSort>("hot");
  const [composing, setComposing] = useState(false);
  const [order, setOrder] = useState<string[] | null>(null);

  const boardList = useMemo(
    () =>
      [...feed.boards.entries()]
        .map(([id, board]) => ({ id, ...board }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [feed.boards],
  );

  // Hold the order still: take it when posts first arrive or the sort changes, not on every vote.
  const ready = !feed.isLoading;
  const postCount = feed.posts.length;
  // feed.posts changes on every vote; only a new set of posts (or a new sort) re-sorts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: held still on purpose, see above
  useEffect(() => {
    if (!ready) return;
    setOrder(
      sortFeed(feed.posts, sort, Math.floor(Date.now() / 1000)).map(
        (p) => p.id,
      ),
    );
  }, [ready, sort, postCount]);

  const rows = useMemo(() => {
    const byId = new Map(feed.posts.map((post) => [post.id, post]));
    return (order ?? [])
      .map((id) => byId.get(id))
      .filter((post): post is FeedPost => post !== undefined);
  }, [order, feed.posts]);

  const profiles = usePeople(
    useMemo(() => rows.map((post) => post.author), [rows]),
  );

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="board-feed">
      <div className="flex flex-wrap items-center gap-2">
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
              data-testid={`board-feed-sort-${key}`}
              key={key}
              onClick={() => setSort(key)}
              type="button"
            >
              {FEED_SORT_LABELS[key]}
            </button>
          ))}
        </fieldset>
        <Button
          aria-label="Refresh boards"
          onClick={feed.refetch}
          size="sm"
          title="Refresh"
          variant="ghost"
        >
          <RefreshCw aria-hidden className="h-4 w-4" />
        </Button>
        {boardList.length > 0 ? (
          <Button
            className="ml-auto"
            data-testid="board-feed-new-post"
            onClick={() => {
              if (needAccount("post")) setComposing(true);
            }}
            size="sm"
          >
            New post
          </Button>
        ) : null}
      </div>

      {boardList.length > 0 ? (
        <nav aria-label="Boards" className="-mx-3 overflow-x-auto px-3">
          <ul className="flex gap-2" data-testid="board-feed-boards">
            {boardList.map((board) => (
              <li key={board.id}>
                <Link
                  className="block whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium hover:bg-secondary"
                  params={{ boardId: board.id }}
                  title={board.description || undefined}
                  to="/b/$boardId"
                >
                  {board.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {composing ? (
        <FeedComposer
          boards={boardList}
          onDone={(boardId, postId) => {
            setComposing(false);
            if (boardId && postId) {
              void queryClient.invalidateQueries({ queryKey: ["board-feed"] });
              void navigate({
                to: "/b/$boardId",
                params: { boardId },
                search: { post: postId },
              });
            }
          }}
        />
      ) : null}

      {feed.error ? (
        <QueryError
          description="The server did not answer, so no board posts can be shown."
          error={feed.error}
          onRetry={feed.refetch}
          testId="board-feed-error"
          title="Couldn't load the boards"
        />
      ) : feed.isLoading || order === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading posts…
        </p>
      ) : boardList.length === 0 ? (
        <p
          className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground"
          data-testid="board-feed-no-boards"
        >
          This server has no boards yet. A community's owners can add one from
          its workspace.
        </p>
      ) : rows.length === 0 ? (
        <p
          className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground"
          data-testid="board-feed-empty"
        >
          No posts yet. Start the first discussion.
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="board-feed-posts">
          {rows.map((post) => (
            <FeedRow
              add={feed.add}
              board={{
                id: post.boardId,
                name: feed.boards.get(post.boardId)?.name ?? "Board",
              }}
              key={post.id}
              post={post}
              profile={profiles?.[post.author]}
            />
          ))}
        </ul>
      )}
      {feed.truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the newest {FEED_POST_LIMIT} posts.
        </p>
      ) : null}
    </div>
  );
}
