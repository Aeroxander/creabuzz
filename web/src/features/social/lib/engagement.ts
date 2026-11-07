/**
 * Per-note engagement counts from the events that reference it: votes (`+` and
 * `-` reactions, NIP-25; each person's newest one counts, so changing a vote
 * replaces it), reposts (kind 6), quotes (`q` tags) and direct replies.
 * Pure and alias-free: `social.test.mjs` drives it under `node --test`.
 */

import {
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "../../../shared/constants/kinds.ts";
import { parseNote, type SignedEventLike } from "../../feed/lib/feed-events.ts";

export interface Engagement {
  /** People whose newest vote on the note is up / down. */
  ups: number;
  downs: number;
  reposts: number;
  quotes: number;
  replies: number;
  /** The viewer's newest vote, if any. */
  myVote: "+" | "-" | null;
  /**
   * Every vote record the viewer has on the note, newest first. Taking a vote
   * back, or changing it, deletes all of them so none can count again.
   */
  myVoteIds: string[];
  /** The viewer's own repost event id, so it can be undone. */
  viewerRepostId: string | null;
}

export const NO_ENGAGEMENT: Engagement = {
  ups: 0,
  downs: 0,
  reposts: 0,
  quotes: 0,
  replies: 0,
  myVote: null,
  myVoteIds: [],
  viewerRepostId: null,
};

/** Up votes minus down votes: the number people see. */
export function netScore(
  engagement: Pick<Engagement, "ups" | "downs">,
): number {
  return engagement.ups - engagement.downs;
}

/** `+` (or an empty reaction, which NIP-25 reads as a like) and `-` are votes; emoji reactions are not. */
function voteOf(content: string): "+" | "-" | null {
  if (content === "+" || content === "") return "+";
  if (content === "-") return "-";
  return null;
}

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
    ids.map((id) => [id, { ...NO_ENGAGEMENT, myVoteIds: [] }]),
  );
  const seen = new Set<string>();
  // target → voter → that voter's votes, newest first once sorted.
  const votes = new Map<string, Map<string, SignedEventLike[]>>();
  for (const e of related) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);

    if (e.kind === KIND_REACTION) {
      if (voteOf(e.content) === null) continue;
      const target = lastTagValue(e.tags, "e") ?? "";
      if (!out.has(target)) continue;
      const byVoter = votes.get(target) ?? new Map<string, SignedEventLike[]>();
      byVoter.set(e.pubkey, [...(byVoter.get(e.pubkey) ?? []), e]);
      votes.set(target, byVoter);
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
  for (const [targetId, byVoter] of votes) {
    const target = out.get(targetId);
    if (!target) continue;
    for (const [voter, list] of byVoter) {
      list.sort(
        (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
      );
      const vote = voteOf(list[0].content);
      if (vote === "+") target.ups += 1;
      else if (vote === "-") target.downs += 1;
      if (viewer && voter === viewer) {
        target.myVote = vote;
        target.myVoteIds = list.map((e) => e.id);
      }
    }
  }
  return out;
}
