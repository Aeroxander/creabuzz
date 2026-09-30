/**
 * Deploy state machine for the founder money-loop flow (FLOW half): the
 * onchain step table, the deploy card's state/action types, the pure reducer,
 * the resume/retry plan and the failure labels. No effects live here — the
 * orchestrator is `auctionDeployRun.ts`, the effect ports, constants,
 * parameter gate, config encoding and factory calls are in `auctionPlan.ts`.
 */
import type { AuctionPreflightStage } from "./auctionPlan.ts";

// ---------------------------------------------------------------------------
// Deploy flow state machine (pure reducer)
// ---------------------------------------------------------------------------

/**
 * The onchain steps in hard order: the GraduationExecutor MUST precede the
 * auction (it is the auction's `fundsRecipient`/`tokensRecipient` at deploy
 * time — GraduationExecutor.sol:77-91). The hook (curated track) deploys first
 * because the auction constructor bakes its address in as `validationHook`.
 *
 * `AuctionLauncher.registerLaunch` is deliberately absent: OPTIONAL (its own
 * contract says the factory remains the deploy path, AuctionLauncher.sol:5-9)
 * and no launcher address is pinned in the record — deferred, reported.
 */
export const AUCTION_DEPLOY_STEPS = [
  {
    id: "hook",
    label: "Bid gate",
    detail: "Deploys the AllowlistHook (curated track only).",
  },
  {
    id: "executor",
    label: "Graduation executor",
    detail:
      "Deploys GraduationExecutor — the auction's funds/tokens recipient.",
  },
  {
    id: "auction",
    label: "Auction",
    detail: "Deploys the auction contract.",
  },
  {
    id: "hookAuction",
    label: "Lock bid gate to the auction",
    detail:
      "Tells the AllowlistHook which auction may call it, so nobody else can burn a bidder's cap (curated track only).",
  },
  {
    id: "fund",
    label: "Fund the auction",
    detail:
      "Transfers the whole sale supply from the deploying wallet to the auction.",
  },
  {
    id: "received",
    label: "Open bidding",
    detail:
      "Calls onTokensReceived() so the auction accepts bids. Safe to repeat.",
  },
  {
    id: "bind",
    label: "Bind the executor",
    detail:
      "Binds the graduation executor to this one auction — it refuses every other address.",
  },
] as const;

export type AuctionDeployStepId = (typeof AUCTION_DEPLOY_STEPS)[number]["id"];

export type AuctionDeployStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export interface AuctionDeployStepState {
  status: AuctionDeployStepStatus;
  /** Confirmed tx hash; null when satisfied by pre-existing code. */
  txHash: string | null;
  /** Created (CREATE) or precomputed (CREATE2) address. */
  address: string | null;
  /** Satisfied by code already onchain (an earlier attempt). */
  alreadyDeployed: boolean;
}

export type AuctionDeployPhase =
  | "idle"
  | "preparing"
  | "running"
  | "linking"
  | "success"
  | "paused"
  | "blocked";

export interface AuctionDeployFailure {
  /** Which part of the flow failed: preflight, an onchain step, the record update. */
  stage: "prepare" | "step" | "link";
  /** `stage: "prepare"` — which check. */
  check: AuctionPreflightStage | null;
  /** `stage: "step"` — which step. */
  step: AuctionDeployStepId | null;
  /** Mined tx hash (also present for a mined revert); null without a receipt. */
  txHash: string | null;
  /**
   * "reverted" — mined with status reverted; "unknown" — no receipt (the tx
   * may or may not have been broadcast); null — failed before broadcast.
   */
  outcome: "reverted" | "unknown" | null;
  reason: string;
}

export interface AuctionDeployState {
  phase: AuctionDeployPhase;
  steps: Record<AuctionDeployStepId, AuctionDeployStepState>;
  /** The CREATE2 auction address (known before the factory tx mines). */
  auctionAddress: string | null;
  failure: AuctionDeployFailure | null;
}

export type AuctionDeployAction =
  | { type: "begin"; mode: "fresh" | "resume" }
  | { type: "blocked"; stage: AuctionPreflightStage; detail: string }
  | { type: "prepared"; auctionAddress: string | null }
  | { type: "step_started"; step: AuctionDeployStepId }
  | { type: "step_address"; step: AuctionDeployStepId; address: string }
  | {
      type: "step_done";
      step: AuctionDeployStepId;
      txHash: string | null;
      address: string;
      alreadyDeployed: boolean;
    }
  | {
      type: "step_failed";
      step: AuctionDeployStepId;
      txHash: string | null;
      outcome: "reverted" | "unknown" | null;
      reason: string;
    }
  | { type: "link_started" }
  | { type: "link_failed"; reason: string }
  | { type: "linked" };

export type AuctionDispatch = (action: AuctionDeployAction) => void;

function freshDeploySteps(
  admission: "curated" | "community",
): Record<AuctionDeployStepId, AuctionDeployStepState> {
  const entry = (skipped: boolean): AuctionDeployStepState => ({
    status: skipped ? "skipped" : "pending",
    txHash: null,
    address: null,
    alreadyDeployed: false,
  });
  return {
    hook: entry(admission !== "curated"),
    executor: entry(false),
    auction: entry(false),
    hookAuction: entry(admission !== "curated"),
    fund: entry(false),
    received: entry(false),
    bind: entry(false),
  };
}

