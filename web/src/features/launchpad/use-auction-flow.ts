/**
 * React wiring for the Manage panel's auction deploy and graduation
 * execution on the web: the pure flows (`lib/auctionFlow.ts`,
 * `lib/graduationFlow.ts`, ported from the desktop app) bound to an injected
 * wallet (`lib/wallet-effects.ts`) and the relay's launch-mirror publisher.
 *
 * Signing needs a connected wallet account; the readiness check does not —
 * it only reads, and always reads the configured RPC endpoint (the chain the
 * launch lives on, never whatever network the wallet happens to be on), so a
 * founder (or a curious investor) can see whether graduation is possible
 * before connecting anything. The GraduationExecutor is recovered from chain at
 * readiness time (`fundsRecipient()`), so graduation works after a reload
 * that loses the deploy flow's session state.
 */
import { useCallback, useMemo, useReducer, useRef } from "react";

import {
  ethBlockNumber,
  ethCall,
  getRpcEndpoint,
  isContractDeployed,
} from "./chain";
import {
  auctionDeployReducer,
  auctionErrorMessage,
  initAuctionDeployState,
  retryPlan,
  runAuctionDeploy,
  type AuctionDispatch,
  type AuctionEffects,
  type AuctionPlanInputs,
} from "./lib/auctionFlow";
import { buildGraduationCall } from "./lib/evmCalls";
import {
  buildGraduationsView,
  checkGraduationReadiness,
  decodeGraduationRecord,
  GRADUATION_STEPS,
  graduationFlowReducer,
  graduationRetryPlan,
  initialGraduationState,
  runGraduationFlow,
  type GraduationDeps,
  type GraduationFlowState,
  type GraduationReadiness,
  type GraduationRetryPlan,
  type GraduationStepId,
} from "./lib/graduationFlow";
import { makeWalletAuctionEffects } from "./lib/wallet-effects";
import type { Eip1193ProviderLike } from "./lib/wallet-sender";

/** A connected signing account: the provider and the address it signs as. */
export interface ConnectedWallet {
  provider: Eip1193ProviderLike;
  address: string;
}

/**
 * Reads-only effects over the configured RPC endpoint. `send` and
 * `transactionCount` refuse: nothing that signs may run without a wallet.
 */
function makeReadOnlyEffects(rpcUrl: string): AuctionEffects {
  const needsWallet = (): never => {
    throw new Error("Connect a wallet to send this transaction.");
  };
  return {
    call: ({ to, data }) => ethCall(rpcUrl, to, data),
    send: async () => needsWallet(),
    codeAt: (address) => isContractDeployed(rpcUrl, address),
    transactionCount: async () => needsWallet(),
    blockNumber: () => ethBlockNumber(rpcUrl),
  };
}

// ---------------------------------------------------------------------------
// Deploy auction
// ---------------------------------------------------------------------------

export interface AuctionDeployFlowInput {
  /** The launch record's sale fields. */
  plan: AuctionPlanInputs;
  /** Null until the founder connects a wallet; `start` is inert without one. */
  wallet: ConnectedWallet | null;
  /** The chain the launch is on (the wallet is checked against it). */
  chainId: number;
  /** Republish the launch record with the deployed `auction` tag. */
  onLink: (input: { auction: string }) => Promise<unknown>;
  /** CCA factory override (default: the canonical v2.1.0 factory). */
  factory?: string;
  /** GraduationExecutor reserve share (default 4000 = 40%). */
  reserveBps?: number;
}

export interface AuctionDeployFlow {
  state: ReturnType<typeof auctionDeployReducer>;
  /** True while preparing, sending transactions, or updating the record. */
  busy: boolean;
  /** Fresh deploy: preflight → CREATE/CREATE2 sequence → record update. */
  start: () => void;
  /** Resume from the failed step, or retry just the record update. */
  retry: () => void;
}

