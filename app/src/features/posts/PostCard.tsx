import { relativeTime } from "@creaton/core/client/relative-time.ts";
import {
  displayText,
  extractTopics,
  parseNote,
} from "@creaton/core/social/feed/feed-events.ts";
import { Link } from "@tanstack/react-router";
import { Bookmark, Heart, MessageCircle } from "lucide-react";
import { Fragment } from "react";
import { useBookmarks } from "../../lib/bookmarks";
import type { ProfileMetadata } from "../../lib/profiles";
import { nameOf, pictureOf } from "../../lib/profiles";
import { useRequireAccount } from "../../lib/use-require-account";
import { Avatar } from "../../ui/avatar";
import { cn } from "../../ui/cn";
import { useToast } from "../../ui/toast";
import { PostMore } from "../safety/PostMore";
import { SAVED_DONE, UNSAVED_DONE } from "../saved/saved-words";
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
          className="relative z-10 -my-3 truncate py-3 text-sm font-semibold hover:underline"
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

/** A `#topic` in a post's text, as the post's own topics (`extractTopics`) find it. */
const HASHTAG = /(^|\s)#([\p{L}\p{N}_-]{2,32})/gu;

/**
 * A post's text as written, cut into plain text and the `#topics` that open the posts under that topic. Only the topics the
 * post is tagged with link (a post carries its first five), so a link always leads to a page that holds this post.
 */
export function topicParts(
  text: string,
): (
  | { at: number; text: string }
  | { at: number; topic: string; label: string }
)[] {
  const tagged = new Set(extractTopics(text));
  const parts: (
    | { at: number; text: string }
    | { at: number; topic: string; label: string }
  )[] = [];
  let from = 0;
  for (const match of text.matchAll(HASHTAG)) {
    const topic = match[2].toLowerCase();
    if (!tagged.has(topic)) continue;
    const start = (match.index ?? 0) + match[1].length;
    if (start > from) parts.push({ at: from, text: text.slice(from, start) });
    parts.push({ at: start, topic, label: `#${match[2]}` });
    from = start + match[2].length + 1;
  }
  if (from < text.length) parts.push({ at: from, text: text.slice(from) });
  return parts;
}

/** A post's text as written: line breaks kept, long words broken, `#topics` open that topic. */
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
      {topicParts(displayText(text)).map((part) =>
        "topic" in part ? (
          <Link
            className="link relative z-10 -my-2 inline-block py-2 font-semibold"
            key={part.at}
            params={{ tag: part.topic }}
            to="/tag/$tag"
          >
            {part.label}
          </Link>
        ) : (
          <Fragment key={part.at}>{part.text}</Fragment>
        ),
      )}
    </p>
  );
}

/**
 * Like, comments, save and More for one post. The like is a press; the comments open the post; save keeps the post in the
 * person's private saved list; More offers Report and Hide. With the author's `name`, each press says whose post it is, so a
 * screen reader hears one post's presses apart from another's.
 */
export function PostActions({
  event,
  engagement,
  name,
}: {
  event: SignedEvent;
  engagement: Engagement;
  /** The author's name. */
  name?: string;
}) {
  const like = useLike();
  const requireAccount = useRequireAccount();
  const toast = useToast();
  const liked = engagement.myVote === "+";
  return (
    <div className="relative z-10 flex items-center gap-1 text-sm text-muted">
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
          <span className="sr-only">{`Like ${name}'s post, ${engagement.ups}`}</span>
        ) : null}
        <span aria-hidden={name ? "true" : undefined} className="num">
          {engagement.ups}
        </span>
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
      <SaveButton event={event} name={name} />
      <PostMore event={event} name={name ?? "this person"} />
    </div>
  );
}

/** Keep a post in the saved list (private to the person), or take it out again. */
function SaveButton({ event, name }: { event: SignedEvent; name?: string }) {
  const bookmarks = useBookmarks();
  const requireAccount = useRequireAccount();
  const toast = useToast();
  const saved = bookmarks.isSaved(event.id);
  const label = `${saved ? "Saved" : "Save"} ${name ? `${name}'s post` : "post"}`;
  return (
    <button
      aria-label={label}
      aria-pressed={saved}
      className={cn(
        "btn btn-ghost btn-sm",
        saved ? "text-mint-ink" : "text-muted",
      )}
      data-testid="post-save"
      onClick={() =>
        requireAccount(() => {
          const wanted = !saved;
          (wanted ? bookmarks.save(event.id) : bookmarks.remove(event.id)).then(
            () => toast(wanted ? SAVED_DONE : UNSAVED_DONE, "done"),
            (error: Error) => toast(error.message, "problem"),
          );
        })
      }
      type="button"
    >
      <Bookmark
        aria-hidden="true"
        fill={saved ? "currentColor" : "none"}
        size={18}
      />
    </button>
  );
}

/**
 * A post in a list: who, when, what, and its counts. Pressing the post opens it and its comments (the same place the
 * Comments press goes, which is the one a keyboard or a screen reader uses).
 */
export function PostCard({
  event,
  profiles,
  engagement,
}: {
  event: SignedEvent;
  profiles: Record<string, ProfileMetadata> | undefined;
  engagement: Engagement;
}) {
  const reply = parseNote(event)?.rootId != null;
  return (
    <article
      className="plain relative flex flex-col gap-2.5 rounded-2xl p-4"
      data-testid="post-card"
    >
      <Byline at={event.created_at} profiles={profiles} pubkey={event.pubkey} />
      {reply ? <p className="text-xs text-muted">Reply</p> : null}
      <PostText text={event.content} />
      <PostActions
        engagement={engagement}
        event={event}
        name={nameOf(profiles, event.pubkey)}
      />
      <Link
        aria-hidden="true"
        className="absolute inset-0 rounded-2xl"
        params={{ id: event.id }}
        tabIndex={-1}
        to="/post/$id"
      />
    </article>
  );
}
