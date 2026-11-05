import { useQuery } from "@tanstack/react-query";

import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import {
  auctionProgress,
  progressPercent,
  recordSaleCurrency,
  type AuctionProgress,
} from "../chain";
import { formatMoney } from "../lib/amounts";
import { fundingLine } from "../lib/contributor-only";
import {
  type FundingStance,
  type ResolvedFunding,
  isContributorProject,
} from "../lib/funding";
import { raisesOffered } from "../lib/raises-offered";
import { SANDBOX_ID, sandboxProgress } from "../lib/sandbox";
import type { LaunchRecord, LaunchStage } from "../models";

const STAGE_LABELS: Record<LaunchStage, string> = {
  draft: "Draft",
  review: "In review",
  live: "Live",
  funding: "Funding",
  graduated: "Sale completed",
  failed: "Failed",
};

export function StageBadge({
  stage,
  record,
}: {
  stage: LaunchStage;
  /** The launch's record, so a contributor project is never labelled with a sale it never had. */
  record?: Partial<Pick<LaunchRecord, "funding" | "auction" | "tokenPlan">>;
}) {
  if (record && isContributorProject(record)) {
    return (
      <Badge data-testid="contributor-badge" variant="secondary">
        Contributor project
      </Badge>
    );
  }
  return <Badge variant="secondary">{STAGE_LABELS[stage]}</Badge>;
}

/**
 * The funding status on a card — the project's own word about raising,
 * corrected by the chain (`lib/funding.ts`). Reads as one plain sentence so
 * "Not raising · looking for contributors" carries both halves of the
 * declaration, not just the stance.
 */
const FUNDING_TONES: Record<FundingStance, string> = {
  "not-raising":
    "bg-black/10 text-black/70 dark:bg-white/10 dark:text-white/70",
  planning: "bg-blue-500/15 text-blue-800 dark:text-blue-300",
  raising: "bg-emerald-500/20 text-emerald-800 dark:text-emerald-300",
  closing: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  closed: "bg-black/10 text-black/70 dark:bg-white/10 dark:text-white/70",
  rolling: "bg-violet-500/15 text-violet-800 dark:text-violet-300",
};

export function FundingBadge({
  funding,
  className,
}: {
  funding: ResolvedFunding;
  className?: string;
}) {
  // A contributor-only build says who a project is looking for, never a word about raising (`contributor-only.ts`).
  const line = fundingLine(funding, raisesOffered());
  if (line === null) return null;
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-2xs font-semibold",
        FUNDING_TONES[funding.stance],
        className,
      )}
      data-testid="launch-funding-badge"
    >
      {line}
    </span>
  );
}

export function useAuctionProgress(record: LaunchRecord | undefined) {
  return useQuery<AuctionProgress>({
    queryKey: [
      "launchpad",
      "auction",
      record?.author,
      record?.id,
      record?.auction,
      record?.id === SANDBOX_ID ? "simulated" : undefined,
    ],
    queryFn: () =>
      record?.id === SANDBOX_ID
        ? sandboxProgress()
        : auctionProgress(record as LaunchRecord),
    enabled: record !== undefined,
    // The sandbox advances on its own clock; refetch so the raise visibly moves.
    refetchInterval: record?.id === SANDBOX_ID ? 2000 : undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function ProgressBar({
  record,
  quietWhenUnknown = false,
}: {
  record: LaunchRecord;
  /**
   * Cards: say nothing when there is no chain reading, instead of a dash and
   * "No chain data" repeated on every card. The launch page keeps the honest
   * version.
   */
  quietWhenUnknown?: boolean;
}) {
  const { data } = useAuctionProgress(record);
  const measurable = data !== undefined && data.source !== "unavailable";
  const pct = measurable ? progressPercent(data.raised, data.goal) : 0;
  // The raise is in the sale's own currency (ETH has 18 decimals, USDC 6): never assume one.
  const currency = recordSaleCurrency(record);
  if (quietWhenUnknown && !measurable) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums">
          {measurable ? `${pct.toFixed(1)}%` : "—"}
        </span>
        {data ? (
          <span
            className="text-xs text-black/60 dark:text-white/60"
            data-testid="launch-progress-source"
            title={
              data.source === "rpc"
                ? "Live values from the network."
                : data.source === "preview"
                  ? "Preview data, shown in development builds only."
                  : `No network data: ${data.reason ?? "unavailable"}.`
            }
          >
            {data.source === "rpc"
              ? "Live"
              : data.source === "preview"
                ? "Preview data"
                : data.source === "simulated"
                  ? "Simulated"
                  : "No network data"}
          </span>
        ) : null}
      </div>
      <div
        aria-label="Funding progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(pct)}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{
            width: `${Math.min(100, Math.max(0, measurable ? pct : 0))}%`,
          }}
        />
      </div>
      {measurable && data.goal !== null && data.goal > 0n ? (
        <p
          className="mt-1 text-2xs text-black/60 dark:text-white/60"
          data-testid="launch-raise-line"
        >
          {formatMoney(data.raised, currency)} of{" "}
          {formatMoney(data.goal, currency)} raised
        </p>
      ) : null}
    </div>
  );
}

/**
 * The launch-page ownership disclaimer (docs/token-lifecycle-design.md §7
 * "Launch page copy"): buyers acquire ownership only — governance and exit —
 * and no dividends or revenue share unless they contribute and earn one.
 * One component so every bid surface says the same thing, placed before the
 * bid action ("say it before the bid button").
 */
export function OwnershipOnlyNote({ className }: { className?: string }) {
  return (
    <p
      className={cn("text-2xs text-black/50 dark:text-white/50", className)}
      data-testid="ownership-only-note"
    >
      Buyers acquire ownership only: governance and exit. No dividends or
      revenue share, ever, unless they contribute and earn one.
    </p>
  );
}
