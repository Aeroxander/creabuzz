import { Link, useNavigate } from "@tanstack/react-router";
import {
  ExternalLink,
  Lock,
  MessageCircle,
  ScrollText,
  Share,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { needAccountTo } from "@/features/identity/lib/account-copy";
import type { ProfileMetadata } from "@/features/profiles/lib/index-profiles";
import {
  resolveUserName,
  resolveUserSecondaryName,
} from "@/features/profiles/use-profiles";
import { VoteControl } from "@/features/social/ui/VoteControl";
import { existingUserPubkey } from "@/shared/lib/identity";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { relativeTime, shortRelativeTime } from "@/shared/lib/relative-time";
import { ServerImage } from "@/shared/ui/ServerImage";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { type FeedPost, postMedia, previewText } from "../lib/board-feed";
import type { BoardEvent } from "../lib/board-model";
import { useBoardActions } from "../use-board-actions";
import { useBoardStateRecord } from "../use-board-moderation";
import { failureWords } from "@/shared/lib/readable-error";

/**
 * A board post in the timeline, looking like every other post there: picture, name and time, then which board it is
 * on, its title, the first lines of its text and its first picture, and the same action bar with Reddit votes. It
 * opens on its board's page, where the discussion is.
 *
 * A post about a DAO decision has no vote arrows, as on the board: a vote here is not the DAO's vote. A thread its
 * board's moderators locked says so, as it does on the board.
 */
export function BoardPostCard({
  post,
  board,
  author,
  add,
}: {
  post: FeedPost;
  board: { id: string; name: string };
  author: ProfileMetadata | undefined;
  /** Merge a record the server just accepted (the reader's vote) into the list. */
  add: (event: BoardEvent) => void;
}) {
  const navigate = useNavigate();
  const actions = useBoardActions(post.boardId, add);
  const locked = useBoardStateRecord(post.boardId).locked.has(post.id);
  const name = resolveUserName(author, post.author);
  const handle = resolveUserSecondaryName(author, post.author);
  const media = postMedia(post.body);
  const preview = post.body ? previewText(post.body, 280) : "";
  const open = () =>
    void navigate({
      to: "/b/$boardId",
      params: { boardId: post.boardId },
      search: { post: post.id },
    });

  const vote = (direction: "+" | "-") => {
    if (existingUserPubkey() === null) {
      toast.error(needAccountTo("vote"));
      return;
    }
    actions
      .vote(post.id, direction === "+" ? "up" : "down", post)
      .catch((error) =>
        toast.error("Couldn't vote", {
          description: failureWords(error).text,
        }),
      );
  };

  const share = () => {
    const url = `${window.location.origin}/b/${post.boardId}?post=${post.id}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Couldn't copy the link"));
  };

  return (
    <article
      aria-label={`Board post by ${name}: ${post.title}`}
      className="relative border-b border-black/10 px-4 pb-1 pt-3 transition-colors hover:bg-black/[0.02] dark:border-white/10 dark:hover:bg-white/[0.03]"
      data-testid="social-board-post"
    >
      <div className="flex gap-3">
        <Link
          aria-label={`${name}'s profile`}
          className="relative z-10 h-fit shrink-0"
          params={{ pubkey: post.author }}
          to="/u/$pubkey"
        >
          <UserAvatar
            avatarUrl={author?.picture ?? null}
            className="h-11 w-11"
            displayName={name}
          />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-1 text-sm">
            <Link
              className="relative z-10 truncate font-bold text-black hover:underline dark:text-white"
              params={{ pubkey: post.author }}
              to="/u/$pubkey"
            >
              {name}
            </Link>
            <span className="truncate text-black/60 dark:text-white/60">
              {handle}
            </span>
            <span className="text-black/60 dark:text-white/60">·</span>
            <Link
              aria-label={`Open post from ${relativeTime(post.createdAt)}`}
              className="shrink-0 text-black/60 after:absolute after:inset-0 hover:underline dark:text-white/60"
              params={{ boardId: post.boardId }}
              search={{ post: post.id }}
              title={new Date(post.createdAt * 1000).toLocaleString()}
              to="/b/$boardId"
            >
              {shortRelativeTime(post.createdAt)}
            </Link>
          </p>
          <Link
            className="relative z-10 mt-0.5 inline-flex max-w-full items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-xs font-medium text-black/70 hover:bg-black/10 dark:bg-white/10 dark:text-white/70 dark:hover:bg-white/15"
            data-testid="social-board-post-board"
            params={{ boardId: board.id }}
            to="/b/$boardId"
          >
            <Users aria-hidden className="h-3 w-3 shrink-0" />
            <span className="truncate">{board.name}</span>
          </Link>
          {locked ? (
            <span
              className="ml-1.5 inline-flex items-center gap-1 text-xs text-black/60 dark:text-white/60"
              data-testid="social-board-post-locked"
            >
              <Lock aria-hidden className="h-3 w-3" /> Locked
            </span>
          ) : null}
          <h3
            className="mt-1 text-base font-bold leading-snug text-black dark:text-white"
            data-testid="social-board-post-title"
          >
            {post.title}
          </h3>
          {preview ? (
            <p className="mt-0.5 line-clamp-4 whitespace-pre-line text-sm text-black/80 dark:text-white/80">
              {preview}
            </p>
          ) : null}
          {media.image ? (
            <ServerImage
              alt=""
              className="mt-2 max-h-80 w-full rounded-2xl border border-black/10 object-cover dark:border-white/10"
              data-testid="social-board-post-picture"
              loading="lazy"
              referrerPolicy="no-referrer"
              src={rewriteRelayUrl(media.image)}
            />
          ) : null}
          {media.link ? (
            <a
              className="relative z-10 mt-1 inline-flex max-w-full items-center gap-1 text-xs text-sky-700 hover:underline dark:text-sky-400"
              href={media.link.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="truncate">{media.link.host}</span>
              <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
            </a>
          ) : null}
          <div className="mt-1 flex max-w-md items-center justify-between">
            <button
              aria-label={`Replies: ${post.commentCount}`}
              className="relative z-10 flex items-center gap-1 rounded-full py-1 pr-2 text-xs text-black/60 hover:text-sky-600 dark:text-white/60"
              data-testid="social-board-post-replies"
              onClick={open}
              type="button"
            >
              <span className="grid h-8 w-8 place-items-center rounded-full">
                <MessageCircle
                  aria-hidden
                  className="h-[1.15rem] w-[1.15rem]"
                />
              </span>
              {post.commentCount}
            </button>
            {post.proposal ? (
              <span className="inline-flex items-center gap-1 text-xs text-black/60 dark:text-white/60">
                <ScrollText aria-hidden className="h-4 w-4" /> About a decision
              </span>
            ) : (
              <VoteControl
                label={`post "${post.title}"`}
                mine={post.myVote === 1 ? "+" : post.myVote === -1 ? "-" : null}
                onVote={vote}
                score={post.score}
                testId="social-board-vote"
              />
            )}
            <button
              aria-label="Copy link to post"
              className="relative z-10 grid h-8 w-8 place-items-center rounded-full text-black/60 hover:bg-sky-500/10 hover:text-sky-600 dark:text-white/60"
              onClick={share}
              type="button"
            >
              <Share aria-hidden className="h-[1.15rem] w-[1.15rem]" />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
