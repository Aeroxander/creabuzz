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
  what,
}: {
  score: number;
  myVote: 1 | -1 | 0;
  onVote: (direction: "up" | "down") => void;
  /** "post" or "reply": names what is being voted on, for screen readers. */
  what: string;
}) {
  const base =
    "grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="flex w-9 shrink-0 flex-col items-center">
      <button
        aria-label={`Upvote this ${what}`}
        aria-pressed={myVote === 1}
        className={cn(base, myVote === 1 && "text-primary-ink")}
        data-testid="board-upvote"
        onClick={() => onVote("up")}
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
        aria-label={`Downvote this ${what}`}
        aria-pressed={myVote === -1}
        className={cn(base, myVote === -1 && "text-destructive")}
        data-testid="board-downvote"
        onClick={() => onVote("down")}
        type="button"
      >
        <ChevronDown aria-hidden className="h-5 w-5" />
      </button>
    </div>
  );
}
