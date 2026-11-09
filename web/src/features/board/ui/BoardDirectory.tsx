/**
 * Home's Boards tab: every board on this server to browse, join and start, under the project each belongs to. A board
 * a project's record names is listed under that project's name (which opens the project); the rest are under "This
 * server", last. Their posts are in the Everyone timeline (and Following, for people you follow); this is where you find
 * a board, see what it is for and how busy it is, and open it. A joined board shows what is unread in it, as the
 * workspace's sidebar does, when the server keeps read state (D101); otherwise no marker at all, never a false "all read".
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { MessageSquare, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { unreadMarker } from "@/features/channels/lib/read-state";
import { useUnreadRooms } from "@/features/channels/use-unread-rooms";
import { needAccountTo } from "@/features/identity/lib/account-copy";
import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { QueryError } from "@/shared/ui/query-error";

import { groupBoardsByProject, projectQualifiers } from "../lib/project-boards";
import { useBoardFeed } from "../use-board-feed";
import { useMyBoards } from "../use-my-boards";
import { useBoardProjects } from "../use-project-boards";
import { JoinBoardButton } from "./JoinBoardButton";
import { StartBoardForm } from "./StartBoardForm";
import { UnreadChip } from "./UnreadChip";

const WEEK = 7 * 24 * 3600;

export function BoardDirectory() {
  const feed = useBoardFeed();
  const mine = useMyBoards();
  const unread = useUnreadRooms();
  const projects = useBoardProjects();
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
  // Under each project that names them. The boards are listed as soon as they are known and move under their projects
  // when those are read: the grouping is a way to find a board, not part of the board. If it cannot be read the boards
  // stay listed, and the page says the grouping is missing (below) instead of passing them off as the server's own.
  const groups = useMemo(
    () => groupBoardsByProject(boards, projects.projects),
    [boards, projects.projects],
  );
  // Two projects can share a name; the heading then says who made each.
  const nameOf = useUserNames(
    groups.flatMap((group) => (group.project ? [group.project.author] : [])),
  );
  const qualifiers = useMemo(
    () =>
      projectQualifiers(
        groups.flatMap((group) => (group.project ? [group.project] : [])),
        nameOf,
      ),
    [groups, nameOf],
  );

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="board-directory">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          A board is where people post a topic and reply under it. Each project
          has its own, and the rest belong to this server. Posts show up in
          Everyone; join the boards you care about.
        </p>
        {starting ? null : (
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
        )}
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
      ) : feed.boardsLoading ? (
        // The boards are listed as soon as they are known; their activity fills in when the posts arrive.
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
        <div className="flex flex-col gap-4" data-testid="board-directory-list">
          {projects.failed ? (
            <p
              className="text-xs text-destructive"
              data-testid="board-directory-grouping-problem"
              role="alert"
            >
              Couldn't group boards by project.{" "}
              <button
                className="underline"
                onClick={projects.retry}
                type="button"
              >
                Try again
              </button>
            </p>
          ) : null}
          {groups.map((group) => {
            const key = group.project?.key ?? "server";
            const heading = group.project?.name ?? "This server";
            const qualifier = group.project
              ? (qualifiers.get(group.project.key) ?? null)
              : null;
            // Without a project to tell apart from, one group needs no heading.
            const named = groups.length > 1 || group.project !== null;
            return (
              <section
                aria-label={named ? undefined : "Boards"}
                aria-labelledby={named ? `board-group-${key}` : undefined}
                className="flex flex-col gap-2"
                data-testid={`board-directory-group-${key}`}
                key={key}
              >
                {named ? (
                  <h2
                    className="min-w-0 truncate text-sm font-semibold"
                    id={`board-group-${key}`}
                  >
                    {group.project ? (
                      <Link
                        className="hover:underline"
                        data-testid="board-directory-project-link"
                        params={{ launchId: group.project.id }}
                        search={{ author: group.project.author }}
                        to="/launchpad/$launchId"
                      >
                        {heading}
                      </Link>
                    ) : (
                      heading
                    )}
                    {qualifier ? (
                      <span
                        className="font-normal text-muted-foreground"
                        data-testid="board-directory-project-qualifier"
                      >
                        {" "}
                        {qualifier}
                      </span>
                    ) : null}
                  </h2>
                ) : null}
                <ul className="flex flex-col gap-2">
                  {group.boards.map((board) => {
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
                          {board.name.replace(/[^a-z0-9]/gi, "").slice(0, 1) ||
                            "#"}
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
                              <UnreadChip
                                marker={marker}
                                testId={`board-directory-${board.id}-unread`}
                              />
                            ) : null}
                          </div>
                          {board.description ? (
                            <p className="line-clamp-2 text-sm text-muted-foreground">
                              {board.description}
                            </p>
                          ) : null}
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <MessageSquare
                                aria-hidden
                                className="h-3.5 w-3.5"
                              />
                              {board.week === 1
                                ? "1 post this week"
                                : `${board.week} posts this week`}
                            </span>
                            {board.latest > 0 ? (
                              <span>
                                Active {shortRelativeTime(board.latest)}
                              </span>
                            ) : null}
                            {board.joined ? (
                              <span className="inline-flex items-center gap-1 text-primary-ink">
                                <Users aria-hidden className="h-3.5 w-3.5" />{" "}
                                Joined
                              </span>
                            ) : null}
                          </p>
                        </div>
                        {board.visibility === "public" ? (
                          <JoinBoardButton
                            boardId={board.id}
                            boardName={board.name}
                          />
                        ) : (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            Invite only
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
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
