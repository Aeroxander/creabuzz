/**
 * Token-mint step orchestration: pure reducer + dependency-injected runner.
 * Port of desktop `lib/mintFlow.ts` (the reference implementation) and
 * `mintHooks.ts`'s run/retry orchestration (lines 106-235). The three onchain
 * steps come from `mint-tx.ts`'s composer; the fourth, `link`, is the
 * mirror-only record write-back (the `token` tag on the launch record) and
 * carries the `bidHooks.ts` mirror-reducer contract: a link failure never
 * re-sends the money action — `retryPlan` returns `{ kind: "record" }` and
 * retry re-publishes only the record (Review-Proven Rule 5).
 *
 * Send strategy (documented difference by sender): the composer is shared and
 * sender-agnostic. Through the SPONSORED sender (`identity/lib/
 * sponsoredSender.ts`) the 3 deploy calls become ONE batched UserOp — kernel
 * 0.3.3 executes CALLTYPE_BATCH through the same `execute(bytes32,bytes)` —
 * so they land atomically and a failure means nothing landed. Through the
 * injected wallet (`lib/wallet-sender.ts`) they are 3 sequential
 * transactions, each receipt awaited before the next (ordering is a hard
 * protocol requirement). `strategy` selects the orchestration; the call bytes
 * are identical either way.
 *
 * Idempotent retry: step 1 is guarded by a code check at the precomputed
 * CREATE2 `tokenAddress` — a previous attempt with an unknown outcome may have
 * landed, and re-sending `deployToken` would revert on the address mismatch
 * (`tokenAlreadyDeployed` satisfies step 1 instead). Steps 2-3 are idempotent
 * owner setters (same validator / ruleset again), so replaying them after an
 * unknown outcome cannot corrupt state (mintFlow.ts:653-678).
 */
import type {
  MintEvmCall,
  MintPlanInputs,
  TokenDeployCallsParams,
} from "./mint-tx.ts";
import {
  buildComputeDeploymentAddressView,
  buildInfraFeeView,
  buildTokenDeployCalls,
  decodeAddressWord,
  DEFAULT_TOKENMASTER_ROUTER,
  deployParamsForPlan,
  MAX_INFRASTRUCTURE_FEE_BPS,
  treasuryGate,
  ZERO_ADDRESS,
} from "./mint-tx.ts";

/** Receipt shape of one sent transaction / UserOp bundle. */
export interface MintTxReceipt {
  txHash: string;
  /**
   * "success" — landed; "reverted" — mined with status reverted (data, not an
   * exception); "unknown" — outcome not observable (possibly never broadcast).
   */
  status: "success" | "reverted" | "unknown";
  blockNumber?: number | null;
}

/**
 * The chain effects the deploy flow needs. A mined `status: "reverted"` is
 * DATA (a failed step), not an exception; a rejected `send` means the outcome
 * is unknown (possibly never broadcast) and is reported as such.
 */
export interface MintEffects {
  /** `eth_call` — returns raw hex return data (a single 32-byte word here). */
  call(target: { to: string; data: string }): Promise<string>;
  /** Send one call sequentially; resolves once the outcome is known. */
  send(call: MintEvmCall): Promise<MintTxReceipt>;
  /** Send all calls as ONE batched UserOp (sponsored-sender strategy). */
  sendBatch?(calls: MintEvmCall[]): Promise<MintTxReceipt>;
}

/** Human-safe message for a thrown unknown. */
export function mintErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Plan inputs → preflight (mintFlow.ts:280-400)
// ---------------------------------------------------------------------------

/** Which preflight check produced a blocking failure. */
export type MintPreflightStage =
  | "plan"
  | "treasury"
  | "infrastructure-fee"
  | "token-address"
  | "token-state";

/** A preflight failure that names the exact check that failed. */
export class MintPrepareError extends Error {
  readonly stage: MintPreflightStage;

  constructor(stage: MintPreflightStage, message: string) {
    super(message);
    this.name = "MintPrepareError";
    this.stage = stage;
  }
}

/** Everything `buildTokenDeployCalls` needs, pre-derived. */
export interface PreparedDeploy {
  /** Deploy params with the computed CREATE2 `tokenAddress` filled in. */
  params: TokenDeployCallsParams;
  /** `buildTokenDeployCalls(params)` — the ordered 3-call sequence. */
  calls: MintEvmCall[];
  /** The precomputed CREATE2 token address (steps 2-3 target it). */
  tokenAddress: string;
  /** The live router fee used for the address computation. */
  infrastructureFeeBps: bigint;
}

