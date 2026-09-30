/**
 * Combined work board — one view over everything being worked on.
 *
 * Items: fleet tasks (kind:44011, channel/community scope) and git issues
 * (kind:1621, repo scope via the `a` tag). Status vocabulary is aligned:
 * tasks carry status in content (read-side LWW by d); issues derive status
 * from NIP-34 status events (1630 open, 1631 done, 1632 closed, 1633
 * triage) reduced the way the desktop does, plus label heuristics.
 *
 * Approvals reuse the workflow vocabulary: granting/denying a task's
 * approval publishes 46011/46012 with an e-tag to the task, plus a 44011
 * status row (done / closed) recording the approver.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "@/shared/ui/query-error";

import {
  queryEvents,
  type NostrFilter,
  type NostrEvent,
} from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { publishEvent } from "@/shared/lib/publish-event";
import { signAsUser, userPubkey } from "@/shared/lib/identity";
import { subscribeChannel } from "@/features/channels/subscribe-channel";
import { KIND_AGENT_TASK, KIND_GIT_ISSUE } from "@/shared/constants/kinds";
import {
  keepRecentRows,
  mergeTaskRows,
  type TaskRowEvent,
} from "./lib/task-planning";
import {
  parseTask,
  type FleetTask,
  type TaskPriority,
} from "./use-agent-tasks";

export const KIND_GIT_STATUS_OPEN = 1630;
export const KIND_GIT_STATUS_MERGED = 1631;
export const KIND_GIT_STATUS_CLOSED = 1632;
export const KIND_GIT_STATUS_DRAFT = 1633;

/** Board column -> NIP-34 status kind for issue moves. */
export const ISSUE_STATUS_KIND: Record<string, number> = {
  open: KIND_GIT_STATUS_OPEN,
  done: KIND_GIT_STATUS_MERGED,
  closed: KIND_GIT_STATUS_CLOSED,
  triage: KIND_GIT_STATUS_DRAFT,
};
export const ISSUE_MOVE_TARGETS = ["open", "done", "closed"];

export type WorkItemType = "task" | "issue";

export interface WorkItem {
  type: WorkItemType;
  /** Raw `d` tag (tasks) or event id (issues): used when publishing. */
  id: string;
  /** Author-qualified key for storage, React keys and drag payloads. */
  key: string;
  title: string;
  description: string;
  status: string; // aligned vocabulary: open/assigned/in_progress/triage/needs_approval/done/closed/cancelled
  assignee: string | null;
  scope: string | null; // channel id (task) or repo a-tag (issue)
  scopeLabel: string | null;
  parentEventId: string | null;
  author: string;
  approver: string | null;
  priority: TaskPriority;
  due: number | null;
  labels: string[];
  /** Milestone the task counts toward, or null (always null for issues). */
  milestone: string | null;
  /** Points the task earns once its contribution is accepted, or null. */
  reward: number | null;
  /** Who created the item: the task's first row signer, the issue author. */
  creator: string;
  /** Newest task row id — what a backing reaction points at (tasks only). */
  latestRowId: string | null;
  /** Row that marked the task done, while it is done (tasks only). */
  doneRowId: string | null;
  updatedAt: number;
}

interface GitIssue {
  id: string;
  content: string;
  tags: string[][];
  pubkey: string;
  created_at: number;
}

function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

function taskApprover(event: NostrEvent): string | null {
  try {
    const body = JSON.parse(event.content) as { approver?: string | null };
    return body.approver ?? null;
  } catch {
    return null;
  }
}

function repoOwnerFromAddress(repoAddress?: string): string | null {
  const owner = (repoAddress ?? "").split(":")[1] ?? "";
  return /^[a-fA-F0-9]{64}$/.test(owner) ? owner.toLowerCase() : null;
}

