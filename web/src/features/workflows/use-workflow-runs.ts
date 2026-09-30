/**
 * Community workflow run list: run state read from the server's authorized
 * run endpoints, with bounded polling (deadline + terminal paused state),
 * generation-fenced refreshes, and the approve/reject + retry command
 * events. Resolution failures keep the row actionable with an inline error —
 * the buttons double as the retry, matching the approvals inbox.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { queryEvents } from "@/shared/lib/nostr-client";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";
import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";
import { publishEvent } from "@/shared/lib/publish-event";
import {
  APPROVALS_LIMIT,
  KIND_WORKFLOW_DEF,
  RUNS_LIMIT,
  WORKFLOW_LIMIT,
  parseApprovalsResponse,
  parseRunsResponse,
  parseWorkflowDefinition,
  type RunApproval,
  type WorkflowRun,
  type WorkflowSummary,
} from "./lib/workflowRuns";
import { buildApprovalDecision, buildWorkflowTrigger } from "./lib/runActions";

/** Bounded polling: while runs are active, then paused with a manual retry. */
const POLL_MS = 10_000;
/** Auto-refresh runs at most this long; after it the panel offers Refresh. */
const POLL_DEADLINE_MS = 15 * 60_000;
/** Approval reads per refresh — only runs waiting on approval need them. */
const APPROVAL_FETCH_LIMIT = 8;

export type WorkflowRunItem = {
  run: WorkflowRun;
  workflow: WorkflowSummary;
  approvals: RunApproval[];
};

export type RunListState = {
  items: WorkflowRunItem[];
  loading: boolean;
  /** Last refresh failure; the snapshot on screen stays available. */
  error: string | null;
  /** True while a command publish is in flight, keyed by token or run id. */
  acting: ReadonlySet<string>;
  /** Inline publish failures keyed by token or run id. */
  errors: ReadonlyMap<string, string>;
  /** Auto-refresh paused at the polling deadline (Refresh stays available). */
  pollPaused: boolean;
  /** Approval tokens addressed to this session's user (decision gating). */
  myPendingTokens: ReadonlySet<string>;
  /** Tokens resolved by this session, so a row never resurrects. */
  locallyResolvedTokens: ReadonlySet<string>;
  approve: (tokenHash: string, approved: boolean) => Promise<void>;
  retryRun: (runId: string, workflowId: string) => Promise<void>;
  refresh: () => Promise<void>;
};

async function fetchRuns(workflowId: string): Promise<WorkflowRun[]> {
  const url = `${relayHttpBaseUrl()}/workflows/${encodeURIComponent(workflowId)}/runs?limit=${RUNS_LIMIT}`;
  const auth = await makeNip98AuthHeader(url, "GET");
  const response = await fetch(url, { headers: { Authorization: auth } });
  if (!response.ok) {
    throw new Error(`The server refused the run list (${response.status}).`);
  }
  return parseRunsResponse(await response.json(), workflowId);
}

async function fetchApprovals(
  workflowId: string,
  runId: string,
): Promise<RunApproval[]> {
  const url = `${relayHttpBaseUrl()}/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/approvals`;
  const auth = await makeNip98AuthHeader(url, "GET");
  const response = await fetch(url, { headers: { Authorization: auth } });
  if (!response.ok) {
    throw new Error(
      `The server refused the approval list (${response.status}).`,
    );
  }
  return parseApprovalsResponse(await response.json(), runId);
}

