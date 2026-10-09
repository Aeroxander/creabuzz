/**
 * The ragequit step orchestrator: a pure reducer plus a dependency-injected
 * runner, mirroring the launchpad money-action contract of `exit-flow.ts`
 * (which mirrors desktop `bidHooks.ts`' bidFlowReducer/runBidFlow):
 *
 * - every failure names its step (Review-Proven Rule 1) — the step vocabulary
 *   here is the closed set {"exit", "mirror"}, where `mirror` is the
 *   record-only write-back (mint-flow.ts calls the same slot `link`);
 * - a mined revert resolves as `status: "reverted"` receipt data and is a
 *   failed step, never a silent success;
 * - retry re-sends only the remaining steps (Review-Proven Rule 5
 *   prefix-consistency): a mirror-only failure can NEVER re-send the burn —
 *   ragequit is not idempotent (it burns the holder's tokens), so the `exit`
 *   step is terminal-failed once a send has been attempted and is never
 *   blindly re-run from a resume;
 * - the mirror is best-effort money legibility, not money: if the tx landed
 *   and the record write-back failed, the state still holds the exit receipt
 *   and the failure names `mirror`, so the UI can show "the exit landed — the
 *   Nostr record did not" with the raw tx hash instead of pretending either
 *   success or loss.
 *
 * Send strategy (same contract as exit-flow.ts): the composer emits the same
 * call bytes for every sender; `identity/lib/sponsoredSender.ts` and
 * `lib/wallet-sender.ts` receive those bytes unmodified (sender parity is
 * tested in `ragequit-flow.test.mjs`).
 */
import {
  createStepFlow,
  type StepFlowAction,
  type StepFlowState,
} from "@creaton/core/launchpad/step-flow.ts";
import type {
  SendCallsResult,
  SenderCall,
} from "../../identity/lib/sponsoredSender.ts";
import { flowOutcomeMessage } from "./exit-flow.ts";
import type { FlowReceipt } from "./exit-flow.ts";
import type { RagequitTx } from "./ragequit-tx.ts";

/**
 * The closed step vocabulary:
 * - `exit`: the `ragequit` tx (burn shares + claim the pools).
 * - `mirror`: the kind:47005 `ragequit` receipt (NIP-LP's word for this
 *   action) — the record-only write-back.
 */
export type RagequitStepId = "exit" | "mirror";

export const RAGEQUIT_STEP_LABELS: Record<RagequitStepId, string> = {
  exit: "Exit onchain: give up your shares and take your part of the treasury",
  mirror: "Record the exit on the launch",
};

export type RagequitFlowState = StepFlowState<RagequitStepId, FlowReceipt>;

export type RagequitFlowAction = StepFlowAction<RagequitStepId, FlowReceipt>;

const ragequitFlow = createStepFlow<RagequitStepId, FlowReceipt>(
  ["exit", "mirror"],
  RAGEQUIT_STEP_LABELS,
);

export const initialRagequitFlowState = ragequitFlow.initial;

/** Pure step-orchestrator reducer (contract of exit-flow.ts). */
export const ragequitFlowReducer = ragequitFlow.reducer;

/** Steps not yet confirmed done — what a retry may still run. */
export const remainingRagequitSteps = ragequitFlow.remaining;

export const completedRagequitSteps = ragequitFlow.completed;

export interface RagequitResume {
  completed: ReadonlySet<RagequitStepId>;
}

export function resumeRagequitFromState(
  state: RagequitFlowState,
): RagequitResume {
  return { completed: completedRagequitSteps(state) };
}

/** Injected I/O; tests script fakes here. */
export interface RagequitFlowDeps {
  send: (call: RagequitTx) => Promise<FlowReceipt>;
  /** Publish the kind:47005 `ragequit` receipt for a confirmed exit. */
  publishReceipt: (receipt: FlowReceipt) => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "the request failed";
}

