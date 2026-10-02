import { Link } from "@tanstack/react-router";
import { Bot, MessageSquare, Rocket, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { buildUndo } from "@/features/social/lib/post-events";
import { useSocialPublish } from "@/features/social/use-social-actions";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relativeTime } from "@/shared/lib/relative-time";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

import {
  displayText,
  type FeedNote,
  parseLaunchCoordinate,
} from "../lib/feed-events";
import { EMPTY_TALLY, type VoteTally } from "../lib/ranking";
import { VoteButtons } from "./VoteButtons";

/**
 * One post or reply: author, text, the launches it is about, votes, and the
 * way into its thread. Launch names come from `launchName`, so a quoted launch
 * reads as its name rather than a coordinate.
 */
export function NoteCard({
  note,
  nameOf,
  launchName,
  tally = EMPTY_TALLY,
  replies = 0,
  onReply,
  compact = false,
}: {
  note: FeedNote;
  nameOf: (pubkey: string) => string;
  launchName: (coord: string) => string | null;
  tally?: VoteTally;
  replies?: number;
  onReply?: () => void;
  compact?: boolean;
}) {
  const author = nameOf(note.author);
  const publish = useSocialPublish();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const isMine = existingUserPubkey() === note.author;
  const remove = () => {
    setConfirmDelete(false);
    // Hidden at once; put back if the relay refuses.
    setDeleted(true);
    publish.mutate(buildUndo(note.id, note.event.kind), {
      onSuccess: () => toast.success("Post deleted"),
      onError: (error) => {
        setDeleted(false);
        toast.error(
          error instanceof Error ? error.message : "Could not delete the post.",
        );
      },
    });
  };
  if (deleted) return null;
  return (
    <article
      aria-label={`Post by ${author}`}
      className={`flex gap-2 ${compact ? "py-2" : "glass rounded-xl border p-3"}`}
      data-testid="note-card"
    >
      <VoteButtonsColumn note={note} tally={tally} author={author} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-black/60 dark:text-white/60">
          <Link
            className="font-semibold text-black hover:underline dark:text-white"
            params={{ pubkey: note.author }}
            to="/u/$pubkey"
          >
            {author}
          </Link>
          {note.byAgent ? (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-2xs font-medium text-sky-800 dark:text-sky-200"
              data-testid="note-agent-badge"
              title="Posted by an agent on its owner's behalf"
            >
              <Bot aria-hidden className="h-3 w-3" /> Agent
            </span>
          ) : null}
          <time dateTime={new Date(note.createdAt * 1000).toISOString()}>
            {relativeTime(note.createdAt)}
          </time>
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-black dark:text-white">
          {displayText(note.text)}
        </p>
        {note.launches.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {note.launches.map((coord) => {
              const ref = parseLaunchCoordinate(coord);
              if (!ref) return null;
              return (
                <Link
                  className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/5 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-500/10 dark:text-violet-200"
                  data-testid="note-launch"
                  key={coord}
                  params={{ launchId: ref.id }}
                  search={{ author: ref.pubkey, action: undefined }}
                  to="/launchpad/$launchId"
                >
                  <Rocket aria-hidden className="h-3.5 w-3.5" />
                  {launchName(coord) ?? ref.id}
                </Link>
              );
            })}
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-1">
          {onReply ? (
            <button
              className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-black/60 hover:bg-black/5 hover:text-black dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
              data-testid="note-reply"
              onClick={onReply}
              type="button"
            >
              <MessageSquare aria-hidden className="h-3.5 w-3.5" />
              {replies > 0
                ? `${replies} ${replies === 1 ? "reply" : "replies"}`
                : "Reply"}
            </button>
          ) : null}
          {isMine ? (
            <button
              aria-label="Delete post"
              className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-black/60 hover:bg-red-500/10 hover:text-red-600 dark:text-white/60"
              data-testid="note-delete"
              onClick={() => setConfirmDelete(true)}
              type="button"
            >
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        confirmLabel="Delete"
        description="This removes your post for everyone. Replies already written under it stay with the thread."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
        open={confirmDelete}
        title="Delete this post?"
      />
    </article>
  );
}

function VoteButtonsColumn({
  note,
  tally,
  author,
}: {
  note: FeedNote;
  tally: VoteTally;
  author: string;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center [&>div]:flex-col">
      <VoteButtons
        label={`post by ${author}`}
        tally={tally}
        target={note.event}
        testId="note-vote"
      />
    </div>
  );
}
