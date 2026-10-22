import { Link } from "@tanstack/react-router";
import {
  ExternalLink,
  Lock,
  MessageSquare,
  Pin,
  ScrollText,
} from "lucide-react";

import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { postMedia, previewText } from "../lib/board-feed";
import type { BoardPost } from "../lib/board-model";
import type { PostStatus } from "../lib/post-status";
import { TONE_CLASS } from "./status-tone";
import { VoteButtons } from "./VoteButtons";

/**
 * One post in a list, laid out like a forum post: the score, then the author's picture large enough to recognise, who
 * and when (and, on the boards front page, which board), the title, the first lines of the text and how many replies.
 * A post with a picture shows it small at the side, and a post with a link names the site it goes to.
 *
 * A post about a DAO decision has no vote arrows. It is not ranked by votes (a vote here is not the DAO's vote and
 * would read as support), so where the arrows would be it says what it is, and where the decision stands when known.
 */
export function PostRow({
  post,
  profile,
  status,
  board,
  pinned = false,
  locked = false,
  voteDisabledReason = null,
  onOpen,
  onVote,
}: {
  /** Why the reader cannot vote here (muted on this board). */
  voteDisabledReason?: string | null;
  post: BoardPost;
  /** Pinned to the top of its board by a moderator. */
  pinned?: boolean;
  /** Locked by a moderator: no new replies. */
  locked?: boolean;
  profile: Profile | undefined;
  /** Where the decision this post is about stands, when it could be read and checked. */
  status?: PostStatus;
  /** The board the post is on, shown when the list mixes boards. */
  board?: { id: string; name: string };
  onOpen: () => void;
  onVote: (direction: "up" | "down") => void;
}) {
  const name = resolveUserName(profile, post.author);
  const preview = post.body ? previewText(post.body) : "";
  const media = postMedia(post.body);
  return (
    <li
      className="flex gap-2 rounded-xl border bg-card p-3"
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
          disabledReason={voteDisabledReason}
          myVote={post.myVote}
          onVote={onVote}
          score={post.score}
          subject={`post "${post.title}"`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <Link
            aria-hidden
            className="shrink-0"
            params={{ pubkey: post.author }}
            tabIndex={-1}
            to="/u/$pubkey"
          >
            <UserAvatar
              avatarUrl={profile?.picture ?? null}
              displayName={name}
              size="lg"
            />
          </Link>
          <div className="min-w-0 text-xs leading-snug">
            <Link
              className="block truncate text-sm font-semibold text-foreground hover:underline"
              data-testid="board-post-author"
              params={{ pubkey: post.author }}
              to="/u/$pubkey"
            >
              {name}
            </Link>
            <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
              {board ? (
                <>
                  <Link
                    className="font-medium text-foreground/80 hover:underline"
                    data-testid="board-post-board"
                    params={{ boardId: board.id }}
                    to="/b/$boardId"
                  >
                    {board.name}
                  </Link>
                  <span aria-hidden>·</span>
                </>
              ) : null}
              <span>{shortRelativeTime(post.createdAt)}</span>
              {pinned ? (
                <span
                  className="inline-flex items-center gap-0.5 font-medium text-foreground/80"
                  data-testid="board-post-pinned"
                >
                  <span aria-hidden>·</span>
                  <Pin aria-hidden className="h-3 w-3" /> Pinned
                </span>
              ) : null}
              {locked ? (
                <span
                  className="inline-flex items-center gap-0.5"
                  data-testid="board-post-locked"
                >
                  <span aria-hidden>·</span>
                  <Lock aria-hidden className="h-3 w-3" /> Locked
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="mt-2 flex gap-3">
          <div className="min-w-0 flex-1">
            <button
              className="block max-w-full text-left text-base font-semibold hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="board-post-title"
              onClick={onOpen}
              type="button"
            >
              {post.title}
            </button>
            {media.link ? (
              <a
                className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-primary-ink hover:underline"
                data-testid="board-post-link"
                href={media.link.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                <span className="truncate">{media.link.host}</span>
                <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
              </a>
            ) : null}
          </div>
          {media.image ? (
            <img
              alt=""
              className="h-20 w-20 shrink-0 rounded-lg border object-cover sm:h-24 sm:w-24"
              data-testid="board-post-thumbnail"
              loading="lazy"
              referrerPolicy="no-referrer"
              src={rewriteRelayUrl(media.image)}
            />
          ) : null}
        </div>
        {preview ? (
          <p
            className="mt-1 line-clamp-3 text-sm text-muted-foreground"
            data-testid="board-post-preview"
          >
            {preview}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
