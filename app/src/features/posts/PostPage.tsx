import { MAX_POST_CHARS } from "@creaton/core/social/feed/feed-events.ts";
import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { useState } from "react";
import { useAccount } from "../../lib/account";
import { nameOf, useProfiles } from "../../lib/profiles";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { TextArea } from "../../ui/field";
import { useToast } from "../../ui/toast";
import { BackHeader } from "../../app/BackHeader";
import { FoldedPost } from "../safety/FoldedPost";
import { Byline, PostActions, PostText } from "./PostCard";
import {
  engagementOf,
  type Row,
  useEngagement,
  usePublishReply,
  useThread,
} from "./use-posts";

/** How far replies step in: deeper replies line up with the third level so a phone keeps its width. */
const MAX_DEPTH = 3;

interface Node {
  row: Row;
  depth: number;
}

/** Replies in reading order: each reply under the one it answers, oldest first at every level. */
export function replyOrder(focusId: string, replies: readonly Row[]): Node[] {
  const children = new Map<string, Row[]>();
  for (const row of replies) {
    const parent = row.replyToId ?? focusId;
    const list = children.get(parent) ?? [];
    list.push(row);
    children.set(parent, list);
  }
  for (const list of children.values())
    list.sort(
      (a, b) =>
        a.event.created_at - b.event.created_at ||
        (a.event.id < b.event.id ? -1 : 1),
    );
  const out: Node[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    for (const row of children.get(id) ?? []) {
      if (seen.has(row.event.id)) continue;
      seen.add(row.event.id);
      out.push({ row, depth: Math.min(depth, MAX_DEPTH) });
      walk(row.event.id, depth + 1);
    }
  };
  walk(focusId, 0);
  return out;
}

/** A post and its comments, with a box to reply at the foot. */
export function PostPage({ id }: { id: string }) {
  const thread = useThread(id);
  const note = thread.data?.note ?? null;
  const ancestors = thread.data?.ancestors ?? [];
  const replies = (thread.data?.replies ?? []).filter(
    (row) => row.event.id !== id,
  );
  const below = note
    ? replyOrder(
        note.event.id,
        replies.filter((r) => isUnder(r, note.event.id, replies)),
      )
    : [];
  const people = [
    ...ancestors.map((r) => r.event.pubkey),
    ...(note ? [note.event.pubkey] : []),
    ...below.map((n) => n.row.event.pubkey),
  ];
  const profiles = useProfiles(people).data;
  const engagement = useEngagement(
    note ? [note.event.id, ...below.map((n) => n.row.event.id)] : [],
  ).data;

  return (
    <main className="screen mx-auto flex max-w-lg flex-col gap-4">
      <BackHeader title="Post" />
      {thread.isPending ? (
        <Card className="h-40 animate-pulse" tone="plain" />
      ) : thread.isError ? (
        <EmptyState
          action={
            <Button onClick={() => void thread.refetch()} variant="secondary">
              Try again
            </Button>
          }
          title="This post could not be read"
        >
          {readFailureWords(thread.error).text}
        </EmptyState>
      ) : !note ? (
        <EmptyState title="This post is not here">
          It may have been removed by the person who wrote it.
        </EmptyState>
      ) : (
        <>
          {ancestors.map((row) => (
            <FoldedPost event={row.event} key={row.event.id}>
              <Card className="opacity-80" tone="plain">
                <Byline
                  at={row.event.created_at}
                  profiles={profiles}
                  pubkey={row.event.pubkey}
                />
                <div className="mt-2 text-sm">
                  <PostText text={row.event.content} />
                </div>
              </Card>
            </FoldedPost>
          ))}
          <FoldedPost event={note.event}>
            <article
              className="plain flex flex-col gap-3 rounded-2xl p-4"
              data-testid="post-focus"
            >
              <Byline
                at={note.event.created_at}
                profiles={profiles}
                pubkey={note.event.pubkey}
              />
              <PostText large text={note.event.content} />
              <PostActions
                engagement={engagementOf(engagement, note.event.id)}
                event={note.event}
                name={nameOf(profiles, note.event.pubkey)}
              />
            </article>
          </FoldedPost>
          <ReplyBox note={note} root={ancestors[0] ?? note} />
          <section aria-label="Comments" className="flex flex-col gap-2">
            {below.length === 0 ? (
              <p className="px-1 text-sm text-muted">No comments yet.</p>
            ) : (
              below.map(({ row, depth }) => (
                <div
                  key={row.event.id}
                  style={{ marginLeft: `${depth * 0.875}rem` }}
                >
                  <FoldedPost event={row.event}>
                    <article
                      className="plain flex flex-col gap-2 rounded-2xl p-3"
                      data-testid="comment"
                    >
                      <Byline
                        at={row.event.created_at}
                        profiles={profiles}
                        pubkey={row.event.pubkey}
                      />
                      <PostText text={row.event.content} />
                      <PostActions
                        engagement={engagementOf(engagement, row.event.id)}
                        event={row.event}
                        name={nameOf(profiles, row.event.pubkey)}
                      />
                    </article>
                  </FoldedPost>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </main>
  );
}

/** Whether a reply sits under the focused note (a thread read by its root also holds the root's other branches). */
function isUnder(row: Row, focusId: string, all: readonly Row[]): boolean {
  const byId = new Map(all.map((r) => [r.event.id, r]));
  let parent = row.replyToId;
  for (let hops = 0; parent && hops < 50; hops += 1) {
    if (parent === focusId) return true;
    parent = byId.get(parent)?.replyToId ?? null;
  }
  return false;
}

function ReplyBox({ note, root }: { note: Row; root: Row }) {
  const { pubkey } = useAccount();
  const requireAccount = useRequireAccount();
  const reply = usePublishReply();
  const toast = useToast();
  const [text, setText] = useState("");
  const tooLong = text.length > MAX_POST_CHARS;
  if (!pubkey)
    return (
      <Button
        block
        data-testid="reply-sign-up"
        onClick={() => requireAccount(() => {})}
        variant="secondary"
      >
        Sign up to comment
      </Button>
    );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        reply.mutate(
          { text, root: root.event, parent: note.event },
          {
            onSuccess: () => {
              setText("");
              toast("Comment posted", "done");
            },
            onError: (error) => toast(error.message, "problem"),
          },
        );
      }}
    >
      <TextArea
        data-testid="reply-text"
        label="Comment"
        onChange={(e) => setText(e.target.value)}
        problem={tooLong ? "That is longer than a comment can be." : null}
        rows={3}
        value={text}
      />
      <Button
        data-testid="reply-send"
        disabled={!text.trim() || tooLong || reply.isPending}
        type="submit"
      >
        Comment
      </Button>
    </form>
  );
}
