import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";
import {
  buildResolutionMap,
  KIND_APPROVAL_DENY,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_REQUEST,
  NEEDS_ME_REQUEST_LIMIT,
  needsMeStatus,
  parseNeedsMeApproval,
  parseNeedsMeResolution,
  type NeedsMeApproval,
  type NeedsMeResolution,
  type NeedsMeStatus,
} from "@/features/home/lib/needsMe";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { useRelayConnection } from "@/shared/api/useRelayConnection";
import { useFocusedRefetchInterval } from "@/shared/lib/useDocumentVisible";

/** Poll backstop cadence — matches the home feed. The live subscription and
 *  reconnect invalidation are the freshness paths; the poll covers a silently
 *  dropped live event. */
export const NEEDS_ME_REFETCH_INTERVAL_MS = 30_000;

export type NeedsMeItem = NeedsMeApproval & {
  status: NeedsMeStatus;
};

type NeedsMeQueryData = {
  requests: RelayEvent[];
  resolutions: NeedsMeResolution[];
  /** False when the resolution read degraded — pending rows still render. */
  resolutionsComplete: boolean;
};

type NeedsMeLocalData = {
  resolving: string[];
  resolved: string[];
  /**
   * Per-token inline failure message from the last rejected resolution
   * publish. Cleared on the next attempt for the same token.
   */
  errors: { tokenHash: string; message: string }[];
};

const EMPTY_LOCAL: NeedsMeLocalData = {
  resolving: [],
  resolved: [],
  errors: [],
};

/**
 * The #p audience for the request read: the current user plus (optionally)
 * their owned agents' pubkeys. Budget overrun requests address the budgeted
 * AGENT (`p` = subject), while workflow requests address the workflow owner —
 * an owner only sees their agents' overruns if the agent keys are included.
 * Bounded so the REQ filter cannot grow without limit.
 */
export function needsMeAudiencePubkeys(
  currentPubkey: string | undefined,
  ownedAgentPubkeys: readonly string[] = [],
): string[] {
  const audience: string[] = [];
  if (currentPubkey) {
    audience.push(currentPubkey);
  }
  for (const pubkey of ownedAgentPubkeys) {
    if (audience.length >= NEEDS_ME_REQUEST_LIMIT) break;
    const normalized = pubkey.trim().toLowerCase();
    if (normalized !== "" && !audience.includes(normalized)) {
      audience.push(normalized);
    }
  }
  return audience;
}

export function needsMeQueryKey(communityId: string | null, pubkey?: string) {
  return ["needs-me", communityId, pubkey ?? null] as const;
}

export function needsMeLocalQueryKey(
  communityId: string | null,
  pubkey?: string,
) {
  return ["needs-me-local", communityId, pubkey ?? null] as const;
}

function uniqueTokenHashes(requests: readonly RelayEvent[]): string[] {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const event of requests) {
    const approval = parseNeedsMeApproval(event);
    if (approval && !seen.has(approval.tokenHash)) {
      seen.add(approval.tokenHash);
      hashes.push(approval.tokenHash);
    }
  }
  return hashes;
}

async function fetchNeedsMeData(audience: string[]): Promise<NeedsMeQueryData> {
  // Kinds are always present (the relay p-gate 403s kindless filters) and the
  // read is bounded: pending approval requests addressed to me or my agents.
  const requests = await relayClient.fetchEvents({
    kinds: [KIND_APPROVAL_REQUEST],
    "#p": audience,
    limit: NEEDS_ME_REQUEST_LIMIT,
  });

  // Resolution check: the relay persists the kind:46030/46031 command events
  // under their token-hash `d` tag. A token that cannot be found there is
  // still pending. A failed resolution read degrades (rows stay pending)
  // rather than failing the whole "needs me" surface.
  const tokenHashes = uniqueTokenHashes(requests);
  if (tokenHashes.length === 0) {
    return { requests, resolutions: [], resolutionsComplete: true };
  }
  try {
    const resolutionEvents = await relayClient.fetchEvents({
      kinds: [KIND_APPROVAL_GRANT, KIND_APPROVAL_DENY],
      "#d": tokenHashes,
      limit: tokenHashes.length * 2,
    });
    return {
      requests,
      resolutions: resolutionEvents
        .map(parseNeedsMeResolution)
        .filter((r): r is NeedsMeResolution => r !== null),
      resolutionsComplete: true,
    };
  } catch (error) {
    console.error("Couldn’t read approval resolutions", error);
    return { requests, resolutions: [], resolutionsComplete: false };
  }
}

