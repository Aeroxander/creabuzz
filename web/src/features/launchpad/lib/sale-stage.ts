/**
 * The stage a launch page should show: the record's own, corrected by the auction where the auction can say.
 *
 * A launch record's stage is a label the founder moves forward by hand (or that the app moves when it launches). The
 * auction has its own clock and its own result, and the page used to ignore both: a sale that had run and been funded
 * still read Draft, and a DAO's front page (which is for a project whose sale is over) never appeared. Here the auction
 * decides, and only a launch the chain could not be read for keeps its saved label.
 *
 * - Before the start block nothing changes.
 * - From the start block until the end block the sale is live, even if the record still says draft.
 * - After the end block a sale that missed its minimum has failed, and one that met it is complete once the buyers can
 *   claim (the claim block). Between the two it is still live.
 * - A stage that already says graduated or failed is final and kept.
 *
 * Pure and alias-free: `sale-stage.test.mjs` drives it under `node --test`.
 */

export type Stage =
  | "draft"
  | "review"
  | "live"
  | "funding"
  | "graduated"
  | "failed";

export interface SaleStageInput {
  stage: Stage;
  hasAuction: boolean;
  /** The auction read from the chain: `graduated` once the minimum raise was met. */
  progress?: { source: string; graduated: boolean };
  window?: {
    startBlock: number | null;
    endBlock: number | null;
    claimBlock: number | null;
    head: number | bigint | null;
  };
}

/** The stage for a launch record, its saved stage, the current block and the auction read. */
export function stageForLaunch(
  launch: {
    record: {
      auction: string | null;
      startBlock: number | null;
      endBlock: number | null;
      claimBlock: number | null;
    };
  },
  stage: Stage,
  head: number | bigint | null,
  progress: SaleStageInput["progress"],
): Stage {
  return stageFromChain({
    stage,
    hasAuction: Boolean(launch.record.auction),
    progress,
    window: {
      startBlock: launch.record.startBlock,
      endBlock: launch.record.endBlock,
      claimBlock: launch.record.claimBlock,
      head,
    },
  });
}

export function stageFromChain(input: SaleStageInput): Stage {
  const { stage, hasAuction, progress, window } = input;
  if (stage === "graduated" || stage === "failed") return stage;
  const head = window?.head == null ? null : Number(window.head);
  const start = window?.startBlock ?? null;
  const end = window?.endBlock ?? null;
  const claim = window?.claimBlock ?? null;
  if (!hasAuction || head === null || start === null || end === null) {
    return stage;
  }
  const opened = stage === "draft" || stage === "review" ? "live" : stage;
  if (head < start) return stage;
  if (head < end) return opened;
  // The auction is over; only a reading from the chain can say how it went.
  if (progress?.source !== "rpc") return stage;
  if (!progress.graduated) return "failed";
  return claim !== null && head >= claim ? "graduated" : opened;
}
