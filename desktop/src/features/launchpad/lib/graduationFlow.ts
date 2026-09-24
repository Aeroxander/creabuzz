/**
 * Pure graduation-execution logic — the second half of the founder money loop
 * (plan gap G3, `docs/next-gen-launchpad-plan.md` §6 Phase A2): readiness in
 * the contract's own terms, the single atomic
 * `GraduationExecutor.executeGraduation(auction)` call that moves the money,
 * and the 47005 `sweep`/`lock` receipts published AFTER the confirmed receipt
 * with the tx hash bound (§6 A2 / §C5 vocabulary).
 *
 * Split from `auctionFlow.ts` (shared effect ports, decoders, and signatures
 * live there; no network/clock/DOM here — `auctionFlow.test.mjs` binds this
 * seam with scripted fakes). Sources of truth:
 * - `contracts/src/GraduationExecutor.sol` — `executeGraduation` (:77-129,
 *   callable by anyone), `graduations(address)` record (:34-45), and its
 *   deploy-time recipient requirement (:86-91) the readiness check verifies.
 * - `contracts/lib/continuous-clearing-auction/src/ContinuousClearingAuction.sol`
 *   — `isGraduated()` (:161-170), `lbpInitializationParams()` gating
 *   (:134-141, readable exactly when finalized + graduated), sweeps
 *   (:663-700).
 * - `contracts/src/CCA.sol:8-30` — the pinned view surface.
 * - `crates/buzz-relay/src/handlers/ingest.rs:2075-2116` — 47005 receipt
 *   envelope: exactly one `a` tag and one well-formed `tx` tag; the `kind`
 *   vocabulary (`sweep`/`lock`) is unconstrained.
 */

import { decodeBool } from "@/features/launchpad/lib/chainRpc";
import {
  encodeFunctionData,
  selectorOf,
} from "@/features/launchpad/lib/evmCalls";
import {
  addressWordValue,
  auctionErrorMessage,
  SIGNATURE_FUNDS_RECIPIENT,
  SIGNATURE_GRADUATIONS,
  SIGNATURE_IS_GRADUATED,
  SIGNATURE_LBP_INITIALIZATION_PARAMS,
  SIGNATURE_TOKENS_RECIPIENT,
  wordValue,
  words,
  type AuctionEffects,
  type AuctionSendCall,
  type AuctionTxReceipt,
} from "@/features/launchpad/lib/auctionFlow";

/** The `graduations(address)` record (GraduationExecutor.sol:34-45). */
export interface GraduationRecord {
  initialPriceX96: bigint;
  tokensSold: bigint;
  currencyRaised: bigint;
  reserveEscrow: bigint;
  treasuryShare: bigint;
  unsoldTokens: bigint;
  tokenMasterPool: string;
  executed: boolean;
}

/** Decode the 8-word `graduations(address)` getter return. */
export function decodeGraduationRecord(returnData: string): GraduationRecord {
  const w = words(returnData);
  if (w.length !== 8) {
    throw new Error(
      `expected 8 words from graduations(address), got ${w.length}`,
    );
  }
  return {
    initialPriceX96: wordValue(w[0]),
    tokensSold: wordValue(w[1]),
    currencyRaised: wordValue(w[2]),
    reserveEscrow: wordValue(w[3]),
    treasuryShare: wordValue(w[4]),
    unsoldTokens: wordValue(w[5]),
    tokenMasterPool: addressWordValue(w[6]),
    executed: wordValue(w[7]) !== 0n,
  };
}

/** The `executor.graduations(auction)` view call. */
export function buildGraduationsView(executor: string, auction: string) {
  return {
    to: executor,
    data: encodeFunctionData(SIGNATURE_GRADUATIONS, ["address"], [auction]),
  };
}

/** `lbpInitializationParams()` values (CCA.sol:9-13). */
export interface LbpParams {
  initialPriceX96: bigint;
  tokensSold: bigint;
  currencyRaised: bigint;
}

