import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { displayText } from "@creaton/core/social/feed/feed-events.ts";
import { Link } from "@tanstack/react-router";
import { Heart, MessageCircle } from "lucide-react";
import type { ProfileMetadata } from "../../lib/profiles";
import { nameOf, pictureOf } from "../../lib/profiles";
import { useRequireAccount } from "../../lib/use-require-account";
import { Avatar } from "../../ui/avatar";
import { cn } from "../../ui/cn";
import { useToast } from "../../ui/toast";
import { type Engagement, type SignedEvent, useLike } from "./use-posts";

/** Who wrote it and when, as one link to their profile. */
export function Byline({
  pubkey,
  profiles,
  at,
}: {
  pubkey: string;
  profiles: Record<string, ProfileMetadata> | undefined;
  at: number;
}) {
  const name = nameOf(profiles, pubkey);
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar
        name={name}
        picture={pictureOf(profiles, pubkey)}
        pubkey={pubkey}
        size="sm"
      />
      <div className="flex min-w-0 items-baseline gap-2">
        <Link
          className="-my-3 truncate py-3 text-sm font-semibold hover:underline"
          params={{ pubkey }}
          to="/u/$pubkey"
        >
          {name}
        </Link>
        <span className="shrink-0 text-xs text-muted">{relativeTime(at)}</span>
      </div>
    </div>
  );
}

/** A post's text as written: line breaks kept, long words broken. */
export function PostText({
  text,
  large = false,
}: {
  text: string;
  large?: boolean;
}) {
  return (
    <p
      className={cn(
        "whitespace-pre-wrap break-words leading-relaxed",
        large ? "text-lg" : "text-base",
      )}
    >
      {displayText(text)}
    </p>
  );
}

/** Like and reply counts. The like is a press; the reply opens the post. */
export function PostActions({
  event,
  engagement,
  name,
}: {
  event: SignedEvent;
  engagement: Engagement;
  /** The author's name: with it each press says whose post it is, so a screen reader hears one post's two presses apart from another's. */
  name?: string;
}) {
  const like = useLike();
  const requireAccount = useRequireAccount();
  const toast = useToast();
  const liked = engagement.myVote === "+";
  return (
    <div className="flex items-center gap-1 text-sm text-muted">
      <button
        aria-label={name ? undefined : `Like, ${engagement.ups}`}
        aria-pressed={liked}
        className={cn(
          "btn btn-ghost btn-sm",
          liked ? "text-mint-ink" : "text-muted",
        )}
        data-testid="post-like"
        disabled={like.isPending}
        onClick={() => {
          // A like is kept once given; pressing it again changes nothing.
          if (liked) return;
          requireAccount(() =>
            like.mutate(event, {
              onError: (error) => toast(error.message, "problem"),
            }),
          );
        }}
        type="button"
      >
        <Heart
          aria-hidden="true"
          fill={liked ? "currentColor" : "none"}
          size={18}
        />
        {name ? (
          <span className="sr-only">{`Like ${name}'s post,`}</span>
        ) : null}
        <span className="num">{engagement.ups}</span>
      </button>
      <Link
        aria-label={
          name
            ? `Comments on ${name}'s post, ${engagement.replies}`
            : `Comments, ${engagement.replies}`
        }
        className="btn btn-ghost btn-sm text-muted"
        params={{ id: event.id }}
        to="/post/$id"
      >
        <MessageCircle aria-hidden="true" size={18} />
        <span className="num">{engagement.replies}</span>
      </Link>
    </div>
  );
}

/** A post in a list: who, when, what, and its counts. The text opens the post and its comments. */
export function PostCard({
  event,
  profiles,
  engagement,
}: {
  event: SignedEvent;
  profiles: Record<string, ProfileMetadata> | undefined;
  engagement: Engagement;
}) {
  return (
    <article
      className="plain flex flex-col gap-2.5 rounded-2xl p-4"
      data-testid="post-card"
    >
      <Byline at={event.created_at} profiles={profiles} pubkey={event.pubkey} />
      <Link
        className="block rounded-lg focus-visible:outline-2 focus-visible:outline-mint-ink"
        params={{ id: event.id }}
        to="/post/$id"
      >
        <PostText text={event.content} />
      </Link>
      <PostActions
        engagement={engagement}
        event={event}
        name={nameOf(profiles, event.pubkey)}
      />
    </article>
  );
}
