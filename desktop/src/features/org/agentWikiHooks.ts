/**
 * Agent Wiki distill mutation — the "Distill now" drive for
 * `buzz agwiki distill --publish` through the bundled `buzz` sidecar.
 *
 * IPC contract (mirrors the `org_classify_task` / `team_run` sidecar pattern
 * in desktop/src-tauri/src/commands/org_classify.rs and commands/team.rs):
 *
 *   invokeTauri("agwiki_distill", { space }) -> { ok, stdout, stderr }
 *
 * The command spawns `buzz agwiki distill --space <space> --publish` with the
 * classify sidecar's env contract (BUZZ_RELAY_URL from the active workspace
 * override, BUZZ_PRIVATE_KEY from the keyring, BUZZ_CLASSIFIER_API_URL /
 * _API_KEY / _MODEL passed through). Missing classifier URL/key is rejected
 * up front with the same error strings as `org_classify_task` ("… is not
 * configured") and surfaced inline unchanged. The command enforces a hard
 * 180 s wall-clock timeout and kills the child process tree when it fires
 * (rejecting with "distill timed out after 180s and was stopped", the same
 * format as org_classify's timeout).
 *
 * The JS race below is a second fence for a hung IPC channel; it cannot kill
 * the process itself — the sidecar command owns the process-tree kill.
 *
 * Terminal outcomes are DATA, not rejections: "nothing new" is explicitly not
 * an error, so the mutation resolves the outcome union
 * (published | nothing-new | timeout | failed) and the UI renders each
 * distinctly. Rejected invocations are classified through the same pure seam;
 * no failure is swallowed — `failed` always carries a bounded inline message.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useChannelsQuery } from "@/features/channels/hooks";
import {
  allWorkflowsQueryKey,
  workflowListFocusRefetchPolicy,
} from "@/features/workflows/hooks";
import { invokeTauri } from "@/shared/api/tauri";
import {
  createWorkflow,
  deleteWorkflow,
  getChannelsWorkflows,
} from "@/shared/api/tauriWorkflows";
import type { Workflow } from "@/shared/api/types";

import { orgQueryKey } from "./hooks";
import {
  AGENT_WIKI_STANDUP_D,
  AGENT_WIKI_DISTILL_TIMEOUT_SECONDS,
  classifyAgentWikiDistillError,
  classifyAgentWikiDistillRun,
  parseAgentWikiD,
  type AgentWikiDistillOutcome,
  type AgentWikiDistillRun,
} from "./lib/agentWiki";
import {
  SELF_MAINTENANCE_NO_CHANNEL_COPY,
  agentWikiSelfMaintenanceYaml,
  findSelfMaintenanceWorkflow,
  selfMaintenanceErrorMessage,
  selfMaintenanceScheduleLabel,
  type SelfMaintenanceAction,
} from "./lib/agentWikiSelfMaintenance";

/** JS-side fence for a hung IPC channel; the sidecar owns the process kill. */
export const AGENT_WIKI_DISTILL_TIMEOUT_MS =
  AGENT_WIKI_DISTILL_TIMEOUT_SECONDS * 1000;

// Same string format the sidecar contract uses for its own timeout rejection
// (mirrors desktop/src-tauri/src/commands/org_classify.rs), so one predicate
// classifies both fences as `timeout`.
const TIMEOUT_ERROR_TEXT = `distill timed out after ${AGENT_WIKI_DISTILL_TIMEOUT_SECONDS}s and was stopped`;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(TIMEOUT_ERROR_TEXT)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one `buzz agwiki distill --publish` round and surface its terminal
 * outcome. On `published`, the wiki queries are refetched so the rewritten
 * standup appears immediately.
 */
export function useAgentWikiDistillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<AgentWikiDistillOutcome> => {
      const space = parseAgentWikiD(AGENT_WIKI_STANDUP_D)?.space ?? "default";
      try {
        const run = await withTimeout(
          invokeTauri<AgentWikiDistillRun>("agwiki_distill", { space }),
          AGENT_WIKI_DISTILL_TIMEOUT_MS,
        );
        return classifyAgentWikiDistillRun(run);
      } catch (error) {
        return classifyAgentWikiDistillError(errorText(error));
      }
    },
    onSuccess: (outcome) => {
      if (outcome.status !== "published") return;
      void queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "agent-wiki"],
      });
      void queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "agent-wiki-page"],
      });
    },
  });
}

// ── Self-maintenance (scheduled distill) toggle ──────────────────────────────
//
// The distill loop runs as the `distill_agent_wiki` workflow action on the
// relay's cron scheduler; the workflow itself IS the toggle (docs/agent-wiki.md
// § Self-maintenance). These hooks drive the desktop's EXISTING workflow
// commands — `create_workflow` / `delete_workflow` (desktop/src-tauri/src/
// commands/workflows.rs, the same surface the Workflows screen's dialog uses)
// — with the pinned YAML from lib/agentWikiSelfMaintenance.ts. No sidecar, no
// new command.

