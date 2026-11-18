/**
 * A milestone submission that survives a cancelled wallet prompt or a reload.
 *
 * Submitting a milestone is four separate things: file the claim, state which milestone it is for, send it to the
 * panel's reviewers, and publish the evidence they will read. Each is its own transaction or message, so stopping part
 * way is normal: a person cancels one prompt, closes the tab, loses the connection. The submission is saved before the
 * first of them, and what is left to do is worked out from what the chain and the server already show, not from flags
 * kept here, so a retry never files a second claim and never forgets to publish the evidence.
 *
 * Pure and alias-free: `milestone-submission.test.mjs` drives it under `node --test`.
 */

import { hashText, idWord } from "@creaton/core/launchpad/work.ts";
import type { ClaimView } from "@creaton/core/launchpad/work.ts";

import {
  MAX_MILESTONE_CLAIMS,
  milestoneClaimNames,
} from "./milestone-progress.ts";

const ZERO_WORD = `0x${"0".repeat(64)}`;

export interface SubmissionDraft {
  /** The claim's name; its id is derived from it, so the same name always means the same claim. */
  name: string;
  /** The evidence text, exactly as it will be committed to and published. */
  evidence: string;
}

export type SubmitStep = "file" | "check" | "bind" | "publish";

export type RemainingSteps = { steps: SubmitStep[] } | { problem: string };

/** The claim a draft stands for, among the panel's claims, only if the connected wallet filed it. */
export function claimForDraft(
  claims: readonly ClaimView[],
  draft: SubmissionDraft | null,
  wallet: string,
): ClaimView | null {
  if (!draft) return null;
  const id = idWord(draft.name).toLowerCase();
  return (
    claims.find(
      (c) =>
        c.id.toLowerCase() === id &&
        c.record.contributor.toLowerCase() === wallet.toLowerCase(),
    ) ?? null
  );
}

/** Someone else's claim already has the draft's name, so filing it would be refused: it has to start over. */
export function nameTakenByOther(
  claims: readonly ClaimView[],
  draft: SubmissionDraft | null,
  wallet: string,
): boolean {
  if (!draft) return false;
  const id = idWord(draft.name).toLowerCase();
  return claims.some(
    (c) =>
      c.id.toLowerCase() === id &&
      c.record.contributor.toLowerCase() !== wallet.toLowerCase(),
  );
}

/**
 * What is still to do, in order. Nothing is repeated that already shows: a claim that is filed is not filed again, a
 * criterion that is set is not set again, a claim that is already with the reviewers is not sent again, and evidence
 * that readers can already verify is not published again. Something that cannot be continued says why.
 */
export function remainingSteps(input: {
  draft: SubmissionDraft;
  /** The claim the draft stands for, once it is on the chain. */
  claim: ClaimView | null;
  /** The fingerprint of the milestone's words: what the claim's criterion must be. */
  checkHash: string;
  /** Readers can already verify this claim's evidence. */
  published: boolean;
  /** Someone else filed a claim under the draft's name first ({@link nameTakenByOther}). */
  nameTaken?: boolean;
}): RemainingSteps {
  const { draft, claim, checkHash, published } = input;
  if (claim === null) {
    // Filing again would be refused every time: say so instead of offering a Continue that cannot work.
    if (input.nameTaken) {
      return {
        problem:
          "Someone else already used this submission's name, so it cannot be sent. Press Start over to send the same text under a new name.",
      };
    }
    return { steps: ["file", "check", "bind", "publish"] };
  }
  if (claim.record.status !== "Open") {
    return {
      problem:
        "That submission is no longer open, so it cannot be continued. Press Start over to make a new one.",
    };
  }
  if (hashText(draft.evidence) !== claim.record.evidenceHash.toLowerCase()) {
    return {
      problem:
        "The saved text is not what was sent with that submission. Press Start over to make a new one.",
    };
  }
  const steps: SubmitStep[] = [];
  const current = claim.record.checkHash.toLowerCase();
  if (current === ZERO_WORD) steps.push("check");
  else if (current !== checkHash.toLowerCase()) {
    return {
      problem:
        "That submission names different words for what counts as done, so it cannot be this milestone's. Press Start over to make a new one.",
    };
  }
  if (claim.project === null) steps.push("bind");
  if (!published) steps.push("publish");
  return { steps };
}

