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

import { useCallback, useEffect, useMemo, useState } from "react";

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
import { parseTask, type FleetTask } from "./use-agent-tasks";

export const KIND_GIT_STATUS_OPEN = 1630;
export const KIND_GIT_STATUS_MERGED = 1631;
export const KIND_GIT_STATUS_CLOSED = 1632;
export const KIND_GIT_STATUS_DRAFT = 1633;

export type WorkItemType = "task" | "issue";

export interface WorkItem {
  type: WorkItemType;
  id: string;
  title: string;
  description: string;
  status: string; // aligned vocabulary: open/assigned/in_progress/triage/needs_approval/done/closed/cancelled
  assignee: string | null;
  scope: string | null; // channel id (task) or repo a-tag (issue)
  scopeLabel: string | null;
  parentEventId: string | null;
  author: string;
  approver: string | null;
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

export function useWorkBoard(): {
  items: WorkItem[];
  loading: boolean;
  createTask: (input: {
    title: string;
    description?: string;
    assignee?: string;
    channelId?: string;
  }) => Promise<void>;
  requestApproval: (task: FleetTask) => Promise<void>;
  approve: (task: FleetTask) => Promise<void>;
  reject: (task: FleetTask) => Promise<void>;
} {
  const [tasks, setTasks] = useState<Record<string, WorkItem>>({});
  const [issues, setIssues] = useState<Record<string, WorkItem>>({});
  const [loading, setLoading] = useState(true);

  const upsertTask = useCallback((event: NostrEvent) => {
    const task = parseTask(event);
    if (!task) return;
    setTasks((prev) => {
      const existing = prev[task.id];
      if (existing && existing.updatedAt >= task.updatedAt) return prev;
      const item: WorkItem = {
        type: "task",
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        assignee: task.assignee,
        scope: task.channelId,
        scopeLabel: "channel",
        parentEventId: task.parentEventId,
        author: task.author,
        approver: taskApprover(event),
        updatedAt: task.updatedAt,
      };
      return { ...prev, [task.id]: item };
    });
  }, []);

  useEffect(() => {
    const wsUrl = relayWsUrl();
    let disposed = false;

    // --- fleet tasks (live + history) ---
    const taskUnsub = subscribeChannel(
      wsUrl,
      { kinds: [KIND_AGENT_TASK] } satisfies NostrFilter,
      { onEvent: (event) => upsertTask(event) },
    );

    // --- git issues + status events (history; live for issues too) ---
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
              title: event.content.split("\n")[0].slice(0, 140) || "Issue",
              description: event.content,
              status: "open",
              assignee: null,
              scope: getTag(event, "a") ?? null,
              scopeLabel: "repo",
              parentEventId: null,
              author: event.pubkey,
              approver: null,
              updatedAt: event.created_at * 1000,
            },
          }));
        },
      },
    );

    // --- one-shot history: tasks, issues, status events, approvals ---
    const load = async () => {
      try {
        const [taskEvents, issueEvents, statusEvents, approvalEvents] =
          await Promise.all([
            queryEvents(wsUrl, { kinds: [KIND_AGENT_TASK], limit: 200 }),
            queryEvents(wsUrl, { kinds: [KIND_GIT_ISSUE], limit: 200 }),
            queryEvents(wsUrl, {
              kinds: [
                KIND_GIT_STATUS_OPEN,
                KIND_GIT_STATUS_MERGED,
                KIND_GIT_STATUS_CLOSED,
                KIND_GIT_STATUS_DRAFT,
              ],
              limit: 400,
            }),
            queryEvents(wsUrl, { kinds: [46030, 46031], limit: 400 }).catch(
              () => [],
            ),
          ]);
        if (disposed) return;
        const approverByTask = new Map<string, string>();
        for (const approval of approvalEvents) {
          const target = approval.tags.find((t) => t[0] === "e")?.[1];
          if (!target) continue;
          approverByTask.set(target, approval.pubkey);
        }
        const tasksNext: Record<string, WorkItem> = {};
        for (const event of taskEvents) {
          const task = parseTask(event);
          if (!task) continue;
          const existing = tasksNext[task.id];
          if (existing && existing.updatedAt >= task.updatedAt) continue;
          tasksNext[task.id] = {
            type: "task",
            id: task.id,
            title: task.title,
            description: task.description,
            status: task.status,
            assignee: task.assignee,
            scope: task.channelId,
            scopeLabel: "channel",
            parentEventId: task.parentEventId,
            author: task.author,
            approver: null,
            updatedAt: task.updatedAt,
          };
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
            title: issue.content.split("\n")[0].slice(0, 140) || "Issue",
            description: issue.content,
            status,
            assignee: null,
            scope: getTag(issue as unknown as NostrEvent, "a") ?? null,
            scopeLabel: "repo",
            parentEventId: null,
            author: issue.pubkey,
            approver: null,
            updatedAt: issue.created_at * 1000,
          };
        }
        setIssues((prev) => ({ ...prev, ...issuesNext }));
        setLoading(false);
      } catch {
        if (!disposed) setLoading(false);
      }
    };
    void load();

    return () => {
      disposed = true;
      taskUnsub();
      issueUnsub();
    };
  }, [upsertTask]);

  const createTask = useCallback(
    async (input: {
      title: string;
      description?: string;
      assignee?: string;
      channelId?: string;
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

  const items = useMemo(
    () =>
      [...Object.values(tasks), ...Object.values(issues)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    [tasks, issues],
  );

  return { items, loading, createTask, requestApproval, approve, reject };
}