/**
 * Run the `DeployAppToken.s.sol` VIEW preconditions: read the live
 * infrastructure fee, compute the CREATE2 token address, and re-derive the
 * ordered deploy calls (`buildTokenDeployCalls` — re-running this is what
 * makes a retry safe). Throws {@link MintPrepareError} naming the exact check.
 */
export async function prepareDeploy(
  effects: Pick<MintEffects, "call">,
  inputs: MintPlanInputs,
): Promise<PreparedDeploy> {
  let viewParams: TokenDeployCallsParams;
  try {
    viewParams = deployParamsForPlan(inputs, ZERO_ADDRESS);
  } catch (error) {
    throw new MintPrepareError("plan", mintErrorMessage(error));
  }

  let feeRaw: string;
  try {
    feeRaw = await effects.call(
      buildInfraFeeView(viewParams.router ?? DEFAULT_TOKENMASTER_ROUTER),
    );
  } catch (error) {
    throw new MintPrepareError(
      "infrastructure-fee",
      `reading router.infrastructureFeeBPS() failed: ${mintErrorMessage(error)}`,
    );
  }
  let infrastructureFeeBps: bigint;
  try {
    infrastructureFeeBps = BigInt(feeRaw);
  } catch (error) {
    throw new MintPrepareError(
      "infrastructure-fee",
      `router.infrastructureFeeBPS() returned a malformed word: ${mintErrorMessage(error)}`,
    );
  }
  if (infrastructureFeeBps > 65_535n) {
    throw new MintPrepareError(
      "infrastructure-fee",
      `router.infrastructureFeeBPS() out of uint16 range: ${infrastructureFeeBps}`,
    );
  }
  if (infrastructureFeeBps > MAX_INFRASTRUCTURE_FEE_BPS) {
    throw new MintPrepareError(
      "infrastructure-fee",
      `the router's infrastructure fee (${infrastructureFeeBps} bps) is above the ${MAX_INFRASTRUCTURE_FEE_BPS} bps deploy cap — the deploy would revert`,
    );
  }

  let addressRaw: string;
  try {
    addressRaw = await effects.call(
      buildComputeDeploymentAddressView(viewParams, infrastructureFeeBps),
    );
  } catch (error) {
    throw new MintPrepareError(
      "token-address",
      `factory.computeDeploymentAddress(...) failed: ${mintErrorMessage(error)}`,
    );
  }
  let tokenAddress: string;
  try {
    tokenAddress = decodeAddressWord(addressRaw);
  } catch (error) {
    throw new MintPrepareError(
      "token-address",
      `factory.computeDeploymentAddress(...) returned a malformed word: ${mintErrorMessage(error)}`,
    );
  }
  if (tokenAddress === ZERO_ADDRESS) {
    throw new MintPrepareError(
      "token-address",
      "factory.computeDeploymentAddress(...) returned the zero address",
    );
  }

  const params = { ...viewParams, tokenAddress };
  return {
    params,
    calls: buildTokenDeployCalls(params),
    tokenAddress,
    infrastructureFeeBps,
  };
}

// ---------------------------------------------------------------------------
// Flow state machine (pure reducer — mintFlow.ts:433-642, ported verbatim)
// ---------------------------------------------------------------------------

/** The three onchain steps, in `DeployAppToken.s.sol` broadcast order. */
export const MINT_STEPS = [
  {
    id: "deploy",
    label: "Deploy token",
    detail: "Creates the token and its pool (usually the slow step).",
  },
  {
    id: "validator",
    label: "Transfer validator",
    detail: "Wires the transfer validator on the new token.",
  },
  {
    id: "ruleset",
    label: "Trading ruleset",
    detail: "Opens trading with the Vanilla ruleset.",
  },
] as const;

export type MintStepId = (typeof MINT_STEPS)[number]["id"];

export type MintStepStatus = "pending" | "running" | "done" | "failed";

export interface MintStepState {
  status: MintStepStatus;
  /** Confirmed tx hash; null while pending/running or when reusing an
   *  earlier session's deploy (`tokenAlreadyDeployed`). */
  txHash: string | null;
}

export type MintPhase =
  | "idle"
  | "preparing"
  | "running"
  | "paused"
  | "linking"
  | "success"
  | "blocked";

