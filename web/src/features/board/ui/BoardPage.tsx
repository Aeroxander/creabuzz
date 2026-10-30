/**
 * One board on its own page, in the social column beside Home: the same board the community's workspace shows, so a
 * post can be found, linked to and answered without going into the workspace. The open post is in the address
 * (`?post=`) so it can be shared. Reading it here reads it everywhere: once it has been on screen a moment, the
 * server is told, as the workspace does for the board it shows (D101).
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { lazy } from "react";

import { useChannels } from "@/features/channels/use-channels";
import { useReadWhileOnScreen } from "@/features/channels/use-read-while-on-screen";
import { useUnreadRooms } from "@/features/channels/use-unread-rooms";
import { PageBar, SocialShell } from "@/features/social/ui/SocialShell";
import { QueryError } from "@/shared/ui/query-error";

import { BoardView } from "./BoardView";

// A thread about a DAO decision reads the chain; only then is that code needed.
const ProposalExtras = lazy(() =>
  import("@/features/launchpad/ui/ProposalExtras").then((m) => ({
    default: m.ProposalExtras,
  })),
);
const ProposalStates = lazy(() =>
  import("@/features/launchpad/ui/ProposalStates").then((m) => ({
    default: m.ProposalStates,
  })),
);

export function BoardPage({
  boardId,
  postId,
}: {
  boardId: string;
  postId: string | undefined;
}) {
  const navigate = useNavigate();
  const channels = useChannels();
  const board = channels.channels.find(
    (channel) => channel.id === boardId && channel.type === "forum",
  );
  const unread = useUnreadRooms();
  const onScreen = board ? board.id : null;
  useReadWhileOnScreen(
    unread.markRead,
    onScreen,
    onScreen === null ? null : (unread.rows.get(onScreen)?.latest ?? null),
  );

  const back = (
    <Link
      aria-label="Back to all boards"
      className="-ml-2 rounded-full p-2 hover:bg-black/5 dark:hover:bg-white/10"
      search={{ tab: "boards" }}
      to="/"
    >
      <ArrowLeft aria-hidden className="h-5 w-5" />
    </Link>
  );

  return (
    <SocialShell>
      <PageBar back={back} title={board?.name ?? "Board"} />
      {channels.error ? (
        <div className="p-4">
          <QueryError
            description="The server did not answer, so this board can't be found."
            error={channels.error}
            onRetry={() => void channels.refetch()}
            testId="board-page-error"
            title="Couldn't load this board"
          />
        </div>
      ) : channels.isLoading ? (
        <p className="p-4 text-sm text-muted-foreground" role="status">
          Loading the board…
        </p>
      ) : !board ? (
        <p className="p-6 text-sm" data-testid="board-page-missing">
          This board isn't here. It may be private, or it may have been removed.
        </p>
      ) : (
        <BoardView
          channel={board}
          key={board.id}
          onOpenPost={(id) =>
            void navigate({
              to: "/b/$boardId",
              params: { boardId },
              search: id ? { post: id } : {},
            })
          }
          postId={postId}
          proposalExtras={ProposalExtras}
          proposalStates={ProposalStates}
        />
      )}
    </SocialShell>
  );
}
