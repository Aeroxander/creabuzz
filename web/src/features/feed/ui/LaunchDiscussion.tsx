import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { BoardView } from "@/features/board/ui/BoardView";
import type { Launch } from "@/features/launchpad/models";
import { useCreateProjectBoard } from "@/features/launchpad/use-launch-chat";
import { useProjectBoard } from "@/features/launchpad/use-project-board";
import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { QueryError } from "@/shared/ui/query-error";
import { useLaunchUpdates } from "@/features/social/use-launch-updates";

import { EMPTY_TALLY } from "../lib/ranking";
import { type PinnedUpdatable, pinnedUpdates } from "../lib/launch-thread";
import { useLaunchNotes, useVoteTallies } from "../use-feed";
import { launchCoord, launchRef, launchVoteTarget } from "./LaunchVoteCard";
import { ThreadList } from "./ThreadList";
import { VoteButtons } from "./VoteButtons";

/** The founder's own updates, pinned above the board, newest first. */
function PinnedUpdates({ updates }: { updates: PinnedUpdatable[] }) {
  if (updates.length === 0) return null;
  return (
    <section
      aria-label="Pinned team updates"
      className="mt-3 flex flex-col gap-2"
      data-testid="pinned-updates"
    >
      {updates.map((update) => (
        <article
          className="glass rounded-xl border p-3"
          key={update.id}
          data-testid="pinned-update"
        >
          <p className="flex flex-wrap items-center gap-2 text-2xs text-black/60 dark:text-white/60">
            <span className="rounded-full bg-black/10 px-2 py-0.5 font-medium text-black/70 dark:bg-white/15 dark:text-white/70">
              Pinned · team update
            </span>
            {relativeTime(update.createdAt)}
          </p>
          {update.title ? (
            <h3 className="mt-1 text-sm font-semibold text-black dark:text-white">
              {update.title}
            </h3>
          ) : null}
          <p className="mt-0.5 text-sm whitespace-pre-wrap break-words text-black/80 [overflow-wrap:anywhere] dark:text-white/80">
            {update.body}
          </p>
          {update.replyTo ? (
            <Link
              className="mt-2 inline-block text-sm font-semibold text-primary-ink underline"
              data-testid="pinned-update-reply"
              params={{ id: update.replyTo }}
              to="/social/post/$id"
            >
              Reply
            </Link>
          ) : null}
        </article>
      ))}
    </section>
  );
}

/**
 * Where people talk about the project: its own board (D156). Anyone here can start a post on it, reply and vote; the
 * founder runs it, so they can remove posts and appoint moderators. A project made before boards has none until the
 * founder opens it here.
 */
