/**
 * One post opened: its text, the replies under it, and a box to reply.
 *
 * Replies nest under the comment they answer, with an inline composer at the
 * selected parent. Only the author can delete their own
 * post or reply, after a confirmation. A slot above the text takes the header
 * for a post that is about a DAO decision.
 */

import { ArrowLeft, ScrollText } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

import type { BoardComment, BoardPost } from "../lib/board-model";
import { commentThreads } from "../lib/comment-threads";
import type { BoardActions } from "../use-board-actions";
import { AuthorChip } from "./AuthorChip";
import { BoardMarkdown } from "./BoardMarkdown";
import { BoardModeration } from "./BoardModeration";
import { CommentReplies } from "./CommentReplies";
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
  badges,
  canModerate = false,
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
  /** A short fact beside a person's name, by public key. */
  badges?: Record<string, string>;
  /** The reader owns or administers this board: they may remove other people's posts and replies. */
  canModerate?: boolean;
}) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const focusRequested = useRef(false);

  const nameOf = (pubkey: string) =>
    resolveUserName(profiles?.[pubkey], pubkey);
  const byId = new Map(comments.map((c) => [c.id, c]));
  const replyingTo = replyTo ? byId.get(replyTo) : undefined;
  const threads = useMemo(() => commentThreads(comments), [comments]);
  const focusTarget = replyTo === null ? null : (replyingTo?.id ?? post.id);

  useEffect(() => {
    if (focusTarget !== null || focusRequested.current)
      replyBox.current?.focus();
    focusRequested.current = false;
  }, [focusTarget]);

  const selectReply = (id: string | null) => {
    if (sending.current) return;
    setProblem(null);
    if (id === replyTo) {
      replyBox.current?.focus();
      return;
    }
    focusRequested.current = true;
    setReplyTo(id);
  };

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
    if (sending.current) return;
    if (!needAccount("reply")) return;
    if (replyTo !== null && !replyingTo) {
      setProblem(
        "That reply is no longer here. Choose another reply, or reply to the post instead.",
      );
      return;
    }
    if (draft.trim() === "") {
      setProblem("Write something first.");
      return;
    }
    sending.current = true;
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
      sending.current = false;
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

  const replyForm = (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/20 p-3"
      data-testid="board-reply-form"
      onSubmit={(event) => {
        event.preventDefault();
        void sendReply();
      }}
    >
      {replyTo !== null ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="board-replying-to"
          id="board-reply-target"
          role={replyingTo ? "status" : "alert"}
        >
          {replyingTo
            ? `Replying to ${nameOf(replyingTo.author)}.`
            : "The reply you selected is no longer here. Your draft is kept."}{" "}
          <button
            className="underline"
            disabled={busy}
            onClick={() => selectReply(null)}
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
        aria-describedby={replyTo !== null ? "board-reply-target" : undefined}
        className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        disabled={busy}
        id="board-reply-box"
        ref={replyBox}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void sendReply();
          }
        }}
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
          disabled={busy || (replyTo !== null && !replyingTo)}
          size="sm"
          type="submit"
        >
          {busy ? "Sending…" : "Reply"}
        </Button>
      </div>
    </form>
  );

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
        {post.proposal ? (
          <div
            aria-hidden
            className="grid w-9 shrink-0 place-items-start pt-1 text-muted-foreground"
          >
            <ScrollText className="h-5 w-5" />
          </div>
        ) : (
          <VoteButtons
            myVote={post.myVote}
            onVote={(direction) => vote(post, direction)}
            score={post.score}
            subject={`post "${post.title}"`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <AuthorChip
              badge={badges?.[post.author]}
              profile={profiles?.[post.author]}
              pubkey={post.author}
              size="xl"
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
            <BoardModeration
              author={post.author}
              canRemove={canModerate}
              id={post.id}
              kind="post"
              me={me}
              name={nameOf(post.author)}
              needAccount={needAccount}
              onRemove={(id) => {
                void run("remove that post", async () => {
                  await actions.moderate(id);
                  onBack();
                });
              }}
            />
          </div>
          <h2
            className="mt-3 text-lg font-bold"
            data-testid="board-thread-title"
          >
            {post.title}
          </h2>
          {header}
          {post.body ? (
            <div className="mt-3" data-testid="board-thread-body">
              <BoardMarkdown text={post.body} />
            </div>
          ) : null}
          <button
            className="mt-2 text-xs text-muted-foreground underline disabled:opacity-50"
            data-testid="board-reply-post"
            disabled={busy}
            onClick={() => selectReply(null)}
            type="button"
          >
            Reply to post
          </button>
        </div>
      </article>

      {!replyingTo ? <div className="px-4 pb-4">{replyForm}</div> : null}
      <section aria-label="Replies" className="border-t px-4 py-3">
        <h3 className="text-sm font-semibold">
          {comments.length === 1 ? "1 reply" : `${comments.length} replies`}
        </h3>
        <CommentReplies
          context={{
            profiles,
            badges,
            me,
            busy,
            replyTo,
            replyForm,
            onVote: vote,
            onReply: selectReply,
            onDelete: (id) => setDeleting({ kind: "reply", id }),
            canModerate,
            needAccount,
            onRemove: (id) =>
              void run("remove that reply", () => actions.moderate(id)),
          }}
          threads={threads}
        />
      </section>

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
