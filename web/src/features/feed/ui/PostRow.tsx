import { Link, useNavigate } from "@tanstack/react-router";
import { Bookmark, Heart, MessageCircle, Share } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { relativeTime, shortRelativeTime } from "@/shared/lib/relative-time";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  EMPTY_META,
  type Post,
  type PostMeta,
  type Profile,
} from "../feed-model";
import { NoteContent } from "../content";
import { useLikeNote } from "../use-feed";
import { useToggleBookmark } from "../use-social";
import { Avatar, displayNameOf } from "./Avatar";

function compact(n: number): string {
  return n === 0
    ? ""
    : new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

function ActionButton({
  label,
  count,
  tone,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  count: number;
  tone: "reply" | "like" | "share" | "bookmark";
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const hover = {
    reply: "hover:text-sky-500 [&:hover>span:first-child]:bg-sky-500/10",
    like: "hover:text-rose-500 [&:hover>span:first-child]:bg-rose-500/10",
    share: "hover:text-sky-500 [&:hover>span:first-child]:bg-sky-500/10",
    bookmark: "hover:text-sky-500 [&:hover>span:first-child]:bg-sky-500/10",
  }[tone];
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group relative z-10 flex items-center gap-0.5 text-[13px] text-muted-foreground transition-colors disabled:cursor-default",
        hover,
        active && tone === "like" && "text-rose-500",
        active && tone === "bookmark" && "text-sky-500",
      )}
    >
      <span className="-m-2 flex h-9 w-9 items-center justify-center rounded-full transition-colors [&_svg]:size-[18px]">
        {children}
      </span>
      <span className="min-w-4 tabular-nums">{compact(count)}</span>
    </button>
  );
}

/** One timeline row in the Twitter layout: avatar column + content column. */
export function PostRow({
  post,
  profile,
  meta = EMPTY_META,
  viewer,
  bookmarked = false,
}: {
  post: Post;
  profile?: Profile;
  meta?: PostMeta;
  viewer: string | null;
  bookmarked?: boolean;
}) {
  const { event } = post;
  const navigate = useNavigate();
  const like = useLikeNote();
  const bookmark = useToggleBookmark(viewer);
  const liked = meta.likedByViewer || like.isSuccess;
  const handle = profile?.name
    ? `@${profile.name}`
    : truncatePubkey(event.pubkey);

  function share() {
    const url = `${window.location.origin}/feed/${event.id}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Link copied to clipboard"))
      .catch(() => toast.error("Couldn't copy the link"));
  }

  return (
    <article className="relative flex gap-3 border-b px-4 pt-3 pb-1 transition-colors hover:bg-foreground/[0.03]">
      <Link
        to="/p/$id"
        params={{ id: event.pubkey }}
        aria-label={`${displayNameOf(event.pubkey, profile)}'s profile`}
        className="relative z-10 h-fit shrink-0"
      >
        <Avatar pubkey={event.pubkey} profile={profile} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1 text-[15px] leading-5">
          <Link
            to="/p/$id"
            params={{ id: event.pubkey }}
            className="relative z-10 truncate font-bold hover:underline"
          >
            {displayNameOf(event.pubkey, profile)}
          </Link>
          <span className="truncate text-muted-foreground">{handle}</span>
          <span className="text-muted-foreground">·</span>
          {/* Stretched link: the whole row opens the thread. */}
          <Link
            to="/feed/$noteId"
            params={{ noteId: event.id }}
            title={new Date(event.created_at * 1000).toLocaleString()}
            aria-label={`Open post from ${relativeTime(event.created_at)}`}
            className="shrink-0 text-muted-foreground after:absolute after:inset-0 hover:underline"
          >
            {shortRelativeTime(event.created_at)}
          </Link>
        </div>
        <div className="mt-0.5">
          <NoteContent content={event.content} />
        </div>
        <div className="mt-1 flex max-w-[425px] items-center justify-between">
          <ActionButton
            label="Reply"
            count={meta.replies}
            tone="reply"
            onClick={() =>
              navigate({ to: "/feed/$noteId", params: { noteId: event.id } })
            }
          >
            <MessageCircle />
          </ActionButton>
          <ActionButton
            label={liked ? "Liked" : "Like"}
            count={meta.likes + (like.isSuccess && !meta.likedByViewer ? 1 : 0)}
            tone="like"
            active={liked}
            disabled={!viewer || liked || like.isPending}
            onClick={() =>
              like.mutate(
                { id: event.id, author: event.pubkey },
                { onError: (e) => toast.error(e.message) },
              )
            }
          >
            <Heart className={cn(liked && "fill-current")} />
          </ActionButton>
          <ActionButton
            label={bookmarked ? "Remove bookmark" : "Bookmark"}
            count={0}
            tone="bookmark"
            active={bookmarked}
            disabled={!viewer}
            onClick={() =>
              bookmark.mutate(
                { id: event.id, add: !bookmarked },
                { onError: (e) => toast.error(e.message) },
              )
            }
          >
            <Bookmark className={cn(bookmarked && "fill-current")} />
          </ActionButton>
          <ActionButton
            label="Copy link"
            count={0}
            tone="share"
            onClick={share}
          >
            <Share />
          </ActionButton>
        </div>
      </div>
    </article>
  );
}
