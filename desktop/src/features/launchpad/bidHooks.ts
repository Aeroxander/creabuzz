/**
 * The in-app bid flow for the launchpad: wallet/chain IPC reads, the
 * underlying-allowance preflight, the sequential transaction step
 * orchestrator, and the kind-47002 mirror publish step.
 *
 * Flow contract (`docs/next-gen-launchpad-plan.md` §Phase A1): the bid is sent
 * onchain from the app — **no pasted transaction hashes anywhere** — and the
 * 47002 mirror is published automatically on tx success with the hash bound
 * (`publishMirror(txHash)`). A mined revert resolves as `status: "reverted"`
 * receipt data and is a **failed step**, never a fake success; every failure
 * names its step (Review-Proven Rule 1) and keeps completed steps visible so a
 * retry only re-sends what remains. A mirror retry never re-sends a money
 * action — the `submitBid` hash is bound from the confirmed receipt and only
 * the mirror publish is re-attempted.
 *
 * The IPC surface (`desktop/src-tauri`, `evm_*` commands):
 * - `evm_wallet_status() -> { hasWallet, address }`
 * - `evm_chain_status({ rpcUrl }) -> { chainId }`
 * - `evm_call({ rpcUrl, to, data }) -> { returnData }`
 * - `evm_send_transaction({ rpcUrl, chainId, to, data, value?, gasLimit? })`
 *   -> `{ txHash, status, blockNumber, gasUsed, contractAddress }`
 *
 * Testable under `node --test` (`bidHooks.test.mjs`): the reducer, the step
 * orchestrator, and the calldata helpers are pure or dependency-injected; only
 * the thin `invokeTauri` wrappers and `useBidFlow` touch the app runtime.
 */

import * as React from "react";

import { decodeUint256 } from "@/features/launchpad/lib/chainRpc";
import {
  buildBidCalls,
  encodeFunctionData,
  type BidPlan,
  type EvmCall,
  PERMIT2_ADDRESS,
} from "@/features/launchpad/lib/evmCalls";
import { invokeTauri } from "@/shared/api/tauri";

// ---------------------------------------------------------------------------
// IPC contract (desktop/src-tauri `evm_*` commands)
// ---------------------------------------------------------------------------

/** `evm_wallet_status` result. */
export interface WalletStatus {
  hasWallet: boolean;
  address: string | null;
}

/** A mined transaction receipt (`evm_send_transaction`). */
export interface TxReceipt {
  txHash: string;
  /** A mined revert resolves as `"reverted"` data — a failed step, not a throw. */
  status: "success" | "reverted";
  blockNumber: number;
  gasUsed: string;
  contractAddress: string | null;
}

/** Arguments for `evm_send_transaction`. */
export interface EvmSendArgs {
  rpcUrl: string;
  chainId: number;
  to: string;
  data: string;
  /** Hex quantity; native-currency bids carry the budget as `msg.value`. */
  value?: string;
  gasLimit?: string;
}

/** Ask the app's wallet backend whether a wallet is connected. */
export function evmWalletStatus(): Promise<WalletStatus> {
  return invokeTauri<WalletStatus>("evm_wallet_status");
}

/** Read the chain id the configured RPC endpoint reports. */
export function evmChainStatus(rpcUrl: string): Promise<{ chainId: number }> {
  return invokeTauri<{ chainId: number }>("evm_chain_status", { rpcUrl });
}

/** Raw `eth_call`; resolves the 0x return data. */
export function evmEthCall(
  rpcUrl: string,
  to: string,
  data: string,
): Promise<string> {
  return invokeTauri<{ returnData: string }>("evm_call", {
    rpcUrl,
    to,
    data,
  }).then((result) => result.returnData);
}

/** Sign, broadcast, and await a mined receipt for one call. */
export function evmSendTransaction(args: EvmSendArgs): Promise<TxReceipt> {
  return invokeTauri<TxReceipt>("evm_send_transaction", { ...args });
}

// ---------------------------------------------------------------------------
// Underlying allowance preflight
// ---------------------------------------------------------------------------

/** `allowance(address,address)` — standard ERC-20 (`cast sig` → `0xdd62ed3e`). */
export const SIGNATURE_ERC20_ALLOWANCE = "allowance(address,address)";

/** Calldata for `currency.allowance(owner, PERMIT2)` (read-only). */
export function buildAllowanceCall(currency: string, owner: string): EvmCall {
  return {
    to: currency,
    data: encodeFunctionData(
      SIGNATURE_ERC20_ALLOWANCE,
      ["address", "address"],
      [owner, PERMIT2_ADDRESS],
    ),
  };
}

