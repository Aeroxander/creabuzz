/**
 * Who may open a vote, and which vote already covers a suggestion, so a page offers "Put to a vote" only to someone the
 * DAO would let open it, and says "Being voted on" once a vote is open.
 *
 * Pure and alias-free: `proposal-gate.test.mjs` drives it under `node --test`.
 */

import {
  ACTION_SIGNATURES,
  formatUnits,
} from "@creaton/core/launchpad/daoActions.ts";
import {
  decodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";

/** What a decisions read says about opening votes (`DecisionsSnapshot`). */
export interface ProposalPower {
  proposalThreshold: bigint;
  walletCapacity: bigint | null;
}

/**
 * Whether the connected account is known to be unable to open a decision: it holds no votes, or fewer than the DAO
 * asks for. Unknown (no read yet, a failed read, no wallet connected) is not "unable": the Decisions tab says why then.
 */
export function cannotOpenDecision(power: ProposalPower | undefined): boolean {
  const capacity = power?.walletCapacity ?? null;
  return (
    power !== undefined &&
    capacity !== null &&
    (capacity === 0n || capacity < power.proposalThreshold)
  );
}

/**
 * Whether to offer opening a vote (a freeze or unwind on someone's work) on a card: only to a signed-in person with a
 * wallet whose read does not show too few votes. A visitor with no account or no wallet is not offered it.
 */
export function mayOfferVote(
  power: ProposalPower | undefined,
  account: { signedIn: boolean; wallet: string | null },
): boolean {
  return (
    account.signedIn && account.wallet !== null && !cannotOpenDecision(power)
  );
}

/** Who may open a vote, in a few words: "Holders of 1 Share or more", or "Holders of Shares" when any holder may. */
export function whoMayOpen(power: ProposalPower | undefined): string {
  if (!power || power.proposalThreshold <= 10n ** 18n)
    return power && power.proposalThreshold > 0n
      ? "Holders of 1 Share or more"
      : "Holders of Shares";
  return `Holders of ${formatUnits(power.proposalThreshold, 18)} Shares or more`;
}

/**
 * What someone who cannot open a decision is told instead of a form: how many Shares it takes and how many they hold.
 * Null when they can, or when that is not known yet.
 */
export function cannotOpenLine(
  power: ProposalPower | undefined,
): string | null {
  if (!power || !cannotOpenDecision(power)) return null;
  const need =
    power.proposalThreshold > 0n ? power.proposalThreshold : 10n ** 18n;
  return `You need ${formatUnits(need, 18)} ${need === 10n ** 18n ? "Share" : "Shares"} to open a decision. You hold ${formatUnits(power.walletCapacity ?? 0n, 18)}.`;
}

const APPROVE_PROJECT = selectorOf(ACTION_SIGNATURES.approveProject)
  .slice(2)
  .toLowerCase();

/** A decision as far as this needs it: its id, where it stands, and the call it would make. */
interface DecisionLike {
  id: string;
  state: string;
  action: { data: string } | null;
}

const LIVE = new Set(["Active", "Succeeded", "Queued"]);

/**
 * The open vote that would approve this work area (same short name and same words), or null. A vote that already
 * passed and ran, or failed, does not count: the suggestion then reads as approved, or can be put to a vote again.
 */
export function openVoteFor(
  decisions: readonly DecisionLike[],
  area: { projectId: string; checkHash: string },
): string | null {
  for (const decision of decisions) {
    if (!LIVE.has(decision.state) || !decision.action) continue;
    const hex = decision.action.data.replace(/^0x/, "").toLowerCase();
    if (!hex.startsWith(APPROVE_PROJECT)) continue;
    try {
      const [id, , , , , check] = decodeParameters(
        ["bytes32", "address", "uint128", "uint128", "uint64", "bytes32"],
        `0x${hex.slice(8)}`,
      ) as [string, string, bigint, bigint, bigint, string];
      if (
        id.toLowerCase() === area.projectId.toLowerCase() &&
        check.toLowerCase() === area.checkHash.toLowerCase()
      )
        return decision.id;
    } catch {}
  }
  return null;
}
