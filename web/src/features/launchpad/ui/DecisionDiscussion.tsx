/**
 * The talk about one decision, under the decision: the threads people have
 * started on the community's boards, a way into each, and a way to start one.
 *
 * Threads live on the boards, not here; this only lists the ones that name this
 * decision and opens them in the community. A board's votes are a way to say
 * what people think, so the section says plainly that they are not the DAO's
 * vote.
 */

import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { postDraft } from "@/features/board/lib/board-events";
import type { ProposalRef } from "@/features/board/lib/proposal-link";
import type { ProposalThread } from "@/features/board/lib/proposal-threads";
import { PostComposer } from "@/features/board/ui/PostComposer";
import { useStarterBoards } from "@/features/board/use-starter-boards";
import type { Channel } from "@/features/channels/use-channels";
import { needAccountTo } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { communityHostName } from "@/shared/lib/relay-url";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";

/** The board a new discussion starts on: the supporters board when there is one. */
export function defaultBoard(boards: readonly Channel[]): Channel | null {
  const open = boards.filter((board) => board.visibility !== "private");
  return open.find((board) => board.name === "supporters") ?? open[0] ?? null;
}

function ThreadLink({
  thread,
  testId,
}: {
  thread: ProposalThread;
  testId: string;
}) {
  return (
    <p className="text-sm">
      <Link
        className="font-medium underline"
        data-testid={testId}
        params={{ host: communityHostName() }}
        search={{ channel: thread.boardId, post: thread.postId }}
        to="/c/$host"
      >
        {thread.title}
      </Link>
      <span className="ml-2 text-xs text-muted-foreground">
        on {thread.boardName} · {shortRelativeTime(thread.createdAt)}
      </span>
    </p>
  );
}

export function DecisionDiscussion({
  decision,
  headline,
  boards,
  threads,
  loading,
  failed,
  onRetry,
  onStarted,
}: {
  decision: ProposalRef;
  /** What the decision would do, in a few words, to start a title from. */
  headline: string;
  boards: readonly Channel[];
  threads: readonly ProposalThread[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** Called after a thread is started, so the lists read again. */
  onStarted: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [boardId, setBoardId] = useState<string | null>(null);
  const open = boards.filter((board) => board.visibility !== "private");
  const target = boardId
    ? (open.find((board) => board.id === boardId) ?? defaultBoard(boards))
    : defaultBoard(boards);
  const starter = useStarterBoards(boards.map((board) => board.name));
  // The first thread started is the decision's main discussion; the rest are alongside it.
  const oldestFirst = [...threads].sort(
    (a, b) => a.createdAt - b.createdAt || (a.postId < b.postId ? -1 : 1),
  );
  const mainThread = oldestFirst[0];
  const otherThreads = oldestFirst.slice(1);

  const begin = () => {
    if (existingUserPubkey() === null) {
      toast.error(needAccountTo("start a discussion"));
      return;
    }
    setStarting(true);
  };

  return (
    <section
      aria-label="Discussion"
      className="mt-3 rounded-xl border bg-secondary/30 p-3"
      data-testid="decision-discussion"
    >
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <MessagesSquare aria-hidden className="h-4 w-4" />
        Discussion
      </h4>
      <p className="text-xs text-muted-foreground">
        Talk it through on the community's boards. Votes on a board show what
        people think; they are not the DAO's vote.
      </p>

      {loading ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Loading the discussion…
        </p>
      ) : failed ? (
        <p
          className="mt-2 text-xs text-destructive"
          data-testid="discussion-problem"
          role="alert"
        >
          Couldn't load the discussion.{" "}
          <button className="underline" onClick={onRetry} type="button">
            Try again
          </button>
        </p>
      ) : threads.length > 0 ? (
        <div className="mt-2" data-testid="discussion-threads">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Main discussion
          </p>
          <ThreadLink thread={mainThread} testId="discussion-main-thread" />
          {otherThreads.length > 0 ? (
            <>
              <p className="mt-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                {otherThreads.length === 1
                  ? "One more thread"
                  : `${otherThreads.length} more threads`}
              </p>
              <ul className="flex flex-col gap-1">
                {otherThreads.map((thread) => (
                  <li key={thread.postId}>
                    <ThreadLink thread={thread} testId="discussion-thread" />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="discussion-empty"
        >
          Nobody has started a discussion about this yet.
        </p>
      )}

      {starting && target ? (
        <div className="mt-3">
          {open.length > 1 ? (
            <label className="mb-2 flex items-center gap-2 text-xs">
              Post it on
              <select
                className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
                data-testid="discussion-board"
                onChange={(event) => setBoardId(event.target.value)}
                value={target.id}
              >
                {open.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <PostComposer
            hint={`This goes on the ${target.name} board, where everyone who can read it will see it.`}
            initialTitle={`Proposal: ${headline}`}
            onCancel={() => setStarting(false)}
            onSubmit={async (title, body) => {
              await publishAsUser(
                postDraft({
                  boardId: target.id,
                  title,
                  body,
                  proposal: decision,
                }),
                "The server didn't accept the discussion.",
              );
              setStarting(false);
              onStarted();
            }}
            submitLabel="Start the discussion"
          />
        </div>
      ) : !loading && !failed ? (
        open.length > 0 ? (
          <Button
            className="mt-2"
            data-testid="discussion-start"
            onClick={begin}
            size="sm"
            variant="outline"
          >
            {threads.length > 0 ? "Start another thread" : "Start a discussion"}
          </Button>
        ) : (
          <div
            className="mt-2 text-xs text-muted-foreground"
            data-testid="discussion-no-boards"
          >
            <p>This community has no open board to discuss it on yet.</p>
            <Button
              className="mt-1"
              data-testid="discussion-add-boards"
              disabled={starter.state.phase === "working"}
              onClick={() => {
                if (existingUserPubkey() === null) {
                  toast.error(needAccountTo("add boards"));
                  return;
                }
                void starter.create().then(onStarted);
              }}
              size="sm"
              variant="outline"
            >
              {starter.state.phase === "working"
                ? "Setting up…"
                : "Add supporters and founders boards"}
            </Button>
            {starter.state.phase === "error" ? (
              <p className="mt-1 text-destructive" role="alert">
                {starter.state.message}
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}
