import {
  buildTimeline,
  type TimelineEntry,
  type TimelineSummary,
} from "./lib/milestone-timeline";
import { plannedMilestoneTokens } from "./lib/milestone-plan";
import type { Launch } from "./models";
import { useEvidencePackets } from "./use-evidence";
import { useRecordEvents, useWork } from "./use-work";
import { useWalletLabels } from "./use-wallet-labels";

/**
 * The public milestone timeline for a launch: the same read the Milestones tab and the DAO's front page show, so both say
 * the same thing. With no DAO yet it is the agreement from the launch record. With one, it is what the chain says, and while
 * that is being read (or could not be) it says so rather than showing every milestone as not started.
 */
export function useMilestoneTimeline(
  launch: Launch,
  dao: string | null,
): {
  entries: TimelineEntry[];
  summary: TimelineSummary;
  panel: {
    address: string;
    reviewers: readonly { address: string }[];
    quorum: number;
    challengeWindow: number;
    expiresAt: number;
    closed: boolean;
  } | null;
  /** The chain is still being read. */
  reading: boolean;
  /** The chain could not be read: nothing is shown as reached or not. */
  failed: boolean;
  /** How to write a reviewer's wallet. */
  labelOf: (address: string) => string;
} {
  const plan = launch.record.unlocks;
  const plannedTokens = plannedMilestoneTokens(launch.record);
  const planned = (plan?.milestones ?? []).map((m, index) => ({
    label: m.label,
    percent: m.percent,
    plannedTokens: plannedTokens[index] ?? null,
  }));
  const work = useWork(dao, null);
  const events = useRecordEvents(dao, work.data);
  const evidence = useEvidencePackets(launch);
  const panel = work.data?.mandates.find((m) => m.isMilestonePanel) ?? null;
  const labelOf = useWalletLabels(
    (panel?.reviewers ?? []).map((r) => r.address),
  );
  const reading = dao !== null && (work.isLoading || events.isLoading);
  const failed = dao !== null && !reading && (!work.data || !events.data);
  const { entries, summary } = buildTimeline({
    milestones: planned,
    panel: panel
      ? {
          address: panel.address,
          reviewers: panel.reviewers,
          quorum: panel.quorum,
          challengeWindow: panel.challengeWindow,
          claims: panel.claims,
        }
      : null,
    tranches: (events.data?.promises ?? []).map((p) => p.tranches),
    verdicts: events.data?.verdicts,
    packets: evidence.packets,
    now: work.data?.chainTime ?? Math.floor(Date.now() / 1000),
  });
  return {
    entries,
    summary,
    panel: panel
      ? {
          address: panel.address,
          reviewers: panel.reviewers,
          quorum: panel.quorum,
          challengeWindow: panel.challengeWindow,
          expiresAt: panel.expiresAt,
          closed: panel.closed,
        }
      : null,
    reading,
    failed,
    labelOf,
  };
}
