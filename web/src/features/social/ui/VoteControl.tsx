import { ArrowBigDown, ArrowBigUp } from "lucide-react";

import { cn } from "@/shared/lib/cn";

/**
 * Up and down arrows with the score between them, sized for a timeline's action bar. Only how it looks and what it
 * says: the caller decides what a vote writes (a reaction on a short post, a board vote on a board post).
 */
export function VoteControl({
  mine,
  score,
  onVote,
  label,
  testId,
  busy = false,
}: {
  mine: "+" | "-" | null;
  /** A vote is being sent: the arrows say so and take no new vote until it is done. */
  busy?: boolean;
  score: number;
  onVote: (direction: "+" | "-") => void;
  /** What is voted on, for screen readers: `post by Ann`. */
  label: string;
  testId: string;
}) {
  const button = (direction: "+" | "-") => {
    const up = direction === "+";
    const active = mine === direction;
    const Icon = up ? ArrowBigUp : ArrowBigDown;
    return (
      <button
        aria-label={`${up ? "Upvote" : "Downvote"} ${label}`}
        aria-disabled={busy || undefined}
        aria-pressed={active}
        className={cn(
          busy && "cursor-wait opacity-60",
          "relative z-10 grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-black/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10",
          active
            ? up
              ? "text-orange-600 dark:text-orange-400"
              : "text-indigo-600 dark:text-indigo-400"
            : "text-black/60 dark:text-white/60",
        )}
        data-testid={`${testId}-${up ? "up" : "down"}`}
        onClick={() => {
          if (!busy) onVote(direction);
        }}
        type="button"
      >
        <Icon
          aria-hidden
          className="h-[1.15rem] w-[1.15rem]"
          fill={active ? "currentColor" : "none"}
        />
      </button>
    );
  };
  return (
    <div
      aria-busy={busy || undefined}
      className="flex items-center"
      data-testid={testId}
    >
      {button("+")}
      <span
        className={cn(
          "min-w-5 text-center text-xs font-semibold tabular-nums",
          mine === "+"
            ? "text-orange-600 dark:text-orange-400"
            : mine === "-"
              ? "text-indigo-600 dark:text-indigo-400"
              : "text-black/70 dark:text-white/70",
        )}
        data-testid={`${testId}-score`}
      >
        <span className="sr-only">Score </span>
        {score}
      </span>
      {button("-")}
    </div>
  );
}
