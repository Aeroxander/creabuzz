import { useMutation, useQueryClient } from "@tanstack/react-query";

import { invokeTauri } from "@/shared/api/tauri";

import { orgQueryKey } from "./shared";

// ── Contribution classifier (buzz org contribute classify) ────────────────
//
// The desktop spawns the bundled `buzz` sidecar and returns structured
// results; the classifier API key never crosses the IPC boundary (it is
// passed only to the child process environment in Rust).

export type OrgClassifyResult = {
  mode: "preview" | "published";
  taskEventId: string;
  /** Validated draft content (preview mode only). */
  draft?: Record<string, unknown>;
  /** Published record event id (publish mode only). */
  eventId?: string;
};

export type OrgClassifyBatchTask = {
  status: "ok" | "skip" | "fail";
  detail: string;
  line: string;
};

export type OrgClassifyBatchResult = {
  ok: number;
  skipped: number;
  failed: number;
  tasks: OrgClassifyBatchTask[];
};

/** Single-task draft: preview (no confirm needed) or publish (confirm in UI). */
export function useOrgClassifyTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      taskEventId: string;
      publish: boolean;
    }): Promise<OrgClassifyResult> =>
      invokeTauri<OrgClassifyResult>("org_classify_task", {
        taskEventId: input.taskEventId,
        publish: input.publish,
      }),
    onSuccess: () => {
      // A published pending record should show up in the Contributions tab.
      void queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "contributions"],
      });
    },
  });
}

/** Batch: draft records for all done tasks that lack one (one LLM call each). */
export function useOrgClassifyAllDoneMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (limit?: number): Promise<OrgClassifyBatchResult> =>
      invokeTauri<OrgClassifyBatchResult>("org_classify_all_done", {
        limit: limit ?? null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...orgQueryKey, "contributions"],
      });
    },
  });
}