export interface MintFailure {
  /** Which part of the flow failed: preflight, an onchain step, the record update. */
  stage: "prepare" | "step" | "link";
  /** `stage: "prepare"` — which check. */
  check: MintPreflightStage | null;
  /** `stage: "step"` — which of the three calls (0-based). */
  stepIndex: number | null;
  /** Mined tx hash (also present for a mined revert); null without a receipt. */
  txHash: string | null;
  /**
   * "reverted" — mined with status reverted (no state change from this tx);
   * "unknown" — no receipt (the tx may or may not have been broadcast).
   */
  outcome: "reverted" | "unknown" | null;
  reason: string;
}

export interface MintFlowState {
  phase: MintPhase;
  /** Exactly {@link MINT_STEPS}.length entries, index-aligned with it. */
  steps: MintStepState[];
  /** The precomputed CREATE2 token address (known before step 1 mines). */
  tokenAddress: string | null;
  /** Step 1 satisfied by code already at `tokenAddress` (earlier attempt). */
  tokenAlreadyDeployed: boolean;
  failure: MintFailure | null;
}

export type MintAction =
  | { type: "begin"; mode: "fresh" | "resume" }
  | { type: "blocked"; stage: MintPreflightStage; detail: string }
  | { type: "prepared"; tokenAddress: string; tokenAlreadyDeployed: boolean }
  | { type: "step_started"; index: number }
  | { type: "step_done"; index: number; txHash: string | null }
  | {
      type: "step_failed";
      index: number;
      txHash: string | null;
      outcome: "reverted" | "unknown";
      reason: string;
    }
  | { type: "link_started" }
  | { type: "link_failed"; reason: string }
  | { type: "linked" };

export type MintDispatch = (action: MintAction) => void;

export function initMintFlow(): MintFlowState {
  return {
    phase: "idle",
    steps: MINT_STEPS.map(() => ({ status: "pending", txHash: null })),
    tokenAddress: null,
    tokenAlreadyDeployed: false,
    failure: null,
  };
}

function withStep(
  state: MintFlowState,
  index: number,
  step: MintStepState,
): MintStepState[] {
  return state.steps.map((s, i) => (i === index ? step : s));
}

