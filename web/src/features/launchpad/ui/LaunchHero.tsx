/**
 * The top of a launch page: cover, who is behind it, the pitch, and the three
 * numbers a backer decides on first. The tables below carry the rest.
 */

import { Link } from "@tanstack/react-router";
import { ArrowLeft, Star } from "lucide-react";

import { isContributorProject } from "../lib/funding";
import { listLink } from "../lib/project-list-copy";
import { raisesOffered } from "../lib/raises-offered";
import type { ReactNode } from "react";

import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { ServerImage } from "@/shared/ui/ServerImage";
import { progressPercent } from "../chain";
import { formatMoney } from "../lib/amounts";
import { launchArt } from "../lib/launch-art";
import { saleCurrencyFor } from "@creaton/core/launchpad/sale-currency.ts";
import type { LaunchRecord, LaunchStage } from "../models";
import type { ResolvedFunding } from "../lib/funding";
import { followersLine } from "../lib/supporters";
import { FundingBadge, StageBadge, useAuctionProgress } from "./widgets";

export function LaunchHero({
  record,
  stage,
  funding = null,
  followed,
  followDisabled,
  onToggleFollow,
  showFollow,
  actions,
  note,
  chips,
  idea = false,
  supporters = null,
  followNote = false,
  belowName,
}: {
  /** The record line (chips) under the name and the "by" line. */
  belowName?: ReactNode;
  /** Says what following gives, under the buttons. Off where there is nothing to follow (a pretend project). */
  followNote?: boolean;
  record: LaunchRecord;
  stage: LaunchStage;
  /** The funding status to show; null when the surface cannot resolve one. */
  funding?: ResolvedFunding | null;
  followed: boolean;
  followDisabled: boolean;
  onToggleFollow(): void;
  showFollow: boolean;
  actions: ReactNode;
  note: ReactNode;
  /** Short facts about the project, shown under its pitch. */
  chips?: ReactNode;
  /** No sale terms yet: shown as an idea rather than a draft. */
  idea?: boolean;
  /** People following this launch; null while unknown. */
  supporters?: number | null;
}) {
  const { data: profiles } = useProfiles([record.author]);
  const founder = profiles?.[record.author];
  const founderName = resolveUserName(founder, record.author);
  const back = listLink({
    contributor: isContributorProject(record),
    raises: raisesOffered(),
  });
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
  // An idea has no sale yet, so the default split is not a fact about it; a project whose sale is over is no longer
  // "up for sale".
  if (record.allocation && !idea && stage !== "graduated") {
    stats.push({
      label: "Up for sale",
      value: `${record.allocation.sale}% of supply`,
    });
  }
  if (pct !== null) {
    stats.push({ label: "Raised", value: `${pct.toFixed(1)}%` });
  }

  return (
    <header className="flex flex-col gap-3" data-testid="launch-hero">
      {/* The way back is the list of projects, named as the top bar names it; "Launchpad" only where sales are offered. */}
      <Link
        className="flex items-center gap-1 text-sm text-muted-foreground hover:underline"
        to={back.to}
      >
        <ArrowLeft aria-hidden className="h-4 w-4" /> {back.label}
      </Link>
      <div className="relative">
        <div
          className={
            stage === "graduated"
              ? "h-16 overflow-hidden rounded-2xl sm:h-20"
              : "h-24 overflow-hidden rounded-2xl sm:h-32"
          }
          style={
            record.image
              ? undefined
              : { background: launchArt(record.id).background }
          }
        >
          {record.image ? (
            <ServerImage
              alt=""
              className="h-full w-full object-cover"
              src={record.image}
              unavailable="hide"
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
            {record.name}{" "}
            {idea ? null : <StageBadge record={record} stage={stage} />}
            {record.category ? (
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-bold">
                {record.category}
              </span>
            ) : null}
            {record.agent ? (
              <span
                className="rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-semibold text-violet-300"
                data-testid="launch-agent-badge-detail"
                title="An agent runs this project"
              >
                Agent
              </span>
            ) : null}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span>by {founderName}</span>
            {funding ? <FundingBadge funding={funding} /> : null}
            {supporters !== null && (idea || supporters > 0) ? (
              <>
                {" · "}
                <span data-testid="launch-supporters">
                  {followersLine(supporters)}
                </span>
              </>
            ) : null}
          </p>
          {belowName ? <div className="mt-3">{belowName}</div> : null}
          <p className="mt-3 max-w-2xl text-base">
            {record.pitch || "No pitch yet."}
          </p>
          {chips ? <div className="mt-3">{chips}</div> : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            {showFollow ? (
              <Button
                data-testid="launch-follow"
                disabled={followDisabled}
                onClick={onToggleFollow}
                type="button"
                variant={followed ? "outline" : "default"}
              >
                <Star
                  aria-hidden
                  className="mr-1 h-4 w-4"
                  fill={followed ? "currentColor" : "none"}
                />
                {followed ? "Following" : "Follow"}
              </Button>
            ) : null}
            {actions}
          </div>
          {followNote ? (
            <p
              className="max-w-60 text-right text-xs text-muted-foreground"
              data-testid="launch-follow-note"
            >
              {followed
                ? "You follow this project. Its updates show in your Home, under Updates."
                : "Follow to get this project's updates in your Home, under Updates."}
            </p>
          ) : null}
          {note}
        </div>
      </div>

      {stats.length > 0 ? (
        <dl
          className={
            stage === "graduated"
              ? "flex flex-wrap gap-3"
              : "grid grid-cols-2 gap-3 sm:grid-cols-3"
          }
          data-testid="launch-hero-stats"
        >
          {stats.map((stat) => (
            <div
              className={
                stage === "graduated"
                  ? "rounded-lg bg-secondary/60 px-3 py-1.5"
                  : "rounded-xl bg-secondary/60 px-4 py-3"
              }
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
