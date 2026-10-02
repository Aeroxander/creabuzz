import { useQuery } from "@tanstack/react-query";

import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import {
  auctionProgress,
  progressPercent,
  type AuctionProgress,
} from "../chain";
import { formatMoney } from "../lib/amounts";
import { SANDBOX_ID, sandboxProgress } from "../lib/sandbox";
import type { LaunchRecord, LaunchStage } from "../models";
import { effectiveStage } from "../models";

const STAGE_LABELS: Record<LaunchStage, string> = {
  draft: "Draft",
  review: "In review",
  live: "Live",
  funding: "Funding",
  graduated: "Graduated",
  failed: "Failed",
};

export function StageBadge({ stage }: { stage: LaunchStage }) {
  return <Badge variant="secondary">{STAGE_LABELS[stage]}</Badge>;
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
                ? "Live chain values."
                : data.source === "preview"
                  ? "Preview fixture — development builds only."
                  : `No chain data: ${data.reason ?? "unavailable"}.`
            }
          >
            {data.source === "rpc"
              ? "Live"
              : data.source === "preview"
                ? "Preview data"
                : data.source === "simulated"
                  ? "Simulated"
                  : "No chain data"}
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
          {formatMoney(data.raised)} of {formatMoney(data.goal)} raised
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
      Buyers acquire ownership only — governance and exit. No dividends or
      revenue share, ever, unless they contribute and earn one.
    </p>
  );
}

export { effectiveStage };