/** Said when every name a milestone's claims can take is used: nothing is sent. */
export const CLAIM_NAMES_USED_UP = `This milestone has been submitted ${MAX_MILESTONE_CLAIMS} times, the most this page can send, so nothing was sent. Your text is still in the box. Going on needs a decision by holders: raise it on the Decisions tab.`;

/** Said when the wallet or milestone changed while a name was being checked: nothing is sent under the old one. */
export const CLAIM_CHECK_SUPERSEDED =
  "Your account changed while this submission's name was being checked, so nothing was sent. Your text is still in the box. Submit again to send it from this account.";

/** Said when the network could not say whether a name is free: nothing is sent, and trying again is safe. */
export const CLAIM_NAME_UNCHECKED =
  "Couldn't check that this submission's name is free, so nothing was sent. Your text is still in the box. Try again in a moment.";

/**
 * Whether the milestone panel's record for one claim name is empty, from its `claims(bytes32)` read: an unused name reads
 * as eight zero-led words (no contributor). A reply too short to be that record is not "free": it throws, so a bad read
 * is never taken for a free name and filed over someone's claim.
 */
export function claimSlotEmpty(hex: string): boolean {
  const body = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length < 8 * 64) {
    throw new Error("the claim record could not be read");
  }
  return /^0+$/.test(body.slice(0, 64));
}

/**
 * The name for a new submission of milestone `index`. Names the panel's claims already show are skipped; each remaining
 * one is checked with the network before it is chosen, because the claims shown are only the newest ones and another
 * person may have filed since they were read. Bounded by {@link milestoneClaimNames}: when all are used the answer says so,
 * and a check that fails stops the search rather than guessing.
 */
export async function allocateClaimName(
  index: number,
  /** The names of the claims already shown on the panel. */
  shown: readonly string[],
  /** Reads whether a name is unused on the chain; throws when it cannot tell. */
  isFree: (name: string) => Promise<boolean>,
  /** False once the submission this search is for is no longer the one on screen (another wallet, another milestone). */
  isCurrent: () => boolean = () => true,
): Promise<{ name: string } | { problem: string }> {
  const used = new Set(shown.map((t) => t.toLowerCase()));
  for (const name of milestoneClaimNames(index)) {
    if (used.has(name.toLowerCase())) continue;
    let free: boolean;
    try {
      free = await isFree(name);
    } catch {
      return { problem: CLAIM_NAME_UNCHECKED };
    }
    // Checked after every wait: a result for a wallet that is no longer connected must not be saved or filed.
    if (!isCurrent()) return { problem: CLAIM_CHECK_SUPERSEDED };
    if (free) return { name };
  }
  return { problem: CLAIM_NAMES_USED_UP };
}

const STORAGE_PREFIX = "buzz.launchpad.milestone-submission:";

/** Where one wallet's submission for one milestone of one DAO is kept. */
export function submissionKey(
  dao: string,
  wallet: string,
  index: number,
): string {
  return `${STORAGE_PREFIX}${dao.toLowerCase()}:${wallet.toLowerCase()}:${index}`;
}

/** The saved submission, or null when there is none or it is not well formed. */
export function loadSubmission(
  key: string,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): SubmissionDraft | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return null;
    const { name, evidence } = value as Record<string, unknown>;
    return typeof name === "string" &&
      name.trim() !== "" &&
      typeof evidence === "string" &&
      evidence.trim() !== ""
      ? { name, evidence }
      : null;
  } catch {
    return null;
  }
}

/**
 * Keep the submission so a cancel or a reload finds it again. True only when it is really kept: the write did not fail
 * and reading it back gives the same text (some browsers drop a write without saying so). A submission that is not kept
 * must not be sent: a claim filed with no saved name and evidence is exactly the lost one this draft exists to prevent.
 */
export function saveSubmission(
  key: string,
  draft: SubmissionDraft,
  storage: Pick<Storage, "setItem" | "getItem"> | null = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    const raw = JSON.stringify(draft);
    storage.setItem(key, raw);
    return storage.getItem(key) === raw;
  } catch {
    return false;
  }
}

export function clearSubmission(
  key: string,
  storage: Pick<Storage, "removeItem"> | null = safeStorage(),
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
