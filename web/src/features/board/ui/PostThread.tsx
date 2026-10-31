/**
 * One post opened: its text, the replies under it, and a box to reply.
 *
 * Replies nest under the comment they answer, with an inline composer at the
 * selected parent. Only the author can delete their own
 * post or reply, after a confirmation. A slot above the text takes the header
 * for a post that is about a DAO decision.
 *
 * Moderation: a locked thread says so and takes no new replies (moderators,
 * owners and admins can still answer in it); the board's moderators, owners and
 * admins can lock or pin it here, and remove words or mute their author on this
 * board. Replies moderators removed are counted, with their reasons, from the
 * board's public log.
 */

import { ArrowLeft, Lock, Pin, ScrollText } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";
import {
  CREATE_ACCOUNT,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";
import { whenText } from "@/shared/lib/refusal-text";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

import type { BoardComment, BoardPost } from "../lib/board-model";
import type {
  LogEntry,
  MuteChoice,
  ThreadAction,
} from "../lib/board-moderation";
import { commentThreads } from "../lib/comment-threads";
import type { BoardActions } from "../use-board-actions";
import { AuthorChip } from "./AuthorChip";
import { BoardMarkdown } from "./BoardMarkdown";
import { BoardModeration } from "./BoardModeration";
import { CommentReplies } from "./CommentReplies";
import { VoteButtons } from "./VoteButtons";
import { failureWords } from "@/shared/lib/readable-error";

interface Target {
  kind: "post" | "reply";
  id: string;
}

/** What the thread needs to show and offer moderation. */
export interface ThreadModeration {
  locked: boolean;
  pinned: boolean;
  /** The reader moderates this board (lock, pin, remove, mute), as a moderator, owner or admin. */
  canModerate: boolean;
  /** Lock or (when locked) unlock this thread, as the server would allow this reader. */
  canToggleLock: boolean;
  /** Pin or (when pinned) unpin this thread, as the server would allow this reader. */
  canTogglePin: boolean;
  /** The board's rules, shown beside the reply box (empty when it has none). */
  rules: string;
  /** Whether the reader may remove this author's words. */
  canRemove: (author: string) => boolean;
  /** Whether the reader may mute this author on the board. */
  canMute: (author: string) => boolean;
  muteChoices: MuteChoice[];
  onThread: (action: ThreadAction, reason?: string) => Promise<unknown>;
  onMute: (person: string, days: number, reason: string) => Promise<unknown>;
  /** Replies removed from this thread, from the board's log, newest first. */
  removed: LogEntry[];
  /** When the reader's mute on this board ends (unix seconds), if they are muted. */
  mutedUntil: number | null;
}

const NO_ONE: ReadonlySet<string> = new Set();

export const NO_MODERATION: ThreadModeration = {
  locked: false,
  pinned: false,
  canModerate: false,
  canToggleLock: false,
  canTogglePin: false,
  rules: "",
  canRemove: () => false,
  canMute: () => false,
  muteChoices: [],
  onThread: async () => undefined,
  onMute: async () => undefined,
  removed: [],
  mutedUntil: null,
};

export function PostThread({
  post,
  comments,
  profiles,
  me,
  actions,
  needAccount,
  onBack,
  backInBar = false,
  header,
  badges,
  moderation = NO_MODERATION,
  muted = NO_ONE,
}: {
  post: BoardPost;
  comments: BoardComment[];
  profiles: Record<string, Profile> | undefined;
  me: string | null;
  actions: BoardActions;
  /** Tells a signed-out reader to make an account; true when they have one. */
  needAccount: (action: string) => boolean;
  onBack: () => void;
  /** The page's own bar already holds the one back control, so the thread shows none of its own. */
  backInBar?: boolean;
  header?: ReactNode;
  /** A short fact beside a person's name, by public key. */
  badges?: Record<string, string>;
  moderation?: ThreadModeration;
  /** People the reader muted: their replies are folded, and a post of theirs says so. */
  muted?: ReadonlySet<string>;
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
  const mutedReason =
    moderation.mutedUntil !== null
      ? `You are muted on this board until ${whenText(moderation.mutedUntil)}.`
      : null;
  // A locked thread takes replies only from its moderators, owners and admins. A visitor gets a sign-up line instead.
  const canReply =
    me !== null &&
    (!moderation.locked || moderation.canModerate) &&
    moderation.mutedUntil === null;

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
        description: failureWords(error).text,
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
      setProblem(failureWords(error, "Couldn't send that. Try again.").text);
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
        placeholder="Write a reply"
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
      {!backInBar ? (
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
      ) : (
        <div className="h-3" />
      )}
      {post.author !== me && muted.has(post.author) ? (
        <p
          className="px-4 pb-2 text-xs text-muted-foreground"
          data-testid="board-thread-muted-author"
        >
          You muted {nameOf(post.author)}. You see this post because you opened
          it.
        </p>
      ) : null}
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
            disabledReason={mutedReason}
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
              canRemove={moderation.canRemove(post.author)}
              id={post.id}
              kind="post"
              me={me}
              mute={
                moderation.canMute(post.author)
                  ? {
                      choices: moderation.muteChoices,
                      onMute: (days, reason) =>
                        moderation.onMute(post.author, days, reason),
                    }
                  : null
              }
              name={nameOf(post.author)}
              needAccount={needAccount}
              onRemove={async (id, reason) => {
                await actions.moderate(id, reason);
                onBack();
              }}
              thread={{
                locked: moderation.locked,
                pinned: moderation.pinned,
                canToggleLock: moderation.canToggleLock,
                canTogglePin: moderation.canTogglePin,
                onThread: moderation.onThread,
              }}
            />
          </div>
          {moderation.pinned || moderation.locked ? (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {moderation.pinned ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                  data-testid="board-thread-pinned"
                >
                  <Pin aria-hidden className="h-3 w-3" /> Pinned
                </span>
              ) : null}
              {moderation.locked ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                  data-testid="board-thread-locked"
                >
                  <Lock aria-hidden className="h-3 w-3" /> Locked
                </span>
              ) : null}
            </div>
          ) : null}
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
          {canReply && replyTo !== null ? (
            <button
              className="mt-2 text-xs text-muted-foreground underline disabled:opacity-50"
              data-testid="board-reply-post"
              disabled={busy}
              onClick={() => selectReply(null)}
              type="button"
            >
              Reply to post
            </button>
          ) : null}
        </div>
      </article>

      {moderation.mutedUntil !== null ? (
        <p
          className="mx-4 mb-4 rounded-lg border bg-secondary/30 p-3 text-sm"
          data-testid="board-thread-muted-note"
          role="status"
        >
          You are muted on this board until{" "}
          {new Date(moderation.mutedUntil * 1000).toLocaleString()}. You can
          still read it, and post everywhere else.
        </p>
      ) : moderation.locked ? (
        <p
          className="mx-4 mb-4 rounded-lg border bg-secondary/30 p-3 text-sm"
          data-testid="board-thread-locked-note"
          role="status"
        >
          {moderation.canModerate
            ? "This thread is locked. Only moderators, owners and admins can reply."
            : "This thread is locked. No new replies."}
        </p>
      ) : null}
      {moderation.rules.trim() !== "" ? (
        <details
          className="mx-4 mb-3 rounded-lg border px-3 py-2 text-xs"
          data-testid="board-thread-rules"
        >
          <summary className="cursor-pointer font-medium">
            This board's rules
          </summary>
          <div className="mt-2 text-sm">
            <BoardMarkdown text={moderation.rules} />
          </div>
        </details>
      ) : null}
      {me === null ? (
        <p
          className="mx-4 mb-4 text-sm text-muted-foreground"
          data-testid="board-reply-sign-up"
        >
          <button
            className="font-semibold text-foreground underline underline-offset-2"
            onClick={() => window.dispatchEvent(new Event(SIGN_UP_EVENT))}
            type="button"
          >
            {CREATE_ACCOUNT}
          </button>{" "}
          to reply.
        </p>
      ) : canReply && !replyingTo ? (
        <div className="px-4 pb-4">{replyForm}</div>
      ) : null}
      <section aria-label="Replies" className="border-t px-4 py-3">
        <h3 className="text-sm font-semibold">
          {comments.length === 1 ? "1 reply" : `${comments.length} replies`}
        </h3>
        {moderation.removed.length > 0 ? (
          <div
            className="mt-2 text-xs text-muted-foreground"
            data-testid="board-thread-removed"
          >
            {moderation.removed.length === 1
              ? "1 reply was removed by moderators"
              : `${moderation.removed.length} replies were removed by moderators`}
            {moderation.removed.some((entry) => entry.reason.trim())
              ? `: ${moderation.removed
                  .map((entry) => entry.reason.trim())
                  .filter((reason) => reason !== "")
                  .join("; ")}.`
              : "."}{" "}
            The board's moderation log says who and when.
          </div>
        ) : null}
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
            canRemove: moderation.canRemove,
            canMute: moderation.canMute,
            muteChoices: moderation.muteChoices,
            onMute: moderation.onMute,
            canReply,
            voteDisabledReason: mutedReason,
            needAccount,
            onRemove: (id, reason) => actions.moderate(id, reason),
            muted,
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
