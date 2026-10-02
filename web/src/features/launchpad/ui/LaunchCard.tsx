/**
 * One launch as a card: cover, the founder's face, the pitch, and the numbers a
 * backer weighs first. Used wherever launches are listed, so a launch looks like
 * the same thing on Home, Launches and Discover.
 */

import { Link } from "@tanstack/react-router";
import { Star, Users } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { formatMoney } from "../lib/amounts";
import { saleCurrencyFor } from "../lib/sale-currency";
import { launchArt } from "../lib/launch-art";
import type { LaunchRecord, LaunchStage } from "../models";
import { StageBadge } from "./widgets";

/** What a card reads from a launch, so a preview can fill it from a form. */
export type LaunchCardRecord = Pick<
  LaunchRecord,
  | "id"
  | "name"
  | "pitch"
  | "image"
  | "category"
  | "agent"
  | "author"
  | "currency"
  | "chainId"
  | "requiredRaised"
>;

export interface LaunchCardProps {
  record: LaunchCardRecord;
  stage: LaunchStage;
  /** Founder's display name and picture, when known. */
  founder?: { name: string; picture: string | null };
  bids: number;
  updates: number;
  followed: boolean;
  followDisabled?: boolean;
  onToggleFollow(): void;
  /** Voting buttons and the like, rendered in the footer. */
  footer?: React.ReactNode;
  /** Lets a surface keep the test id its specs already use for the title. */
  titleTestId?: string;
}

export function LaunchCard({
  record,
  stage,
  founder,
  bids,
  updates,
  followed,
  followDisabled,
  onToggleFollow,
  footer,
  titleTestId = "launch-card-title",
}: LaunchCardProps) {
  const art = launchArt(record.id);
  // ETH and known USDC read in their own units; anything else keeps the
  // dollar reading this directory has always given a raise.
  const known = record.currency
    ? saleCurrencyFor(record.currency, record.chainId)
    : null;
  const goal = record.requiredRaised
    ? formatMoney(
        record.requiredRaised,
        known && known.kind !== "custom" ? known : undefined,
      )
    : null;
  return (
    <article
      className="glass group flex h-full flex-col rounded-xl border p-2 transition hover:border-primary/40"
      data-testid="launch-card"
    >
      <div className="relative">
        <Link
          aria-label={record.name}
          className="relative block h-36 overflow-hidden rounded-xl"
          params={{ launchId: record.id }}
          search={{ action: undefined, author: record.author }}
          style={record.image ? undefined : { background: art.background }}
          tabIndex={-1}
          to="/launchpad/$launchId"
        >
          {record.image ? (
            <img
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              src={record.image}
            />
          ) : null}
        </Link>
        {record.category ? (
          <span className="absolute left-2 top-2 rounded-full bg-black/45 px-2.5 py-0.5 text-2xs font-bold text-white backdrop-blur">
            {record.category}
          </span>
        ) : null}
        <button
          aria-label={followed ? "Unfollow launch" : "Follow launch"}
          aria-pressed={followed}
          className={cn(
            "absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/45 backdrop-blur transition hover:bg-black/60 disabled:opacity-50",
            followed ? "text-amber-400" : "text-white",
          )}
          disabled={followDisabled}
          onClick={onToggleFollow}
          type="button"
        >
          <Star
            aria-hidden
            className="h-4 w-4"
            fill={followed ? "currentColor" : "none"}
          />
        </button>
        <UserAvatar
          avatarUrl={founder?.picture ?? null}
          className="absolute -bottom-6 left-4 h-14 w-14 text-base ring-4 ring-card"
          displayName={founder?.name ?? record.name}
        />
      </div>

      <div className="flex flex-1 flex-col px-3 pb-2 pt-8">
        <div className="flex items-start justify-between gap-2">
          <Link
            className="min-w-0 text-xl font-extrabold leading-tight tracking-tight hover:underline"
            data-testid={titleTestId}
            params={{ launchId: record.id }}
            search={{ action: undefined, author: record.author }}
            to="/launchpad/$launchId"
          >
            <span className="block truncate">{record.name}</span>
          </Link>
          <StageBadge stage={stage} />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {founder ? `by ${founder.name}` : null}
          {record.agent ? (
            <span
              className="ml-1.5 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-2xs font-semibold text-violet-300"
              data-testid="launch-agent-badge"
              title={`Run by agent ${record.agent.slice(0, 8)}…`}
            >
              Agent-run
            </span>
          ) : null}
        </p>
        <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
          {record.pitch || "No pitch yet."}
        </p>

        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <span
            className="inline-flex items-center gap-1.5 rounded-xl bg-secondary px-3 py-2 text-sm font-bold tabular-nums"
            title={`${bids} bids · ${updates} updates`}
          >
            <Users aria-hidden className="h-4 w-4" />
            {bids}
          </span>
          {goal ? (
            <span
              className="rounded-xl bg-secondary/80 px-3 py-2 text-sm font-bold tabular-nums"
              title="Raise needed to graduate"
            >
              Target {goal}
            </span>
          ) : null}
        </div>
        {footer ? <div className="mt-3">{footer}</div> : null}
      </div>
    </article>
  );
}
