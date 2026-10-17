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
}): RemainingSteps {
  const { draft, claim, checkHash, published } = input;
  if (claim === null) {
    return { steps: ["file", "check", "bind", "publish"] };
  }
  if (claim.record.status !== "Open") {
    return {
      problem:
        "That claim is no longer open, so it cannot be continued. Start a new submission.",
    };
  }
  if (hashText(draft.evidence) !== claim.record.evidenceHash.toLowerCase()) {
    return {
      problem:
        "The saved text is not what was filed with that claim. Start a new submission.",
    };
  }
  const steps: SubmitStep[] = [];
  const current = claim.record.checkHash.toLowerCase();
  if (current === ZERO_WORD) steps.push("check");
  else if (current !== checkHash.toLowerCase()) {
    return {
      problem:
        "That claim names different words for its criterion, so it cannot be this milestone's. Start a new submission.",
    };
  }
  if (claim.project === null) steps.push("bind");
  if (!published) steps.push("publish");
  return { steps };
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

export function saveSubmission(
  key: string,
  draft: SubmissionDraft,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
  try {
    storage?.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage unavailable: the submission just does not survive a reload.
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
