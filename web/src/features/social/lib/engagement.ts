/**
 * Per-note engagement counts from the events that reference it: likes
 * (`+` reactions), reposts (kind 6), quotes (`q` tags) and direct replies.
 * Pure and alias-free: `social.test.mjs` drives it under `node --test`.
 */

import {
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "../../../shared/constants/kinds.ts";
import { parseNote, type SignedEventLike } from "../../feed/lib/feed-events.ts";

export interface Engagement {
  likes: number;
  reposts: number;
  quotes: number;
  replies: number;
  likedByViewer: boolean;
  /** The viewer's own repost event id, so it can be undone. */
  viewerRepostId: string | null;
}

export const NO_ENGAGEMENT: Engagement = {
  likes: 0,
  reposts: 0,
  quotes: 0,
  replies: 0,
  likedByViewer: false,
  viewerRepostId: null,
};

export function tagValues(tags: string[][], name: string): string[] {
  return [
    ...new Set(
      tags
        .filter((t) => t[0] === name && typeof t[1] === "string" && t[1])
        .map((t) => t[1]),
    ),
  ];
}

export function lastTagValue(
  tags: string[][],
  name: string,
): string | undefined {
  const values = tagValues(tags, name);
  return values[values.length - 1];
}

/** Engagement for every id in `ids`, counting each referencing event once. */
export function computeEngagement(
  ids: readonly string[],
  related: readonly SignedEventLike[],
  viewer: string | null,
): Map<string, Engagement> {
  const out = new Map<string, Engagement>(
    ids.map((id) => [id, { ...NO_ENGAGEMENT }]),
  );
  const seen = new Set<string>();
  for (const e of related) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);

    if (e.kind === KIND_REACTION) {
      if (e.content !== "+" && e.content !== "") continue;
      const target = out.get(lastTagValue(e.tags, "e") ?? "");
      if (!target) continue;
      target.likes += 1;
      if (viewer && e.pubkey === viewer) target.likedByViewer = true;
    } else if (e.kind === KIND_REPOST) {
      const target = out.get(lastTagValue(e.tags, "e") ?? "");
      if (!target) continue;
      target.reposts += 1;
      if (viewer && e.pubkey === viewer) target.viewerRepostId = e.id;
    } else if (e.kind === KIND_TEXT_NOTE) {
      for (const quoted of tagValues(e.tags, "q")) {
        const target = out.get(quoted);
        if (target) target.quotes += 1;
      }
      const note = parseNote(e);
      const parent = note?.replyToId ? out.get(note.replyToId) : undefined;
      if (parent) parent.replies += 1;
    }
  }
  return out;
}
