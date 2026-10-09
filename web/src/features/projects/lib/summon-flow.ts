/**
 * The summon step orchestrator: a pure reducer plus a dependency-injected
 * runner, the money-action contract of `launchpad/lib/ragequit-flow.ts`
 * (which mirrors `exit-flow.ts`) applied to the DAO-forming transaction:
 *
 * - the step vocabulary is the closed pair `{"send", "mirror"}`; every
 *   failure names its step (Review-Proven Rule 1) — `mirror` is the
 *   record-only write-back of the kind:47005 `summon` receipt;
 * - a mined revert resolves as receipt *data* (`status: "reverted"`) and
 *   fails the step — never a silent success — and an outcome the chain never
 *   reported within the poll budget is `unknown`, also a failure, never an
 *   assumed success;
 * - retry re-sends only the remaining steps (Review-Proven Rule 5): a
 *   mirror-only failure can NEVER re-send the summon. Summoning is not
 *   idempotent — a second `summon` would CREATE2-revert on the same salt
 *   (`Moloch.sol:2078-2086`) or, worse, publish a second DAO for one map —
 *   so `send` is terminal-failed once attempted;
 * - the mirror is legibility, not money: if the tx landed and the receipt
 *   write-back failed, the state still holds the summon receipt (tx, dao)
 *   and the failure names `mirror`, so the UI can show "the DAO was formed —
 *   the record did not" with the raw hash instead of pretending either.
 *
 * Send strategy (same contract as `ragequit-flow.ts`): the composer emits the
 * same call bytes for every sender; `identity/lib/sponsoredSender.ts` and
 * `launchpad/lib/wallet-sender.ts` receive those bytes unmodified (parity is
 * tested in `summon-flow.test.mjs`).
 */
import type {
  SendCallsResult,
  SenderCall,
} from "../../identity/lib/sponsoredSender.ts";
import {
  createStepFlow,
  type StepFlowAction,
  type StepFlowState,
} from "@creaton/core/launchpad/step-flow.ts";
import type { SummonTx } from "./summon-composer.ts";
import type { ConfirmedSummon } from "./summon-chain.ts";

/** What one sent step resolved to. `dao` is null when the log never said. */
export interface SummonReceipt extends ConfirmedSummon {
  txHash: string;
}

export type SummonStepId = "send" | "mirror";

export const SUMMON_STEP_LABELS: Record<SummonStepId, string> = {
  send: "Create the DAO onchain and issue its shares",
  mirror: "Record the new DAO on the launch",
};

/** The plan, in order: the money write first, its record second. */
export const SUMMON_ORDER: readonly SummonStepId[] = ["send", "mirror"];

export type SummonFlowAction = StepFlowAction<SummonStepId, SummonReceipt>;

export type SummonFlowState = StepFlowState<SummonStepId, SummonReceipt> & {
  /**
   * A summon tx whose outcome the chain never reported. The tx may still land,
   * so the flow will not send again until the user reconciles onchain
   * (Review-Proven Rule 4: a retry loop needs a terminal state — this is it).
   */
  reconcile: boolean;
};

const summonFlow = createStepFlow<SummonStepId, SummonReceipt>(
  SUMMON_ORDER,
  SUMMON_STEP_LABELS,
);

export function initialSummonFlowState(): SummonFlowState {
  return { ...summonFlow.initial(), reconcile: false };
}

/** Pure step-orchestrator reducer (contract of `step-flow.ts`). */
export function summonFlowReducer(
  state: SummonFlowState,
  action: SummonFlowAction,
): SummonFlowState {
  const reconcile =
    action.type !== "reset" &&
    (state.reconcile ||
      (action.type === "step-failed" &&
        action.step === "send" &&
        action.receipt?.status === "unknown"));
  return { ...summonFlow.reducer(state, action), reconcile };
}

/** Steps not yet confirmed done — what a retry may still run. */
export const remainingSummonSteps = summonFlow.remaining;

export const completedSummonSteps = summonFlow.completed;

export interface SummonResume {
  completed: ReadonlySet<SummonStepId>;
  /** True once a summon tx reported an unknown outcome — do not send again. */
  reconcile: boolean;
  /** The tx hash left by that unknown outcome, when there is one. */
  priorReceipt?: SummonReceipt;
}

export function resumeSummonFromState(state: SummonFlowState): SummonResume {
  return {
    completed: completedSummonSteps(state),
    reconcile: state.reconcile,
    ...(state.receipts.send ? { priorReceipt: state.receipts.send } : {}),
  };
}

/** Injected I/O; tests script fakes here. */
export interface SummonFlowDeps {
  send: (call: SummonTx) => Promise<SummonReceipt>;
  /** Publish the kind:47005 `summon` receipt for a confirmed summon. */
  publishReceipt: (receipt: SummonReceipt) => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "the request failed";
}

/** The human form of a send outcome — data, never an exception. */
export function summonOutcomeMessage(receipt: SummonReceipt): string | null {
  if (receipt.status === "success") return null;
  if (receipt.status === "reverted") {
    return `the transaction failed onchain (tx ${receipt.txHash})`;
  }
  return `the outcome of transaction ${receipt.txHash} is still unknown${
    receipt.reason ? ` (${receipt.reason})` : ""
  }. Check whether it landed before retrying; nothing was recorded`;
}