/** Decode the 3-word `lbpInitializationParams()` return. */
export function decodeLbpParams(returnData: string): LbpParams {
  const w = words(returnData);
  if (w.length !== 3) {
    throw new Error(
      `expected 3 words from lbpInitializationParams(), got ${w.length}`,
    );
  }
  return {
    initialPriceX96: wordValue(w[0]),
    tokensSold: wordValue(w[1]),
    currencyRaised: wordValue(w[2]),
  };
}

export type GraduationReadinessStatus =
  | "ready"
  | "running"
  | "threshold-missed"
  | "misconfigured";

export interface GraduationReadiness {
  status: GraduationReadinessStatus;
  /** The contract's actual gate, in plain words. */
  message: string;
  /** The GraduationExecutor (`fundsRecipient` — recovered from chain). */
  executor: string | null;
  /** `lbpInitializationParams()` values; null until the auction finalizes. */
  params: LbpParams | null;
  /** True when `executeGraduation` will finalize the end-block checkpoint itself. */
  finalizesOnExecute: boolean;
}

/** A readiness read that failed — names the exact check (rule 1). */
export class GraduationCheckError extends Error {
  readonly stage: "recipients" | "graduated" | "params" | "block";

  constructor(
    stage: "recipients" | "graduated" | "params" | "block",
    message: string,
  ) {
    super(message);
    this.name = "GraduationCheckError";
    this.stage = stage;
  }
}

/**
 * Readiness for `GraduationExecutor.executeGraduation(auction)` via `evm_call`
 * views, in the contract's own terms:
 * - `fundsRecipient()` / `tokensRecipient()` (CCA.sol:23-25) must both be the
 *   executor or `executeGraduation` reverts with typed misconfiguration errors
 *   (GraduationExecutor.sol:86-91) — surfaced as `misconfigured`, never sent;
 * - `isGraduated()` (CCA.sol:15) gates the sweep (GraduationExecutor.sol:79);
 * - `lbpInitializationParams()` (CCA.sol:17) is exactly what `executeGraduation`
 *   consumes (GraduationExecutor.sol:98-99) and is only readable once the
 *   auction is finalized AND graduated (ContinuousClearingAuction.sol:134-141)
 *   — its success IS "finalized + graduated + over".
 *
 * A graduated-but-unfinalized auction past its end block is reported `ready`
 * with `finalizesOnExecute` (the sweeps self-checkpoint the end block,
 * ContinuousClearingAuction.sol:91-95) so the recovery affordance is never
 * hidden behind a wait that never clears (Review-Proven Rule 6).
 */
