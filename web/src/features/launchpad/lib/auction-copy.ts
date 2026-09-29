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
  AUCTION_DEPLOY_STEPS,
  type AuctionDeployState,
  type AuctionDeployStepId,
  type AuctionDeployStepState,
} from "./auctionFlow.ts";
import type {
  GraduationReadiness,
  GraduationStepId,
  GraduationStepStatus,
} from "./graduationFlow.ts";
import { isUserRejection } from "./wallet-errors.ts";

/**
 * What the panels SHOW for each step, in plain words. The flow modules keep
 * their own developer-facing labels (they are shared, byte for byte, with the
 * desktop app); the web speaks to founders, not contract authors. A test walks
 * the flow's step list so a step added there cannot ship without copy here.
 */
export const AUCTION_STEP_COPY: Record<
  AuctionDeployStepId,
  { label: string; detail: string }
> = {
  hook: {
    label: "Bid gate",
    detail: "Limits how much each wallet can bid (curated track only).",
  },
  executor: {
    label: "Graduation executor",
    detail:
      "The contract that receives the raise and the unsold tokens when the auction ends.",
  },
  auction: {
    label: "Auction",
    detail: "Creates the auction itself.",
  },
  hookAuction: {
    label: "Lock the bid gate to the auction",
    detail:
      "Makes sure only this auction can use the bid gate (curated track only).",
  },
  fund: {
    label: "Fund the auction",
    detail: "Moves the whole sale supply from your wallet into the auction.",
  },
  received: {
    label: "Open bidding",
    detail: "Tells the auction its tokens arrived, so it starts taking bids.",
  },
  bind: {
    label: "Link the executor to the auction",
    detail:
      "Makes the executor serve this one auction and no other. Only the treasury wallet can do this.",
  },
};

export const GRADUATION_STEP_COPY: Record<
  GraduationStepId,
  { label: string; detail: string }
> = {
  execute: {
    label: "Execute graduation",
    detail: "One transaction: sweeps the raise, splits it, records the result.",
  },
  mirrorSweep: {
    label: "Publish the sweep receipt",
    detail: "Records that transaction on this launch's page.",
  },
  mirrorLock: {
    label: "Publish the reserve receipt",
    detail: "Records the reserve held behind the token's price floor.",
  },
};

/** The plain label of a deploy step, falling back to the raw id. */
export function auctionStepLabel(step: string): string {
  return AUCTION_STEP_COPY[step as AuctionDeployStepId]?.label ?? step;
}

/** End a sentence: add a full stop unless the text already ends in punctuation. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

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

/**
 * Status words for a graduation step row. Before the flow has started every
 * step is unplanned in the reducer's terms, but to a reader it is simply not
 * started yet: "Not planned" would read as "this will not happen".
 */
export function graduationStepStatusText(
  status: GraduationStepStatus,
  started: boolean,
): string {
  switch (status) {
    case "active":
      return "In progress…";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "skipped":
      return started ? "Not needed" : "Not started";
    default:
      return "Waiting";
  }
}

/**
 * The graduation gate in plain words. The flow's own `message` cites contract
 * source lines and function names; it is kept for a "Technical detail"
 * disclosure, and this is what the founder reads first.
 */
