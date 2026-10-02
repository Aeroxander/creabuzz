import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";

import type { LaunchRecord } from "@/features/launchpad/models";
import { ProgressBar } from "@/features/launchpad/ui/widgets";
import { KIND_LAUNCH_RECORD } from "@/shared/constants/kinds";

import {
  launchCoordinate,
  type LaunchRef,
  type SignedEventLike,
} from "../lib/feed-events";
import { EMPTY_TALLY, type VoteTally } from "../lib/ranking";
import { VoteButtons } from "./VoteButtons";

/** The vote target for a launch: its current record event. */
export function launchVoteTarget(record: LaunchRecord): SignedEventLike {
  return {
    id: record.eventId,
    pubkey: record.author,
    kind: KIND_LAUNCH_RECORD,
    created_at: record.createdAt,
    tags: [],
    content: "",
  };
}

export function launchRef(record: LaunchRecord): LaunchRef {
  return { pubkey: record.author, id: record.id };
}

export function launchCoord(record: LaunchRecord): string {
  return launchCoordinate(launchRef(record));
}

const STAGE_LABEL: Record<string, string> = {
  draft: "Draft",
  review: "In review",
  live: "Live",
  funding: "Raising",
  graduated: "Graduated",
  failed: "Did not graduate",
};

/** A launch as a feed row: votes, name, pitch, stage, discussion size. */
export function LaunchVoteCard({
  record,
  tally = EMPTY_TALLY,
  comments = 0,
}: {
  record: LaunchRecord;
  tally?: VoteTally;
  comments?: number;
}) {
  return (
    <article
      aria-label={`Launch ${record.name}`}
      className="flex gap-2 glass rounded-xl border p-3"
      data-testid="launch-vote-card"
    >
      <div className="flex shrink-0 flex-col items-center [&>div]:flex-col">
        <VoteButtons
          label={record.name}
          launch={launchRef(record)}
          tally={tally}
          target={launchVoteTarget(record)}
          testId="launch-vote"
        />
      </div>
      <div className="min-w-0 flex-1">
        <Link
          className="text-sm font-semibold text-black hover:underline dark:text-white"
          params={{ launchId: record.id }}
          search={{ author: record.author, action: undefined }}
          to="/launchpad/$launchId"
        >
          {record.name}
        </Link>
        <p className="mt-0.5 line-clamp-2 text-sm text-black/70 dark:text-white/70">
          {record.pitch}
        </p>
        <div className="mt-1.5">
          <ProgressBar record={record} />
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-black/60 dark:text-white/60">
          <span className="rounded-full bg-black/5 px-2 py-0.5 dark:bg-white/10">
            {STAGE_LABEL[record.stage] ?? record.stage}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare aria-hidden className="h-3.5 w-3.5" />
            {comments} {comments === 1 ? "post" : "posts"}
          </span>
        </p>
      </div>
    </article>
  );
}
