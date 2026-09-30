/**
 * The exit/claim step orchestrator: a pure reducer plus a dependency-injected
 * runner. Port of desktop `exitHooks.ts`' flow section (lines 900-1105), which
 * mirrors `bidHooks.ts`' bidFlowReducer/runBidFlow. Web's money-action flows
 * share this machine's contract:
 *
 * - every failure names its step (Review-Proven Rule 1) — the step vocabulary
 *   is the closed set {checkpoint, exit, claim} here and
 *   {deploy, validator, ruleset, link} in `mint-flow.ts`, where `link` is the
 *   mirror-only record write-back;
 * - a mined revert resolves as `status: "reverted"` receipt data and is a
 *   failed step, never a silent success;
 * - retry re-sends only the remaining steps — completed steps are never
 *   re-sent (Review-Proven Rule 5 prefix-consistency), so a mirror/link-only
 *   failure can never re-send the money action (`mint-flow.ts`'s
 *   `retryPlan` is the production consumer of that rule).
 *
 * Send strategy (documented per the launchpad money-action contract): the
 * composer in `my-bids.ts` emits the same `UnsignedTx` list for every sender.
 * Both `identity/lib/sponsoredSender.ts` (one batched UserOp per `sendCalls`,
 * atomic) and `lib/wallet-sender.ts` (one `eth_sendTransaction` per call,
 * sequential) receive those bytes unmodified. This runner sends ONE step per
 * `sendCalls` invocation because `checkpointThenExit` must re-derive the exit
 * hints after the checkpoint lands (Review-Proven Rule 2) — the calls of the
 * two-step plan are never composed ahead of the checkpoint.
 */
import type {
  SendCallsResult,
  SenderCall,
} from "../../identity/lib/sponsoredSender.ts";
import type { UnsignedTx } from "./bid-tx.ts";
import type { ExitStepCall, ExitStepId } from "./my-bids.ts";
import { EXIT_STEP_LABELS } from "./my-bids.ts";

/**
 * The receipt contract of one sent step. `status: "reverted"` is a mined
 * revert (failed step, data not exception); a thrown send error is reported as
 * `unknown` at the mint layer and as a named failure here.
 */
export interface FlowReceipt {
  txHash: string;
  status: "success" | "reverted" | "unknown";
}

/** Per-step status. `skipped` = not part of this plan. */
export type ExitStepStatus =
  | "pending"
  | "active"
  | "done"
  | "failed"
  | "skipped";

/**
 * - `idle`: no attempt started.
 * - `running`: a step is in flight.
 * - `failed`: a step failed; retry sends only the remaining steps.
 * - `done`: every step confirmed.
 */
export type ExitFlowPhase = "idle" | "running" | "failed" | "done";

/** The full observable state of one exit/claim attempt. */
export interface ExitFlowState {
  phase: ExitFlowPhase;
  /** Planned step order. */
  order: ExitStepId[];
  steps: Record<ExitStepId, ExitStepStatus>;
  receipts: Partial<Record<ExitStepId, FlowReceipt>>;
  failedStep: ExitStepId | null;
  /** Names the failed step and the reason (Review-Proven Rule 1). */
  errorMessage: string | null;
}

/** State transition events, emitted by {@link runExitFlow}. */
export type ExitFlowAction =
  | { type: "reset"; order: readonly ExitStepId[] }
  | { type: "step-start"; step: ExitStepId }
  | { type: "step-done"; step: ExitStepId; receipt?: FlowReceipt }
  | { type: "step-failed"; step: ExitStepId; message: string };

const ALL_STEP_IDS: readonly ExitStepId[] = ["checkpoint", "exit", "claim"];

function freshSteps(
  order: readonly ExitStepId[],
): Record<ExitStepId, ExitStepStatus> {
  const steps = {} as Record<ExitStepId, ExitStepStatus>;
  for (const id of ALL_STEP_IDS) {
    steps[id] = order.includes(id) ? "pending" : "skipped";
  }
  return steps;
}

/** The state before any attempt: nothing planned, nothing sent. */
export function initialExitFlowState(): ExitFlowState {
  return {
    phase: "idle",
    order: [],
    steps: freshSteps([]),
    receipts: {},
    failedStep: null,
    errorMessage: null,
  };
}

