import type { CreateLaunchInput } from "../use-launches";
import type { LaunchRecord } from "../models";

/**
 * The record as an edit input.
 *
 * Every field the record holds has to survive here, or an action that only
 * means to change one of them erases the rest: `tickSpacing` was reset to ""
 * and `tokenPlan` was dropped on *every* save, so terms the founder had set
 * disappeared and the mint handoff vanished for good (the Mint panel is gated
 * on `tokenPlan`, so it could never come back).
 */
export function recordToInput(
  record: LaunchRecord,
  overrides: Partial<CreateLaunchInput> = {},
): CreateLaunchInput {
  return {
    id: record.id,
    name: record.name,
    pitch: record.pitch,
    stage: record.stage,
    chainId: record.chainId ?? "11155111",
    currency: record.currency ?? "",
    floorPrice: record.floorPrice ?? "",
    tickSpacing: record.tickSpacing ?? "",
    requiredRaised: record.requiredRaised ?? "",
    auction: record.auction ?? "",
    token: record.token ?? "",
    treasury: record.treasury ?? "",
    admission: record.admission,
    channels: record.channels,
    chat: record.chat,
    // Preserve everything the record already holds that this editor does not
    // control: the founder commitments, the money fields, the split, the
    // signer, and (from the wizard) the window, the unlock plan and the
    // DAO-at-graduation choice. A save that drops any of them silently
    // rewrites what investors were shown (Review-Proven Rule 1).
    longPitch: record.longPitch ?? "",
    ipList: record.ipList,
    updateCadence: record.updateCadence ?? "",
    image: record.image ?? "",
    category: record.category ?? "",
    budget: record.budget ?? "",
    allocation: record.allocation,
    startBlock: record.startBlock ?? undefined,
    endBlock: record.endBlock ?? undefined,
    claimBlock: record.claimBlock ?? undefined,
    // Tags the deploy flows write and a later save must not erase.
    ...(record.distributor ? { distributor: record.distributor } : {}),
    ...(record.claimStake ? { claimStake: record.claimStake } : {}),
    ...(record.verifierSet ? { verifierSet: record.verifierSet } : {}),
    ...(record.legalWrapper ? { legalWrapper: record.legalWrapper } : {}),
    ...(record.ipRecord ? { ipRecord: record.ipRecord } : {}),
    ...(record.revenuePledge ? { revenuePledge: record.revenuePledge } : {}),
    ...(record.workAreas.length > 0 ? { workAreas: record.workAreas } : {}),
    ...(record.reviewerTies ? { reviewerTies: record.reviewerTies } : {}),
    ...(record.builtOn ? { builtOn: record.builtOn } : {}),
    ...(record.remixTerms ? { remixTerms: record.remixTerms } : {}),
    ...(record.reviewerTerms ? { reviewerTerms: record.reviewerTerms } : {}),
    ...(record.unlocks ? { unlocks: record.unlocks } : {}),
    ...(record.daoAtGraduation !== null
      ? { daoAtGraduation: record.daoAtGraduation }
      : {}),
    ...(record.listing ? { listing: record.listing } : {}),
    // The team is tags on this record, and the server reads them to decide who may post for the project: a save
    // that dropped them would take everyone off the team without a word.
    startedAt: record.startedAt,
    team: record.team,
    formerTeam: record.formerTeam,
    // Tags no form here owns. A save that left them out would erase them: the agent the record says wrote it, the
    // projects it links to, and the bid gates.
    ...(record.agent ? { agent: record.agent } : {}),
    ...(record.projects.length > 0 ? { projects: record.projects } : {}),
    ...(record.hooks.length > 0 ? { hooks: record.hooks } : {}),
    ...(record.funding ? { funding: record.funding } : {}),
    ...(record.tokenPlan ? { tokenPlan: record.tokenPlan } : {}),
    ...(record.vesting ? { vesting: record.vesting } : {}),
    ...overrides,
  };
}

/**
 * The tags a save writes for what the record carries and no form owns (see `recordToInput`). The agent tag is left
 * to the agent's own signing when the record is published as the agent, which writes it itself.
 */
export function carriedTags(input: {
  asAgent?: boolean;
  agent?: string;
  projects?: readonly string[];
  hooks?: readonly { address: string; bucket: string }[];
}): string[][] {
  return [
    ...(input.agent && !input.asAgent ? [["agent", input.agent]] : []),
    ...(input.projects ?? []).map((coordinate) => ["a", coordinate]),
    ...(input.hooks ?? []).map((hook) => ["hook", hook.address, hook.bucket]),
  ];
}