/**
 * Read `currency.allowance(owner, PERMIT2)` and decode the 32-byte word — the
 * underlying ERC-20 → Permit2 allowance a first-time bidder is missing. Throws
 * (never silently returns zero) when the read or the decode fails.
 */
export async function readPermit2UnderlyingAllowance(
  rpcUrl: string,
  currency: string,
  owner: string,
): Promise<bigint> {
  const call = buildAllowanceCall(currency, owner);
  const returnData = await evmEthCall(rpcUrl, call.to, call.data);
  return decodeUint256(returnData);
}

// ---------------------------------------------------------------------------
// Step orchestrator — pure reducer + dependency-injected runner
// ---------------------------------------------------------------------------

/** One labeled step of a bid attempt. */
export type BidStepId =
  | "underlyingApprove"
  | "permit2Approve"
  | "submitBid"
  | "mirrorPublish";

/** Human names for the steps; failure messages name the failed step. */
export const BID_STEP_LABELS: Record<BidStepId, string> = {
  underlyingApprove: "Underlying approve",
  permit2Approve: "Permit2 approve",
  submitBid: "Submit bid",
  mirrorPublish: "Mirror publish",
};

/** Per-step status. `skipped` = not part of this plan (e.g. native auction). */
export type BidStepStatus =
  | "pending"
  | "active"
  | "done"
  | "failed"
  | "skipped";

/**
 * - `idle`: no attempt started.
 * - `running`: a step is in flight.
 * - `failed`: a money step failed before the bid landed; retry sends only the
 *   remaining steps.
 * - `mirrorFailed`: the bid landed onchain but the 47002 mirror publish
 *   failed; retry is mirror-only and never re-sends a money action.
 * - `done`: bid placed and mirrored.
 */
export type BidFlowPhase =
  | "idle"
  | "running"
  | "failed"
  | "mirrorFailed"
  | "done";

/** The full observable state of one bid attempt. */
export interface BidFlowState {
  phase: BidFlowPhase;
  /** Planned step order (money steps then `mirrorPublish`). */
  order: BidStepId[];
  steps: Record<BidStepId, BidStepStatus>;
  receipts: Partial<Record<BidStepId, TxReceipt>>;
  failedStep: BidStepId | null;
  /** Names the failed step and the reason (Review-Proven Rule 1). */
  errorMessage: string | null;
  /** The confirmed `submitBid` tx hash — the mirror's hash binding. */
  bidTxHash: string | null;
}

/** State transition events, emitted by {@link runBidFlow}. */
export type BidFlowAction =
  | { type: "reset"; order: readonly BidStepId[] }
  | { type: "step-start"; step: BidStepId }
  | { type: "step-done"; step: BidStepId; receipt?: TxReceipt }
  | { type: "step-failed"; step: BidStepId; message: string };

const ALL_STEP_IDS: readonly BidStepId[] = [
  "underlyingApprove",
  "permit2Approve",
  "submitBid",
  "mirrorPublish",
];

function freshSteps(
  order: readonly BidStepId[],
): Record<BidStepId, BidStepStatus> {
  const steps = {} as Record<BidStepId, BidStepStatus>;
  for (const id of ALL_STEP_IDS) {
    steps[id] = order.includes(id) ? "pending" : "skipped";
  }
  return steps;
}

/** The state before any attempt: nothing planned, nothing sent. */
export function initialBidFlowState(): BidFlowState {
  return {
    phase: "idle",
    order: [],
    steps: freshSteps([]),
    receipts: {},
    failedStep: null,
    errorMessage: null,
    bidTxHash: null,
  };
}

