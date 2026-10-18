import type { ReactNode } from "react";

import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import type { BoardComment } from "../lib/board-model";
import type { CommentThread } from "../lib/comment-threads";
import { AuthorChip } from "./AuthorChip";
import { BoardMarkdown } from "./BoardMarkdown";
import { VoteButtons } from "./VoteButtons";

interface ReplyContext {
  profiles: Record<string, Profile> | undefined;
  badges: Record<string, string> | undefined;
  me: string | null;
  busy: boolean;
  replyTo: string | null;
  replyForm: ReactNode;
  onVote: (comment: BoardComment, direction: "up" | "down") => void;
  onReply: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Nested comment branches; deeper levels keep their order without narrowing the text further. */
export function CommentReplies({
  threads,
  context,
  depth = 0,
}: {
  threads: CommentThread[];
  context: ReplyContext;
  depth?: number;
}) {
  const {
    profiles,
    badges,
    me,
    busy,
    replyTo,
    replyForm,
    onVote,
    onReply,
    onDelete,
  } = context;
  return (
    <ol
      className={`mt-4 space-y-4 ${depth > 0 && depth <= 3 ? "ml-2 border-l border-border pl-2 sm:ml-4 sm:pl-3" : ""}`}
      data-testid={depth === 0 ? "board-replies" : "board-reply-children"}
    >
      {threads.map(({ comment, children }) => {
        const name = resolveUserName(
          profiles?.[comment.author],
          comment.author,
        );
        return (
          <li data-testid={`board-reply-${comment.id}`} key={comment.id}>
            <article
              className="flex gap-2"
              data-testid={`board-reply-content-${comment.id}`}
            >
              <VoteButtons
                myVote={comment.myVote}
                onVote={(direction) => onVote(comment, direction)}
                score={comment.score}
                subject={`reply by ${name}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <AuthorChip
                    badge={badges?.[comment.author]}
                    profile={profiles?.[comment.author]}
                    pubkey={comment.author}
                  />
                  <span>{shortRelativeTime(comment.createdAt)}</span>
                </div>
                <BoardMarkdown text={comment.body} />
                <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
                  <button
                    aria-label={`Reply to ${name}`}
                    className="underline disabled:opacity-50"
                    data-testid="board-reply-to"
                    disabled={busy}
                    onClick={() => onReply(comment.id)}
                    type="button"
                  >
                    Reply
                  </button>
                  {me !== null && me === comment.author ? (
                    <button
                      className="underline disabled:opacity-50"
                      data-testid="board-delete-reply"
                      disabled={busy}
                      onClick={() => onDelete(comment.id)}
                      type="button"
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
            {replyTo === comment.id ? (
              <div className="mt-3">{replyForm}</div>
            ) : null}
            {children.length > 0 ? (
              <CommentReplies
                context={context}
                depth={depth + 1}
                threads={children}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
