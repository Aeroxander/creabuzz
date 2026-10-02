/**
 * The top of a launch page: cover, who is behind it, the pitch, and the three
 * numbers a backer decides on first. The tables below carry the rest.
 */

import { Link } from "@tanstack/react-router";
import { ArrowLeft, Star } from "lucide-react";
import type { ReactNode } from "react";

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { progressPercent } from "../chain";
import { formatMoney } from "../lib/amounts";
import { launchArt } from "../lib/launch-art";
import { saleCurrencyFor } from "../lib/sale-currency";
import type { LaunchRecord, LaunchStage } from "../models";
import { StageBadge, useAuctionProgress } from "./widgets";

export function LaunchHero({
  record,
  stage,
  followed,
  followDisabled,
  onToggleFollow,
  showFollow,
  actions,
  note,
}: {
  record: LaunchRecord;
  stage: LaunchStage;
  followed: boolean;
  followDisabled: boolean;
  onToggleFollow(): void;
  showFollow: boolean;
  actions: ReactNode;
  note: ReactNode;
}) {
  const { data: profiles } = useProfiles([record.author]);
  const founder = profiles?.[record.author];
  const founderName = resolveUserName(founder, record.author);
  const { data: progress } = useAuctionProgress(record);
  const measurable =
    progress !== undefined && progress.source !== "unavailable";
  const pct = measurable
    ? progressPercent(progress.raised, progress.goal)
    : null;
  const currency = record.currency
    ? saleCurrencyFor(record.currency, record.chainId)
    : null;
  const money = (value: string) =>
    formatMoney(
      value,
      currency && currency.kind !== "custom" ? currency : undefined,
    );
  const stats: Array<{ label: string; value: string }> = [];
  if (record.requiredRaised) {
    stats.push({ label: "Target", value: money(record.requiredRaised) });
  }
  if (record.allocation) {
    stats.push({
      label: "Up for sale",
      value: `${record.allocation.sale}% of supply`,
    });
  }
  if (pct !== null) {
    stats.push({ label: "Raised", value: `${pct.toFixed(1)}%` });
  }

  return (
    <header className="flex flex-col gap-4" data-testid="launch-hero">
      <Link
        className="flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        to="/launchpad"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" /> Launchpad
      </Link>
      <div className="relative">
        <div
          className="h-40 overflow-hidden rounded-2xl sm:h-52"
          style={
            record.image
              ? undefined
              : { background: launchArt(record.id).background }
          }
        >
          {record.image ? (
            <img
              alt=""
              className="h-full w-full object-cover"
              src={record.image}
            />
          ) : null}
        </div>
        <UserAvatar
          avatarUrl={founder?.picture ?? null}
          className="absolute -bottom-8 left-5 h-16 w-16 text-lg ring-4 ring-background"
          displayName={founderName}
        />
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4 pt-6">
        <div className="min-w-0 flex-1 basis-80">
          <h1 className="flex flex-wrap items-center gap-2 text-3xl font-black tracking-tight">
            {record.name} <StageBadge stage={stage} />
            {record.category ? (
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-bold">
                {record.category}
              </span>
            ) : null}
            {record.agent ? (
              <span
                className="rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-semibold text-violet-300"
                data-testid="launch-agent-badge-detail"
                title={`Run by agent ${record.agent.slice(0, 8)}…`}
              >
                Agent-run
              </span>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">by {founderName}</p>
          <p className="mt-3 max-w-2xl text-base">
            {record.pitch || "No pitch yet."}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            {showFollow ? (
              <button
                aria-label={followed ? "Unfollow launch" : "Follow launch"}
                aria-pressed={followed}
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-lg border",
                  followed
                    ? "border-amber-500/50 text-amber-500"
                    : "border-border",
                )}
                data-testid="launch-follow"
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
            ) : null}
            {actions}
          </div>
          {note}
        </div>
      </div>

      {stats.length > 0 ? (
        <dl
          className="grid grid-cols-2 gap-3 sm:grid-cols-3"
          data-testid="launch-hero-stats"
        >
          {stats.map((stat) => (
            <div
              className="rounded-xl bg-secondary/60 px-4 py-3"
              key={stat.label}
            >
              <dt className="text-xs font-semibold text-muted-foreground">
                {stat.label}
              </dt>
              <dd className="mt-0.5 text-lg font-extrabold tabular-nums">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </header>
  );
}
