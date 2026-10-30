import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { parseBindingRecord } from "@/features/projects/lib/bindings";
import { KIND_EVM_BINDING } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { claimKey, type RecordEvents, type Verdict } from "./lib/record-read";
import {
  boundWallets,
  type ReviewReason,
  reasonsFor,
  reasonWouldShow,
} from "./lib/review-reasons";

/** The most people whose bindings one lookup reads: one reviewer panel, with room to spare. */
const MAX_AUTHORS = 50;
const MAX_RECORDS = 200;

/** The wallets `authors` have bound, live (a withdrawn binding unbinds), as `boundWallets` names them. */
async function fetchBoundWallets(authors: string[]): Promise<Set<string>> {
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_EVM_BINDING],
    authors,
    limit: MAX_RECORDS,
  });
  return boundWallets(
    events.flatMap((event) => {
      const parsed = parseBindingRecord(event);
      return parsed ? [parsed] : [];
    }),
  );
}

export interface ClaimReview {
  /** Who answered on the chain, in the order they did; null while it is not read (or could not be). */
  verdicts: Verdict[] | null;
  /** The reasons that can be shown: each from a wallet that turned the claim down, signed by whoever bound it. */
  reasons: ReviewReason[];
}

/**
 * Who reviewed each claim and, for a turn-down, why: the verdicts from the chain (`record`, the Work tab's own read) and
 * the reasons reviewers published (`reasons`, from the evidence read), each reason checked against the turn-downs and
 * the bindings of the people who signed them (`lib/review-reasons.ts`). Only the signers' bindings are read.
 */
export function useReviewReasons(
  reasons: readonly ReviewReason[],
  record: RecordEvents | undefined,
): { reviewOf: (mandate: string, claimId: string) => ClaimReview } {
  const authors = useMemo(
    () =>
      [...new Set(reasons.map((r) => r.author))].sort().slice(0, MAX_AUTHORS),
    [reasons],
  );
  const bindings = useQuery({
    queryKey: ["launchpad", "reason-bindings", relayWsUrl(), authors],
    enabled: authors.length > 0,
    queryFn: () => fetchBoundWallets(authors),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return useMemo(() => {
    const bound = bindings.data ?? new Set<string>();
    return {
      reviewOf: (mandate: string, claimId: string): ClaimReview => {
        const verdicts =
          record?.verdicts.get(claimKey(mandate, claimId)) ??
          (record ? [] : null);
        const objectedBy = verdicts
          ? verdicts.filter((v) => !v.approve).map((v) => v.reviewer)
          : null;
        return {
          verdicts,
          reasons: reasonsFor(
            { id: claimId, mandate },
            reasons,
            objectedBy,
            bound,
          ),
        };
      },
    };
  }, [bindings.data, record, reasons]);
}

/**
 * Whether a reason the signed-in person writes as `reviewer` would be shown to the contributor: their own key has a live
 * binding to that wallet, read the way the reasons are filtered. `check` reads it again and answers (null when it could
 * not be read), for the moment before a reason is published. The key starts with "identity", so linking an account
 * (`AccountNameLink`) reads it again.
 */
export function useReasonShown(reviewer: string): {
  /** null while it is not known. */
  shown: boolean | null;
  check: () => Promise<boolean | null>;
} {
  const me = existingUserPubkey();
  const own = useQuery({
    queryKey: ["identity", "reason-binding", relayWsUrl(), me],
    enabled: me !== null,
    queryFn: () => fetchBoundWallets([me as string]),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const answer = (bound: Set<string> | undefined): boolean | null =>
    me && bound ? reasonWouldShow(bound, me, reviewer) : null;
  return {
    shown: answer(own.data),
    check: async () => {
      if (!me) return null;
      const read = await own.refetch();
      return read.isError ? null : answer(read.data);
    },
  };
}