export function graduationReadinessText(
  readiness: GraduationReadiness,
): string {
  switch (readiness.status) {
    case "ready":
      return "The auction has ended and raised enough. You can execute the graduation now.";
    case "running":
      return "The auction is still running. Graduation opens once it ends.";
    case "threshold-missed":
      return "The auction ended below its required raise, so there is nothing to graduate. Bidders can exit and claim their refunds.";
    case "already-graduated":
      return "This launch has already been graduated.";
    case "blocked":
      return "Graduation cannot run right now. The technical detail below says what the contract objected to.";
    case "misconfigured":
      return "This auction was not deployed with the graduation executor as its funds and tokens recipient, so graduation cannot run. The launch has to be redeployed.";
    default:
      return readiness.message;
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
  const label = auctionStepLabel(stepId);
  const txNote = failure.txHash ? ` Transaction: ${failure.txHash}.` : "";
  const completed = AUCTION_DEPLOY_STEPS.filter(
    (s) => state.steps[s.id]?.status === "done",
  ).map((s) => auctionStepLabel(s.id));
  const completedNote =
    completed.length > 0
      ? ` Already done: ${completed.join(", ")}.`
      : " No steps were completed.";
  // Declining in the wallet is a KNOWN outcome — the transaction was never
  // sent. Reporting it as "may or may not have gone through" would send the
  // founder hunting for a transaction that does not exist.
  if (isUserRejection(failure.reason)) {
    return `You declined “${label}” in your wallet, so nothing was sent for this step.${completedNote} Use “Retry remaining steps” to continue when you are ready.`;
  }
  const outcome =
    failure.outcome === "reverted"
      ? "was reverted onchain"
      : failure.outcome === "unknown"
        ? "ended without a receipt, so it may or may not have gone through"
        : "failed before it was sent";
  const retryNote =
    failure.outcome === "unknown"
      ? " “Retry remaining steps” first checks whether it already landed, then continues from there."
      : " “Retry remaining steps” runs again from this step with fresh values.";
  return `${label} ${outcome}: ${sentence(failure.reason)}${txNote}${completedNote}${retryNote}`;
}

// ---------------------------------------------------------------------------
// Gates: what must be true before the panels let anyone sign
// ---------------------------------------------------------------------------

/** Why a panel is not ready to send, or `ok` when it is. */
export type SendGate =
  | { ok: true }
  | {
      ok: false;
      reason: "mainnet" | "plan" | "no-wallet" | "wrong-chain" | "not-treasury";
      message: string;
    };

const sameAddress = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Gate for the auction deploy. Checked BEFORE the first transaction because the
 * failures it prevents are expensive: the executor is deployed first, and the
 * final `bindAuction` is treasury-only, so a wallet that is not the treasury
 * would spend gas and stall at the last step. The order is the order a founder
 * can fix things in: build restrictions, then the sale terms, then the wallet.
 */
export function deployGate(input: {
  /** A mainnet launch on a build that has not enabled mainnet. */
  mainnetBlocked: boolean;
  /** Why the sale terms cannot be deployed (from the parameter gate), if so. */
  planProblem: string | null;
  /** The connected account, or null. */
  address: string | null;
  /** The chain the wallet is on, or null when not yet known. */
  walletChainId: number | null;
  /** The chain the launch is on. */
  launchChainId: number | null;
  /** The launch record's treasury. */
  treasury: string | null | undefined;
}): SendGate {
  if (input.mainnetBlocked) {
    return {
      ok: false,
      reason: "mainnet",
      message:
        "This launch is on a mainnet, and this build has mainnet switched off. The contracts are unaudited: use a test network.",
    };
  }
  if (input.planProblem) {
    return { ok: false, reason: "plan", message: input.planProblem };
  }
  if (!input.address) {
    return {
      ok: false,
      reason: "no-wallet",
      message: "Connect the treasury wallet to deploy the auction.",
    };
  }
  if (
    input.launchChainId !== null &&
    input.walletChainId !== null &&
    input.walletChainId !== input.launchChainId
  ) {
    return {
      ok: false,
      reason: "wrong-chain",
      message: `Your wallet is on chain ${input.walletChainId}, but this launch is on chain ${input.launchChainId}. Switch networks in your wallet.`,
    };
  }
  if (input.treasury && !sameAddress(input.address, input.treasury)) {
    return {
      ok: false,
      reason: "not-treasury",
      message: `Only the launch's treasury wallet can finish this deploy, because the last step binds the executor to the auction and only the treasury may do that. Connect ${input.treasury}.`,
    };
  }
  return { ok: true };
}

/**
 * Gate for executing graduation. The call itself is permissionless (funds can
 * only go to the treasury and the reserve escrow), so it needs a wallet on the
 * right chain and nothing more.
 */
export function graduationGate(input: {
  address: string | null;
  walletChainId: number | null;
  launchChainId: number | null;
}): SendGate {
  if (!input.address) {
    return {
      ok: false,
      reason: "no-wallet",
      message: "Connect a wallet to execute the graduation.",
    };
  }
  if (
    input.launchChainId !== null &&
    input.walletChainId !== null &&
    input.walletChainId !== input.launchChainId
  ) {
    return {
      ok: false,
      reason: "wrong-chain",
      message: `Your wallet is on chain ${input.walletChainId}, but this launch is on chain ${input.launchChainId}. Switch networks in your wallet.`,
    };
  }
  return { ok: true };
}
