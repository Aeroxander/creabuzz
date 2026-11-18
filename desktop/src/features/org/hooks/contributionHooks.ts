import { useMutation, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { KIND_CONTRIBUTION_RECORD } from "@/shared/constants/kinds";

import {
  buildReviewRepublish,
  type DisplayedReviewRecord,
} from "../lib/contributionReview";
import type { ReviewStatus } from "../orgModels";
import { orgQueryKey } from "./shared";

// ── Contribution review (Phase 3) ──────────────────────────────────────────

type ReviewUpdateInput = {
  /** The record rendered on screen — the exact version being reviewed. */
  record: DisplayedReviewRecord;
  reviewStatus: ReviewStatus;
  appealNote?: string;
};

/**
 * Republish a kind:37013 record with the same `d` tag, copying the record
 * **rendered on screen** and updating `reviewStatus` (NIP-33 LWW picks the
 * newest write). The copy source is the displayed snapshot, never a click-time
 * read: a concurrent edit must not change which version an Accept applies to.
 * If the store moved ahead of the display, the displayed version still wins
 * and the later write supersedes this one like any other review. The
 * relay-side reviewer grant check is future work; any signer may review for
 * now and the UI labels reviewers as unverified.
 */
async function republishContributionReview(
  input: ReviewUpdateInput,
): Promise<string> {
  const draft = buildReviewRepublish(input.record, input);
  const event = await signRelayEvent({
    kind: KIND_CONTRIBUTION_RECORD,
    content: draft.content,
    tags: draft.tags,
  });
  await relayClient.publishEvent(
    event,
    "Timed out updating contribution review.",
    "Failed to update contribution review.",
  );
  return event.id;
}

export function useUpdateContributionReviewMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: republishContributionReview,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "contributions"],
      });
      await queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "chart"],
      });
    },
  });
}