export function useWorkflowRuns(): RunListState {
  const me = existingUserPubkey();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [runsByWorkflow, setRunsByWorkflow] = useState<
    ReadonlyMap<string, WorkflowRun[]>
  >(() => new Map());
  const [approvalsByRun, setApprovalsByRun] = useState<
    ReadonlyMap<string, RunApproval[]>
  >(() => new Map());
  const [myPendingTokens, setMyPendingTokens] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [locallyResolved, setLocallyResolved] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [pollPaused, setPollPaused] = useState(false);
  // Generation fence: only the newest refresh may write state.
  const generationRef = useRef(0);
  const deadlineRef = useRef(Date.now() + POLL_DEADLINE_MS);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    deadlineRef.current = Date.now() + POLL_DEADLINE_MS;
    setPollPaused(false);
    try {
      const definitionEvents = await queryEvents(relayWsUrl(), {
        kinds: [KIND_WORKFLOW_DEF],
        limit: WORKFLOW_LIMIT,
      });
      const summaries = definitionEvents
        .map(parseWorkflowDefinition)
        .filter((w): w is WorkflowSummary => w !== null)
        .slice(0, WORKFLOW_LIMIT);
      if (generation !== generationRef.current) return;
      setWorkflows(summaries);

      // Per-workflow reads degrade individually: one bad workflow must not
      // blank the whole list.
      const runEntries = await Promise.all(
        summaries.map(async (workflow) => {
          try {
            return [workflow.id, await fetchRuns(workflow.id)] as const;
          } catch {
            return [workflow.id, [] as WorkflowRun[]] as const;
          }
        }),
      );
      if (generation !== generationRef.current) return;
      setRunsByWorkflow(new Map(runEntries));

      const waitingRuns = runEntries
        .flatMap(([workflowId, runs]) =>
          runs
            .filter((run) => run.status === "waiting_approval")
            .map((run) => ({ workflowId, run })),
        )
        .slice(0, APPROVAL_FETCH_LIMIT);
      const approvalEntries = await Promise.all(
        waitingRuns.map(async ({ workflowId, run }) => {
          try {
            return [run.id, await fetchApprovals(workflowId, run.id)] as const;
          } catch {
            return [run.id, [] as RunApproval[]] as const;
          }
        }),
      );
      if (generation !== generationRef.current) return;
      setApprovalsByRun((current) => {
        const next = new Map(current);
        for (const [runId, approvals] of approvalEntries) {
          next.set(runId, approvals);
        }
        return next;
      });

      // Which pending approvals are addressed to me (same query the
      // approvals inbox runs) — the decision affordance is gated on it.
      if (me) {
        try {
          const requests = await queryEvents(relayWsUrl(), {
            kinds: [46010],
            "#p": [me],
            limit: APPROVALS_LIMIT,
          });
          if (generation !== generationRef.current) return;
          const tokens = new Set<string>();
          for (const event of requests) {
            const token = event.tags.find((tag) => tag[0] === "d")?.[1];
            if (token) tokens.add(token);
          }
          setMyPendingTokens(tokens);
        } catch {
          // Degrade to status-only rows; the poll retries.
        }
      }
      setError(null);
    } catch {
      if (generation === generationRef.current) {
        setError(
          "Couldn’t load workflow runs. Check your connection, then refresh.",
        );
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (Date.now() >= deadlineRef.current) {
        setPollPaused(true);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const items = useMemo<WorkflowRunItem[]>(() => {
    const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const rows: WorkflowRunItem[] = [];
    for (const [workflowId, runs] of runsByWorkflow) {
      const workflow = byId.get(workflowId);
      if (!workflow) continue;
      for (const run of runs) {
        rows.push({
          run,
          workflow,
          approvals: approvalsByRun.get(run.id) ?? [],
        });
      }
    }
    return rows.sort((a, b) => b.run.createdAt - a.run.createdAt);
  }, [workflows, runsByWorkflow, approvalsByRun]);

  const setActingFor = useCallback((key: string, on: boolean) => {
    setActing((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const clearError = useCallback((key: string) => {
    setErrors((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  const publish = useCallback(
    async (
      key: string,
      template: { kind: number; content: string; tags: string[][] },
      onDone: () => void,
    ) => {
      setActingFor(key, true);
      clearError(key);
      try {
        const event = await signAsUser(template);
        const result = await publishEvent(relayWsUrl(), event, {
          signAuth: signAsUser,
        });
        if (!result.accepted) {
          throw new Error(result.message || "The server rejected the change.");
        }
        onDone();
        void refresh();
      } catch (error) {
        setErrors((current) =>
          new Map(current).set(
            key,
            error instanceof Error && error.message
              ? error.message
              : "Couldn’t send the change. Try again.",
          ),
        );
      } finally {
        setActingFor(key, false);
      }
    },
    [clearError, refresh, setActingFor],
  );

  /** Approve or reject one pending approval (kind:46030/46031, `d` = token). */
  const approve = useCallback(
    (tokenHash: string, approved: boolean) =>
      publish(tokenHash, buildApprovalDecision({ tokenHash, approved }), () =>
        setLocallyResolved((current) => {
          const next = new Set(current);
          next.add(tokenHash);
          return next;
        }),
      ),
    [publish],
  );

  /** User-initiated bounded retry: one new run, never an auto-retry loop. */
  const retryRun = useCallback(
    (runId: string, workflowId: string) =>
      publish(runId, buildWorkflowTrigger(workflowId), () => {}),
    [publish],
  );

  return {
    items,
    loading,
    error,
    acting,
    errors,
    pollPaused,
    myPendingTokens,
    locallyResolvedTokens: locallyResolved,
    approve,
    retryRun,
    refresh,
  };
}
