/**
 * The threads about a DAO's decisions, from the posts found on its community's
 * boards: which post belongs to which decision, newest first.
 *
 * A post's decision tag is a claim by its author (see `proposal-link.ts`), so a
 * post counts for a decision only when its tag names exactly that DAO on that
 * chain; anything else is ignored rather than guessed at.
 *
 * Alias-free; `proposal-threads.test.mjs` drives it under `node --test`.
 */

import type { BoardEvent } from "./board-model.ts";
import { splitPost } from "./post-text.ts";
import { proposalOf } from "./proposal-link.ts";

export interface ProposalThread {
  boardId: string;
  boardName: string;
  postId: string;
  title: string;
  author: string;
  createdAt: number;
  /** The decision id the post names. */
  decisionId: string;
}

/** Group posts, each read from the named board, by the decision of `dao` (on `chainId`) they are about. */
export function groupProposalThreads(
  found: readonly { boardId: string; boardName: string; post: BoardEvent }[],
  chainId: number,
  dao: string,
): Map<string, ProposalThread[]> {
  const wanted = dao.toLowerCase();
  const byDecision = new Map<string, ProposalThread[]>();
  const seen = new Set<string>();
  for (const { boardId, boardName, post } of found) {
    if (post.kind !== 45001 || seen.has(post.id)) continue;
    const ref = proposalOf(post.tags);
    if (ref === null || ref.chainId !== chainId || ref.dao !== wanted) continue;
    seen.add(post.id);
    const list = byDecision.get(ref.id) ?? [];
    list.push({
      boardId,
      boardName,
      postId: post.id,
      title: splitPost(post.content).title,
      author: post.pubkey,
      createdAt: post.created_at,
      decisionId: ref.id,
    });
    byDecision.set(ref.id, list);
  }
  for (const list of byDecision.values()) {
    list.sort(
      (a, b) => b.createdAt - a.createdAt || (a.postId < b.postId ? 1 : -1),
    );
  }
  return byDecision;
}
