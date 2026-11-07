/**
 * Splits a note's text into what a client renders: plain text, links,
 * hashtags, `$TICKER` cashtags, `nostr:` mentions, quoted-event references and inline images.
 * Pure and alias-free: `social.test.mjs` drives it under `node --test`.
 */

import { type Entity, parseEntity } from "./entity.ts";

export type Token =
  | { type: "text"; text: string }
  | { type: "link"; url: string }
  | { type: "image"; url: string }
  | { type: "hashtag"; tag: string }
  | { type: "cashtag"; symbol: string }
  | { type: "mention"; pubkey: string }
  | { type: "event"; id: string; author?: string };

// A cashtag is `$` and a ticker of 2 to 8 letters or digits that starts with a letter, so `$5` and `$100` stay prices.
const TOKEN =
  /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]|nostr:[0-9a-z]+|(?<=^|[\s(])#[\p{L}\p{N}_-]{2,64}|(?<=^|[\s(])\$[A-Za-z][A-Za-z0-9]{1,7}(?![A-Za-z0-9$]))/gu;
const IMAGE = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i;

export function isImageUrl(url: string): boolean {
  return /^https?:\/\//.test(url) && IMAGE.test(url);
}

function entityToken(entity: Entity | null, raw: string): Token {
  if (entity?.type === "pubkey") {
    return { type: "mention", pubkey: entity.pubkey };
  }
  if (entity?.type === "event") {
    return { type: "event", id: entity.id, author: entity.author };
  }
  return { type: "text", text: raw };
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > last)
      tokens.push({ type: "text", text: text.slice(last, index) });
    if (raw.startsWith("#")) {
      tokens.push({ type: "hashtag", tag: raw.slice(1).toLowerCase() });
    } else if (raw.startsWith("$")) {
      tokens.push({ type: "cashtag", symbol: raw.slice(1).toUpperCase() });
    } else if (raw.startsWith("nostr:")) {
      tokens.push(entityToken(parseEntity(raw), raw));
    } else if (isImageUrl(raw)) {
      tokens.push({ type: "image", url: raw });
    } else {
      tokens.push({ type: "link", url: raw });
    }
    last = index + raw.length;
  }
  if (last < text.length) tokens.push({ type: "text", text: text.slice(last) });
  return tokens;
}

/** Tickers written as `$TICKER`, upper-cased and deduplicated, in the order they first appear. */
export function cashtagSymbols(text: string): string[] {
  return [
    ...new Set(
      tokenize(text).flatMap((t) => (t.type === "cashtag" ? [t.symbol] : [])),
    ),
  ];
}

/** Pubkeys mentioned with `nostr:npub…` / `nostr:nprofile…`, deduplicated. */
export function mentionedPubkeys(text: string): string[] {
  return [
    ...new Set(
      tokenize(text).flatMap((t) => (t.type === "mention" ? [t.pubkey] : [])),
    ),
  ];
}

/** Event ids quoted with `nostr:nevent…` / `nostr:note…`, deduplicated. */
export function quotedEventIds(text: string): string[] {
  return [
    ...new Set(
      tokenize(text).flatMap((t) => (t.type === "event" ? [t.id] : [])),
    ),
  ];
}