function ProjectBoard({ launch }: { launch: Launch }) {
  const { record } = launch;
  const boardId = record.chat.board;
  const { board, loading, error, retry } = useProjectBoard(boardId);
  const [postId, setPostId] = useState<string | undefined>(undefined);
  const open = useCreateProjectBoard(launch);
  const me = existingUserPubkey();
  const isFounder = me !== null && me === record.author;
  const openBoard = () =>
    void open
      .mutateAsync()
      .then(({ dropped }) =>
        toast.success(
          "The project board is open.",
          dropped > 0
            ? {
                description: `To make room for it, the project no longer lists ${dropped === 1 ? "one of the channels" : `${dropped} of the channels`} you picked.`,
              }
            : undefined,
        ),
      )
      .catch((cause: unknown) =>
        toast.error("The board wasn't opened", {
          description: failureWords(cause).text,
        }),
      );

  if (boardId === null) {
    if (!isFounder) {
      return (
        <p
          className="glass rounded-xl border px-4 py-3 text-sm text-muted-foreground"
          data-testid="discussion-no-board"
        >
          {record.name} has no board to talk on yet. Its founder can open one
          here. Until then, you can{" "}
          <Link
            className="font-semibold text-primary-ink underline"
            to="/social"
          >
            post about it on Home
          </Link>
          .
        </p>
      );
    }
    return (
      <div
        className="glass flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
        data-testid="discussion-open-board"
      >
        <p className="min-w-0 flex-1 text-sm">
          Give people one place to talk about {record.name}: a board where
          anyone here can post, reply and vote. You run it, so you can remove
          posts that don&apos;t belong.
        </p>
        <Button
          data-testid="discussion-open-board-button"
          disabled={open.isPending}
          onClick={openBoard}
          size="sm"
        >
          {open.isPending ? "Opening…" : "Open the project board"}
        </Button>
      </div>
    );
  }
  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading the project board…
      </p>
    );
  }
  if (error) {
    return (
      <QueryError
        description="The server did not answer, so the project board can't be shown."
        error={error}
        onRetry={retry}
        testId="discussion-board-error"
        title="Couldn't load the project board"
      />
    );
  }
  if (!board) {
    // Its founder can always get a board back: a new one takes the old one's place in the record.
    return (
      <div
        className="glass flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
        data-testid="discussion-board-missing"
      >
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {isFounder
            ? "This project's board isn't here any more. It may have been removed. Open a new one to give people a place to talk again."
            : "This project's board isn't here. It may have been removed, or it may be open only to some people."}
        </p>
        {isFounder ? (
          <Button
            data-testid="discussion-replace-board-button"
            disabled={open.isPending}
            onClick={openBoard}
            size="sm"
            variant="outline"
          >
            {open.isPending ? "Opening…" : "Open a new board"}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div data-testid="discussion-board">
      <BoardView
        channel={board}
        key={board.id}
        onOpenPost={(id) => setPostId(id ?? undefined)}
        postId={postId}
        projectBoard
      />
    </div>
  );
}

/**
 * The project's Discussion tab: support for the project, the team's updates pinned, then its board. Notes posted here
 * before the board (D156) stay readable below it, with no reply box: new talk goes on the board.
 */
export function LaunchDiscussion({
  launch,
  updates = [],
}: {
  launch: Launch;
  updates?: readonly PinnedUpdatable[];
}) {
  const { record } = launch;
  const coord = launchCoord(record);
  const notes = useLaunchNotes(coord);
  const { tallies } = useVoteTallies();
  const teamKeys = useMemo(
    () => new Set([record.author, ...record.team.map((t) => t.pubkey)]),
    [record.author, record.team],
  );
  // Launch-mode posts from the team pin to the top like the older founder updates, and leave the earlier notes so
  // they are not shown twice.
  const allUpdates = useLaunchUpdates().updates;
  const launchUpdates = useMemo(
    () => allUpdates.filter((u) => u.coord === coord),
    [allUpdates, coord],
  );
  const pinnedFromPosts: PinnedUpdatable[] = useMemo(
    () =>
      launchUpdates.map((u) => ({
        id: u.id,
        author: u.author,
        createdAt: u.at,
        title: "",
        body: u.event.content.replace(/\n*nostr:naddr1\w+/g, "").trim(),
        replyTo: u.id,
      })),
    [launchUpdates],
  );
  const pinned = pinnedUpdates([...updates, ...pinnedFromPosts]);
  // Notes from before the board: top-level posts from the team, and every reply under them.
  const earlier = useMemo(() => {
    const all = notes.data ?? [];
    const roots = new Set(
      all.filter((n) => !n.rootId && teamKeys.has(n.author)).map((n) => n.id),
    );
    const pinnedIds = new Set(launchUpdates.map((u) => u.id));
    return all.filter(
      (n) =>
        !pinnedIds.has(n.id) &&
        (n.rootId ? roots.has(n.rootId) : roots.has(n.id)),
    );
  }, [notes.data, teamKeys, launchUpdates]);

  return (
    <section aria-label="Discussion" data-testid="launch-discussion">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <VoteButtons
            label={record.name}
            launch={launchRef(record)}
            tally={tallies.get(coord) ?? EMPTY_TALLY}
            target={launchVoteTarget(record)}
            testId="launch-vote"
          />
          <span className="text-sm text-black/60 dark:text-white/60">
            Support this project
          </span>
        </div>
      </div>
      <PinnedUpdates updates={pinned} />
      <div className="mt-3">
        <ProjectBoard launch={launch} />
      </div>
      {notes.isError ? (
        <div className="mt-4">
          <QueryError
            description="The server did not answer, so notes from before the board can't be shown."
            error={notes.error}
            kinds={[KIND_TEXT_NOTE]}
            onRetry={() => void notes.refetch()}
            relayUrl={relayWsUrl()}
            testId="discussion-error"
            title="Couldn't load the earlier notes"
          />
        </div>
      ) : earlier.length > 0 ? (
        <section
          aria-labelledby="discussion-earlier-title"
          className="mt-6"
          data-testid="discussion-earlier"
        >
          <h2 className="text-sm font-semibold" id="discussion-earlier-title">
            Earlier notes
          </h2>
          <p className="mb-2 text-xs text-muted-foreground">
            Posted here before the project board. They can be read and voted on,
            but not replied to: talk on the board above.
          </p>
          <ThreadList
            empty={null}
            mode="new"
            notes={earlier}
            testId="discussion-list"
          />
        </section>
      ) : null}
    </section>
  );
}
