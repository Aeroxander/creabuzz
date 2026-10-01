import { Link, useNavigate } from "@tanstack/react-router";
import { Bookmark, Heart, MessageCircle, Repeat2, Share } from "lucide-react";
import { useState } from "react";
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
import { useLikeNote, useRepost } from "../use-feed";
import { useToggleBookmark } from "../use-social";
import { Avatar, displayNameOf } from "./Avatar";
import { QuoteDialog } from "./QuoteDialog";

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
  tone: "reply" | "like" | "share" | "bookmark" | "repost";
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
    repost:
      "hover:text-emerald-500 [&:hover>span:first-child]:bg-emerald-500/10",
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
        active && tone === "repost" && "text-emerald-500",
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
  reposterProfile,
}: {
  post: Post;
  profile?: Profile;
  meta?: PostMeta;
  viewer: string | null;
  bookmarked?: boolean;
  reposterProfile?: Profile;
}) {
  const { event } = post;
  const navigate = useNavigate();
  const like = useLikeNote();
  const bookmark = useToggleBookmark(viewer);
  const repost = useRepost();
  const [menuOpen, setMenuOpen] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const reposted = meta.viewerRepostId !== null;
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
    <article className="relative border-b px-4 pt-3 pb-1 transition-colors hover:bg-foreground/[0.03]">
      {post.repostedBy && (
        <div className="mb-1 flex items-center gap-2 pl-[52px] text-[13px] font-bold text-muted-foreground">
          <Repeat2 className="h-4 w-4" />
          <Link
            to="/p/$id"
            params={{ id: post.repostedBy.pubkey }}
            className="relative z-10 truncate hover:underline"
          >
            {post.repostedBy.pubkey === viewer
              ? "You"
              : displayNameOf(post.repostedBy.pubkey, reposterProfile)}{" "}
            reposted
          </Link>
        </div>
      )}
      <div className="flex gap-3">
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
            <div className="relative">
              <ActionButton
                label={reposted ? "Reposted" : "Repost"}
                count={meta.reposts}
                tone="repost"
                active={reposted}
                disabled={!viewer}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Repeat2 />
              </ActionButton>
              {menuOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Close menu"
                    className="fixed inset-0 z-20 cursor-default"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    role="menu"
                    className="absolute bottom-full left-0 z-30 mb-1 w-44 overflow-hidden rounded-xl border bg-popover py-1 shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] font-bold hover:bg-foreground/5"
                      onClick={() => {
                        setMenuOpen(false);
                        repost.mutate(
                          meta.viewerRepostId
                            ? { action: "undo", repostId: meta.viewerRepostId }
                            : { action: "repost", note: event },
                          { onError: (e) => toast.error(e.message) },
                        );
                      }}
                    >
                      <Repeat2 className="h-4 w-4" />
                      {reposted ? "Undo repost" : "Repost"}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] font-bold hover:bg-foreground/5"
                      onClick={() => {
                        setMenuOpen(false);
                        setQuoting(true);
                      }}
                    >
                      <MessageCircle className="h-4 w-4" />
                      Quote
                    </button>
                  </div>
                </>
              )}
            </div>
            <ActionButton
              label={liked ? "Liked" : "Like"}
              count={
                meta.likes + (like.isSuccess && !meta.likedByViewer ? 1 : 0)
              }
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
      </div>
      <QuoteDialog
        open={quoting}
        onClose={() => setQuoting(false)}
        post={post}
        viewer={viewer}
      />
    </article>
  );
}
