/**
 * Home's Boards tab: every board on this server to browse, join and start, the way a list of communities reads.
 * Their posts are in the Everyone timeline (and Following, for people you follow); this is where you find a board,
 * see what it is for and how busy it is, and open it. A joined board shows what is unread in it, as the workspace's
 * sidebar does, when the server keeps read state (D101); otherwise no marker at all, never a false "all read".
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { MessageSquare, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { unreadMarker } from "@/features/channels/lib/read-state";
import { useUnreadRooms } from "@/features/channels/use-unread-rooms";
import { needAccountTo } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { QueryError } from "@/shared/ui/query-error";

import { useBoardFeed } from "../use-board-feed";
import { useMyBoards } from "../use-my-boards";
import { JoinBoardButton } from "./JoinBoardButton";
import { StartBoardForm } from "./StartBoardForm";

const WEEK = 7 * 24 * 3600;

export function BoardDirectory() {
  const feed = useBoardFeed();
  const mine = useMyBoards();
  const unread = useUnreadRooms();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);

  // How busy each board is, from the newest posts read: posts this week and the latest one.
  const activity = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const map = new Map<string, { week: number; latest: number }>();
    for (const post of feed.posts) {
      const seen = map.get(post.boardId) ?? { week: 0, latest: 0 };
      if (now - post.createdAt < WEEK) seen.week += 1;
      seen.latest = Math.max(seen.latest, post.lastActivity);
      map.set(post.boardId, seen);
    }
    return map;
  }, [feed.posts]);

  const boards = useMemo(
    () =>
      [...feed.boards.entries()]
        .map(([id, board]) => ({
          id,
          ...board,
          joined: mine.joined.has(id),
          ...(activity.get(id) ?? { week: 0, latest: 0 }),
        }))
        .sort(
          (a, b) =>
            Number(b.joined) - Number(a.joined) ||
            b.latest - a.latest ||
            a.name.localeCompare(b.name),
        ),
    [feed.boards, mine.joined, activity],
  );

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="board-directory">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Boards are communities for one topic. Their posts show up in Everyone;
          join the ones you care about.
        </p>
        <Button
          data-testid="board-directory-start"
          onClick={() => {
            if (existingUserPubkey() === null) {
              toast.error(needAccountTo("start a board"));
              return;
            }
            setStarting(true);
          }}
          size="sm"
        >
          Start a board
        </Button>
      </div>

      {starting ? (
        <StartBoardForm
          onCancel={() => setStarting(false)}
          onStarted={(boardId) => {
            setStarting(false);
            void navigate({ to: "/b/$boardId", params: { boardId } });
          }}
        />
      ) : null}

      {feed.error ? (
        <QueryError
          description="The server did not answer, so the boards can't be listed."
          error={feed.error}
          onRetry={feed.refetch}
          testId="board-directory-error"
          title="Couldn't load the boards"
        />
      ) : feed.isLoading ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading boards…
        </p>
      ) : boards.length === 0 ? (
        <p
          className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground"
          data-testid="board-directory-empty"
        >
          There are no boards here yet. Start the first one.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="board-directory-list">
          {boards.map((board) => {
            const marker = board.joined
              ? unreadMarker(unread.rows.get(board.id))
              : null;
            return (
              <li
                className="flex items-center gap-3 rounded-xl border bg-card p-3"
                data-joined={board.joined || undefined}
                data-testid={`board-directory-${board.id}`}
                key={board.id}
              >
                <span
                  aria-hidden
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/15 text-base font-bold uppercase text-primary-ink"
                >
                  {board.name.replace(/[^a-z0-9]/gi, "").slice(0, 1) || "#"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Link
                      className="block truncate text-base font-semibold hover:underline"
                      data-testid="board-directory-name"
                      params={{ boardId: board.id }}
                      to="/b/$boardId"
                    >
                      {board.name}
                      {marker ? (
                        <span className="sr-only">{`, ${marker.words}`}</span>
                      ) : null}
                    </Link>
                    {marker ? (
                      <span
                        aria-hidden
                        className={`shrink-0 rounded-full px-1.5 text-2xs font-semibold ${
                          marker.attention
                            ? "bg-destructive text-destructive-foreground"
                            : "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                        }`}
                        data-testid={`board-directory-${board.id}-unread`}
                      >
                        {marker.label ?? "•"}
                      </span>
                    ) : null}
                  </div>
                  {board.description ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {board.description}
                    </p>
                  ) : null}
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare aria-hidden className="h-3.5 w-3.5" />
                      {board.week === 1
                        ? "1 post this week"
                        : `${board.week} posts this week`}
                    </span>
                    {board.latest > 0 ? (
                      <span>Active {shortRelativeTime(board.latest)}</span>
                    ) : null}
                    {board.joined ? (
                      <span className="inline-flex items-center gap-1 text-primary-ink">
                        <Users aria-hidden className="h-3.5 w-3.5" /> Joined
                      </span>
                    ) : null}
                  </p>
                </div>
                {board.visibility === "public" ? (
                  <JoinBoardButton boardId={board.id} boardName={board.name} />
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Invite only
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {unread.paused ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="board-directory-unread-paused"
          role="status"
        >
          Unread counts may be out of date.{" "}
          <button className="underline" onClick={unread.refresh} type="button">
            Refresh
          </button>
        </p>
      ) : null}
    </div>
  );
}
