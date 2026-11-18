/**
 * The replies under a post as a tree, Reddit style: each reply sits under the reply it answers (NIP-10 `reply`
 * marker, or the last `e` tag), siblings ordered by score, best first, then oldest first.
 *
 * A reply whose parent the server did not return is placed under the opened post when that post is the thread's
 * first one (its root), so nothing that answers the conversation is lost; under a reply deeper in, it is left out,
 * because it cannot be told whether it belongs under the opened reply.
 *
 * Pure and alias-free: `thread-tree.test.mjs` drives it under `node --test`.
 */

import type { Row } from "./timeline.ts";

export interface ReplyNode {
  row: Row;
  children: ReplyNode[];
}

export function buildReplyTree(
  rows: readonly Row[],
  focus: { id: string; isRoot: boolean },
  scoreOf: (id: string) => number = () => 0,
): ReplyNode[] {
  const byId = new Map<string, Row>();
  for (const row of rows) {
    if (row.event.id !== focus.id) byId.set(row.event.id, row);
  }
  const children = new Map<string, Row[]>();
  for (const row of byId.values()) {
    let parent = row.replyToId ?? row.rootId;
    if (parent === null) continue;
    if (parent !== focus.id && !byId.has(parent)) {
      if (!focus.isRoot || row.rootId !== focus.id) continue;
      parent = focus.id;
    }
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const order = (a: Row, b: Row) =>
    scoreOf(b.event.id) - scoreOf(a.event.id) ||
    a.event.created_at - b.event.created_at ||
    (a.event.id < b.event.id ? -1 : 1);
  const seen = new Set<string>();
  const grow = (id: string): ReplyNode[] =>
    (children.get(id) ?? [])
      .filter((row) => !seen.has(row.event.id) && seen.add(row.event.id))
      .sort(order)
      .map((row) => ({ row, children: grow(row.event.id) }));
  return grow(focus.id);
}

/** How many replies a tree holds, at every depth. */
export function countReplies(nodes: readonly ReplyNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countReplies(node.children), 0);
}
