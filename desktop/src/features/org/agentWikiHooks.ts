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
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { invokeTauri } from "@/shared/api/tauri";

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
