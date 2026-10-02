import { Link } from "@tanstack/react-router";

import { resolveUserName } from "@/features/profiles/use-profiles";
import { relativeTime } from "@/shared/lib/relative-time";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { displayText } from "../../feed/lib/feed-events";
import { tokenize } from "../lib/content";
import { usePeople } from "../use-people";
import { useNotesById } from "../use-social-data";

const MAX_IMAGES = 4;
const MAX_QUOTES = 2;

function Mention({ pubkey }: { pubkey: string }) {
  const people = usePeople([pubkey]);
  return (
    <Link
      className="relative z-10 text-sky-700 hover:underline dark:text-sky-400"
      params={{ pubkey }}
      to="/u/$pubkey"
    >
      @{resolveUserName(people[pubkey], pubkey)}
    </Link>
  );
}

/** A quoted post, shown as a compact bordered card that opens the post. */
function QuoteCard({ id }: { id: string }) {
  const row = useNotesById([id]).data?.[0];
  const author = row?.event.pubkey;
  const people = usePeople(author ? [author] : []);
  if (!row || !author) {
    return (
      <div className="relative z-10 mt-3 rounded-xl border border-black/10 p-3 text-sm text-black/60 dark:border-white/10 dark:text-white/60">
        This post isn't available.
      </div>
    );
  }
  const name = resolveUserName(people[author], author);
  return (
    <div
      className="relative z-10 mt-3 overflow-hidden rounded-xl border border-black/10 p-3 transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.04]"
      data-testid="social-quote-card"
    >
      <div className="flex items-center gap-2 text-sm">
        <UserAvatar
          avatarUrl={people[author]?.picture ?? null}
          displayName={name}
          size="xs"
        />
        <Link
          className="truncate font-semibold text-black after:absolute after:inset-0 dark:text-white"
          params={{ id }}
          to="/social/post/$id"
        >
          {name}
        </Link>
        <span className="shrink-0 text-black/60 dark:text-white/60">
          · {relativeTime(row.event.created_at)}
        </span>
      </div>
      <div className="mt-1 line-clamp-6">
        <PostContent embed={false} text={row.event.content} />
      </div>
    </div>
  );
}

/**
 * A post's text: links, hashtags and mentions are live, image links become
 * media, and quoted posts become cards. `nostr:` references are what other
 * Nostr clients render the same way.
 */
export function PostContent({
  text,
  embed = true,
}: {
  text: string;
  embed?: boolean;
}) {
  const tokens = tokenize(displayText(text));
  const images = tokens.flatMap((t) => (t.type === "image" ? [t.url] : []));
  const quotes = embed
    ? [
        ...new Set(tokens.flatMap((t) => (t.type === "event" ? [t.id] : []))),
      ].slice(0, MAX_QUOTES)
    : [];

  return (
    <>
      <p className="whitespace-pre-wrap break-words text-base text-black dark:text-white">
        {tokens.map((token, i) => {
          const key = `${token.type}-${i}`;
          switch (token.type) {
            case "text":
              return token.text;
            case "hashtag":
              return (
                <Link
                  className="relative z-10 text-sky-700 hover:underline dark:text-sky-400"
                  key={key}
                  params={{ tag: token.tag }}
                  to="/social/tag/$tag"
                >
                  #{token.tag}
                </Link>
              );
            case "mention":
              return <Mention key={key} pubkey={token.pubkey} />;
            case "link":
              return (
                <a
                  className="relative z-10 break-all text-sky-700 hover:underline dark:text-sky-400"
                  href={token.url}
                  key={key}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                >
                  {token.url.replace(/^https?:\/\//, "")}
                </a>
              );
            default:
              // Images and quoted posts render below the text.
              return null;
          }
        })}
      </p>
      {images.length > 0 ? (
        <div
          className={`mt-3 grid gap-0.5 overflow-hidden rounded-xl border border-black/10 dark:border-white/10 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
        >
          {images.slice(0, MAX_IMAGES).map((src) => (
            <img
              alt=""
              className="max-h-96 w-full object-cover"
              key={src}
              loading="lazy"
              referrerPolicy="no-referrer"
              src={src}
            />
          ))}
        </div>
      ) : null}
      {quotes.map((id) => (
        <QuoteCard id={id} key={id} />
      ))}
    </>
  );
}
