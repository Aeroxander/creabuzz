/**
 * Where a decision stands, in words, and the one step (if any) anyone can take to move it along.
 *
 * Alias-free; `decision-stage.test.mjs` drives it under `node --test`.
 */

import type { Decision } from "@creaton/core/launchpad/decisions.ts";

/** A moment, as a short local date and time. */
export const when = (seconds: number | bigint): string =>
  new Date(Number(seconds) * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** A span of whole days, hours or minutes, in words. */
export function duration(seconds: bigint): string {
  const s = Number(seconds);
  if (s % 86_400 === 0) return `${s / 86_400} day${s === 86_400 ? "" : "s"}`;
  if (s % 3_600 === 0) return `${s / 3_600} hour${s === 3_600 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} minute${s === 60 ? "" : "s"}`;
  return `${s} seconds`;
}

export function decisionStage(
  decision: Decision,
  now: number,
): {
  label: string;
  tone: "open" | "good" | "wait" | "bad" | "done";
  next: string;
  step: "start" | "run" | null;
} {
  const delay = decision.rules?.delay ?? 0n;
  switch (decision.state) {
    case "Executed":
      return {
        label: "Done",
        tone: "done",
        next: "This decision was carried out.",
        step: null,
      };
    case "Expired":
      return {
        label: "Expired",
        tone: "bad",
        next: "It did not get enough support in time. Support you gave it is free again.",
        step: null,
      };
    case "Defeated":
      return {
        label: "Rejected",
        tone: "bad",
        next: "It was voted down.",
        step: null,
      };
    case "Queued":
      return {
        label: "Waiting to run",
        tone: "wait",
        next: `Approved. It can take effect at ${when(decision.queuedAt + Number(delay))}. Support must hold until then.`,
        step: null,
      };
    case "Succeeded":
      return decision.queuedAt === 0
        ? {
            label: "Approved",
            tone: "good",
            next: `It has enough support. Start the ${duration(delay)} wait, then it can take effect.`,
            step: "start",
          }
        : {
            label: "Ready to run",
            tone: "good",
            next: "The wait is over and support held. Anyone can run it now.",
            step: "run",
          };
    default:
      return {
        label: "Collecting support",
        tone: "open",
        next:
          decision.rules && now < Number(decision.rules.reviewEndsAt)
            ? `Nothing can take effect before ${when(decision.rules.reviewEndsAt)}, whatever the vote.`
            : "It needs enough support, and that support has to hold.",
        step: null,
      };
  }
}

/** A decision that can still change: it is gathering support, approved and waiting, or waiting to run. */
export function isLive(decision: Pick<Decision, "state">): boolean {
  return (
    decision.state === "Active" ||
    decision.state === "Succeeded" ||
    decision.state === "Queued"
  );
}
