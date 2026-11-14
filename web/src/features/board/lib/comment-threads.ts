import type { BoardComment } from "./board-model.ts";

/** A comment and the replies directly answering it. */
export interface CommentThread {
  comment: BoardComment;
  children: CommentThread[];
}

/**
 * Group replies under their parent, oldest first within each branch. Missing
 * parents stay visible at the top level. Break malformed parent cycles so no
 * comment disappears and rendering always terminates.
 */
export function commentThreads(
  comments: readonly BoardComment[],
): CommentThread[] {
  const ordered = [...comments].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  const nodes = new Map<string, CommentThread>(
    ordered.map((comment) => [comment.id, { comment, children: [] }]),
  );
  const parents = new Map(
    ordered.map((comment) => [
      comment.id,
      comment.replyTo && nodes.has(comment.replyTo) ? comment.replyTo : null,
    ]),
  );
  const settled = new Set<string>();
  for (const comment of ordered) {
    const path = new Set<string>();
    let current: string | null = comment.id;
    while (current !== null && !settled.has(current)) {
      if (path.has(current)) {
        parents.set(current, null);
        break;
      }
      path.add(current);
      current = parents.get(current) ?? null;
    }
    for (const id of path) settled.add(id);
  }
  const roots: CommentThread[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(parents.get(node.comment.id) ?? "");
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
