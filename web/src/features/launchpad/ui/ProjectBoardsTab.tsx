/**
 * A project's boards: the ones its record names, to open from here. Its founder can add the supporters and founders
 * boards, which are made inside the project, never loose on the server. Only the person who published a project can add
 * boards to it, because the project's record is what names them.
 */

import { Link } from "@tanstack/react-router";
import { Lock, Newspaper } from "lucide-react";
import { toast } from "sonner";

import { droppedLinksNotice } from "@/features/board/lib/project-boards";
import { missingStarterBoards } from "@/features/board/lib/starter-boards";
import { UnreadChip } from "@/features/board/ui/UnreadChip";
import { useMyBoards } from "@/features/board/use-my-boards";
import {
  useProjectBoardsOf,
  useProjectStarterBoards,
} from "@/features/board/use-project-boards";
import { unreadMarker } from "@/features/channels/lib/read-state";
import { useUnreadRooms } from "@/features/channels/use-unread-rooms";
import { needAccountTo } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { QueryError } from "@/shared/ui/query-error";

import type { Launch } from "../models";

/** What the button says for the boards still missing. */
function addBoardsLabel(missing: readonly { name: string }[]): string {
  return missing.length === 1
    ? `Add the ${missing[0].name} board`
    : "Add supporters and founders boards";
}

export function ProjectBoardsTab({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const { boards, loading, error, retry } = useProjectBoardsOf(launch);
  const failed = error != null;
  const mine = useMyBoards();
  const unread = useUnreadRooms();
  const missing = missingStarterBoards(boards.map((board) => board.name));
  const starter = useProjectStarterBoards(
    launch,
    boards.map((board) => board.name),
  );
  const working = starter.state.phase === "working";

  const addBoards = async () => {
    if (existingUserPubkey() === null) {
      toast.error(needAccountTo("add boards"));
      return;
    }
    const dropped = await starter.create();
    const notice = droppedLinksNotice(launch.record.name, dropped ?? 0);
    if (notice) toast.message(notice);
  };

  const offer =
    isFounder && missing.length > 0 ? (
      <div className="mt-3" data-testid="project-boards-offer">
        <Button
          data-testid="project-boards-add"
          disabled={working}
          onClick={() => void addBoards()}
          size="sm"
          variant={boards.length === 0 ? "default" : "outline"}
        >
          {working ? "Setting up…" : addBoardsLabel(missing)}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          Supporters is open to everyone here. Founders is private: only people
          you add can read it.
        </p>
      </div>
    ) : null;

  return (
    <Card className="p-4" data-testid="project-boards">
      <div className="flex items-start gap-3">
        <Newspaper
          aria-hidden
          className="mt-0.5 h-5 w-5 shrink-0 text-primary-ink"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold">Boards</h2>
          <p className="text-xs text-muted-foreground">
            A board is where people post a topic and reply under it. These
            belong to {launch.record.name}.
          </p>

          {failed ? (
            <div className="mt-3">
              <QueryError
                description="The server did not answer, so the boards can't be listed."
                error={error}
                onRetry={retry}
                testId="project-boards-error"
                title="Couldn't load the boards"
              />
            </div>
          ) : loading ? (
            <p className="mt-3 text-sm text-muted-foreground" role="status">
              Loading boards…
            </p>
          ) : boards.length === 0 ? (
            <p
              className="mt-3 text-sm text-muted-foreground"
              data-testid="project-boards-empty"
            >
              {isFounder
                ? "This project has no boards yet."
                : "This project has no boards yet. Its founder can add them."}
            </p>
          ) : (
            <ul
              className="mt-2 divide-y divide-border/60"
              data-testid="project-boards-list"
            >
              {boards.map((board) => {
                const marker = mine.joined.has(board.id)
                  ? unreadMarker(unread.rows.get(board.id))
                  : null;
                return (
                  <li
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                    data-testid={`project-board-${board.id}`}
                    key={board.id}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <Link
                          className="block truncate text-sm font-semibold hover:underline"
                          data-testid="project-board-name"
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
                            testId={`project-board-${board.id}-unread`}
                          />
                        ) : null}
                      </div>
                      {board.description ? (
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {board.description}
                        </p>
                      ) : null}
                    </div>
                    {board.visibility === "private" ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Lock aria-hidden className="h-3 w-3" /> Invite only
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {failed || loading ? null : offer}
          {starter.state.phase === "error" ? (
            <p
              className="mt-2 text-xs text-destructive"
              data-testid="project-boards-problem"
              role="alert"
            >
              {starter.state.message}{" "}
              <button
                className="underline"
                onClick={() => void addBoards()}
                type="button"
              >
                Try again
              </button>
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
