import type { ReactNode } from "react";

const TOKEN = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]|#[\p{L}\p{N}_]+)/gu;
const IMAGE = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i;

export function extractImages(content: string): string[] {
  return (content.match(TOKEN) ?? []).filter(
    (t) => t.startsWith("http") && IMAGE.test(t),
  );
}

/** Render note text with links and hashtags highlighted; image URLs are shown as media. */
export function NoteContent({ content }: { content: string }) {
  const images = new Set(extractImages(content));
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of content.matchAll(TOKEN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) parts.push(content.slice(last, index));
    if (images.has(token)) {
      // rendered below as media
    } else if (token.startsWith("#")) {
      parts.push(
        <span key={index} className="text-primary">
          {token}
        </span>,
      );
    } else {
      parts.push(
        <a
          key={index}
          href={token}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="break-all text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {token.replace(/^https?:\/\//, "")}
        </a>,
      );
    }
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
