/**
 * Plain-language copy for the auction deploy and graduation panels: the step
 * markers and status text, and the failure message. Pure so `node --test`
 * binds it (`auction-copy.test.mjs`); the panels only render what this returns.
 *
 * The failure message follows the ported desktop rule (Review-Proven Rule 1 —
 * a caught failure must say what happened and what to do): exact step,
 * transaction, outcome, completed work, and the retry action.
 */
import {
  AUCTION_DEPLOY_STEP_LABELS,
  AUCTION_DEPLOY_STEPS,
  type AuctionDeployState,
  type AuctionDeployStepState,
} from "./auctionFlow.ts";
import type { GraduationStepStatus } from "./graduationFlow.ts";

/** One-character marker for a step row (decorative; the text carries meaning). */
export function stepMarker(
  status: AuctionDeployStepState["status"] | GraduationStepStatus,
): string {
  switch (status) {
    case "running":
    case "active":
      return "…";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "skipped":
      return "–";
    default:
      return "○";
  }
}

/** Status words for a deploy step row. `short` shortens a transaction hash. */
export function deployStepStatusText(
  step: AuctionDeployStepState,
  short: (hash: string) => string,
): string {
  switch (step.status) {
    case "running":
      return "In progress…";
    case "failed":
      return "Failed";
    case "skipped":
      return "Not part of this launch (community track).";
    case "done":
      if (step.alreadyDeployed) return "Done (already deployed)";
      return step.txHash ? `Confirmed ${short(step.txHash)}` : "Done";
    default:
      return "Pending";
  }
}

/** Status words for a graduation step row. */
export function graduationStepStatusText(status: GraduationStepStatus): string {
  switch (status) {
    case "active":
      return "In progress…";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "skipped":
      return "Not planned";
    default:
      return "Pending";
  }
}

/** Why the deploy stopped and what to do next, or null when it has not failed. */
export function auctionFailureMessage(
  state: AuctionDeployState,
): string | null {
  const failure = state.failure;
  if (!failure) return null;
  if (failure.stage === "prepare") {
    return `Nothing was sent. The ${failure.check ?? "preflight"} check failed: ${failure.reason}`;
  }
  if (failure.stage === "link") {
    const auctionAddress = state.auctionAddress ?? "(address unavailable)";
    return `Every deploy transaction confirmed and the auction is at ${auctionAddress}, but saving it to the launch record failed: ${failure.reason} The onchain work is complete. Use “Retry record update” to link it.`;
  }
  const stepId = failure.step ?? "auction";
  const label =
    AUCTION_DEPLOY_STEP_LABELS[
      stepId as keyof typeof AUCTION_DEPLOY_STEP_LABELS
    ] ?? stepId;
  const outcome =
    failure.outcome === "reverted"
      ? "was reverted onchain"
      : failure.outcome === "unknown"
        ? "ended without a receipt, so it may or may not have gone through"
        : "failed before it was sent";
  const txNote = failure.txHash ? ` Transaction: ${failure.txHash}.` : "";
  const completed = AUCTION_DEPLOY_STEPS.filter(
    (s) => state.steps[s.id]?.status === "done",
  ).map((s) => s.label);
  const completedNote =
    completed.length > 0
      ? ` Already done: ${completed.join(", ")}.`
      : " No steps were completed.";
  const retryNote =
    failure.outcome === "unknown"
      ? " “Retry remaining steps” first checks whether it already landed, then continues from there."
      : " “Retry remaining steps” runs again from this step with fresh values.";
  return `${label} ${outcome}: ${failure.reason}${txNote}${completedNote}${retryNote}`;
}