export function initAuctionDeployState(
  admission: "curated" | "community" = "community",
): AuctionDeployState {
  return {
    phase: "idle",
    steps: freshDeploySteps(admission),
    auctionAddress: null,
    failure: null,
  };
}

function withStep(
  state: AuctionDeployState,
  step: AuctionDeployStepId,
  patch: Partial<AuctionDeployStepState>,
): Record<AuctionDeployStepId, AuctionDeployStepState> {
  return { ...state.steps, [step]: { ...state.steps[step], ...patch } };
}

/** Pure flow reducer — the single state authority of the deploy card. */
export function auctionDeployReducer(
  state: AuctionDeployState,
  action: AuctionDeployAction,
): AuctionDeployState {
  switch (action.type) {
    case "begin": {
      // Both modes keep completed steps (deploy idempotency lives onchain plus
      // in the recorded predictions) and give a failed/running step a clean
      // retry that RETAINS its predicted address — the no-receipt guard reads
      // it before re-sending. `mode` documents intent ("fresh" = first run,
      // "resume" = retry); the transition is identical by design.
      const steps = Object.fromEntries(
        Object.entries(state.steps).map(([id, step]) => [
          id,
          step.status === "failed" || step.status === "running"
            ? {
                ...step,
                status: "pending" as const,
                txHash: null,
                alreadyDeployed: false,
              }
            : step,
        ]),
      ) as Record<AuctionDeployStepId, AuctionDeployStepState>;
      return { ...state, steps, phase: "preparing", failure: null };
    }
    case "blocked":
      return {
        ...state,
        phase: "blocked",
        failure: {
          stage: "prepare",
          check: action.stage,
          step: null,
          txHash: null,
          outcome: null,
          reason: action.detail,
        },
      };
    case "prepared":
      return {
        ...state,
        phase: "running",
        auctionAddress: action.auctionAddress ?? state.auctionAddress,
        failure: null,
      };
    case "step_started":
      return {
        ...state,
        phase: "running",
        steps: withStep(state, action.step, {
          status: "running",
          txHash: null,
          alreadyDeployed: false,
        }),
        failure: null,
      };
    case "step_address":
      return {
        ...state,
        steps: withStep(state, action.step, { address: action.address }),
      };
    case "step_done":
      return {
        ...state,
        steps: withStep(state, action.step, {
          status: "done",
          txHash: action.txHash,
          address: action.address,
          alreadyDeployed: action.alreadyDeployed,
        }),
      };
    case "step_failed":
      return {
        ...state,
        phase: "paused",
        steps: withStep(state, action.step, {
          status: "failed",
          txHash: action.txHash,
        }),
        failure: {
          stage: "step",
          check: null,
          step: action.step,
          txHash: action.txHash,
          outcome: action.outcome,
          reason: action.reason,
        },
      };
    case "link_started":
      return { ...state, phase: "linking", failure: null };
    case "link_failed":
      return {
        ...state,
        phase: "paused",
        failure: {
          stage: "link",
          check: null,
          step: null,
          txHash: null,
          outcome: null,
          reason: action.reason,
        },
      };
    case "linked":
      return { ...state, phase: "success", failure: null };
    default:
      return state;
  }
}

/** Index of the first step still to run (AUCTION_DEPLOY_STEPS.length when done). */
export function deployResumeIndex(state: AuctionDeployState): number {
  const index = AUCTION_DEPLOY_STEPS.findIndex(
    (s) =>
      state.steps[s.id].status !== "done" &&
      state.steps[s.id].status !== "skipped",
  );
  return index === -1 ? AUCTION_DEPLOY_STEPS.length : index;
}

/** What "retry" means in the current state (null = nothing to retry). */
export type AuctionRetryPlan =
  | { kind: "steps"; resumeAt: number }
  | { kind: "record"; auctionAddress: string }
  | null;

/**
 * Retry is always safe when offered:
 * - step failures resume at the failed step with RE-DERIVED inputs; a retry of
 *   a CREATE step first checks code at its predicted address (an unknown
 *   outcome is indistinguishable from "landed later"), and the factory step
 *   checks the CREATE2 address before re-sending (re-running `create` with the
 *   same salt would revert);
 * - the executor/hook CREATE retries predict a fresh address from the current
 *   nonce when no code exists at the previous prediction (a reverted deploy
 *   consumes its nonce);
 * - a record-update failure keeps the deployed auction and re-publishes only
 *   the record.
 */
export function retryPlan(state: AuctionDeployState): AuctionRetryPlan {
  if (state.phase !== "paused") return null;
  if (state.failure?.stage === "link") {
    const auctionAddress = state.auctionAddress ?? state.steps.auction.address;
    return auctionAddress ? { kind: "record", auctionAddress } : null;
  }
  if (state.failure?.stage === "step") {
    return { kind: "steps", resumeAt: deployResumeIndex(state) };
  }
  return null;
}
