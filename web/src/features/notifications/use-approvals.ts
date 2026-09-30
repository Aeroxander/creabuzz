/**
 * Approval inbox state: kind:46010 requests addressed to the current user
 * (budget overruns + workflow), with resolution status and approve/reject
 * actions that publish kind:46030/46031 command events.
 *
 * Freshness: bounded polling (the server does not fan out `#p` filters to
 * live subscriptions), with each refresh generation-fenced so a slow response
 * never overwrites a newer one. Resolution failures roll back to pending and
 * surface an inline retry — never a dead end.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";
import { publishEvent } from "@/shared/lib/publish-event";
import {
  APPROVALS_REQUEST_LIMIT,
  KIND_APPROVAL_DENY,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_REQUEST,
  approvalStatus,
  buildResolutionMap,
  parseApprovalRequest,
  parseApprovalResolution,
  type ApprovalRequest,
  type ApprovalResolution,
  type ApprovalStatus,
} from "./lib/approvals";

const POLL_MS = 15_000;

export type ApprovalItem = ApprovalRequest & { status: ApprovalStatus };

export function useApprovals(): {
  items: ApprovalItem[];
  resolving: ReadonlySet<string>;
  /** Inline publish-failure messages keyed by approval token hash. */
  errors: ReadonlyMap<string, string>;
  resolve: (tokenHash: string, approved: boolean) => Promise<void>;
  /** Clears a stale inline error so a retry starts clean. */
  clearError: (tokenHash: string) => void;
} {
  const me = existingUserPubkey();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [resolutions, setResolutions] = useState<ApprovalResolution[]>([]);
  const [localResolved, setLocalResolved] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [resolving, setResolving] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  // Generation fence: a refresh response is applied only when it is still the
  // newest request (rule: fence async results by generation).
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!me) return;
    const generation = ++generationRef.current;
    try {
      const requestEvents = await queryEvents(relayWsUrl(), {
        kinds: [KIND_APPROVAL_REQUEST],
        "#p": [me],
        limit: APPROVALS_REQUEST_LIMIT,
      });
      const parsed = requestEvents
        .map(parseApprovalRequest)
        .filter((r): r is ApprovalRequest => r !== null);
      const tokenHashes = [...new Set(parsed.map((r) => r.tokenHash))];
      let parsedResolutions: ApprovalResolution[] = [];
      if (tokenHashes.length > 0) {
        // A failed resolution read degrades (rows stay pending) rather than
        // failing the whole surface.
        try {
          const resolutionEvents = await queryEvents(relayWsUrl(), {
            kinds: [KIND_APPROVAL_GRANT, KIND_APPROVAL_DENY],
            "#d": tokenHashes,
            limit: tokenHashes.length * 2,
          });
          parsedResolutions = resolutionEvents
            .map(parseApprovalResolution)
            .filter((r): r is ApprovalResolution => r !== null);
        } catch {
          parsedResolutions = [];
        }
      }
      if (generation !== generationRef.current) return;
      setRequests(parsed);
      setResolutions(parsedResolutions);
    } catch {
      // Keep the last good snapshot on screen; the poll will try again.
    }
  }, [me]);

  useEffect(() => {
    if (!me) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [me, refresh]);

  const resolutionByToken = useMemo(
    () => buildResolutionMap(resolutions),
    [resolutions],
  );

  const items = useMemo<ApprovalItem[]>(
    () =>
      requests
        .map((request) => ({
          ...request,
          status: resolving.has(request.tokenHash)
            ? ("resolving" as const)
            : approvalStatus(request, resolutionByToken, localResolved),
        }))
        .sort((left, right) => right.createdAt - left.createdAt),
    [requests, resolutionByToken, localResolved, resolving],
  );

  const clearError = useCallback((tokenHash: string) => {
    setErrors((current) => {
      if (!current.has(tokenHash)) return current;
      const next = new Map(current);
      next.delete(tokenHash);
      return next;
    });
  }, []);

  /**
   * Resolve a request through the same command surface the CLI uses: a signed
   * kind:46030 (grant) / 46031 (deny) event whose `d` tag repeats the token
   * hash. Optimistic while in flight; on failure the row returns to pending
   * with an inline error and the buttons stay available as the retry.
   */
  const resolve = useCallback(
    async (tokenHash: string, approved: boolean) => {
      setResolving((current) => new Set(current).add(tokenHash));
      setErrors((current) => {
        if (!current.has(tokenHash)) return current;
        const next = new Map(current);
        next.delete(tokenHash);
        return next;
      });
      try {
        const event = await signAsUser({
          kind: approved ? KIND_APPROVAL_GRANT : KIND_APPROVAL_DENY,
          content: "",
          tags: [["d", tokenHash]],
        });
        const result = await publishEvent(relayWsUrl(), event);
        if (!result.accepted) {
          throw new Error(
            result.message || "The server rejected the decision.",
          );
        }
        setLocalResolved((current) => {
          const next = new Set(current);
          next.add(tokenHash);
          return next;
        });
        void refresh();
      } catch (error) {
        setErrors((current) =>
          new Map(current).set(
            tokenHash,
            error instanceof Error && error.message
              ? error.message
              : "Couldn’t send the decision. Try again.",
          ),
        );
      } finally {
        setResolving((current) => {
          const next = new Set(current);
          next.delete(tokenHash);
          return next;
        });
      }
    },
    [refresh],
  );

  return { items, resolving, errors, resolve, clearError };
}
