/**
 * Running a template's plan: build each step's record, send it, and stop at the
 * first one the server refuses. Pure over its dependencies (the sender, the
 * clock, the id generator), so `run-plan.test.mjs` drives it under `node --test`
 * with a fake server.
 *
 * What exists afterwards is always a consistent prefix of the plan (the same
 * contract the command line keeps): a failure leaves every earlier step in
 * place, marks the rest "not attempted", and applying again resumes from the
 * server's own state, with no local journal to lose.
 */

import {
  buildStepEvent,
  canonicalChannelName,
  channelIdOf,
  describeStep,
  type EventDraft,
  type ExistingState,
  itemKey,
  type PlanStep,
} from "@creaton/core/templates/apply.ts";
import type { TemplateEntry } from "@creaton/core/templates/schema.ts";

/** How one step ended. */
export type StepStatus =
  | "created"
  /** The server already had it. */
  | "skipped"
  /** This app cannot do it; the command line can. */
  | "needs-cli"
  | "failed"
  | "not-attempted";

/** One line of the progress list. */
export interface StepResult {
  step: PlanStep;
  /** The step in words: "Create #writers-room". */
  label: string;
  status: StepStatus;
  /** Why a step failed, in words a person can act on. */
  message?: string;
}

/** What a run did. */
export interface RunReport {
  /** `done`: every step was created or skipped (or needs the command line). `partial`: a step failed. */
  status: "done" | "partial";
  results: StepResult[];
  /** Template channel id to the server's channel id, for every channel that exists afterwards. */
  channelIds: Record<string, string>;
}

export interface RunOptions {
  entry: TemplateEntry;
  plan: PlanStep[];
  existing: ExistingState;
  /** The signer, 64-hex. */
  me: string;
  /** Sign and send one record; throw with the server's reason when it refuses. */
  publish: (draft: EventDraft) => Promise<void>;
  /** Turn a refusal into words, given the step it came from. */
  explain: (step: PlanStep, error: unknown) => string;
  now?: () => number;
  newId?: () => string;
  /** Called after every step with the full list so far. */
  onProgress?: (results: StepResult[]) => void;
}

/** Run the plan. Never throws for a refused step; the report says what happened. */
export async function runPlan(options: RunOptions): Promise<RunReport> {
  const { entry, plan, existing, me, publish } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const newId = options.newId ?? (() => crypto.randomUUID());

  // Channels that already exist are found by name.
  const channelIds: Record<string, string> = {};
  for (const channel of entry.template.channels) {
    const found = existing.channels.get(canonicalChannelName(channel.name));
    if (found !== undefined) channelIds[channel.id] = found;
  }

  const results: StepResult[] = plan.map((step) => ({
    step,
    label: describeStep(entry, step),
    status: "not-attempted" as StepStatus,
  }));
  const report = (): RunReport => ({
    status: results.some((r) => r.status === "failed") ? "partial" : "done",
    results: results.map((r) => ({ ...r })),
    channelIds: { ...channelIds },
  });

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    if (step.action === "already-exists" || step.action === "unchanged") {
      results[i].status = "skipped";
      options.onProgress?.(results.map((r) => ({ ...r })));
      continue;
    }
    if (step.action === "needs-cli") {
      results[i].status = "needs-cli";
      options.onProgress?.(results.map((r) => ({ ...r })));
      continue;
    }
    try {
      const prior = existing.items.get(
        itemKey(step.kind, step.item),
      )?.createdAt;
      const draft = buildStepEvent(step, {
        entry,
        channelIds,
        me,
        now: now(),
        prior,
        newId,
      });
      await publish(draft);
      if (step.kind === "channel") channelIds[step.item] = channelIdOf(draft);
      results[i].status = "created";
    } catch (error) {
      results[i].status = "failed";
      results[i].message = options.explain(step, error);
      options.onProgress?.(results.map((r) => ({ ...r })));
      break;
    }
    options.onProgress?.(results.map((r) => ({ ...r })));
  }
  return report();
}