/**
 * The "Needs me" query: pending kind:46010 approval requests (workflow + NIP-ORG
 * budget overruns) addressed to the current user, with resolution status.
 *
 * Freshness: bounded backfill query + live subscription + reconnect
 * invalidation + a poll backstop. The live subscription opens before the
 * backfill resolves, so events arriving in between are seen by both paths and
 * deduplicated by event id (no gap between history and live).
 */
export function useNeedsMeApprovals({
  currentPubkey,
  ownedAgentPubkeys = [],
}: {
  currentPubkey?: string;
  ownedAgentPubkeys?: readonly string[];
} = {}) {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? null;
  const connectionState = useRelayConnection();
  const connected = connectionState === "connected";
  const queryClient = useQueryClient();
  const refetchInterval = useFocusedRefetchInterval(
    connected ? NEEDS_ME_REFETCH_INTERVAL_MS : false,
  );
  const enabled = connected && currentPubkey !== undefined;

  const audience = React.useMemo(
    () => needsMeAudiencePubkeys(currentPubkey, ownedAgentPubkeys),
    [currentPubkey, ownedAgentPubkeys],
  );

  const query = useQuery({
    queryKey: needsMeQueryKey(communityId, currentPubkey),
    queryFn: () => fetchNeedsMeData(audience),
    enabled,
    refetchInterval,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  const localQuery = useQuery({
    queryKey: needsMeLocalQueryKey(communityId, currentPubkey),
    queryFn: () => EMPTY_LOCAL,
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });

  // Live subscription: any new approval request (or resolution command event
  // visible to this connection) invalidates the bounded backfill.
  React.useEffect(() => {
    if (!enabled || !currentPubkey) return;
    let disposed = false;
    let dispose: (() => Promise<void>) | null = null;

    void relayClient
      .subscribeLive(
        {
          kinds: [KIND_APPROVAL_REQUEST],
          "#p": audience,
          limit: 0,
          since: Math.floor(Date.now() / 1_000),
        },
        () => {
          void queryClient.invalidateQueries({
            queryKey: needsMeQueryKey(communityId, currentPubkey),
          });
        },
      )
      .then((unsubscribe) => {
        if (disposed) {
          void unsubscribe();
        } else {
          dispose = unsubscribe;
        }
      })
      .catch((error) => {
        console.error("Couldn’t subscribe to approval requests", error);
      });

    const unsubscribeReconnect = relayClient.subscribeToReconnects(() => {
      void queryClient.invalidateQueries({
        queryKey: needsMeQueryKey(communityId, currentPubkey),
      });
    });

    return () => {
      disposed = true;
      unsubscribeReconnect();
      if (dispose) void dispose();
    };
  }, [audience, communityId, currentPubkey, enabled, queryClient]);

  const local = localQuery.data ?? EMPTY_LOCAL;
  const data = query.data;
  const resolutionByToken = React.useMemo(
    () => buildResolutionMap(data?.resolutions ?? []),
    [data?.resolutions],
  );
  const locallyResolved = React.useMemo(
    () => new Set(local.resolved),
    [local.resolved],
  );
  const locallyResolving = React.useMemo(
    () => new Set(local.resolving),
    [local.resolving],
  );

  const items = React.useMemo<NeedsMeItem[]>(() => {
    if (!data) return [];
    const approvals = data.requests
      .map(parseNeedsMeApproval)
      .filter((a): a is NeedsMeApproval => a !== null);
    return approvals
      .map((approval) => ({
        ...approval,
        status: locallyResolving.has(approval.tokenHash)
          ? ("resolving" as const)
          : needsMeStatus(approval, resolutionByToken, locallyResolved),
      }))
      .sort((left, right) => right.createdAt - left.createdAt);
  }, [data, locallyResolving, locallyResolved, resolutionByToken]);

  /** Raw pending-request events, for merging into the home inbox feed. */
  const pendingRequestEvents = React.useMemo<RelayEvent[]>(() => {
    if (!data) return [];
    const pendingTokens = new Set(
      items
        .filter((item) => item.status === "pending")
        .map((item) => item.tokenHash),
    );
    return data.requests.filter((event) => {
      const approval = parseNeedsMeApproval(event);
      return approval !== null && pendingTokens.has(approval.tokenHash);
    });
  }, [data, items]);

  /** Requests resolved (granted/denied) — the inbox must not render them. */
  const resolvedEventIds = React.useMemo<Set<string>>(
    () =>
      new Set(
        items
          .filter(
            (item) => item.status === "granted" || item.status === "denied",
          )
          .map((item) => item.id),
      ),
    [items],
  );

  // `?? []`: cached local data written before the errors field existed must
  // not crash the surface (local query data persists per community session).
  const resolveErrors = React.useMemo(
    () =>
      new Map(
        (local.errors ?? []).map((entry) => [entry.tokenHash, entry.message]),
      ),
    [local.errors],
  );

  const clearResolveError = React.useCallback(
    (tokenHash: string) => {
      queryClient.setQueryData<NeedsMeLocalData>(
        needsMeLocalQueryKey(communityId, currentPubkey),
        (current) => ({
          resolving: current?.resolving ?? [],
          resolved: current?.resolved ?? [],
          errors: (current?.errors ?? []).filter(
            (entry) => entry.tokenHash !== tokenHash,
          ),
        }),
      );
    },
    [communityId, currentPubkey, queryClient],
  );

  return {
    items,
    pendingRequestEvents,
    resolvedEventIds,
    /** Inline publish-failure messages keyed by approval token hash. */
    resolveErrors,
    /** Clears a stale inline error so a retry starts clean. */
    clearResolveError,
    /** True once the bounded reads have completed at least once. */
    hasLoaded: data !== undefined,
    resolutionsComplete: data?.resolutionsComplete ?? true,
    refetch: query.refetch,
  };
}

export type ResolveApprovalInput = {
  tokenHash: string;
  approved: boolean;
};

function describeResolutionError(message: string): string {
  // The relay enforces owner-only approvers for NIP-ORG budget approvals
  // (command_executor.rs `check_budget_approver`); surface that rejection
  // instead of implying everyone can approve.
  if (/community owner/i.test(message)) {
    return "Only the community owner can resolve this approval.";
  }
  return message || "Relay rejected the approval.";
}

/**
 * Resolve an approval request through the same surface the CLI uses: a signed
 * kind:46030 (grant) / 46031 (deny) command event whose `d` tag repeats the
 * token hash. Optimistically marks the request resolved; a failed publish
 * rolls the row back to pending and surfaces the relay’s rejection.
 */
export function useResolveNeedsMeApproval(currentPubkey?: string) {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? null;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ tokenHash, approved }: ResolveApprovalInput) => {
      const event = await signRelayEvent({
        kind: approved ? KIND_APPROVAL_GRANT : KIND_APPROVAL_DENY,
        content: "",
        tags: [["d", tokenHash]],
      });
      return relayClient.publishEvent(
        event,
        "Timed out sending the approval.",
        "Failed to send the approval.",
      );
    },
    onMutate: async ({ tokenHash }) => {
      await queryClient.cancelQueries({
        queryKey: needsMeQueryKey(communityId, currentPubkey),
      });
      const localKey = needsMeLocalQueryKey(communityId, currentPubkey);
      const previous = queryClient.getQueryData<NeedsMeLocalData>(localKey);
      // A retry clears its own stale inline error; the rollback snapshot keeps
      // the previous error so a cancelled attempt restores it.
      queryClient.setQueryData<NeedsMeLocalData>(localKey, (current) => ({
        resolving: [...(current?.resolving ?? []), tokenHash],
        resolved: current?.resolved ?? [],
        errors: (current?.errors ?? []).filter(
          (entry) => entry.tokenHash !== tokenHash,
        ),
      }));
      return { previous, localKey };
    },
    onSuccess: (_result, { tokenHash }) => {
      const localKey = needsMeLocalQueryKey(communityId, currentPubkey);
      queryClient.setQueryData<NeedsMeLocalData>(localKey, (current) => ({
        resolving: (current?.resolving ?? []).filter((t) => t !== tokenHash),
        resolved: [...(current?.resolved ?? []), tokenHash],
        errors: current?.errors ?? [],
      }));
      void queryClient.invalidateQueries({
        queryKey: needsMeQueryKey(communityId, currentPubkey),
      });
    },
    onError: (error, { tokenHash }, context) => {
      // Roll the optimistic resolution back — the row returns to pending —
      // and surface the rejection INLINE on the approval card. Approval state
      // is visible on screen, so a toast would detach the failure from the
      // row the operator is acting on (design rule: no toasts for on-screen
      // state).
      const message = describeResolutionError(
        error instanceof Error ? error.message : String(error),
      );
      if (context) {
        queryClient.setQueryData<NeedsMeLocalData>(
          context.localKey,
          (current) => ({
            resolving: (current?.resolving ?? []).filter(
              (t) => t !== tokenHash,
            ),
            resolved: (current?.resolved ?? []).filter((t) => t !== tokenHash),
            errors: [
              ...(current?.errors ?? []).filter(
                (entry) => entry.tokenHash !== tokenHash,
              ),
              { tokenHash, message },
            ],
          }),
        );
      }
    },
  });
}
