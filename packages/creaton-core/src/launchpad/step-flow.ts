/**
 * The step-by-step state machine behind the web's money-action flows (exit,
 * ragequit, summon): a closed set of named steps, a pure reducer over them,
 * and the two questions a retry asks — what is left, and what already landed.
 *
 * The rules every flow built on this keeps (Review-Proven Rules 1 and 5):
 *
 * - a failure names its step and says why;
 * - a retry re-sends only the steps not yet confirmed done, so a record-only
 *   write-back that failed can never re-send the money action before it.
 *
 * Each flow supplies its own step ids, its own labels and (when it needs more
 * than this) wraps the reducer; nothing here knows about transactions.
 */

/** Per-step status. `skipped` = not part of this plan. */
export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

/**
 * - `idle`: no attempt started.
 * - `running`: a step is in flight.
 * - `failed`: a step failed; retry sends only the remaining steps.
 * - `done`: every planned step confirmed.
 */
type StepFlowPhase = "idle" | "running" | "failed" | "done";

/** The full observable state of one attempt. */
export interface StepFlowState<Id extends string, Receipt> {
  phase: StepFlowPhase;
  /** Planned step order. */
  order: Id[];
  steps: Record<Id, StepStatus>;
  receipts: Partial<Record<Id, Receipt>>;
  failedStep: Id | null;
  /** Names the failed step and the reason (Review-Proven Rule 1). */
  errorMessage: string | null;
}

/** State transition events, emitted by a flow's runner. */
export type StepFlowAction<Id extends string, Receipt> =
  | { type: "reset"; order: readonly Id[] }
  | { type: "step-start"; step: Id }
  | { type: "step-done"; step: Id; receipt?: Receipt }
  | {
      type: "step-failed";
      step: Id;
      message: string;
      /** Kept on failure when the caller needs to name the hash. */
      receipt?: Receipt;
    };

/**
 * Build the reducer and helpers for one flow. `allIds` is the closed step
 * vocabulary (a step missing from a plan's `order` is `skipped`); `labels`
 * names each step in the failure message.
 */
export function createStepFlow<Id extends string, Receipt>(
  allIds: readonly Id[],
  labels: Record<Id, string>,
) {
  type State = StepFlowState<Id, Receipt>;
  type Action = StepFlowAction<Id, Receipt>;

  function freshSteps(order: readonly Id[]): Record<Id, StepStatus> {
    const steps = {} as Record<Id, StepStatus>;
    for (const id of allIds) {
      steps[id] = order.includes(id) ? "pending" : "skipped";
    }
    return steps;
  }

  /** The state before any attempt: nothing planned, nothing sent. */
  function initial(): State {
    return {
      phase: "idle",
      order: [],
      steps: freshSteps([]),
      receipts: {},
      failedStep: null,
      errorMessage: null,
    };
  }

  function reducer(state: State, action: Action): State {
    switch (action.type) {
      case "reset": {
        const order = [...action.order];
        return { ...initial(), order, steps: freshSteps(order) };
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
        const receipts = action.receipt
          ? { ...state.receipts, [action.step]: action.receipt }
          : state.receipts;
        return {
          ...state,
          phase: "failed",
          steps: { ...state.steps, [action.step]: "failed" as const },
          receipts,
          failedStep: action.step,
          errorMessage: `${labels[action.step]} failed: ${action.message}`,
        };
      }
    }
  }

  /** Steps not yet confirmed done — exactly what a retry will (re-)send. */
  function remaining(state: State): Id[] {
    return state.order.filter((id) => state.steps[id] !== "done");
  }

  /** Steps already confirmed done — never re-sent on retry. */
  function completed(state: State): Set<Id> {
    return new Set(state.order.filter((id) => state.steps[id] === "done"));
  }

  return { initial, reducer, remaining, completed };
}