/** Pure step-orchestrator reducer (port of exitHooks.ts:963-1011). */
export function exitFlowReducer(
  state: ExitFlowState,
  action: ExitFlowAction,
): ExitFlowState {
  switch (action.type) {
    case "reset": {
      const order = [...action.order];
      return {
        ...initialExitFlowState(),
        order,
        steps: freshSteps(order),
      };
    }
    case "step-start": {
      return {
        ...state,
        phase: "running",
        steps: { ...state.steps, [action.step]: "active" },
        failedStep: null,
        errorMessage: null,
      };
    }
    case "step-done": {
      const steps = { ...state.steps, [action.step]: "done" as const };
      const receipts = action.receipt
        ? { ...state.receipts, [action.step]: action.receipt }
        : state.receipts;
      const allDone = state.order.every((id) => steps[id] === "done");
      return {
        ...state,
        phase: allDone ? "done" : "running",
        steps,
        receipts,
        failedStep: null,
        errorMessage: null,
      };
    }
    case "step-failed": {
      return {
        ...state,
        phase: "failed",
        steps: { ...state.steps, [action.step]: "failed" as const },
        failedStep: action.step,
        errorMessage: `${EXIT_STEP_LABELS[action.step]} failed — ${action.message}`,
      };
    }
  }
}

/** Steps not yet confirmed done — exactly what a retry will (re-)send. */
export function remainingExitSteps(state: ExitFlowState): ExitStepId[] {
  return state.order.filter((id) => state.steps[id] !== "done");
}

/** Steps already confirmed done — never re-sent on retry. */
export function completedExitSteps(state: ExitFlowState): Set<ExitStepId> {
  return new Set(state.order.filter((id) => state.steps[id] === "done"));
}

/** Where a retry picks up. */
export interface ExitResume {
  completed: ReadonlySet<ExitStepId>;
}

/** Derive the {@link ExitResume} for {@link runExitFlow} from the state. */
export function resumeExitFromState(state: ExitFlowState): ExitResume {
  return { completed: completedExitSteps(state) };
}

/** Injected I/O for {@link runExitFlow}; tests script fakes here. */
export interface ExitFlowDeps {
  send: (call: UnsignedTx) => Promise<FlowReceipt>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "the request failed";
}

/**
 * Run (or resume) one exit/claim attempt: build + send each remaining step in
 * order. Dispatches every transition through `dispatch`; stops at the first
 * failure and names it. `resume.completed` steps are never re-sent.
 */
export async function runExitFlow(
  execution: { calls: readonly ExitStepCall[] },
  deps: ExitFlowDeps,
  dispatch: (action: ExitFlowAction) => void,
  resume: ExitResume = { completed: new Set() },
): Promise<void> {
  for (const entry of execution.calls) {
    if (resume.completed.has(entry.step)) continue;
    dispatch({ type: "step-start", step: entry.step });
    let call: UnsignedTx;
    try {
      call = await entry.build();
    } catch (err) {
      dispatch({
        type: "step-failed",
        step: entry.step,
        message: errorMessage(err),
      });
      return;
    }
    let receipt: FlowReceipt;
    try {
      receipt = await deps.send(call);
    } catch (err) {
      // Rule 1: the failure names its step; nothing downstream is attempted.
      dispatch({
        type: "step-failed",
        step: entry.step,
        message: errorMessage(err),
      });
      return;
    }
    if (receipt.status !== "success") {
      // A mined revert (or unknown outcome) is a failed step — data, not an
      // exception, and never a silent success.
      dispatch({
        type: "step-failed",
        step: entry.step,
        message: `the transaction reverted onchain (tx ${receipt.txHash})`,
      });
      return;
    }
    dispatch({ type: "step-done", step: entry.step, receipt });
  }
}

/**
 * Bind a {@link CallSender} to {@link ExitFlowDeps}' one-call send. One
 * `sendCalls` per step keeps the re-derivation window of `checkpointThenExit`
 * and gives per-step receipts; the call bytes reach the sender unmodified.
 */
export function senderFlowDeps(sender: {
  sendCalls(calls: SenderCall[]): Promise<SendCallsResult>;
}): ExitFlowDeps {
  return {
    async send(call) {
      const result = await sender.sendCalls([toSenderCall(call)]);
      // Both adapters resolve only on an accepted send ("confirmed" when the
      // sponsored path saw the receipt, "submitted" for a wallet hash). A
      // mined revert surfaces as a thrown send error on the sponsored path or
      // as state that does not move after refetch — the reducer's
      // `status: "reverted"` contract stays for adapters that surface it.
      return { txHash: result.txHash, status: "success" };
    },
  };
}

/** `UnsignedTx` → the sender seam's `SenderCall`, byte-preserving. */
export function toSenderCall(call: UnsignedTx): SenderCall {
  return { to: call.to, data: call.data, value: call.value };
}