/** Pure step-orchestrator reducer (the production seam `bidHooks.test.mjs` binds). */
export function bidFlowReducer(
  state: BidFlowState,
  action: BidFlowAction,
): BidFlowState {
  switch (action.type) {
    case "reset": {
      const order = [...action.order];
      return {
        ...initialBidFlowState(),
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
      const bidTxHash =
        action.step === "submitBid" && action.receipt
          ? action.receipt.txHash
          : state.bidTxHash;
      const allDone = state.order.every((id) => steps[id] === "done");
      return {
        ...state,
        phase: allDone ? "done" : "running",
        steps,
        receipts,
        bidTxHash,
        failedStep: null,
        errorMessage: null,
      };
    }
    case "step-failed": {
      const bidLanded = state.bidTxHash !== null;
      return {
        ...state,
        phase:
          action.step === "mirrorPublish" && bidLanded
            ? "mirrorFailed"
            : "failed",
        steps: { ...state.steps, [action.step]: "failed" as const },
        failedStep: action.step,
        errorMessage: `${BID_STEP_LABELS[action.step]} failed — ${action.message}`,
      };
    }
  }
}

/** Steps not yet confirmed done — exactly what a retry will (re-)send. */
export function remainingSteps(state: BidFlowState): BidStepId[] {
  return state.order.filter((id) => state.steps[id] !== "done");
}

/** Steps already confirmed done — never re-sent on retry. */
export function completedStepSet(state: BidFlowState): Set<BidStepId> {
  return new Set(state.order.filter((id) => state.steps[id] === "done"));
}

/** Where a retry picks up: what is done, and the hash to bind the mirror to. */
export interface BidResume {
  completed: ReadonlySet<BidStepId>;
  bidTxHash: string | null;
}

/** Derive the {@link BidResume} for `runBidFlow` from the current state. */
export function resumeFromState(state: BidFlowState): BidResume {
  return { completed: completedStepSet(state), bidTxHash: state.bidTxHash };
}

/** A labeled onchain call: one money step. */
export interface BidStepCall {
  step: BidStepId;
  call: EvmCall;
}

/** Everything one bid attempt needs; re-runnable for retries. */
export interface BidExecution {
  rpcUrl: string;
  chainId: number;
  /** Ordered money steps (`underlyingApprove` / `permit2Approve` / `submitBid`). */
  calls: readonly BidStepCall[];
  /** Full planned order including the trailing `mirrorPublish`. */
  order: readonly BidStepId[];
  /**
   * Publish the kind-47002 mirror with the confirmed `submitBid` hash bound
   * (`docs/next-gen-launchpad-plan.md` §Phase A1: "47002 mirrors automatically
   * on tx success (hash binding)"). This is the ONLY publish path — it reuses
   * the launchpad's existing mirror mutation.
   */
  publishMirror: (txHash: string) => Promise<void>;
}

/** Injected I/O for {@link runBidFlow}; tests script fakes here. */
export interface BidFlowDeps {
  sendTransaction: (args: EvmSendArgs) => Promise<TxReceipt>;
}

/** Inputs for {@link buildBidExecution}. */
export interface BidExecutionParams {
  rpcUrl: string;
  chainId: number;
  /** CCA auction address. */
  auction: string;
  /** Bid currency; the zero address marks a native-currency auction. */
  currency: string;
  plan: BidPlan;
  /** True when `currency.allowance(owner, PERMIT2)` is below the budget. */
  needsUnderlyingAllowance: boolean;
  /** Unix-seconds deadline for the Permit2 approve (ignored natively). */
  permit2Deadline: bigint;
  publishMirror: (txHash: string) => Promise<void>;
}

function stepForCall(call: EvmCall, params: BidExecutionParams): BidStepId {
  const to = call.to.toLowerCase();
  if (to === params.auction.toLowerCase()) return "submitBid";
  if (to === PERMIT2_ADDRESS.toLowerCase()) return "permit2Approve";
  return "underlyingApprove";
}

/**
 * Compose the ordered, labeled execution for one bid from `buildBidCalls`
 * (`./lib/evmCalls.ts`): optional underlying approve → Permit2 approve
 * (ERC-20) → `submitBid`, with the mirror publish appended as the final step.
 * Throws on an inconsistent call sequence — composition failures surface
 * before anything is sent.
 */
export function buildBidExecution(params: BidExecutionParams): BidExecution {
  const calls = buildBidCalls({
    auction: params.auction,
    currency: params.currency,
    plan: params.plan,
    needsUnderlyingAllowance: params.needsUnderlyingAllowance,
    permit2Deadline: params.permit2Deadline,
  });
  const labeled: BidStepCall[] = calls.map((call) => ({
    step: stepForCall(call, params),
    call,
  }));
  const seen = new Set<BidStepId>();
  for (const entry of labeled) {
    if (entry.step === "mirrorPublish" || seen.has(entry.step)) {
      throw new Error(`bid call sequence is inconsistent at ${entry.step}`);
    }
    seen.add(entry.step);
  }
  if (
    labeled.length === 0 ||
    labeled[labeled.length - 1].step !== "submitBid"
  ) {
    throw new Error("bid call sequence must end with submitBid");
  }
  return {
    rpcUrl: params.rpcUrl,
    chainId: params.chainId,
    calls: labeled,
    order: [...labeled.map((entry) => entry.step), "mirrorPublish"],
    publishMirror: params.publishMirror,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "the request failed";
}

/**
 * Run (or resume) one bid attempt: send each remaining money step in order,
 * awaiting each mined receipt, then publish the mirror bound to the confirmed
 * `submitBid` hash. Dispatches every transition through `dispatch`; stops at
 * the first failure and names it. `resume.completed` steps are never re-sent —
 * in particular a mirror-only retry sends zero transactions.
 */
export async function runBidFlow(
  execution: BidExecution,
  deps: BidFlowDeps,
  dispatch: (action: BidFlowAction) => void,
  resume: BidResume = { completed: new Set(), bidTxHash: null },
): Promise<void> {
  let bidTxHash = resume.bidTxHash;
  for (const entry of execution.calls) {
    if (resume.completed.has(entry.step)) continue;
    dispatch({ type: "step-start", step: entry.step });
    let receipt: TxReceipt;
    try {
      receipt = await deps.sendTransaction({
        rpcUrl: execution.rpcUrl,
        chainId: execution.chainId,
        to: entry.call.to,
        data: entry.call.data,
        // Explicit hex quantity — same normalization as mintHooks' and
        // auctionHooks' send wrappers ("0x0" when the call moves no value).
        value: entry.call.value ?? "0x0",
      });
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
      // A mined revert is a failed step — data, not an exception, and never a
      // silent success.
      dispatch({
        type: "step-failed",
        step: entry.step,
        message: `the transaction reverted onchain (tx ${receipt.txHash})`,
      });
      return;
    }
    dispatch({ type: "step-done", step: entry.step, receipt });
    if (entry.step === "submitBid") bidTxHash = receipt.txHash;
  }
  if (resume.completed.has("mirrorPublish")) return;
  dispatch({ type: "step-start", step: "mirrorPublish" });
  if (bidTxHash === null) {
    dispatch({
      type: "step-failed",
      step: "mirrorPublish",
      message: "no confirmed submitBid transaction to bind the mirror to",
    });
    return;
  }
  try {
    await execution.publishMirror(bidTxHash);
  } catch (err) {
    // The bid is onchain; only the mirror failed. The retry path re-runs just
    // this step — the money action is never re-sent.
    dispatch({
      type: "step-failed",
      step: "mirrorPublish",
      message: errorMessage(err),
    });
    return;
  }
  dispatch({ type: "step-done", step: "mirrorPublish" });
}

// ---------------------------------------------------------------------------
// React glue
// ---------------------------------------------------------------------------

const TAURI_BID_FLOW_DEPS: BidFlowDeps = {
  sendTransaction: evmSendTransaction,
};

/** The dialog-facing bid flow: reducer state plus start/retry/reset. */
export interface UseBidFlowResult {
  state: BidFlowState;
  /** Begin a fresh attempt (arms the plan and runs it). */
  start: (execution: BidExecution) => Promise<void>;
  /** Resume the armed plan: only unfinished steps run (mirror-only when the bid landed). */
  retry: () => Promise<void>;
  /** Disarm — used when the dialog reopens with fresh form values. */
  reset: () => void;
}

/**
 * Bind the step orchestrator to the Tauri IPC layer. `start` arms a new
 * attempt; `retry` re-runs exactly the remaining steps of the armed execution
 * (see {@link runBidFlow}).
 */
export function useBidFlow(): UseBidFlowResult {
  const [state, dispatch] = React.useReducer(
    bidFlowReducer,
    undefined,
    initialBidFlowState,
  );
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const executionRef = React.useRef<BidExecution | null>(null);

  const start = React.useCallback((execution: BidExecution) => {
    executionRef.current = execution;
    dispatch({ type: "reset", order: execution.order });
    return runBidFlow(execution, TAURI_BID_FLOW_DEPS, dispatch);
  }, []);

  const retry = React.useCallback(() => {
    const execution = executionRef.current;
    if (!execution) return Promise.resolve();
    return runBidFlow(
      execution,
      TAURI_BID_FLOW_DEPS,
      dispatch,
      resumeFromState(stateRef.current),
    );
  }, []);

  const reset = React.useCallback(() => {
    executionRef.current = null;
    dispatch({ type: "reset", order: [] });
  }, []);

  return { state, start, retry, reset };
}
