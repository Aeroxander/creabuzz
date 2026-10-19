/**
 * The boards front page on Home: the posts of the boards you joined (or of every board), Hot, New or Top (by day, week,
 * month or all time), with each board one tap away and a "New post" that asks which board it goes on. Voting works from
 * the list; a post opens on its board's own page. New posts by other people are counted live and shown on request, and
 * older posts are read a page at a time.
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
  FEED_PERIOD_LABELS,
  FEED_SORT_LABELS,
  type FeedPeriod,
  type FeedPost,
  type FeedSort,
  sortFeed,
  withinPeriod,
} from "../lib/board-feed";
import type { BoardEvent } from "../lib/board-model";
import { useBoardActions } from "../use-board-actions";
import { useBoardFeed } from "../use-board-feed";
import { useMyBoards } from "../use-my-boards";
import { PostComposer } from "./PostComposer";
import { PostRow } from "./PostRow";
import { StartBoardForm } from "./StartBoardForm";

const SORTS = Object.keys(FEED_SORT_LABELS) as FeedSort[];
const PERIODS = Object.keys(FEED_PERIOD_LABELS) as FeedPeriod[];
type Scope = "mine" | "all";

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
  const mine = useMyBoards();
  const [chosenScope, setChosenScope] = useState<Scope | null>(null);
  // Until the reader picks, show their boards when they have joined any, and every board otherwise.
  const scope: Scope = chosenScope ?? (mine.joined.size > 0 ? "mine" : "all");
  const joinedIds = useMemo(() => [...mine.joined.keys()], [mine.joined]);
  const feed = useBoardFeed({
    scope: scope === "mine" ? joinedIds : null,
    enabled: !mine.isLoading,
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sort, setSort] = useState<FeedSort>("hot");
  const [period, setPeriod] = useState<FeedPeriod>("week");
  const [composing, setComposing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [order, setOrder] = useState<string[] | null>(null);

  // Joined boards first, then the rest, each by name.
  const boardList = useMemo(
    () =>
      [...feed.boards.entries()]
        .map(([id, board]) => ({ id, ...board, joined: mine.joined.has(id) }))
        .sort(
          (a, b) =>
            Number(b.joined) - Number(a.joined) || a.name.localeCompare(b.name),
        ),
    [feed.boards, mine.joined],
  );

  // Hold the order still: take it when a new set of posts arrives (first load, older page, "show new") or the sort or
  // window changes, never on a vote, so the post under the cursor does not move.
  const ready = !feed.isLoading;
  const postKey = feed.posts
    .map((p) => p.id)
    .sort()
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: held still on purpose, see above
  useEffect(() => {
    if (!ready) return;
    const now = Math.floor(Date.now() / 1000);
    const pool =
      sort === "top" ? withinPeriod(feed.posts, period, now) : feed.posts;
    setOrder(sortFeed(pool, sort, now).map((p) => p.id));
  }, [ready, sort, period, postKey]);

  const rows = useMemo(() => {
    const byId = new Map(feed.posts.map((post) => [post.id, post]));
    return (order ?? [])
      .map((id) => byId.get(id))
      .filter((post): post is FeedPost => post !== undefined);
  }, [order, feed.posts]);

  const profiles = usePeople(
    useMemo(() => rows.map((post) => post.author), [rows]),
  );

  const choice = (active: boolean) =>
    `rounded px-2.5 py-1 text-xs font-medium ${
      active
        ? "bg-secondary text-foreground"
        : "text-muted-foreground hover:bg-secondary/60"
    }`;
  const noneJoined = scope === "mine" && mine.joined.size === 0;

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="board-feed">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="m-0 flex min-w-0 rounded-md border p-0.5">
          <legend className="sr-only">Whose boards</legend>
          {(["mine", "all"] as const).map((key) => (
            <button
              aria-pressed={scope === key}
              className={choice(scope === key)}
              data-testid={`board-feed-scope-${key}`}
              key={key}
              onClick={() => setChosenScope(key)}
              type="button"
            >
              {key === "mine" ? "Your boards" : "All boards"}
            </button>
          ))}
        </fieldset>
        <fieldset className="m-0 flex min-w-0 rounded-md border p-0.5">
          <legend className="sr-only">Sort posts</legend>
          {SORTS.map((key) => (
            <button
              aria-pressed={sort === key}
              className={choice(sort === key)}
              data-testid={`board-feed-sort-${key}`}
              key={key}
              onClick={() => setSort(key)}
              type="button"
            >
              {FEED_SORT_LABELS[key]}
            </button>
          ))}
        </fieldset>
        {sort === "top" ? (
          <label className="flex items-center gap-1 text-xs">
            <span className="sr-only">Top posts from</span>
            <select
              className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
              data-testid="board-feed-period"
              onChange={(event) => setPeriod(event.target.value as FeedPeriod)}
              value={period}
            >
              {PERIODS.map((key) => (
                <option key={key} value={key}>
                  {FEED_PERIOD_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button
          aria-label="Refresh boards"
          onClick={feed.refetch}
          size="sm"
          title="Refresh"
          variant="ghost"
        >
          <RefreshCw aria-hidden className="h-4 w-4" />
        </Button>
        <Button
          className="ml-auto"
          data-testid="board-feed-start"
          onClick={() => {
            if (needAccount("start a board")) {
              setComposing(false);
              setStarting(true);
            }
          }}
          size="sm"
          variant="outline"
        >
          Start a board
        </Button>
        {boardList.length > 0 ? (
          <Button
            data-testid="board-feed-new-post"
            onClick={() => {
              if (needAccount("post")) {
                setStarting(false);
                setComposing(true);
              }
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
                  className={`block whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium hover:bg-secondary ${
                    board.joined ? "border-primary/50 bg-primary/10" : ""
                  }`}
                  data-joined={board.joined || undefined}
                  params={{ boardId: board.id }}
                  title={board.description || undefined}
                  to="/b/$boardId"
                >
                  {board.name}
                  {board.joined ? (
                    <span className="sr-only"> (joined)</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {starting ? (
        <StartBoardForm
          onCancel={() => setStarting(false)}
          onStarted={(boardId) => {
            setStarting(false);
            void navigate({ to: "/b/$boardId", params: { boardId } });
          }}
        />
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

      <div
        aria-live="polite"
        className="sticky top-14 z-10 self-center"
        role="status"
      >
        {feed.fresh > 0 ? (
          <button
            className="rounded-full border bg-card px-4 py-1.5 text-xs font-medium shadow-sm"
            data-testid="board-feed-show-new"
            onClick={feed.refetch}
            type="button"
          >
            {feed.fresh === 1 ? "1 new post" : `${feed.fresh} new posts`}. Show
          </button>
        ) : null}
      </div>

      {feed.error ? (
        <QueryError
          description="The server did not answer, so no board posts can be shown."
          error={feed.error}
          onRetry={feed.refetch}
          testId="board-feed-error"
          title="Couldn't load the boards"
        />
      ) : boardList.length === 0 && !feed.isLoading ? (
        <p
          className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground"
          data-testid="board-feed-no-boards"
        >
          There are no boards here yet. Start the first one.
        </p>
      ) : noneJoined ? (
        <p
          className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground"
          data-testid="board-feed-none-joined"
        >
          You haven't joined a board yet. Open one above and press Join, or look
          at{" "}
          <button
            className="underline"
            onClick={() => setChosenScope("all")}
            type="button"
          >
            all boards
          </button>
          .
        </p>
      ) : feed.isLoading || order === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading posts…
        </p>
      ) : rows.length === 0 ? (
        <p
          className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground"
          data-testid="board-feed-empty"
        >
          {sort === "top" && period !== "all"
            ? `No posts ${FEED_PERIOD_LABELS[period].toLowerCase()}. Try a longer time.`
            : "No posts yet. Start the first discussion."}
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
      {feed.hasOlder && !noneJoined && rows.length > 0 ? (
        <Button
          className="self-center"
          data-testid="board-feed-older"
          disabled={feed.loadingOlder}
          onClick={feed.loadOlder}
          size="sm"
          variant="outline"
        >
          {feed.loadingOlder ? "Loading…" : "Show older posts"}
        </Button>
      ) : null}
    </div>
  );
}
