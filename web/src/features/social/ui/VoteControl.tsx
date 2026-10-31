import { ArrowBigDown, ArrowBigUp } from "lucide-react";
import { useId } from "react";

import { cn } from "@/shared/lib/cn";

/**
 * Up and down arrows with the score between them: the one vote control on posts, board posts, replies and projects.
 * Only how it looks and what it says: the caller decides what a vote writes (a reaction on a short post or a project, a
 * board vote on a board post).
 */
export function VoteControl({
  mine,
  score,
  onVote,
  label,
  testId,
  busy = false,
  disabledReason = null,
  orientation = "row",
}: {
  mine: "+" | "-" | null;
  /** A vote is being sent: the arrows say so and take no new vote until it is done. */
  busy?: boolean;
  score: number;
  onVote: (direction: "+" | "-") => void;
  /** What is voted on, for screen readers: `post by Ann`. */
  label: string;
  testId: string;
  /** Why the reader cannot vote here (muted on this board): the arrows stay reachable, take no vote and say why. */
  disabledReason?: string | null;
  /** A board's list stacks the arrows beside the post; a timeline's action bar lays them in a row. */
  orientation?: "row" | "column";
}) {
  const reasonId = useId();
  const off = busy || disabledReason !== null;
  const button = (direction: "+" | "-") => {
    const up = direction === "+";
    const active = mine === direction;
    const Icon = up ? ArrowBigUp : ArrowBigDown;
    return (
      <button
        aria-describedby={disabledReason !== null ? reasonId : undefined}
        aria-disabled={off || undefined}
        aria-label={`${up ? "Upvote" : "Downvote"} ${label}`}
        aria-pressed={active}
        className={cn(
          busy && "cursor-wait opacity-60",
          disabledReason !== null && "cursor-not-allowed opacity-40",
          "relative z-10 grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-black/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10",
          active
            ? up
              ? "text-orange-600 dark:text-orange-400"
              : "text-indigo-600 dark:text-indigo-400"
            : "text-black/60 dark:text-white/60",
        )}
        data-testid={`${testId}-${up ? "up" : "down"}`}
        onClick={() => {
          if (!off) onVote(direction);
        }}
        title={disabledReason ?? undefined}
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
      className={cn(
        "flex items-center",
        orientation === "column" && "w-9 shrink-0 flex-col",
      )}
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
      {disabledReason !== null ? (
        <span className="sr-only" id={reasonId}>
          {disabledReason}
        </span>
      ) : null}
    </div>
  );
}
