import { MessageSquare, ScrollText } from "lucide-react";

import type { Profile } from "@/features/profiles/use-profiles";
import { shortRelativeTime } from "@/shared/lib/relative-time";

import type { BoardPost } from "../lib/board-model";
import type { PostStatus } from "../lib/post-status";
import { AuthorChip } from "./AuthorChip";
import { TONE_CLASS } from "./status-tone";
import { VoteButtons } from "./VoteButtons";

/**
 * One post in the list: score, title, who and when, how many replies.
 *
 * A post about a DAO decision has no vote arrows. It is not ranked by votes (a vote here is not the DAO's vote and
 * would read as support), so where the arrows would be it says what it is, and where the decision stands when known.
 */
export function PostRow({
  post,
  profile,
  status,
  onOpen,
  onVote,
}: {
  post: BoardPost;
  profile: Profile | undefined;
  /** Where the decision this post is about stands, when it could be read and checked. */
  status?: PostStatus;
  onOpen: () => void;
  onVote: (direction: "up" | "down") => void;
}) {
  return (
    <li
      className="flex gap-2 rounded-xl border p-3"
      data-testid={`board-post-${post.id}`}
    >
      {post.proposal ? (
        <div
          aria-hidden
          className="grid w-9 shrink-0 place-items-start pt-1 text-muted-foreground"
        >
          <ScrollText className="h-5 w-5" />
        </div>
      ) : (
        <VoteButtons
          myVote={post.myVote}
          onVote={onVote}
          score={post.score}
          subject={`post "${post.title}"`}
        />
      )}
      <div className="min-w-0 flex-1">
        <button
          className="block max-w-full text-left text-base font-semibold hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="board-post-title"
          onClick={onOpen}
          type="button"
        >
          {post.title}
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <AuthorChip profile={profile} pubkey={post.author} />
          <span>{shortRelativeTime(post.createdAt)}</span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare aria-hidden className="h-3.5 w-3.5" />
            {post.commentCount === 1
              ? "1 reply"
              : `${post.commentCount} replies`}
          </span>
          {post.proposal ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary-ink">
                Proposal
              </span>
              {status ? (
                <span
                  className={`rounded-full px-2 py-0.5 text-2xs font-medium ${TONE_CLASS[status.tone]}`}
                  data-testid="board-post-status"
                >
                  {status.label}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}
