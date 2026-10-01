import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { parseEntity } from "@/shared/lib/nip19";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { isImageUrl } from "./feed-model";
import { usePostsByIds, useProfiles } from "./use-feed";
import { Avatar, displayNameOf } from "./ui/Avatar";

const TOKEN =
  /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]|nostr:[0-9a-z]+|(?<=^|[\s(])#[\p{L}\p{N}_]+)/gu;

export function extractImages(content: string): string[] {
  return (content.match(TOKEN) ?? []).filter(
    (t) => t.startsWith("http") && isImageUrl(t),
  );
}

function Mention({ pubkey }: { pubkey: string }) {
  const profile = useProfiles([pubkey]).data?.get(pubkey);
  return (
    <Link
      to="/p/$id"
      params={{ id: pubkey }}
      className="relative z-10 text-primary hover:underline"
    >
      @{profile?.name ?? displayNameOf(pubkey, profile)}
    </Link>
  );
}

function renderToken(token: string, key: number): ReactNode {
  if (token.startsWith("#")) {
    const tag = token.slice(1).toLowerCase();
    return (
      <Link
        key={key}
        to="/tag/$tag"
        params={{ tag }}
        className="relative z-10 text-primary hover:underline"
      >
        {token}
      </Link>
    );
  }
  if (token.startsWith("nostr:")) {
    const entity = parseEntity(token);
    if (entity?.type === "pubkey") {
      return <Mention key={key} pubkey={entity.pubkey} />;
    }
    if (entity?.type === "event") return null; // shown as an embedded card
    return token;
  }
  return (
    <a
      key={key}
      href={token}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="relative z-10 break-all text-primary hover:underline"
    >
      {token.replace(/^https?:\/\//, "")}
    </a>
  );
}

/** A quoted note (NIP-18 `q` / `nostr:nevent`) rendered as a compact bordered card. */
function QuotedPost({ id }: { id: string }) {
  const post = usePostsByIds([id]).data?.[0];
  const author = post?.event.pubkey;
  const profile = useProfiles(author ? [author] : []).data?.get(author ?? "");
  if (!post || !author) {
    return (
      <div className="relative z-10 mt-3 rounded-2xl border p-3 text-sm text-muted-foreground">
        This post isn’t available.
      </div>
    );
  }
  return (
    <div className="relative z-10 mt-3 overflow-hidden rounded-2xl border p-3 transition-colors hover:bg-foreground/[0.04]">
      <div className="flex items-center gap-2 text-[15px] leading-5">
        <Avatar
          pubkey={author}
          profile={profile}
          className="h-5 w-5 text-[10px]"
        />
        <Link
          to="/feed/$noteId"
          params={{ noteId: id }}
          className="truncate font-bold after:absolute after:inset-0"
        >
          {displayNameOf(author, profile)}
        </Link>
        {profile?.name && (
          <span className="truncate text-muted-foreground">
            @{profile.name}
          </span>
        )}
        <span className="text-muted-foreground">
          · {shortRelativeTime(post.event.created_at)}
        </span>
      </div>
      <div className="mt-1 line-clamp-6">
        <NoteContent content={post.event.content} embed={false} />
      </div>
    </div>
  );
}

/** Render note text: links, hashtags, `nostr:` mentions; image URLs become media, event refs become quote cards. */
export function NoteContent({
  content,
  embed = true,
}: {
  content: string;
  embed?: boolean;
}) {
  const images = new Set(extractImages(content));
  const quoted = embed
    ? [
        ...new Set(
          (content.match(/nostr:[0-9a-z]+/g) ?? []).flatMap((t) => {
            const entity = parseEntity(t);
            return entity?.type === "event" ? [entity.id] : [];
          }),
        ),
      ].slice(0, 2)
    : [];
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of content.matchAll(TOKEN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) parts.push(content.slice(last, index));
    if (!images.has(token)) parts.push(renderToken(token, index));
    last = index + token.length;
  }
  if (last < content.length) parts.push(content.slice(last));

  return (
    <>
      <p className="whitespace-pre-wrap break-words text-[15px] leading-5">
        {parts}
      </p>
      {quoted.map((id) => (
        <QuotedPost key={id} id={id} />
      ))}
      {images.size > 0 && (
        <div
          className={`mt-3 grid gap-0.5 overflow-hidden rounded-2xl border ${
            images.size > 1 ? "grid-cols-2" : "grid-cols-1"
          }`}
        >
          {[...images].slice(0, 4).map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="max-h-[510px] w-full object-cover"
            />
          ))}
        </div>
      )}
    </>
  );
}
