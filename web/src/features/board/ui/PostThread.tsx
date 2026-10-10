/**
 * One post opened: its text, the replies under it, and a box to reply.
 *
 * Replies are in the order they were written, each with its own vote; an answer
 * to another reply says whom it answers. Only the author can delete their own
 * post or reply, after a confirmation. A slot above the text takes the header
 * for a post that is about a DAO decision.
 */

import { ArrowLeft } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

import type { BoardComment, BoardPost } from "../lib/board-model";
import type { BoardActions } from "../use-board-actions";
import { AuthorChip } from "./AuthorChip";
import { BoardMarkdown } from "./BoardMarkdown";
import { VoteButtons } from "./VoteButtons";

interface Target {
  kind: "post" | "reply";
  id: string;
}

export function PostThread({
  post,
  comments,
  profiles,
  me,
  actions,
  needAccount,
  onBack,
  header,
}: {
  post: BoardPost;
  comments: BoardComment[];
  profiles: Record<string, Profile> | undefined;
  me: string | null;
  actions: BoardActions;
  /** Tells a signed-out reader to make an account; true when they have one. */
  needAccount: (action: string) => boolean;
  onBack: () => void;
  header?: ReactNode;
}) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);

  const nameOf = (pubkey: string) =>
    resolveUserName(profiles?.[pubkey], pubkey);
  const byId = new Map(comments.map((c) => [c.id, c]));
  const replyingTo = replyTo ? byId.get(replyTo) : undefined;

  const run = async (what: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      toast.error(`Couldn't ${what}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const vote = (target: BoardPost | BoardComment, direction: "up" | "down") => {
    if (!needAccount("vote")) return;
    void run("vote", () => actions.vote(target.id, direction, target));
  };

  const sendReply = async () => {
    if (!needAccount("reply")) return;
    if (draft.trim() === "") {
      setProblem("Write something first.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await actions.comment({
        root: post.id,
        parent: replyingTo ? replyingTo.id : post.id,
        body: draft,
      });
      setDraft("");
      setReplyTo(null);
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't send that. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    await run(`delete that ${target.kind}`, async () => {
      await actions.remove(target.id);
      if (target.kind === "post") onBack();
    });
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="board-thread"
    >
      <div className="p-3">
        <Button
          data-testid="board-back"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          <ArrowLeft aria-hidden className="mr-1 h-4 w-4" /> All posts
        </Button>
      </div>
      <article className="flex gap-2 px-4 pb-4">
        <VoteButtons
          myVote={post.myVote}
          onVote={(direction) => vote(post, direction)}
          score={post.score}
          what="post"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold" data-testid="board-thread-title">
            {post.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <AuthorChip
              profile={profiles?.[post.author]}
              pubkey={post.author}
            />
            <span>{shortRelativeTime(post.createdAt)}</span>
            {me !== null && me === post.author ? (
              <button
                className="underline"
                data-testid="board-delete-post"
                onClick={() => setDeleting({ kind: "post", id: post.id })}
                type="button"
              >
                Delete
              </button>
            ) : null}
          </div>
          {header}
          {post.body ? (
            <div className="mt-3" data-testid="board-thread-body">
              <BoardMarkdown text={post.body} />
            </div>
          ) : null}
        </div>
      </article>

      <section aria-label="Replies" className="border-t px-4 py-3">
        <h3 className="text-sm font-semibold">
          {comments.length === 1 ? "1 reply" : `${comments.length} replies`}
        </h3>
        <ol className="mt-3 flex flex-col gap-4" data-testid="board-replies">
          {comments.map((comment) => {
            const parent = comment.replyTo
              ? byId.get(comment.replyTo)
              : undefined;
            return (
              <li
                className="flex gap-2"
                data-testid={`board-reply-${comment.id}`}
                key={comment.id}
              >
                <VoteButtons
                  myVote={comment.myVote}
                  onVote={(direction) => vote(comment, direction)}
                  score={comment.score}
                  what="reply"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <AuthorChip
                      profile={profiles?.[comment.author]}
                      pubkey={comment.author}
                    />
                    <span>{shortRelativeTime(comment.createdAt)}</span>
                    {parent ? (
                      <span>replying to {nameOf(parent.author)}</span>
                    ) : null}
                  </div>
                  <BoardMarkdown text={comment.body} />
                  <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
                    <button
                      className="underline"
                      data-testid="board-reply-to"
                      onClick={() => {
                        setReplyTo(comment.id);
                        document.getElementById("board-reply-box")?.focus();
                      }}
                      type="button"
                    >
                      Reply
                    </button>
                    {me !== null && me === comment.author ? (
                      <button
                        className="underline"
                        data-testid="board-delete-reply"
                        onClick={() =>
                          setDeleting({ kind: "reply", id: comment.id })
                        }
                        type="button"
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <form
        className="mt-auto flex flex-col gap-2 border-t p-4"
        data-testid="board-reply-form"
        onSubmit={(event) => {
          event.preventDefault();
          void sendReply();
        }}
      >
        {replyingTo ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="board-replying-to"
          >
            Replying to {nameOf(replyingTo.author)}.{" "}
            <button
              className="underline"
              onClick={() => setReplyTo(null)}
              type="button"
            >
              Reply to the post instead
            </button>
          </p>
        ) : null}
        <label className="sr-only" htmlFor="board-reply-box">
          Write a reply
        </label>
        <textarea
          className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          id="board-reply-box"
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            me === null ? "Create your account to reply." : "Write a reply"
          }
          value={draft}
        />
        {problem ? (
          <p
            className="text-xs text-destructive"
            data-testid="board-reply-problem"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
        <div>
          <Button
            data-testid="board-reply-submit"
            disabled={busy}
            size="sm"
            type="submit"
          >
            {busy ? "Sending…" : "Reply"}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        confirmLabel="Delete"
        description={`This ${deleting?.kind === "reply" ? "reply" : "post"} will be removed for everyone.`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        open={deleting !== null}
        title={`Delete this ${deleting?.kind === "reply" ? "reply" : "post"}?`}
      />
    </div>
  );
}
