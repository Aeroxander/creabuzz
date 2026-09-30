import { useQuery } from "@tanstack/react-query";

import {
  formatRaised,
  previewChainAdapter,
  type AuctionProgress,
} from "@/features/launchpad/lib/chain";
import {
  getRpcEndpoint,
  RpcChainAdapter,
} from "@/features/launchpad/lib/chainRpc";
import type { LaunchRecord } from "@/features/launchpad/launchpadModels";
import { cn } from "@/shared/lib/cn";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";

async function fetchAuctionProgress(
  record: LaunchRecord,
): Promise<AuctionProgress> {
  // Live reads first when an auction is linked; the preview fixture is the
  // honest fallback and stays badged as preview in the UI.
  if (record.auction) {
    try {
      const adapter = new RpcChainAdapter(
        getRpcEndpoint(getCachedRelayOrigin()),
      );
      return await adapter.getAuctionProgress(record);
    } catch {
      // RPC unreachable or contract not deployed there — fall through.
    }
  }
  return previewChainAdapter.getAuctionProgress(record);
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
    queryFn: () => fetchAuctionProgress(record as LaunchRecord),
    enabled: record !== undefined,
    staleTime: 60_000,
  });
}

export function AuctionProgressBar({ record }: { record: LaunchRecord }) {
  const progress = useAuctionProgress(record);
  const data = progress.data;
  const pct =
    data?.goal === null || data?.goal === undefined || data.goal === 0n
      ? 0
      : Number((data.raised * 10000n) / (data.goal as bigint)) / 100;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums">
          {data ? formatRaised(data.raised, data.goal) : "—"}
        </span>
        {data ? (
          <span
            className="text-2xs text-muted-foreground"
            title={
              data.source === "rpc"
                ? "Live chain values."
                : "Preview fixture — point the launchpad at a chain RPC for live auction values."
            }
          >
            {data.source === "rpc" ? "Live" : "Preview data"}
          </span>
        ) : null}
      </div>
      <div
        aria-label="Funding progress"
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(Math.min(100, Math.max(0, pct)))}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn(
            "h-full rounded-full bg-primary transition-[width]",
            data ? "" : "animate-pulse",
          )}
          style={{ width: `${Math.min(100, Math.max(0, data ? pct : 8))}%` }}
        />
      </div>
    </div>
  );
}
