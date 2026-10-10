import { MessageSquare, ScrollText } from "lucide-react";

import type { Profile } from "@/features/profiles/use-profiles";
import { shortRelativeTime } from "@/shared/lib/relative-time";

import type { BoardPost } from "../lib/board-model";
import { AuthorChip } from "./AuthorChip";
import { VoteButtons } from "./VoteButtons";

/** One post in the list: score, title, who and when, how many replies. */
export function PostRow({
  post,
  profile,
  onOpen,
  onVote,
}: {
  post: BoardPost;
  profile: Profile | undefined;
  onOpen: () => void;
  onVote: (direction: "up" | "down") => void;
}) {
  return (
    <li
      className="flex gap-2 rounded-xl border p-3"
      data-testid={`board-post-${post.id}`}
    >
      <VoteButtons
        myVote={post.myVote}
        onVote={onVote}
        score={post.score}
        subject={`post "${post.title}"`}
      />
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
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary-ink">
              <ScrollText aria-hidden className="h-3 w-3" />
              Proposal
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}
