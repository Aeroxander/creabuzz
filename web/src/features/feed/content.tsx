import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { parseEntity } from "@/shared/lib/nip19";
import { isImageUrl } from "./feed-model";
import { useProfiles } from "./use-feed";
import { displayNameOf } from "./ui/Avatar";

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
    if (entity?.type === "event") {
      return (
        <Link
          key={key}
          to="/feed/$noteId"
          params={{ noteId: entity.id }}
          className="relative z-10 text-primary hover:underline"
        >
          post
        </Link>
      );
    }
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

/** Render note text: links, hashtags, `nostr:` mentions; image URLs become media. */
export function NoteContent({ content }: { content: string }) {
  const images = new Set(extractImages(content));
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