function issueStatus(
  issue: GitIssue,
  statusEvents: NostrEvent[],
): { status: string; approver: string | null } {
  const allowed = new Set([issue.pubkey.toLowerCase()]);
  const owner = repoOwnerFromAddress(
    getTag(issue as unknown as NostrEvent, "a"),
  );
  if (owner) allowed.add(owner);
  const latest = statusEvents
    .filter(
      (event) =>
        allowed.has(event.pubkey.toLowerCase()) &&
        event.tags.some((t) => t[0] === "e" && t[1] === issue.id),
    )
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (latest?.kind === KIND_GIT_STATUS_MERGED)
    return { status: "done", approver: null };
  if (latest?.kind === KIND_GIT_STATUS_CLOSED)
    return { status: "closed", approver: null };
  if (latest?.kind === KIND_GIT_STATUS_DRAFT)
    return { status: "triage", approver: null };
  const labels = issue.tags
    .filter((t) => t[0] === "t")
    .map((t) => t[1].toLowerCase());
  if (labels.includes("in-progress") || labels.includes("active")) {
    return { status: "in_progress", approver: null };
  }
  if (labels.includes("triage")) return { status: "triage", approver: null };
  return { status: "open", approver: null };
}

export function useWorkBoard(channels?: { id: string }[]): {
  items: WorkItem[];
  loading: boolean;
  createTask: (input: {
    title: string;
    description?: string;
    assignee?: string;
    channelId?: string;
    priority?: TaskPriority;
    due?: number | null;
    labels?: string[];
    milestone?: string | null;
    reward?: number | null;
  }) => Promise<void>;
  requestApproval: (task: FleetTask) => Promise<void>;
  approve: (task: FleetTask) => Promise<void>;
  reject: (task: FleetTask) => Promise<void>;
  setStatus: (task: FleetTask, status: string) => Promise<void>;
  publishIssueStatus: (issue: WorkItem, target: string) => Promise<void>;
  setAssignee: (task: FleetTask, assignee: string | null) => Promise<void>;
  /** Set when the relay read failed; the board shows a retry instead of "0 items". */
  loadError: unknown;
  /** Reason a secondary read failed, or null when everything loaded. */
  degraded: string | null;
  reload: () => void;
  updateTask: (
    task: FleetTask,
    patch: {
      description?: string;
      priority?: TaskPriority;
      due?: number | null;
      labels?: string[];
      title?: string;
      milestone?: string | null;
      reward?: number | null;
    },
  ) => Promise<void>;
} {
  const channelIds = useMemo(
    () => channels?.map((c) => c.id) ?? [],
    [channels],
  );
  const [tasks, setTasks] = useState<Record<string, WorkItem>>({});
  const [issues, setIssues] = useState<Record<string, WorkItem>>({});
  const [loading, setLoading] = useState(true);
  /** Kept so the board can say a load failed instead of rendering "0 items". */
  const [loadError, setLoadError] = useState<unknown>(null);
  /** Secondary reads that failed: the board shows a note instead of hiding it. */
  const [degraded, setDegraded] = useState<string | null>(null);
  const latestStatus = useRef(new Map<string, NostrEvent>());
  const loadStarted = useRef(false);
  /** Bumped by `reload` to re-run the loader effect. */
  const [reloadToken, setReloadToken] = useState(0);

  // Track the newest status event per issue; recompute the issue's status.
  const upsertIssueStatus = useCallback((event: NostrEvent) => {
    const target = event.tags.find((t) => t[0] === "e")?.[1];
    if (!target) return;
    setIssues((prev) => {
      const item = prev[target];
      if (!item) return prev;
      const current = latestStatus.current.get(target);
      if (current && current.created_at > event.created_at) return prev;
      latestStatus.current.set(target, event);
      const next: WorkItem = { ...item };
      if (event.kind === KIND_GIT_STATUS_MERGED) next.status = "done";
      else if (event.kind === KIND_GIT_STATUS_CLOSED) next.status = "closed";
      else if (event.kind === KIND_GIT_STATUS_DRAFT) next.status = "triage";
      return { ...prev, [target]: next };
    });
  }, []);

  // Every row of every task, by `d`. The item is re-merged from all of a
  // task's rows (`mergeTaskRows`): arrival order never matters (history after
  // live cannot resurrect a stale status), and a writer that omits a field —
  // the fleet worker's `{title, status}` pickup row — cannot erase it.
  const rowsByTask = useRef(new Map<string, NostrEvent[]>());

  const taskItemFromRows = useCallback((d: string): WorkItem | null => {
    const rows = rowsByTask.current.get(d) ?? [];
    const merged = mergeTaskRows(rows as TaskRowEvent[]);
    if (!merged) return null;
    const newest = merged.event as NostrEvent;
    const task = parseTask(newest);
    if (!task) return null;
    // Never lose the thread link: newer rows keep it, and a row that drops
    // the e-tag falls back to the newest row that carried one.
    const parent =
      task.parentEventId ??
      [...rows]
        .reverse()
        .find((row) => getTag(row, "e"))
        ?.tags.find((t) => t[0] === "e")?.[1] ??
      null;
    return {
      type: "task",
      id: task.id,
      // Stable across updates by other people: keyed by the task's creator.
      key: `${merged.creator}:${task.id}`,
      title: task.title,
      description: task.description,
      status: task.status,
      assignee: task.assignee,
      scope: task.channelId,
      scopeLabel: "channel",
      parentEventId: parent,
      author: task.author,
      priority: task.priority,
      due: task.due,
      labels: task.labels,
      milestone: task.milestone,
      reward: task.reward,
      creator: merged.creator,
      latestRowId: merged.latestRowId,
      doneRowId: merged.doneRowId,
      approver: taskApprover(newest),
      updatedAt: task.updatedAt,
    };
  }, []);

  /** Record rows (bounded per task) and return the task ids they touched. */
  const ingestTaskRows = useCallback((events: readonly NostrEvent[]) => {
    const touched = new Set<string>();
    for (const event of events) {
      const d = getTag(event, "d");
      if (!d) continue;
      const rows = rowsByTask.current.get(d) ?? [];
      rowsByTask.current.set(
        d,
        keepRecentRows([...rows, event] as TaskRowEvent[]) as NostrEvent[],
      );
      touched.add(d);
    }
    return touched;
  }, []);

  const upsertTask = useCallback(
    (event: NostrEvent) => {
      for (const d of ingestTaskRows([event])) {
        const item = taskItemFromRows(d);
        if (item) setTasks((prev) => ({ ...prev, [d]: item }));
      }
    },
    [ingestTaskRows, taskItemFromRows],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` is a restart key — bumping it must re-run this effect even though the body reads only refs and setters.
  useEffect(() => {
    const wsUrl = relayWsUrl();
    let disposed = false;
    const cleanups: (() => void)[] = [];

    // --- fleet tasks (live + history) ---
    // Global sub for scope-less rows + one per channel: the relay walls
    // channel-scoped events off from global subscriptions, so drops on
    // channel-tied tasks must be delivered per-channel or the board never
    // re-renders.
    const taskUnsub = subscribeChannel(
      wsUrl,
      { kinds: [KIND_AGENT_TASK] } satisfies NostrFilter,
      { onEvent: (event) => upsertTask(event) },
    );
    cleanups.push(taskUnsub);
    for (const channel of channelIds) {
      cleanups.push(
        subscribeChannel(
          wsUrl,
          { kinds: [KIND_AGENT_TASK], "#h": [channel] } satisfies NostrFilter,
          { onEvent: (event) => upsertTask(event) },
        ),
      );
    }

    // --- git issues + status events (history; live for issues + statuses) ---
    cleanups.push(
      subscribeChannel(
        wsUrl,
        {
          kinds: [
            KIND_GIT_STATUS_OPEN,
            KIND_GIT_STATUS_MERGED,
            KIND_GIT_STATUS_CLOSED,
            KIND_GIT_STATUS_DRAFT,
          ],
        } satisfies NostrFilter,
        { onEvent: (event) => upsertIssueStatus(event) },
      ),
    );
    const issueUnsub = subscribeChannel(
      wsUrl,
      { kinds: [KIND_GIT_ISSUE] } satisfies NostrFilter,
      {
        onEvent: (event) => {
          setIssues((prev) => ({
            ...prev,
            [event.id]: {
              type: "issue",
              id: event.id,
              key: event.id,
              title: event.content.split("\n")[0].slice(0, 140) || "Issue",
              description: event.content,
              status: "open",
              assignee: null,
              scope: getTag(event, "a") ?? null,
              scopeLabel: "repo",
              parentEventId: null,
              author: event.pubkey,
              approver: null,
              priority: "normal",
              due: null,
              labels: [],
              milestone: null,
              reward: null,
              creator: event.pubkey,
              latestRowId: null,
              doneRowId: null,
              updatedAt: event.created_at * 1000,
            },
          }));
        },
      },
    );

    // --- one-shot history: tasks, issues, status events, approvals ---
    // A new effect run (including a `reload`) loads once from scratch.
    loadStarted.current = false;
    const load = async () => {
      if (loadStarted.current) return;
      loadStarted.current = true;
      if (!disposed) {
        setLoading(true);
        setLoadError(null);
      }
      // The board's own content must not be faked: a refused task or issue
      // query fails the load so the view can offer a retry. Status and approval
      // reads are secondary — losing them degrades detail, not the item list —
      // so they are recorded and surfaced rather than silently dropped.
      let degraded: string | null = null;
      const optional = (error: unknown) => {
        degraded ??= errorMessage(error);
        return [];
      };
      try {
        const taskEvents = await queryEvents(wsUrl, {
          kinds: [KIND_AGENT_TASK],
          limit: 200,
        });
        const issueEvents = await queryEvents(wsUrl, {
          kinds: [KIND_GIT_ISSUE],
          limit: 200,
        });
        const { queryEventsHttp } = await import("@/shared/lib/http-query");
        const statusEvents = await queryEventsHttp([
          {
            kinds: [
              KIND_GIT_STATUS_OPEN,
              KIND_GIT_STATUS_MERGED,
              KIND_GIT_STATUS_CLOSED,
              KIND_GIT_STATUS_DRAFT,
            ],
            limit: 400,
          },
        ]).catch(optional);
        const approvalEvents = await queryEvents(wsUrl, {
          kinds: [46030, 46031],
          limit: 400,
        }).catch(optional);
        if (disposed) return;
        setDegraded(degraded);
        const approverByTask = new Map<string, string>();
        for (const approval of approvalEvents) {
          const target = approval.tags.find((t) => t[0] === "e")?.[1];
          if (!target) continue;
          approverByTask.set(target, approval.pubkey);
        }
        const tasksNext: Record<string, WorkItem> = {};
        for (const d of ingestTaskRows(taskEvents)) {
          const item = taskItemFromRows(d);
          if (item) tasksNext[d] = item;
        }
        setTasks((prev) => ({ ...prev, ...tasksNext }));

        const issueMap: Record<string, GitIssue> = {};
        for (const event of issueEvents) {
          issueMap[event.id] = {
            id: event.id,
            content: event.content,
            tags: event.tags,
            pubkey: event.pubkey,
            created_at: event.created_at,
          };
        }
        const issuesNext: Record<string, WorkItem> = {};
        for (const issue of Object.values(issueMap)) {
          const { status } = issueStatus(issue, statusEvents);
          issuesNext[issue.id] = {
            type: "issue",
            id: issue.id,
            // Event ids are globally unique already.
            key: issue.id,
            title: issue.content.split("\n")[0].slice(0, 140) || "Issue",
            description: issue.content,
            status,
            assignee: null,
            scope: getTag(issue as unknown as NostrEvent, "a") ?? null,
            scopeLabel: "repo",
            parentEventId: null,
            author: issue.pubkey,
            approver: null,
            priority: "normal",
            due: null,
            labels: [],
            milestone: null,
            reward: null,
            creator: issue.pubkey,
            latestRowId: null,
            doneRowId: null,
            updatedAt: issue.created_at * 1000,
          };
        }
        setIssues((prev) => ({ ...prev, ...issuesNext }));
        if (!disposed) setLoadError(null);
        setLoading(false);
      } catch (err) {
        console.error("[workboard] load failed", err);
        if (!disposed) {
          setLoadError(err);
          setLoading(false);
        }
      }
    };
    void load();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      issueUnsub();
    };
  }, [
    upsertTask,
    upsertIssueStatus,
    ingestTaskRows,
    taskItemFromRows,
    channelIds,
    reloadToken,
  ]);

  const createTask = useCallback(
    async (input: {
      title: string;
      description?: string;
      assignee?: string;
      channelId?: string;
      priority?: TaskPriority;
      due?: number | null;
      labels?: string[];
      milestone?: string | null;
      reward?: number | null;
    }) => {
      const id =
        "task-" +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 6);
      const tags: string[][] = [["d", id]];
      if (input.assignee) tags.push(["p", input.assignee]);
      if (input.channelId) tags.push(["h", input.channelId]);
      const signed = await signAsUser({
        kind: KIND_AGENT_TASK,
        tags,
        content: JSON.stringify({
          title: input.title,
          description: input.description ?? "",
          status: input.assignee ? "assigned" : "open",
          priority: input.priority ?? "normal",
          due: input.due ?? null,
          labels: input.labels ?? [],
          milestone: input.milestone ?? null,
          reward: input.reward ?? null,
        }),
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted)
        throw new Error(result.message ?? "task publish rejected");
    },
    [],
  );

  const publishTaskRow = useCallback(
    async (task: FleetTask, status: string, approver: string | null) => {
      const tags: string[][] = [
        ["d", task.id],
        ["p", task.assignee ?? approver ?? task.author],
      ];
      if (task.channelId) tags.push(["h", task.channelId]);
      if (task.parentEventId) tags.push(["e", task.parentEventId]);
      const signed = await signAsUser({
        kind: KIND_AGENT_TASK,
        tags,
        content: JSON.stringify({
          title: task.title,
          description: task.description,
          status,
          approver,
          priority: task.priority,
          due: task.due,
          labels: task.labels,
          milestone: task.milestone,
          reward: task.reward,
          _taskId: task.id,
        }),
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted)
        throw new Error(result.message ?? "task update rejected");
    },
    [],
  );

  const requestApproval = useCallback(
    async (task: FleetTask) => {
      await publishTaskRow(task, "needs_approval", null);
    },
    [publishTaskRow],
  );

  // Approval = the approver writes the outcome row (done/closed) with
  // attribution. The workflow command kinds (46030/46031) need relay-side
  // command plumbing (deferred).
  const approve = useCallback(
    async (task: FleetTask) => {
      await publishTaskRow(task, "done", userPubkey());
    },
    [publishTaskRow],
  );

  const reject = useCallback(
    async (task: FleetTask) => {
      await publishTaskRow(task, "closed", userPubkey());
    },
    [publishTaskRow],
  );

  // Board actions: status/assignee/field updates publish a fresh LWW row.
  const setStatus = useCallback(
    async (task: FleetTask, status: string) => {
      await publishTaskRow(task, status, null);
    },
    [publishTaskRow],
  );

  const setAssignee = useCallback(
    async (task: FleetTask, assignee: string | null) => {
      await publishTaskRow(
        { ...task, assignee },
        // Assigning transitions open -> assigned; unassigning returns to open.
        assignee ? "assigned" : "open",
        null,
      );
    },
    [publishTaskRow],
  );

  const updateTask = useCallback(
    async (
      task: FleetTask,
      patch: {
        description?: string;
        priority?: TaskPriority;
        due?: number | null;
        labels?: string[];
        title?: string;
        milestone?: string | null;
        reward?: number | null;
      },
    ) => {
      await publishTaskRow(
        {
          ...task,
          title: patch.title ?? task.title,
          description: patch.description ?? task.description,
          priority: patch.priority ?? task.priority,
          due: patch.due !== undefined ? patch.due : task.due,
          labels: patch.labels !== undefined ? patch.labels : task.labels,
          milestone:
            patch.milestone !== undefined ? patch.milestone : task.milestone,
          reward: patch.reward !== undefined ? patch.reward : task.reward,
        },
        task.status,
        null,
      );
    },
    [publishTaskRow],
  );

  // NIP-34: publish a status event targeting the issue. Allowed targets map
  // to the status kinds (open/done/closed); other columns are no-ops.
  const publishIssueStatus = useCallback(
    async (issue: WorkItem, target: string) => {
      const kind = ISSUE_STATUS_KIND[target];
      if (!kind) return;
      const signed = await signAsUser({
        kind,
        tags: [["e", issue.id]],
        content: "",
      });
      const result = await publishEvent(relayWsUrl(), signed, {
        signAuth: signAsUser,
      });
      if (!result.accepted) {
        throw new Error(result.message ?? "issue status rejected");
      }
    },
    [],
  );

  const items = useMemo(
    () =>
      [...Object.values(tasks), ...Object.values(issues)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    [tasks, issues],
  );

  return {
    items,
    loading,
    loadError,
    degraded,
    reload: () => setReloadToken((token) => token + 1),
    createTask,
    requestApproval,
    approve,
    reject,
    setStatus,
    publishIssueStatus,
    setAssignee,
    updateTask,
  };
}
