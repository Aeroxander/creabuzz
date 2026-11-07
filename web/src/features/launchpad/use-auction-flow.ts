/**
 * React wiring for the Manage panel's graduation execution on the web: the
 * pure flow (`lib/graduationFlow.ts`, ported from the desktop app) bound to an
 * injected wallet (`lib/wallet-effects.ts`) and the relay's launch-mirror
 * publisher. (Deploying an auction by hand was removed in D150; the launch kit
 * makes the auction.)
 *
 * Signing needs a connected wallet account; the readiness check does not —
 * it only reads, and always reads the configured RPC endpoint (the chain the
 * launch lives on, never whatever network the wallet happens to be on), so a
 * founder (or a curious investor) can see whether graduation is possible
 * before connecting anything. The GraduationExecutor is recovered from chain at
 * readiness time (`fundsRecipient()`), so graduation works after a reload
 * that loses the session state.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  ethBlockNumber,
  ethCall,
  getRpcEndpoint,
  isContractDeployed,
} from "./chain";
import {
  auctionErrorMessage,
  type AuctionEffects,
} from "@creaton/core/launchpad/auctionFlow.ts";
import {
  makeGenerationFence,
  settleIfCurrent,
} from "@creaton/core/launchpad/deploy-progress.ts";
import { buildGraduationCall } from "@creaton/core/launchpad/evmCalls.ts";
import {
  buildGraduationsView,
  checkGraduationReadiness,
  decodeGraduationRecord,
  type GraduationRecord,
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
} from "@creaton/core/launchpad/graduationFlow.ts";
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
// Execute graduation
// ---------------------------------------------------------------------------

type GraduationPublishReceipt = (
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
  /**
   * Retry semantics: re-check / re-execute remaining / mirror-only. A
   * manually supplied graduation hash rides the retry directly.
   */
  retry: (suppliedTxHash?: string) => void;
  retryPlan: GraduationRetryPlan;
  /**
   * What the graduation did, read back from the executor once it has run (in
   * this session or an earlier one). Null until then, or if the read fails —
   * it is a summary of a chain fact, never a gate on anything.
   */
  result: GraduationRecord | null;
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

  // Always the CURRENT configured endpoint (the chain the launch lives on):
  // an empty-dep pin would keep reading whichever endpoint the page loaded
  // with after the community (and its relay/RPC) changed.
  const rpcUrl = getRpcEndpoint();
  const readEffects = useMemo(() => makeReadOnlyEffects(rpcUrl), [rpcUrl]);
  const [result, setResult] = useState<GraduationRecord | null>(null);
  // Starting the flow resets the reducer (readiness included), so the executor
  // found by the readiness check is remembered here for the summary read.
  const executorSeen = useRef<string | null>(null);
  if (state.readiness?.executor)
    executorSeen.current = state.readiness.executor;
  const graduatedExecutor =
    state.phase === "done" || state.readiness?.status === "already-graduated"
      ? executorSeen.current
      : null;
  useEffect(() => {
    if (!graduatedExecutor) return;
    let alive = true;
    readEffects
      .call(buildGraduationsView(graduatedExecutor, auction))
      .then((raw) => {
        if (alive) setResult(decodeGraduationRecord(raw));
      })
      .catch(() => {
        // Informational only: the graduation is on chain whether or not this
        // summary could be read, so a failed read shows no summary.
        if (alive) setResult(null);
      });
    return () => {
      alive = false;
    };
  }, [auction, graduatedExecutor, readEffects]);
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

  // Generation fence: a slow earlier readiness answer must never overwrite a
  // newer one (the `useConnectedWallet` pattern).
  const checkFence = useRef(makeGenerationFence());
  const check = useCallback(() => {
    const token = checkFence.current.next();
    dispatch({ type: "check_start" });
    // Always the configured RPC (the chain the launch lives on): a wallet that
    // is on another network would otherwise report "no such auction" for a
    // perfectly good one.
    void checkGraduationReadiness({ effects: readEffects, auction, endBlock })
      .then((readiness: GraduationReadiness) =>
        settleIfCurrent(checkFence.current, token, () =>
          dispatch({ type: "check_result", readiness }),
        ),
      )
      .catch((error: unknown) =>
        settleIfCurrent(checkFence.current, token, () =>
          dispatch({
            type: "check_failed",
            message: auctionErrorMessage(error),
          }),
        ),
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
          "the GraduationExecutor address is unknown. Run the readiness check first",
      });
      return;
    }
    dispatch({
      type: "reset",
      order: GRADUATION_STEPS.map((s) => s.id),
    });
    execute(executorAddress);
  }, [execute, executor]);

  /**
   * `suppliedTxHash` is the founder's manually entered graduation hash. It is
   * passed straight into the run, so the recovery works even when the browser
   * refuses to persist it.
   */
  const retry = useCallback(
    (suppliedTxHash?: string) => {
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
        graduationTxHash: suppliedTxHash ?? current.graduationTxHash,
      });
    },
    [check, execute, executor],
  );

  const busy = state.phase === "checking" || state.phase === "running";
  return {
    state,
    busy,
    check,
    start,
    retry,
    retryPlan: graduationRetryPlan(state),
    result,
  };
}