/** Drive the auction deploy's state machine. */
export function useAuctionDeployFlow(
  input: AuctionDeployFlowInput,
): AuctionDeployFlow {
  const { plan, wallet, chainId, onLink, factory, reserveBps } = input;
  const [state, dispatch] = useReducer(
    auctionDeployReducer,
    plan.admission,
    initAuctionDeployState,
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const run = useCallback(
    (mode: "fresh" | "resume"): void => {
      if (!wallet) return;
      void runAuctionDeploy({
        effects: makeWalletAuctionEffects({
          provider: wallet.provider,
          deployer: wallet.address,
          chainId,
        }),
        plan,
        deployer: wallet.address,
        ...(factory !== undefined ? { factory } : {}),
        ...(reserveBps !== undefined ? { reserveBps } : {}),
        dispatch: dispatch as AuctionDispatch,
        mode,
        previous: stateRef.current,
        onLink,
      });
    },
    [chainId, factory, onLink, plan, reserveBps, wallet],
  );

  const start = useCallback(() => run("fresh"), [run]);
  const retry = useCallback(() => {
    const planToRetry = retryPlan(stateRef.current);
    if (!planToRetry) return;
    if (planToRetry.kind === "record") {
      dispatch({ type: "link_started" });
      void onLink({ auction: planToRetry.auctionAddress })
        .then(() => dispatch({ type: "linked" }))
        .catch((error: unknown) =>
          dispatch({ type: "link_failed", reason: auctionErrorMessage(error) }),
        );
      return;
    }
    run("resume");
  }, [onLink, run]);

  const busy =
    state.phase === "preparing" ||
    state.phase === "running" ||
    state.phase === "linking";
  return { state, busy, start, retry };
}

// ---------------------------------------------------------------------------
// Execute graduation
// ---------------------------------------------------------------------------

export type GraduationPublishReceipt = (
  kind: "sweep" | "lock",
  parts: { extraTags: string[][]; content: Record<string, string> },
) => Promise<unknown>;

export interface GraduationFlowInput {
  /** The `auction` tag — the deployed CCA auction. */
  auction: string;
  /**
   * The GraduationExecutor. Null = recover it from chain at check time
   * (`fundsRecipient()`, verified equal to `tokensRecipient()`).
   */
  executor: string | null;
  /** The record's `endBlock` (readiness "is the auction over?" comparison). */
  endBlock: number | null;
  /** Null until a wallet is connected; reads work without one. */
  wallet: ConnectedWallet | null;
  chainId: number;
  /** Publish one launch receipt bound to the confirmed tx hash. */
  publishReceipt: GraduationPublishReceipt;
}

export interface GraduationFlow {
  state: GraduationFlowState;
  /** True while checking readiness, executing, or publishing receipts. */
  busy: boolean;
  /** Run (or re-run) the readiness reads. */
  check: () => void;
  /** Execute the graduation, then publish the bound receipts. */
  start: () => void;
  /** Retry semantics: re-check / re-execute remaining / mirror-only. */
  retry: () => void;
  retryPlan: GraduationRetryPlan;
}

/**
 * Drive the graduation state machine. `check()` runs the contract's own gates
 * via view calls; `start()` sends `executeGraduation` and publishes the
 * `sweep`/`lock` receipts bound to the confirmed tx hash.
 */
export function useGraduationFlow(input: GraduationFlowInput): GraduationFlow {
  const { auction, executor, endBlock, wallet, chainId, publishReceipt } =
    input;
  const [state, dispatch] = useReducer(
    graduationFlowReducer,
    undefined,
    initialGraduationState,
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const readEffects = useMemo(() => makeReadOnlyEffects(getRpcEndpoint()), []);
  const signEffects = useMemo(
    () =>
      wallet
        ? makeWalletAuctionEffects({
            provider: wallet.provider,
            deployer: wallet.address,
            chainId,
          })
        : null,
    [chainId, wallet],
  );

  const check = useCallback(() => {
    dispatch({ type: "check_start" });
    // Always the configured RPC (the chain the launch lives on): a wallet that
    // is on another network would otherwise report "no such auction" for a
    // perfectly good one.
    void checkGraduationReadiness({ effects: readEffects, auction, endBlock })
      .then((readiness: GraduationReadiness) =>
        dispatch({ type: "check_result", readiness }),
      )
      .catch((error: unknown) =>
        dispatch({
          type: "check_failed",
          message: auctionErrorMessage(error),
        }),
      );
  }, [auction, endBlock, readEffects]);

  const execute = useCallback(
    (
      executorAddress: string,
      resume?: {
        completed: Set<GraduationStepId>;
        graduationTxHash: string | null;
      },
    ) => {
      if (!signEffects) {
        dispatch({
          type: "check_failed",
          message: "Connect a wallet to execute the graduation.",
        });
        return;
      }
      const deps: GraduationDeps = {
        send: (call) => signEffects.send(call),
        readGraduation: async () =>
          decodeGraduationRecord(
            await signEffects.call(
              buildGraduationsView(executorAddress, auction),
            ),
          ),
        publishReceipt,
      };
      void runGraduationFlow(
        {
          auction,
          executor: executorAddress,
          call: buildGraduationCall(executorAddress, auction),
        },
        deps,
        dispatch,
        resume,
      );
    },
    [auction, publishReceipt, signEffects],
  );

  const start = useCallback(() => {
    const executorAddress = stateRef.current.readiness?.executor ?? executor;
    if (!executorAddress) {
      dispatch({
        type: "check_failed",
        message:
          "the GraduationExecutor address is unknown — run the readiness check first",
      });
      return;
    }
    dispatch({
      type: "reset",
      order: GRADUATION_STEPS.map((s) => s.id),
    });
    execute(executorAddress);
  }, [execute, executor]);

  const retry = useCallback(() => {
    const plan = graduationRetryPlan(stateRef.current);
    if (!plan) return;
    const current = stateRef.current;
    const executorAddress = current.readiness?.executor ?? executor;
    if (plan.kind === "check" || !executorAddress) {
      check();
      return;
    }
    const completed = new Set<GraduationStepId>(
      GRADUATION_STEPS.map((s) => s.id).filter(
        (id) => current.steps[id] === "done",
      ),
    );
    execute(executorAddress, {
      completed,
      graduationTxHash: current.graduationTxHash,
    });
  }, [check, execute, executor]);

  const busy = state.phase === "checking" || state.phase === "running";
  return {
    state,
    busy,
    check,
    start,
    retry,
    retryPlan: graduationRetryPlan(state),
  };
}