/**
 * Run (or resume) one attempt.
 *
 * - `send` builds + sends the summon. Its three outcomes behave
 *   differently: a confirmed send is *done* and a resume skips it (only the
 *   record leg runs); a mined revert means nothing landed, so a resume may
 *   re-send; an unknown outcome sets `reconcile`, and every later attempt
 *   stops at the terminal guard below instead of sending again.
 * - `mirror` runs only with a send receipt — fresh from this run, or carried
 *   in on a resume (`entry.receipt` / `resume.priorReceipt`). A mirror failure
 *   leaves the receipt in state and is retryable WITHOUT re-sending the money.
 */
export async function runSummonFlow(
  execution: { calls: readonly SummonStepCall[] },
  deps: SummonFlowDeps,
  dispatch: (action: SummonFlowAction) => void,
  resume: SummonResume = { completed: new Set(), reconcile: false },
): Promise<void> {
  // Terminal state: an unmined-then-maybe-mined summon is reconciled onchain,
  // never re-sent — a second call would either CREATE2-revert on the same salt
  // (`Moloch.sol:2078-2086`) or summon a second DAO for one equity map.
  if (resume.reconcile) {
    const prior = resume.priorReceipt;
    dispatch({
      type: "step-failed",
      step: "send",
      message: summonOutcomeMessage(
        prior ?? {
          txHash: "unknown tx",
          status: "unknown",
          dao: null,
          blockNumber: null,
        },
      ) as string,
      ...(prior ? { receipt: prior } : {}),
    });
    return;
  }
  let sendReceipt: SummonReceipt | null = null;
  for (const entry of execution.calls) {
    if (resume.completed.has(entry.step)) continue;
    dispatch({ type: "step-start", step: entry.step });
    if (entry.step === "mirror") {
      // Fresh run: the send just resolved in this call. Resume: the receipt
      // comes from the plan (`entry.receipt`) or from the state the resume
      // was built from (`resume.priorReceipt`) — never re-derived, never lost.
      const record =
        sendReceipt ?? entry.receipt ?? resume.priorReceipt ?? null;
      if (!record) {
        dispatch({
          type: "step-failed",
          step: "mirror",
          message: "no confirmed summon to record",
        });
        return;
      }
      try {
        await deps.publishReceipt(record);
      } catch (err) {
        dispatch({
          type: "step-failed",
          step: "mirror",
          message: `${errorMessage(err)}. The summon itself landed (tx ${record.txHash}); retrying records it without sending again.`,
        });
        return;
      }
      dispatch({ type: "step-done", step: "mirror", receipt: record });
      continue;
    }
    let call: SummonTx;
    try {
      call = await entry.build();
    } catch (err) {
      dispatch({
        type: "step-failed",
        step: "send",
        message: errorMessage(err),
      });
      return;
    }
    let receipt: SummonReceipt;
    try {
      receipt = await deps.send(call);
    } catch (err) {
      dispatch({
        type: "step-failed",
        step: "send",
        message: errorMessage(err),
      });
      return;
    }
    const outcome = summonOutcomeMessage(receipt);
    if (outcome) {
      dispatch({
        type: "step-failed",
        step: "send",
        message: outcome,
        receipt,
      });
      return;
    }
    sendReceipt = receipt;
    dispatch({ type: "step-done", step: "send", receipt });
  }
}

/** One planned step. */
export type SummonStepCall =
  | { step: "send"; build: () => Promise<SummonTx> | SummonTx }
  | {
      step: "mirror";
      /** The confirmed send receipt to record (required on a resume). */
      receipt?: SummonReceipt;
    };

/**
 * Build the standard plan: the summon first, then the record write-back. On a
 * resume that re-records only, pass the prior send receipt (`fromState`).
 */
export function buildSummonPlan(input: {
  buildTx: () => SummonTx | Promise<SummonTx>;
  priorReceipt?: SummonReceipt;
}): { order: SummonStepId[]; calls: SummonStepCall[] } {
  return {
    order: [...SUMMON_ORDER],
    calls: [
      { step: "send", build: input.buildTx },
      { step: "mirror", receipt: input.priorReceipt },
    ],
  };
}

/**
 * Bind a `CallSender` to this flow: the composed bytes reach the sender
 * unmodified, the outcome is read back from the chain (bounded), and the
 * confirmed receipt is what the mirror records.
 */
export function senderSummonDeps(
  sender: {
    sendCalls(calls: SenderCall[]): Promise<SendCallsResult>;
  },
  confirm: (txHash: string) => Promise<ConfirmedSummon>,
  publishReceipt: SummonFlowDeps["publishReceipt"],
): SummonFlowDeps {
  return {
    async send(call) {
      const result = await sender.sendCalls([
        { to: call.to, data: call.data, value: call.value },
      ]);
      const confirmed = await confirm(result.txHash);
      return {
        txHash: result.txHash,
        status: confirmed.status,
        dao: confirmed.dao,
        blockNumber: confirmed.blockNumber,
        ...(confirmed.reason ? { reason: confirmed.reason } : {}),
      };
    },
    publishReceipt,
  };
}
