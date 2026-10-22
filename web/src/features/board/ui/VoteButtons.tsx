/**
 * Up and down arrows with the score between them. A signed-in reader's own
 * vote is shown pressed; pressing it again takes it back. Someone without an
 * account is told what to do instead of getting a dead button.
 */

import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/shared/lib/cn";

export function VoteButtons({
  score,
  myVote,
  onVote,
  subject,
  disabledReason = null,
}: {
  score: number;
  myVote: 1 | -1 | 0;
  onVote: (direction: "up" | "down") => void;
  /** What is being voted on, for screen readers: `post "Which editor?"`, `reply by Bob`. */
  subject: string;
  /** Why the reader cannot vote here (muted on this board); the arrows are off and say why. */
  disabledReason?: string | null;
}) {
  const base =
    "grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="flex w-9 shrink-0 flex-col items-center">
      <button
        aria-label={`Upvote ${subject}`}
        aria-pressed={myVote === 1}
        className={cn(base, myVote === 1 && "text-primary-ink")}
        data-testid="board-upvote"
        disabled={disabledReason !== null}
        onClick={() => onVote("up")}
        title={disabledReason ?? undefined}
        type="button"
      >
        <ChevronUp aria-hidden className="h-5 w-5" />
      </button>
      <span
        className="text-sm font-semibold tabular-nums"
        data-testid="board-score"
      >
        {score}
        <span className="sr-only"> points</span>
      </span>
      <button
        aria-label={`Downvote ${subject}`}
        aria-pressed={myVote === -1}
        className={cn(base, myVote === -1 && "text-destructive")}
        data-testid="board-downvote"
        disabled={disabledReason !== null}
        onClick={() => onVote("down")}
        title={disabledReason ?? undefined}
        type="button"
      >
        <ChevronDown aria-hidden className="h-5 w-5" />
      </button>
    </div>
  );
}
