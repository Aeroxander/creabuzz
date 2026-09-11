import type { LaunchRecord } from "@/features/launchpad/launchpadModels";

/**
 * Chain read model for a launch auction. `source` is honesty metadata: the
 * UI always shows whether values are live chain reads or local preview
 * fixtures. No mainnet/testnet deploys exist yet, so the preview adapter is
 * the default everywhere.
 */
export type AuctionProgress = {
  raised: bigint;
  goal: bigint | null;
  clearingPrice: string | null;
  graduated: boolean;
  ended: boolean;
  bidCount: number;
  source: "preview" | "rpc";
};

export interface LaunchChainAdapter {
  readonly source: "preview" | "rpc";
  getAuctionProgress(record: LaunchRecord): Promise<AuctionProgress>;
}

function hashSeed(input: string): bigint {
  let hash = 14695981039346656037n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 1099511628211n) & ((1n << 64n) - 1n);
  }
  return hash;
}

/**
 * Deterministic fixture adapter. Derives plausible auction progress from the
 * launch id + auction address so every launch renders a distinct, stable
 * dashboard before chain wiring lands. NEVER presented as live data — callers
 * must surface `source: "preview"` in the UI.
 */
export class PreviewChainAdapter implements LaunchChainAdapter {
  readonly source = "preview" as const;

  async getAuctionProgress(record: LaunchRecord): Promise<AuctionProgress> {
    const seed = hashSeed(
      `${record.author}:${record.id}:${record.auction ?? "undeployed"}`,
    );
    const goal = record.requiredRaised
      ? BigInt(record.requiredRaised)
      : 100000000000n;
    const pct = 12n + (seed % 78n);
    const raised = (goal * pct) / 100n;
    return {
      raised,
      goal,
      clearingPrice: record.floorPrice,
      graduated: record.stage === "graduated",
      ended: record.stage === "graduated" || record.stage === "failed",
      bidCount: Number(seed % 240n),
      source: "preview",
    };
  }
}

export const previewChainAdapter = new PreviewChainAdapter();

export function formatRaised(raised: bigint, goal: bigint | null): string {
  if (goal === null || goal === 0n) return raised.toString();
  const pct = Number((raised * 10000n) / goal) / 100;
  return `${pct.toFixed(1)}%`;
}
