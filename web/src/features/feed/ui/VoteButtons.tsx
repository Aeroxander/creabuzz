import { ArrowBigDown, ArrowBigUp } from "lucide-react";
import { toast } from "sonner";

import { existingUserPubkey } from "@/shared/lib/identity";

import {
  buildVote,
  type LaunchRef,
  type SignedEventLike,
  type VoteDirection,
} from "../lib/feed-events";
import { EMPTY_TALLY, type VoteTally } from "../lib/ranking";
import { usePublishFeedEvent } from "../use-feed";

/** Weighted scores are fractional; show one decimal only when it matters. */
export function formatScore(score: number): string {
  const rounded = Math.round(score * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Up/down voting on a note or a launch. The score shown is the trust-weighted
 * sum; the button titles give the raw headcount, so nobody has to take the
 * weighting on faith.
 */
export function VoteButtons({
  target,
  launch,
  tally = EMPTY_TALLY,
  label,
  testId = "vote",
}: {
  target: SignedEventLike;
  launch?: LaunchRef | null;
  tally?: VoteTally;
  /** What is being voted on, for the buttons' accessible names. */
  label: string;
  testId?: string;
}) {
  const publish = usePublishFeedEvent();
  const signedIn = existingUserPubkey() !== null;

  const vote = (direction: VoteDirection) => {
    if (!signedIn) {
      toast.error("Create your identity from the profile menu to vote.");
      return;
    }
    if (tally.mine === direction) return;
    publish.mutate(buildVote({ target, direction, launch }), {
      onError: (error) =>
        toast.error(
          error instanceof Error ? error.message : "Your vote was not saved.",
        ),
    });
  };

  const button = (direction: VoteDirection) => {
    const up = direction === "+";
    const active = tally.mine === direction;
    const Icon = up ? ArrowBigUp : ArrowBigDown;
    return (
      <button
        aria-label={`${up ? "Upvote" : "Downvote"} ${label}`}
        aria-pressed={active}
        className={`rounded-md p-1 transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10 ${
          active
            ? up
              ? "text-orange-600 dark:text-orange-400"
              : "text-indigo-600 dark:text-indigo-400"
            : "text-black/60 dark:text-white/60"
        }`}
        data-testid={`${testId}-${up ? "up" : "down"}`}
        disabled={publish.isPending}
        onClick={() => vote(direction)}
        title={`${up ? tally.up : tally.down} ${up ? "upvote" : "downvote"}${
          (up ? tally.up : tally.down) === 1 ? "" : "s"
        }`}
        type="button"
      >
        <Icon
          aria-hidden
          className="h-5 w-5"
          fill={active ? "currentColor" : "none"}
        />
      </button>
    );
  };

  return (
    <div className="flex items-center gap-0.5">
      {button("+")}
      <span
        className="min-w-6 text-center text-sm font-semibold tabular-nums"
        data-testid={`${testId}-score`}
      >
        <span className="sr-only">Score </span>
        {formatScore(tally.score)}
      </span>
      {button("-")}
    </div>
  );
}