/** Channels that can host the workflow (creation is channel-scoped). */
export type SelfMaintenanceHostChannel = { id: string; name: string };

export type SelfMaintenanceState = {
  /** True while the channel list or the workflow scan is still loading. */
  isPending: boolean;
  /** True when either read failed — the row must NOT claim "off" then. */
  isError: boolean;
  /** Bounded read-failure detail; null when no read failed. */
  errorMessage: string | null;
  /** Member channels eligible to host the workflow, name-sorted. */
  hostChannels: SelfMaintenanceHostChannel[];
  /** The detected `agwiki-nightly` `distill_agent_wiki` workflow, if any. */
  workflow: Workflow | null;
  enabled: boolean;
  /** Human schedule from the workflow's own trigger; null when not derivable. */
  schedule: string | null;
  /** Name of the channel hosting the workflow; null when unknown. */
  hostChannelName: string | null;
};

/**
 * Is the documented `agwiki-nightly` `distill_agent_wiki` workflow present?
 *
 * Reads through the Workflows UI's own surface: one batched
 * `get_channels_workflows` call across the user's member channels (exactly
 * what WorkflowsView runs to list "all workflows"), keyed under the
 * `workflows-all` family so every workflow mutation's list invalidation
 * refreshes this scan too. The extra `agwiki-self-maintenance` leaf keeps this
 * entry's `Workflow[]` shape from colliding with WorkflowsView's
 * channel-annotated entry at the parent key.
 */
export function useSelfMaintenanceState(): SelfMaintenanceState {
  const channelsQuery = useChannelsQuery();
  const hostChannels = React.useMemo(
    () =>
      (channelsQuery.data ?? [])
        .filter((channel) => channel.isMember)
        .map((channel) => ({ id: channel.id, name: channel.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channelsQuery.data],
  );
  const channelIds = React.useMemo(
    () => hostChannels.map((channel) => channel.id),
    [hostChannels],
  );
  const channelIdKey = channelIds.join(",");

  const workflowsQuery = useQuery({
    queryKey: [
      ...allWorkflowsQueryKey(channelIdKey),
      "agwiki-self-maintenance",
    ],
    queryFn: () => getChannelsWorkflows(channelIds),
    enabled: channelIds.length > 0,
    ...workflowListFocusRefetchPolicy,
  });

  const workflow = findSelfMaintenanceWorkflow(workflowsQuery.data ?? []);
  const readError = workflowsQuery.error ?? channelsQuery.error ?? null;
  return {
    isPending:
      channelsQuery.isPending ||
      (channelIds.length > 0 && workflowsQuery.isPending),
    isError: readError !== null,
    errorMessage:
      readError === null ? null : selfMaintenanceErrorMessage(readError),
    hostChannels,
    workflow,
    enabled: workflow !== null,
    schedule: workflow
      ? selfMaintenanceScheduleLabel(workflow.definition)
      : null,
    hostChannelName: workflow?.channelId
      ? (hostChannels.find((channel) => channel.id === workflow.channelId)
          ?.name ?? null)
      : null,
  };
}

/**
 * One-click enable/disable of the scheduled distill.
 *
 * enable → `create_workflow` with the documented workflow verbatim (pinned in
 * lib/agentWikiSelfMaintenance.ts); disable → `delete_workflow` for the
 * detected workflow. Rule 1: a rejected command surfaces inline as the
 * command's own bounded error excerpt (mutation.error.message) — never a
 * silent success. Success invalidates the whole workflow list family (the
 * same predicate as the Workflows screen's mutations), which refreshes both
 * the Workflows screen and {@link useSelfMaintenanceState}'s scan.
 */
export function useSelfMaintenanceMutation(
  hostChannelId: string | null,
  workflowId: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: SelfMaintenanceAction,
    ): Promise<SelfMaintenanceAction> => {
      try {
        if (action === "enable") {
          if (!hostChannelId) throw new Error(SELF_MAINTENANCE_NO_CHANNEL_COPY);
          await createWorkflow(hostChannelId, agentWikiSelfMaintenanceYaml());
        } else {
          if (!workflowId) {
            throw new Error("no scheduled distill workflow to disable");
          }
          await deleteWorkflow(workflowId);
        }
        return action;
      } catch (error) {
        // Normalize to a bounded display string; the raw command error text is
        // preserved up to the excerpt cap (see selfMaintenanceErrorMessage).
        throw new Error(selfMaintenanceErrorMessage(error));
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "workflows" ||
          query.queryKey[0] === "workflows-all",
      });
    },
  });
}
