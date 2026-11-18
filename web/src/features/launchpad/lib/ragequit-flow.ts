/**
 * The ragequit step orchestrator: a pure reducer plus a dependency-injected
 * runner, mirroring the launchpad money-action contract of `exit-flow.ts`
 * (which mirrors desktop `bidHooks.ts`' bidFlowReducer/runBidFlow):
 *
 * - every failure names its step (Review-Proven Rule 1) — the step vocabulary
 *   here is the closed set {"exit", "mirror"}, where `mirror` is the
 *   record-only write-back;
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
import type { SenderCall } from "../../identity/lib/sponsoredSender.ts";
import { StepRevertedError } from "./acting-account.ts";
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
  exit: "Leave: your Shares are destroyed and your part is paid out",
  mirror: "Save a record of it on this project",
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
          message: "there is no confirmed exit to record",
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
          message: `${errorMessage(err)}. The exit itself went through (confirmation ID ${record.txHash}); trying again only saves the record and does not send the exit again.`,
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
 * Bind a confirmed send to this flow's one-call send. `send` resolves only once the call landed and succeeded (the
 * acting account's `sendCalls`, or `sendPicked`), so its hash is a success; a step the chain refused
 * (`StepRevertedError`) is a reverted receipt, never "Exit confirmed". A sender that only hands back a hash it submitted
 * cannot be bound here (D144): that is how a wallet on the wrong network once read as a confirmed exit. The composed
 * bytes reach the send unmodified (parity test in `ragequit-flow.test.mjs`).
 */
export function confirmedRagequitDeps(
  send: (calls: SenderCall[]) => Promise<string>,
  publishReceipt: RagequitFlowDeps["publishReceipt"],
): RagequitFlowDeps {
  return {
    async send(call) {
      try {
        const txHash = await send([
          { to: call.to, data: call.data, value: call.value },
        ]);
        return { txHash, status: "success" };
      } catch (error) {
        if (error instanceof StepRevertedError) {
          return { txHash: error.txHash, status: "reverted" };
        }
        throw error;
      }
    },
    publishReceipt,
  };
}

/**
 * Wrap the flow's `dispatch` so `onExitLanded` runs once, the moment the exit step is confirmed: what the page shows
 * about Shares and money is re-read then, even when saving the record afterwards fails (D144).
 */
export function onExitLanded(
  dispatch: (action: RagequitFlowAction) => void,
  landed: () => void,
): (action: RagequitFlowAction) => void {
  let fired = false;
  return (action) => {
    dispatch(action);
    if (!fired && action.type === "step-done" && action.step === "exit") {
      fired = true;
      landed();
    }
  };
}

/** The holder's Shares as read from the chain: all they hold, and what can leave now (locked team Shares cannot). */
export interface FreshShares {
  sharesBalance: bigint;
  sharesBurnable: bigint;
}

/** What pressing Leave does, decided from the holder's position read from the chain just before (see {@link firstExit}). */
export type ExitCheck =
  /** Send it, burning `burn`; `balanceBefore` is what the holder held just before, so a retry can tell it landed. */
  | { kind: "send"; burn: bigint; balanceBefore: bigint }
  /** What can leave now is not what the dialog showed and the person agreed to: nothing is sent, they confirm again. */
  | { kind: "changed"; burnable: bigint }
  /** The position could not be read, so nothing is sent. */
  | { kind: "unknown" };

/**
 * Before the first send. The dialog shows what the page read earlier, and Shares can arrive since (an award vote that
 * runs mints them), so the position is read from the chain first: the exit burns exactly what the dialog showed, and
 * is refused when that is no longer what can leave. The balance read here, not the page's, is what a retry compares.
 */
export function firstExit(input: {
  /** The Shares the dialog showed, and the person agreed to give up. */
  shown: bigint;
  /** The holder's position read now; null when it could not be read. */
  fresh: FreshShares | null;
}): ExitCheck {
  const { shown, fresh } = input;
  if (!fresh) return { kind: "unknown" };
  if (fresh.sharesBurnable !== shown) {
    return { kind: "changed", burnable: fresh.sharesBurnable };
  }
  return { kind: "send", burn: shown, balanceBefore: fresh.sharesBalance };
}

/** What pressing Retry does, decided from the holder's position read again just before (see {@link exitRetry}). */
export type ExitRetry =
  /** The exit is done: only its record is saved, for the Shares that exit burned. */
  | { kind: "record"; burn: bigint }
  /** The exit sent before already burned the Shares, though its confirmation never came: it landed, nothing is sent. */
  | { kind: "landed" }
  | ExitCheck;

/**
 * Before an exit is sent a second time. A ragequit burns the Shares, so one whose confirmation timed out may well have
 * landed. So the position is read again first: Shares down by what was sent means it landed. Otherwise it is sent
 * again only for exactly what was sent before and what the dialog still shows; anything else (Shares that arrived
 * since, which a landed exit would leave behind) is refused, and the person confirms again.
 */
export function exitRetry(input: {
  /** The exit step is confirmed. */
  exitDone: boolean;
  /** The Shares the last exit sent asked to burn, and the holder's Shares just before it; null when none was sent. */
  sent: { burn: bigint; balanceBefore: bigint } | null;
  /** The holder's position read again now; null when it could not be read. */
  fresh: FreshShares | null;
  /** What the dialog shows can leave. */
  current: bigint;
}): ExitRetry {
  const { sent, fresh } = input;
  if (input.exitDone)
    return { kind: "record", burn: sent?.burn ?? input.current };
  if (!sent || sent.burn === 0n)
    return firstExit({ shown: input.current, fresh });
  if (!fresh) return { kind: "unknown" };
  if (fresh.sharesBalance <= sent.balanceBefore - sent.burn) {
    return { kind: "landed" };
  }
  if (fresh.sharesBurnable !== sent.burn || input.current !== sent.burn) {
    return { kind: "changed", burnable: fresh.sharesBurnable };
  }
  return { kind: "send", burn: sent.burn, balanceBefore: fresh.sharesBalance };
}

/** The transaction named in a failed send's words (a wallet whose confirmation timed out says which it sent), or null. */
export function sentTxHash(error: unknown): string | null {
  const texts = [
    error instanceof Error ? error.message : "",
    (error as { technical?: unknown } | null)?.technical,
  ];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const match = /\bTransaction (0x[0-9a-fA-F]{64})\b/.exec(text);
    if (match) return match[1];
  }
  return null;
}
