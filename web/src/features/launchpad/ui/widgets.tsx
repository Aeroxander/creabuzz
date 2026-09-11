import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/shared/ui/badge";
import { auctionProgress, progressPercent } from "../chain";
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
  return useQuery({
    queryKey: [
      "launchpad",
      "auction",
      record?.author,
      record?.id,
      record?.auction,
    ],
    queryFn: () => auctionProgress(record as LaunchRecord),
    enabled: record !== undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function ProgressBar({ record }: { record: LaunchRecord }) {
  const { data } = useAuctionProgress(record);
  const measurable = data !== undefined && data.source !== "unavailable";
  const pct = measurable ? progressPercent(data.raised, data.goal) : 0;
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
                : "No chain data"}
          </span>
        ) : null}
      </div>
      <div
        aria-label="Funding progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(pct)}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-black dark:bg-white"
          style={{
            width: `${Math.min(100, Math.max(0, measurable ? pct : 0))}%`,
          }}
        />
      </div>
    </div>
  );
}

export { effectiveStage };
