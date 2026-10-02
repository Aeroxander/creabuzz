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
    ...(record.unlocks ? { unlocks: record.unlocks } : {}),
    ...(record.daoAtGraduation !== null
      ? { daoAtGraduation: record.daoAtGraduation }
      : {}),
    ...(record.tokenPlan ? { tokenPlan: record.tokenPlan } : {}),
    ...(record.vesting ? { vesting: record.vesting } : {}),
    ...overrides,
  };
}
