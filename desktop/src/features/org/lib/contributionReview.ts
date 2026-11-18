/**
 * Pure builder for a contribution-review republish (kind:37013, same `d`).
 *
 * The review copies the record **rendered on screen** — the exact snapshot the
 * reviewer saw — never a click-time refetch. A concurrent edit must not
 * silently change which version an "Accept" applies to: if the store moved
 * ahead of the display, the displayed version still wins (and the later write
 * supersedes this one under NIP-33 LWW like any other review).
 *
 * Alias-free and pure so `contributionReview.test.mjs` can drive it under
 * `node --test`.
 */
import type { ReviewStatus } from "../orgModels";

/** The displayed record's immutable snapshot. */
export type DisplayedReviewRecord = {
  content: Record<string, unknown>;
  tags: readonly (readonly string[])[];
};

export type ReviewRepublishInput = {
  reviewStatus: ReviewStatus;
  appealNote?: string;
  /** Injected clock (seconds) for appeal history; defaults to now. */
  nowSecs?: number;
};

export type ReviewRepublishDraft = {
  content: string;
  tags: string[][];
};

/** Build the republish event draft from the on-screen record snapshot. */
export function buildReviewRepublish(
  displayed: DisplayedReviewRecord,
  input: ReviewRepublishInput,
): ReviewRepublishDraft {
  const content: Record<string, unknown> = { ...displayed.content };
  content.reviewStatus = input.reviewStatus;
  if (input.reviewStatus === "appealed") {
    const history = Array.isArray(content.appealHistory)
      ? (content.appealHistory as unknown[])
      : [];
    content.appealHistory = [
      ...history,
      {
        status: "appealed",
        at: input.nowSecs ?? Math.floor(Date.now() / 1_000),
        ...(input.appealNote ? { note: input.appealNote } : {}),
      },
    ];
  }
  return {
    content: JSON.stringify(content),
    tags: displayed.tags.map((tag) => [...tag]),
  };
}
