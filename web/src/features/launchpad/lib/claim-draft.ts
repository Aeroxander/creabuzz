/**
 * The text of a work submission, kept in this browser from the moment its fingerprint goes to the chain until its
 * evidence is published, so a reload or a closed tab in between never strands the claim. The chain only holds the
 * text's fingerprint: without the exact text, nobody can publish what the reviewers must read, and the claim can never
 * be approved. Same pattern as a milestone submission (`milestone-submission.ts`): kept and read back before anything
 * is sent, and dropped only once the evidence is on the server.
 *
 * A copy is kept per server, per signed-in account, per wallet and per claim (its id and the fingerprint of its text),
 * so one person's copy never fills in another's form, and a copy is only ever offered for the claim whose fingerprint
 * it matches.
 *
 * Pure and alias-free: `claim-draft.test.mjs` drives it under `node --test`.
 */

import { hashText } from "@creaton/core/launchpad/work.ts";

const PREFIX = "buzz.launchpad.claim-draft:";
/**
 * The most copies kept. Past it the oldest copies are dropped by when they were kept, whatever became of their claim:
 * that includes a copy left by a wallet prompt that was cancelled (kept on purpose, since part of a send may have
 * landed) and, after many newer ones, a copy whose claim landed but was never published. That claim's evidence can then
 * still be published by pasting its exact text.
 */
export const MAX_CLAIM_DRAFTS = 20;
const ZERO_WORD = `0x${"0".repeat(64)}`;

export interface ClaimDraft {
  /** The claim's title as typed. */
  name: string;
  /** The evidence exactly as its fingerprint went to the chain (with how it was checked). */
  evidence: string;
  /** The words it is judged against, exactly. */
  check: string;
}

export interface ClaimDraftScope {
  /** The server this page talks to. */
  server: string;
  /** The signed-in account. */
  account: string;
  /** The wallet that files the claim. */
  wallet: string;
  /** The claim's id (its title in 32 bytes). */
  claimId: string;
  /** The fingerprint of the evidence the claim commits to. */
  evidenceHash: string;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem" | "getItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>;

export function claimDraftKey(scope: ClaimDraftScope): string {
  return `${PREFIX}${[
    scope.server,
    scope.account,
    scope.wallet,
    scope.claimId,
    scope.evidenceHash,
  ]
    .map((part) => part.trim().toLowerCase())
    .join("|")}`;
}

/** The kept copy, or null when there is none or it is not well formed. */
export function loadClaimDraft(
  key: string,
  storage: ReadStorage | null = safeStorage(),
): ClaimDraft | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return null;
    const { name, evidence, check } = value as Record<string, unknown>;
    return typeof name === "string" &&
      typeof evidence === "string" &&
      evidence.trim() !== "" &&
      typeof check === "string"
      ? { name, evidence, check }
      : null;
  } catch {
    return null;
  }
}

/**
 * Keep the copy. True only when it is really kept: the write did not fail and reading it back gives the same text (some
 * browsers drop a write without saying so). A claim must not be sent when this is false.
 */
export function saveClaimDraft(
  key: string,
  draft: ClaimDraft,
  storage: WriteStorage | null = safeStorage(),
  now: number = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    const raw = JSON.stringify({ ...draft, savedAt: now });
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) return false;
    pruneClaimDrafts(storage, key);
    return true;
  } catch {
    return false;
  }
}

/** Forget the copy, once its evidence is on the server. */
export function clearClaimDraft(
  key: string,
  storage: Pick<Storage, "removeItem"> | null = safeStorage(),
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}

/**
 * The kept text to publish for this claim, only when it is exactly what the claim committed to: its evidence matches
 * the claim's fingerprint, and its words match the claim's (or the claim states no words yet). Anything else is null:
 * a copy that does not match would only be refused.
 */
export function draftForClaim(
  draft: ClaimDraft | null,
  claim: { record: { evidenceHash: string; checkHash: string } },
): ClaimDraft | null {
  if (!draft) return null;
  if (hashText(draft.evidence) !== claim.record.evidenceHash.toLowerCase())
    return null;
  const check = claim.record.checkHash.toLowerCase();
  if (check !== ZERO_WORD && hashText(draft.check) !== check) return null;
  return draft;
}

export type FileOutcome = "not-kept" | "not-sent" | "not-published" | "done";

/**
 * Submit work in the order that never strands it: keep the copy, send what is left to the chain, publish the evidence,
 * and only then forget the copy. When the claim's fingerprint is about to go to the chain (`commits`), a copy that could
 * not be kept stops everything before the wallet is asked. When it is already there, keeping is still tried, but
 * publishing goes ahead either way: it is the step that makes the claim readable.
 */
export async function fileWithDraft(steps: {
  commits: boolean;
  keep: () => boolean;
  /** Sends what is left on the chain; resolves false when it did not all land. */
  send: () => Promise<boolean>;
  publish: () => Promise<void>;
  forget: () => void;
}): Promise<FileOutcome> {
  if (!steps.keep() && steps.commits) return "not-kept";
  if (!(await steps.send())) return "not-sent";
  try {
    await steps.publish();
  } catch {
    return "not-published";
  }
  steps.forget();
  return "done";
}

/** Keep at most `MAX_CLAIM_DRAFTS` copies, dropping the oldest; never the one just kept. */
function pruneClaimDrafts(storage: WriteStorage, keep: string): void {
  if (typeof storage.key !== "function" || typeof storage.length !== "number")
    return;
  const kept: { key: string; at: number }[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    let at = 0;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null") as {
        savedAt?: unknown;
      } | null;
      at = typeof value?.savedAt === "number" ? value.savedAt : 0;
    } catch {
      at = 0;
    }
    kept.push({ key, at });
  }
  if (kept.length <= MAX_CLAIM_DRAFTS) return;
  kept
    .filter((entry) => entry.key !== keep)
    .sort((a, b) => a.at - b.at)
    .slice(0, kept.length - MAX_CLAIM_DRAFTS)
    .forEach((entry) => {
      storage.removeItem(entry.key);
    });
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