/** Pure flow reducer — the single state authority of the deploy card. */
export function mintFlowReducer(
  state: MintFlowState,
  action: MintAction,
): MintFlowState {
  switch (action.type) {
    case "begin": {
      const base =
        action.mode === "fresh"
          ? initMintFlow()
          : {
              ...state,
              // Keep completed steps; give the failed one a clean retry.
              steps: state.steps.map((s) =>
                s.status === "failed"
                  ? { status: "pending" as const, txHash: null }
                  : s,
              ),
            };
      return { ...base, phase: "preparing", failure: null };
    }
    case "blocked":
      return {
        ...state,
        phase: "blocked",
        failure: {
          stage: "prepare",
          check: action.stage,
          stepIndex: null,
          txHash: null,
          outcome: null,
          reason: action.detail,
        },
      };
    case "prepared": {
      const steps = state.steps.map((s) => ({ ...s }));
      if (action.tokenAlreadyDeployed && steps[0].status === "pending") {
        // A previous attempt already created the token — rerunning the deploy
        // call would revert on the CREATE2 address mismatch.
        steps[0] = { status: "done", txHash: null };
      }
      return {
        ...state,
        phase: "running",
        steps,
        tokenAddress: action.tokenAddress,
        tokenAlreadyDeployed: action.tokenAlreadyDeployed,
        failure: null,
      };
    }
    case "step_started":
      return {
        ...state,
        phase: "running",
        steps: withStep(state, action.index, {
          status: "running",
          txHash: null,
        }),
        failure: null,
      };
    case "step_done":
      return {
        ...state,
        steps: withStep(state, action.index, {
          status: "done",
          txHash: action.txHash,
        }),
      };
    case "step_failed":
      return {
        ...state,
        phase: "paused",
        steps: withStep(state, action.index, {
          status: "failed",
          txHash: action.txHash,
        }),
        failure: {
          stage: "step",
          check: null,
          stepIndex: action.index,
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
          // The mirror step: the money steps stay done and are never re-sent
          // for a link failure (retryPlan → { kind: "record" }).
          stage: "link",
          check: null,
          stepIndex: null,
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

/** Index of the first not-done step (MINT_STEPS.length when all are done). */
export function resumeIndex(state: MintFlowState): number {
  const index = state.steps.findIndex((s) => s.status !== "done");
  return index === -1 ? state.steps.length : index;
}

/** What "retry" means in the current state (null = nothing to retry). */
export type MintRetryPlan =
  | { kind: "steps"; resumeAt: number }
  | { kind: "record"; tokenAddress: string }
  | null;

/**
 * Retry is always safe when offered:
 * - step failures resume at the failed step with re-derived calls; a retry of
 *   step 1 first verifies code at the token address (`tokenAlreadyDeployed`)
 *   because a no-receipt outcome is indistinguishable from "landed later";
 * - steps 2-3 are idempotent owner setters (same validator / ruleset again),
 *   so replaying them after an unknown outcome cannot corrupt state;
 * - a record-update (mirror) failure keeps the deployed token and re-publishes
 *   only the record — a mirror-only failure never re-sends the money action.
 * `null` while paused means retry is genuinely unavailable (say so in the UI).
 */
export function retryPlan(state: MintFlowState): MintRetryPlan {
  if (state.phase !== "paused") return null;
  if (state.failure?.stage === "link") {
    return state.tokenAddress
      ? { kind: "record", tokenAddress: state.tokenAddress }
      : null;
  }
  if (state.failure?.stage === "step") {
    return { kind: "steps", resumeAt: resumeIndex(state) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator: send the calls (sequential or one batched UserOp)
// ---------------------------------------------------------------------------

export interface MintRunOutcome {
  /** True when every step is done (the caller then links the record). */
  completed: boolean;
}

/** How the composed calls reach the sender. */
export type MintSendStrategy = "sequential" | "batched";

/**
 * Send `calls` per the strategy — each receipt awaited before the next
 * broadcast (sequential, the ordering is a hard protocol requirement), or as
 * one batched UserOp (sponsored sender; atomic). Halts on the first failure
 * and records exactly which step failed and why (mined revert vs. unknown
 * outcome); completed steps are never rolled back or hidden.
 */
export async function runDeploySteps(input: {
  calls: MintEvmCall[];
  /** Resume point (0..2) — a retry resumes at the failed step. */
  startAt: number;
  strategy: MintSendStrategy;
  effects: Pick<MintEffects, "send" | "sendBatch">;
  dispatch: MintDispatch;
}): Promise<MintRunOutcome> {
  const { calls, startAt, strategy, effects, dispatch } = input;
  if (calls.length !== MINT_STEPS.length) {
    throw new Error(
      `expected ${MINT_STEPS.length} deploy calls, got ${calls.length}`,
    );
  }
  if (startAt >= calls.length) return { completed: true };

  if (strategy === "batched") {
    // One UserOp carries every remaining call: it lands all-or-nothing, so a
    // failure names the first incomplete step and nothing is marked done.
    const sendBatch = effects.sendBatch;
    if (!sendBatch) throw new Error("batched strategy needs effects.sendBatch");
    const remaining = calls.slice(startAt);
    for (let index = startAt; index < calls.length; index++) {
      dispatch({ type: "step_started", index });
    }
    let receipt: MintTxReceipt;
    try {
      receipt = await sendBatch(remaining);
    } catch (error) {
      dispatch({
        type: "step_failed",
        index: startAt,
        txHash: null,
        outcome: "unknown",
        reason: mintErrorMessage(error),
      });
      return { completed: false };
    }
    if (receipt.status !== "success") {
      dispatch({
        type: "step_failed",
        index: startAt,
        txHash: receipt.txHash,
        outcome: receipt.status === "unknown" ? "unknown" : "reverted",
        reason:
          receipt.status === "unknown"
            ? `the batched transaction ${receipt.txHash} has an unknown outcome — check the chain before retrying`
            : `transaction ${receipt.txHash} reverted in block ${receipt.blockNumber ?? "unknown"}`,
      });
      return { completed: false };
    }
    for (let index = startAt; index < calls.length; index++) {
      dispatch({ type: "step_done", index, txHash: receipt.txHash });
    }
    return { completed: true };
  }

  for (let index = startAt; index < calls.length; index++) {
    dispatch({ type: "step_started", index });
    let receipt: MintTxReceipt;
    try {
      receipt = await effects.send(calls[index]);
    } catch (error) {
      dispatch({
        type: "step_failed",
        index,
        txHash: null,
        outcome: "unknown",
        reason: mintErrorMessage(error),
      });
      return { completed: false };
    }
    if (receipt.status !== "success") {
      dispatch({
        type: "step_failed",
        index,
        txHash: receipt.txHash,
        outcome: receipt.status === "unknown" ? "unknown" : "reverted",
        reason:
          receipt.status === "unknown"
            ? `transaction ${receipt.txHash} has an unknown outcome — check the chain before retrying`
            : `transaction ${receipt.txHash} reverted in block ${receipt.blockNumber ?? "unknown"}`,
      });
      return { completed: false };
    }
    dispatch({ type: "step_done", index, txHash: receipt.txHash });
  }
  return { completed: true };
}

// ---------------------------------------------------------------------------
// Full attempt runner (the production seam tests bind; the UI wires React
// state to it) — port of mintHooks.ts' run()/retry() (:128-228).
// ---------------------------------------------------------------------------

export interface MintAttemptInput {
  /** Mint plan without the treasury — the deployer (post-gate) supplies it. */
  plan: Omit<MintPlanInputs, "treasury"> & {
    recordTreasury: string | null | undefined;
  };
  /** The signing account (wallet or passkey-owned Kernel). */
  deployer: string;
  strategy: MintSendStrategy;
  effects: MintEffects & {
    /** True when code already exists at `tokenAddress` (idempotent retry). */
    isDeployed(tokenAddress: string): Promise<boolean>;
  };
  /** The mirror step: write the `token` tag back to the launch record. */
  link: (tokenAddress: string) => Promise<void>;
  dispatch: MintDispatch;
  /** Current state — drives resume (the UI owns the reducer). */
  state: MintFlowState;
}

/**
 * One full attempt: treasury gate → preflight → code check → steps → link.
 * `mode: "resume"` keeps completed steps and re-sends only the remainder.
 * Every failure is dispatched with its stage named; nothing is swallowed.
 */
export async function runMintAttempt(
  input: MintAttemptInput,
  mode: "fresh" | "resume",
): Promise<void> {
  const { plan, deployer, strategy, effects, link, dispatch, state } = input;
  const { recordTreasury, ...mintPlan } = plan;
  const gate = treasuryGate(deployer, recordTreasury);
  if (!gate.ok) {
    dispatch({ type: "blocked", stage: "treasury", detail: gate.detail });
    return;
  }
  const resumeAt = mode === "resume" ? resumeIndex(state) : 0;
  dispatch({ type: "begin", mode });

  let prepared: PreparedDeploy;
  try {
    prepared = await prepareDeploy(effects, {
      ...mintPlan,
      treasury: gate.treasury,
    });
  } catch (error) {
    const stage: MintPreflightStage =
      error instanceof MintPrepareError ? error.stage : "plan";
    dispatch({ type: "blocked", stage, detail: mintErrorMessage(error) });
    return;
  }

  // A previous attempt may already have created the token (its outcome is
  // kept onchain, not in app state) — rerunning the deploy call would revert
  // on the CREATE2 address mismatch. Surface the check's own failures rather
  // than guessing (Review-Proven Rule 1: no silent fallbacks).
  let tokenAlreadyDeployed: boolean;
  try {
    tokenAlreadyDeployed = await effects.isDeployed(prepared.tokenAddress);
  } catch (error) {
    dispatch({
      type: "blocked",
      stage: "token-state",
      detail: `verifying ${prepared.tokenAddress} onchain failed: ${mintErrorMessage(error)}`,
    });
    return;
  }
  dispatch({
    type: "prepared",
    tokenAddress: prepared.tokenAddress,
    tokenAlreadyDeployed,
  });

  const outcome = await runDeploySteps({
    calls: prepared.calls,
    startAt: Math.max(resumeAt, tokenAlreadyDeployed ? 1 : 0),
    strategy,
    effects,
    dispatch,
  });
  if (!outcome.completed) return;

  dispatch({ type: "link_started" });
  try {
    await link(prepared.tokenAddress);
    dispatch({ type: "linked" });
  } catch (error) {
    dispatch({ type: "link_failed", reason: mintErrorMessage(error) });
  }
}

/**
 * Retry entry: a `{ kind: "record" }` plan re-publishes ONLY the record
 * (the mirror step — never the money action); a `{ kind: "steps" }` plan
 * re-runs the attempt in resume mode. Returns what it did.
 */
export async function retryMintAttempt(
  input: MintAttemptInput,
): Promise<"record" | "steps" | "nothing"> {
  const planToRetry = retryPlan(input.state);
  if (!planToRetry) return "nothing";
  if (planToRetry.kind === "record") {
    input.dispatch({ type: "link_started" });
    try {
      await input.link(planToRetry.tokenAddress);
      input.dispatch({ type: "linked" });
    } catch (error) {
      input.dispatch({ type: "link_failed", reason: mintErrorMessage(error) });
    }
    return "record";
  }
  await runMintAttempt(input, "resume");
  return "steps";
}