export async function checkGraduationReadiness(input: {
  effects: Pick<AuctionEffects, "call" | "blockNumber">;
  auction: string;
  /** The launch record's `endBlock` (the value passed at deploy). */
  endBlock: number | null;
}): Promise<GraduationReadiness> {
  const { effects, auction, endBlock } = input;

  let fundsRecipient: string;
  let tokensRecipient: string;
  try {
    const [fundsRaw, tokensRaw] = await Promise.all([
      effects.call({
        to: auction,
        data: selectorOf(SIGNATURE_FUNDS_RECIPIENT),
      }),
      effects.call({
        to: auction,
        data: selectorOf(SIGNATURE_TOKENS_RECIPIENT),
      }),
    ]);
    fundsRecipient = addressWordValue(fundsRaw);
    tokensRecipient = addressWordValue(tokensRaw);
  } catch (error) {
    throw new GraduationCheckError(
      "recipients",
      `reading the auction's fundsRecipient()/tokensRecipient() failed: ${auctionErrorMessage(error)}`,
    );
  }
  if (fundsRecipient.toLowerCase() !== tokensRecipient.toLowerCase()) {
    return {
      status: "misconfigured",
      message:
        `This auction's recipients are misconfigured: fundsRecipient is ${fundsRecipient} but tokensRecipient is ${tokensRecipient}. ` +
        "executeGraduation requires BOTH to be the GraduationExecutor (GraduationExecutor.sol:86-91) and will revert — this launch must be redeployed with the executor as both recipients.",
      executor: fundsRecipient,
      params: null,
      finalizesOnExecute: false,
    };
  }

  let graduated: boolean;
  try {
    graduated = decodeBool(
      await effects.call({
        to: auction,
        data: selectorOf(SIGNATURE_IS_GRADUATED),
      }),
    );
  } catch (error) {
    throw new GraduationCheckError(
      "graduated",
      `reading the auction's isGraduated() failed: ${auctionErrorMessage(error)}`,
    );
  }

  let params: LbpParams | null = null;
  try {
    params = decodeLbpParams(
      await effects.call({
        to: auction,
        data: selectorOf(SIGNATURE_LBP_INITIALIZATION_PARAMS),
      }),
    );
  } catch {
    // A revert here is the EXPECTED pre-finalization state
    // (ContinuousClearingAuction.sol:136-137); the graduated/block reads below
    // (neither of which reverts) decide the honest verdict. Never fabricate.
  }

  if (graduated && params) {
    return {
      status: "ready",
      message:
        "Finalized and graduated — lbpInitializationParams() is readable, the exact gate executeGraduation consumes (GraduationExecutor.sol:98-99).",
      executor: fundsRecipient,
      params,
      finalizesOnExecute: false,
    };
  }

  let block: bigint;
  try {
    block = await effects.blockNumber();
  } catch (error) {
    throw new GraduationCheckError(
      "block",
      `reading the current block failed: ${auctionErrorMessage(error)}`,
    );
  }
  const over = endBlock !== null && block > BigInt(endBlock);

  if (graduated) {
    if (over) {
      return {
        status: "ready",
        message:
          "Graduated and past the end block — the end-block checkpoint is still pending, and the graduation call finalizes it itself (ContinuousClearingAuction.sol:91-95).",
        executor: fundsRecipient,
        params: null,
        finalizesOnExecute: true,
      };
    }
    return {
      status: "running",
      message:
        "The raise met the threshold (isGraduated() = true) but the auction is still running — graduation executes after the end block (the sweeps require the auction to be over, ContinuousClearingAuction.sol:663).",
      executor: fundsRecipient,
      params: null,
      finalizesOnExecute: false,
    };
  }
  if (over) {
    return {
      status: "threshold-missed",
      message:
        "Threshold not met — refunds path. The auction ended below its required raise, so there is nothing to graduate; bidders exit/claim refunds.",
      executor: fundsRecipient,
      params: null,
      finalizesOnExecute: false,
    };
  }
  return {
    status: "running",
    message:
      "Auction still running — isGraduated() is false; graduation executes after the end block.",
    executor: fundsRecipient,
    params: null,
    finalizesOnExecute: false,
  };
}

// ---------------------------------------------------------------------------
// 47005 receipts (`sweep` / `lock` vocabulary — plan §6 A2 / §C5)
// ---------------------------------------------------------------------------

/** 0x + 64 hex — the relay's `tx` tag contract (ingest.rs:2093-2100). */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Tags + content of a 47005 `sweep` receipt (net raise swept + treasury share). */
export function sweepReceiptParts(input: {
  auction: string;
  tx: string;
  currencyRaised: bigint;
  treasuryShare: bigint;
  unsoldTokens: bigint;
}): { extraTags: string[][]; content: Record<string, string> } {
  if (!TX_HASH_RE.test(input.tx)) {
    throw new Error(`receipt tx hash must be 0x + 64 hex: ${input.tx}`);
  }
  return {
    extraTags: [
      ["kind", "sweep"],
      ["tx", input.tx],
    ],
    content: {
      table: "sweep",
      auction: input.auction,
      currencyRaised: input.currencyRaised.toString(),
      treasuryShare: input.treasuryShare.toString(),
      unsoldTokens: input.unsoldTokens.toString(),
    },
  };
}

