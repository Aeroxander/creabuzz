import { useMutation, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { KIND_CONTRIBUTION_RECORD } from "@/shared/constants/kinds";

import type { ReviewStatus } from "../orgModels";
import { orgQueryKey } from "./shared";

// ── Contribution review (Phase 3) ──────────────────────────────────────────

type ReviewUpdateInput = {
  dtag: string;
  reviewStatus: ReviewStatus;
  appealNote?: string;
};

/**
 * Republish a kind:37013 record with the same `d` tag, copying every prior
 * field and updating `reviewStatus` (NIP-33 LWW picks the newest write).
 * The relay-side reviewer grant check is future work; any signer may review
 * for now and the UI labels reviewers as unverified.
 */
async function republishContributionReview(
  input: ReviewUpdateInput,
): Promise<string> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_CONTRIBUTION_RECORD],
    "#d": [input.dtag],
    limit: 500,
  });
  if (events.length === 0) {
    throw new Error(`Contribution record "${input.dtag}" not found.`);
  }
  const current = events.reduce((newest, event) =>
    event.created_at > newest.created_at ? event : newest,
  );

  let content: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(current.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    content = parsed as Record<string, unknown>;
  } catch {
    content = {};
  }

  content.reviewStatus = input.reviewStatus;
  if (input.reviewStatus === "appealed") {
    const history = Array.isArray(content.appealHistory)
      ? (content.appealHistory as unknown[])
      : [];
    content.appealHistory = [
      ...history,
      {
        status: "appealed",
        at: Math.floor(Date.now() / 1_000),
        ...(input.appealNote ? { note: input.appealNote } : {}),
      },
    ];
  }

  const event = await signRelayEvent({
    kind: KIND_CONTRIBUTION_RECORD,
    content: JSON.stringify(content),
    tags: current.tags,
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
