/**
 * The few hottest board posts, shown above the short posts on Home's Everyone tab so long discussions are part of the
 * feed rather than something to go and look for. Nothing is shown while loading, on a failed read, or when no board
 * post is recent enough to be worth lifting; the Boards tab says why in each of those cases.
 */

import { useNavigate } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { useMemo } from "react";

import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";
import { usePeople } from "@/features/social/use-people";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { sortFeed } from "../lib/board-feed";
import { useBoardFeed } from "../use-board-feed";

const SHOWN = 3;
/** Only posts this recent are lifted into Home; older ones live on the Boards tab. */
const RECENT_SECONDS = 7 * 24 * 3600;

export function HotOnBoards({ onSeeAll }: { onSeeAll: () => void }) {
  const feed = useBoardFeed({ live: false });
  const navigate = useNavigate();
  const top = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return sortFeed(
      feed.posts.filter((post) => now - post.createdAt < RECENT_SECONDS),
      "hot",
      now,
    ).slice(0, SHOWN);
  }, [feed.posts]);
  const profiles: Record<string, Profile> | undefined = usePeople(
    useMemo(() => top.map((post) => post.author), [top]),
  );

  if (feed.isLoading || feed.error || top.length === 0) return null;

  return (
    <section
      aria-labelledby="hot-on-boards"
      className="border-b border-border/60 px-4 py-3"
      data-testid="hot-on-boards"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold" id="hot-on-boards">
          Hot on the boards
        </h2>
        <button
          className="text-xs font-medium text-sky-700 hover:underline dark:text-sky-400"
          data-testid="hot-on-boards-all"
          onClick={onSeeAll}
          type="button"
        >
          See all boards
        </button>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {top.map((post) => {
          const name = resolveUserName(profiles?.[post.author], post.author);
          const board = feed.boards.get(post.boardId)?.name ?? "Board";
          return (
            <li key={post.id}>
              <button
                className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-black/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
                data-testid="hot-on-boards-post"
                onClick={() =>
                  void navigate({
                    to: "/b/$boardId",
                    params: { boardId: post.boardId },
                    search: { post: post.id },
                  })
                }
                type="button"
              >
                <UserAvatar
                  avatarUrl={profiles?.[post.author]?.picture ?? null}
                  displayName={name}
                  size="md"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {post.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {board} · {name} · {shortRelativeTime(post.createdAt)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end text-xs text-muted-foreground tabular-nums">
                  {post.proposal ? null : (
                    <span>
                      {post.score}{" "}
                      {Math.abs(post.score) === 1 ? "point" : "points"}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare aria-hidden className="h-3 w-3" />
                    {post.commentCount}
                    <span className="sr-only"> replies</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