/**
 * Run (or resume) one exit attempt.
 *
 * - `exit` builds + sends the burn; the send is terminal — once attempted it
 *   is never re-run from a resume (`resume.completed`), because a submitted
 *   tx that failed to confirm must be reconciled onchain, not re-sent
 *   (Review-Proven Rule 1 / the money-send contract in exit-flow.ts:207-212).
 * - `mirror` runs only with a confirmed exit receipt — fresh from this run's
 *   `exit` step, or supplied via `entry.receipt` on a resume. A mirror failure
 *   leaves the exit receipt in state (the UI can always show the raw tx) and
 *   is retryable WITHOUT re-sending the money.
 */
export async function runRagequitFlow(
  execution: { calls: readonly RagequitStepCall[] },
  deps: RagequitFlowDeps,
  dispatch: (action: RagequitFlowAction) => void,
  resume: RagequitResume = { completed: new Set() },
): Promise<void> {
  let exitReceipt: FlowReceipt | null = null;
  for (const entry of execution.calls) {
    if (resume.completed.has(entry.step)) continue;
    dispatch({ type: "step-start", step: entry.step });
    if (entry.step === "mirror") {
      const record = exitReceipt ?? entry.receipt ?? null;
      if (!record) {
        dispatch({
          type: "step-failed",
          step: "mirror",
          message: "no confirmed exit to record",
        });
        return;
      }
      try {
        await deps.publishReceipt(record);
      } catch (err) {
        // Record-only failure: the exit itself is NOT rolled back or re-sent;
        // the named step is the record, and the exit receipt is already in
        // state when the exit confirmed (partial-failure honesty).
        dispatch({
          type: "step-failed",
          step: "mirror",
          message: `${errorMessage(err)}. The exit itself landed (tx ${record.txHash}); retrying records it without sending again.`,
        });
        return;
      }
      dispatch({ type: "step-done", step: "mirror", receipt: record });
      continue;
    }
    let call: RagequitTx;
    try {
      call = await entry.build();
    } catch (err) {
      dispatch({
        type: "step-failed",
        step: "exit",
        message: errorMessage(err),
      });
      return;
    }
    let receipt: FlowReceipt;
    try {
      receipt = await deps.send(call);
    } catch (err) {
      dispatch({
        type: "step-failed",
        step: "exit",
        message: errorMessage(err),
      });
      return;
    }
    if (receipt.status !== "success") {
      // A mined revert (or unknown outcome) is a failed step — data, not an
      // exception, and never a silent success.
      dispatch({
        type: "step-failed",
        step: "exit",
        message: flowOutcomeMessage(receipt),
      });
      return;
    }
    exitReceipt = receipt;
    dispatch({ type: "step-done", step: "exit", receipt });
  }
}

/** One planned step. */
export type RagequitStepCall =
  | { step: "exit"; build: () => Promise<RagequitTx> | RagequitTx }
  | {
      step: "mirror";
      /** The confirmed exit receipt to record (required on a resume). */
      receipt?: FlowReceipt;
    };

/**
 * Build the standard plan: exit first, then the record write-back. On a
 * resume that re-records only, pass the prior exit receipt (`fromState`).
 */
export function buildRagequitPlan(input: {
  buildTx: () => RagequitTx | Promise<RagequitTx>;
  priorExitReceipt?: FlowReceipt;
}): { order: RagequitStepId[]; calls: RagequitStepCall[] } {
  return {
    order: ["exit", "mirror"],
    calls: [
      { step: "exit", build: input.buildTx },
      { step: "mirror", receipt: input.priorExitReceipt },
    ],
  };
}

/**
 * Bind a `CallSender` to this flow's one-call send — the composed bytes reach
 * the sender unmodified (parity test in `ragequit-flow.test.mjs`).
 */
export function senderRagequitDeps(
  sender: {
    sendCalls(calls: SenderCall[]): Promise<SendCallsResult>;
  },
  publishReceipt: RagequitFlowDeps["publishReceipt"],
): RagequitFlowDeps {
  return {
    async send(call) {
      const result = await sender.sendCalls([
        { to: call.to, data: call.data, value: call.value },
      ]);
      return { txHash: result.txHash, status: "success" };
    },
    publishReceipt,
  };
}
