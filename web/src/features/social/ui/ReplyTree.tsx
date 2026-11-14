import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

import type { SignedEventLike } from "@/features/feed/lib/feed-events";
import { cn } from "@/shared/lib/cn";
import { existingUserPubkey } from "@/shared/lib/identity";

import { netScore } from "../lib/engagement";
import {
  buildReplyTree,
  countReplies,
  type ReplyNode,
} from "../lib/thread-tree";
import type { Row } from "../lib/timeline";
import { useLaunchUpdates } from "../use-launch-updates";
import { engagementOf, useEngagementMap, usePeople } from "../use-people";
import { useBookmarkIds } from "../use-bookmarks";
import { useMutedPeople } from "../use-social-actions";
import { PostCard } from "./PostCard";
import { PostComposer } from "./PostComposer";
import { useLaunchName } from "./PostList";

/** Past this depth a branch continues on the reply's own page, so text never narrows to nothing on a phone. */
const MAX_DEPTH = 6;

/**
 * Every reply in a conversation, nested under the reply it answers, Reddit style: a line down the left of each
 * branch, the best-voted reply first among its siblings, and Reply opening a box right under the reply it answers.
 *
 * The order is taken when the set of replies changes, not on each vote, so a reply does not jump while it is read.
 */
export function ReplyTree({
  replies,
  focus,
  root,
}: {
  replies: readonly Row[];
  /** The opened post, and whether it is the thread's first post. */
  focus: { event: SignedEventLike; isRoot: boolean };
  /** The thread's first post, which every reply names as its root. */
  root: SignedEventLike;
}) {
  const me = existingUserPubkey();
  const muted = useMutedPeople().data;
  const visible = useMemo(
    () =>
      muted?.size
        ? replies.filter((row) => !muted.has(row.event.pubkey))
        : replies,
    [replies, muted],
  );
  const ids = useMemo(() => visible.map((row) => row.event.id), [visible]);
  const engagement = useEngagementMap(ids, me);
  const people = usePeople(
    useMemo(() => visible.map((row) => row.event.pubkey), [visible]),
  );
  const bookmarks = useBookmarkIds().data;
  const launchName = useLaunchName();
  const officialUpdates = useLaunchUpdates().ids;

  // Scores as they were when this set of replies arrived: the order holds still while votes come in.
  const held = useRef<{ key: string; scores: Map<string, number> } | null>(
    null,
  );
  const key = [...ids].sort().join(",");
  const scoresReady = ids.every((id) => engagement.has(id));
  if (held.current?.key !== key && (scoresReady || ids.length === 0)) {
    held.current = {
      key,
      scores: new Map(
        ids.map((id) => [id, netScore(engagementOf(engagement, id))]),
      ),
    };
  }
  const scores = held.current?.key === key ? held.current.scores : null;
  const tree = useMemo(
    () =>
      buildReplyTree(
        visible,
        { id: focus.event.id, isRoot: focus.isRoot },
        (id) => scores?.get(id) ?? 0,
      ),
    [visible, focus.event.id, focus.isRoot, scores],
  );

  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const branch = (nodes: ReplyNode[], depth: number) => (
    <ol
      className={cn(
        depth > 0 &&
          "ml-6 border-l-2 border-black/10 dark:border-white/10 max-sm:ml-3",
      )}
      data-testid={depth === 0 ? "social-reply-tree" : "social-reply-branch"}
    >
      {nodes.map((node) => {
        const note = node.row.event;
        const hidden = countReplies(node.children);
        return (
          <li data-testid={`social-reply-${note.id}`} key={note.id}>
            <PostCard
              author={people[note.pubkey]}
              bookmarked={bookmarks?.includes(note.id) ?? false}
              engagement={engagementOf(engagement, note.id)}
              launchName={launchName}
              launchUpdate={officialUpdates.has(note.id)}
              onReply={() =>
                setReplyingTo((current) =>
                  current === note.id ? null : note.id,
                )
              }
              row={node.row}
            />
            {replyingTo === note.id ? (
              <div className="ml-6 max-sm:ml-3">
                <PostComposer
                  onPosted={() => setReplyingTo(null)}
                  placeholder="Write a reply"
                  replyTo={{ root, parent: note }}
                  testId={`social-reply-to-${note.id}`}
                />
              </div>
            ) : null}
            {node.children.length === 0 ? null : depth + 1 >= MAX_DEPTH ? (
              <Link
                className="ml-6 block py-2 text-sm font-medium text-sky-700 hover:underline dark:text-sky-400 max-sm:ml-3"
                data-testid="social-reply-continue"
                params={{ id: note.id }}
                to="/social/post/$id"
              >
                Continue this thread ({hidden}{" "}
                {hidden === 1 ? "reply" : "replies"})
              </Link>
            ) : (
              branch(node.children, depth + 1)
            )}
          </li>
        );
      })}
    </ol>
  );

  if (tree.length === 0) return null;
  return branch(tree, 0);
}