/** Tags + content of a 47005 `lock` receipt (reserve escrow for the TM floor). */
export function lockReceiptParts(input: {
  auction: string;
  tx: string;
  reserveEscrow: bigint;
}): { extraTags: string[][]; content: Record<string, string> } {
  if (!TX_HASH_RE.test(input.tx)) {
    throw new Error(`receipt tx hash must be 0x + 64 hex: ${input.tx}`);
  }
  return {
    extraTags: [
      ["kind", "lock"],
      ["tx", input.tx],
    ],
    content: {
      table: "lock",
      auction: input.auction,
      reserveEscrow: input.reserveEscrow.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Graduation flow state machine (money step vs. mirror steps, rule 1)
// ---------------------------------------------------------------------------

export const GRADUATION_STEPS = [
  {
    id: "execute",
    label: "Execute graduation",
    detail: "executor.executeGraduation(auction) — atomic sweep + split.",
  },
  {
    id: "mirrorSweep",
    label: "Publish sweep receipt",
    detail: "47005 sweep receipt, bound to the confirmed tx.",
  },
  {
    id: "mirrorLock",
    label: "Publish lock receipt",
    detail: "47005 lock receipt (reserve escrow), bound to the confirmed tx.",
  },
] as const;

export type GraduationStepId = (typeof GRADUATION_STEPS)[number]["id"];
export type GraduationStepStatus =
  | "pending"
  | "active"
  | "done"
  | "failed"
  | "skipped";

export type GraduationFlowPhase =
  | "idle"
  | "checking"
  | "not-ready"
  | "ready"
  | "running"
  | "failed"
  | "mirrorFailed"
  | "done";

export interface GraduationFlowState {
  phase: GraduationFlowPhase;
  readiness: GraduationReadiness | null;
  order: GraduationStepId[];
  steps: Record<GraduationStepId, GraduationStepStatus>;
  failedStep: GraduationStepId | null;
  /** Names the failed check/step and the reason (Review-Proven Rule 1). */
  errorMessage: string | null;
  /** The confirmed `executeGraduation` tx hash — the receipts' hash binding. */
  graduationTxHash: string | null;
}

export type GraduationFlowAction =
  | { type: "check_start" }
  | { type: "check_result"; readiness: GraduationReadiness }
  | { type: "check_failed"; message: string }
  | { type: "reset"; order: readonly GraduationStepId[] }
  | { type: "step-start"; step: GraduationStepId }
  | { type: "step-done"; step: GraduationStepId; txHash?: string }
  | { type: "step-failed"; step: GraduationStepId; message: string };

const ALL_GRADUATION_STEPS: readonly GraduationStepId[] = [
  "execute",
  "mirrorSweep",
  "mirrorLock",
];

function freshGraduationSteps(
  order: readonly GraduationStepId[],
): Record<GraduationStepId, GraduationStepStatus> {
  const steps = {} as Record<GraduationStepId, GraduationStepStatus>;
  for (const id of ALL_GRADUATION_STEPS) {
    steps[id] = order.includes(id) ? "pending" : "skipped";
  }
  return steps;
}

export function initialGraduationState(): GraduationFlowState {
  return {
    phase: "idle",
    readiness: null,
    order: [],
    steps: freshGraduationSteps([]),
    failedStep: null,
    errorMessage: null,
    graduationTxHash: null,
  };
}

/** Pure reducer — the production seam `auctionFlow.test.mjs` binds. */
export function graduationFlowReducer(
  state: GraduationFlowState,
  action: GraduationFlowAction,
): GraduationFlowState {
  switch (action.type) {
    case "check_start":
      return {
        ...state,
        phase: "checking",
        readiness: null,
        failedStep: null,
        errorMessage: null,
      };
    case "check_result":
      return {
        ...state,
        phase: action.readiness.status === "ready" ? "ready" : "not-ready",
        readiness: action.readiness,
        errorMessage: null,
      };
    case "check_failed":
      return {
        ...state,
        phase: "failed",
        readiness: null,
        failedStep: null,
        errorMessage: action.message,
      };
    case "reset": {
      const order = [...action.order];
      return {
        ...initialGraduationState(),
        phase: "ready",
        order,
        steps: freshGraduationSteps(order),
      };
    }
    case "step-start":
      return {
        ...state,
        phase: "running",
        steps: { ...state.steps, [action.step]: "active" },
        failedStep: null,
        errorMessage: null,
      };
    case "step-done": {
      const steps = { ...state.steps, [action.step]: "done" as const };
      const graduationTxHash =
        action.step === "execute" && action.txHash
          ? action.txHash
          : state.graduationTxHash;
      const allDone = state.order.every((id) => steps[id] === "done");
      return {
        ...state,
        phase: allDone ? "done" : "running",
        steps,
        graduationTxHash,
        failedStep: null,
        errorMessage: null,
      };
    }
    case "step-failed": {
      const moneyLanded = state.graduationTxHash !== null;
      const isMirror =
        action.step === "mirrorSweep" || action.step === "mirrorLock";
      return {
        ...state,
        phase: isMirror && moneyLanded ? "mirrorFailed" : "failed",
        steps: { ...state.steps, [action.step]: "failed" as const },
        failedStep: action.step,
        errorMessage: `${
          GRADUATION_STEPS.find((s) => s.id === action.step)?.label ??
          action.step
        } failed — ${action.message}`,
      };
    }
  }
}

/** What "retry" means (null = nothing to retry). */
export type GraduationRetryPlan =
  | { kind: "check" }
  | { kind: "execute" }
  | { kind: "mirror" }
  | null;

/**
 * Retry is always safe when offered:
 * - a check failure re-runs the readiness reads only;
 * - an execute failure re-runs ONLY the remaining steps and first re-reads the
 *   onchain `graduations(auction).executed` flag — an unknown outcome that
 *   actually landed is detected and never re-sent (`AlreadyExecuted` would
 *   revert, GraduationExecutor.sol:81);
 * - a mirror failure re-publishes only the missing receipts — the money action
 *   is NEVER re-sent (the confirmed tx hash is bound into the receipt tags).
 */
export function graduationRetryPlan(
  state: GraduationFlowState,
): GraduationRetryPlan {
  if (state.phase === "mirrorFailed") return { kind: "mirror" };
  if (state.phase === "failed") {
    return state.failedStep === null
      ? { kind: "check" }
      : state.failedStep === "execute"
        ? { kind: "execute" }
        : { kind: "mirror" };
  }
  return null;
}

/** Injected I/O for {@link runGraduationFlow}; tests script fakes here. */
export interface GraduationDeps {
  send(call: AuctionSendCall): Promise<AuctionTxReceipt>;
  /** Read `executor.graduations(auction)` (also the idempotency guard). */
  readGraduation(): Promise<GraduationRecord>;
  /**
   * Publish one 47005 receipt via `usePublishLaunchMirrorMutation` with the
   * `tx` tag already bound inside `parts`.
   */
  publishReceipt(
    kind: "sweep" | "lock",
    parts: { extraTags: string[][]; content: Record<string, string> },
  ): Promise<unknown>;
}

/** Everything one graduation attempt needs; re-runnable for retries. */
export interface GraduationExecution {
  auction: string;
  executor: string;
  /** The `executor.executeGraduation(auction)` money call (evmCalls). */
  call: AuctionSendCall;
}

function graduationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run (or resume) one graduation: the single atomic `executeGraduation` money
 * call, then the 47005 `sweep` + `lock` receipts bound to its confirmed hash.
 * Completed steps are never re-sent; a mirror-only retry sends zero
 * transactions. Every failure names its step and distinguishes the money step
 * from the mirrors.
 */
export async function runGraduationFlow(
  execution: GraduationExecution,
  deps: GraduationDeps,
  dispatch: (action: GraduationFlowAction) => void,
  resume: {
    completed: ReadonlySet<GraduationStepId>;
    graduationTxHash: string | null;
  } = {
    completed: new Set(),
    graduationTxHash: null,
  },
): Promise<void> {
  let graduationTxHash = resume.graduationTxHash;

  if (!resume.completed.has("execute")) {
    dispatch({ type: "step-start", step: "execute" });
    let record: GraduationRecord;
    try {
      record = await deps.readGraduation();
    } catch (error) {
      dispatch({
        type: "step-failed",
        step: "execute",
        message: `reading the onchain graduation record failed before sending anything: ${graduationErrorMessage(error)}`,
      });
      return;
    }
    if (record.executed) {
      // An earlier attempt's unknown-outcome tx landed — never re-send
      // (executeGraduation would revert AlreadyExecuted).
      dispatch({
        type: "step-done",
        step: "execute",
        ...(graduationTxHash ? { txHash: graduationTxHash } : {}),
      });
    } else {
      let receipt: AuctionTxReceipt;
      try {
        receipt = await deps.send(execution.call);
      } catch (error) {
        dispatch({
          type: "step-failed",
          step: "execute",
          message: `${graduationErrorMessage(error)} — the transaction may or may not have been broadcast; retry first re-checks the onchain graduation record`,
        });
        return;
      }
      if (receipt.status !== "success") {
        dispatch({
          type: "step-failed",
          step: "execute",
          message: `the transaction reverted onchain (tx ${receipt.txHash}, block ${receipt.blockNumber})`,
        });
        return;
      }
      graduationTxHash = receipt.txHash;
      dispatch({ type: "step-done", step: "execute", txHash: receipt.txHash });
    }
  }

  const mirrors: GraduationStepId[] = ["mirrorSweep", "mirrorLock"];
  const remaining = mirrors.filter((id) => !resume.completed.has(id));
  if (remaining.length === 0) return;

  if (graduationTxHash === null) {
    // Rule 1: name it — the graduation is complete onchain but its hash is
    // unknown, so the receipts cannot be bound (the relay requires one `tx`
    // tag, ingest.rs:2111-2114).
    dispatch({
      type: "step-failed",
      step: remaining[0],
      message:
        "the graduation is executed onchain but this session has no confirmed transaction hash to bind the receipts to (the earlier attempt's receipt was never received) — receipts cannot be published without it",
    });
    return;
  }

  let record: GraduationRecord;
  try {
    record = await deps.readGraduation();
  } catch (error) {
    dispatch({
      type: "step-failed",
      step: remaining[0],
      message: `reading the onchain graduation record (for the receipt amounts) failed: ${graduationErrorMessage(error)} — the graduation itself is complete (tx ${graduationTxHash})`,
    });
    return;
  }
  if (!record.executed) {
    dispatch({
      type: "step-failed",
      step: remaining[0],
      message: `the onchain graduation record does not show the graduation as executed although tx ${graduationTxHash} confirmed — refusing to publish receipts for it`,
    });
    return;
  }

  for (const mirror of remaining) {
    dispatch({ type: "step-start", step: mirror });
    if (mirror === "mirrorSweep") {
      const parts = sweepReceiptParts({
        auction: execution.auction,
        tx: graduationTxHash,
        currencyRaised: record.currencyRaised,
        treasuryShare: record.treasuryShare,
        unsoldTokens: record.unsoldTokens,
      });
      try {
        await deps.publishReceipt("sweep", parts);
      } catch (error) {
        dispatch({
          type: "step-failed",
          step: "mirrorSweep",
          message: `${graduationErrorMessage(error)} — the graduation is complete (tx ${graduationTxHash}); retry re-publishes the receipt only`,
        });
        return;
      }
      dispatch({ type: "step-done", step: "mirrorSweep" });
    } else {
      const parts = lockReceiptParts({
        auction: execution.auction,
        tx: graduationTxHash,
        reserveEscrow: record.reserveEscrow,
      });
      try {
        await deps.publishReceipt("lock", parts);
      } catch (error) {
        dispatch({
          type: "step-failed",
          step: "mirrorLock",
          message: `${graduationErrorMessage(error)} — the graduation is complete (tx ${graduationTxHash}); retry re-publishes the receipt only`,
        });
        return;
      }
      dispatch({ type: "step-done", step: "mirrorLock" });
    }
  }
}
